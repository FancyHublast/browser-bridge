/**
 * Browser Bridge · 指令路由与实现
 *
 * 【设计原则：agent 不应该知道"档位"这回事】
 *   click / type / drag / screenshot 这些指令内部自己判断走轻量档（合成事件）
 *   还是增强档（CDP），对调用方完全透明。
 *   只有真正需要显式声明信任级别时，才用 cdp_* 前缀强制走 CDP。
 *   否则 agent 要记两套语义，必然用错。
 *
 * 【错误信息的原则】
 *   每一条错误都要能回答"我该怎么办"。比如 attach 失败不能只说
 *   "Another debugger is attached"，必须告诉用户去关 F12。
 *   这是自动化工具能不能被人用下去的分水岭 —— 模糊报错会让人放弃整个工具。
 */

import { initState, getState, patchState } from './state.js';
import * as cdp from './cdp.js';
import { capture } from './screenshot.js';
import * as ax from './ax.js';
import {
  contentCall,
  resolveTabId,
  listFrames,
  sleep,
  assertInjectable,
  broadcastFrames
} from './tabs.js';

// ───────────────────────── 网络记录落缓冲 ─────────────────────────

cdp.setNetSink((rec) => {
  const st = getState();
  if (!st.recording) return;
  st.net.push(Object.assign({ seq: ++st.netSeq }, rec));
  if (st.net.length > 2000) st.net.splice(0, st.net.length - 2000);
});

// ───────────────────────── 路由入口 ─────────────────────────

export async function dispatch(cmd, args, msg) {
  await initState();
  const fn = TABLE[cmd];
  if (!fn) {
    throw new Error('未知指令「' + cmd + '」\n可用指令：' + Object.keys(TABLE).join(', '));
  }
  return await fn(args || {}, msg || {});
}

// ───────────────────────── 通用小工具 ─────────────────────────

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) throw new Error('url 不能为空');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (/^localhost([:/]|$)|^127\.0\.0\.1([:/]|$)/i.test(s)) return 'http://' + s;
  return 'https://' + s;
}

/**
 * 等页面加载完成。
 * 注意：SPA 内部路由跳转不会触发 tabs.onUpdated 的 complete 事件，
 * 所以超时不当作失败抛出去，而是带一个 note 返回 —— 避免把正常情况报成故障。
 */
function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(true), timeoutMs);

    function finish(timedOut) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ timedOut: !!timedOut });
    }

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish(false);
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish(false);
      })
      .catch(() => finish(false));
  });
}

/**
 * 字符串 -> {x, y, frameId}
 * frameId 很关键：元素在主文档返回 0；在 iframe 里返回真实的 frameId。
 *
 * 注意：这里返回的 x/y 是**相对于元素所在那一帧**的视口坐标。
 * 增强档走 CDP 前必须先经 toTopPoint() 换算成顶层坐标。
 */
async function pointOf(spec, tabId) {
  if (spec && typeof spec === 'object' && spec.x != null && spec.y != null) {
    // 显式给坐标：一律按顶层视口坐标理解
    return { x: Number(spec.x), y: Number(spec.y), frameId: 0 };
  }
  if (typeof spec === 'string' && spec.trim()) {
    // contentCall 的 auto 模式会自动扫帧，命中 iframe 时回填 frameId / frameUrl
    const info = await contentCall(tabId, 'resolve_point', { target: spec });
    return { x: info.x, y: info.y, frameId: info.frameId || 0, frameUrl: info.frameUrl };
  }
  throw new Error('无法解析坐标端点：' + JSON.stringify(spec));
}

/** 两个 URL 是否指向同一份文档（忽略 query/hash —— 帧导航后 query 可能变） */
function sameDoc(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(String(a));
    const ub = new URL(String(b));
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch (e) {
    return false;
  }
}

/**
 * 求「目标帧相对顶层视口」的偏移 —— 增强档走 CDP 的必要前提。
 *
 * 【为什么必须换算，而不是直接降级】
 *   CDP 的 Input.dispatchMouseEvent 坐标是**顶层视口**的 CSS 像素；
 *   而 iframe 内元素的 getBoundingClientRect() 是相对**该帧**的。
 *   直接拿来用，结果不是「点不动」，而是**点到旁边的元素上** ——
 *   可能误触提交、删除、支付。所以早期版本选择了保守降级。
 *
 *   但降级代价很大：合成事件 isTrusted=false，遇到行为风控（淘宝滑块那类）
 *   一律被拦。影刀能过滑块，靠的正是「真实事件 + 正确坐标」两者兼备 —— 缺一不可。
 *
 * 【为什么不用 screenX 差值】
 *   最初用的是「子帧 screenX − 顶层 screenX」。真机实测**在 Chrome 155 上失效**：
 *   跨域帧的 screenX/screenY 被对齐成与顶层相同，差值恒为 0（隐私保护行为）。
 *   当时的安全校验兜住了（没有点错位置），但换算等于没做，于是每次都退回合成事件。
 *
 * 【现在怎么算】
 *   帧内脚本读不到自己在父文档里的位置（跨域读 window.frameElement 抛 SecurityError），
 *   但**父文档读得到 iframe 元素本身的几何** —— 跨域限制的是 iframe 的 *内容*，
 *   不是那个 <iframe> 标签。所以从目标帧沿父链向上，每层在父帧里按 URL 找到
 *   对应的 iframe 元素，把它的 left/top 累加起来，就是总偏移。
 *
 *   匹配不上、或匹配到多个时**拒绝猜测**（返回 error），调用方回退合成事件 ——
 *   猜错的代价是点到别的地方，比点不动严重得多。
 */
