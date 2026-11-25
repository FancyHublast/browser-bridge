/**
 * Browser Bridge · 语义树定位（ax）
 *
 * 【为什么需要它 —— DOM 之外还有一层更稳的东西】
 *   选择器（CSS / XPath）绑的是 DOM 结构：前端重写一遍 DOM、给类名加个哈希、
 *   多包一层 div，选择器就归零了。
 *   但**页面的语义是稳定的**：一个输入框不管外面套了几层 div，它还是 textbox；
 *   按钮上的字不管用什么标签实现，用户看到的还是"登录"。
 *
 *   这层语义浏览器自己就有一份 —— 无障碍树（Accessibility Tree，简称 AX 树）。
 *   屏幕阅读器读的就是它。CDP 的 `Accessibility.getFullAXTree` 能把整棵吐出来：
 *   每个节点自带 role（button / textbox / checkbox / link…）、name、value、状态。
 *
 *   按 `role=textbox, name=账号` 定位，比 `#app > div > form > input:nth-child(2)`
 *   抗改版能力强一个数量级 —— 这就是桌面 RPA 在 Windows 上走 UIAutomation 的同一个思路，
 *   浏览器里的等价物就是 AX 树。
 *
 * 【它在这一层，不在 content 层】
 *   AX 树**只有 CDP 能拿**，content script 拿不到（DOM 里的 role / aria-* 只是它的一小部分投影）。
 *   所以本文件在 service worker 侧，走 cdp.js 的通道。
 *
 * 【副作用要管住】
 *   调 CDP 必须先 debugger.attach，而 attach 会在浏览器顶部挂一条"正在调试此浏览器"的黄条。
 *   所以：增强档（本来就已经附着）直接用；轻量档**临时附着、用完立刻 detach**，
 *   不能因为一次查询就把黄条长期留在用户浏览器上。
 *
 * 【顺带的两个能力】
 *   ① 跨帧：AX 节点带 frameId，一次调用能同时看到 iframe 里的语义节点 ——
 *      千牛 / 生意参谋这类把登录框放 iframe 里的页面，靠它能直接看到框里的控件。
 *   ② 坐标：用 DOM.getBoxModel 把 backendDOMNodeId 换成屏幕矩形，
 *      于是"按语义点击"变成可能：browser_ax(action="click", role="button", name="登录")。
 */
import * as cdp from './cdp.js';

/** 一次最多返回多少节点。AX 树在复杂页面上能上万，全吐回来既慢又没用 */
const MAX_NODES = 400;

/** 常见的"没信息量"角色，默认不返回（可通过 withGeneric=true 要回来） */
const GENERIC_ROLES = new Set([
  'generic',
  'none',
  'RootWebArea',
  'paragraph',
  'LineBreak',
  'text',
  'InlineTextBox',
  'StaticText'
]);

function str(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.value === 'string') return v.value;
  return '';
}

/**
 * 取整棵 AX 树（精简过的）。
 *
 * @param {number} tabId
 * @param {object} [opt] { withGeneric:boolean }
 * @returns {Promise<{nodes:Array, detached:boolean}>}
 */
export async function axTree(tabId, opt) {
  const o = opt || {};
  const wasAttached = cdp.isAttached(tabId);
  await cdp.ensureAttached(tabId);

  let payload;
  try {
    payload = await cdp.send(tabId, 'Accessibility.getFullAXTree', {});
  } finally {
    // 轻量档下临时附着的，用完就撤 —— 不留黄条
    if (!wasAttached) await cdp.detach(tabId).catch(() => {});
  }

  const raw = (payload && payload.nodes) || [];
  const nodes = [];

  for (let i = 0; i < raw.length && nodes.length < MAX_NODES; i++) {
    const n = raw[i];
    if (!n || n.ignored) continue;
    const role = str(n.role);
    if (!o.withGeneric && (GENERIC_ROLES.has(role) || !role)) continue;

    const name = str(n.name);
    // 没有名字也没有值的节点基本没有定位价值（无名容器），默认过滤掉
    if (!o.withGeneric && !name && !str(n.value)) continue;

    nodes.push({
      nodeId: n.nodeId,
      backendNodeId: n.backendDOMNodeId || null,
      role: role,
      name: name.slice(0, 120),
      value: str(n.value).slice(0, 120),
      description: str(n.description).slice(0, 120),
      frameId: n.frameId != null ? n.frameId : null,
      childIds: n.childIds || []
    });
  }

  return {
    count: nodes.length,
    total: raw.length,
    truncated: raw.length > nodes.length,
    nodes: nodes,
    hint:
      'role + name 就是定位用的语义坐标。要点击某个节点用 browser_ax 的 action="click" 带上同样的 role/name。'
  };
}

/**
 * 按语义条件在 AX 树里找节点，并补上屏幕坐标。
 *
 * @param {object} q { role, name, nameContains, value, frameId }
 */
