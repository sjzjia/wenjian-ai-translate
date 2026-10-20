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

const HOUR_MS = 3600000;
const CHART_HOURS = 24;

let chartSeries = []; // 最近 24 个小时桶，按时间升序
let chartHover = -1;
let chartRaf = 0;
let usageTimer = 0;

async function loadUsage() {
  const el = $('usageText');
  if (!el) return;
  const { usage } = await chrome.storage.local.get({
    usage: { requests: 0, chars: 0, tokens: 0 }
  });
  const req = Number(usage.requests || 0);
  const chars = Number(usage.chars || 0);
  const tokens = Number(usage.tokens || 0);
  el.textContent = `已请求 ${req} 次，累计 ${chars.toLocaleString()} 字符 / 约 ${tokens.toLocaleString()} tokens（仅本地统计）`;
  await loadChart();
}

async function loadChart() {
  const { usageHourly } = await chrome.storage.local.get({ usageHourly: [] });
  const nowHour = Math.floor(Date.now() / HOUR_MS);
  const map = new Map();
  for (const b of Array.isArray(usageHourly) ? usageHourly : []) {
    if (b && typeof b.h === 'number') map.set(b.h, b);
  }
  chartSeries = [];
  // 固定 24 个槽位（当前小时往前 23 个），没有记录的小时补零，波形才不会跳
  for (let i = CHART_HOURS - 1; i >= 0; i--) {
    const h = nowHour - i;
    const b = map.get(h);
    chartSeries.push({ h, c: b ? Number(b.c) || 0 : 0, t: b ? Number(b.t) || 0 : 0 });
  }
  chartHover = -1;
  hideTip();
  drawChart();
}

function fmtShort(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toLocaleString();
}

function hourLabel(h) {
  const d = new Date(h * HOUR_MS);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

function drawChart() {
  const canvas = $('usageChart');
  const hint = $('usageChartHint');
  if (!canvas || !chartSeries.length) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(280, canvas.clientWidth || canvas.parentElement?.clientWidth || 640);
  const cssH = 168;
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  // 只在尺寸真的变了才重设：给 width 赋值会清空画布，hover 时不该走这条
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 10;
  const padR = 10;
  const padT = 18;
  const padB = 22;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;
  const slot = w / CHART_HOURS;
  const barW = Math.max(2, slot * 0.28);
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

  // 三条横向网格
  ctx.strokeStyle = '#eef2f7';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = padT + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
  }

  const maxT = Math.max(1, ...chartSeries.map((s) => s.t));
  const maxC = Math.max(1, ...chartSeries.map((s) => s.c));
  const hasData = chartSeries.some((s) => s.t || s.c);

  if (!hasData) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = `12px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText('最近 24 小时还没有翻译记录', padL + w / 2, padT + h / 2);
    if (hint) hint.textContent = '翻译任意页面后，这里会按小时显示消耗';
    hideTip();
    return;
  }

  // 悬停整列高亮：只改柱子颜色太细微，加一条竖向虚线一眼能看出选中哪一格
  if (chartHover >= 0) {
    const hx = padL + slot * chartHover;
    ctx.fillStyle = 'rgba(37, 99, 235, 0.07)';
    ctx.fillRect(hx, padT, slot, h);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.3)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx + slot / 2, padT);
    ctx.lineTo(hx + slot / 2, padT + h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  chartSeries.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const hovered = i === chartHover;
    // token 与字符并排，各自按自身峰值缩放，只比形状不比高度
    const th = (s.t / maxT) * h;
    const ch = (s.c / maxC) * h;
    if (s.t) {
      ctx.fillStyle = hovered ? '#1d4ed8' : '#2563eb';
      ctx.fillRect(cx - barW - 1, padT + h - th, barW, th);
    }
    if (s.c) {
      ctx.fillStyle = hovered ? '#60a5fa' : '#93c5fd';
      ctx.fillRect(cx + 1, padT + h - ch, barW, ch);
    }
  });

  // 时间轴：首、每 6 小时、尾
  ctx.fillStyle = '#94a3b8';
  ctx.font = `10.5px ${font}`;
  ctx.textAlign = 'center';
  [0, 6, 12, 18, 23].forEach((i) => {
    const x = padL + slot * i + slot / 2;
    const clamped = Math.min(Math.max(x, padL + 16), padL + w - 16);
    ctx.fillText(hourLabel(chartSeries[i].h), clamped, cssH - 6);
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`峰值 ${fmtShort(maxT)} tokens / ${fmtShort(maxC)} 字符`, padL, 12);

  if (hint) {
    if (chartHover >= 0) {
      const s = chartSeries[chartHover];
      hint.textContent = `${hourLabel(s.h)} 这一小时：${s.t.toLocaleString()} tokens · ${s.c.toLocaleString()} 字符`;
    } else {
      hint.textContent = '把鼠标移到柱子上查看该小时的具体数值';
    }
  }
}

function hideTip() {
  const tip = $('usageChartTip');
  if (tip) tip.hidden = true;
}

/** 跟随鼠标的数值浮层；i < 0 表示落在图外 */
function updateTip(e, i) {
  const tip = $('usageChartTip');
  if (!tip) return;
  const s = chartSeries[i];
  if (i < 0 || !s) {
    tip.hidden = true;
    return;
  }

  tip.innerHTML =
    `<div class="tip-head">${hourLabel(s.h)} – ${hourLabel(s.h + 1)}</div>` +
    `<div class="tip-row"><span>Token</span><b>${s.t.toLocaleString()}</b></div>` +
    `<div class="tip-row"><span>字符</span><b>${s.c.toLocaleString()}</b></div>`;

  const block = tip.parentElement;
  const br = block.getBoundingClientRect();
  // 左右夹紧，避免浮层被卡片边缘裁掉；顶部留出自身高度，别翻到卡片外面
  const x = Math.min(Math.max(e.clientX - br.left, 70), Math.max(70, br.width - 70));
  const y = Math.max(e.clientY - br.top - 12, 64);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.hidden = false;
}

function bindChartEvents() {
  const canvas = $('usageChart');
  if (!canvas) return;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const padL = 10;
    const padR = 10;
    const slot = (rect.width - padL - padR) / CHART_HOURS;
    const i = Math.floor((e.clientX - rect.left - padL) / slot);
    const next = i >= 0 && i < CHART_HOURS ? i : -1;
    if (next !== chartHover) {
      chartHover = next;
      drawChart();
    }
    // 同一列内移动也要跟着走，所以放在判断外面
    updateTip(e, next);
  });

  canvas.addEventListener('mouseleave', () => {
    if (chartHover !== -1) {
      chartHover = -1;
      drawChart();
    }
    hideTip();
  });

  window.addEventListener('resize', () => {
    if (chartRaf) cancelAnimationFrame(chartRaf);
    chartRaf = requestAnimationFrame(() => {
      chartRaf = 0;
      hideTip();
      drawChart();
    });
  });
}

// 设置页开着时后台还在翻译：节流刷新，别每次请求都重绘
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.usage && !changes.usageHourly)) return;
  clearTimeout(usageTimer);
  usageTimer = setTimeout(loadUsage, 500);
});

$('resetUsage').addEventListener('click', async () => {
  await chrome.storage.local.set({
    usage: { requests: 0, chars: 0, tokens: 0 },
    usageHourly: []
  });
  await loadUsage();
});

load();
bindChartEvents();
loadUsage();