async function frameOffsetChain(tabId, frameId) {
  let frames;
  try {
    frames = await listFrames(tabId);
  } catch (e) {
    return { error: '读取帧树失败：' + String((e && e.message) || e) };
  }

  const byId = new Map(frames.map((f) => [f.frameId, f]));
  const chain = [];
  let cur = Number(frameId);
  let guard = 0;
  while (cur && cur !== 0 && guard++ < 12) {
    const f = byId.get(cur);
    if (!f) return { error: '帧树里找不到 frameId=' + cur + '（页面可能刚导航过）' };
    chain.push(f);
    cur = Number(f.parentFrameId);
  }
  if (cur !== 0) return { error: '帧嵌套过深（超过 12 层），放弃换算' };

  let ox = 0;
  let oy = 0;
  const steps = [];

  for (let i = chain.length - 1; i >= 0; i--) {
    const child = chain[i];
    const parentId = Number(child.parentFrameId);

    let list;
    try {
      list = await contentCall(tabId, 'list_iframes', {}, 5000, parentId);
    } catch (e) {
      return {
        error: '读取父帧(frameId=' + parentId + ')的 iframe 列表失败：' + String((e && e.message) || e)
      };
    }

    const arr = (list && list.iframes) || [];
    let cands = arr.filter((f) => f.src && f.src === child.url);
    if (!cands.length) cands = arr.filter((f) => sameDoc(f.src, child.url));

    if (!cands.length) {
      return {
        error:
          '在父帧(frameId=' + parentId + ')里找不到 frameId=' + child.frameId +
          ' 对应的 iframe 元素（该帧 URL 与父文档里所有 iframe 的 src 都对不上）'
      };
    }
    if (cands.length > 1) {
      return {
        error:
          '父帧里有 ' + cands.length + ' 个 URL 相同的 iframe，无法确定目标帧是哪一个' +
          '（拒绝猜测：猜错就是点到别的地方）'
      };
    }

    ox += cands[0].x;
    oy += cands[0].y;
    steps.push({
      frameId: child.frameId,
      parentFrameId: parentId,
      offsetX: Math.round(cands[0].x),
      offsetY: Math.round(cands[0].y),
      via: cands[0].id || '(无 id)'
    });
  }

  return { ox: ox, oy: oy, steps: steps };
}

/**
 * 帧内视口坐标 → 顶层视口坐标。
 * 换算不可信时返回 { convertError }，调用方据此回退合成事件 —— 绝不硬点。
 */
async function toTopPoint(tabId, pt) {
  if (!pt || !pt.frameId) return pt; // 主文档，本来就是顶层坐标

  const off = await frameOffsetChain(tabId, pt.frameId);
  if (off.error) return Object.assign({}, pt, { convertError: off.error });

  const x = pt.x + off.ox;
  const y = pt.y + off.oy;

  // 安全校验一：换算后的点必须落在**主文档里某个 iframe 的矩形内**。
  // 目标帧的任何祖先都在主文档里，所以换算正确时这必然成立 ——
  // 这一关专门挡「偏移量算错了、但恰好还没跑出视口」的情况。
  let insideAnIframe = null;
  try {
    const list = await contentCall(tabId, 'list_iframes', {}, 5000, 0);
    const arr = (list && list.iframes) || [];
    if (arr.length) {
      insideAnIframe = arr.some(
        (f) => x >= f.x - 4 && x <= f.x + f.w + 4 && y >= f.y - 4 && y <= f.y + f.h + 4
      );
    }
  } catch (e) {
    insideAnIframe = null; // 拿不到列表就不做这项判断，交给另一道校验
  }

  // 安全校验二：换算后的点跑出顶层视口 → 一定是算错了。
  // 视口尺寸取自主文档的 metrics，不再依赖子帧的 outerWidth（那个也受隐私对齐影响）。
  let vw = 0;
  let vh = 0;
  try {
    const m = await contentCall(tabId, 'metrics', {}, 5000, 0);
    vw = Number(m && m.viewportWidth) || 0;
    vh = Number(m && m.viewportHeight) || 0;
  } catch (e) {
    /* 取不到就跳过这一关 */
  }

  return Object.assign({}, pt, {
    x: x,
    y: y,
    offset: { x: off.ox, y: off.oy },
    convertChain: off.steps,
    converted: true,
    outOfViewport: vw > 0 && vh > 0 && (x < -2 || y < -2 || x > vw + 2 || y > vh + 2),
    outsideIframes: insideAnIframe === false
  });
}

/**
 * 增强档的坐标准备：解析端点 →（必要时）换算到顶层坐标 → 判断能否安全走 CDP。
 *
 * 返回 { pt, ok, note }：
 *   ok = true  → pt 的 x/y 可直接喂给 CDP
 *   ok = false → 换算不可信，调用方应回退成"该帧内的合成事件"，并把 note 透给用户
 */
async function cdpPoint(tabId, spec) {
  const raw = await pointOf(spec, tabId);
  if (!raw.frameId) return { pt: raw, ok: true };

  const conv = await toTopPoint(tabId, raw);

  if (conv.convertError || conv.outOfViewport || conv.outsideIframes) {
    const why = conv.convertError
      ? conv.convertError
      : conv.outOfViewport
        ? '换算结果落在顶层视口之外（x=' + Math.round(conv.x) + ', y=' + Math.round(conv.y) + '）'
        : '换算结果的落点不在页面里任何 iframe 范围内（说明偏移量算错了）';
    return {
      pt: conv,
      ok: false,
      note:
        '目标位于 iframe（frameId=' +
        raw.frameId +
        '）内，但跨帧坐标换算不可信（' +
        why +
        '），已回退为该帧内的合成事件（isTrusted=false）。' +
        '注意：合成事件可能被行为风控拦截。'
    };
  }

  const chainNote =
    conv.convertChain && conv.convertChain.length > 1
      ? '（跨 ' + conv.convertChain.length + ' 层嵌套帧）'
      : '';

  return {
    pt: conv,
    ok: true,
    note:
      '目标在 iframe（frameId=' +
      raw.frameId +
      '）内' +
      chainNote +
      '，已按帧偏移（+' +
      Math.round(conv.offset.x) +
      ',' +
      Math.round(conv.offset.y) +
      '）换算为顶层视口坐标后投递 CDP 真实事件。'
  };
}

/** 只保留"像接口"的记录，滤掉图片/字体/CSS 这类噪音 */
function isApiLike(r) {
  const url = r.url || '';
  if (/\.(png|jpe?g|gif|svg|webp|bmp|ico|woff2?|ttf|otf|eot|css|mp4|mp3)(\?|#|$)/i.test(url)) return false;
  if (r.kind === 'cdp' && r.resourceType && ['XHR', 'Fetch', 'Document', 'WebSocket'].indexOf(r.resourceType) === -1) {
    return false;
  }
  return true;
}

// ───────────────────────── 标签页 ─────────────────────────

async function cmdPing() {
  return { pong: true, mode: getState().mode, recording: getState().recording, at: Date.now() };
}

async function cmdStatus() {
  const st = getState();
  return {
    mode: st.mode,
    recording: st.recording,
    netBuffered: st.net.length,
    attachedTabs: cdp.attachedTabs(),
    version: chrome.runtime.getManifest().version
  };
}

async function cmdTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    count: tabs.length,
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      active: t.active,
      pinned: t.pinned,
      title: t.title,
      url: t.url,
      status: t.status,
      discarded: t.discarded
    }))
  };
}

