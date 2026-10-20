/**
 * 后台 Service Worker
 * 职责：统一持有 API 配置、发起大模型请求、做批次容错与重试。
 * 页面脚本（content script）不直接接触网络请求，避免 CORS 与密钥外泄。
 */

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  temperature: 0.3,
  maxCharsPerBatch: 2500,
  concurrency: 12,
  bilingual: false,
  autoTranslateSelection: false,
  autoPrompt: true,
  disableThinking: true,
  hoverTranslate: true,
  inputTranslate: true,
  autoFollow: true,
  skipSites: [],
  systemPrompt: '',
  glossary: ''
};

/* 配置缓存：避免每个批次都读一次 storage.sync */
let cfgCache = null;

async function getConfig(force) {
  if (cfgCache && !force) return cfgCache;
  const stored = await chrome.storage.sync.get(DEFAULTS);
  cfgCache = { ...DEFAULTS, ...stored };
  return cfgCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') cfgCache = null;
});

/* ------------------------------------------------------------------ */
/* 译文缓存：相同文本 + 相同目标语言 + 相同模型直接命中                  */
/* 一级内存缓存，二级 storage.local 持久化（Service Worker 重启不丢）    */
/* ------------------------------------------------------------------ */

const CACHE_PREFIX = 'tc:';
const CACHE_LIMIT = 2000;

const memCache = new Map();
let cachePromise = null;
let cacheDirty = new Set();

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(model, lang, text, style) {
  // style 是自定义提示词：它会改变译文风格，必须参与缓存键
  const s = `${model}\u0000${lang}\u0000${style || ''}\u0000${text}`;
  // 双哈希降低碰撞概率，避免不同原文命中同一条译文
  return CACHE_PREFIX + hashStr(s) + hashStr(s + '\u0001');
}

function loadCache() {
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        const all = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(CACHE_PREFIX) && typeof v === 'string' && v) {
            memCache.set(k, v);
          }
        }
      } catch {
        /* 缓存不可用不影响主流程 */
      }
    })();
  }
  return cachePromise;
}

/**
 * 读缓存并刷新 LRU 顺序。
 * 淘汰按 Map 插入顺序丢最早写入的条目，命中时挪到队尾，
 * 导航 / 页脚这类跨页面重复的热文本就不会被一次性长页挤出去。
 */
function lookupTranslation(key) {
  const v = memCache.get(key);
  if (v) {
    memCache.delete(key);
    memCache.set(key, v);
  }
  return v;
}

function rememberTranslation(key, value) {
  if (!value) return;
  memCache.set(key, value);
  cacheDirty.add(key);
  // 简单容量控制：超限时丢弃最早写入的条目
  if (memCache.size > CACHE_LIMIT) {
    const drop = [...memCache.keys()].slice(0, memCache.size - CACHE_LIMIT);
    for (const k of drop) memCache.delete(k);
    chrome.storage.local.remove(drop).catch(() => {});
  }
}

let flushTimer = null;

/** 合并写入：并发批次会频繁触发落盘，攒 400ms 一次写完 */
function flushCache() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushCacheNow();
  }, 400);
}

function flushCacheNow() {
  if (!cacheDirty.size) return;
  const patch = {};
  for (const k of cacheDirty) {
    const v = memCache.get(k);
    if (v) patch[k] = v;
  }
  cacheDirty.clear();
  if (Object.keys(patch).length) {
    chrome.storage.local.set(patch).catch(() => {});
  }
}

async function clearCache() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  memCache.clear();
  cacheDirty.clear();
  cachePromise = null;
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 大模型调用                                                          */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

/**
 * 按请求体量估算超时。固定 60 / 120 秒对慢模型是灾难：
 * 一批 2500 字要输出约 3000 token，30 tok/s 就得 100 秒，
 * 固定上限会稳定超时，然后降级非流式（60 秒，更容易死）、拆批、再超时。
 * 这里按 15 token/s 保守估计生成耗时，另加 20 秒预填充与网络余量。
 * 本地 4B 模型实测远快于此，给宽一点不会拖慢它——超时只在真的卡住时才触发。
 */
function timeoutFor(body) {
  const chars = (body && body.messages ? body.messages : []).reduce(
    (s, m) => s + String(m.content || '').length,
    0
  );
  return Math.max(REQUEST_TIMEOUT_MS, Math.min(300000, 20000 + chars * 80));
}
// 临时性故障，退避重试往往能成功
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// 探明当前接口不支持流式后置位，后续批次直接用非流式，不再浪费一次失败请求。
// Service Worker 重启会重置，届时重新探测一次，代价可接受
let streamUnsupported = false;

