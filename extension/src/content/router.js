/**
 * Browser Bridge · content 消息路由（**每一帧各跑一份**）
 *
 * 【为什么它必须独立于 main.js —— v1.3.1 修的架构缺陷】
 *   v1.3.0 把 content_scripts 拆成 5 组时，把「消息路由」留在了 main.js 里，
 *   而 main.js 所在的组是 all_frames:false（面板只该挂在主文档）。
 *   于是 iframe 里注入了 config / adapter / locator / actions / picker，
 *   却**没有任何 chrome.runtime.onMessage 监听器** —— 后果是整片 iframe 不可用：
 *     · frames 探针里每个 iframe 都报 injected:false（ping 没人接）
 *     · query / click / type / read 一旦落到 iframe，SW 补注入后仍收不到回执，
 *       报"content script 注入后无响应"
 *     · 千牛 / 生意参谋这类把登录框放进跨域 iframe 的后台，等于完全无法操作
 *   路由必须和共享基础层一样 all_frames:true —— 谁要被执行，谁就得有耳朵。
 *
 * 【本文件的职责】
 *   1) MAP：SW 发来的动作名 -> RK.actions / RK.adapter / RK.picker 里的实现
 *   2) onMessage：唯一的收件口，把结果（或错误）回给 SW
 *   3) Alt+Shift+A 手动拾取快捷键 —— **必须每帧注册**：
 *      焦点在 iframe 里时（登录框正是如此）主文档收不到 keydown，
 *      每帧各一份，只有焦点所在帧会触发，不会重复
 *
 * 【幂等】
 *   扩展更新后 SW 会用 chrome.scripting.executeScript 往老页面补注入，
 *   不幂等就会把监听器注册两遍 -> 同一条指令执行两次（"点一下变两下"）。
 *   故用 __BB_ROUTER_LOADED__ 挡住。
 */