async function cmdActiveTab(args) {
  const tabId = await resolveTabId(args.tabId);
  const tab = await chrome.tabs.get(tabId);
  let metrics = null;
  try {
    metrics = await contentCall(tabId, 'metrics');
  } catch (e) {
    metrics = { error: String((e && e.message) || e) };
  }
  return { tabId: tab.id, title: tab.title, url: tab.url, status: tab.status, metrics };
}

async function cmdGoto(args) {
  const url = normalizeUrl(args.url);
  const timeout = args.timeout || 25000;
  let tabId;
  let created = false;

  // 默认开新标签页：不打断你正在看的页面。
  // 要复用某个已有的页面，必须显式给 tabId —— 「悄悄把用户当前页导航走」是最招人烦的行为。
  if (args.tabId != null && args.tabId !== 'new' && !args.newTab) {
    tabId = await resolveTabId(args.tabId);
    await chrome.tabs.update(tabId, { url: url });
  } else {
    const tab = await chrome.tabs.create({ url: url, active: args.active !== false });
    tabId = tab.id;
    created = true;
  }

  const r = await waitForLoad(tabId, timeout);
  const tab = await chrome.tabs.get(tabId);

  return {
    tabId: tabId,
    url: tab.url,
    title: tab.title,
    createdNewTab: created,
    loaded: !r.timedOut,
    note: r.timedOut
      ? '等待加载超时（' + timeout + 'ms）。若是单页应用的内部跳转，这属正常 —— 页面通常已经就绪，可用 page_info 确认。'
      : undefined
  };
}

async function cmdNewTab(args) {
  const tab = await chrome.tabs.create({
    url: args.url ? normalizeUrl(args.url) : undefined,
    active: args.active !== false
  });
  if (args.url) await waitForLoad(tab.id, args.timeout || 25000);
  return { tabId: tab.id, url: tab.url };
}

async function cmdCloseTab(args) {
  const tabId = await resolveTabId(args.tabId);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function cmdActivateTab(args) {
  const tabId = await resolveTabId(args.tabId);
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return { tabId: tabId, url: tab.url, title: tab.title };
}

async function cmdReload(args) {
  const tabId = await resolveTabId(args.tabId);
  await chrome.tabs.reload(tabId, { bypassCache: !!args.hard });
  await waitForLoad(tabId, args.timeout || 25000);
  return { tabId: tabId, reloaded: true };
}

/**
 * 列出页面里所有 frame。
 * agent 在"元素明明看得见却查不到"时应该先调它 —— 十有八九目标在 iframe 里，
 * 而登录表单、报表内容区、弹窗壳子正是 iframe 的高发区。
 */
async function cmdFrames(args) {
  const tabId = await resolveTabId(args.tabId);
  const frames = await listFrames(tabId);

  // 顺带ping一下每个帧，确认 content script 到不到位、帧里到底是什么页面
  const out = [];
  for (const f of frames) {
    const item = {
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      isTop: f.isTop,
      crossOrigin: f.crossOrigin,
      url: f.url
    };
    if (args.probe !== false) {
      try {
        const p = await contentCall(tabId, 'ping', {}, 4000, f.frameId);
        item.title = p && p.title;
        item.injected = true;
      } catch (e) {
        item.injected = false;
        item.probeError = String((e && e.message) || e).slice(0, 120);
      }
    }
    out.push(item);
  }

  return {
    tabId: tabId,
    count: out.length,
    frames: out,
    frameHint:
      out.length > 1
        ? '这个页面有 ' + out.length + ' 个 frame。默认 frame="auto" 会自动在 iframe 里找元素；' +
          '若已知道目标在哪一帧，直接传 frame=<frameId> 可省掉扫描。'
        : '页面只有主文档，无需关心 frame 参数。'
  };
}

// ───────────────────────── 页面读取 ─────────────────────────

async function cmdPageInfo(args) {
  const tabId = await resolveTabId(args.tabId);
  const metrics = await contentCall(tabId, 'metrics', {}, undefined, args.frame);
  const out = { tabId: tabId, metrics: metrics };
  if (args.withText) {
    out.page = await contentCall(tabId, 'page_text', { maxChars: args.maxChars || 12000 }, undefined, args.frame);
  }
  return out;
}

async function cmdQuery(args) {
  if (!args.target) throw new Error('query 需要 target（定位表达式）');
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'query', args, undefined, args.frame);
}

async function cmdGetText(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'get_text', args, undefined, args.frame);
}

async function cmdGetHtml(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'get_html', args, undefined, args.frame);
}

async function cmdGetValue(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'get_value', args, undefined, args.frame);
}

async function cmdWaitFor(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'wait_for', args, (args.timeout || 15000) + 3000, args.frame);
}

/**
 * 只解析坐标，不做任何操作。
 *
 * 存在的理由：系统级（Win32 SendInput）鼠标必须拿到**屏幕物理像素**，
 * 而唯一的可信来源是"顶层视口的 CSS 坐标"（再乘 dpr、加视口原点）。
 * 本指令复用增强档那套帧偏移链（frameOffsetChain），把 iframe 内元素也换算到顶层，
 * 但**不派发任何事件** —— 换算结果到底可不可信由 reliable 如实带出，
 * 让调用方自己决定是照做还是拒绝。
 */
async function cmdPoint(args) {
  const tabId = await resolveTabId(args.tabId);
  const hasXY = args.x != null && args.y != null;
  if (!hasXY && !args.target) throw new Error('point 需要 target（定位表达式）或 x/y 坐标');

  const prep = await cdpPoint(tabId, hasXY ? { x: args.x, y: args.y } : args.target);

  return {
    tabId: tabId,
    x: prep.pt.x,
    y: prep.pt.y,
    frameId: prep.pt.frameId || 0,
    frameUrl: prep.pt.frameUrl || null,
    reliable: !!prep.ok,
    note: prep.note || null,
    hint:
      'x/y 是**顶层视口**的 CSS 像素。系统级鼠标要先换算成屏幕物理像素：' +
      '屏幕 = 视口原点 + x/y × devicePixelRatio，视口原点见 browser_page_info 的视口尺寸与窗口客户区。'
  };
}

// ───────────────────────── 页面操作 ─────────────────────────