/** 本地/内网端点（Ollama、vLLM、LM Studio 等）通常无需鉴权 */
function isLocalEndpoint(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h.endsWith('.local') ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

/** 模型名里的推理模型特征：认不出平台时靠它决定要不要试一次关闭参数 */
const REASONING_MODEL_RE =
  /(qwen3|thinking|reasoner|(^|[-_/.])r1|qwq|glm-4\.5|kimi-k2|seed-1\.6|magistral|grok-[34])/i;

/**
 * 关闭「思考模式」需要附加的请求参数，按平台识别。
 * 翻译是确定性任务，思考链纯属浪费：既计费又拖慢首字，
 * 部分本地框架（vLLM / SGLang 的 Qwen3）还会把思考内容混进正文干扰解析。
 *
 * 各家的开关字段互不兼容，只能硬编码。猜错的代价由 paramCompat 兜住：
 * 同一个「host+模型」只会白付一次 400，之后自动剔除该参数（见 rememberDropped）。
 * 所以这里可以放宽识别，不必为了安全一律返回 {}。
 */
function thinkingParams(baseUrl, model) {
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return {};
  }
  const m = String(model || '');

  // Ollama 原生接口：0.9+ 支持 think，更早版本忽略未知字段
  if (host.includes('ollama') || host.endsWith(':11434')) return { think: false };

  // enable_thinking：通义、硅基流动、混元、千帆、腾讯云、各类 one-api 转发 Qwen3
  if (
    host.includes('dashscope') ||
    host.includes('aliyuncs') ||
    host.includes('siliconflow') ||
    host.includes('hunyuan') ||
    host.includes('tencent') ||
    host.includes('baidubce') ||
    host.includes('qianfan') ||
    host.includes('modelscope')
  ) {
    return { enable_thinking: false };
  }

  // thinking.type：智谱、DeepSeek、火山方舟、月之暗面
  if (
    host.includes('bigmodel') ||
    host.includes('deepseek') ||
    host.includes('volces') ||
    host.includes('ark.cn') ||
    host.includes('moonshot')
  ) {
    return { thinking: { type: 'disabled' } };
  }

  // OpenRouter 用统一的 reasoning 字段，可关掉推理
  if (host.includes('openrouter')) return { reasoning: { enabled: false } };

  // OpenAI o 系列：o3 / o4-mini 支持 minimal；o1 只接受 low，被拒后由记忆剔除
  if (host.includes('openai.com') && /^o[134]/.test(m)) return { reasoning_effort: 'minimal' };

  // 其余（自建 vLLM / SGLang / one-api / 各类网关）：
  // 只有模型名像推理模型时才试一次，普通模型乱加参数只会换来 400
  if (REASONING_MODEL_RE.test(m)) return { enable_thinking: false };
  return {};
}

/* ------------------------------------------------------------------ */
/* 参数兼容性记忆                                                      */
/*                                                                     */
/* 接口不认识的参数会 400。原来的做法是每次请求现剥现重发，于是一个    */
/* 不兼容的参数会让「每个批次」都白付一次完整输入（20 批 = 20 次）。  */
/* 这里按「host+模型」记住被拒过的参数，之后构造请求时直接不发。      */
/* ------------------------------------------------------------------ */

const COMPAT_STORE = 'paramCompat';
let compatMap = null;      // Map<`host|model`, Set<参数名>>
let compatSaveTimer = null;

function compatKeyOf(baseUrl, model) {
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    /* 地址不合法时按模型名归类即可 */
  }
  return `${host}|${String(model || '').toLowerCase()}`;
}

async function loadCompat() {
  if (compatMap) return compatMap;
  compatMap = new Map();
  try {
    const { [COMPAT_STORE]: raw } = await chrome.storage.local.get({ [COMPAT_STORE]: {} });
    for (const [k, v] of Object.entries(raw || {})) {
      if (Array.isArray(v) && v.length) compatMap.set(k, new Set(v));
    }
  } catch {
    /* 读不到就当没有记忆，不影响翻译 */
  }
  return compatMap;
}

/** 同步取用：请求前剔除已知不被支持的参数 */
function droppedParams(baseUrl, model) {
  if (!compatMap) return null;
  return compatMap.get(compatKeyOf(baseUrl, model)) || null;
}

/** 记录一个被接口拒绝的参数，攒 300ms 合并落盘（并发批次会同时命中 400） */
function rememberDropped(baseUrl, model, param) {
  if (!compatMap || !param) return;
  const k = compatKeyOf(baseUrl, model);
  const set = compatMap.get(k) || new Set();
  if (set.has(param)) return;
  set.add(param);
  compatMap.set(k, set);
  if (compatSaveTimer) return;
  compatSaveTimer = setTimeout(() => {
    compatSaveTimer = null;
    const obj = {};
    for (const [key, s] of compatMap) obj[key] = [...s];
    chrome.storage.local.set({ [COMPAT_STORE]: obj }).catch(() => {});
  }, 300);
}

/** 去掉内联在正文里的思考内容：<think>…</think>、<think>…</think>、<reasoning>…</reasoning> */
const THINK_BLOCK_RE = /<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi;
function stripThinking(text) {
  return String(text || '').replace(THINK_BLOCK_RE, '');
}

/**
 * 输出上限的字段名。绝大多数接口用 max_tokens；
 * OpenAI 的 o 系 / GPT-5 推理模型只认 max_completion_tokens，传错会被 400 拒掉。
 */
function outputLimitKey(baseUrl, model) {
  try {
    if (new URL(baseUrl).host.includes('openai.com') && /^(o1|o3|o4|gpt-5)/.test(model)) {
      return 'max_completion_tokens';
    }
  } catch {
    /* 地址解析不了就用默认字段名 */
  }
  return 'max_tokens';
}

