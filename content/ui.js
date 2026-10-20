/**
 * UI 层：Shadow DOM 隔离的悬浮按钮 + 译文卡片 + 进度提示。
 * 挂载在 window.__LLMT_UI 上。
 */
(() => {
  const HOST_ID = 'llmt-root';

  // 自定义图标：Shadow DOM 里的相对路径按页面地址解析，必须用扩展绝对 URL
  let ICON_URL = '';
  try {
    ICON_URL = chrome.runtime.getURL('icons/icon128.png');
  } catch {
    /* 非扩展环境 */
  }

  // 页面 CSP 拦掉 chrome-extension:// 图片时的兜底，保证不会留一块空白
  const fallbackLogo = (cls) =>
    `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#2563eb" />
      <text x="16" y="22.5" text-anchor="middle" font-size="19" font-weight="700"
        fill="#ffffff">译</text>
    </svg>`;

  const logoMarkup = (cls) =>
    ICON_URL
      ? `<img class="${cls}" src="${ICON_URL}" alt="" />`
      : fallbackLogo(cls);

  let host = null;
  let shadow = null;
  let trigger = null;
  let card = null;
  let toast = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }

    .llmt-trigger {
      position: fixed; z-index: 2147483647; display: none;
      width: 30px; height: 30px; border-radius: 50%;
      background: #2563eb; color: #fff; border: none; cursor: pointer;
      box-shadow: 0 4px 14px rgba(37,99,235,.45);
      font-size: 13px; font-weight: 600; line-height: 30px; text-align: center;
      padding: 0; user-select: none;
      transition: transform .12s ease, background .12s ease;
    }
    .llmt-trigger:hover { transform: scale(1.08); background: #1d4ed8; }

    .llmt-card {
      position: fixed; z-index: 2147483647; display: none;
      width: 380px; max-width: calc(100vw - 24px);
      background: #fff; color: #111827;
      border: 1px solid #e5e7eb; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(15,23,42,.18), 0 2px 8px rgba(15,23,42,.08);
      overflow: hidden;
      animation: llmt-in .14s ease-out;
    }
    @keyframes llmt-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

    .llmt-head {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 12px; border-bottom: 1px solid #f1f5f9; background: #f8fafc;
    }
    .llmt-title { font-size: 12px; font-weight: 600; color: #475569; flex: 1; letter-spacing: .02em; }
    .llmt-logo { width: 16px; height: 16px; flex: none; display: block; }
    .llmt-iconbtn {
      width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer;
      background: transparent; color: #64748b; font-size: 13px; line-height: 1;
      display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .llmt-iconbtn:hover { background: #e2e8f0; color: #0f172a; }

    .llmt-body { padding: 12px 14px; max-height: 46vh; overflow-y: auto; }
    .llmt-src {
      font-size: 12px; line-height: 1.6; color: #94a3b8;
      margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e2e8f0;
      max-height: 84px; overflow: hidden; word-break: break-word;
    }
    .llmt-src.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .llmt-dst {
      font-size: 14px; line-height: 1.75; color: #0f172a;
      white-space: pre-wrap; word-break: break-word;
    }
    .llmt-dst.loading { color: #94a3b8; }
    .llmt-dst.error { color: #dc2626; font-size: 13px; }

    .llmt-foot {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-top: 1px solid #f1f5f9; background: #fafbfc;
    }
    .llmt-spacer { flex: 1; }
    .llmt-btn {
      border: 1px solid #e2e8f0; background: #fff; color: #475569;
      font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    }
    .llmt-btn:hover { background: #f1f5f9; color: #0f172a; }
    .llmt-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .llmt-btn.primary:hover { background: #1d4ed8; }

    .llmt-dots::after {
      content: ''; display: inline-block; width: 12px; text-align: left;
      animation: llmt-dots 1.2s steps(4, end) infinite;
    }
    @keyframes llmt-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }

    .llmt-toast {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 28px;
      transform: translateX(-50%);
      background: rgba(15,23,42,.92); color: #fff;
      font-size: 13px; line-height: 1; padding: 10px 16px; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.25); display: none;
      max-width: 70vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .llmt-prompt {
      position: fixed; z-index: 2147483647;
      left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 360px; max-width: calc(100vw - 32px);
      background: #fff; color: #0f172a;
      border: 1px solid #dbe3ee; border-top: 3px solid #2563eb;
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(15,23,42,.28), 0 6px 16px rgba(15,23,42,.12);
      animation: llmt-pop .26s cubic-bezier(.22,1,.36,1);
    }
    @keyframes llmt-pop {
      from { opacity: 0; transform: translate(-50%, -46%) scale(.94); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    .llmt-prompt-body { padding: 14px 16px 13px; }
    .llmt-prompt-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .llmt-prompt-icon { width: 34px; height: 34px; flex: none; display: block; }
    .llmt-prompt-title {
      font-size: 14px; font-weight: 600; color: #0f172a; line-height: 1.35;
      word-break: break-word;
    }
    .llmt-prompt-text {
      font-size: 13px; line-height: 1.6; color: #475569; margin-bottom: 12px;
      word-break: break-word;
    }
    .llmt-prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .llmt-prompt-actions .llmt-btn { font-size: 13px; padding: 7px 12px; border-radius: 8px; }
    .llmt-prompt-actions .llmt-btn.primary { flex: 1; min-width: 110px; font-weight: 600; }
    .llmt-btn.ghost { border-color: transparent; background: transparent; color: #94a3b8; padding: 6px 8px; font-size: 12px; }
    .llmt-btn.ghost:hover { background: #f1f5f9; color: #475569; }
    .llmt-prompt-progress {
      position: absolute; left: 0; bottom: 0; height: 3px; width: 100%;
      background: linear-gradient(90deg, #93c5fd, #2563eb);
      transform-origin: left center;
      animation: llmt-countdown 20s linear forwards;
    }
    @keyframes llmt-countdown {
      from { transform: scaleX(1); }
      to { transform: scaleX(0); }
    }
    @media (max-width: 480px) {
      .llmt-prompt { width: calc(100vw - 24px); }
    }
  `;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-llmt-ui', '1');
      (document.body || document.documentElement).appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';

    // 优先使用 Constructable Stylesheet，避免被页面 CSP 拦截
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }

    trigger = document.createElement('button');
    trigger.className = 'llmt-trigger';
    trigger.type = 'button';
    trigger.title = 'AI 翻译选中内容';
    trigger.textContent = '译';
    shadow.appendChild(trigger);

    card = document.createElement('div');
    card.className = 'llmt-card';
    card.innerHTML = `
      <div class="llmt-head">
        ${logoMarkup('llmt-logo')}
        <span class="llmt-title">AI 翻译</span>
        <button class="llmt-iconbtn" data-act="retranslate" title="重新翻译">⟳</button>
        <button class="llmt-iconbtn" data-act="close" title="关闭">✕</button>
      </div>
      <div class="llmt-body">
        <div class="llmt-src clamp"></div>
        <div class="llmt-dst"></div>
      </div>
      <div class="llmt-foot">
        <button class="llmt-btn" data-act="speak">朗读</button>
        <button class="llmt-btn" data-act="copy">复制译文</button>
        <button class="llmt-btn" data-act="expand">展开原文</button>
        <span class="llmt-spacer"></span>
        <button class="llmt-btn primary" data-act="replace">替换原文</button>
      </div>
    `;
    shadow.appendChild(card);

    toast = document.createElement('div');
    toast.className = 'llmt-toast';
    shadow.appendChild(toast);

    // 站点 CSP 拦掉扩展图片时换成内联 SVG，不留空白
    shadow.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.outerHTML = fallbackLogo(img.className);
      });
    });
  }

  function clampToViewport(el, x, y, gap = 10) {
    const rect = el.getBoundingClientRect();
    const w = rect.width || el.offsetWidth;
    const h = rect.height || el.offsetHeight;
    let left = Math.min(x, window.innerWidth - w - gap);
    let top = y;
    if (top + h + gap > window.innerHeight) top = Math.max(gap, y - h - gap * 2);
    el.style.left = `${Math.max(gap, left)}px`;
    el.style.top = `${Math.max(gap, top)}px`;
  }

  /* ---------------- 悬浮按钮 ---------------- */

  function showTrigger(rect, onClick) {
    ensure();
    trigger.style.display = 'block';
    const x = rect.right + 6;
    const y = rect.bottom + 6;
    clampToViewport(trigger, x, y, 6);
    trigger.onmousedown = (e) => e.preventDefault(); // 防止点击时清空选区
    trigger.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick && onClick();
    };
  }

  function hideTrigger() {
    if (trigger) trigger.style.display = 'none';
  }

  function isTriggerEvent(e) {
    return !!(trigger && e.composedPath && e.composedPath().includes(trigger));
  }

  function isCardEvent(e) {
    return !!(card && e.composedPath && e.composedPath().includes(card));
  }

  /* ---------------- 译文卡片 ---------------- */

  let cardState = { original: '', translated: '', onReplace: null };
  let cardAnchor = null;

  function showCard({ rect, original, onReplace }) {
    ensure();
    cardState = { original, translated: '', onReplace };
    cardAnchor = rect || null;
    card.style.display = 'block';
    card.style.width = '380px';

    const src = card.querySelector('.llmt-src');
    src.textContent = original;
    src.classList.add('clamp');
    const dst = card.querySelector('.llmt-dst');
    dst.className = 'llmt-dst loading';
    dst.textContent = '正在翻译';
    dst.classList.add('llmt-dots');

    const expandBtn = card.querySelector('[data-act="expand"]');
    expandBtn.textContent = '展开原文';
    expandBtn.disabled = false;

    positionCard();
    requestAnimationFrame(positionCard);
  }

  /** 按锚点位置摆放卡片：默认在选区下方，空间不足则翻到上方 */
  function positionCard() {
    if (!card || card.style.display === 'none') return;
    const gap = 8;
    const anchor = cardAnchor || {
      left: window.innerWidth / 2 - 190,
      top: window.innerHeight / 3,
      bottom: window.innerHeight / 3,
      right: 0
    };

    const w = card.offsetWidth || 380;
    const h = card.offsetHeight || 140;

    let left = Math.min(anchor.left, window.innerWidth - w - gap);
    left = Math.max(gap, left);

    let top = anchor.bottom + gap;
    if (top + h > window.innerHeight - gap) {
      top = anchor.top - h - gap;
    }
    if (top < gap) top = gap;

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function setCardLoading() {
    if (!card) return;
    const dst = card.querySelector('.llmt-dst');
    dst.className = 'llmt-dst loading llmt-dots';
    dst.textContent = '正在翻译';
  }

  function setCardResult(text) {
    if (!card) return;
    cardState.translated = text;
    const dst = card.querySelector('.llmt-dst');
    dst.className = 'llmt-dst';
    dst.textContent = text;
    requestAnimationFrame(positionCard);
  }

  function setCardError(msg) {
    if (!card) return;
    const dst = card.querySelector('.llmt-dst');
    dst.className = 'llmt-dst error';
    dst.textContent = msg;
  }

  function hideCard() {
    if (card) card.style.display = 'none';
  }

  function isCardVisible() {
    return !!(card && card.style.display === 'block');
  }

  /* ---------------- 朗读 ---------------- */

  let speakingBtn = null;

  /** 按译文的文字类型猜朗读语言，避免中文被英文音库念 */
  function guessSpeechLang(text) {
    const s = String(text || '');
    if (/[\u4e00-\u9fa5]/.test(s)) return 'zh-CN';
    if (/[\u3040-\u30ff]/.test(s)) return 'ja-JP';
    if (/[\uac00-\ud7af]/.test(s)) return 'ko-KR';
    if (/[\u0400-\u04ff]/.test(s)) return 'ru-RU';
    return 'en-US';
  }

  function speakText(text, btn) {
    if (!text) return;
    if (!('speechSynthesis' in window)) {
      flashToast('当前浏览器不支持朗读');
      return;
    }
    // 正在朗读时再点一次即停止
    if (speakingBtn) {
      speechSynthesis.cancel();
      speakingBtn.textContent = '朗读';
      speakingBtn = null;
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = guessSpeechLang(text);
    u.rate = 0.95;
    u.onend = u.onerror = () => {
      if (btn) btn.textContent = '朗读';
      if (speakingBtn === btn) speakingBtn = null;
    };
    speakingBtn = btn || null;
    if (btn) btn.textContent = '停止';
    speechSynthesis.speak(u);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindActions(handlers = {}) {
    ensure();
    card.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;

      if (act === 'close') {
        hideCard();
      } else if (act === 'speak') {
        speakText(cardState.translated, btn);
      } else if (act === 'copy') {
        const text = cardState.translated;
        if (!text) return;
        navigator.clipboard.writeText(text).then(
          () => flashToast('已复制'),
          () => flashToast('复制失败')
        );
      } else if (act === 'expand') {
        const src = card.querySelector('.llmt-src');
        const clamped = src.classList.toggle('clamp');
        btn.textContent = clamped ? '展开原文' : '收起原文';
      } else if (act === 'retranslate') {
        handlers.onRetranslate && handlers.onRetranslate(cardState.original);
      } else if (act === 'replace') {
        if (cardState.onReplace && cardState.translated) {
          cardState.onReplace(cardState.translated);
          hideCard();
          flashToast('已替换原文');
        }
      }
    });
  }

  let toastTimer = null;
  function flashToast(msg, ms = 1800) {
    ensure();
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.display = 'none';
    }, ms);
  }

  /* ---------------- 外语页面提示条 ---------------- */

  let prompt = null;
  let promptTimer = null;
  let promptEsc = null;

  function showPrompt({ title, desc, text, onTranslate, onDismiss, onNever }) {
    ensure();
    hidePrompt();

    prompt = document.createElement('div');
    prompt.className = 'llmt-prompt';
    prompt.innerHTML = `
      <div class="llmt-prompt-body">
        <div class="llmt-prompt-head">
          ${logoMarkup('llmt-prompt-icon')}
          <div class="llmt-prompt-title"></div>
        </div>
        <div class="llmt-prompt-text"></div>
        <div class="llmt-prompt-actions">
          <button class="llmt-btn primary" data-act="go">翻译此页</button>
          <button class="llmt-btn" data-act="dismiss">暂不</button>
          <button class="llmt-btn ghost" data-act="never">此站不再提示</button>
        </div>
      </div>
      <div class="llmt-prompt-progress"></div>
    `;

    const titleEl = prompt.querySelector('.llmt-prompt-title');
    const descEl = prompt.querySelector('.llmt-prompt-text');
    titleEl.textContent = title || text || '';
    if (desc) descEl.textContent = desc;
    else descEl.remove();

    shadow.appendChild(prompt);

    prompt.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      hidePrompt();
      if (act === 'go' && onTranslate) onTranslate();
      else if (act === 'dismiss' && onDismiss) onDismiss();
      else if (act === 'never' && onNever) onNever();
    });

    // 鼠标停在卡片上时暂停倒计时，离开后再给 15 秒
    prompt.addEventListener('mouseenter', () => {
      clearTimeout(promptTimer);
      promptTimer = null;
      const bar = prompt && prompt.querySelector('.llmt-prompt-progress');
      if (bar) bar.style.animationPlayState = 'paused';
    });
    prompt.addEventListener('mouseleave', () => {
      if (!prompt) return;
      const bar = prompt.querySelector('.llmt-prompt-progress');
      if (bar) bar.style.animationPlayState = 'running';
      clearTimeout(promptTimer);
      promptTimer = setTimeout(hidePrompt, 10000);
    });

    promptEsc = (e) => {
      if (e.key === 'Escape') hidePrompt();
    };
    document.addEventListener('keydown', promptEsc, true);

    // 居中会挡住正文，20 秒无操作自动收起
    promptTimer = setTimeout(hidePrompt, 20000);
  }

  function hidePrompt() {
    clearTimeout(promptTimer);
    promptTimer = null;
    if (promptEsc) {
      document.removeEventListener('keydown', promptEsc, true);
      promptEsc = null;
    }
    if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt);
    prompt = null;
  }

  function isPromptVisible() {
    return !!(prompt && prompt.isConnected);
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    if (!rects.length) return null;
    return rects[rects.length - 1];
  }

  window.__LLMT_UI = {
    ensure,
    showTrigger,
    hideTrigger,
    isTriggerEvent,
    isCardEvent,
    showCard,
    setCardLoading,
    setCardResult,
    setCardError,
    hideCard,
    isCardVisible,
    bindActions,
    flashToast,
    showPrompt,
    hidePrompt,
    isPromptVisible,
    getSelectionRect
  };
})();