async function cmdClick(args) {
  const tabId = await resolveTabId(args.tabId);
  const hasXY = args.x != null && args.y != null;
  const spec = hasXY ? { x: args.x, y: args.y } : args.target;

  if (getState().mode === 'debugger') {
    const prep = await cdpPoint(tabId, spec);
    if (!prep.ok) {
      // 换算不可信才降级（并说明风险），这是例外路径，不是常态
      const r = await contentCall(tabId, 'click', args, undefined, prep.pt.frameId);
      return {
        mode: 'light',
        degradedFrom: 'debugger',
        frameId: prep.pt.frameId,
        frameUrl: prep.pt.frameUrl,
        result: r,
        note: prep.note
      };
    }
    await cdp.clickAt(tabId, prep.pt.x, prep.pt.y, args);
    return {
      mode: 'debugger',
      trust: 'isTrusted',
      at: { x: prep.pt.x, y: prep.pt.y },
      frameId: prep.pt.frameId || 0,
      crossFrame: !!prep.pt.converted,
      note: prep.note || '事件由浏览器底层产生，isTrusted 为 true。'
    };
  }
  return contentCall(tabId, 'click', args, undefined, args.frame);
}

async function cmdHover(args) {
  const tabId = await resolveTabId(args.tabId);
  if (getState().mode === 'debugger') {
    const prep = await cdpPoint(tabId, args.target);
    if (!prep.ok) {
      const r = await contentCall(tabId, 'hover', args, undefined, prep.pt.frameId);
      return { mode: 'light', degradedFrom: 'debugger', frameId: prep.pt.frameId, result: r, note: prep.note };
    }
    await cdp.moveTo(tabId, prep.pt.x, prep.pt.y);
    return {
      mode: 'debugger',
      at: { x: prep.pt.x, y: prep.pt.y },
      frameId: prep.pt.frameId || 0,
      crossFrame: !!prep.pt.converted,
      note: prep.note
    };
  }
  return contentCall(tabId, 'hover', args, undefined, args.frame);
}

async function cmdType(args) {
  if (args.text == null) throw new Error('type 需要 text');
  const tabId = await resolveTabId(args.tabId);

  if (getState().mode === 'debugger') {
    const prep = await cdpPoint(tabId, args.target);

    if (!prep.ok) {
      // 换算不可信才降级：合成事件要自己负责聚焦和清空，actions.type 已经做了
      const r = await contentCall(tabId, 'type', args, undefined, prep.pt.frameId);
      return {
        mode: 'light',
        degradedFrom: 'debugger',
        frameId: prep.pt.frameId,
        result: r,
        note: prep.note
      };
    }

    const pt = prep.pt;
    // 先用真实点击聚焦，否则键盘事件没有落点
    await cdp.clickAt(tabId, pt.x, pt.y, { clickCount: 1 });

    if (args.clear !== false) {
      // Ctrl+A 全选再 Delete。modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2
      });
      await cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2
      });
      await sleep(40);
      await cdp.pressKey(tabId, 'Delete');
      await sleep(60);
    }

    const text = String(args.text);
    await cdp.typeText(tabId, text, args);

    if (args.pressEnter) {
      await cdp.pressKey(tabId, 'Enter');
    }

    // 回读核对 —— 输入类操作不做回读等于没做（带上帧号，省一次扫帧）
    const v = await contentCall(tabId, 'get_value', args, undefined, pt.frameId || 0).catch(() => null);
    const actual = v ? v.value : null;
    return {
      mode: 'debugger',
      trust: 'isTrusted',
      frameId: pt.frameId || 0,
      crossFrame: !!pt.converted,
      expected: text,
      actual: actual,
      match: actual == null ? null : actual === text,
      note: actual == null ? '无法回读目标值（可能不是输入框），请人工确认' : prep.note
    };
  }

  return contentCall(tabId, 'type', args, undefined, args.frame);
}

async function cmdPress(args) {
  if (!args.key) throw new Error('press 需要 key（如 Enter / Tab / Escape / ArrowDown）');
  const tabId = await resolveTabId(args.tabId);
  if (getState().mode === 'debugger') {
    let prep = null;
    if (args.target) prep = await cdpPoint(tabId, args.target);
    if (prep && !prep.ok) {
      const r = await contentCall(tabId, 'press', args, undefined, prep.pt.frameId);
      return { mode: 'light', degradedFrom: 'debugger', frameId: prep.pt.frameId, result: r, note: prep.note };
    }
    if (prep) await cdp.clickAt(tabId, prep.pt.x, prep.pt.y, {});
    await cdp.pressKey(tabId, args.key);
    return {
      mode: 'debugger',
      key: args.key,
      trust: 'isTrusted',
      frameId: prep ? prep.pt.frameId || 0 : 0
    };
  }
  return contentCall(tabId, 'press', args, undefined, args.frame);
}

async function cmdScroll(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'scroll', args, undefined, args.frame);
}

async function cmdDrag(args) {
  if (!args.from || !args.to) throw new Error('drag 需要 from 与 to（坐标 {x,y} 或定位表达式）');
  const tabId = await resolveTabId(args.tabId);
  if (getState().mode === 'debugger') {
    const a = await cdpPoint(tabId, args.from);
    const b = await cdpPoint(tabId, args.to);
    if (!a.ok || !b.ok) {
      const frameId = a.pt.frameId || b.pt.frameId;
      const r = await contentCall(tabId, 'drag', args, undefined, frameId);
      return {
        mode: 'light',
        degradedFrom: 'debugger',
        frameId: frameId,
        result: r,
        note: a.note || b.note
      };
    }
    const r = await cdp.dragAt(tabId, a.pt, b.pt, args);
    return Object.assign(
      {
        from: { x: a.pt.x, y: a.pt.y },
        to: { x: b.pt.x, y: b.pt.y },
        frameId: a.pt.frameId || b.pt.frameId || 0,
        crossFrame: !!(a.pt.converted || b.pt.converted),
        note: a.note || b.note
      },
      r
    );
  }
  return contentCall(tabId, 'drag', args, undefined, args.frame);
}

async function cmdElementAt(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'element_at', { x: args.x, y: args.y }, undefined, args.frame);
}

// ───────────────────────── 描述符定位与元素拾取 ─────────────────────────

/**
 * 同一时刻只允许一个拾取会话。
 * 人只有一只鼠标，两个会话抢同一套事件监听必然互相打断 —— 不如直接串行化。
 */
let pendingPick = null;

/**
 * content 侧拾取结果回填。由 service-worker.js 的消息入口调过来。
 *
 * 【为什么不走 contentCall 的请求-响应】
 *   拾取的完成时刻由**人**决定（可能 2 秒，也可能 50 秒），
 *   而 contentCall 是"发出后等一个确定性的回执"的模型，超时机制会先把这条腿掐断。
 *   所以拾取拆成两段：pick_start 立刻返回"已进入拾取模式"，
 *   真正的结果由页面**主动推**回来（__bb_pick_result），在这里对上号。
 */