/** 单次请求，带超时。超时抛 AbortError，由上层翻译成可读文案 */
async function postChat(baseUrl, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutFor(body));
  try {
    // 本地模型没有 Key 时不发送 Authorization，避免服务端拒绝空凭证
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 全局限流冷却。并发批次各自撞 429、各自退避，退避结束后又会同时打过去，
 * 实际请求数被放大到「并发 × 重试次数」。命中 429 后统一推迟所有请求。
 */
let rateLimitUntil = 0;

/**
 * 正在进行的流式请求。用户点「停止」时只丢掉前端结果的话，
 * 后台会把整批译完再丢弃，token 照付（大模型一批上千 token）。
 * 这里留着 controller，收到取消消息就真正 abort。
 */
const activeStreamCtrls = new Set();

/** 带退避重试的请求：429 / 5xx 等临时错误重试，其余立即返回 */
async function requestChat(baseUrl, apiKey, body) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const cool = rateLimitUntil - Date.now();
    if (cool > 0) await new Promise((r) => setTimeout(r, Math.min(cool, 10000)));
    try {
      last = await postChat(baseUrl, apiKey, body);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const sec = Math.round(timeoutFor(body) / 1000);
        throw new Error(`请求超时（${sec} 秒无响应），请检查接口地址或网络`);
      }
      throw new Error(`网络请求失败：${e.message}（请检查接口地址是否可访问）`);
    }
    if (last.ok || !RETRYABLE_STATUS.has(last.status)) return last;
    if (attempt === MAX_RETRIES) break;
    // 优先尊重服务端 Retry-After，否则 1s → 2s 指数退避
    const after = Number(last.headers.get('retry-after'));
    const wait =
      Number.isFinite(after) && after > 0
        ? Math.min(after * 1000, 10000)
        : 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
    // 429 拉高全局冷却，让并发中的其它请求一起让路，避免重试风暴
    if (last.status === 429) rateLimitUntil = Math.max(rateLimitUntil, Date.now() + wait);
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

/** 把 HTTP 状态码翻译成用户能看懂的提示。baseUrl 用于区分本地服务，给出针对性建议 */
function describeHttpError(status, raw, baseUrl) {
  const detail = String(raw || '').slice(0, 300);
  const local = baseUrl && isLocalEndpoint(baseUrl);
  if (status === 403 && local) {
    // 本地服务（Ollama 等）会校验 Origin，扩展的 chrome-extension:// 来源默认不在白名单里
    return '服务端拒绝了请求（403）。本地服务常见原因是未允许扩展来源：Ollama 需设置 OLLAMA_ORIGINS=*（或 chrome-extension://你的扩展ID）后重启再试';
  }
  if (status === 401 || status === 403) {
    // 本地端点根本不发送 Authorization，403 与 API Key 无关
    return local ? `被本地服务端拒绝（${status}）：${detail}` : `鉴权失败（${status}），请检查 API Key 是否正确`;
  }
  if (status === 404) return `接口地址不存在（404），请检查 Base URL（通常以 /v1 结尾）`;
  if (status === 429) return `请求过于频繁（429），请稍后重试或调低并发数`;
  if (status >= 500) return `服务端错误（${status}），请稍后重试`;
  return `接口返回 ${status}：${detail}`;
}

/** 带状态码的错误：上层据此判断换个方式重发是否还有意义 */
function httpError(status, raw, baseUrl) {
  const err = new Error(describeHttpError(status, raw, baseUrl));
  err.status = status;
  return err;
}

/** 最近翻译记录：划词、段落、输入框共用，最多保留 60 条 */
async function saveHistory(original, translated, lang) {
  try {
    const src = String(original || '').trim();
    const dst = String(translated || '').trim();
    if (!src || !dst || src === dst) return;
    const { history } = await chrome.storage.local.get({ history: [] });
    history.unshift({ o: src.slice(0, 400), t: dst.slice(0, 800), lang, ts: Date.now() });
    await chrome.storage.local.set({ history: history.slice(0, 60) });
  } catch {
    /* 记录失败不影响翻译 */
  }
}

/** 累计用量：请求次数与字符数，只存本地，用于估算消耗 */
async function bumpUsage(chars) {
  try {
    const { usage } = await chrome.storage.local.get({ usage: { requests: 0, chars: 0 } });
    usage.requests = (usage.requests || 0) + 1;
    usage.chars = (usage.chars || 0) + chars;
    usage.updatedAt = Date.now();
    await chrome.storage.local.set({ usage });
  } catch {
    /* 统计失败不影响翻译 */
  }
}

