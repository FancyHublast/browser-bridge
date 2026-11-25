/**
 * Browser Bridge · service worker 指令中枢
 *
 * ───────────────────────────────────────────────────────────────────────
 *  这个文件是整个插件的脑子。它做三件事：
 *    1. 维持一条到本地 MCP 服务的 WebSocket 长连接（自动重连 + 双向心跳）
 *    2. 把 MCP 服务下发的指令，路由到正确的执行者（自己 / content script / CDP）
 *    3. 管理状态（档位、抓包缓冲、连接状态），并同步给面板与弹窗
 *
 *  ── MV3 生死线：service worker 会被回收 ──
 *  这不只是"可能"，是常态：空闲约 30 秒就被杀，全局变量全部清零。
 *  应对策略（三保险）：
 *    a) chrome.alarms 每 30 秒唤醒一次，醒来第一件事就是 ensureWS()；
 *    b) 服务端每 20 秒发一次心跳，插件回 pong —— 消息处理会重置空闲计时器；
 *    c) content script 在页面可见时每 20 秒 ping 一次，等于让"有页面开着"期间的 SW 永不休眠。
 *
 *  ── 指令回执模型 ──
 *  请求 {id, cmd, args}，响应 {id, ok, data|error}。本地服务侧有超时兜底，
 *  插件侧也必须在传输层超时，否则一个卡死的页面会把整条链路堵住。
 * ───────────────────────────────────────────────────────────────────────
 */

import { Bridge } from './ws-client.js';
import { dispatch, resolvePick, storeManualPick, startPickSession } from './commands.js';
import { getState, patchState } from './state.js';
// contentCall = SW 往页面里发一个 content 动作的通道（带注入保障与扫帧）。
import { contentCall, CONTENT_FILES_MAIN, CONTENT_FILES_FRAME } from './tabs.js';

const bridge = new Bridge();

bridge.onStatus((st) => {
  broadcastPanel({
    connected: st.connected,
    wsUrl: st.url,
    lenient: st.reason || undefined,
    // 连接状态一变就把指引同步过去，不用等用户重新打开面板
    hint: st.connected ? undefined : notConnectedHint(st)
  });
});

// ───────────────────────── 生命周期 ─────────────────────────

/**
 * 扩展重载/更新后，把已经打开的页面换成新脚本。
 *
 * 【为什么必须做】
 *   content script 是"注入那一刻的代码快照"，重载扩展**不会**让页面里的旧实例更新。
 *   旧实例这时已经成了孤儿：chrome.* 调用全部抛 "Extension context invalidated"，
 *   可它注册的事件监听和挂在页面上的 DOM 都还在。
 *
 *   典型症状（本次真机上全部命中）：
 *     · 页面上出现两个 BB 球，点哪个都没反应；
 *     · Alt+Shift+A 快捷键失灵 —— 按下去的是旧实例，它发消息的那条路已经断了；
 *     · iframe 里拾取不到元素，因为旧世界的 iframe 里压根没有 router.js 收件口。
 *   而用户完全想不到"原来还要去按一下 F5"。
 *   与其把这条写进说明书指望人记住，不如自己补一次：注入即接管。
 *
 * 【幂等性】每个 content 文件开头都有 __BB_xxx_LOADED__ 守卫，
 * 重复注入只是空跑几行判断，不会有副作用。
 * 而重载扩展后新隔离世界的守卫变量是空的，所以新代码一定会真正跑起来。
 */
async function reinjectOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (e) {
    return;
  }

  for (const t of tabs) {
    if (t.id == null) continue;

    // 帧树拿不到（页面正在跳转）就只处理主文档 —— 不能因此整页跳过
    let ids = [0];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
      if (frames && frames.length) {
        // 限个上限：埋点多的页面动辄几十个 iframe，一次性全注入会明显卡顿
        ids = frames.map((f) => f.frameId).slice(0, 16);
      }
    } catch (e) {
      /* 保持 [0] */
    }

    for (const fid of ids) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, frameIds: [fid] },
          files: fid === 0 ? CONTENT_FILES_MAIN : CONTENT_FILES_FRAME
        });
      } catch (e) {
        /* 受限帧（about:、扩展页、正在跳转的帧）跳过，不影响其它帧 */
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('bb-keepalive', { periodInMinutes: 0.5 });
  await bridge.ensure();
  // 重载后接管已打开的页面：用户不必手动刷新，扩展自己也应该是"装上就是好的"
  await reinjectOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('bb-keepalive', { periodInMinutes: 0.5 });
  await bridge.ensure();
});

// (a) 定时唤醒。SW 每次被唤醒都重建，这里等于"复活后立刻把连接捡回来"
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bb-keepalive') bridge.ensure();
});

// SW 被回收前，尽量把抓包缓冲落盘（storage.session 在浏览器会话内保留）
chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(() => {
  bridge.flushNow();
});

