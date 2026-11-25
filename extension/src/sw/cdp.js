/**
 * Browser Bridge · 增强档：chrome.debugger（CDP）通道
 *
 * 【为什么"增强档"值得存在？】
 *   合成 DOM 事件（轻量档）有三件事做不到：
 *     1) isTrusted 恒为 false —— 有风控校验的站点会直接判定为机器人；
 *     2) setPointerCapture 强绑定的拖拽库，事件收不到；
 *     3) 全页截图、完整网络流（含响应体）—— 光靠 DOM API 拿不全。
 *   这三个场景只能走 CDP：事件由浏览器底层产生，isTrusted 为 true。
 *
 * 【代价必须提前说清】
 *   - attach 后浏览器顶部会常驻一条"正在调试此浏览器"的黄条，这是 Chrome 的安全设计，去不掉；
 *   - 同一个标签页同一时刻只能有一个调试客户端。你手动打开 F12 会让 attach 失败，
 *     反之亦然。这是最容易踩的坑，报错信息里必须写清楚该怎么办。
 *
 * 【SW 重启会丢什么】
 *   attached 这个 Set 是内存态，SW 被回收后归零，但浏览器侧的附着其实还在。
 *   所以每次启动都要用 chrome.debugger.getTargets() 把真实状态同步回来，
 *   否则会出现"明明已附着，再次 attach 却报已被占用"的鬼故事。
 */

const CDP_VERSION = '1.3';
/** 已附着的 tabId 集合（内存态，启动时用 syncAttached 校准） */
const attached = new Set();

/** 网络抓包：requestId -> {method, url, t, frameUrl} */
const pendingRequests = new Map();

/** 已开启 Network 域的 tabId */
const networkEnabled = new Set();

let netSink = null;

/** 由 commands.js 注入"把记录写进缓冲"的回调，避免循环依赖 */
export function setNetSink(fn) {
  netSink = fn;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function msgOf(e) {
  return String((e && e.message) || e);
}

// ───────────────────────── 附着管理 ─────────────────────────

/**
 * 从浏览器侧同步真实附着状态。
 * SW 每次启动都应调用一次（在 service-worker.js 的启动流程里）。
 */
export async function syncAttached() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && t.tabId >= 0) attached.add(t.tabId);
    }
  } catch (e) {
    /* 拿不到就当作没有，后续 attach 会自然纠偏 */
  }
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function attachedTabs() {
  return Array.from(attached);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId: tabId }, CDP_VERSION);
  } catch (e) {
    const m = msgOf(e);
    if (/already attached/i.test(m)) {
      // 可能是 SW 重启后我们自己的旧附着 —— 先释放再重来，失败则明确报"被别人占用"
      try {
        await chrome.debugger.detach({ tabId: tabId });
        await chrome.debugger.attach({ tabId: tabId }, CDP_VERSION);
      } catch (e2) {
        throw new Error(
          '标签页 ' +
            tabId +
            ' 已被其它调试客户端占用，无法附着。\n' +
            '常见原因：该页开着 F12 开发者工具，或另一个占用调试的扩展在跑。\n' +
            '处理：关掉该页的开发者工具后重试；本插件会保持附着，不需要时可在弹窗里切回「轻量档」释放。'
        );
      }
    } else if (/Cannot attach/i.test(m) || /chrome:\/\//i.test(m)) {
      throw new Error('该页面不允许附着调试器（chrome://、扩展商店等受限页面）：' + m);
    } else {
      throw new Error('附着调试器失败：' + m);
    }
  }

  attached.add(tabId);
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId: tabId });
  } catch (e) {
    /* 已经掉了也算成功 */
  }
  attached.delete(tabId);
  networkEnabled.delete(tabId);
}

export async function detachAll() {
  for (const tabId of Array.from(attached)) {
    await detach(tabId);
  }
}

/** 发一条 CDP 命令 */
export async function send(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
  } catch (e) {
    throw new Error('CDP ' + method + ' 失败：' + msgOf(e));
  }
}

export async function ensureAttached(tabId) {
  if (!attached.has(tabId)) await attach(tabId);
}

// 用户手动关闭调试条 / 关标签页 / 打开 F12 时都会触发
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId != null) {
    attached.delete(source.tabId);
    networkEnabled.delete(source.tabId);
  }
});

// ───────────────────────── CDP 输入事件 ─────────────────────────