async function callChat(messages, opts = {}) {
  const cfg = await getConfig();
  const apiKey = (opts.apiKey || cfg.apiKey || '').trim();
  const baseUrl = (opts.baseUrl || cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const model = (opts.model || cfg.model || '').trim();

  // 本地 Ollama 等内网服务不需要 Key，只有远端接口才强制要求
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    throw new Error('未配置 API Key，请点击扩展图标 → 设置（本地模型可留空）');
  }
  if (!baseUrl) throw new Error('未配置接口地址（Base URL）');
  if (!model) throw new Error('未配置模型名称');

  const body = {
    model,
    messages,
    stream: false
  };
  if (cfg.temperature !== null && cfg.temperature !== undefined && cfg.temperature >= 0) {
    body.temperature = Number(cfg.temperature);
  }
  // 不再发送 response_format：翻译协议已改成「编号|译文」的纯文本行，
  // 强制 JSON 会和提示词冲突，逐条兜底时还会把 JSON 原文当译文写进页面。

  // 关闭思考模式（默认开）：按接口地址与模型名附加厂商参数
  const thinkOpts = cfg.disableThinking === false ? {} : thinkingParams(baseUrl, model);
  const thinkKeys = Object.keys(thinkOpts);
  Object.assign(body, thinkOpts);

  // 剔除该「host+模型」此前明确拒绝过的参数：否则每个批次都要重演一次 400
  await loadCompat();
  const rejected = droppedParams(baseUrl, model);
  if (rejected) {
    for (const k of rejected) delete body[k];
  }

  // 输出上限：按输入体量估算，留足余量不截断正常译文，但能挡住模型跑题无限生成。
  // 本地推理模型没有默认输出限制，跑题时会把一次请求拖到几分钟
  const estChars = messages.reduce((s, m) => s + String(m.content || '').length, 0);
  const limitKey = outputLimitKey(baseUrl, model);
  body[limitKey] = Math.min(8192, Math.ceil(estChars * 2) + 300);

  let res = await requestChat(baseUrl, apiKey, body);

  if (!res.ok) {
    let raw = await res.text().catch(() => '');
    // 接口不认识的参数逐个剥掉重试（temperature / 思考参数 / 输出上限）。
    // 老版本 Ollama、不支持思考开关的模型、限制取值范围的网关都走这条路。
    // 每剥掉一个就记进 paramCompat，后续请求直接不发，不必再付一次 400 的输入钱
    const optional = ['temperature', ...thinkKeys, limitKey].filter((k) => k in body);
    for (let i = 0; i < 3 && !res.ok && res.status === 400 && optional.length; i++) {
      const lower = raw.toLowerCase();
      const bad = optional.find((k) => lower.includes(k.toLowerCase()));
      if (!bad) break;
      delete body[bad];
      optional.splice(optional.indexOf(bad), 1);
      rememberDropped(baseUrl, model, bad);
      res = await requestChat(baseUrl, apiKey, body);
      raw = res.ok ? '' : await res.text().catch(() => '');
    }
    if (!res.ok) throw httpError(res.status, raw, baseUrl);
  }

  const data = await res.json();
  // 只统计成功请求，失败重试不计入，避免用量虚高
  bumpUsage(messages.reduce((s, m) => s + String(m.content || '').length, 0));
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('接口返回格式异常，未取到 choices[0].message.content');
  }
  // 兜底清掉内联在正文里的思考内容（vLLM / SGLang 的 Qwen3 会这样）
  return stripThinking(content);
}

/* ------------------------------------------------------------------ */
/* 流式翻译                                                            */
/* ------------------------------------------------------------------ */

/** 流式专用提示词：要求 NDJSON，一行一条，便于边收边解析 */
/**
 * 术语表：一行一条「原文=译文」，拼成提示词片段；没配置时返回空串。
 * haystack 为本批待译文本：只保留在其中出现过的术语，
 * 否则动辄上百条的术语表会在每个批次里重复发送，白白消耗 token。
 */
const GLOSSARY_HEAD = '术语表（出现时严格按下列译法，不得改写）：';

/** 术语表条目缓存：整份术语表对每条待译文本都要重新 split 一次是白做工 */
let glossaryLinesCache = { raw: '', lines: [] };
function glossaryLines(glossary) {
  const raw = String(glossary || '').trim();
  if (glossaryLinesCache.raw !== raw) {
    glossaryLinesCache = {
      raw,
      lines: raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && /[=＝]/.test(s))
        .slice(0, 300)
    };
  }
  return glossaryLinesCache.lines;
}

/** 术语表里命中这段文本的条目 */
function glossaryUsed(glossary, text) {
  const lines = glossaryLines(glossary);
  if (!lines.length || !text) return [];
  // 整段只小写化一次：放在 filter 里会对 300 条术语各做一次全量拷贝
  const lower = text.toLowerCase();
  return lines.filter((l) => {
    const src = l.split(/[=＝]/)[0].trim();
    // 大小写不敏感匹配：术语表写 Transformer，正文里出现 transformer 也要命中
    return src && lower.includes(src.toLowerCase());
  });
}

function glossaryBlock(glossary, haystack) {
  const lines = glossaryLines(glossary);
  if (!lines.length) return '';
  const lowerHay = haystack ? haystack.toLowerCase() : '';
  const used = haystack
    ? lines.filter((l) => {
        const src = l.split(/[=＝]/)[0].trim();
        return src && lowerHay.includes(src.toLowerCase());
      })
    : lines;
  if (!used.length) return '';
  return `${GLOSSARY_HEAD}\n${used.join('\n')}`;
}

/**
 * 单段文本实际命中的术语块，专用于缓存键。
 * 键里带全量术语表时，改一条与本文无关的术语就会让整站缓存失效、
 * 触发全量重译（一次就是几万 token）；按命中条目构造键后，
 * 同一文本无论落到哪个批次、术语表怎么改，只要作用于它的条目没变，键就稳定。
 */
function glossaryForText(glossary, text) {
  const used = glossaryUsed(glossary, text);
  return used.length ? `${GLOSSARY_HEAD}\n${used.join('\n')}` : '';
}

function buildStreamSystemPrompt(targetLang, custom, glossary, haystack) {
  const g = glossaryBlock(glossary, haystack);
  const tail = g ? `\n${g}` : '';
  if (custom && custom.trim()) {
    const c = custom.replace(/\{lang\}/g, targetLang);
    // 自定义提示词没写 {lang} 时补一句，否则模型不知道要译成什么语言
    const withLang = /\{lang\}/.test(custom) ? c : `${c}\n目标语言：${targetLang}`;
    // 自定义提示词可能要求输出 JSON 数组，流式下无法逐条解析，追加行格式约束
    return `${withLang}\n每行按「编号|译文」输出，不要数组和代码块。${tail}`;
  }
  return `把每行「编号|原文」译成「${targetLang}」，按「编号|译文」逐行输出，不遗漏，保留数字/链接/代码/专有名词，不要数组和代码块。${tail}`;
}

/**
 * 发起流式请求，每收到一段增量就回调 onDelta(delta, accumulated)。
 * 返回完整文本；接口不支持流式时抛错，由上层降级为非流式。
 */
