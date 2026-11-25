/**
 * Browser Bridge · 主文档入口（面板挂载 + 保活）
 *
 * 【它只剩两件事】
 *   1) 挂 BB 面板球 —— 面板是页面级的视觉入口，只在主文档挂；
 *      挂进 iframe 会在那个小框里多冒出一个球，既没意义又挡内容
 *   2) 每 20 秒给 service worker 一个存活信号，避免 MV3 SW 在页面开着时被回收
 *
 * 【消息路由与拾取快捷键不在这里】（v1.3.1 搬家）
 *   它们已迁到 router.js（all_frames:true 注入）。
 *   iframe 里没有路由，SW 的指令就送不进去；焦点在 iframe 里时，快捷键也收不到。
 *   本文件因此不再需要 MAP / onMessage / keydown。
 */


(function () {
  'use strict';

  if (window.__BB_MAIN_LOADED__) return;

  const RK = window.RK;
  if (!RK || !RK.actions || !RK.adapter) {
    // config/adapter/actions 任一没加载成功，后续全部无从谈起。
    // 同 router.js：检查通过之前不置位，否则一次"基础层未就绪"会让面板永久挂不上。
    return;
  }

  window.__BB_MAIN_LOADED__ = true;

  // ───────────────────────── 保活 ─────────────────────────

  /**
   * 每 20 秒给 SW 一个"我还活着"的信号。
   * 这是让 MV3 service worker 在有页面打开期间不休眠的最廉价手段 ——
   * 比在 SW 里用 setInterval 靠谱（SW 一旦被回收，interval 也就没了）。
   * 只在页面可见时发，隐藏的标签页不参与，避免几十个后台页一起吵。
   *
   * 只在**顶层帧**发：一个页面上可能被注入好几个 iframe，每个都发就纯属刷屏了。
   * 顶层帧代表"这个标签页还开着"，语义上也更对。
   */
  if (window.top === window) {
    setInterval(function () {
      if (document.hidden) return;
      try {
        chrome.runtime.sendMessage({ __bb_keeplive: true }, function () {
          void chrome.runtime.lastError; // 读一下，否则控制台会有未处理告警
        });
      } catch (e) {
        /* 扩展上下文失效（重载/卸载），静默即可，刷新页面会恢复 */
      }
    }, 20000);
  }

  // ───────────────────────── 启动 ─────────────────────────

  function boot() {
    // 面板只挂顶层帧。iframe 里挂出来的小球会盖住那个小框的内容，而且毫无意义。
    // （SW 注入 iframe 时本来就不带 panel.js，这里是第二道保险。）
    const isTop = window.top === window;
    if (isTop) {
      try {
        if (RK.panel) RK.panel.mount();
      } catch (e) {
        RK.warn('面板挂载失败：', e);
      }
    }

    if (!isTop) return; // 非顶层帧不需要面板，也不需要拉连接状态

    // 挂载后主动拉一次真实状态：面板首次出现不该是"连接中…"的空白
    try {
      chrome.runtime.sendMessage({ __bb_panel: true, action: 'status' }, function (r) {
        if (chrome.runtime.lastError) return;
        if (r && r.ok && RK.panel && r.data) {
          RK.panel.setState({
            connected: r.data.connected,
            wsUrl: r.data.url,
            mode: r.data.mode,
            lenient: r.data.reason || undefined,
            recording: r.data.recording
          });
        }
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