/**
 * 真实鼠标点击。
 * 先发一次 mouseMoved —— 不少前端框架靠 mousemove 才把 hover 态算出来，
 * 少了这一步，点到的可能是"未展开"的元素。
 */
export async function clickAt(tabId, x, y, opts) {
  opts = opts || {};
  const button = opts.button || 'left';
  const count = opts.clickCount || 1;
  const holdMs = opts.holdMs != null ? opts.holdMs : 30;

  await ensureAttached(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x,
    y: y,
    button: 'none',
    buttons: 0
  });
  await sleep(10);

  for (let i = 1; i <= count; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x,
      y: y,
      button: button,
      buttons: 1,
      clickCount: i
    });
    await sleep(holdMs);
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x,
      y: y,
      button: button,
      buttons: 0,
      clickCount: i
    });
    if (i < count) await sleep(60);
  }
}

/** 真实鼠标移动（用于 hover / 拖拽轨迹） */
export async function moveTo(tabId, x, y, opts) {
  opts = opts || {};
  await ensureAttached(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x,
    y: y,
    button: opts.button || 'none',
    buttons: opts.buttons || 0
  });
}

// ── 拟人化轨迹 ─────────────────────────────────────────────────────
//
// 淘宝 nc 滑块 / 无痕验证这类行为风控，看的不是"点了没点"，而是三件事：
//   1) isTrusted  —— 走 CDP 就有了，这是**前提而非全部**；
//   2) 轨迹形状   —— 完美直线、恒定斜率、瞬移，都会被判机器；
//   3) 时序       —— 步进间隔是否等距、按下到移动是否零延迟、到位到松手是否瞬间。
// 所以下面这些"多余"的随机不是装饰，是这个函数**唯一**的价值所在。
//
// 反例提醒：原来那版用的是 easeInOutCubic（速度峰值恰好在 50%、起步立刻有速度），
// 那条曲线是纯数学产物，人手做不出来 —— 只在"拖起来就行"的场景够用，过不了风控。

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * 生成一条位移曲线：起步慢 → 中段推进 → 末段收住，速度峰值在 35% 附近。
 *
 * 注意 a/b 必须在**闭包外**随机一次。若在曲线函数里每次调用都随机，
 * 同一条轨迹的不同采样点会落在不同曲线上，结果是非单调甚至倒退。
 */
function humanEaseFactory() {
  const a = randRange(1.7, 2.1);
  const b = randRange(2.3, 2.9);
  return function (p) {
    const pa = Math.pow(p, a);
    const qb = Math.pow(1 - p, b);
    return pa / (pa + qb || 1e-9);
  };
}

/**
 * 真实拖拽：接近 → 迟疑 → 按下 → 静止 → 变速弧线拖行 → 停顿 → 抬起。
 *
 * 参数：
 *   steps       轨迹采样点数，默认按距离自适应（太疏会被判瞬移，太密纯浪费）
 *   durationMs  整段拖行时长，默认 620~1150ms 随机（人类拖 300px 大致就这个量级）
 *   jitterY     整段弧线的最大纵向漂移，默认 ±3px
 *   holdMs      到位后到松手的停顿，默认 160~420ms 随机
 */