async function streamChat(messages, onDelta) {
  const cfg = await getConfig();
  const apiKey = (cfg.apiKey || '').trim();
  const baseUrl = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const model = (cfg.model || '').trim();
  // 本地 Ollama 等内网服务不需要 Key，只有远端接口才强制要求
  if (!apiKey && !isLocalEndpoint(baseUrl)) throw new Error('未配置 API Key（本地模型可留空）');
  if (!baseUrl) throw new Error('未配置接口地址（Base URL）');
  if (!model) throw new Error('未配置模型名称');

  const body = { model, messages, stream: true };
  if (cfg.temperature !== null && cfg.temperature !== undefined && cfg.temperature >= 0) {
    body.temperature = Number(cfg.temperature);
  }
  // 关闭思考模式（默认开）：按接口地址与模型名附加厂商参数
  if (cfg.disableThinking !== false) {
    Object.assign(body, thinkingParams(baseUrl, model));
  }
  // 输出上限：挡住模型跑题无限生成（本地推理模型无默认限制，跑题能把请求拖到几分钟）。
  // 被接口拒绝时上层会降级到非流式，那里有 400 自动剥参数重试
  body[outputLimitKey(baseUrl, model)] = Math.min(
    8192,
    Math.ceil(messages.reduce((s, m) => s + String(m.content || '').length, 0) * 2) + 300
  );

  // 流式没有 400 自动剥离，参数被拒就是整批失败，所以先按记忆剔除已知不兼容项。
  // 这条记忆由非流式路径探测写入，第一次流式失败后，后续批次就不再撞同一个墙
  await loadCompat();
  const rejected = droppedParams(baseUrl, model);
  if (rejected) {
    for (const k of rejected) delete body[k];
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  activeStreamCtrls.add(ctrl);
  // 与非流式同一套估算：慢模型生成一批 2500 字可能要 100 秒以上，
  // 原来固定 120 秒会卡在临界点上，忽快忽慢时随机失败
  const timer = setTimeout(() => ctrl.abort(), timeoutFor(body));
  // 与非流式保持一致：成功结束后统计一次用量
  const countChars = () => messages.reduce((s, m) => s + String(m.content || '').length, 0);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      // 端点不存在 / 方法不允许：这个接口没有流式能力，记住它
      if (res.status === 404 || res.status === 405) streamUnsupported = true;
      // 400 多半是某个可选参数不被接受。流式没有自动剥离，只能记下来，
      // 让后续批次不再发送，避免每批都撞一次墙
      if (res.status === 400) {
        const lower = raw.toLowerCase();
        const candidates = [
          'temperature',
          ...Object.keys(thinkingParams(baseUrl, model)),
          outputLimitKey(baseUrl, model)
        ];
        for (const k of candidates) {
          if (lower.includes(k.toLowerCase())) rememberDropped(baseUrl, model, k);
        }
      }
      throw httpError(res.status, raw, baseUrl);
    }
    if (!res.body) {
      streamUnsupported = true;
      throw new Error('当前接口不支持流式响应');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          bumpUsage(countChars());
          return stripThinking(acc);
        }

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          acc += delta;
          // 只清洗增量：调用方只用第一个参数逐行解析，
          // 对 acc 反复跑正则会随输出变长成 O(n²)
          onDelta(stripThinking(delta), acc);
        }
      }
    }
    bumpUsage(countChars());
    return stripThinking(acc);
  } catch (e) {
    // 用户点「停止」：标记出来，上层直接收尾，不降级、不重发
    if (e && e.name === 'AbortError' && ctrl.userCancelled) {
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
    throw e;
  } finally {
    activeStreamCtrls.delete(ctrl);
    clearTimeout(timer);
  }
}

/**
 * 解析「编号|译文」，兼容 Markdown 表格 / 列表符号 / 编号: 译文。
 * allowDot 控制是否接受「1. 译文」：这种写法在译文折行时会把续行误判成新编号，
 * 只在整段都没有「编号|」行时（模型确实用了点号格式）才启用。
 */
function parseNumberedLine(line, allowDot) {
  const s = String(line || '')
    .trim()
    .replace(/^[-*•]\s+/, '')      // 去掉列表符号
    .replace(/^\*\*|\*\*$/g, '')   // 去掉加粗
    .trim();
  if (!s) return null;
  let m = s.match(/^\|?\s*(\d{1,4})\s*[|｜:：]\s*(.+?)\s*\|?$/);
  if (!m && allowDot) m = s.match(/^(\d{1,4})\.\s+(.+)$/);   // 点号后必须跟空格，避免 1.5 被误判
  if (!m) return null;
  const id = Number(m[1]);
  const text = m[2].trim();
  if (!Number.isFinite(id) || !text) return null;
  return { id, text };
}

/** 解析整段文本里的所有「编号|译文」；一条都没有时返回 null */
function parseNumberedBlock(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const pick = (allowDot) => {
    const out = {};
    let hit = 0;
    for (const line of lines) {
      const e = parseNumberedLine(line, allowDot);
      if (!e) continue;
      out[e.id] = e.text;
      hit++;
    }
    return hit ? out : null;
  };
  // 先按「编号|」严格解析；整段一条都没有时才接受「1. 译文」，
  // 避免译文折行的续行（如「2. 然后…」）覆盖真正的第 2 条
  return pick(false) || pick(true);
}

