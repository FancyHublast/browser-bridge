/**
 * Browser Bridge · 标签页定位与 content script 通道
 *
 * 【为什么单独抽一个模块？】
 *   service worker 里几乎每个指令都要"找到目标标签页 → 确保 content script 在 → 发消息"。
 *   把它抽出来，既避免 commands.js 与 screenshot.js 之间形成循环依赖，
 *   也让"注入"这件事只有一处实现 —— 注入是 bug 高发区。
 *
 * 【为什么不做"已注入"缓存？】
 *   看起来能省一次消息往返，但它会在两个常见场景下静默失效：
 *     a) 页面导航到 chrome:// 等受限地址后，缓存说"已注入"实际没有；
 *     b) 扩展更新后旧注入失效，缓存还是"已注入"。
 *   代价是一次本地消息（亚毫秒），换来的是永远正确的判断。按每次探测来做。
 *
 * 【iframe 为什么必须单独处理】（v1.0.2 新增）
 *   早期版本把 frameId 写死成 0，只在主文档里找元素。这在真机上立刻翻车：
 *   生意参谋的登录表单压根不在主文档，而在一个跨域 iframe
 *   （#alibaba-login-box → havanalogin.taobao.com/mini_login.htm）里，
 *   于是 query/click 全部 0 命中。国内一大批后台（淘宝系、拼多多商家后台）
 *   都用 iframe 搭内容区，所以这不是边角情况，是主路径。
 *
 *   实现上刻意**不**把动作包塞进所有 frame（manifest 里 all_frames 保持 false）：
 *   面板会被注入到每个 iframe 里（页面上冒出几十个 BB 小球），内存也白吃。
 *   改成"按需注入 + 自动扫帧"：主文档先行，不行才逐个 iframe 试，
 *   命中即返回并告知 frameId。绝大多数调用零额外开销。
 */

/** 与 manifest.json 中 content_scripts 的 js 数组保持一致，顺序即依赖顺序 */
/**
 * 动态补注入时用的文件清单（按依赖顺序合并）。
 *
 * v1.3.0 之前 manifest 是单一 content_scripts 数组，注入一份就行。
 * v1.3.0 拆成了 5 组（net-hook / net-relay / 共享基础 / picker / panel+main），
 * chrome.scripting.executeScript 一次只能传一个 files 数组，所以把这 5 组合并成一份
 * 按依赖顺序排好——共享基础层在 picker 前面、panel/main 在最后。
 *
 * 注意：CONTENT_FILES_MAIN 与 manifest 的 content_scripts 拆分**不是**简单复制，
 * 而是把所有要跑的文件铺平、维持依赖顺序、并去掉 iframe 不该跑的 panel.js / main.js。
 */
const ALL_FILES = [
  // 共享基础层（每帧都跑）
  'src/content/config.js',
  'src/content/adapter.js',
  'src/content/locator.js',
  'src/content/actions.js',
  // 拾取器（每帧都跑，依赖共享基础层）
  'src/content/picker.js',
  // 消息路由（每帧都跑！v1.3.1 从 main.js 拆出）
  // 少了它，iframe 里就是"有手没耳朵"：元素定位得出来，SW 的指令却送不进去。
  'src/content/router.js',
  // 仅主文档（iframe 里跑会盖住登录框）
  'src/content/panel.js',
  'src/content/main.js'
];
// 网络层是单独的两组（一个 MAIN 世界、一个 ISOLATED），
// 它们已经在 manifest 里 document_start 注入，补注入脚本时不需要重注。
// 这里只需要"业务逻辑"那一组：所有 RK 命名空间、bridge 的桥。

export const CONTENT_FILES_MAIN = ALL_FILES;

/**
 * 注入 iframe 时用的文件表：**去掉 panel.js / main.js**（保留 router.js！）。
 *
 * panel.js 挂一个 position:fixed 的 BB 小球，注入进 iframe 就会在那个小框里
 * 挂出一个 BB 小球（生意参谋的登录 iframe 只有 300×242，小球能盖掉小半个框）。
 * main.js 现在只负责面板挂载与保活，同样只该在主文档跑。
 *
 * 【router.js 绝不能去掉】
 *   它是 SW 指令的收件口。v1.3.0 时它还在 main.js 里、被连同排除掉，
 *   于是 iframe 里元素定位得出来、指令却送不进去（表现为"注入后无响应"）。
 */