export async function axQuery(tabId, q, opt) {
  const o = opt || {};
  const query = q || {};
  const limit = Math.min(Math.max(Number(o.limit) || 10, 1), 50);

  const tree = await axTree(tabId, { withGeneric: !!o.withGeneric });
  const wantRole = query.role ? String(query.role).toLowerCase() : '';
  const wantName = query.name != null ? String(query.name) : '';
  const wantContains = query.nameContains != null ? String(query.nameContains) : '';
  const wantValue = query.value != null ? String(query.value) : '';

  let hits = tree.nodes.filter(function (n) {
    if (wantRole && String(n.role).toLowerCase() !== wantRole) return false;
    if (wantName && n.name !== wantName) return false;
    if (wantContains && n.name.indexOf(wantContains) === -1) return false;
    if (wantValue && n.value !== wantValue) return false;
    if (query.frameId != null && n.frameId !== Number(query.frameId)) return false;
    return true;
  });

  if (!hits.length) {
    return {
      matched: 0,
      query: query,
      // 把"页面上都叫什么"回一部分，比干巴巴说没找到有用得多
      suggestions: tree.nodes
        .filter(function (n) {
          return !wantRole || String(n.role).toLowerCase() === wantRole;
        })
        .slice(0, 12)
        .map(function (n) {
          return { role: n.role, name: n.name };
        })
    };
  }

  // 坐标要单独取：getFullAXTree 不带几何信息，用 DOM.getBoxModel 换
  const needRect = o.withRect !== false;
  if (needRect) {
    const wasAttached = cdp.isAttached(tabId);
    await cdp.ensureAttached(tabId);
    try {
      for (let i = 0; i < hits.length && i < limit; i++) {
        hits[i].rect = await rectOf(tabId, hits[i].backendNodeId);
      }
    } finally {
      if (!wasAttached) await cdp.detach(tabId).catch(() => {});
    }
  }

  const out = hits.slice(0, limit);
  return {
    matched: hits.length,
    query: query,
    // 多个命中时明确提示：语义定位也一样会撞车，不能默默取第一个
    ambiguous: hits.length > 1,
    items: out,
    how_to_use:
      hits.length > 1
        ? '命中多个，请用更精确的 name，或用 index 指定第几个'
        : '可以直接 browser_ax(action="click", ...) 按同一组条件点它'
  };
}

/**
 * backendDOMNodeId → 屏幕矩形。
 * getBoxModel 返回的是 content / padding / border / margin 四个四边形，
 * 取 content 那条算外接矩形即可。
 */
export async function rectOf(tabId, backendNodeId) {
  if (backendNodeId == null) return null;
  let model;
  try {
    model = await cdp.send(tabId, 'DOM.getBoxModel', {
      backendNodeId: backendNodeId
    });
  } catch (e) {
    return null;
  }
  const quad = model && model.model && model.model.content;
  if (!quad || quad.length < 8) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < quad.length; i += 2) {
    if (quad[i] < minX) minX = quad[i];
    if (quad[i] > maxX) maxX = quad[i];
    if (quad[i + 1] < minY) minY = quad[i + 1];
    if (quad[i + 1] > maxY) maxY = quad[i + 1];
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
    cx: Math.round((minX + maxX) / 2),
    cy: Math.round((minY + maxY) / 2)
  };
}

/**
 * 按语义点击：role + name → 找到节点 → 拿坐标 → 走 CDP 真实鼠标事件。
 *
 * 【为什么走 CDP 而不是合成事件】
 *   这条路本来就是为了"选择器失效时还能点得动"，而合成事件（isTrusted=false）
 *   在登录框、风控组件上一律被拦。所以这里必须发真实事件 ——
 *   和过淘宝滑块用的是同一条通道（cdp.clickAt）。
 */
export async function axClick(tabId, q, opt) {
  const o = opt || {};
  const r = await axQuery(tabId, q, { limit: 5, withRect: true });

  if (!r.matched) {
    const sug = (r.suggestions || []).slice(0, 8).map(function (s) {
      return s.role + '「' + s.name + '」';
    });
    throw new Error(
      '语义树里没找到：' + describeQuery(q) +
        (sug.length ? '\n页面上有的：' + sug.join('、') : '')
    );
  }

  const idx = o.index == null ? 0 : Number(o.index);
  const item = r.items[idx];
  if (!item) throw new Error('index=' + idx + ' 超出命中范围（共 ' + r.items.length + ' 个）');

  // 命中多个又没指定 index 时拒绝执行：语义撞车和选择器撞车一样危险
  if (r.matched > 1 && o.index == null && o.allowAmbiguous !== true) {
    throw new Error(
      '语义定位命中 ' + r.matched + ' 个，拒绝猜测（点错比点不动严重得多）。\n' +
        r.items
          .map(function (it, i) {
            return '  [' + i + '] ' + it.role + '「' + it.name + '」';
          })
          .join('\n') +
        '\n请补更精确的 name，或传 index 指定。'
    );
  }

  if (!item.rect || item.rect.width <= 0 || item.rect.height <= 0) {
    throw new Error(
      '节点没有有效尺寸（可能被遮挡或在视口外）：' + item.role + '「' + item.name + '」'
    );
  }

  // AX 节点带 frameId 时，坐标是**该帧**的；主文档帧(0)的坐标才是顶层坐标。
  // 非 0 帧要走 commands.js 那套父链换算，这里不敢硬算 —— 明确报错，让上层决定。
  if (item.frameId != null && item.frameId !== 0) {
    throw new Error(
      '目标在 iframe 里（frameId=' + item.frameId +
        '），跨帧坐标换算请改用 browser_click 走元素描述符路径（先 browser_pick 拾取它）。'
    );
  }

  await cdp.ensureAttached(tabId);
  await cdp.clickAt(tabId, item.rect.cx, item.rect.cy, {
    humanLike: o.humanLike !== false
  });

  return {
    clicked: true,
    role: item.role,
    name: item.name,
    at: { x: item.rect.cx, y: item.rect.cy },
    via: 'cdp',
    note: '真实鼠标事件（isTrusted=true）'
  };
}

function describeQuery(q) {
  const parts = [];
  if (q.role) parts.push('role=' + q.role);
  if (q.name != null) parts.push('name=' + q.name);
  if (q.nameContains != null) parts.push('nameContains=' + q.nameContains);
  if (q.value != null) parts.push('value=' + q.value);
  return parts.join(', ') || '（空条件）';
}
