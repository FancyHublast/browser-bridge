/**
 * Browser Bridge · 元素拾取器（picker）
 *
 * 【这是什么】
 *   "按住 Ctrl 悬停高亮、点一下自动出定位符" —— 桌面 RPA 里体验上最不可替代的那一环。
 *   agent 拿不到稳定选择器时，可以发起一次「拾取会话」：人在页面上点一下目标，
 *   插件回一个**可复用的元素描述符**，agent 存下来在后续步骤里反复使用。
 *   等于把「人工示教」变成了一个工具调用。
 *
 * 【为什么 agent 需要它】
 *   自动定位再强也有边界：canvas 画的控件、随机类名的第三方组件、
 *   一天改三版的运营页。这时候最经济的做法不是让 agent 死磕，
 *   而是问一次人 —— 一次点击的成本，远低于 agent 试错十次。
 *
 * 【事件怎么被拦下来】
 *   overlay 用 pointer-events:none（这样页面照常滚动，用户体验不变），
 *   所有鼠标事件在 **window 的捕获阶段** 拦截：stopPropagation 让事件根本到不了页面元素，
 *   preventDefault 挡掉默认行为。
 *   所以拾取过程中不会误触发页面的任何点击、跳转、提交。
 *
 * 【为什么高亮框要放 Shadow DOM】
 *   页面的 CSS 是全局的。不隔离的话，宿主的 `* { box-sizing }`、`div { position: static }`
 *   之类规则会把我们的悬浮框搞变形，而且是"在这个站点好、在那个站点崩"的薛定谔故障。
 *   Shadow DOM 一劳永逸。
 *
 * 【为什么描述符不在每次 mousemove 里生成】
 *   buildFrom 内部要做最小充分裁剪（对着页面跑 5~8 次全量打分），几十毫秒起步。
 *   每帧都跑必然卡顿。所以：高亮即时更新（便宜），描述符 150ms 防抖后生成（贵但够快），
 *   点击时若缓存有效就直接复用。
 */