// ───────────────────────── 消息入口 ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // (c) content 保活探针：收到就顺带把连接捡一遍
  if (msg && msg.__bb_keeplive) {
    bridge.ensure();
    sendResponse({ ok: true });
    return false;
  }

  // 面板 / 弹窗的自测与设置
  if (msg && msg.__bb_panel) {
    handlePanel(msg, sender)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  // net-hook 抓到的网络记录（由 net-relay 批量转发过来）
  if (msg && msg.__bb_net_batch) {
    pushNetRecords(msg.__bb_net_batch, sender);
    sendResponse({ ok: true, stored: getState().net.length });
    return false;
  }

  // 页面拾取完成（点完了 / Esc 取消 / 超时收尾）→ 回填给正在等待的 pick 指令。
  // 走"页面主动推"而不是请求-响应，因为完成时刻由人决定（详见 commands.js 的 resolvePick）。
  if (msg && msg.__bb_pick_result) {
    // ── 结果来自哪一帧，必须记下来 ──
    // iframe 里拾到的元素，后续要靠 frameId / frameUrl 才能定位回去。
    // 不记的话描述符会指向"主文档里某个长得像的元素"，定位十有八九找错。
    const frameId = sender && sender.frameId != null ? sender.frameId : 0;
    const frameUrl = (sender && sender.url) || '';
    if (msg.data && typeof msg.data === 'object') {
      msg.data.frameId = frameId;
      msg.data.frameUrl = frameUrl;
      // 连续拾取时每个 item 也都标一下（它们都来自同一帧）
      if (Array.isArray(msg.data.items)) {
        msg.data.items.forEach(function (it) {
          if (it && typeof it === 'object') {
            it.frameId = frameId;
            it.frameUrl = frameUrl;
          }
        });
      }
    }

    const delivered = resolvePick(msg, sender);
    const resultTabId = sender && sender.tab && sender.tab.id;

    // 无论成功/取消，其余帧的会话都要收掉 ——
    // 拾取是"所有帧同时起会话"的，只结束收到点击那一帧，别的高亮框会永远留在页面上。
    // 带上 sessionId 让其他帧做严格校验：万一这是新会话开始后迟到的旧会话结果，**不要**误伤。
    if (resultTabId != null) stopPickSession(resultTabId, '拾取结束', msg.sessionId).catch(() => {});

    // 没有人接（= 这是人自己按快捷键发起的拾取）→ 落盘存起来，
    // 之后 agent 用 browser_picks 取走。这就是"人先攒一批元素、agent 随后取用"的那条路。
    if (!delivered && msg.manual && msg.ok) {
      storeManualPick(msg.data, sender).then(function (n) {
        sendResponse({ ok: true, delivered: false, stored: n });
      });
      return true;
    }

    sendResponse({ ok: true, delivered: delivered });
    return false;
  }

  return false;
});

// 本地服务通过 WebSocket 下发的指令
bridge.onCommand(async (msg) => {
  const t0 = Date.now();
  try {
    const data = await dispatch(msg.cmd, msg.args || {}, msg);
    return { id: msg.id, ok: true, data: data, ms: Date.now() - t0 };
  } catch (e) {
    return {
      id: msg.id,
      ok: false,
      error: String((e && e.message) || e),
      ms: Date.now() - t0
    };
  }
});

// ───────────────────────── 面板 / 弹窗动作 ─────────────────────────