export function resolvePick(msg, sender) {
  if (!pendingPick) return false;
  const p = pendingPick;

  // ── 会话校验：只收「本次会话 + 本标签页」推回来的结果 ──
  // 为什么必须校验：拾取的完成时刻由人决定，也就意味着**结果可能来得比预期晚**。
  // 典型串号场景：上一次拾取已经超时收尾、新的拾取会话刚开始，
  // 这时旧页面那条迟到的结果才飘回来 —— 不校验就会把它当成新会话的结果交出去。
  // 校验不通过时**不消费** pendingPick，让真正该来的那条结果还能正常对上号。
  if (p.sessionId && msg && msg.sessionId && msg.sessionId !== p.sessionId) return false;
  const fromTab = sender && sender.tab && sender.tab.id;
  if (fromTab != null && p.tabId != null && fromTab !== p.tabId) return false;

  pendingPick = null;
  if (p.timer) clearTimeout(p.timer);
  if (msg && msg.ok) p.resolve(msg.data);
  else p.reject(new Error((msg && (msg.error || '拾取失败')) || '拾取失败'));
  return true;
}

/**
 * 在**一个标签页的所有帧**里同时起一次拾取会话。
 *
 * 【为什么不用 chrome.tabs.sendMessage + broadcastFrames】
 *   v1.2.0 的实现是逐帧 chrome.tabs.sendMessage(...{frameId:fid})，但 picker 当时只在主文档跑，
 *   iframe 里的 content scripts 根本不存在 — broadcastFrames 就是在对空房间喊话，结果是"好像广播了，
 *   其实没用"。Esc 失效、iframe 内元素拾取不到的根因全在这一处。
 *
 *   v1.3.0 picker 改在每帧各跑一份本地实例，于是用 chrome.runtime.sendMessage 一次广播即可：
 *   它在 service worker 里发出，会被**所有 frame 的 content scripts**的 chrome.runtime.onMessage 收到
 *   （不需要 frameId，也不需要逐帧循环）。
 *
 * 【sessionId 为什么由这里统一生成】
 *   最终只有一个帧会真正收到点击并上报结果。若各帧自己生成 id，
 *   resolvePick 的 sessionId 校验会把这份正确结果当成串号数据丢掉。
 */
export async function startPickSession(tabId, opts) {
  const o = opts || {};
  const sid = 'pk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const args = {
    sessionId: sid,
    hint: o.hint || '',
    anchor: o.anchor === 'raw' ? 'raw' : 'semantic',
    multi: !!o.multi,
    manual: !!o.manual,
    name: o.name || ''
  };

  /**
   * 【为什么用 broadcastFrames，而不是 chrome.runtime.sendMessage 广播】
   *   runtime.sendMessage 会把消息投给**每一个标签页的每一帧**：
   *   你开着五个标签页，五个页面会同时进入拾取模式，人在哪张页面点都算数。
   *   而 picker 侧没有过滤手段 —— content script 收消息时看不到发送方的 tab
   *   （onMessage 的 sender 指的是发消息的那一方，即 SW），所以 msg.tabId 也没法用来判断。
   *
   *   broadcastFrames 走 chrome.tabs.sendMessage(tabId, msg, {frameId})，两个好处：
   *     ① 天然只投到目标标签页，不再污染其他页面；
   *     ② 每帧投递前先 ensureInjected —— 扩展重载后那些"老 iframe"里的拾取器
   *        就是靠这一步补上的。否则消息发过去没人接，
   *        症状正是"主文档能拾、iframe 里拾不到"。
   *   顺带还能拿到"真正送达了哪几帧"，出问题时有据可查。
   */
  let delivered = [];
  try {
    delivered = await broadcastFrames(tabId, {
      __bb_picker: true,
      type: 'pick_start',
      sessionId: sid,
      args: args,
      origin: 'sw',
      tabId: tabId
    });
  } catch (e) {
    return { sessionId: sid, error: String((e && e.message) || e), frames: [] };
  }

  if (!delivered.length) {
    return {
      sessionId: sid,
      error: '目标页没有任何一帧接受拾取会话（页面可能正在跳转，或该页禁止注入脚本）',
      frames: []
    };
  }
  return { sessionId: sid, frames: delivered };
}

/**
 * 收掉一个标签页里所有帧的拾取会话。
 * 不带 sessionId = 对所有 frame 的活跃会话一并收尾（超时/被替换场景需要）
 *
 * 与 startPickSession 同一条通道（tabs.sendMessage 定向到目标页的每一帧）——
 * 若这里还用 runtime.sendMessage 广播，收尾信会撒到所有标签页，
 * 把别的页面上正在进行的拾取一并打断。
 */
export async function stopPickSession(tabId, reason, sessionId) {
  try {
    await broadcastFrames(tabId, {
      __bb_picker: true,
      type: 'pick_end',
      sessionId: sessionId || null,
      reason: reason || '拾取结束'
    });
  } catch (e) {
    /* 收尾失败不该把调用方卡住：会话自身的超时逻辑会兜底 */
  }
}

async function cmdPick(args) {
  const tabId = await resolveTabId(args.tabId);
  const timeoutMs = Math.max(5000, Number(args.timeout || 60) * 1000);

  // 上一个会话还挂着就先收掉，避免两套监听打架
  if (pendingPick) {
    const old = pendingPick;
    pendingPick = null;
    if (old.timer) clearTimeout(old.timer);
    if (old.tabId) {
      // 旧会话可能横跨多个帧（iframe 场景），必须全部广播收尾，不能只收主文档
      await stopPickSession(old.tabId, '被新的拾取请求替换', old.sessionId);
    }
    old.reject(new Error('上一次拾取会话被新的请求替换'));
  }

  const started = await startPickSession(tabId, {
    hint: args.hint,
    anchor: args.anchor === 'raw' ? 'raw' : 'semantic',
    multi: !!args.multi,
    name: args.name || '',
    manual: !!args.manual
  });

  // 一帧都没接受会话（页面正在跳转 / 禁止注入）→ 立刻失败。
  // 不能干等超时：那样用户会以为是"自己没点对"，实际上是遮罩压根没挂上去。
  if (started.error) {
    throw new Error('拾取会话未能启动：' + started.error);
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingPick) return;
      const sid = pendingPick.sessionId;
      pendingPick = null;
      // 超时也要把页面上的拾取模式收掉（所有帧），否则用户会看到一个再也关不掉的遮罩
      stopPickSession(tabId, '拾取超时', sid);
      reject(
        new Error(
          '拾取超时（' + Math.round(timeoutMs / 1000) + ' 秒内没有收到页面上的点击）。\n' +
            '注意：确认拾取要按住 Ctrl 再点左键（单独左键只是预览，不会拾取）。\n' +
            '可能原因：目标标签页不在前台（用户看不到高亮框），或用户没有点击。\n' +
            '建议：先 browser_activate_tab 把页面切到前台，并明确告诉用户"请按住 Ctrl 点击目标元素"。'
        )
      );
    }, timeoutMs);

    pendingPick = {
      resolve: resolve,
      reject: reject,
      timer: timer,
      tabId: tabId,
      sessionId: started.sessionId
    };
  });
}

