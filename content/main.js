/**
 * 主控：全页面翻译、划词翻译、Alt+点击段落翻译。
 */
(() => {
  if (window.__LLMT_LOADED__) return;
  window.__LLMT_LOADED__ = true;

  const DOM = window.__LLMT_DOM;
  const UI = window.__LLMT_UI;
  if (!DOM || !UI) return;

  const DEFAULTS = {
    targetLang: '简体中文',
    bilingual: false,
    baseUrl: 'https://api.openai.com/v1',
    concurrency: 6,
    autoTranslateSelection: false,
    maxCharsPerBatch: 2500,
    autoPrompt: true,
    hoverTranslate: true,
    inputTranslate: true,
    autoFollow: true,
    skipSites: []
  };

  const state = {
    status: 'idle', // idle | translating | done
    records: [],
    cancel: false,
    config: { ...DEFAULTS }
  };

  /* ---------------- 配置 ---------------- */

  // 本地/内网端点（Ollama、vLLM 等）：服务端默认串行处理请求，且 HTTP/1.1
  // 单主机只有 6 条连接，并发调高只会让请求互相排队
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

  // 读成功后缓存：翻译中途改设置走 storage.onChanged 实时更新，
  // 不必每次点翻译都重新读一遍 storage.sync
  let configLoaded = false;

  async function loadConfig() {
    if (configLoaded) return;
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      state.config = { ...DEFAULTS, ...stored };
      configLoaded = true;
    } catch {
      /* 使用默认值，下次再试 */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(changes)) {
      if (k in state.config) state.config[k] = changes[k].newValue;
    }
  });

  /* ---------------- 消息通道 ---------------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, error: '后台无响应' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // 流式译文按 streamId 关联回发起请求的批次
  const streamWaiters = new Map();

  /**
   * 发起流式翻译：后台先回执，随后用 llmtChunk 逐条推送译文，llmtDone 结束。
   * 返回 fallback 表示流式不可用，由调用方退回整批请求。
   */
  function translateBatchStreamed(texts, targetLang, onItem) {
    const streamId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve) => {
      const waiter = { onItem, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        streamWaiters.delete(streamId);
        resolve({ ok: false, fallback: true, error: '流式翻译超时' });
      }, 180000);
      streamWaiters.set(streamId, waiter);

      send({ type: 'translateStream', streamId, texts, targetLang }).then((ack) => {
        if (ack && ack.ok && ack.accepted) return;
        // 后台没接单，立刻降级，不必等超时
        clearTimeout(waiter.timer);
        streamWaiters.delete(streamId);
        resolve({ ok: false, fallback: true, error: (ack && ack.error) || '流式翻译不可用' });
      });
    });
  }

  /**
   * 主动释放所有等待中的流式请求。
   * 点「停止」时后台可能还在生成，不释放的话 worker 要一直等到 llmtDone
   * （最长 180 秒），界面就卡在「翻译中」。
   */
  function cancelPendingStreams() {
    for (const [id, w] of streamWaiters) {
      clearTimeout(w.timer);
      try {
        w.resolve({ ok: false, error: '已取消' });
      } catch {
        /* ignore */
      }
      streamWaiters.delete(id);
    }
  }

  /* ---------------- 全页面翻译 ---------------- */

  // 超长文本被切成多段翻译，同一节点的片段到齐后拼接写回；
  // 缺片时先不写，避免页面出现半截译文
  const nodeParts = new Map();

  /** 把一条译文写回所有引用它的文本节点，返回成功写入的节点数 */
  function applyTranslation(groups, text, translated) {
    const list = groups.get(text) || [];
    let n = 0;
    for (const it of list) {
      let out = translated;
      if (it.parts > 1) {
        let buf = nodeParts.get(it.node);
        if (!buf) {
          buf = { total: it.parts, segs: new Array(it.parts).fill('') };
          nodeParts.set(it.node, buf);
        }
        buf.segs[it.part] = translated;
        if (buf.segs.some((s) => !s)) continue; // 还有片段没到，等齐再写
        nodeParts.delete(it.node);
        out = buf.segs.join('');
      }
      const rec = {
        node: it.node,
        // 用节点当前值做还原依据：切段写入前它仍是完整原文
        original: it.node.nodeValue,
        block: it.block,
        // 写入的译文：完成时用它核对译文是否还留在页面上
        appliedText: out,
        applied: null
      };
      const ok = state.config.bilingual
        ? DOM.applyBilingual(rec, out)
        : DOM.applyReplace(rec, out);
      if (ok) {
        writtenNodes.add(it.node);
        state.records.push(rec);
        n++;
      }
    }
    return n;
  }

  async function translatePage(force = false) {
    UI.hidePrompt();

    if (state.status === 'translating') {
      state.cancel = true;
      cancelPendingStreams();
      UI.flashToast('已停止翻译');
      return;
    }
    if (state.status === 'done') {
      if (!force) {
        restorePage();
        return;
      }
      // 强制重译：先静默还原，避免采集到上一次的译文
      for (const rec of state.records) DOM.restore(rec);
      state.records = [];
      nodeParts.clear();
      DOM.clearMarks();
      state.status = 'idle';
    }

    await loadConfig();
    const targetLang = state.config.targetLang;

    // 三段耗时：收集 → 首条译文 → 全部完成。速度调优先看这三个数
    // performance.now 与 Date.now 同时记：个别站点会覆写 performance.now
    // （反检测脚本常把它固定成常量或大幅降低精度），污染的目的都是让
    // 耗时看起来更短，所以取两个时钟里较大的那个更接近真实值
    const t0 = performance.now();
    const t0Date = Date.now();
    const since = () => Math.max(performance.now() - t0, Date.now() - t0Date);
    UI.flashToast('正在收集页面文本…', 4000);
    const items = await DOM.collect(document.body, targetLang);
    const tCollect = since();
    if (!items.length) {
      UI.flashToast('没有找到可翻译的文本');
      return;
    }

    // 视口内的段落排到前面，用户正在看的部分先出译文
    DOM.prioritizeInView(items);

    // 相同文本去重，减少请求量
    const groups = new Map();
    for (const it of items) {
      const key = it.text.trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const unique = [...groups.entries()].map(([text, list]) => ({ text, list }));

    // 并发策略：远端接口（HTTPS / HTTP2）是真并行，默认 6、上限 10；
    // 本地推理服务端默认串行，默认自动降到 2、上限 6（HTTP/1.1 单主机连接数）。
    // 6 是历史默认值，本地端点下视为「没手动调过」才降档；填 7 以上可强制调高
    const local = isLocalBaseUrl(state.config.baseUrl);
    const stored = Number(state.config.concurrency);
    const wanted = stored && stored !== 6 ? stored : local ? 2 : 6;
    // 切批时要保证批次数够喂满 worker，否则小页面会有 worker 空转
    const concurrency = Math.max(1, Math.min(wanted, local ? 6 : 10));

    const userMax = Number(state.config.maxCharsPerBatch) || 2500;
    const totalChars = unique.reduce((s, it) => s + it.text.trim().length, 0);

    // 首批只放一小撮，页面顶部先出译文；剩下的文本由其余 worker 均分，
    // 批次数仍然正好一轮跑完，不会因为首批变小而多出一轮。
    const firstChars =
      concurrency > 1 ? Math.min(200, Math.floor(totalChars / concurrency / 2)) : 0;
    const restChars = Math.max(0, totalChars - firstChars);
    // 留 10% 余量：首批实际装不满预估字符数，不留余量会多切出一批尾巴
    const autoMax =
      concurrency > 1
        ? Math.ceil((restChars / (concurrency - 1)) * 1.1)
        : restChars;
    const maxChars = Math.max(300, Math.min(userMax, autoMax || userMax));

    const batches = DOM.batch(unique, {
      maxChars,
      // 64 条：字符上限 2500 装不满时，条数上限会成为批次数的主导因素
      // （后台管理页 / 仪表盘大量 10~20 字短文本），64 行仍在模型稳定遵循范围内
      maxItems: 64,
      firstMaxChars: firstChars
    });

    // 后台标签页不触发 rAF，用定时器兜底，避免 worker 永远挂起。
    // 32ms 约等于 30fps 一帧：既让出主线程处理输入/绘制，又不会在后台标签页
    // 里每批白等 50ms（10 批就是 500ms）
    const nextFrame = () =>
      new Promise((r) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          r();
        };
        requestAnimationFrame(fin);
        setTimeout(fin, 32);
      });

    const resuming = state.status === 'partial';
    state.status = 'translating';
    state.cancel = false;
    // 续译时保留已有记录，否则「还原」只能撤回最后一段
    if (!resuming) state.records = [];

    let finished = 0;
    let failed = 0;
    let cursor = 0;
    let inFlight = 0; // 在途请求数：进度条里显示出来，并发是否生效肉眼可见
    let tFirst = 0; // 首条译文出现的时间点，体现"感觉快不快"

    const worker = async () => {
      while (cursor < batches.length) {
        if (state.cancel) return;
        const b = batches[cursor++];
        const texts = b.map((x) => x.text);
        inFlight++;
        try {

        let applied = 0;
        const doneIdx = new Set();
        const onItem = (index, text) => {
          if (state.cancel || doneIdx.has(index)) return;
          const item = b[index];
          if (!item || !text || !text.trim()) return;
          doneIdx.add(index);
          if (!tFirst) tFirst = since();
          if (applyTranslation(groups, item.text, text.trim())) applied++;
        };

        // 优先流式：译文边生成边显示，首条不必等整批生成完
        let res = await translateBatchStreamed(texts, targetLang, onItem);

        // 接口不支持流式时，退回整批请求
        if (!res.ok && res.fallback && !state.cancel) {
          const full = await send({ type: 'translateBatch', texts, targetLang });
          if (full.ok && Array.isArray(full.translations)) {
            b.forEach((item, i) => {
              if (doneIdx.has(i)) return; // 流式已应用过，避免重复写入
              const t = full.translations[i];
              if (t && t.trim()) {
                doneIdx.add(i);
                if (applyTranslation(groups, item.text, t.trim())) applied++;
              }
            });
            res = { ok: true };
          } else {
            res = full;
          }
        }

        if (state.cancel) return;

        if (!res.ok) {
          failed += b.length;
          if (res.error) UI.flashToast(res.error, 4000);
        } else {
          failed += Math.max(0, b.length - applied);
        }

        finished++;
        UI.flashToast(
          `翻译中 ${Math.min(finished, batches.length)}/${batches.length} 批 · 并发 ${inFlight} · 已完成 ${state.records.length} 段`,
          60000
        );

        // 连续改 DOM 会阻塞主线程，每批结束让出一帧
        await nextFrame();
        } finally {
          inFlight--;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, worker)
    );

    if (state.cancel) {
      // 保留 partial：再点翻译接着译剩下的，点还原才清空
      state.status = state.records.length ? 'partial' : 'idle';
      UI.flashToast(`已停止，已译 ${state.records.length} 段，可再次翻译继续`);
      return;
    }

    state.status = 'done';
    startFollow();
    if (state.records.length) {
      const total = since();
      const first = tFirst || total;
      // 落地自检：写入成功不等于译文还留在页面上。React / Vue 这类框架
      // 在翻译过程中重渲染，会用自身 state 把文本节点覆盖回原文；
      // 而此时 MutationObserver 还没建立（它要等 done 之后才启动），
      // 没人补译，于是会出现「records 有 48 条、页面却还是英文」
      const lost = state.records.filter((r) =>
        r.applied
          ? !(r.applied[1] && r.applied[1].isConnected)
          : !r.node || !r.node.isConnected || r.node.nodeValue !== r.appliedText
      ).length;

      // 控制台留一份完整数据：批次数、并发、三段耗时，排查慢在哪里直接看这里
      console.info(
        `[LLMT] 收集 ${Math.round(tCollect)}ms · 首译文 ${Math.round(first)}ms · 全部 ${Math.round(total)}ms · ` +
          `${batches.length} 批 / 并发 ${concurrency}` +
          (lost ? ` · 落地失败 ${lost} 段` : '')
      );

      // 页面已经稳定、不再变化，observer 永远收不到信号，只能主动补一轮
      if (lost) {
        followRoots.clear();
        scheduleRescan(0);
      }

      UI.flashToast(
        `${failed ? `翻译完成，${failed} 段失败（可重试）` : `翻译完成，共 ${state.records.length} 段`}` +
          (lost ? `（${lost} 段被页面改回，正在补译）` : '') +
          ` · 首译 ${(first / 1000).toFixed(1)}s / 总 ${(total / 1000).toFixed(1)}s`,
        4000
      );
    } else {
      state.status = 'idle';
      UI.flashToast('翻译失败，请检查模型配置');
    }
  }

  function restorePage() {
    stopFollow();
    for (const rec of state.records) DOM.restore(rec);
    state.records = [];
    nodeParts.clear();
    DOM.clearMarks();
    state.status = 'idle';
    state.cancel = false;
    UI.flashToast('已还原原文');
  }

  /* ---------------- 动态内容翻译（MutationObserver） ---------------- */

  let observer = null;
  let followTimer = null;
  let rescanTimers = [];
  let rescanning = false;
  let rescanPending = false;
  let rescanQueued = false;
  let hrefTimer = null;
  let lastHref = '';
  let lastAttrScan = 0;
  let rescanBatchAt = 0;
  const followRoots = new Set();
  // 自己写回的译文节点，用来区分页面自身的内容变化
  const writtenNodes = new WeakSet();

  /**
   * 监视地址变化。
   * 页面的 history.pushState 跑在独立世界里，这里包不到它的函数，
   * 只能轻量轮询 href 兜底，覆盖不派发 popstate 的 SPA 路由。
   */
  function startHrefWatch() {
    if (hrefTimer) return;
    lastHref = location.href;
    hrefTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      scheduleRescan(400);
    }, 800);
  }

  function stopHrefWatch() {
    if (!hrefTimer) return;
    clearInterval(hrefTimer);
    hrefTimer = null;
  }

  /**
   * 全页翻译完成后开始跟随 DOM 变化：
   * SPA 路由切换、无限滚动、展开评论区产生的新内容会自动补译。
   */
  function startFollow() {
    if (observer || state.config.autoFollow === false) return;
    observer = new MutationObserver((muts) => {
      if (state.status !== 'done') return;
      let added = false;
      for (const m of muts) {
        if (m.type === 'attributes') {
          // 菜单切换大多只是 display:none ↔ block，DOM 一个节点都没动，
          // 只有属性变了。这种变化 collect 不到，只能触发补扫。
          if (DOM.isOwnUI(m.target)) continue;
          if (Date.now() - lastAttrScan < 1500) continue;
          lastAttrScan = Date.now();
          scheduleRescan(900);
          continue;
        }
        if (m.type === 'characterData') {
          // 自己写回的译文也会触发 characterData，必须排除，否则会无限重译
          if (writtenNodes.has(m.target)) continue;
          const p = m.target.parentElement;
          if (!p || DOM.isOwnUI(p)) continue;
          if (String(m.target.nodeValue || '').trim().length < 2) continue;
          followRoots.add(p);
          added = true;
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (DOM.isOwnUI(n)) continue;
          followRoots.add(n);
          added = true;
        }
      }
      if (added) scheduleFollow();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });

    startHrefWatch();
    // 翻译过程中页面可能已经切过菜单，完成后先补扫一轮
    scheduleRescan();
  }

  function stopFollow() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    stopHrefWatch();
    clearTimeout(followTimer);
    followTimer = null;
    for (const t of rescanTimers) clearTimeout(t);
    rescanTimers = [];
    rescanPending = false;
    rescanQueued = false;
    followRoots.clear();
  }

  function scheduleFollow() {
    clearTimeout(followTimer);
    followTimer = setTimeout(followTranslate, 800);
  }

  /** 分组去重后分批翻译，全页翻译与动态补译共用同一套流程 */
  async function translateItems(items, targetLang) {
    if (!items.length) return;

    const groups = new Map();
    for (const it of items) {
      const key = it.text.trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const unique = [...groups.entries()].map(([text, list]) => ({ text, list }));
    const batches = DOM.batch(unique, { maxChars: 1500, maxItems: 32 });

    for (const b of batches) {
      if (state.status !== 'done') return;
      const texts = b.map((x) => x.text);
      const res = await translateBatchStreamed(texts, targetLang, (index, text) => {
        const item = b[index];
        if (!item || !text || !text.trim()) return;
        applyTranslation(groups, item.text, text.trim());
      });

      // 流式不可用时逐条补，避免新内容整段漏译
      if (!res.ok && res.fallback) {
        for (const t of texts) {
          if (state.status !== 'done') return;
          const one = await send({ type: 'translateText', text: t });
          if (one.ok && one.translation) {
            applyTranslation(groups, t, one.translation.trim());
          }
        }
      }
    }
  }

  async function followTranslate() {
    followTimer = null;
    if (state.status !== 'done') return;

    const roots = [...followRoots];
    followRoots.clear();
    if (!roots.length) return;

    const targetLang = state.config.targetLang;
    const items = [];
    for (const r of roots) {
      if (!r.isConnected) continue;
      const root = r.nodeType === 1 ? r : r.parentElement;
      if (!root) continue;
      try {
        items.push(...(await DOM.collect(root, targetLang)));
      } catch {
        /* 节点已失效 */
      }
    }
    await translateItems(items, targetLang);
  }

  /* ---------------- 菜单 / 路由切换后的补译 ---------------- */

  /**
   * 安排补扫。菜单切换后的内容往往分几拍渲染（骨架屏 → 数据 → 图片），
   * 只扫一次很容易扫在空档上，所以按三个时间点各扫一轮。
   * 首拍必须全页扫（菜单切换只是 display 变化，DOM 没动）；
   * 后两拍只扫这段窗口期内新增的子树，没有新增就直接返回，
   * 避免大页面在一次点击里反复全页遍历三遍。
   */
  function scheduleRescan(delay = 600) {
    if (state.status !== 'done' || state.config.autoFollow === false) return;
    // 轮播图、滚动动画会高频改 class，不加节流会把定时器一直往后推，
    // 扫描永远排不上；3 秒内只排一轮，保证补扫一定能落地。
    const now = Date.now();
    if (now - rescanBatchAt < 3000) {
      // 窗口内的新变更不丢弃：标记待办，本轮拍数全部落地后再补一轮，
      // 否则 2 秒内连点两个菜单，第二个菜单的渲染慢一点就会漏译
      rescanQueued = true;
      return;
    }
    rescanBatchAt = now;
    rescanQueued = false;

    for (const t of rescanTimers) clearTimeout(t);
    // 快照不清空：followRoots 仍归 followTranslate 消费，两边都靠
    // collect 的「已译过滤」去重，不会重复翻译
    const later = () => rescanVisible([...followRoots]);
    const taps = [delay, delay + 1200, delay + 2600];
    rescanTimers = taps.map((d, i) =>
      setTimeout(() => {
        if (i === 0) rescanVisible(document.body);
        else later();
        if (i === taps.length - 1 && rescanQueued) {
          rescanQueued = false;
          scheduleRescan(300);
        }
      }, d)
    );
  }

  /**
   * 重新扫描可见文本。
   * scope 为 document.body 时全页扫描（菜单切换场景）；
   * 为子树列表时只扫这些新增节点（补译跟进场景）。
   * 菜单切换大多只是把面板从 display:none 改成 block，DOM 一个节点都没动，
   * MutationObserver 完全看不见，只能主动补扫一遍。
   */
  async function rescanVisible(scope = document.body) {
    if (state.status !== 'done') return;
    if (rescanning) {
      // 上一轮还没跑完，标记一下，结束后再补一次，别把这次丢掉
      rescanPending = true;
      return;
    }

    rescanning = true;
    try {
      const targetLang = state.config.targetLang;
      let items = [];
      try {
        if (scope === document.body) {
          items = await DOM.collect(document.body, targetLang);
        } else {
          for (const r of scope) {
            if (!r.isConnected) continue;
            const root = r.nodeType === 1 ? r : r.parentElement;
            if (!root) continue;
            items.push(...(await DOM.collect(root, targetLang)));
          }
        }
      } catch {
        items = [];
      }
      await translateItems(items, targetLang);
    } finally {
      rescanning = false;
      if (rescanPending) {
        rescanPending = false;
        scheduleRescan(300);
      }
    }
  }

  // 点击菜单 / 标签页 / 分页后补扫（捕获阶段，避免被页面 stopPropagation 拦掉）
  document.addEventListener(
    'click',
    (e) => {
      if (state.status !== 'done') return;
      const t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (DOM.isOwnUI(t) || UI.isCardEvent(e) || UI.isTriggerEvent(e)) return;
      // 输入类元素不会改变可翻译内容，排除掉，避免打字 / 聚焦也触发全页补扫
      if (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      scheduleRescan();
    },
    true
  );

  // 浏览器前进/后退、hash 路由切换（事件对象不能当延迟参数传进去）
  window.addEventListener('popstate', () => scheduleRescan(400));
  window.addEventListener('hashchange', () => scheduleRescan(400));

  /* ---------------- 悬停翻译（Shift + 悬停） ---------------- */

  let hoverTimer = null;
  let hoverEl = null;

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!e.shiftKey) {
        if (hoverEl) {
          clearTimeout(hoverTimer);
          hoverEl = null;
        }
        return;
      }
      if (state.config.hoverTranslate === false) return;
      const el = e.target;
      if (!el || el.nodeType !== 1 || el === hoverEl) return;
      if (DOM.isOwnUI(el) || UI.isCardEvent(e) || UI.isTriggerEvent(e)) return;

      hoverEl = el;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!hoverEl || !hoverEl.isConnected) return;
        const block = DOM.nearestBlock(hoverEl);
        const text = getBlockText(block);
        if (!text) return;
        const rect = hoverEl.getBoundingClientRect();
        translateSelection(text, rect, { readOnly: true });
      }, 450);
    },
    true
  );

  /* ---------------- 输入框翻译（Alt + Enter） ---------------- */

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return t === 'text' || t === 'search' || t === 'url' || t === 'email' || t === '';
    }
    return !!el.isContentEditable;
  }

  function readEditable(el) {
    if (el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
      return (el.innerText || '').trim();
    }
    return String(el.value || '').trim();
  }

  function writeEditable(el, text) {
    if (el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
      el.innerText = text;
      return;
    }
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function translateInput(el) {
    // 再按一次撤销：翻译前的原文存在 dataset 里
    if (el.dataset && el.dataset.llmtPrev) {
      const prev = el.dataset.llmtPrev;
      delete el.dataset.llmtPrev;
      writeEditable(el, prev);
      UI.flashToast('已还原原文');
      return;
    }
    const text = readEditable(el);
    if (!text) return;
    if (text.length > 5000) {
      UI.flashToast('输入内容过长，请分段翻译');
      return;
    }

    UI.flashToast('正在翻译输入框…', 20000);
    const res = await send({ type: 'translateText', text });
    if (!res.ok) {
      UI.flashToast(res.error || '翻译失败', 4000);
      return;
    }
    el.dataset.llmtPrev = text;
    writeEditable(el, res.translation.trim());
    UI.flashToast('已翻译，再按 Alt+Enter 撤销', 2600);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.key !== 'Enter') return;
      if (state.config.inputTranslate === false) return;
      if (!isEditable(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      translateInput(e.target);
    },
    true
  );

  /* ---------------- 划词翻译 ---------------- */

  function getSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return sel.toString().trim();
  }

  /** 用译文替换指定 Range（选区可能在点击卡片时丢失，故提前克隆） */
  function replaceRange(range, text) {
    try {
      if (range && range.startContainer && range.startContainer.isConnected) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
      } else {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
      }
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    } catch {
      UI.flashToast('替换失败：页面内容已变化');
    }
  }

  async function translateSelection(text, rect, opts = {}) {
    const content = (text || '').trim();
    if (!content) return;
    if (content.length > 5000) {
      UI.flashToast('选中内容过长，请分段翻译');
      return;
    }

    const anchor = rect || UI.getSelectionRect();

    // 提前克隆选区，防止点击卡片时浏览器清除 selection 导致替换失败
    let savedRange = null;
    if (!opts.readOnly) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    }

    UI.hideTrigger();
    UI.showCard({
      rect: anchor,
      original: content,
      onReplace: opts.readOnly ? null : (t) => replaceRange(savedRange, t)
    });

    const res = await send({ type: 'translateText', text: content });
    if (res.ok) {
      UI.setCardResult(res.translation);
    } else {
      UI.setCardError(res.error || '翻译失败');
    }
  }

  /* ---------------- Alt + 点击段落翻译 ---------------- */

  function getBlockText(el) {
    if (!el || el.nodeType !== 1) return '';
    const t = (el.innerText || el.textContent || '').trim();
    return t.length > 3000 ? t.slice(0, 3000) : t;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!e.altKey) return;
      if (UI.isTriggerEvent(e) || UI.isCardEvent(e)) return;
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      if (DOM.isOwnUI(target)) return;

      const block = DOM.nearestBlock(target);
      const text = getBlockText(block);
      if (!text) return;

      e.preventDefault();
      e.stopPropagation();
      const rect = target.getBoundingClientRect();
      translateSelection(text, rect, { readOnly: true });
    },
    true
  );

  /* ---------------- 划词交互 ---------------- */

  let mouseDownInCard = false;

  document.addEventListener(
    'mousedown',
    (e) => {
      mouseDownInCard = UI.isCardEvent(e);
    },
    true
  );

  // 捕获阶段监听：页面脚本若 stopPropagation，冒泡阶段会收不到 mouseup
  document.addEventListener('mouseup', (e) => {
    if (UI.isCardEvent(e) || UI.isTriggerEvent(e)) return;
    if (mouseDownInCard) {
      mouseDownInCard = false;
      return;
    }

    setTimeout(() => {
      const text = getSelectedText();
      if (!text || text.length < 1) {
        UI.hideTrigger();
        return;
      }
      if (text.length > 5000) {
        UI.hideTrigger();
        return;
      }
      const rect = UI.getSelectionRect();
      if (!rect) return;

      if (state.config.autoTranslateSelection) {
        translateSelection(text, rect);
      } else {
        UI.showTrigger(rect, () => translateSelection(text, rect));
      }
    }, 10);
  }, true);

  // 点击空白处关闭卡片与按钮
  document.addEventListener(
    'mousedown',
    (e) => {
      if (UI.isCardEvent(e) || UI.isTriggerEvent(e)) return;
      if (UI.isCardVisible()) UI.hideCard();
      UI.hideTrigger();
    },
    true
  );

  // 卡片内"重新翻译"
  UI.bindActions({
    onRetranslate: async (original) => {
      UI.setCardLoading();
      const res = await send({ type: 'translateText', text: original });
      if (res.ok) UI.setCardResult(res.translation);
      else UI.setCardError(res.error || '翻译失败');
    }
  });

  /* ---------------- 消息入口 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'llmtChunk') {
      const w = streamWaiters.get(msg.streamId);
      if (w && !state.cancel) w.onItem(msg.index, msg.text);
      return;
    }

    if (msg.type === 'llmtDone') {
      const w = streamWaiters.get(msg.streamId);
      if (w) {
        streamWaiters.delete(msg.streamId);
        clearTimeout(w.timer);
        w.resolve({ ok: !!msg.ok, fallback: !!msg.fallback, error: msg.error || '' });
      }
      return;
    }

    if (msg.type === 'pageAction') {
      if (msg.action === 'translate') translatePage(true);
      else if (msg.action === 'restore') restorePage();
      else translatePage();
      sendResponse({ ok: true, status: state.status });
      return true;
    }

    if (msg.type === 'translateSelection') {
      translateSelection(msg.text);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'getStatus') {
      sendResponse({
        ok: true,
        status: state.status,
        count: state.records.length,
        bilingual: !!state.config.bilingual
      });
      return true;
    }
  });

  /* ---------------- 外语页面自动提示 ---------------- */

  const LANG_NAMES = {
    zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français',
    de: 'Deutsch', es: 'Español', pt: 'Português', it: 'Italiano', ru: 'Русский',
    ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', tr: 'Türkçe', nl: 'Nederlands',
    pl: 'Polski', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', hi: 'हिन्दी',
    he: 'עברית', uk: 'Українська', sv: 'Svenska', da: 'Dansk', fi: 'Suomi',
    no: 'Norsk', cs: 'Čeština', el: 'Ελληνικά', fa: 'فارسی', ro: 'Română',
    hu: 'Magyar', latin: '外语'
  };

  // 拉丁字母无法从字符集细分语种，同族视为相同，避免误打扰
  const LATIN_LANGS = new Set([
    'en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'fi',
    'pl', 'cs', 'ro', 'hu', 'tr', 'id', 'ms', 'vi'
  ]);

  function primaryLang(code) {
    return String(code || '').toLowerCase().split(/[-_]/)[0];
  }

  /** 把用户设置的目标语言名映射为语言码，无法识别时返回空串 */
  function targetLangCode(name) {
    const s = String(name || '').toLowerCase();
    if (/中文|汉语|漢語|简体|繁體|繁体|chinese|^zh/.test(s)) return 'zh';
    if (/english|英文|英语|英語/.test(s)) return 'en';
    if (/日本語|日文|japanese|^ja/.test(s)) return 'ja';
    if (/한국|韩语|韓語|korean|^ko/.test(s)) return 'ko';
    if (/français|french|法语|法文|^fr/.test(s)) return 'fr';
    if (/deutsch|german|德语|德文|^de/.test(s)) return 'de';
    if (/español|spanish|西班牙|^es/.test(s)) return 'es';
    if (/русский|russian|俄语|俄文|^ru/.test(s)) return 'ru';
    return '';
  }

  function sameLanguage(a, b) {
    const x = primaryLang(a);
    const y = primaryLang(b);
    if (!x || !y) return true; // 判断不了就当作相同，宁可不提示
    if (x === y) return true;
    if (x === 'latin' && LATIN_LANGS.has(y)) return true;
    if (y === 'latin' && LATIN_LANGS.has(x)) return true;
    return false;
  }

  function siteKey() {
    return location.hostname || location.origin;
  }

  function isSiteSkipped(cfg) {
    const list = Array.isArray(cfg.skipSites) ? cfg.skipSites : [];
    return list.includes(siteKey());
  }

  function systemLanguage() {
    const list = [];
    try {
      list.push(chrome.i18n.getUILanguage());
    } catch {
      /* 个别环境不支持，走 navigator 兜底 */
    }
    if (Array.isArray(navigator.languages)) list.push(...navigator.languages);
    list.push(navigator.language);
    return list.find((v) => v && String(v).trim()) || '';
  }

  /**
   * 判断并提示。返回 true 表示已得出结论（提示了或确定无需提示），
   * 返回 false 表示页面正文还没渲染出来，可以稍后重试。
   */
  function maybeSuggestTranslate() {
    const cfg = state.config;
    if (cfg.autoPrompt === false) return true;
    if (state.status !== 'idle') return true;
    if (!/^https?:$/.test(location.protocol)) return true;
    if (isSiteSkipped(cfg)) return true;
    if (UI.isPromptVisible()) return true;

    const pageLang = DOM.detectLanguage();
    if (!pageLang) return false;

    // 页面语言与系统语言一致、或已经是目标语言时不打扰
    if (sameLanguage(pageLang, systemLanguage())) return true;
    if (sameLanguage(pageLang, targetLangCode(cfg.targetLang))) return true;

    const from = LANG_NAMES[primaryLang(pageLang)] || primaryLang(pageLang).toUpperCase();
    const to = cfg.targetLang || '简体中文';

    UI.showPrompt({
      title: `检测到${from}页面`,
      desc: `要翻译成「${to}」吗？`,
      onTranslate: () => translatePage(true),
      onDismiss: () => {},
      onNever: async () => {
        const list = Array.isArray(cfg.skipSites) ? cfg.skipSites.slice() : [];
        if (!list.includes(siteKey())) list.push(siteKey());
        state.config.skipSites = list;
        try {
          await chrome.storage.sync.set({ skipSites: list });
        } catch {
          /* 保存失败也不影响本次关闭 */
        }
        UI.flashToast('已关闭此站点的翻译提示');
      }
    });
    return true;
  }

  /**
   * 首屏可能还在渲染，分几次重试；一旦有结论立即停止。
   * 首拍压到 300ms：有 lang 声明的站点第一拍就能判定，不必等半秒以上。
   * 另外在 load 事件后补一拍：JS 渲染的首屏通常在这时才有正文，
   * 比干等重试链最后一拍快得多。
   */
  function scheduleSuggestCheck() {
    const delays = [300, 800, 1800, 4000];
    let i = 0;
    let settled = false;

    const check = () => {
      if (settled) return true;
      if (maybeSuggestTranslate()) settled = true;
      return settled;
    };

    const step = () => {
      if (settled || i >= delays.length) return;
      setTimeout(() => {
        if (!check()) step();
      }, delays[i++]);
    };

    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => check(), { once: true });
    }
    step();
  }

  // 注入时顺手唤醒 Service Worker：冷启动要几十到上百毫秒，
  // 用户点翻译时若正好撞上冷启动，第一条请求就白等这段时间。
  // SW 已在运行时这条消息几乎是零成本；chrome:// 等页面发不出去，失败无害
  chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {});

  loadConfig().then(scheduleSuggestCheck);
})();