async function handlePanel(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;

  switch (msg.action) {
    case 'hello':
    case 'status': {
      const st = bridge.snapshot();
      const s = getState();
      const payload = {
        connected: st.connected,
        state: st.state,
        url: st.url,
        reason: st.reason,
        everConnected: st.everConnected,
        retry: st.retry,
        mode: s.mode,
        recording: s.recording,
        netBuffered: s.net.length,
        hint: st.connected ? undefined : notConnectedHint(st)
      };
      broadcastPanel({
        connected: payload.connected,
        wsUrl: payload.url,
        mode: payload.mode,
        recording: payload.recording,
        lenient: payload.reason || undefined
      });
      return { ok: true, data: payload };
    }

    case 'reconnect': {
      // 先落配置再重连，顺序反了会用旧地址连一次
      // reconfigure 在「配置被企业策略锁定」时会返回 {rejected:true}，要带回去给面板提示，
      // 否则用户看到的就是「点了保存却没反应」
      const rejected =
        msg.wsUrl !== undefined || msg.wsToken !== undefined
          ? await bridge.reconfigure(msg.wsUrl, msg.wsToken)
          : null;
      if (!rejected) await bridge.reconnect();
      const snap = bridge.snapshot();
      return { ok: true, data: rejected ? Object.assign({}, snap, { rejected: rejected }) : snap };
    }

    case 'set_mode': {
      const mode = msg.mode === 'debugger' ? 'debugger' : 'light';
      await patchState({ mode: mode });
      // 切回轻量档时立刻把所有 CDP 附着释放掉，别让浏览器挂着"正在调试"的黄条
      if (mode === 'light') await dispatch('mode_light', {}, {});
      const st = bridge.snapshot();
      return { ok: true, data: { mode: mode, connected: st.connected, wsUrl: st.url } };
    }

    case 'probe': {
      // 弹窗里的「自测」按钮：读一次当前活动页。
      // 它能一并验证「SW → content script → 页面」这条腿 —— 光看连接状态绿了是不够的，
      // 插件连着服务端但 content script 注入失败的情况很常见（旧页面没刷新）。
      const data = await dispatch('active_tab', { tabId: tabId }, {});
      return { ok: true, data: data };
    }

    case 'screenshot': {
      const data = await dispatch('screenshot', { fullPage: false, tabId: tabId }, {});
      return { ok: true, data: data };
    }

    /**
     * 面板上的「拾取元素」：等价于在页面上按 Alt+Shift+A。
     * 走手动模式（manual:true）—— 结果落盘而不是回传给某次调用，
     * 因为面板这条路上根本没有一个"正在等待的调用"。
     */
    case 'pick': {
      const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId;
      if (tabId == null) return { ok: false, error: '拿不到当前标签页' };
      // 走 startPickSession：内部按帧定向投递（并顺带补注入），只影响这一个标签页
      const data = await startPickSession(tabId, {
        manual: true,
        multi: true,
        hint: '手动拾取：按住 Ctrl + 左键点击目标元素（可连续点多个），Esc 结束并保存'
      });
      // 一帧都没接住就别谎报成功 —— 用户会对着一个不存在的拾取模式白点半天
      if (data.error) return { ok: false, error: '拾取未能启动：' + data.error };
      return { ok: true, data: { started: true, sessionId: data.sessionId, frames: data.frames } };
    }

    case 'cookies': {
      const data = await dispatch('cookies', { url: sender && sender.tab ? sender.tab.url : undefined }, {});
      // 面板/弹窗里只报"拿到了几条、哪些域"，不把完整 value 打到页面上
      return {
        ok: true,
        data: {
          count: data.count,
          domains: data.domains,
          names: data.cookies.map((c) => c.name)
        }
      };
    }

    case 'net_toggle': {
      const rec = getState().recording;
      const next = !rec;
      await patchState({ recording: next });
      broadcastPanel({ recording: next });
      return { ok: true, data: { recording: next, buffered: getState().net.length } };
    }

    default:
      return { ok: false, error: '未知面板动作：' + msg.action };
  }
}

/**
 * 未连接时给用户一句能直接照做的话，而不是把 `ERR_CONNECTION_REFUSED` 甩给他。
 * 分两种情况说，因为处置方式完全不同：
 *   - 从没连上过 → 服务端压根没启动（最常见，因为它是被 MCP 客户端拉起的）
 *   - 连上过又断了 → 服务端中途退了，或者地址/token 被改了
 */
function notConnectedHint(st) {
  const addr = (st.url || '').replace(/^wss?:\/\//, '');
  if (!st.everConnected) {
    return (
      '本地服务还没启动（' + addr + '）。两种办法：\n' +
      '  1) 重启 WorkBuddy —— MCP 客户端会自动拉起它，不用手动开；\n' +
      '  2) 双击 browser-bridge\\server\\start-server.bat 手工起一个。\n' +
      '注意两者只能有一个：手工起的那个没关，重启 WorkBuddy 时 8765 端口会被占，服务端会退出。'
    );
  }
  return (
    '连接中断（' + addr + '）。' + (st.reason || '') + '\n' +
    '服务端可能已退出。点上面的「重连」再试。'
  );
}

function broadcastPanel(st) {
  // 面板有可能还没注入（页面未刷新、chrome:// 页面等），吞掉错误即可
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, { __bb: true, action: 'panel_state', args: st }, { frameId: 0 }).catch(() => {});
    }
  }).catch(() => {});
}

// ───────────────────────── 网络抓包缓冲 ─────────────────────────

function pushNetRecords(records, sender) {
  const state = getState();
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const frameUrl = sender && sender.url ? sender.url : '';

  for (const r of records) {
    // 未开始抓包时只留"结构"不存正文，避免后台长期堆内存
    if (!state.recording) continue;

    state.net.push({
      seq: ++state.netSeq,
      tabId: tabId,
      frameUrl: frameUrl,
      ...r
    });
  }

  if (state.net.length > 2000) {
    state.net.splice(0, state.net.length - 2000);
  }
  bridge.scheduleFlush();
}

// ───────────────────────── 启动即连 ─────────────────────────

bridge.ensure();
