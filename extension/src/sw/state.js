/**
 * Browser Bridge · service worker 运行态
 *
 * 【为什么要单独一个 state 模块？】
 *   MV3 的 service worker 会被回收，模块顶层变量在重启后归零。
 *   凡是"跨重启必须还在"的东西（档位、是否在抓包）都会被落到
 *   chrome.storage.session —— 它随浏览器会话存活、浏览器关闭即清空，
 *   正好是这类运行态该待的地方（比 local 干净：不会把昨天的抓包开关带到今天）。
 *
 * 【为什么抓包缓冲不落盘？】
 *   网络记录体积大、时效性强，落 storage 只会写爆配额。
 *   它留在内存里，靠"服务端心跳 → SW 不睡"来保证存活。
 *   真需要长期留存的，应该是 agent 那边拿到后自己落库。
 */

const state = {
  /** 'light' 合成事件（默认） | 'debugger' 走 CDP 真实事件 */
  mode: 'light',
  /** 是否正在记录网络 */
  recording: false,
  /** 网络记录环形缓冲 */
  net: [],
  netSeq: 0
};

let ready = null;

export function initState() {
  if (!ready) {
    ready = (async () => {
      try {
        const s = await chrome.storage.session.get(['mode', 'recording']);
        if (s.mode === 'light' || s.mode === 'debugger') state.mode = s.mode;
        if (typeof s.recording === 'boolean') state.recording = s.recording;
      } catch (e) {
        /* storage.session 不可用时用默认值，不阻断启动 */
      }
    })();
  }
  return ready;
}

export function getState() {
  return state;
}

export async function patchState(patch) {
  Object.assign(state, patch);
  const toSave = {};
  if ('mode' in patch) toSave.mode = state.mode;
  if ('recording' in patch) toSave.recording = state.recording;
  if (Object.keys(toSave).length) {
    try {
      await chrome.storage.session.set(toSave);
    } catch (e) {
      /* 忽略 */
    }
  }
}