/**
 * 语义树（Accessibility Tree）定位。
 *
 * 按 role / name 找控件，而不是按 DOM 结构 —— 前端把 DOM 重写一遍、
 * 给类名加个哈希，选择器就废了，但"这是个输入框、它叫账号"不会变。
 *
 * action:
 *   tree   取整棵语义树（精简过，默认滤掉无信息量的容器节点）
 *   query  按 role/name 查节点，返回节点 + 屏幕坐标
 *   click  按语义点击（走 CDP 真实事件）
 */
async function cmdAx(args) {
  const tabId = await resolveTabId(args.tabId);
  const action = args.action === 'click' ? 'click' : args.action === 'query' ? 'query' : 'tree';

  if (action === 'tree') {
    return ax.axTree(tabId, { withGeneric: !!args.withGeneric });
  }

  const q = {
    role: args.role,
    name: args.name,
    nameContains: args.nameContains,
    value: args.value,
    frameId: args.frameId
  };

  if (action === 'query') {
    return ax.axQuery(tabId, q, { limit: args.limit, withRect: args.withRect !== false });
  }

  return ax.axClick(tabId, q, {
    index: args.index,
    allowAmbiguous: !!args.allowAmbiguous,
    humanLike: args.humanLike !== false
  });
}

async function cmdFind(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'find', args, undefined, args.frame);
}

/**
 * 把「一个选择器」升级成「一份可复用的描述符」—— 元素库落盘的入口。
 *
 * 【为什么要它】
 *   选择器一改版就归零，描述符（多属性加权）才能扛。但描述符必须在页面里、
 *   对着真实元素生成（要读一堆属性、还要做候选打分），所以只能由 content 层做。
 *   有了它，agent 就能把「这次好不容易定位到的元素」固化下来，
 *   而不是下次开页面再从零扫一遍。
 */
async function cmdDescribe(args) {
  const tabId = await resolveTabId(args.tabId);
  return contentCall(tabId, 'describe', args, undefined, args.frame);
}

// ───────────────────────── 手动拾取结果的存取 ─────────────────────────

const PICKS_KEY = 'bb_picks';
/** 上限只是防止有人在页面上点几百次把 storage 撑爆；正常攒个十几个完全够用 */
const PICKS_MAX = 50;

/**
 * 把人手动拾取（Alt+Shift+A）的结果落盘。
 *
 * 【为什么要单独存一份】
 *   agent 发起的拾取有 pendingPick 接住，人到手即走；手动拾取没有接收方，
 *   不存就真的没了。落盘之后人可以先攒一批、agent 过一会儿再来取 ——
 *   这才是"人先示教、agent 后执行"该有的样子。
 *
 * 【同名覆盖】
 *   每条 item 现在带 name（agent 传 / 自动生成）。同 name 视为"人对同一元素又示教了一遍"，
 *   直接覆盖最新版本 —— 不然攒几天下来满屏都是"确定"按钮的不同版本。
 *
 * @returns {Promise<number>} 存完之后的总条数
 */
export async function storeManualPick(data, sender) {
  if (!data) return 0;

  // 单元素与连续拾取是两种 payload，统一摊平成条目数组。
  // multi=true 时 items 的顺序是"用户点的顺序"（先点的在前），
  // 落盘后最新要在最前 → 倒过来。slice() 防原地改源。
  const sourceItems = (data.multi && Array.isArray(data.items) ? data.items : [data]).slice().reverse();

  const now = Date.now();
  const srcUrl = (sender && sender.tab && sender.tab.url) || '';
  const rows = sourceItems
    .filter(function (it) {
      return it && it.descriptor;
    })
    .map(function (it) {
      // name 沿用 picker 已经写好的；SW 不再生成 —— 让 picker 拥有命名权
      return {
        ts: now,
        pickedAt: it.pickedAt || now,
        name: it.name || '',
        url: it.url || srcUrl,
        title: it.title || '',
        summary: it.summary || '',
        descriptor: it.descriptor,
        quality: it.quality || null,
        strict: !!it.strict,
        frameId: it.frameId != null ? it.frameId : 0,
        frameUrl: it.frameUrl || it.url || srcUrl
      };
    });

  if (!rows.length) return 0;

  const got = await chrome.storage.local.get(PICKS_KEY);
  const list = Array.isArray(got[PICKS_KEY]) ? got[PICKS_KEY] : [];

  // 同 name 覆盖：先去掉旧的同名项，再插新的放最前
  const incomingNames = new Set(rows.map((r) => r.name).filter(Boolean));
  const filtered = incomingNames.size
    ? list.filter((r) => !r.name || !incomingNames.has(r.name))
    : list;
  const next = rows.concat(filtered).slice(0, PICKS_MAX);
  await chrome.storage.local.set({ [PICKS_KEY]: next });
  return next.length;
}

/**
 * 读取 / 按名挑选 / 删除单条 / 清空手动拾取的历史。
 *
 * action:
 *   list    取回全部（默认）
 *   get     取回名字等于 name 的那一条；模糊时按"包含"匹配，取第一条
 *   drop    删除名字等于 name 的那一条，返回剩下几条
 *   clear   清空，返回清掉了几条
 */
async function cmdPicks(args) {
  const action = args.action || 'list';
  const wantName = (args.name || '').toString().trim();
  const got = await chrome.storage.local.get(PICKS_KEY);
  const list = Array.isArray(got[PICKS_KEY]) ? got[PICKS_KEY] : [];

  function findByName(arr) {
    if (!wantName) return null;
    // 先精确，再"包含"
    let hit = arr.find((r) => r && r.name === wantName);
    if (hit) return hit;
    hit = arr.find((r) => r && r.name && r.name.indexOf(wantName) >= 0);
    return hit || null;
  }

  if (action === 'clear') {
    await chrome.storage.local.remove(PICKS_KEY);
    return { cleared: list.length, remaining: 0 };
  }

  if (action === 'get') {
    const hit = findByName(list);
    return {
      found: !!hit,
      name: wantName,
      item: hit || null,
      count: list.length,
      how_to_use:
        '把 item.descriptor 原样存下来，调用 browser_find / browser_click 时传给 target 参数' +
        '（以 { 开头的字符串会被识别为描述符）。'
    };
  }

  if (action === 'drop') {
    if (!wantName) {
      return { ok: false, error: 'drop 需要 name 参数' };
    }
    const before = list.length;
    const kept = list.filter((r) => !r.name || r.name !== wantName);
    await chrome.storage.local.set({ [PICKS_KEY]: kept });
    return { dropped: before - kept.length, remaining: kept.length };
  }

  // 默认 list
  return {
    count: list.length,
    limit: PICKS_MAX,
    items: list,
    how_to_use:
      '把 item.descriptor 原样存下来，调用 browser_find / browser_click 时传给 target 参数' +
      '（以 { 开头的字符串会被识别为描述符）。'
  };
}