export async function dragAt(tabId, from, to, opts) {
  opts = opts || {};
  await ensureAttached(tabId);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = opts.steps || Math.max(18, Math.min(70, Math.round(distance / 7)));
  const durationMs = opts.durationMs != null ? opts.durationMs : randRange(620, 1150);
  const baseStep = durationMs / steps;
  const ease = humanEaseFactory();

  // 人手拖拽是一条弧线，不是两条平行线 —— 中途偏离、两端回归
  const driftY = opts.jitterY != null ? opts.jitterY * (Math.random() < 0.5 ? -1 : 1) : randRange(-3, 3);
  const noise = randRange(0.4, 1.0);

  const move = (x, y, buttons) =>
    send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: buttons ? 'left' : 'none',
      buttons: buttons
    });

  // ① 先把鼠标从左上飘过来 —— 不少前端框架要靠 mousemove 才算 hover 态
  const approach = Math.max(4, Math.round(steps / 6));
  for (let i = 1; i <= approach; i++) {
    const t = ease(i / approach);
    await move(from.x - 26 * (1 - t), from.y - 18 * (1 - t), 0);
    await sleep(randRange(6, 16));
  }
  await move(from.x, from.y, 0);

  // ② 按下前的迟疑：人不会"移到就按"
  await sleep(randRange(120, 320));
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: 'left',
    buttons: 1,
    clickCount: 1
  });

  // ③ 按下后到真正开始拖动，还有一小段静止
  await sleep(randRange(70, 180));

  // ④ 主轨迹
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const f = ease(p);
    let x = from.x + dx * f;
    let y = from.y + dy * f + Math.sin(p * Math.PI) * driftY;

    // 末点必须精确落在终点，否则拖拽库收不到"到位"信号
    if (i === steps) {
      x = to.x;
      y = to.y;
    } else {
      x += randRange(-noise, noise);
      y += randRange(-noise, noise);
    }

    await move(x, y, 1);

    // 步进时间也要抖 —— 等距间隔是脚本的典型特征
    await sleep(baseStep * randRange(0.55, 1.5));
  }

  // ⑤ 到位后停顿再松手（滑块要靠这段停顿把验证结果算出来）
  await sleep(opts.holdMs != null ? opts.holdMs : randRange(160, 420));
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(to.x),
    y: Math.round(to.y),
    button: 'left',
    buttons: 0,
    clickCount: 1
  });

  return {
    mode: 'cdp',
    trust: 'isTrusted',
    humanLike: true,
    steps: steps,
    durationMs: Math.round(durationMs),
    distance: Math.round(distance),
    from: { x: Math.round(from.x), y: Math.round(from.y) },
    to: { x: Math.round(to.x), y: Math.round(to.y) },
    note:
      '拟人轨迹（起步迟疑 + 变速推进 + 弧线漂移 + 到位停顿），事件由浏览器底层产生，isTrusted=true。'
  };
}

/** 真实键盘输入（逐字符，用 char 类型以支持中文） */
export async function typeText(tabId, text, opts) {
  opts = opts || {};
  const delay = opts.delayMs != null ? opts.delayMs : 20;
  await ensureAttached(tabId);

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    // type:'char' 是专门用于"输入一个字符"的，能正确处理 Unicode
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: ch });
    if (delay > 0) await sleep(delay);
  }
  return { typed: text.length };
}

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
};

export async function pressKey(tabId, name) {
  const info = KEY_MAP[name] || { key: name, code: name, windowsVirtualKeyCode: 0 };
  await ensureAttached(tabId);
  await send(
    tabId,
    'Input.dispatchKeyEvent',
    Object.assign({ type: 'keyDown' }, info)
  );
  await sleep(20);
  await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, info));
  return { key: info.key };
}

/** 在页面上下文执行 JS —— 走 CDP 完全不受页面 CSP 限制 */
export async function evaluate(tabId, expression, opts) {
  opts = opts || {};
  await ensureAttached(tabId);
  const res = await send(tabId, 'Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise !== false,
    userGesture: true
  });

  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails;
    const desc =
      (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || '执行异常';
    throw new Error('页面执行出错：' + String(desc).slice(0, 800));
  }
  return res && res.result ? res.result.value : undefined;
}

// ───────────────────────── CDP 截图 ─────────────────────────

/**
 * 整页长截图（CDP 路径，一次成型）。
 * captureBeyondViewport 让浏览器直接渲染视口外的部分，
 * 不存在拼接产生的"固定头部重复出现"问题 —— 这就是增强档截图质量更高的原因。
 */
export async function captureScreenshot(tabId, opts) {
  opts = opts || {};
  await ensureAttached(tabId);
  await send(tabId, 'Page.enable');

  const params = {
    format: opts.format === 'jpeg' ? 'jpeg' : 'png',
    fromSurface: true,
    captureBeyondViewport: opts.fullPage !== false
  };
  if (params.format === 'jpeg') params.quality = opts.quality || 85;

  if (opts.clip) {
    params.clip = {
      x: opts.clip.x,
      y: opts.clip.y,
      width: opts.clip.width,
      height: opts.clip.height,
      scale: opts.clip.scale || 1
    };
    // 有 clip 时不能同时 beyond viewport，否则坐标会被误解
    params.captureBeyondViewport = false;
  }

  const res = await send(tabId, 'Page.captureScreenshot', params);
  return res && res.data ? res.data : null;
}