export const CONTENT_FILES_FRAME = ALL_FILES.filter(
  (f) => f.indexOf('panel.js') === -1 && f.indexOf('main.js') === -1
);

/** 受限协议：这些页面永远注入不进去，报错要写成"人话"而不是把原始异常甩出去 */
const RESTRICTED = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i;
const STORE_URL = /^https:\/\/chrome\.google\.com\/webstore|^https:\/\/microsoftedge\.microsoft\.com\/addons/i;

/** 扫帧上限：淘宝/拼多多这类页面动辄几十个埋点 iframe，不设上限会明显拖慢 */
const MAX_FRAME_SWEEP = 8;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_res, rej) => {
    timer = setTimeout(() => rej(new Error('动作超时（' + ms + 'ms）：' + (label || '未命名'))), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 未指定 tabId 时落到"当前窗口的活动标签页" */
export async function resolveTabId(tabId) {
  if (tabId != null && tabId !== '' && tabId !== 'active') {
    const id = Number(tabId);
    if (!Number.isNaN(id)) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) throw new Error('标签页不存在：' + tabId + '（可能已被关闭）');
      return id;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) throw new Error('找不到活动标签页，请指定 tabId');
  return tab.id;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

/**
 * 列出目标页的所有 frame。
 * 走 chrome.webNavigation.getAllFrames（manifest 已声明该权限）——
 * 它是浏览器原生维护的帧树，比自己注入探针去数更准、更快，且不产生任何副作用。
 */
export async function listFrames(tabId) {
  const id = await resolveTabId(tabId);
  let frames = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: id });
  } catch (e) {
    /* 页面正在跳转时可能拿不到，兜底成只有主文档 */
  }
  if (!frames || !frames.length) {
    return [{ frameId: 0, parentFrameId: -1, url: '', isTop: true, crossOrigin: false }];
  }
  const topOrigin = originOf((frames.find((f) => f.frameId === 0) || {}).url || '');
  return frames
    .map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url || '',
      isTop: f.frameId === 0,
      crossOrigin: !!topOrigin && originOf(f.url) !== topOrigin
    }))
    .sort((a, b) => a.frameId - b.frameId);
}

/** 目标页是否允许注入 */
export function assertInjectable(tab) {
  const url = (tab && tab.url) || '';
  if (!url) return; // pendingUrl 阶段拿不到，放行由后面兜底
  if (RESTRICTED.test(url)) {
    throw new Error('这是浏览器内部页面（' + url.split('/')[0] + '://），插件不允许在上面操作。请切到一个普通网页再试。');
  }
  if (STORE_URL.test(url)) {
    throw new Error('浏览器扩展商店页面禁止注入脚本，请换一个页面。');
  }
}

/** 把 frameId 说成人话，出错时有用 */
function frameLabel(frameId) {
  return frameId === 0 ? '主文档' : 'iframe(frameId=' + frameId + ')';
}

/**
 * 确保目标标签页的**指定 frame** 已注入 content script。
 * 扩展刚安装/更新后，已打开的旧页面不会自动补注入 —— 这是"装完插件发现没反应"的头号原因，
 * 所以这里主动补一次 executeScript。
 *
 * frameId 默认 0（主文档）。iframe 采用**按需注入**：只有真的要在这个帧里干活时才注入，
 * 避免往页面上几十个埋点/广告 iframe 里都塞一份内容脚本。
 */
export async function ensureInjected(tabId, frameId) {
  const fid = frameId == null ? 0 : Number(frameId);

  try {
    const res = await chrome.tabs.sendMessage(
      tabId,
      { __bb: true, action: 'ping', args: {} },
      { frameId: fid }
    );
    if (res && res.ok) return;
  } catch (e) {
    /* 未注入，走下面的补注入 */
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('标签页不存在：' + tabId);
  assertInjectable(tab);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [fid] },
      files: fid === 0 ? CONTENT_FILES_MAIN : CONTENT_FILES_FRAME
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/Cannot access|The extensions gallery cannot be scripted|Missing host permission/i.test(m)) {
      throw new Error(
        '无权在' + frameLabel(fid) + '注入脚本（' + (tab.url || '').slice(0, 80) + '）：' + m
      );
    }
    throw new Error('注入 content script 失败（' + frameLabel(fid) + '）：' + m);
  }

  // 注入后立刻验一次，避免"注入成功但脚本内部报错"被误判成链路正常
  const probe = await chrome.tabs
    .sendMessage(tabId, { __bb: true, action: 'ping', args: {} }, { frameId: fid })
    .catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error(
      'content script 在' + frameLabel(fid) + '注入后无响应，请刷新页面（F5）后重试。'
    );
  }
}

