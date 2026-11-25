/**
 * Browser Bridge · 动作层（actions）
 *
 * 【本文件解决的核心问题：为什么自己 dispatch 的事件页面不认？】
 *   绝大多数站点在 document / body 上用事件委托（React 的合成事件系统就挂在 root 容器上），
 *   所以 dispatch 到「最内层真实元素」并让事件冒泡上去，是能触发的。
 *   但有两类必须注意：
 *     1) 只监听 pointer* 的库（拖拽库居多）—— 必须补 PointerEvent，不能只发 MouseEvent；
 *     2) 用 isTrusted 做风控的站点 —— 合成事件 isTrusted 永远是 false，此类场景请切「增强档」
 *        （chrome.debugger 走 CDP，事件是浏览器底层产生的，isTrusted 为 true）。
 *
 * 【为什么改 input.value 之后 React 不认？】
 *   React 在 root 上代理 onInput，并且用「原生 value setter」来追踪值是否变化以去重。
 *   直接 `el.value = 'x'` 会绕过追踪，React 认为值没变、不触发 onChange。
 *   所以本文件用两条路：
 *     ① document.execCommand('insertText') —— 浏览器原生插入，能自然触发 beforeinput/input；
 *     ② 原生 setter + 手动派发 InputEvent —— ① 失效时的兜底。
 */
