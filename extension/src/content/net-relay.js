/**
 * Browser Bridge · 网络探针转发器（net-relay）
 *
 * 【为什么需要这个中间人？】
 *   网络探针跑在页面主世界（MAIN world）才能 hook 到真实的 fetch/XHR，
 *   但主世界**拿不到任何 chrome.* API**。所以它只能把数据用
 *   window.postMessage 抛出来，再由隔离世界的本文件转交给 service worker。
 *
 * 【为什么要 all_frames: true？】
 *   大量业务系统把真正的数据请求发在 iframe 里（老式后台、嵌入的报表页）。
 *   只在主 frame 注入会漏掉一大半。本文件每个 frame 各跑一份，
 *   sendMessage 时 Chrome 会自动带上 sender.frameId，服务端能分辨来源。
 *
 * 【为什么批量转发而不是每条一次？】
 *   一个繁忙页面每秒可能发几十个请求，逐条 sendMessage 会把 SW 的消息队列挤爆
 *   （SW 还可能因此被频繁唤醒）。攒 40 条或 300ms 推一次，是延迟与开销的平衡点。
 *
 * 【注意】这里不做"是否在抓包"的判断 —— 判断放在 SW 里。
 *   这样切换抓包开关能立刻生效，不会出现"relay 的本地标志和 SW 状态不一致"的诡异 bug。
 */

(function () {
  'use strict';

  if (window.__BB_RELAY_LOADED__) return;
  window.__BB_RELAY_LOADED__ = true;

  const MAX_BODY = 20000;
  const FLUSH_AT = 40;
  const FLUSH_MS = 300;
  const MAX_QUEUE = 600; // 兜底上限，防止 SW 长时间不可达时内存无限增长

  const queue = [];
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;

    const batch = queue.splice(0, queue.length);
    try {
      chrome.runtime.sendMessage({ __bb_net_batch: batch }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 扩展上下文失效，直接丢弃这批，避免堆积 */
    }
  }

  window.addEventListener(
    'message',
    function (ev) {
      // 只认自己窗口的消息，别的 frame / 第三方脚本发的 postMessage 一律不理
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.__bb_net !== true || !d.payload) return;

      const p = d.payload;

      // 正文兜底截断（探针里已截过一次，这里防的是探针被页面改写的情况）
      if (typeof p.body === 'string' && p.body.length > MAX_BODY) {
        p.body = p.body.slice(0, MAX_BODY) + '…[已截断]';
      }

      queue.push(p);

      if (queue.length >= MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

      if (queue.length >= FLUSH_AT) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    },
    false
  );

  // 页面卸载前把尾巴推出去
  window.addEventListener('pagehide', flush, false);
})();
