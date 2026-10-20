const DEFAULTS = {
  targetLang: '简体中文',
  bilingual: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
};

const $ = (id) => document.getElementById(id);

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

let currentTab = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!currentTab?.id) return resolve({ ok: false, error: '无可用标签页' });
    chrome.tabs.sendMessage(currentTab.id, msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: '当前页面不可用，请刷新后重试' });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

let currentLang = '简体中文';

/** 把任意语言名插到下拉框里（放在"自定义…"之前） */
function addLangOption(sel, value) {
  if (!value) return;
  if ([...sel.options].some((o) => o.value === value)) return;
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value;
  const custom = sel.querySelector('option[value="__custom__"]');
  sel.insertBefore(opt, custom);
}

async function init() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);

  const sel = $('langSelect');
  currentLang = cfg.targetLang || '简体中文';
  addLangOption(sel, currentLang);
  sel.value = currentLang;
  $('bilingual').checked = !!cfg.bilingual;

  // 本地端点（Ollama 等）允许 Key 留空
  $('modelName').textContent = cfg.apiKey || isLocalBaseUrl(cfg.baseUrl) ? cfg.model : '未配置 API Key';

  if (!cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
    setStatus('尚未配置 API Key，请点击右上角 ⚙ 完成设置后再使用。', true);
  }

  currentTab = await getActiveTab();
  const res = await sendToTab({ type: 'getStatus' });
  if (res?.ok) {
    $('pageState').textContent =
      res.status === 'done'
        ? `已翻译 ${res.count} 段`
        : res.status === 'partial'
        ? `已译 ${res.count} 段，未完成`
        : res.status === 'translating'
        ? '翻译中…'
        : '就绪';
  } else {
    $('pageState').textContent = '当前页面不可用';
  }
}

$('langSelect').addEventListener('change', async (e) => {
  const value = e.target.value;

  if (value === '__custom__') {
    const input = window.prompt('请输入目标语言，例如：Italiano、粤语、文言文');
    const val = (input || '').trim();
    if (!val) {
      e.target.value = currentLang;
      return;
    }
    addLangOption(e.target, val);
    e.target.value = val;
    currentLang = val;
    await chrome.storage.sync.set({ targetLang: val });
    setStatus(`目标语言已设为「${val}」，重新翻译生效。`);
    return;
  }

  currentLang = value;
  await chrome.storage.sync.set({ targetLang: value });
  setStatus('目标语言已更新，重新翻译生效。');
});

$('bilingual').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ bilingual: e.target.checked });
  setStatus(e.target.checked ? '已开启双语对照，重新翻译生效。' : '已关闭双语对照。');
});

$('translatePage').addEventListener('click', async () => {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  // 本地 Ollama 等内网服务不需要 Key，只有远端接口才强制要求
  if (!cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
    setStatus('请先配置 API Key（本地模型可留空）', true);
    return;
  }
  const res = await sendToTab({ type: 'pageAction', action: 'translate' });
  if (res?.ok) {
    $('pageState').textContent = '翻译中…';
    setStatus('已开始翻译，请回到页面查看进度。');
  } else {
    setStatus(res?.error || '当前页面不可用，请刷新后重试', true);
  }
});

$('restorePage').addEventListener('click', async () => {
  const res = await sendToTab({ type: 'pageAction', action: 'restore' });
  if (res?.ok) {
    $('pageState').textContent = '就绪';
    setStatus('已还原原文。');
  } else {
    setStatus(res?.error || '当前页面不可用', true);
  }
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

/* ---------------- 最近翻译 ---------------- */

async function renderHistory() {
  const box = $('history');
  const clear = $('clearHistory');
  const res = await chrome.runtime.sendMessage({ type: 'getHistory' });
  const list = res?.history || [];

  box.textContent = '';
  clear.hidden = list.length === 0;

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'h-empty';
    empty.textContent = '还没有划词或段落翻译记录';
    box.appendChild(empty);
    return;
  }

  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'h-row';
    row.title = '点击复制译文';

    const o = document.createElement('div');
    o.className = 'h-o';
    o.textContent = h.o;

    const t = document.createElement('div');
    t.className = 'h-t';
    t.textContent = h.t;

    row.append(o, t);
    row.addEventListener('click', () => {
      navigator.clipboard.writeText(h.t).then(
        () => setStatus('已复制译文'),
        () => setStatus('复制失败', true)
      );
    });
    box.appendChild(row);
  }
}

$('toggleHistory').addEventListener('click', async () => {
  const box = $('history');
  if (!box.hidden) {
    box.hidden = true;
    $('clearHistory').hidden = true;
    return;
  }
  box.hidden = false;
  await renderHistory();
});

$('clearHistory').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearHistory' });
  await renderHistory();
  setStatus('已清空翻译记录');
});
$('openOptions2').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