/**
 * 在页面里执行 JS。
 * 轻量档走 scripting.executeScript；增强档走 CDP Runtime.evaluate（不受页面 CSP 限制）。
 * 轻量档若因 CSP 被拦，要明确告诉用户"切增强档"—— 这是最常见的困惑点。
 */
async function cmdEvaluate(args) {
  if (!args.expression) throw new Error('evaluate 需要 expression');
  const tabId = await resolveTabId(args.tabId);

  // frame 只支持"主文档"或"明确的数字 frameId"。默认 auto 直接落到主文档 ——
  // 在 iframe 里跑一段任意 JS 属于高危操作，不该由"猜"决定跑在哪一帧。
  const rawFrame = args.frame;
  const fid =
    rawFrame == null || rawFrame === 'auto' || rawFrame === 'top' ? 0 : Number(rawFrame);
  if (Number.isNaN(fid)) {
    throw new Error('evaluate 的 frame 参数只能填数字 frameId，或 "auto" / "top"');
  }

  if (getState().mode === 'debugger' && fid === 0) {
    return { mode: 'debugger', value: await cdp.evaluate(tabId, String(args.expression), args) };
  }

  const world = args.world === 'main' ? 'MAIN' : 'ISOLATED';
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [fid] },
      world: world,
      args: [String(args.expression), !!args.awaitPromise],
      func: async (expr, awaitIt) => {
        try {
          // eslint-disable-next-line no-new-func
          const f = new Function('"use strict"; return (' + expr + ');');
          let v = f();
          if (awaitIt && v && typeof v.then === 'function') v = await v;
          let json;
          try {
            json = JSON.stringify(v);
          } catch (e) {
            json = String(v);
          }
          return { ok: true, type: typeof v, value: json, size: json ? json.length : 0 };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }
    });
  } catch (e) {
    throw new Error(
      '脚本注入被拒绝：' +
        String((e && e.message) || e) +
        '\n最常见的原因是**轻量档**下 MV3 扩展的 CSP 禁止 new Function（表现为 "unsafe-eval" 被拦）。' +
        '\n处理：先 browser_mode("debugger") 切增强档（走 CDP，不受扩展 CSP 约束），再重试。'
    );
  }

  const r = results && results[0] ? results[0].result : null;
  if (!r) {
    throw new Error(
      '页面没有返回结果（frameId=' + fid + ' 可能是受限帧或已销毁）。可先用 browser_frames 看有哪些帧。'
    );
  }
  if (!r.ok) {
    throw new Error(
      '页面执行出错：' +
        r.error +
        '\n提示：若报错内容与 CSP / unsafe-eval 有关，说明该页面的内容安全策略禁止了轻量档的动态执行，' +
        '请切换到「增强档」后重试（增强档走浏览器调试协议，不受页面 CSP 约束）。'
    );
  }
  return {
    mode: 'light',
    world: world.toLowerCase(),
    frameId: fid,
    type: r.type,
    value: r.value,
    size: r.size,
    note:
      getState().mode === 'debugger' && fid !== 0
        ? '目标在 iframe 内，增强档的 CDP 求值不支持指定帧，已自动改用该帧内的注入执行。'
        : undefined
  };
}

// ───────────────────────── 截图 ─────────────────────────

async function cmdScreenshot(args) {
  const tabId = await resolveTabId(args.tabId);
  const r = await capture(tabId, args);
  // base64 太大，直接塞进回执会撑爆日志；这里只回摘要 + 数据本体
  return {
    tabId: tabId,
    mode: r.mode,
    fullPage: !!r.fullPage,
    element: !!r.element,
    mime: r.mime,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    tiles: r.tiles,
    warnings: r.warnings,
    // 数据本体放在 data 字段，由本地服务落盘后转成文件路径给 agent
    data: r.data
  };
}

// ───────────────────────── Cookie ─────────────────────────

async function cmdCookies(args) {
  const filter = {};
  if (args.url) filter.url = args.url;
  else if (args.domain) filter.domain = args.domain;
  else {
    const tabId = await resolveTabId(args.tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error('当前页面不是 http(s) 页面，拿不到 Cookie。请指定 url 或先切到目标站点。');
    }
    filter.url = tab.url;
  }
  if (args.name) filter.name = args.name;

  const list = await chrome.cookies.getAll(filter);
  const includeValue = args.withValue !== false;

  return {
    count: list.length,
    domains: Array.from(new Set(list.map((c) => c.domain))),
    filter: filter,
    cookies: list.map((c) => ({
      name: c.name,
      value: includeValue ? c.value : '<已省略>',
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expirationDate: c.expirationDate
    })),
    // 现成的请求头串，agent 拿去直接能用
    header: includeValue ? list.map((c) => c.name + '=' + c.value).join('; ') : undefined
  };
}

async function cmdSetCookie(args) {
  if (!args.url || !args.name) throw new Error('set_cookie 需要 url 与 name');
  const detail = {
    url: args.url,
    name: args.name,
    value: String(args.value == null ? '' : args.value),
    path: args.path || '/',
    secure: args.secure !== false,
    httpOnly: !!args.httpOnly
  };
  if (args.domain) detail.domain = args.domain;
  if (args.expirationDate) detail.expirationDate = Number(args.expirationDate);
  if (args.sameSite) detail.sameSite = args.sameSite;

  const c = await chrome.cookies.set(detail);
  return { ok: !!c, cookie: c ? { name: c.name, domain: c.domain, path: c.path } : null };
}

async function cmdClearCookies(args) {
  const filter = {};
  if (args.url) filter.url = args.url;
  else if (args.domain) filter.domain = args.domain;
  else throw new Error('clear_cookies 需要 url 或 domain —— 不清不楚地批量删 Cookie 太危险，必须指明范围');
  if (args.name) filter.name = args.name;

  const list = await chrome.cookies.getAll(filter);
  let removed = 0;
  for (const c of list) {
    const proto = c.secure ? 'https://' : 'http://';
    const host = c.domain.replace(/^\./, '');
    const url = proto + host + c.path;
    try {
      const r = await chrome.cookies.remove({ url: url, name: c.name, storeId: c.storeId });
      if (r) removed++;
    } catch (e) {
      /* 单条失败不影响整体 */
    }
  }
  return { matched: list.length, removed: removed };
}