/**
 * 「空结果」判定。auto 模式靠它决定"主文档没命中，该去 iframe 里找了"。
 * 只对**返回空比抛错更常见**的读取类动作有意义；click/type 这类查不到会直接抛错。
 */
const EMPTY_CHECKERS = {
  query: (d) => !d || Number(d.total) === 0,
  element_at: (d) => !d || !d.el,
  resolve_point: (d) => !d || d.x == null || d.y == null
};

/**
 * 结果里是否含有「真实可见」的目标。扫帧择优时用它把隐藏模板筛掉。
 *
 * 【为什么必须有这一条】（v1.0.4 真机踩坑）
 *   淘宝 nc 滑块在页面里同时存在「隐藏模板」与「真实实例」，而**模板所在的帧 frameId 更小**。
 *   旧逻辑"第一个非空结果就返回"会先命中模板 —— 拿到的是 rect 全 0 的元素，
 *   拖拽直接打空，而且报错含糊（看起来像是"拖了但没过"）。
 *   判定顺序按"信息量从高到低"：元素列表 → 单元素描述 → 纯矩形。
 */
export function hasVisibleResult(data) {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data.elements)) return data.elements.some((e) => e && e.visible);
  if (data.el && typeof data.el.visible === 'boolean') return !!data.el.visible;
  if (data.rect && typeof data.rect === 'object') {
    return Number(data.rect.w) > 0 && Number(data.rect.h) > 0;
  }
  return false;
}

/** 往单个 frame 发一条动作（不做任何兜底/重试） */
async function callFrame(tabId, action, args, timeoutMs, frameId) {
  await ensureInjected(tabId, frameId);
  const res = await withTimeout(
    chrome.tabs.sendMessage(tabId, { __bb: true, action: action, args: args || {} }, { frameId: frameId }),
    timeoutMs || 20000,
    'content.' + action
  );
  if (!res) throw new Error('content script 无响应：' + action + '（' + frameLabel(frameId) + '）');
  if (!res.ok) throw new Error(res.error || 'content script 执行失败：' + action);
  return res.data;
}

/**
 * 调用 content script 里的动作。
 *
 * frame 参数（第 5 位，默认 auto）：
 *   'auto' / undefined —— 先主文档；没命中（抛错或空结果）再逐个 iframe 试。
 *                         命中时会在返回值里附上 frameId / frameUrl，告诉你元素在哪一帧。
 *   'top'              —— 只在主文档，不扫帧（明确要主文档时用，省时间）
 *   'all'              —— 每个 frame 都跑一遍，返回 {frames:[...]}（适合摸清页面结构）
 *   <数字>              —— 指定 frameId
 *
 * 统一把 {ok:false} 转成异常抛出 —— 让上层只需要处理一种错误形态。
 */
/**
 * 把同一条消息发给**某个标签页的所有帧**（主文档 + 每一个 iframe）。
 *
 * 【为什么必须逐帧发】
 *   chrome.tabs.sendMessage 不指定 frameId 时**只发给主文档** —— 没有"广播给所有帧"这个语义。
 *   这在拾取场景里是致命的：千牛、生意参谋这类后台把登录框放在 iframe 里，
 *   鼠标移到 iframe 上时事件由 iframe 文档自己派发，主文档**根本收不到**，
 *   于是拾取器"看不见" iframe 里的任何元素（同理，键盘焦点在 iframe 里时 Esc 也落不到主文档）。
 *   所以拾取必须让每一帧都各起一份会话、各自高亮自己帧内的内容。
 *
 * 【为什么先 ensureInjected】
 *   iframe 是按需注入的，很多帧此刻还没有 content script，
 *   直接发消息会静默失败（catch 掉就真的什么都没发生）。
 *
 * @returns {Promise<number[]>} 真正送达的 frameId 列表
 */
export async function broadcastFrames(tabId, payload) {
  let frames = [];
  try {
    frames = (await listFrames(tabId)) || [];
  } catch (e) {
    frames = [];
  }
  const ids = frames.map((f) => f.frameId);
  if (!ids.length) ids.push(0);

  const delivered = [];
  await Promise.all(
    ids.map(async (fid) => {
      try {
        await ensureInjected(tabId, fid);
      } catch (e) {
        return; // 注入不了（扩展页/受限域）就跳过，不该拖垮其他帧
      }
      try {
        await chrome.tabs.sendMessage(tabId, payload, { frameId: fid });
        delivered.push(fid);
      } catch (e) {
        /* 该帧收不到，忽略 */
      }
    })
  );
  return delivered;
}