(function () {
  'use strict';

  if (!window.RK || !window.RK.adapter || window.RK.__actionsLoaded) return;
  const RK = window.RK;
  const A = RK.adapter;
  const sleep = RK.sleep;

  const hasPointer = typeof window.PointerEvent === 'function';

  // ───────────────────────── 底层事件构造与派发 ─────────────────────────

  function pointerInit(type, pt, extra) {
    extra = extra || {};
    return Object.assign(
      {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: extra.detail != null ? extra.detail : 1,
        screenX: pt.x,
        screenY: pt.y,
        clientX: pt.x,
        clientY: pt.y,
        ctrlKey: !!extra.ctrlKey,
        shiftKey: !!extra.shiftKey,
        altKey: !!extra.altKey,
        metaKey: !!extra.metaKey,
        button: extra.button != null ? extra.button : 0,
        buttons: extra.buttons != null ? extra.buttons : 1
      },
      extra.pointer === false
        ? {}
        : {
            pointerId: extra.pointerId != null ? extra.pointerId : 1,
            pointerType: extra.pointerType || 'mouse',
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: extra.buttons ? (extra.pressure != null ? extra.pressure : 0.5) : 0,
            tangentialPressure: 0,
            tiltX: 0,
            tiltY: 0,
            twist: 0
          }
    );
  }

  /**
   * 派发一对事件：Pointer 版 + Mouse 版。
   * 只发 Mouse 会漏掉只监听 pointer* 的库；只发 Pointer 会漏掉老代码里的 onmousedown。
   */
  function fire(el, base, pt, extra) {
    const init = pointerInit(base, pt, extra);
    if (hasPointer) {
      try {
        el.dispatchEvent(new PointerEvent('pointer' + base, init));
      } catch (e) {
        /* 某些环境构造 PointerEvent 会抛，忽略 */
      }
    }
    try {
      el.dispatchEvent(new MouseEvent('mouse' + base, init));
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 只发指针事件（没有 mouse 对应物，如 pointercancel） */
  function firePointerOnly(el, type, pt, extra) {
    if (!hasPointer) return;
    try {
      el.dispatchEvent(new PointerEvent(type, pointerInit(type.replace('pointer', ''), pt, extra)));
    } catch (e) {
      /* 忽略 */
    }
  }

  // ───────────────────────── 视口与坐标 ─────────────────────────

  /** 把元素滚进视口中央（已在视口内则不动），返回滚动后的视口中心点 */
  function ensureInView(el, margin) {
    margin = margin || 8;
    const r = el.getBoundingClientRect();
    const out =
      r.top < margin || r.left < margin || r.bottom > innerHeight - margin || r.right > innerWidth - margin;
    if (out) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (e) {
        try {
          el.scrollIntoView();
        } catch (e2) {
          /* 忽略 */
        }
      }
    }
    return A.center(el);
  }

  /**
   * 检查目标点上真正躺着的是不是我们要点的元素。
   * 命中被遮罩层/弹窗挡住是最常见的「点了毫无反应」根因，提前说出来比让 agent 瞎试强。
   */
  function obstruction(el, pt) {
    const top = A.deepElementFromPoint(pt.x, pt.y);
    if (!top) return { blocked: true, by: '坐标处无元素' };
    if (top === el || el.contains(top) || top.contains(el)) return { blocked: false };
    return {
      blocked: true,
      by: top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + ' ' + A.ownText(top).slice(0, 40)
    };
  }

  // ───────────────────────── 基础动作 ─────────────────────────

  /**
   * 点击。target 可以是定位表达式，也可以直接给 x/y 坐标。
   * opts: { x, y, index, clickCount, button, holdMs, deep, visible }
   */
  async function click(target, opts) {
    opts = opts || {};
    const holdMs = opts.holdMs != null ? opts.holdMs : RK.DEFAULTS.clickHoldMs;
    const count = opts.clickCount || 1;

    let el;
    let pt;

    if (opts.x != null && opts.y != null) {
      pt = { x: Math.round(Number(opts.x)), y: Math.round(Number(opts.y)) };
      el = A.deepElementFromPoint(pt.x, pt.y);
      if (!el) throw new Error('坐标 (' + pt.x + ',' + pt.y + ') 处没有元素');
    } else {
      el = A.resolve(target, opts);
      pt = ensureInView(el);
    }

    const block = obstruction(el, pt);

    // 悬浮（hover）先行 —— 很多下拉菜单必须先 mouseover 才把真正可点的项渲染出来
    fire(el, 'over', pt, { buttons: 0 });
    firePointerOnly(el, 'pointerenter', pt, { buttons: 0 });
    fire(el, 'move', pt, { buttons: 0 });
    try {
      el.dispatchEvent(new MouseEvent('mouseenter', pointerInit('', pt, { buttons: 0 })));
    } catch (e) {
      /* 忽略 */
    }
    await sleep(12);

    for (let c = 1; c <= count; c++) {
      fire(el, 'down', pt, { buttons: 1, detail: c });
      firePointerOnly(el, 'pointerenter', pt, { buttons: 1 });
      try {
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      } catch (e) {
        /* 忽略 */
      }
      await sleep(holdMs);
      fire(el, 'up', pt, { buttons: 0, detail: c });
      try {
        el.dispatchEvent(new MouseEvent('click', pointerInit('', pt, { buttons: 0, detail: c })));
      } catch (e) {
        /* 忽略 */
      }
      if (c < count) await sleep(60);
    }

    // 双击后补 dblclick（部分库监听它）
    if (count === 2) {
      try {
        el.dispatchEvent(new MouseEvent('dblclick', pointerInit('', pt, { buttons: 0, detail: 2 })));
      } catch (e) {
        /* 忽略 */
      }
    }

    return {
      clicked: A.describe(el),
      at: pt,
      clickCount: count,
      trust: 'synthetic',
      warning: block.blocked
        ? '目标中心被其它元素遮挡（' + block.by + '），事件仍已派发，但可能不生效；如需真实点击请切「增强档」'
        : undefined
    };
  }

  /** 鼠标悬停（只移动，不按） */
  async function hover(target, opts) {
    opts = opts || {};
    let el;
    let pt;
    if (opts.x != null && opts.y != null) {
      pt = { x: Math.round(Number(opts.x)), y: Math.round(Number(opts.y)) };
      el = A.deepElementFromPoint(pt.x, pt.y);
    } else {
      el = A.resolve(target, opts);
      pt = ensureInView(el);
    }
    if (!el) throw new Error('悬停坐标处没有元素');

    fire(el, 'over', pt, { buttons: 0 });
    firePointerOnly(el, 'pointerenter', pt, { buttons: 0 });
    fire(el, 'move', pt, { buttons: 0 });
    return { hovered: A.describe(el), at: pt };
  }

  // ───────────────────────── 输入 ─────────────────────────

  /** 用原生 setter 写值，再手动派发 input —— React 受控组件的兜底通道 */
  function setNativeValue(el, value) {
    const tag = el.tagName;
    let proto = null;
    if (tag === 'INPUT') proto = window.HTMLInputElement.prototype;
    else if (tag === 'TEXTAREA') proto = window.HTMLTextAreaElement.prototype;

    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, value);
        return true;
      }
    }
    try {
      el.value = value;
      return true;
    } catch (e) {
      return false;
    }
  }

  function fireInput(el, data, inputType) {
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          data: data,
          inputType: inputType || 'insertText'
        })
      );
    } catch (e) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function fireChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 清空输入框 */
  function clearField(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      try {
        if (typeof el.select === 'function') el.select();
        const ok = document.execCommand('delete', false, null);
        if (!ok || el.value) {
          setNativeValue(el, '');
          fireInput(el, '', 'deleteContentBackward');
        }
      } catch (e) {
        setNativeValue(el, '');
        fireInput(el, '', 'deleteContentBackward');
      }
    } else if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      } catch (e) {
        el.textContent = '';
        fireInput(el, '', 'deleteContentBackward');
      }
    }
  }

  /** 往 contenteditable 里插文本 */
  function insertIntoEditable(el, text) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return document.execCommand('insertText', false, text);
    } catch (e) {
      return false;
    }
  }

  /**
   * 输入文本。
   * opts: { delayMs, clear, pressEnter, index }
   *   delayMs = 0  一次性插入（快，绝大多数场景够用）
   *   delayMs > 0  逐字符插入（慢，但对按键频率做校验的站点更稳）
   */
  async function type(target, text, opts) {
    opts = opts || {};
    const value = String(text == null ? '' : text);
    const delay = opts.delayMs != null ? Number(opts.delayMs) : 0;

    const el = A.resolve(target, opts);
    ensureInView(el);

    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch (e) {
      /* 忽略 */
    }
    // 有些框架靠 mousedown 才进入编辑态
    const pt = A.center(el);
    fire(el, 'down', pt, { buttons: 1 });
    fire(el, 'up', pt, { buttons: 0 });
    await sleep(20);

    const isEditable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    if (!isEditable) {
      throw new Error('目标不可输入：' + el.tagName.toLowerCase() + '（需要 input / textarea / contenteditable）');
    }

    if (opts.clear !== false) clearField(el);

    let method = 'execCommand';

    if (delay > 0) {
      for (let i = 0; i < value.length; i++) {
        const ch = value.charAt(i);
        let ok = false;
        try {
          ok = document.execCommand('insertText', false, ch);
        } catch (e) {
          ok = false;
        }
        if (!ok && el.isContentEditable) ok = insertIntoEditable(el, ch);
        if (!ok) {
          method = 'nativeSetter';
          if (el.isContentEditable) el.textContent = (el.textContent || '') + ch;
          else setNativeValue(el, (el.value || '') + ch);
          fireInput(el, ch, 'insertText');
        }
        await sleep(delay);
      }
    } else {
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, value);
      } catch (e) {
        ok = false;
      }
      if (!ok && el.isContentEditable) ok = insertIntoEditable(el, value);
      if (!ok) {
        method = 'nativeSetter';
        if (el.isContentEditable) el.textContent = value;
        else setNativeValue(el, value);
        fireInput(el, value, 'insertText');
      }
    }

    fireChange(el);
    fireInput(el, null, 'insertText');

    if (opts.pressEnter) {
      await pressEnter(el);
    }

    const actual = el.isContentEditable ? el.textContent : el.value;
    return {
      target: A.describe(el),
      expected: value,
      // 回读实际值 —— 输入完不核对等于没输入，这是自动化最常见的事故来源
      actual: actual == null ? '' : String(actual).slice(0, 500),
      match: String(actual == null ? '' : actual) === value,
      method: method
    };
  }

  const KEY_CODES = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
  };

  /** 派发键盘事件（keydown / keypress / keyup） */
  function fireKey(el, name, extra) {
    const info = KEY_CODES[name] || { key: name, code: name, keyCode: 0 };
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.keyCode,
      ctrlKey: !!(extra && extra.ctrlKey),
      shiftKey: !!(extra && extra.shiftKey),
      altKey: !!(extra && extra.altKey),
      metaKey: !!(extra && extra.metaKey)
    };
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', base));
    } catch (e) {
      /* 忽略 */
    }
    if (info.text) {
      try {
        el.dispatchEvent(new KeyboardEvent('keypress', base));
      } catch (e) {
        /* 忽略 */
      }
    }
    try {
      el.dispatchEvent(new KeyboardEvent('keyup', base));
    } catch (e) {
      /* 忽略 */
    }
    return info;
  }

  async function pressEnter(el) {
    const info = fireKey(el, 'Enter');
    // 回车在表单里的副作用是 submit，这里补一次，避免依赖默认行为
    if (el.form && typeof el.form.requestSubmit === 'function') {
      try {
        el.form.requestSubmit();
      } catch (e) {
        /* 忽略 */
      }
    }
    await sleep(30);
    return info;
  }

  async function press(target, key, opts) {
    opts = opts || {};
    const el = target ? A.resolve(target, opts) : document.activeElement || document.body;
    if (target) ensureInView(el);
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch (e) {
      /* 忽略 */
    }
    const info = fireKey(el, key, opts);
    return { key: info.key, on: A.describe(el) };
  }

  // ───────────────────────── 滚动 ─────────────────────────

  async function scroll(opts) {
    opts = opts || {};

    if (opts.target) {
      const el = A.resolve(opts.target, opts);
      try {
        el.scrollIntoView({
          block: opts.block || 'center',
          inline: opts.inline || 'nearest',
          behavior: opts.smooth ? 'smooth' : 'instant'
        });
      } catch (e) {
        el.scrollIntoView();
      }
      await sleep(opts.smooth ? 500 : 60);
      return { scrolledTo: A.describe(el), ...metrics() };
    }

    if (opts.selector) {
      const box = A.resolve(opts.selector, opts);
      box.scrollTop = opts.top != null ? Number(opts.top) : box.scrollTop + (opts.dy || 0);
      box.scrollLeft = opts.left != null ? Number(opts.left) : box.scrollLeft + (opts.dx || 0);
      await sleep(60);
      return { container: A.describe(box), scrollTop: box.scrollTop, scrollLeft: box.scrollLeft };
    }

    if (opts.y != null || opts.x != null) {
      window.scrollTo({
        top: opts.y != null ? Number(opts.y) : window.scrollY,
        left: opts.x != null ? Number(opts.x) : window.scrollX,
        behavior: opts.smooth ? 'smooth' : 'instant'
      });
      if (opts.y == null) {
        window.scrollBy({
          top: opts.dy || 0,
          left: 0,
          behavior: opts.smooth ? 'smooth' : 'instant'
        });
      }
    } else {
      window.scrollBy({
        top: opts.dy || 0,
        left: opts.dx || 0,
        behavior: opts.smooth ? 'smooth' : 'instant'
      });
    }

    await sleep(opts.smooth ? 500 : 60);
    return metrics();
  }

  /** 直接定位到某个滚动位置（整页截图专用，不做平滑动画） */
  async function scrollToY(y) {
    // 临时关掉平滑滚动，否则截图会拍到"正在滚动中"的中间态
    const de = document.documentElement;
    const prev = de.style.scrollBehavior;
    try {
      de.style.scrollBehavior = 'auto';
      window.scrollTo(0, Math.round(y));
      await sleep(40);
      return { scrollY: Math.round(window.scrollY), scrollX: Math.round(window.scrollX) };
    } finally {
      de.style.scrollBehavior = prev || '';
    }
  }

  // ───────────────────────── 拖拽 ─────────────────────────

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /** 生成一条带缓动 + 轻微抖动的轨迹，避免"完美直线"被行为风控识别 */
  function trajectory(from, to, steps, jitter) {
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = easeInOutCubic(i / steps);
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const j = jitter == null ? 1.2 : jitter;
      pts.push({
        x: Math.round(x + (Math.random() - 0.5) * j),
        y: Math.round(y + (Math.random() - 0.5) * j)
      });
    }
    pts[pts.length - 1] = { x: Math.round(to.x), y: Math.round(to.y) };
    return pts;
  }

  function pointOf(spec) {
    if (spec == null) throw new Error('拖拽端点不能为空');
    if (typeof spec === 'object' && spec.x != null && spec.y != null) {
      return { x: Math.round(Number(spec.x)), y: Math.round(Number(spec.y)) };
    }
    if (typeof spec === 'string') {
      const el = A.resolve(spec, {});
      return ensureInView(el);
    }
    throw new Error('无法解析拖拽端点：' + JSON.stringify(spec));
  }

  /**
   * 拖拽。
   * mode = 'pointer'（默认）：pointerdown → 一串 pointermove → pointerup
   *        适合绝大多数自研拖拽（sortable / 自定义 div 拖动）
   * mode = 'html5'：dragstart / dragenter / dragover / drop
   *        适合用了 HTML5 Drag and Drop API 的场景（老式上传区、文件排序）
   *
   * 注：若目标用 setPointerCapture 强绑定，或做了 isTrusted 校验，合成事件可能不生效 —— 切增强档走 CDP。
   */
  async function drag(fromSpec, toSpec, opts) {
    opts = opts || {};
    const mode = opts.mode || 'pointer';
    const steps = opts.steps || RK.DEFAULTS.dragSteps;
    const stepMs = opts.stepMs != null ? opts.stepMs : RK.DEFAULTS.dragStepMs;

    const from = pointOf(fromSpec);
    const to = pointOf(toSpec);

    const srcEl = A.deepElementFromPoint(from.x, from.y);
    const dstEl = A.deepElementFromPoint(to.x, to.y) || srcEl || document.body;

    if (mode === 'html5') {
      return dragHtml5(srcEl, dstEl, from, to);
    }

    const dragTarget = srcEl || document.body;

    fire(dragTarget, 'over', from, { buttons: 0 });
    fire(dragTarget, 'move', from, { buttons: 0 });
    fire(dragTarget, 'down', from, { buttons: 1 });
    firePointerOnly(dragTarget, 'pointerenter', from, { buttons: 1 });
    await sleep(30);

    const pts = trajectory(from, to, steps, opts.jitter);
    for (let i = 0; i < pts.length; i++) {
      // 派发到起始元素上并让它冒泡到 document —— 拖拽库绝大多数把 move 挂在 document 上
      fire(dragTarget, 'move', pts[i], { buttons: 1 });
      await sleep(stepMs);
    }

    await sleep(40);
    // 抬起派发到终点元素，这样目标区域的 mouseup 监听器也能收到
    fire(dstEl, 'up', to, { buttons: 0 });
    try {
      dstEl.dispatchEvent(new MouseEvent('click', pointerInit('', to, { buttons: 0 })));
    } catch (e) {
      /* 忽略 */
    }

    return {
      mode: mode,
      from: from,
      to: to,
      steps: pts.length,
      source: srcEl ? A.describe(srcEl) : null,
      target: dstEl ? A.describe(dstEl) : null,
      trust: 'synthetic'
    };
  }

  async function dragHtml5(srcEl, dstEl, from, to) {
    let dt;
    try {
      dt = new DataTransfer();
    } catch (e) {
      dt = null;
    }
    const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };

    function fireDrag(el, type, pt) {
      const init = Object.assign({}, opts, {
        clientX: pt.x,
        clientY: pt.y,
        screenX: pt.x,
        screenY: pt.y
      });
      try {
        el.dispatchEvent(new DragEvent(type, init));
      } catch (e) {
        /* 忽略 */
      }
    }

    fireDrag(srcEl, 'dragstart', from);
    await sleep(30);
    fireDrag(dstEl, 'dragenter', to);
    // dragover 必须被 preventDefault，否则浏览器认为该区域不接受放置，drop 不会触发
    fireDrag(dstEl, 'dragover', to);
    await sleep(60);
    fireDrag(dstEl, 'drop', to);
    fireDrag(srcEl, 'dragend', to);
    await sleep(30);

    return {
      mode: 'html5',
      from: from,
      to: to,
      source: srcEl ? A.describe(srcEl) : null,
      target: dstEl ? A.describe(dstEl) : null,
      trust: 'synthetic'
    };
  }

  // ───────────────────────── 查询与等待 ─────────────────────────

  function query(target, opts) {
    opts = opts || {};
    const all = A.resolveAll(target, Object.assign({}, opts, { all: true }));
    const limit = opts.limit || 50;
    return {
      count: all.length,
      total: all.length,
      elements: all.slice(0, limit).map(A.describe),
      truncated: all.length > limit
    };
  }

  function elementAt(x, y) {
    const el = A.deepElementFromPoint(Number(x), Number(y));
    return el ? A.describe(el) : null;
  }

  /**
   * 报告本帧的「坐标基准」。
   *
   * 【⚠ 已不再用于坐标换算（2026-10-14 真机实测结论）】
   *   Chrome 155 上，跨域 iframe 的 window.screenX / screenY 会被**对齐成与顶层相同**，
   *   相减恒为 0 —— 这套换算法在真实浏览器里根本不成立（当时靠安全校验兜住了，
   *   没有点错位置，但每次都退回合成事件，行为风控一律拦截）。
   *   现在换算改走「父帧读 iframe 元素矩形、沿父链逐层累加」，见 sw/commands.js 的
   *   frameOffsetChain()。本动作保留，仅作诊断用（能报出各帧的 screenX/outerWidth 等窗口属性）。
   *
   * 【为什么用 screenX/screenY，而不是 frameElement.getBoundingClientRect()】
   *   跨域 iframe 里读 window.frameElement 会抛 SecurityError —— 帧内脚本
   *   拿不到自己在父文档里的位置。但 window.screenX / screenY **不受同源策略限制**，
   *   它给出的是「本帧视口左上角相对屏幕」的坐标。
   *   于是：任意帧的 screenX − 顶层帧的 screenX = 该帧相对顶层视口的偏移。
   *
   *   三个附带好处：
   *     a) **多层嵌套不用逐层累加** —— 都是屏幕绝对坐标，直接相减就完了；
   *     b) **父文档滚动自动包含在内** —— screenX 反映的是此刻真实的屏幕位置，
   *        不需要再去找祖先链上每一个滚动容器的 scrollTop；
   *     c) 纯窗口属性，不碰任何跨域 DOM，零权限、零副作用。
   *
   * 【注意】CDP 的 Input.dispatchMouseEvent 坐标是「相对主 frame viewport 的 CSS 像素」，
   *   与 screenX 同一单位（CSS 像素），且同样不受页面滚动影响，所以相减后可直接使用。
   */
  function originProbe() {
    const isTop = window === window.top;
    return {
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio,
      isTop: isTop
    };
  }

  /**
   * 列出本文档里所有 iframe 元素的视口矩形。
   *
   * 用途：给跨帧坐标换算做**安全校验** —— 换算出来的点必须落在某个 iframe 的矩形内。
   * 因为目标帧的任何祖先都必然在主文档里，换算正确时这个条件一定成立；
   * 反之若落在主文档的空地上，说明偏移量算错了，必须拒绝（宁可退化成合成事件，
   * 也绝不能"点错位置"）。
   *
   * 关键：跨域 iframe 的**内容**读不到，但 iframe **元素本身**属于当前文档，
   * 它的 getBoundingClientRect() 完全可读 —— 这正是这个校验能成立的原因。
   */
  function listIframes() {
    const out = [];
    const all = document.querySelectorAll('iframe, frame');
    for (let i = 0; i < all.length && i < 60; i++) {
      const f = all[i];
      const r = f.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // 1×1 埋点 iframe 不参与
      out.push({
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        id: f.id || null,
        src: String(f.src || '').slice(0, 200)
      });
    }
    return { count: out.length, iframes: out };
  }

  function getText(target, opts) {
    const el = A.resolve(target, opts);
    return {
      text: A.ownText(el).slice(0, 20000),
      element: A.describe(el)
    };
  }

  function getHtml(target, opts) {
    opts = opts || {};
    const el = A.resolve(target, opts);
    const max = opts.maxChars || 30000;
    const html = el.outerHTML || '';
    return {
      html: html.length > max ? html.slice(0, max) + '\n<!-- 已截断 -->' : html,
      length: html.length,
      truncated: html.length > max
    };
  }

  /** 取输入框当前值（核对真相用，别信自己以为输入成功了） */
  function getValue(target, opts) {
    const el = A.resolve(target, opts);
    const v = el.isContentEditable ? el.textContent : el.value;
    return { value: v == null ? '' : String(v).slice(0, 2000), element: A.describe(el) };
  }

  async function waitFor(target, opts) {
    opts = opts || {};
    const timeout = opts.timeout || RK.DEFAULTS.timeout;
    const interval = opts.interval || 200;
    const want = opts.state || 'visible'; // visible | hidden | attached
    const deadline = Date.now() + timeout;
    let lastCount = -1;

    while (Date.now() < deadline) {
      let list = [];
      try {
        list = A.resolveAll(target, { visible: want === 'visible', all: true });
      } catch (e) {
        list = [];
      }
      lastCount = list.length;

      if (want === 'hidden' && list.length === 0) return { ok: true, waitedMs: timeout - (deadline - Date.now()) };
      if (want !== 'hidden' && list.length > 0) {
        return {
          ok: true,
          waitedMs: timeout - (deadline - Date.now()),
          element: A.describe(list[0])
        };
      }
      await sleep(interval);
    }

    throw new Error(
      '等待超时（' + timeout + 'ms）：' + target + ' 期望状态=' + want + '，实际命中 ' + lastCount + ' 个'
    );
  }

  // ───────────────────────── 页面信息 ─────────────────────────

  function metrics() {
    const de = document.documentElement;
    const body = document.body || de;
    return {
      url: location.href,
      title: document.title,
      pageWidth: Math.max(de.scrollWidth, body.scrollWidth, de.offsetWidth, body.offsetWidth),
      pageHeight: Math.max(de.scrollHeight, body.scrollHeight, de.offsetHeight, body.offsetHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      devicePixelRatio: window.devicePixelRatio || 1,
      readyState: document.readyState,
      hasShadowRoots: A.collectShadowRoots().length > 1
    };
  }

  /** 提取页面可读文本，供 agent 理解当前处在哪一步 */
  function pageText(opts) {
    opts = opts || {};
    const max = opts.maxChars || 12000;
    let text = '';
    try {
      text = (document.body && document.body.innerText) || '';
    } catch (e) {
      text = document.body ? document.body.textContent || '' : '';
    }
    text = RK.adapter.normText(text);
    return {
      text: text.length > max ? text.slice(0, max) : text,
      length: text.length,
      truncated: text.length > max,
      url: location.href,
      title: document.title
    };
  }

  A; // 保持引用，避免打包器误删

  RK.actions = {
    click: click,
    hover: hover,
    type: type,
    press: press,
    pressEnter: pressEnter,
    scroll: scroll,
    scrollToY: scrollToY,
    drag: drag,
    query: query,
    elementAt: elementAt,
    getText: getText,
    getHtml: getHtml,
    getValue: getValue,
    waitFor: waitFor,
    metrics: metrics,
    pageText: pageText,
    ensureInView: ensureInView,
    obstruction: obstruction,
    originProbe: originProbe,
    listIframes: listIframes
  };

  RK.__actionsLoaded = true;
})();