/** 取页面真实尺寸（CSS 像素），整页截图拼接需要 */
export async function pageMetrics(tabId) {
  await ensureAttached(tabId);
  const res = await send(tabId, 'Page.getLayoutMetrics');
  const css = (res && res.cssContentSize) || (res && res.contentSize) || {};
  return {
    width: Math.ceil(css.width || 0),
    height: Math.ceil(css.height || 0)
  };
}

// ───────────────────────── CDP 网络监听 ─────────────────────────

/**
 * 开启某个标签页的 Network 域。
 * CDP 抓包是"全量"的：包含页面自身 fetch/XHR、图片、字体、埋点……抓到的比预想的多。
 */
export async function networkStart(tabId) {
  await ensureAttached(tabId);
  if (!networkEnabled.has(tabId)) {
    await send(tabId, 'Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 5 * 1024 * 1024
    });
    networkEnabled.add(tabId);
  }
  return { tabId: tabId, enabled: true };
}

export async function networkStop(tabId) {
  if (networkEnabled.has(tabId)) {
    try {
      await send(tabId, 'Network.disable');
    } catch (e) {
      /* 忽略 */
    }
    networkEnabled.delete(tabId);
  }
  return { tabId: tabId, enabled: false };
}

/**
 * 只要 requestId 是 CDP 内部标识，不跨会话稳定，但长度无上限，
 * 且这里的 Map 是内存态，SW 回收后自然清空，不会泄漏。
 */
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!source || source.tabId == null) return;
  const tabId = source.tabId;
  if (!networkEnabled.has(tabId)) return;
  try {
    if (method === 'Network.requestWillBeSent') {
      pendingRequests.set(params.requestId, {
        tabId: tabId,
        method: params.request.method,
        url: params.request.url,
        t: Date.now(),
        t0: performance.now(),
        frameUrl: params.documentURL || '',
        hasPostData: !!params.request.hasPostData,
        postData: params.request.postData || null,
        type: params.type || 'Other'
      });

      if (netSink) {
        netSink({
          kind: 'cdp',
          phase: 'request',
          tabId: tabId,
          method: params.request.method,
          url: params.request.url,
          resourceType: params.type || 'Other',
          body: params.request.postData ? String(params.request.postData).slice(0, 20000) : null,
          t: Date.now(),
          pageUrl: params.documentURL || ''
        });
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const meta = pendingRequests.get(params.requestId);
      const ms = meta ? Math.round(performance.now() - meta.t0) : null;
      const headers = Object.assign({}, params.response.headers || {});
      // 头部里可能夹带凭据，一律打码后再入缓冲
      ['authorization', 'set-cookie', 'cookie', 'x-api-key'].forEach((k) => {
        Object.keys(headers).forEach((hk) => {
          if (hk.toLowerCase() === k) headers[hk] = '<已隐藏>';
        });
      });

      if (netSink) {
        netSink({
          kind: 'cdp',
          phase: 'response',
          tabId: tabId,
          method: meta ? meta.method : '',
          url: params.response.url,
          resourceType: params.type || (meta ? meta.type : 'Other'),
          status: params.response.status,
          ok: params.response.status >= 200 && params.response.status < 300,
          mimeType: params.response.mimeType,
          headers: headers,
          ms: ms,
          t: Date.now()
        });
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const meta = pendingRequests.get(params.requestId);
      pendingRequests.delete(params.requestId);
      if (!meta || !netSink) return;
      // 只有文本类资源才尝试取正文，二进制抓回来也没用还占地
      const textual = /json|text|javascript|xml|urlencoded|x-www-form-urlencoded/i;
      if (meta.type === 'XHR' || meta.type === 'Fetch' || textual.test(String(meta.mimeType || ''))) {
        try {
          const body = await send(tabId, 'Network.getResponseBody', { requestId: params.requestId });
          if (body && typeof body.body === 'string') {
            netSink({
              kind: 'cdp',
              phase: 'body',
              tabId: tabId,
              url: meta.url,
              method: meta.method,
              body: body.body.slice(0, 20000),
              bodyTruncated: body.body.length > 20000,
              base64: !!body.base64Encoded,
              t: Date.now()
            });
          }
        } catch (e) {
          /* 响应体已被浏览器释放，属正常情况 */
        }
      }
      return;
    }

    if (method === 'Network.loadingFailed') {
      pendingRequests.delete(params.requestId);
    }
  } catch (e) {
    /* 事件处理里的异常绝不能冒泡，否则会打断 SW 的事件循环 */
  }
});