export async function contentCall(tabId, action, args, timeoutMs, frame) {
  const id = await resolveTabId(tabId);

  // 所有帧都跑
  if (frame === 'all') {
    const frames = await listFrames(id);
    const out = [];
    for (const f of frames) {
      try {
        out.push({ frameId: f.frameId, url: f.url, ok: true, data: await callFrame(id, action, args, timeoutMs, f.frameId) });
      } catch (e) {
        out.push({ frameId: f.frameId, url: f.url, ok: false, error: String((e && e.message) || e) });
      }
    }
    return { frames: out };
  }

  // 指定了具体 frameId
  if (frame != null && frame !== 'auto' && frame !== 'top') {
    const fid = Number(frame);
    if (Number.isNaN(fid)) {
      throw new Error('frame 参数只能填数字 frameId，或 "top" / "auto" / "all"');
    }
    return callFrame(id, action, args, timeoutMs, fid);
  }

  const explicitTop = frame === 'top';
  const check = EMPTY_CHECKERS[action];

  let firstData = null;
  let firstErr = null;
  try {
    firstData = await callFrame(id, action, args, timeoutMs, 0);
    // 主文档命中（或该动作不适用"空结果"判定，或用户明确只要主文档）→ 直接返回
    if (explicitTop || !check || !check(firstData)) return firstData;
  } catch (e) {
    firstErr = e;
    if (explicitTop) throw e;
  }

  // ── 主文档没命中 → 扫 iframe ──
  //
  // 【为什么不是"第一个命中就返回"】（v1.0.4 修正）
  //   真机上踩过：淘宝 nc 滑块在页面里同时存在「隐藏模板」与「真实实例」，
  //   而模板所在帧的 frameId 更小 —— 按旧逻辑会命中模板（rect 全 0）就返回，
  //   于是 agent 拿到一个 0×0 的元素，拖拽直接打空。
  //   改成：并发取回所有帧的结果，**有可见命中就优先用可见的**；
  //   全都不可见时才退回第一个非空结果（至少能让调用方看到元素在哪一帧）。
  const others = (await listFrames(id))
    .filter((f) => f.frameId !== 0 && /^https?:/i.test(f.url))
    .sort((a, b) => a.frameId - b.frameId)
    .slice(0, MAX_FRAME_SWEEP);

  const swept = await Promise.all(
    others.map(async (f) => {
      try {
        return { frameId: f.frameId, url: f.url, data: await callFrame(id, action, args, timeoutMs, f.frameId) };
      } catch (e) {
        return null; // 这一帧没有 / 注入不进去，跳过
      }
    })
  );

  const hits = swept.filter((r) => r && !(check && check(r.data)));
  const best = hits.find((r) => hasVisibleResult(r.data)) || hits[0] || null;

  if (best) {
    if (best.data && typeof best.data === 'object' && !Array.isArray(best.data)) {
      const out = Object.assign({}, best.data, {
        frameId: best.frameId,
        frameUrl: best.url,
        frameNote:
          '目标不在主文档，实际命中 iframe（frameId=' +
          best.frameId +
          '）。后续操作同一元素请带上 frame=' +
          best.frameId +
          ' 以免重复扫描。'
      });
      if (hits.length > 1) {
        out.frameSweepNote =
          '共 ' +
          hits.length +
          ' 个帧有命中：' +
          hits
            .map((r) => 'frameId=' + r.frameId + (hasVisibleResult(r.data) ? '(可见)' : '(不可见)'))
            .join('、') +
          '。已优先选用可见的那个 —— 隐藏的那份通常是模板，尺寸为 0，拿它去点会打空。';
      }
      return out;
    }
    return best.data;
  }

  // 所有帧都没命中：优先把主文档那个错误抛出去（它才是最贴近用户意图的）
  if (firstData !== null) return firstData;
  throw firstErr || new Error('content script 无响应：' + action);
}

/** 向所有标签页广播（面板状态同步用），忽略失败 */
export async function broadcast(payload, frameId) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(
    tabs.map((t) =>
      t.id
        ? chrome.tabs
            .sendMessage(t.id, payload, frameId != null ? { frameId: frameId } : undefined)
            .catch(() => {})
        : null
    )
  );
}
