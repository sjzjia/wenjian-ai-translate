/**
 * DOM 层：采集可翻译文本节点、分批、写入译文、还原原文。
 * 挂载在 window.__LLMT_DOM 上，供 content/main.js 使用。
 */
(() => {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'HEAD', 'META', 'LINK',
    'TITLE', 'BASE', 'BR', 'HR'
  ]);

  // 译文会破坏其结构的元素（表格布局、表单控件等）
  const SKIP_ATTR = 'data-llmt-skip';

  const TEXT_RE = /[\p{L}]/u;      // 至少包含一个字母（覆盖所有有文字的语言）
  const HAN_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g; // 汉字（计数用）
  const KANA_HANGUL_RE = /[\u3040-\u30ff\uac00-\ud7af]/;        // 假名 / 韩文

  // 整段就是链接 / 邮箱 / 版本号时没有翻译价值，直接跳过省 token
  const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
  const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
  const VERSION_RE = /^v?\d+(?:\.\d+)+(?:[-+][\w.]+)?$/i;

  // 常见缩写 / 代号：译与不译基本一样（甚至更差），整段命中时跳过省 token。
  // 用白名单而不是「全大写」正则：德语名词、以及 SALE 这类全大写实词不能误伤
  const ABBREVIATIONS = new Set([
    'OK', 'ID', 'VS', 'FAQ', 'API', 'CEO', 'CFO', 'CTO', 'COO', 'USA', 'UK', 'EU', 'UN',
    'PDF', 'URL', 'HTML', 'CSS', 'HTTP', 'HTTPS', 'GPS', 'SMS', 'VIP', 'DNA', 'RNA',
    'AI', 'ML', 'UI', 'UX', 'OS', 'PC', 'TV', 'IP', 'DNS', 'VPN', 'WiFi', 'ISO', 'ERP',
    'CRM', 'SaaS', 'KPI', 'ROI', 'PR', 'HR', 'IT', 'GDP', 'CPI', 'PhD', 'MBA', 'GRE',
    'TOEFL', 'IELTS', 'NASA', 'FBI', 'CIA', 'BBC', 'CNN', 'NBA', 'FIFA', 'OLED', 'LED',
    'USB', 'HDMI', 'SSD', 'HDD', 'CPU', 'GPU', 'RAM', 'ROM', 'SQL', 'iOS', 'Android',
    'GitHub', 'Windows', 'macOS', 'Linux', 'YouTube', 'Facebook', 'Twitter', 'Instagram'
  ]);

  // 网页通用 UI 词：导航、按钮、表单标签里的高频词，译与不译用户都认识，
  // 且每个站点重复出现，整段命中时跳过省 token。只匹配「整段恰好是这个词」，
  // 句子里的同名单词不受影响
  const UI_WORDS = new Set([
    'home', 'search', 'login', 'log in', 'logout', 'log out', 'sign in', 'sign up',
    'register', 'menu', 'more', 'next', 'previous', 'prev', 'back', 'share', 'comments',
    'comment', 'like', 'likes', 'reply', 'replies', 'follow', 'following', 'followers',
    'submit', 'cancel', 'save', 'delete', 'edit', 'settings', 'profile', 'account',
    'help', 'about', 'contact', 'privacy', 'terms', 'cookies', 'newsletter', 'subscribe',
    'download', 'upload', 'print', 'email', 'password', 'username', 'dashboard',
    'notifications', 'messages', 'friends', 'photos', 'videos', 'music', 'files',
    'loading', 'please wait', 'read more', 'show more', 'view all', 'see all', 'load more'
  ]);

  /** 判断元素是否属于扩展自身的 UI */
  function isOwnUI(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.id === 'llmt-root' || n.hasAttribute('data-llmt-ui')) return true;
      n = n.parentElement;
    }
    return false;
  }

  const INLINE_TAGS = new Set([
    'A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'BIG', 'SUB', 'SUP',
    'MARK', 'LABEL', 'CITE', 'Q', 'ABBR', 'TIME', 'BDI', 'BDO', 'FONT', 'INS',
    'DEL', 'TT', 'WBR', 'BR', 'IMG'
  ]);

  /** 元素是否可见（有布局盒） */
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // 不判断 opacity：淡入动画进行中的元素只是暂时透明，仍需要翻译
    return el.getClientRects().length > 0;
  }

  /**
   * 目标语言 → 文字系统。
   * 拉丁语系（英/法/德/西…）共用 A-Z，字符集区分不出语种，硬判必然漏译，因此不参与跳过。
   */
  const TARGET_SCRIPT_RULES = [
    { code: 'han', lang: /中文|汉语|漢語|简体|繁體|繁体|chinese|^zh([-_]|$)/i, chars: HAN_RE_G },
    { code: 'kana', lang: /日本語|日语|日語|日文|japanese|^ja([-_]|$)/i, chars: /[\u3040-\u30ff]/g },
    { code: 'hangul', lang: /한국어|韩语|韓語|korean|^ko([-_]|$)/i, chars: /[\uac00-\ud7af]/g },
    { code: 'cyrillic', lang: /俄语|俄語|русск|russian|^ru([-_]|$)/i, chars: /[\u0400-\u04ff]/g },
    { code: 'arabic', lang: /阿拉伯|عربي|arabic|^ar([-_]|$)/i, chars: /[\u0600-\u06ff]/g },
    { code: 'greek', lang: /希腊|希臘|ελληνικ|greek|^el([-_]|$)/i, chars: /[\u0370-\u03ff]/g },
    { code: 'hebrew', lang: /希伯来|希伯來|עברית|hebrew|^he([-_]|$)/i, chars: /[\u0590-\u05ff]/g },
    { code: 'thai', lang: /泰语|泰語|ไทย|thai|^th([-_]|$)/i, chars: /[\u0e00-\u0e7f]/g }
  ];

  /** 目标语言对应的文字系统；拉丁语系等无法判定时返回 null（不做跳过） */
  function targetScript(lang) {
    const s = String(lang || '');
    return TARGET_SCRIPT_RULES.find((r) => r.lang.test(s)) || null;
  }

  /**
   * 文本是否已经是目标语言（按文字系统判断，用于跳过省 token）。
   * 不要求「一个拉丁字母都没有」：中文技术文档里「使用 React 构建」这类
   * 中英混排句子占比很高，按旧规则会整句送去翻译，白花 token 还可能译坏。
   * 判据：目标文字字符数 ≥ 拉丁字母数的一半。
   */
  function isScriptDominant(t, rule) {
    if (!rule) return false;
    // 中文页里夹的日文句子带假名，不能当成中文跳过；目标为日文时同理
    if (rule.code === 'han' && KANA_HANGUL_RE.test(t)) return false;
    const hits = (t.match(rule.chars) || []).length;
    if (!hits) return false;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    return hits * 2 >= latin;
  }

  /** 文本是否值得翻译 */
  function isTranslatable(text, script) {
    const t = text.trim();
    if (!t) return false;
    if (!TEXT_RE.test(t)) return false;            // 纯数字 / 符号 / emoji
    // 上限只防「整个 body 是一个文本节点」这类怪物，正常长文本交给切分
    if (t.length > 60000) return false;
    if (URL_RE.test(t) || EMAIL_RE.test(t) || VERSION_RE.test(t)) return false;
    if (ABBREVIATIONS.has(t) || ABBREVIATIONS.has(t.toUpperCase())) return false;
    if (UI_WORDS.has(t.toLowerCase())) return false;
    // 已经是目标语言的段落跳过：以前只对中文目标生效，日/韩/俄/阿等
    // 文字系统明确的语言同样可判，省下的量在整页翻译里是最大的一块
    if (isScriptDominant(t, script)) return false;
    return true;
  }

  /**
   * 单段文本上限，同时也是译文缓存的粒度。
   * 上限：与请求层 max_tokens 估算配套，整段过长会把译文拦腰截断。
   * 粒度：缓存以「一段文本」为键，段落里改一个词就整段失效；切成 ≤1200 字的
   * 句子组后，改动只影响所在的那一段，其余片段直接命中缓存（相邻片段仍排在
   * 同一批里，上下文不丢）。再小会把长段落拆成太多行、写回要等全部到齐。
   */
  const MAX_TEXT_CHARS = 1200;
  // 在句子边界后切开，避免把单词 / 句子拦腰截断；单句本身超长时按字符硬切
  const SENTENCE_SPLIT_RE = /(?<=[。！？.!?]\s*)|(?<=\n)/;

  /**
   * 把超长文本切成 ≤MAX_TEXT_CHARS 的片段。
   * 直接丢弃会漏译长文章，整段发送又会超出输出上限把译文拦腰截断。
   */
  function splitLongText(v) {
    if (v.length <= MAX_TEXT_CHARS) return [v];
    const segs = [];
    let cur = '';
    const flush = () => {
      if (cur) {
        segs.push(cur);
        cur = '';
      }
    };
    for (const piece of v.split(SENTENCE_SPLIT_RE)) {
      if (piece.length > MAX_TEXT_CHARS) {
        flush();
        for (let i = 0; i < piece.length; i += MAX_TEXT_CHARS) {
          segs.push(piece.slice(i, i + MAX_TEXT_CHARS));
        }
        continue;
      }
      if (cur.length + piece.length > MAX_TEXT_CHARS) flush();
      cur += piece;
    }
    flush();
    return segs.length ? segs : [v];
  }

  /**
   * 找到文本节点所属的"可翻译容器"。
   * 用标签名快速判断，避免对每个节点都调用 getComputedStyle。
   */
  function nearestBlock(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    const first = el;
    let depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth++ < 6) {
      if (!INLINE_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    // 祖先全是行内元素时不要回退到 body：markDone 拒绝给 body 打标记，
    // 这段文本每次都会被当成新内容重新译一遍，白花 token。
    // 退回最近的元素，标记才有地方落
    if (first && first !== document.body && first !== document.documentElement) return first;
    return el || document.body;
  }

  /**
   * 让出事件循环。大页面采集要几百毫秒，全程占着主线程页面会卡死；
   * scheduler.yield 是 Chrome 129+ 为此设计的 API，老环境退回 setTimeout。
   */
  const yieldToEventLoop = () =>
    'scheduler' in window && typeof window.scheduler?.yield === 'function'
      ? window.scheduler.yield()
      : new Promise((r) => setTimeout(r, 0));

  /**
   * 采集文本节点。
   * 手动栈遍历而非 TreeWalker：父级不可见 / 命中跳过规则时整棵子树剪枝，
   * 隐藏的导航、菜单、代码块不会白遍历；子元素逆序入栈保证弹出仍是文档序。
   * 异步：每扫约 2000 个元素让出一次事件循环，大页面采集期间页面仍可响应。
   * onProgress：每次让出时把当前已采集的数组传出去（同一个引用，调用方自己
   * 记已消费的下标），调用方可以先发首批请求，不必等整页扫完。
   * @returns {Promise<Array<{node: Text, text: string, block: Element}>>}
   */
  async function collect(root = document.body, targetLang = '简体中文', onProgress) {
    if (!root || root.nodeType !== 1) return [];
    // 目标语言的文字系统只解析一次，逐节点判断时复用
    const script = targetScript(targetLang);
    const items = [];
    const visCache = new WeakMap();
    const isVisibleCached = (el) => {
      if (visCache.has(el)) return visCache.get(el);
      const v = isVisible(el);
      visCache.set(el, v);
      return v;
    };

    let guard = 0;
    const stack = [root];
    while (stack.length && guard++ < 50000) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      // 每约 2000 个元素让出一次，保持页面可交互
      if (guard % 2000 === 0) {
        await yieldToEventLoop();
        // 边采边报：调用方拿到已采集部分就能先发请求，首屏不必等整页扫完
        if (onProgress) onProgress(items);
      }
      // 整棵子树跳过的规则放在这里，比 TreeWalker 逐文本节点判断省大量 closest 调用
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.closest(`[${SKIP_ATTR}]`)) continue;
      // HTML 标准的 translate="no"：站点声明不要译的内容（品牌名、代码示例等），
      // 既省 token 也不会译出站点不想要的结果
      if (el.closest('[translate="no" i]')) continue;
      if (el.isContentEditable) continue;
      if (isOwnUI(el)) continue;
      if (!isVisibleCached(el)) continue;

      const doneBlock = el.closest('[data-llmt-done]');

      const kids = [];
      let c = el.firstChild;
      while (c) {
        kids.push(c);
        c = c.nextSibling;
      }

      for (const k of kids) {
        if (k.nodeType !== 3) continue;
        const v = k.nodeValue;
        if (!v || !v.trim()) continue;
        // 块里已经译过这段原文才跳过；换成新文本要重新译
        if (doneBlock && isAlreadyTranslated(doneBlock, v)) continue;
        if (!isTranslatable(v, script)) continue;
        const segs = splitLongText(v);
        if (segs.length === 1) {
          items.push({ node: k, text: v, block: null });
        } else {
          // 超长文本切段：part/parts 供写回时聚齐拼接
          segs.forEach((seg, i) =>
            items.push({ node: k, text: seg, block: null, part: i, parts: segs.length })
          );
        }
      }

      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i].nodeType === 1) stack.push(kids[i]);
      }
    }
    return items;
  }

  /**
   * 把视口内可见的文本项排到最前面，让用户正在看的部分先出译文。
   * 短页面顺序本来就是对的，只有长页面才需要重排。
   */
  function prioritizeInView(items) {
    if (!items || items.length < 40) return items;
    const vh = window.innerHeight || 800;
    const vis = [];
    const rest = [];
    for (const it of items) {
      const el = it.node && it.node.parentElement;
      if (el && el.isConnected) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 0 && r.top < vh && r.width > 0 && r.height > 0) {
          vis.push(it);
          continue;
        }
      }
      rest.push(it);
    }
    items.length = 0;
    items.push(...vis, ...rest);
    return items;
  }

  /**
   * 把采集结果切成批次，控制单次请求体量
   * @returns {Array<Array<{node,text,block,index}>>}
   */
  /**
   * 按字符数与条数切批。
   * firstMaxChars：首批使用更小的上限，让首屏译文更快出现（页面顶部优先）。
   * 仅当总字符数明显大于首批上限时才启用，避免小页面被无谓拆分。
   */
  function batch(items, { maxChars = 2500, maxItems = 32, firstMaxChars = 0 } = {}) {
    const totalChars = items.reduce((s, it) => s + it.text.trim().length, 0);
    const firstLimit =
      firstMaxChars > 0 && totalChars > firstMaxChars * 2 ? firstMaxChars : maxChars;

    const batches = [];
    let cur = [];
    let curChars = 0;

    for (const it of items) {
      const limit = batches.length === 0 ? firstLimit : maxChars;
      const len = it.text.trim().length;
      if (cur.length && (curChars + len > limit || cur.length >= maxItems)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(it);
      curChars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /** 写入译文（替换模式） */
  /**
   * 记录「这个块里当前显示的是哪些译文」。
   * 只打一个布尔标记的话，SPA 复用容器时换上的新文本会被当成已译内容跳过，
   * 菜单切换后就再也不翻译了。记下写入的译文才能区分「还没动的译文」和「新内容」。
   */
  const doneTexts = new WeakMap();

  function markDone(block, translated) {
    if (!block || block.nodeType !== 1) return;
    // body / html 绝不能打标记，否则整页后续内容都会被判定为已译
    if (block === document.body || block === document.documentElement) return;
    block.setAttribute('data-llmt-done', '1');
    let set = doneTexts.get(block);
    if (!set) {
      set = new Set();
      doneTexts.set(block, set);
    }
    set.add(String(translated || '').trim());
  }

  /** 当前文本就是之前写进去的译文才算译过；被页面重置回原文时要重新译 */
  function isAlreadyTranslated(block, text) {
    const set = doneTexts.get(block);
    if (!set) return true; // 没有记录，保守跳过，避免把译文再译一遍
    return set.has(String(text || '').trim());
  }

  function applyReplace(rec, translated) {
    if (!rec.node || !rec.node.isConnected) return false;
    if (!rec.block) rec.block = nearestBlock(rec.node);
    rec.node.nodeValue = translated;
    markDone(rec.block, translated);
    return true;
  }

  /** 写入译文（双语模式：原文保留，译文以行内元素追加） */
  function applyBilingual(rec, translated) {
    if (!rec.node || !rec.node.isConnected) return false;
    const parent = rec.node.parentNode;
    if (!parent) return false;

    if (!rec.block) rec.block = nearestBlock(rec.node);

    // 标记为扩展 UI：动态翻译的 MutationObserver 会跳过它们，避免把译文再译一遍
    const orig = document.createElement('span');
    orig.className = 'llmt-orig';
    orig.setAttribute('data-llmt-ui', '1');
    orig.textContent = rec.original;

    const trans = document.createElement('span');
    trans.className = 'llmt-trans';
    trans.setAttribute('data-llmt-ui', '1');
    trans.textContent = translated;

    parent.replaceChild(orig, rec.node);
    parent.insertBefore(trans, orig.nextSibling);

    rec.applied = [orig, trans];
    markDone(rec.block, translated);
    return true;
  }

  /** 还原单条记录 */
  function restore(rec) {
    if (rec.applied && rec.applied.length) {
      const [orig, trans] = rec.applied;
      const parent = orig.parentNode;
      if (parent) {
        parent.insertBefore(document.createTextNode(rec.original), orig);
        orig.remove();
        if (trans && trans.parentNode) trans.remove();
      }
      rec.applied = null;
      return;
    }
    if (rec.node && rec.node.isConnected) {
      rec.node.nodeValue = rec.original;
    }
  }

  /** 清理翻译标记 */
  function clearMarks() {
    document.querySelectorAll('[data-llmt-done]').forEach((el) => {
      el.removeAttribute('data-llmt-done');
      doneTexts.delete(el);
    });
    document.querySelectorAll('.llmt-orig').forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.insertBefore(document.createTextNode(el.textContent), el);
      el.remove();
    });
    document.querySelectorAll('.llmt-trans').forEach((el) => el.remove());
  }

  /* ---------------- 页面语言检测 ---------------- */

  const SCRIPT_RULES = [
    ['ja', /[\u3040-\u30ff]/g],
    ['ko', /[\uac00-\ud7af]/g],
    ['ru', /[\u0400-\u04ff]/g],
    ['ar', /[\u0600-\u06ff]/g],
    ['el', /[\u0370-\u03ff]/g],
    ['he', /[\u0590-\u05ff]/g],
    ['th', /[\u0e00-\u0e7f]/g],
    ['zh', /[\u4e00-\u9fff]/g]
  ];

  // 使用拉丁字母的语言，字符集无法细分，只用于"同族不提示"的判断
  const LATIN_LANGS = new Set([
    'en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'fi',
    'pl', 'cs', 'ro', 'hu', 'tr', 'id', 'ms', 'vi'
  ]);

  /** 采样正文并统计字符集，内容不足时返回 null */
  function sampleScripts() {
    const body = document.body;
    if (!body) return null;

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (isOwnUI(p)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let text = '';
    let n;
    let guard = 0;
    while ((n = walker.nextNode()) && guard++ < 300 && text.length < 3000) {
      text += n.nodeValue;
    }
    if (text.length < 60) return null;

    const counts = {};
    let total = 0;
    for (const [code, re] of SCRIPT_RULES) {
      counts[code] = (text.match(re) || []).length;
      total += counts[code];
    }
    counts.latin = (text.match(/[A-Za-z]/g) || []).length;
    total += counts.latin;
    if (!total) return null;

    let best = '';
    let max = 0;
    for (const [code, v] of Object.entries(counts)) {
      if (v > max) {
        max = v;
        best = code;
      }
    }
    if (max < 20) return null;

    // 假名数量可观且占比不低，判定为日文；韩文同理
    if (counts.ja >= 8 && counts.ja * 3 >= counts.zh) best = 'ja';
    else if (counts.ko >= 8) best = 'ko';

    return { lang: best, counts, total };
  }

  /**
   * 页面主要语言，返回小写 BCP-47（如 zh-cn、en、ja）。
   * 优先用 lang 声明；当声明与正文字符集明显矛盾时以正文为准。
   */
  function detectLanguage() {
    let declared = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
    if (declared === 'und' || declared === 'zxx') declared = '';

    if (!declared) {
      const meta = document.querySelector('meta[http-equiv="content-language" i]');
      const metaLang = meta && meta.getAttribute('content');
      if (metaLang && metaLang.trim()) declared = metaLang.trim().toLowerCase();
    }

    const sample = sampleScripts();
    const sampled = sample ? sample.lang : '';

    if (!declared) return sampled;
    if (!sampled) return declared;

    const d = declared.split(/[-_]/)[0];
    if (sampled === d) return declared;

    const ratio = sample.counts[sampled] / sample.total;

    // 正文是明确的非拉丁文字（汉字/假名/韩文等）且占比很高 → 相信正文
    if (sampled !== 'latin' && ratio > 0.6) return sampled;

    // 声明是中/日/韩等，但正文 90% 以上是拉丁字母 → 按拉丁语系处理
    if (sampled === 'latin' && ratio > 0.9 && !LATIN_LANGS.has(d)) return 'latin';

    return declared;
  }

  window.__LLMT_DOM = {
    collect,
    batch,
    prioritizeInView,
    applyReplace,
    applyBilingual,
    restore,
    clearMarks,
    isVisible,
    isOwnUI,
    nearestBlock,
    detectLanguage
  };
})();