// ───────────────────────── 网络抓包 ─────────────────────────

async function cmdNetStart(args) {
  const tabId = args.tabId != null ? await resolveTabId(args.tabId) : null;
  await patchState({ recording: true });

  let cdpEnabled = false;
  if (getState().mode === 'debugger' && tabId != null) {
    try {
      await cdp.networkStart(tabId);
      cdpEnabled = true;
    } catch (e) {
      cdpEnabled = false;
    }
  }

  return {
    recording: true,
    mode: getState().mode,
    tabId: tabId,
    cdpNetwork: cdpEnabled,
    note:
      getState().mode === 'debugger'
        ? '已开启全量抓包（含图片/字体等所有资源，正文仅文本类）。'
        : '轻量档抓包只覆盖页面自身发起的 fetch / XMLHttpRequest；要连资源加载一起抓、并且拿到完整响应体，请切「增强档」。'
  };
}

async function cmdNetStop() {
  await patchState({ recording: false });
  const st = getState();
  for (const tabId of cdp.attachedTabs()) {
    await cdp.networkStop(tabId).catch(() => {});
  }
  return { recording: false, buffered: st.net.length };
}

async function cmdNetList(args) {
  const st = getState();
  let list = st.net.slice();

  if (args.tabId != null) {
    const id = Number(args.tabId);
    list = list.filter((r) => r.tabId === id);
  }
  if (args.urlContains) list = list.filter((r) => (r.url || '').indexOf(args.urlContains) !== -1);
  if (args.method) {
    const m = String(args.method).toUpperCase();
    list = list.filter((r) => String(r.method || '').toUpperCase() === m);
  }
  if (args.status != null) list = list.filter((r) => Number(r.status) === Number(args.status));
  if (args.phase) list = list.filter((r) => r.phase === args.phase);
  if (args.onlyApi !== false) list = list.filter(isApiLike);

  const limit = args.limit || 100;
  const sliced = list.slice(-limit);

  return {
    recording: st.recording,
    totalBuffered: st.net.length,
    matched: list.length,
    returned: sliced.length,
    truncated: list.length > sliced.length,
    records: sliced.map((r) => ({
      seq: r.seq,
      phase: r.phase,
      kind: r.kind,
      method: r.method,
      url: r.url,
      status: r.status,
      ms: r.ms,
      resourceType: r.resourceType,
      // 正文默认不带上，避免一口气把上下文撑爆；需要时用 bodyOf 参数
      body: args.withBody ? r.body : undefined
    }))
  };
}

async function cmdNetClear() {
  const st = getState();
  const n = st.net.length;
  st.net.length = 0;
  st.netSeq = 0;
  return { cleared: n };
}

/** 取单条记录的完整正文 */
async function cmdNetBody(args) {
  if (args.seq == null) throw new Error('net_body 需要 seq（来自 net_list 的返回）');
  const st = getState();
  const rec = st.net.find((r) => r.seq === Number(args.seq));
  if (!rec) throw new Error('找不到 seq=' + args.seq + ' 的记录（缓冲可能已被清空）');
  return {
    seq: rec.seq,
    url: rec.url,
    method: rec.method,
    status: rec.status,
    body: rec.body,
    bodyTruncated: rec.bodyTruncated,
    base64: rec.base64
  };
}

// ───────────────────────── 档位与面板 ─────────────────────────

async function cmdMode(args) {
  if (args.set === 'light' || args.set === 'debugger') {
    await patchState({ mode: args.set });
    if (args.set === 'light') {
      // 切回轻量档立刻释放 CDP，别让"正在调试"的黄条一直挂着
      await cdp.detachAll();
      for (const t of await chrome.tabs.query({})) {
        if (t.id) {
          chrome.tabs
            .sendMessage(t.id, { __bb: true, action: 'panel_state', args: { mode: 'light' } }, { frameId: 0 })
            .catch(() => {});
        }
      }
    }
  }
  return {
    mode: getState().mode,
    attachedTabs: cdp.attachedTabs(),
    note:
      getState().mode === 'debugger'
        ? '增强档：点击/输入/拖拽走 CDP 真实事件（isTrusted=true），支持全页截图与全量抓包。浏览器顶部会出现"正在调试"提示条，且该页的 F12 无法同时打开。'
        : '轻量档：合成 DOM 事件，无提示条、可用 F12。适合绝大多数页面；遇到拖拽失效或风控校验请切增强档。'
  };
}

async function cmdPanel(args) {
  const tabId = await resolveTabId(args.tabId);
  // 面板只挂在主文档，别去 iframe 里找
  return contentCall(tabId, 'panel_visible', { visible: args.visible !== false }, undefined, 'top');
}

// ───────────────────────── 指令表 ─────────────────────────

const TABLE = {
  // 基础
  ping: cmdPing,
  status: cmdStatus,
  mode: cmdMode,

  // 标签页
  tabs: cmdTabs,
  active_tab: cmdActiveTab,
  goto: cmdGoto,
  new_tab: cmdNewTab,
  close_tab: cmdCloseTab,
  activate_tab: cmdActivateTab,
  reload: cmdReload,

  // 读取
  frames: cmdFrames,
  page_info: cmdPageInfo,
  query: cmdQuery,
  get_text: cmdGetText,
  get_html: cmdGetHtml,
  get_value: cmdGetValue,
  wait_for: cmdWaitFor,
  element_at: cmdElementAt,
  point: cmdPoint,
  evaluate: cmdEvaluate,

  // 描述符定位与拾取
  find: cmdFind,
  describe: cmdDescribe,
  ax: cmdAx,
  picks: cmdPicks,
  pick: cmdPick,

  // 操作
  click: cmdClick,
  hover: cmdHover,
  type: cmdType,
  press: cmdPress,
  scroll: cmdScroll,
  drag: cmdDrag,

  // 截图
  screenshot: cmdScreenshot,

  // 凭据
  cookies: cmdCookies,
  set_cookie: cmdSetCookie,
  clear_cookies: cmdClearCookies,

  // 网络
  net_start: cmdNetStart,
  net_stop: cmdNetStop,
  net_list: cmdNetList,
  net_clear: cmdNetClear,
  net_body: cmdNetBody,

  // UI
  panel: cmdPanel
};

export const COMMANDS = Object.keys(TABLE);
export { assertInjectable };