/** 把一行解析成 {id, text}：先按「编号|译文」，再按 JSON 兜底 */
function parseStreamEntry(line) {
  const plain = parseNumberedLine(line);
  if (plain) return plain;

  let s = String(line || '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  if (!s.startsWith('{')) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    s = s.slice(a, b + 1);
  }
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const rawId = obj.id ?? obj.i ?? Object.keys(obj)[0];
  const id = Number(rawId);
  if (!Number.isFinite(id)) return null;

  const text = obj.t ?? obj.text ?? obj.translation ?? obj[String(id)] ?? obj[id];
  if (typeof text !== 'string' || !text.trim()) return null;
  return { id, text: text.trim() };
}

/**
 * 流式批量翻译核心：边收边解析，每完成一条就回调 onEntry(下标, 译文)。
 * 返回已解析到的条目数。
 */
async function translateStreamCore(texts, lang, cfg, onEntry) {
  const user = buildBatchPrompt(texts);
  // 术语表按本批文本过滤，避免每个批次重复发送整份术语表
  const sys = buildStreamSystemPrompt(lang, cfg.systemPrompt, cfg.glossary, user);

  let buf = '';
  let parsed = 0;
  const seen = new Set();

  const handleLine = (line) => {
    const entry = parseStreamEntry(line);
    if (!entry) return;
    if (entry.id < 1 || entry.id > texts.length) return;
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    parsed++;
    onEntry(entry.id - 1, entry.text);
  };

  const raw = await streamChat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    (delta) => {
      buf += delta;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  );

  if (buf.trim()) handleLine(buf);

  // 模型没有按行输出（例如整段 JSON 数组）时，用完整文本兜底解析一次
  if (!parsed) {
    const obj = parseNumberedBlock(raw) || parseJsonObject(raw);
    if (obj && !Array.isArray(obj)) {
      texts.forEach((_, i) => {
        const v = obj[String(i + 1)] ?? obj[i + 1];
        if (typeof v === 'string' && v.trim()) {
          parsed++;
          onEntry(i, v.trim());
        }
      });
    }
  }

  return parsed;
}

/**
 * 带缓存与推送的流式批量翻译。
 * push(index, text) 会在每条译文可用时立即调用。
 */
async function translateBatchStream(texts, targetLang, push) {
  if (!texts.length) return { ok: true };

  const cfg = await getConfig();
  const lang = targetLang || cfg.targetLang || '简体中文';
  const model = cfg.model || '';
  // 提示词和术语表都会改变译文，必须一起进缓存键，否则改了配置还命中旧译文。
  // 术语表只带「该文本命中的条目」：改一条无关术语不会再让整站缓存失效、
  // 触发全量重译（一次重译就是几万 token）
  const sysPrompt = (cfg.systemPrompt || '').trim();
  const keyOf = (t) =>
    cacheKey(model, lang, t, `${sysPrompt}\u0000${glossaryForText(cfg.glossary, t)}`);

  await loadCache();

  const out = new Array(texts.length).fill('');
  const miss = [];
  texts.forEach((t, i) => {
    const hit = lookupTranslation(keyOf(t));
    if (hit) {
      out[i] = hit;
      push(i, hit);
    } else {
      miss.push(i);
    }
  });
  if (!miss.length) return { ok: true, cached: true };

  // 已探知该接口不支持流式时直接走非流式，省掉每个批次一次注定失败的请求
  if (!streamUnsupported) {
    try {
      await translateStreamCore(miss.map((i) => texts[i]), lang, cfg, (k, text) => {
        const idx = miss[k];
        out[idx] = text;
        // 原文即译文也写缓存：专有名词、代码标识符这类模型原样返回的条目，
        // 不缓存的话每次翻译都要重新请求一遍（导航、页脚、表头在每个页面都出现）
        rememberTranslation(keyOf(texts[idx]), text);
        push(idx, text);
      });
    } catch (e) {
      // 用户点了停止：直接收尾，既不降级也不重发，省掉一次整批请求
      if (e && e.cancelled) {
        flushCache(); // 已经收到的译文仍要落盘，下次不用重译
        return { ok: false, cancelled: true };
      }
      // 流式不可用（接口不支持 / 网络中断）交给调用方降级为非流式重发；
      // 但鉴权、地址、限流类错误换个姿势重发也必然失败，
      // 直接抛出，省掉整批一次注定失败的重复请求（并发 6 时就是 6 次）
      if (!out.some(Boolean)) {
        const fatal =
          e.status === 401 || e.status === 403 || e.status === 404 || e.status === 429;
        return fatal
          ? { ok: false, error: e.message }
          : { ok: false, fallback: true, error: e.message };
      }
    }
  }

  flushCache();

  // 流式没覆盖到的部分，用非流式补齐
  const missing = miss.filter((i) => !out[i]);
  if (missing.length) {
    const res = await translateCore(missing.map((i) => texts[i]), lang, cfg);
    if (res.ok) {
      missing.forEach((idx, k) => {
        const text = res.translations[k];
        if (!text) return;
        out[idx] = text;
        // 原文即译文也写缓存：专有名词、代码标识符这类模型原样返回的条目，
        // 不缓存的话每次翻译都要重新请求一遍（导航、页脚、表头在每个页面都出现）
        rememberTranslation(keyOf(texts[idx]), text);
        push(idx, text);
      });
      flushCache();
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 提示词与解析                                                        */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(targetLang, custom, glossary, haystack) {
  const g = glossaryBlock(glossary, haystack);
  const tail = g ? `\n${g}` : '';
  if (custom && custom.trim()) {
    const c = custom.replace(/\{lang\}/g, targetLang);
    // 自定义提示词没写 {lang} 时补一句，否则模型不知道要译成什么语言
    const base = /\{lang\}/.test(custom) ? c : `${c}\n目标语言：${targetLang}`;
    return base + tail;
  }
  // 一行一条：比 <seg> 包装和 JSON 键值省一半以上 token
  return `把每行「编号|原文」译成「${targetLang}」，输出「编号|译文」，逐行对应不遗漏，保留数字/链接/代码/专有名词，不要解释。${tail}`;
}

// 编号|原文，一行一条；连续空白压成单个空格、去掉首尾空白，
// 不改语义但每个批次省下若干 token
function buildBatchPrompt(texts) {
  return texts
    .map((t, i) => `${i + 1}|${String(t).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/** 从模型回复中尽量提取 JSON 对象；失败返回 null */
function parseJsonObject(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  // 去掉 ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };

  let obj = tryParse(text);
  if (obj) return obj;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    obj = tryParse(text.slice(start, end + 1));
    if (obj) return obj;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                            */
/* ------------------------------------------------------------------ */

/**
 * 批量翻译
 * @returns {{ok: boolean, translations?: string[], error?: string}}
 */
async function translateBatch(texts, targetLang) {
  if (!texts.length) return { ok: true, translations: [] };

  const cfg = await getConfig();
  const lang = targetLang || cfg.targetLang || '简体中文';
  const model = cfg.model || '';
  // 自定义提示词会改变译文风格，必须参与缓存键，否则改完设置仍命中旧译文。
  // 术语表只带「该文本命中的条目」：改一条无关术语不会再让整站缓存失效、
  // 触发全量重译（一次重译就是几万 token）
  const sysPrompt = (cfg.systemPrompt || '').trim();
  const keyOf = (t) =>
    cacheKey(model, lang, t, `${sysPrompt}\u0000${glossaryForText(cfg.glossary, t)}`);

  await loadCache();

  // 先查缓存，命中部分不再发起请求
  const out = new Array(texts.length).fill('');
  const miss = [];
  texts.forEach((t, i) => {
    const hit = lookupTranslation(keyOf(t));
    if (hit) out[i] = hit;
    else miss.push(i);
  });

  if (!miss.length) return { ok: true, translations: out, cached: true };

  const res = await translateCore(miss.map((i) => texts[i]), lang, cfg);
  if (!res.ok) {
    // 部分命中时仍然返回可用结果，未命中的留空由前端按失败处理
    if (out.some(Boolean)) return { ok: true, translations: out };
    return res;
  }

  miss.forEach((idx, k) => {
    const v = res.translations[k];
    if (!v) return;
    out[idx] = v;
    // 译文与原文相同（专有名词、已是目标语言）同样写缓存：
    // 这类条目往往在导航、页脚反复出现，不缓存等于每次重译一遍
    rememberTranslation(keyOf(texts[idx]), v);
  });
  flushCache();

  return { ok: true, translations: out };
}

/** 实际发起请求的批量翻译（不含缓存逻辑） */
async function translateCore(texts, lang, cfg) {
  // 术语表按本批文本过滤，避免每个批次重复发送整份术语表
  const sys = buildSystemPrompt(lang, cfg.systemPrompt, cfg.glossary, texts.join('\n'));

  try {
    const raw = await callChat([
      { role: 'system', content: sys },
      { role: 'user', content: buildBatchPrompt(texts) }
    ]);

    const obj = parseNumberedBlock(raw) || parseJsonObject(raw);
    if (obj) {
      const out = texts.map((_, i) => {
        const v = obj[String(i + 1)] ?? obj[i + 1];
        return typeof v === 'string' ? v.trim() : '';
      });
      // 解析到一部分就只补缺失，已命中的不再重发；一条都没解析到才全量逐条
      const hit = out.filter(Boolean).length;
      if (hit === texts.length) return { ok: true, translations: out };
      if (hit > 0) {
        const retryIdx = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
        const retry = await translateIndividually(retryIdx.map((i) => texts[i]), lang, cfg);
        retryIdx.forEach((idx, k) => {
          if (retry[k]) out[idx] = retry[k];
        });
        return { ok: true, translations: out };
      }
    }
  } catch (e) {
    if (texts.length === 1) return { ok: false, error: e.message };
    // 鉴权 / 地址 / 限流：拆开重发也必然失败，而且 429 拆半只会把请求数翻倍
    if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 429) {
      return { ok: false, error: e.message };
    }
    // 先拆半重试：批次过大导致的超时、输出被截断、网关单请求上限，拆开后往往直接成功。
    // 原来直接逐条，一批 64 条会变成 64 次请求，每次都带一份完整 system prompt
    if (texts.length > 8) {
      const mid = Math.ceil(texts.length / 2);
      const [a, b] = await Promise.all([
        translateCore(texts.slice(0, mid), lang, cfg),
        translateCore(texts.slice(mid), lang, cfg)
      ]);
      if (a.ok || b.ok) {
        return {
          ok: true,
          translations: [
            ...(a.ok ? a.translations : texts.slice(0, mid).map(() => '')),
            ...(b.ok ? b.translations : texts.slice(mid).map(() => ''))
          ]
        };
      }
      return { ok: false, error: e.message };
    }
    // 小批次仍失败才逐条：先探测一条，避免配置错误导致大量无效请求
    const probe = await translateIndividually([texts[0]], lang, cfg);
    if (!probe[0]) return { ok: false, error: e.message };
    const rest = await translateIndividually(texts.slice(1), lang, cfg);
    const merged = [probe[0], ...rest];
    return { ok: true, translations: merged };
  }

  const one = await translateIndividually(texts, lang, cfg);
  if (one.some((v) => v)) {
    return { ok: true, translations: one };
  }
  return { ok: false, error: '翻译失败：模型未返回可用结果（可在设置页测试连接排查）' };
}

/** 清洗模型返回的裸译文 */
function cleanupTranslation(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith('{')) {
    const o = parseJsonObject(s);
    if (o) s = String(o['1'] ?? o[1] ?? s);
  }
  return s.replace(/^["'“”]|["'“”]$/g, '').trim();
}

/** 逐条翻译（批量失败兜底）。并发执行，避免串行拖慢 */
async function translateIndividually(texts, lang, cfg) {
  if (!texts.length) return [];

  const conf = cfg || (await getConfig());
  const sys = `把内容译成「${lang}」，只输出译文本身，不要引号、解释、JSON 或 Markdown。`;

  const out = new Array(texts.length).fill('');
  let cursor = 0;

  const worker = async () => {
    while (cursor < texts.length) {
      const i = cursor++;
      try {
        const raw = await callChat([
          { role: 'system', content: sys },
          { role: 'user', content: texts[i] }
        ]);
        out[i] = cleanupTranslation(raw);
      } catch {
        out[i] = '';
      }
    }
  };

  // 并发跟设置走：逐条兜底只在批量路径彻底失败时才走，这里不必再压得比主路径低
  const parallel = Math.max(1, Math.min(Number(conf.concurrency) || 8, 16));
  await Promise.all(Array.from({ length: Math.min(parallel, texts.length) }, worker));
  return out;
}

/** 测试连通性 */
async function testConnection(override) {
  try {
    const reply = await callChat(
      [
        { role: 'system', content: '你是一个连通性测试助手。' },
        { role: 'user', content: '只回复两个字：成功' }
      ],
      override || {}
    );
    return { ok: true, reply: String(reply).trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case 'translateBatch':
      return translateBatch(msg.texts || [], msg.targetLang);

    case 'translateStream': {
      const tabId = sender.tab?.id;
      const streamId = msg.streamId;
      if (!tabId || !streamId) return { ok: false, error: '无法定位标签页' };

      // 立即返回，译文通过 tabs.sendMessage 逐条推送
      translateBatchStream(msg.texts || [], msg.targetLang, (index, text) => {
        chrome.tabs
          .sendMessage(tabId, { type: 'llmtChunk', streamId, index, text })
          .catch(() => {});
      })
        .then((res) => {
          chrome.tabs
            .sendMessage(tabId, {
              type: 'llmtDone',
              streamId,
              ok: res.ok,
              fallback: !!res.fallback,
              error: res.error || ''
            })
            .catch(() => {});
        })
        .catch((e) => {
          chrome.tabs
            .sendMessage(tabId, { type: 'llmtDone', streamId, ok: false, error: e.message })
            .catch(() => {});
        });

      return { ok: true, accepted: true };
    }

    case 'cancelStreams': {
      // 真正中止在途请求：不中止的话模型会一直生成到结束，token 照付
      for (const c of activeStreamCtrls) {
        c.userCancelled = true;
        c.abort();
      }
      activeStreamCtrls.clear();
      return { ok: true };
    }

    case 'translateText': {
      const cfg = await getConfig();
      const lang = msg.targetLang || cfg.targetLang;
      const res = await translateIndividually([msg.text], lang, cfg);
      if (res[0]) saveHistory(msg.text, res[0], lang);
      return res[0]
        ? { ok: true, translation: res[0] }
        : { ok: false, error: '翻译失败，请检查模型配置' };
    }

    case 'getHistory': {
      const { history } = await chrome.storage.local.get({ history: [] });
      return { ok: true, history };
    }

    case 'clearHistory':
      await chrome.storage.local.set({ history: [] });
      return { ok: true };

    case 'ping':
      // 预热：content script 注入时就把 Service Worker 唤醒、缓存预载进内存，
      // 用户点翻译时不必等冷启动和首轮读盘
      await loadCache();
      return { ok: true };

    case 'testConnection':
      return testConnection(msg.override);

    case 'clearCache':
      await clearCache();
      return { ok: true };

    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'toggleTranslate':
      return await toggleTranslateOnTab(sender.tab?.id ?? msg.tabId);

    case 'translatePage':
      return await toggleTranslateOnTab(msg.tabId, 'translate');

    case 'restorePage':
      return await toggleTranslateOnTab(msg.tabId, 'restore');

    default:
      return { ok: false, error: `未知消息类型：${msg && msg.type}` };
  }
}

async function toggleTranslateOnTab(tabId, action) {
  if (!tabId) return { ok: false, error: '未找到当前标签页' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'pageAction', action: action || 'toggle' });
    return res || { ok: true };
  } catch (e) {
    return { ok: false, error: '当前页面不支持翻译（请刷新页面后重试）' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // 保持异步通道
});

/* ------------------------------------------------------------------ */
/* 右键菜单 & 快捷键                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'llmt-translate-selection',
      title: '用 AI 翻译选中内容',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'llmt-translate-page',
      title: 'AI 翻译整个页面',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'llmt-translate-selection') {
    chrome.tabs
      .sendMessage(tab.id, { type: 'translateSelection', text: info.selectionText })
      .catch(() => {});
  } else if (info.menuItemId === 'llmt-translate-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'pageAction', action: 'translate' }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-translate' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'pageAction', action: 'toggle' }).catch(() => {});
  }
});
