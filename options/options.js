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
  glossary: '',
  compactPrompt: true
};

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' }
};

// 本地/内网端点（Ollama 等）无需 API Key
function isLocalBaseUrl(baseUrl) {
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

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'systemPrompt', 'glossary'];
const NUMBER_FIELDS = ['temperature', 'maxCharsPerBatch', 'concurrency'];
const BOOL_FIELDS = [
  'bilingual',
  'autoTranslateSelection',
  'autoPrompt',
  'disableThinking',
  'hoverTranslate',
  'inputTranslate',
  'autoFollow',
  'compactPrompt'
];

function readForm() {
  const cfg = {};
  TEXT_FIELDS.forEach((k) => {
    cfg[k] = $(k).value.trim();
  });
  NUMBER_FIELDS.forEach((k) => {
    const v = Number($(k).value);
    cfg[k] = Number.isFinite(v) ? v : DEFAULTS[k];
  });
  BOOL_FIELDS.forEach((k) => {
    cfg[k] = $(k).checked;
  });
  return cfg;
}

function fillForm(cfg) {
  TEXT_FIELDS.forEach((k) => {
    $(k).value = cfg[k] ?? DEFAULTS[k];
  });
  NUMBER_FIELDS.forEach((k) => {
    $(k).value = cfg[k] ?? DEFAULTS[k];
  });
  BOOL_FIELDS.forEach((k) => {
    $(k).checked = !!cfg[k];
  });
}

function setResult(el, text, kind = '') {
  el.textContent = text;
  el.className = `result${kind ? ' ' + kind : ''}`;
}

// 表单用存储值填充前禁止保存，否则会把复选框读成页面初始的未勾选状态
let loaded = false;
$('saveBtn').disabled = true;

async function load() {
  try {
    const cfg = await chrome.storage.sync.get(DEFAULTS);
    fillForm(cfg);
  } finally {
    loaded = true;
    $('saveBtn').disabled = false;
  }
}

$('preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  $('baseUrl').value = p.baseUrl;
  $('model').value = p.model;
  $('preset').value = '';
  setResult($('testResult'), '已填入预设，请补充 API Key 后测试连接（本地模型可留空）。');
});

$('toggleKey').addEventListener('click', () => {
  const input = $('apiKey');
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  $('toggleKey').textContent = isPwd ? '隐藏' : '显示';
});

$('saveBtn').addEventListener('click', async () => {
  if (!loaded) await load();
  const cfg = readForm();
  if (!cfg.baseUrl) {
    setResult($('saveHint'), '请填写 Base URL', 'err');
    return;
  }
  await chrome.storage.sync.set(cfg);
  setResult($('saveHint'), '已保存', 'ok');
  setTimeout(() => setResult($('saveHint'), ''), 2200);
});

$('resetBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  fillForm(DEFAULTS);
  setResult($('saveHint'), '已恢复默认配置', 'ok');
  setTimeout(() => setResult($('saveHint'), ''), 2200);
});

$('testBtn').addEventListener('click', async () => {
  const cfg = readForm();
  const btn = $('testBtn');
  const out = $('testResult');

  // 本地 Ollama 等内网服务不需要 Key，只有远端接口才强制要求
  if (!cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
    setResult(out, '请先填写 API Key（本地模型可留空）', 'err');
    return;
  }

  btn.disabled = true;
  setResult(out, '正在请求模型…');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'testConnection',
      override: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }
    });
    if (res?.ok) {
      setResult(out, `连接成功，模型回复：${res.reply || '（空）'}`, 'ok');
    } else {
      setResult(out, `连接失败：${res?.error || '未知错误'}`, 'err');
    }
  } catch (e) {
    setResult(out, `连接失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('resetSkipBtn').addEventListener('click', async () => {
  const out = $('cacheHint');
  try {
    await chrome.storage.sync.set({ skipSites: [] });
    setResult(out, '已恢复所有站点的翻译提示', 'ok');
  } catch (e) {
    setResult(out, `操作失败：${e.message}`, 'err');
  }
  setTimeout(() => setResult(out, ''), 2400);
});

$('clearCacheBtn').addEventListener('click', async () => {
  const btn = $('clearCacheBtn');
  const out = $('cacheHint');
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
    setResult(out, res?.ok ? '缓存已清除' : `清除失败：${res?.error || '未知错误'}`, res?.ok ? 'ok' : 'err');
  } catch (e) {
    setResult(out, `清除失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    setTimeout(() => setResult(out, ''), 2400);
  }
});

// 输入变化时提示未保存
[...TEXT_FIELDS, ...NUMBER_FIELDS].forEach((k) => {
  $(k).addEventListener('input', () => {
    setResult($('saveHint'), '有未保存的修改');
  });
});

/* ---------------- 用量统计 ---------------- */

async function loadUsage() {
  const el = $('usageText');
  if (!el) return;
  const { usage } = await chrome.storage.local.get({ usage: { requests: 0, chars: 0 } });
  const req = Number(usage.requests || 0);
  const chars = Number(usage.chars || 0);
  el.textContent = `已请求 ${req} 次，累计 ${chars.toLocaleString()} 字符（仅本地统计）`;
}

$('resetUsage').addEventListener('click', async () => {
  await chrome.storage.local.set({ usage: { requests: 0, chars: 0 } });
  await loadUsage();
});

load();
loadUsage();