(function () {
  'use strict';

  if (window.__BB_ROUTER_LOADED__) return;

  const RK = window.RK;
  if (!RK || !RK.actions || !RK.adapter) {
    // config/adapter/actions 任一没加载成功，后续全部无从谈起。
    //
    // 【为什么这里 return 之前绝不能置位】
    //   若先把 __BB_ROUTER_LOADED__ 置成 true 再检查，这一次"基础层尚未就绪"
    //   就会被记成"路由已建好"，此后无论补注入多少次，都被开头那行挡住 ——
    //   路由永久缺失。症状是"元素定位得出来、指令却送不进去"，极难查。
    //   不置位则每次注入都重试一次，代价只是多跑几行判断。
    return;
  }

  window.__BB_ROUTER_LOADED__ = true;

  let panelVisible = true;

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  }

  /**
   * 解析定位表达式里的「锚点后缀」语法：
   *
   *   "#nc_1_n1t>>right"     该元素的右边缘
   *   "#nc_1_n1t>>right:6"   右边缘再往里 6px
   *   ".list>>bottom"        列表底部
   *   "#btn"                 无后缀 = 默认取中心
   *
   * 【为什么需要它】
   *   默认取元素中心，这对"点一下"够用；但拖拽类场景的目标点常常是某个容器的边缘 ——
   *   最典型的就是滑块验证码：必须把滑块拖到**轨道最右端**，拖到中心点等于没拖。
   *   用后缀表达，就不用为此给上层工具再开一堆坐标参数。
   *
   * 分隔符选 ">>" 是因为它在 CSS 选择器和 XPath 里都不合法，不会与正常选择器冲突。
   */
  function splitAnchor(spec) {
    if (typeof spec !== 'string') return { selector: spec, anchor: null, inset: null };
    const m = spec.match(/^(.*?)>>(left|right|top|bottom|center)(?::(\d+(?:\.\d+)?))?\s*$/i);
    if (!m) return { selector: spec, anchor: null, inset: null };
    return {
      selector: m[1],
      anchor: m[2].toLowerCase(),
      inset: m[3] != null ? Number(m[3]) : null
    };
  }

  function setPanelVisible(v) {
    panelVisible = v !== false;
    const host = document.getElementById('__bb_panel_host__');
    if (host) host.style.display = panelVisible ? '' : 'none';
    return panelVisible;
  }

  // ───────────────────────── 动作表 ─────────────────────────

  const MAP = {
    // 连通性探针：SW 用它判断 content script 是否已在位
    ping: function () {
      return {
        pong: true,
        url: location.href,
        title: document.title,
        version: RK.VERSION,
        frame: window.top === window ? 'top' : 'iframe'
      };
    },

    metrics: function () {
      return RK.actions.metrics();
    },

    page_text: function (a) {
      return RK.actions.pageText(a);
    },

    query: function (a) {
      return RK.actions.query(a.target, a);
    },

    element_at: function (a) {
      return RK.actions.elementAt(a.x, a.y);
    },

    /** 给增强档用：报本帧的屏幕基准，用于跨 iframe 坐标换算 */
    probe_origin: function () {
      return RK.actions.originProbe();
    },

    /** 给增强档用：列出本文档所有 iframe 矩形，用于换算结果的安全校验 */
    list_iframes: function () {
      return RK.actions.listIframes();
    },

    click: function (a) {
      return RK.actions.click(a.target, a);
    },

    hover: function (a) {
      return RK.actions.hover(a.target, a);
    },

    type: function (a) {
      return RK.actions.type(a.target, a.text, a);
    },

    press: function (a) {
      return RK.actions.press(a.target, a.key, a);
    },

    scroll: function (a) {
      return RK.actions.scroll(a);
    },

    scroll_to_y: function (a) {
      return RK.actions.scrollToY(a.y);
    },

    drag: function (a) {
      return RK.actions.drag(a.from, a.to, a);
    },

    get_text: function (a) {
      return RK.actions.getText(a.target, a);
    },

    get_html: function (a) {
      return RK.actions.getHtml(a.target, a);
    },

    get_value: function (a) {
      return RK.actions.getValue(a.target, a);
    },

    wait_for: function (a) {
      return RK.actions.waitFor(a.target, a);
    },

    /** 给增强档用：只求坐标，不派发事件。支持 >>left|right|top|bottom 锚点后缀 */
    resolve_point: function (a) {
      const parsed = splitAnchor(a.target);
      const el = RK.adapter.resolve(parsed.selector, a);
      RK.actions.ensureInView(el); // 作用：滚进视口；返回值是中心点，锚点场景不用它
      const r = el.getBoundingClientRect();
      const inset = parsed.inset == null ? 1 : parsed.inset;
      let x = r.left + r.width / 2;
      let y = r.top + r.height / 2;
      if (parsed.anchor === 'left') x = r.left + inset;
      else if (parsed.anchor === 'right') x = r.left + r.width - inset;
      else if (parsed.anchor === 'top') y = r.top + inset;
      else if (parsed.anchor === 'bottom') y = r.top + r.height - inset;
      return {
        x: Math.round(x),
        y: Math.round(y),
        rect: rectOf(el),
        anchor: parsed.anchor || 'center',
        el: RK.adapter.describe(el)
      };
    },

    query_one_rect: function (a) {
      const el = RK.adapter.resolve(a.target, a);
      return { rect: rectOf(el), el: RK.adapter.describe(el) };
    },

    /**
     * 把页面上某个元素（用选择器定位）转成**可复用的定位描述符**。
     *
     * 存在的意义：选择器改版即归零，描述符（多属性加权打分）才扛得住改版。
     * 但描述符必须在页面里对着真实元素生成，所以这活儿只能 content 层干 ——
     * 服务端的元素库落盘就靠它把"选择器"升级成"描述符"。
     */
    describe: function (a) {
      const el = RK.adapter.resolve(a.target, a);
      if (!RK.locator || !RK.locator.buildFrom) {
        throw new Error('locator 未加载，无法生成描述符（脚本未注入或版本不匹配，刷新页面后重试）');
      }
      const built = RK.locator.buildFrom(el, a || {});
      return {
        matched: 1,
        descriptor: built.descriptor,
        quality: built.quality,
        summary: built.summary,
        dropped: built.dropped,
        rect: rectOf(el),
        el: RK.adapter.describe(el)
      };
    },

    /**
     * 按描述符定位，**只报告结果、不派发任何事件**。
     *
     * 【为什么要有这一步】
     *   打分定位给出的是"最像的那个"，而不是"一定是那个"。把分数、次高分、
     *   未命中属性一并报出来，agent 才有依据判断"这次定位可不可信"。
     *   先 find 确认、再 click 动手，比直接点完发现点错要省事得多。
     */
    find: function (a) {
      const desc = a.descriptor || a.target;

      if (RK.adapter.isDescriptor(desc)) {
        const r = RK.adapter.resolveDesc(desc, a);
        const out = {
          matched: 1,
          via: 'descriptor',
          score: r.score,
          coverage: r.coverage,
          runnerUp: r.runnerUp,
          candidateCount: r.candidateCount,
          hits: r.hits,
          misses: r.misses,
          rect: rectOf(r.el),
          el: RK.adapter.describe(r.el)
        };
        // 需要排查"为什么是这个"时，把前几个候选一并带回去
        if (a.withCandidates && RK.locator) out.candidates = RK.locator.rank(desc, a);
        return out;
      }

      // 选择器写法照样能走这个动作，语义与 query_one_rect 一致（方便统一入口）
      const el = RK.adapter.resolve(desc, a);
      return { matched: 1, via: 'selector', rect: rectOf(el), el: RK.adapter.describe(el) };
    },

    /** 进入拾取模式：人点一下，回一个可复用的元素描述符（详见 picker.js） */
    pick_start: function (a) {
      if (!RK.picker) {
        throw new Error('拾取器未加载（脚本未注入或 locator 缺失），请刷新页面后重试');
      }
      return RK.picker.start(a || {});
    },

    /**
     * 上层主动收掉拾取会话（超时、或新的拾取请求把它替换掉了）。
     * silent=true：这类收尾不需要页面再回传结果 —— 上层该给的拒绝已经给出去了，
     * 迟到的结果只会落在空处。用户自己按 Esc / 右键取消走的是 picker 内部路径，
     * 那条**必须**回传（见 picker.js 的 cancel）。
     */
    pick_cancel: function (a) {
      if (!RK.picker) return { cancelled: false, reason: '拾取器未加载' };
      return RK.picker.cancel((a && a.reason) || '上层主动取消', { silent: !(a && a.notify) });
    },

    pick_state: function () {
      if (!RK.picker) return { active: false, reason: '拾取器未加载' };
      return RK.picker.state();
    },

    panel_visible: function (a) {
      return { visible: setPanelVisible(a.visible !== false) };
    },

    panel_state: function (a) {
      if (RK.panel) RK.panel.setState(a || {});
      return { ok: true };
    },

    set_debug: function (a) {
      RK.debug = !!a.debug;
      return { debug: RK.debug };
    }
  };

  // ───────────────────────── 消息通道 ─────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // 只处理发给 content 的指令；面板消息与抓包批次走另一条路
    if (!msg || !msg.__bb) return false;
    if (msg.__bb_panel || msg.__bb_net_batch) return false;

    const fn = MAP[msg.action];
    if (!fn) {
      sendResponse({ ok: false, error: 'content 未知动作：' + msg.action });
      return false;
    }

    try {
      const out = fn(msg.args || {});
      if (out && typeof out.then === 'function') {
        out
          .then(function (data) {
            sendResponse({ ok: true, data: data });
          })
          .catch(function (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          });
        return true; // 保持通道打开，等异步动作回填
      }
      sendResponse({ ok: true, data: out });
      return false;
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
      return false;
    }
  });

  // ───────────────────────── 手动拾取快捷键 ─────────────────────────

  /**
   * 快捷键：进入/结束手动拾取。
   *
   * 【为什么是 Alt+Shift+A 而不是更顺手的 Alt+Shift+P】
   *   实测 Alt+Shift+P 在千牛等客户端里已经被占用（系统/宿主热键优先级高于页面）。
   *   网页永远抢不过宿主客户端的热键，所以只能避让 —— 换一个冷门组合。
   *   **它仍然可能在某些环境冲突**，所以面板上的「拾取元素」按钮是等价入口：
   *   快捷键用不了就用按钮，不必为此重装或改代码。
   *
   * 【为什么要有这个入口】
   *   browser_pick 是 agent 发起的，人只是被动配合点一下。但真实场景里常常反过来：
   *   人先浏览页面、把要操作的几个元素挨个点出来攒着，过一会儿再让 agent 来干活。
   *   没有这个入口，就只能让 agent 一直占着一次调用等着人点，既不自然也浪费一轮往返。
   *
   * 【默认 multi=true 的理由】
   *   手动拾取的价值就在"攒一批"：单个元素临时点一下也就够了，真值得开快捷键的
   *   是一次性把页面上五六个目标全圈出来。按 Esc 一次性交回。
   *   想要单个也能用：拾取完直接按 Esc，效果一样。
   *
   * 【结果去哪了】
   *   手动拾取没有 pendingPick 接，service worker 会把它们落进 chrome.storage.local，
   *   agent 之后用 browser_picks 取走。再按一次同一个快捷键 = 收工。
   */
  function toggleManualPick() {
    // 已经在拾取中 → 再按一次就是收工（multi 模式下已拾取的元素会被一并交回）
    if (RK.picker && RK.picker.active()) {
      RK.picker.cancel('手动收工', { silent: false });
      return;
    }

    /**
     * 【为什么不在这里直接 RK.picker.start】
     *   两个原因，都是实测踩出来的：
     *   ① 键盘焦点在 iframe 里时（千牛登录框正是如此），主文档的 keydown 收不到，
     *      只在本帧起会话的话，别的帧里根本没有拾取器 —— 必须让 SW 去起跨帧会话；
     *   ② 手动拾取的结果要落盘给 browser_picks 取用，这件事只能由 SW 做。
     *   所以这里只是"按了个键"，真正的活交给 SW 的 handlePanel('pick')。
     */
    try {
      chrome.runtime.sendMessage({ __bb_panel: true, action: 'pick' }, function (r) {
        void chrome.runtime.lastError;
        if (!r || !r.ok) RK.warn('手动拾取未能开始：', (r && r.error) || '无响应');
      });
    } catch (e) {
      RK.warn('手动拾取启动失败：', e);
    }
  }

  // 所有帧都注册：焦点在 iframe 里时（登录框常在这种帧里），
  // 只有那个 iframe 的 window 能收到 keydown。只有焦点所在帧会触发，不会重复。
  window.addEventListener(
    'keydown',
    function (e) {
      if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        toggleManualPick();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
})();