(function () {
  'use strict';

  if (!window.RK || window.RK.__pickerLoaded) return;
  const RK = window.RK;
  if (!RK.locator) return; // 依赖 locator（描述符生成与预览）

  const HOST_ID = '__bb_pick_host__';
  const PANEL_ID = '__bb_panel_host__';
  const KEEPALIVE_MS = 5000;
  const PREVIEW_DEBOUNCE_MS = 150;
  const MAX_BUBBLE_UP = 6;

  /** 单次会话的状态。null = 未在拾取 */
  let session = null;
  let hostEl = null;
  let shadow = null;
  let els = {};
  let keepaliveTimer = null;
  let previewTimer = null;
  let rafId = 0;
  let lastPoint = { x: 0, y: 0 };

  function log() {
    RK.log.apply(null, ['[picker]'].concat([].slice.call(arguments)));
  }

  // ───────────────────────── 会话生命周期 ─────────────────────────

  function active() {
    return !!session;
  }

  function start(opts) {
    const o = opts || {};
    if (session) {
      // 已经有一次会话在跑：视为重复调用，不叠加
      return { started: false, reason: '已有拾取会话在进行中', sessionId: session.id };
    }

    session = {
      /**
       * 会话 id 由上层（SW）统一生成并下发。
       * 【为什么不能各帧自己生成】拾取是**所有帧同时起会话**的（否则 iframe 里的元素拾取不到），
       * 而最终只有一个帧会真正收到点击。若每帧 id 不同，SW 那边的 sessionId 校验
       * 就会把"正确帧"的结果当成串号数据丢掉 —— 整个拾取链路直接断掉。
       */
      id: o.sessionId || 'pk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      hint: o.hint || '',
      anchor: o.anchor || 'semantic', // semantic = 冒泡到语义元素；raw = 严格取鼠标下的元素
      multi: !!o.multi,
      // agent 给这次拾取起的名字。最终写进每条 item.name —— 同名会被 SW 视作"重做一遍"覆盖
      name: o.name || '',
      /**
       * manual = 人自己按快捷键发起的拾取，而不是 agent 通过 browser_pick 发起的。
       * 区别只在于结果的去向：agent 发起时结果由 pendingPick 接走；
       * 手动发起时没有接收方，由 service worker 落进 chrome.storage，
       * 之后 agent 用 browser_picks 取走。这样"人先攒一批元素"这件事不需要 agent 在场。
       */
      manual: !!o.manual,
      picked: [],
      preview: null, // { el, descriptor, quality, summary }
      target: null // 当前高亮的目标元素
    };

    ensureHost();
    showOverlay(true);
    bind(true);
    startKeepalive();
    hidePanel(true);

    setBadge(
      session.hint
        ? session.hint
        : '拾取模式：按住 Ctrl + 左键点击目标元素' +
          (session.multi ? '（可连续拾取，Esc 结束）' : '（Esc 取消）') +
          '　Alt+左键 = 严格选中鼠标下的元素'
    );

    log('拾取会话开始', session.id, 'anchor=' + session.anchor, 'multi=' + session.multi);
    return { started: true, sessionId: session.id };
  }

  function finish(payload, notify) {
    if (!session) return;
    const sid = session.id;
    // manual 标记必须在清空 session 之前读出来：结果的去向由它决定
    // （agent 发起 → pendingPick 接走；手动发起 → SW 落盘，等 browser_picks 来取）
    const manual = !!session.manual;

    bind(false);
    stopKeepalive();
    showOverlay(false);
    hidePanel(false);
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    session = null;

    if (notify !== false) {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ __bb_pick_result: true, sessionId: sid, manual: manual }, payload),
          function () {
            void chrome.runtime.lastError;
          }
        );
      } catch (e) {
        /* 扩展上下文失效（重载/卸载），静默即可 */
      }
    }
  }

  function cancel(reason, opts) {
    if (!session) return { cancelled: false, reason: '当前没有拾取会话' };

    // 连续拾取模式下，Esc 是"收工"而不是"放弃" —— 已经点到的东西必须交出去，
    // 否则用户点了五个元素、手一抖按了 Esc，前面全白干。
    if (session.multi && session.picked.length) {
      const items = session.picked.slice();
      log('连续拾取结束，交回', items.length, '个描述符');
      finish({
        ok: true,
        data: { multi: true, count: items.length, items: items },
        note: reason || '连续拾取结束'
      });
      return { cancelled: true, completed: true, count: items.length };
    }

    log('拾取会话取消：', reason);
    // silent：上层（超时 / 被新请求替换）主动收尾时不再回传 —— 该由上层给的拒绝
    // 已经给出去了，这条迟到的结果没有接收方，只会白白制造一次"石沉大海"的日志。
    // 用户自己按 Esc / 右键取消时**必须**回传，那是唯一的结果来源。
    finish({ ok: false, cancelled: true, error: reason || '用户取消了拾取' }, !(opts && opts.silent));
    return { cancelled: true, reason: reason || '用户取消' };
  }

  // ───────────────────────── DOM 装配 ─────────────────────────

  function ensureHost() {
    if (hostEl && hostEl.isConnected) return hostEl;

    hostEl = document.getElementById(HOST_ID);
    if (hostEl && hostEl.shadowRoot) {
      shadow = hostEl.shadowRoot;
      els = shadow.__bbEls || {};
      return hostEl;
    }

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';

    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.hl{position:fixed;left:0;top:0;width:0;height:0;display:none;' +
      'border:1px solid #0F6E56;background:rgba(29,158,117,0.14);border-radius:3px;' +
      'box-shadow:0 0 0 1px rgba(255,255,255,0.7);pointer-events:none;box-sizing:border-box}' +
      '.hl.raw{border-color:#BA7517;background:rgba(239,159,39,0.16)}' +
      '.badge{position:fixed;left:12px;top:12px;max-width:min(620px,86vw);' +
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#085041;' +
      'background:#E1F5EE;border:1px solid #0F6E56;border-radius:8px;padding:6px 10px;' +
      'pointer-events:none;box-sizing:border-box;white-space:normal;word-break:break-all}' +
      '.tip{position:fixed;display:none;max-width:min(520px,80vw);' +
      'font:12px/1.5 ui-monospace,Consolas,monospace;color:#2C2C2A;background:#FFFFFF;' +
      'border:1px solid #888780;border-radius:8px;padding:6px 9px;' +
      'pointer-events:none;box-sizing:border-box;white-space:normal;word-break:break-all}' +
      '.tip .t{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0C447C;display:block;margin-bottom:2px}' +
      '.tip .d{color:#085041;display:block}' +
      '.tip .w{color:#854F0B;display:block;margin-top:2px}' +
      '</style>' +
      '<div class="hl"></div><div class="tip"></div><div class="badge"></div>';

    els = {
      hl: shadow.querySelector('.hl'),
      tip: shadow.querySelector('.tip'),
      badge: shadow.querySelector('.badge')
    };
    shadow.__bbEls = els;

    (document.documentElement || document.body).appendChild(hostEl);
    return hostEl;
  }

  function showOverlay(on) {
    if (!els.hl) return;
    els.hl.style.display = on ? '' : 'none';
    if (els.tip) els.tip.style.display = 'none';
    if (els.badge) els.badge.style.display = on ? '' : 'none';
  }

  function setBadge(text) {
    if (els.badge) els.badge.textContent = text;
  }

  /**
   * 拾取期间把 BB 面板球藏起来。
   * 面板是 position:fixed 挂右上角的，目标元素常常就在那附近 —— 不藏会挡手。
   */
  function hidePanel(hide) {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;
    if (hide) {
      p.__bb_prev_display = p.style.display;
      p.style.display = 'none';
    } else {
      p.style.display = p.__bb_prev_display || '';
      delete p.__bb_prev_display;
    }
  }

  // ───────────────────────── 目标判定 ─────────────────────────

  const INTERACTIVE = /^(a|button|input|select|textarea|option|label|summary)$/i;

  /**
   * 语义目标冒泡 —— 影刀「元素显著性判定」的简化版。
   *
   * 【为什么不能直接用鼠标下的元素】
   *   现代前端里，一个按钮常常是 <button><span><svg/></span><span>登录</span></button>。
   *   鼠标停在文字上，elementFromPoint 返回的是那个 <span> ——
   *   拿它生成描述符，下次点的时候 span 的文本可能被 React 换掉，定位就飘了。
   *   往上冒泡到"有语义的那一层"（button / a / [role] / 带 testid 的节点）才稳。
   */
  function semanticTarget(el) {
    let node = el;
    let up = 0;
    while (node && node.nodeType === 1 && up < MAX_BUBBLE_UP) {
      if (INTERACTIVE.test(node.tagName)) return node;
      if (node.getAttribute('role')) return node;
      if (node.getAttribute('data-testid') || node.getAttribute('data-test')) return node;

      const text = RK.adapter.ownText(node);
      // 有独立文本、且不是包了一堆子节点的大容器 → 可以停在这里
      if (text && text.length <= 40 && node.children && node.children.length <= 3) return node;

      node = node.parentElement;
      up++;
    }
    return el;
  }

  // ───────────────────────── 事件绑定 ─────────────────────────

  const HANDLERS = {
    mousemove: onMove,
    mousedown: swallow,
    mouseup: swallow,
    click: onClick,
    dblclick: swallow,
    auxclick: swallow,
    contextmenu: onContextMenu,
    keydown: onKeyDown,
    scroll: onScroll,
    wheel: function () {
      // 滚轮放行：拾取时经常需要滚动去找元素，拦掉它就变成"必须取消才能滚"
    }
  };

  const BOUND = ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'scroll'];

  function bind(on) {
    for (let i = 0; i < BOUND.length; i++) {
      const type = BOUND[i];
      if (on) window.addEventListener(type, HANDLERS[type], true);
      else window.removeEventListener(type, HANDLERS[type], true);
    }
  }

  function swallow(e) {
    if (!session) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function pointOf(e) {
    return { x: Math.round(e.clientX), y: Math.round(e.clientY) };
  }

  function onMove(e) {
    if (!session) return;
    swallow(e);

    const pt = pointOf(e);
    lastPoint = pt;

    if (rafId) return; // 一帧只处理一次，mousemove 的触发频率远高于渲染帧率
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      updateTarget(pt);
    });
  }

  function onScroll() {
    if (!session || !session.target) return;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      paintHighlight(session.target);
      positionTip(lastPoint);
    });
  }

  function onContextMenu(e) {
    if (!session) return;
    swallow(e);
    cancel('用户右键取消了拾取');
  }

  function onKeyDown(e) {
    if (!session) return;
    if (e.key === 'Escape') {
      swallow(e);
      cancel('用户按 Esc 取消了拾取');
    }
  }

  /** 解析鼠标下的元素（穿透 Shadow DOM），并切到语义目标 */
  function resolveUnder(pt, strictOverride) {
    let raw = RK.adapter.deepElementFromPoint(pt.x, pt.y);
    if (raw && (raw === hostEl || hostEl.contains(raw))) raw = null;

    // overlay 是 pointer-events:none，正常情况不会命中它；这里只是兜底，
    // 真出现了就临时藏一下再取一次
    if (!raw) {
      if (els.hl) els.hl.style.display = 'none';
      try {
        raw = RK.adapter.deepElementFromPoint(pt.x, pt.y);
      } finally {
        if (els.hl) els.hl.style.display = '';
      }
    }
    if (!raw || raw.nodeType !== 1) return null;

    // strict（不向上冒泡到语义父元素）：会话级 raw 模式，或本次点击按住 Alt 临时指定
    const strict = strictOverride === true || session.anchor === 'raw';
    return { raw: raw, target: strict ? raw : semanticTarget(raw) };
  }

  function updateTarget(pt) {
    if (!session) return;
    const r = resolveUnder(pt);
    if (!r) {
      setTip('（此处没有可拾取的元素）');
      return;
    }

    // 相同目标不重复算 —— buildFrom 很贵，必须去重
    if (session.target !== r.target) {
      session.target = r.target;
      session.preview = null;
      paintHighlight(r.target);
      paintPreview(r.target); // 先出便宜的信息
      schedulePreview(r.target); // 再补描述符（防抖）
    } else {
      positionTip(pt);
    }
  }

  function paintHighlight(el) {
    if (!els.hl || !el) return;
    const rect = el.getBoundingClientRect();
    els.hl.style.display = '';
    els.hl.style.left = Math.round(rect.left) + 'px';
    els.hl.style.top = Math.round(rect.top) + 'px';
    els.hl.style.width = Math.round(rect.width) + 'px';
    els.hl.style.height = Math.round(rect.height) + 'px';
    if (el.tagName === 'IFRAME') els.hl.classList.add('raw');
    else els.hl.classList.remove('raw');
  }

  /** 便宜的即时预览：元素长什么样 */
  function paintPreview(el) {
    const d = RK.adapter.describe(el);
    if (!d) return;
    const head = d.tag + (d.attrs.id ? '#' + d.attrs.id : '') + (d.classes.length ? '.' + d.classes.slice(0, 2).join('.') : '');
    const text = d.text ? '“' + d.text.slice(0, 60) + '”' : '';
    const rect = d.rect.w + '×' + d.rect.h + ' @' + d.rect.x + ',' + d.rect.y;
    session.preview = { el: el, descriptor: null, summary: '' };
    setTip(
      '<span class="t">' + escapeHtml(head) + '</span>' +
        (text ? '<span class="d">' + escapeHtml(text) + '</span>' : '') +
        '<span class="w">' + escapeHtml(rect) + '　生成描述符中…</span>'
    );
    positionTip(lastPoint);
  }

  function schedulePreview(el) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      previewTimer = null;
      if (!session || session.target !== el) return;
      let built;
      try {
        built = RK.locator.buildFrom(el, { note: '' });
      } catch (e) {
        setTip('生成描述符失败：' + escapeHtml(String((e && e.message) || e)));
        return;
      }
      session.preview = { el: el, descriptor: built.descriptor, quality: built.quality, summary: built.summary, dropped: built.dropped };
      renderPreviewTip();
    }, PREVIEW_DEBOUNCE_MS);
  }

  function renderPreviewTip() {
    const p = session && session.preview;
    if (!p || !p.descriptor) return;
    const q = p.quality || {};
    const warn = q.unique
      ? '<span class="d">→ 唯一命中（' + q.score + '）</span>'
      : '<span class="w">⚠ 不唯一：页面上还有 ' + Math.max(0, (q.candidateCount || 1) - 1) + ' 个相似元素</span>';
    setTip('<span class="t">将写入：</span><span class="d">' + escapeHtml(p.summary || '') + '</span>' + warn);
    positionTip(lastPoint);
  }

  function setTip(html) {
    if (!els.tip) return;
    els.tip.innerHTML = html;
    els.tip.style.display = '';
  }

  /** 让提示框跟着鼠标走，但不越出视口 */
  function positionTip(pt) {
    if (!els.tip || els.tip.style.display === 'none') return;
    const p = pt || lastPoint;
    const w = els.tip.offsetWidth || 240;
    const h = els.tip.offsetHeight || 60;
    let x = p.x + 16;
    let y = p.y + 18;
    if (x + w > window.innerWidth - 8) x = Math.max(8, p.x - w - 16);
    if (y + h > window.innerHeight - 8) y = Math.max(8, p.y - h - 16);
    els.tip.style.left = Math.round(x) + 'px';
    els.tip.style.top = Math.round(y) + 'px';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ───────────────────────── 确认拾取 ─────────────────────────

  function onClick(e) {
    if (!session) return;
    // 拾取期间一律吞掉点击：不让页面收到，避免"想拾取却把按钮点下去了"
    swallow(e);

    /**
     * 【拾取的确认键必须是 Ctrl + 左键】
     *   第一版是"左键即拾取"，实测两个问题：
     *     ① 手滑点一下就拾错了，而拾错元素比拾不到更麻烦（后面全按错的来）；
     *     ② 与页面自身的点击语义完全混在一起，用户分不清自己是在"浏览"还是"拾取"。
     *   改成 Ctrl+左键（影刀也是这个键位）之后：移动鼠标随便看、随便滚，
     *   只有显式按住 Ctrl 点下去才算数 —— 浏览与拾取两种意图彻底分开。
     *   没按 Ctrl 时给一句明确提示，而不是默默什么都不做。
     */
    if (!e.ctrlKey) {
      setBadge('按住 Ctrl 再点左键才拾取（当前只是预览）。Esc 取消。');
      return;
    }

    const pt = pointOf(e);
    // 按住 Alt = 严格选中鼠标正下方的元素（不向上冒泡到 button / a 这类语义父元素）
    const r = resolveUnder(pt, e.altKey);
    if (!r) {
      setBadge('这里没有可拾取的元素，换个位置再点（Esc 取消）');
      return;
    }

    const el = r.target;

    // 缓存有效就直接用，避免重复跑 prune
    let built;
    if (session.preview && session.preview.el === el && session.preview.descriptor) {
      built = session.preview;
    } else {
      try {
        built = RK.locator.buildFrom(el, { note: '' });
      } catch (err) {
        setBadge('生成描述符失败：' + String((err && err.message) || err) + '（Esc 取消）');
        return;
      }
    }

    const item = {
      // 名字分三档：① SW 传来的 sessionName（agent 给的，覆盖默认）
      // ② 浏览器拾取时的 hint（手动模式由 SW 强写入）
      // ③ 自动 fallback：<标题-title>|<角色>-序号>
      name:
        session.name ||
        session.hint ||
        (document.title || 'page').slice(0, 20) +
          '|' +
          (el.tagName || 'el').toLowerCase() +
          '-' +
          Math.floor(Math.random() * 1000),
      descriptor: built.descriptor,
      summary: built.summary,
      quality: built.quality,
      dropped: built.dropped || [],
      element: RK.adapter.describe(el),
      url: location.href,
      title: document.title,
      strict: session.anchor === 'raw',
      pickedAt: Date.now()
    };

    if (session.multi) {
      session.picked.push(item);
      session.target = null;
      session.preview = null;
      setBadge(
        '已拾取 ' + session.picked.length + ' 个：' + item.summary + '　（Ctrl+左键继续，Esc 结束）'
      );
      return;
    }

    finish({ ok: true, data: item });
  }

  // ───────────────────────── 保活 ─────────────────────────

  /**
   * 拾取过程可能持续几十秒。MV3 的 service worker 空闲 30 秒就被回收，
   * 而 content 的常规保活只在页面可见时发 —— 用户切个标签页就可能断。
   * 所以拾取会话期间自己发一条，保证 SW 活到结果回传。
   */
  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      if (!session) return;
      try {
        chrome.runtime.sendMessage({ __bb_keeplive: true }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        /* 忽略 */
      }
    }, KEEPALIVE_MS);
  }

  function stopKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  // ───────────────────────── SW 协议（每帧实例）─────────────────────────

  /**
   * 拾取协议：每个 frame 的 picker 都是独立本地实例，会话状态由 SW 协调。
   *
   * 之前 picker 只在主文档跑，iframe 内的 mousedown / keydown 根本不到主文档；
   * 改成每帧一份本地实例后：鼠标移到哪个 frame、那个 frame 的 ctrl+click/Esc 自然就响应。
   * 任一帧完成 → 该帧把 result 发给 SW → SW 广播 pick_end 给所有帧清理。
   *
   * SW → 多帧：chrome.runtime.sendMessage 在 content 里是 per-instance 广播，
   *   所有 frame 的 listener 都会收到，**不需要** chrome.tabs.sendMessage + frameId。
   */
  function frameKey() {
    return location.href || 'unknown';
  }

  function handleSWMessage(msg) {
    if (!msg || msg.__bb_picker !== true) return { accepted: false, reason: '消息不是拾取指令' };
    const t = msg.type;

    if (t === 'pick_start') {
      if (session && session.id === msg.sessionId) {
        return { accepted: true, deduped: true, frame: frameKey() };
      }
      if (session) {
        // 本帧已被别的会话占着（agent 二次发起 / 跨标签串号），不覆盖
        return { accepted: false, reason: '本帧已有拾取会话在进行中', frame: frameKey() };
      }
      const r = start(
        Object.assign({}, msg.args || {}, {
          sessionId: msg.sessionId,
          // 把 manual 透传到 session：手动发起的拾取，结果无人接会落盘
          manual: !!(msg.args && msg.args.manual),
          // 记录发起方，方便日志与排查
          origin: msg.origin || 'sw'
        })
      );
      return { accepted: !!(r && r.started), frame: frameKey(), sessionId: r.sessionId };
    }

    if (t === 'pick_end') {
      if (!session) return { accepted: true, idle: true, frame: frameKey() };
      if (msg.sessionId && session.id !== msg.sessionId) {
        return { accepted: false, reason: 'sessionId 不匹配', frame: frameKey() };
      }
      // silent: true = SW 主动收尾，不要再发 __bb_pick_result —— 该回的结果早就回了
      cancel(msg.reason || 'SW 主动收尾', { silent: true });
      return { accepted: true, frame: frameKey() };
    }

    if (t === 'pick_query') {
      return {
        accepted: true,
        active: !!session,
        sessionId: session ? session.id : null,
        frame: frameKey()
      };
    }

    return { accepted: false, reason: '未知的协议类型：' + t, frame: frameKey() };
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.__bb_picker !== true) return false;
      let r;
      try {
        r = handleSWMessage(msg);
      } catch (e) {
        r = { accepted: false, error: String((e && e.message) || e) };
      }
      sendResponse(r);
      return false; // 同步响应即可
    });
  }

  // ───────────────────────── 导出 ─────────────────────────

  RK.picker = {
    start: start,
    cancel: cancel,
    active: active,
    /** 当前会话的快照（面板/诊断用） */
    state: function () {
      if (!session) return { active: false };
      return {
        active: true,
        sessionId: session.id,
        anchor: session.anchor,
        multi: session.multi,
        picked: session.picked.length,
        target: session.target ? RK.adapter.describe(session.target) : null,
        preview: session.preview && session.preview.summary ? session.preview.summary : null
      };
    },
    /** SW 协议入口（仅 SW 通过 chrome.runtime.sendMessage 调用，正常人不直接用） */
    _handleSW: handleSWMessage
  };

  RK.__pickerLoaded = true;
})();
