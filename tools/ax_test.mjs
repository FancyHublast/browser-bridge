/**
 * Browser Bridge · 语义树定位（ax.js）单测
 *
 * 【怎么测的】
 *   真的起不了 Chrome，所以造一个假的 chrome.debugger：
 *   sendCommand 按方法名返回预置的 AX 树 / BoxModel。
 *   然后直接 import 真实的 ax.js（和 cdp.js），断言它的行为。
 *
 *   这样能覆盖的：过滤规则、查询匹配、歧义拒绝、rect 计算、跨帧拒绝、临时附着是否释放。
 *   不能覆盖的：真实 AX 树长什么样 —— 那部分只能靠真机试。
 *
 * 【跑法】
 *   node tools/ax_test.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_DIR = path.join(__dirname, '..', 'extension', 'src', 'sw');

// ───────────────────────── 断言小工具 ─────────────────────────

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label + (actual === expected ? '' : `（实际 ${JSON.stringify(actual)}）`));
}

async function throws(fn, re, label) {
  try {
    await fn();
    failed++;
    console.log('  ✗ ' + label + '（本该抛错，却没有）');
  } catch (e) {
    const m = String((e && e.message) || e);
    if (re.test(m)) {
      passed++;
      console.log('  ✓ ' + label);
    } else {
      failed++;
      console.log('  ✗ ' + label + '（错误信息对不上：' + m.slice(0, 120) + '）');
    }
  }
}

// ───────────────────────── 假 chrome ─────────────────────────

let attachedTabs = new Set();
let detachCount = 0;
let sendLog = [];

/** 每个测试用 setFixtures 换一副数据 */
let fixtures = {
  axNodes: [],
  boxModels: {}
};

globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} },
    // cdp.js 在模块顶层注册了网络事件监听。这里必须给个占位，
    // 否则 import 阶段就炸 —— 静态 import 的副作用也是被测代码的一部分。
    onEvent: { addListener() {} },
    async attach({ tabId }) {
      if (attachedTabs.has(tabId)) throw new Error('Another debugger is already attached');
      attachedTabs.add(tabId);
    },
    async detach({ tabId }) {
      if (!attachedTabs.has(tabId)) throw new Error('Debugger is not attached');
      attachedTabs.delete(tabId);
      detachCount++;
    },
    async sendCommand({ tabId }, method, params) {
      sendLog.push(method);
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: fixtures.axNodes };
      }
      if (method === 'DOM.getBoxModel') {
        const m = fixtures.boxModels[params.backendNodeId];
        if (!m) throw new Error('No node with given id found');
        return { model: { content: m } };
      }
      // 输入事件（clickAt 会派发 mouseMoved / mousePressed / mouseReleased）不需要返回值
      if (/^Input\./.test(method)) return {};
      throw new Error('未预置的 CDP 方法：' + method);
    }
  }
};

const ax = await import('file://' + path.join(SW_DIR, 'ax.js').replace(/\\/g, '/'));
const cdp = await import('file://' + path.join(SW_DIR, 'cdp.js').replace(/\\/g, '/'));

// ───────────────────────── AX 节点构造 ─────────────────────────

function N(id, role, name, extra) {
  return Object.assign(
    {
      nodeId: String(id),
      backendDOMNodeId: 1000 + id,
      ignored: false,
      role: { type: 'role', value: role },
      name: { type: 'computedString', value: name },
      value: { type: 'string', value: '' },
      childIds: []
    },
    extra || {}
  );
}

/** 一个四边形（左上、右上、右下、左下） */
function quad(x, y, w, h) {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

/**
 * 换一副数据并**清干净附着状态**。
 * 必须 await cdp.detachAll()：cdp 内部的附着集合是模块级私有的，
 * 靠测试自己的 attachedTabs 清不掉 —— 不清就会跨用例污染，
 * "该释放没释放"这类断言会假通过。
 */
async function setFixtures(f) {
  await cdp.detachAll().catch(() => {});
  fixtures = f;
  attachedTabs = new Set();
  detachCount = 0;
  sendLog = [];
}

// ───────────────────────── 1. 过滤规则 ─────────────────────────

console.log('\n=========== 取树：过滤掉没信息量的节点 ===========');
{
  await setFixtures({
    axNodes: [
      N(1, 'RootWebArea', '千牛工作台'),
      N(2, 'generic', ''),
      N(3, 'generic', '外层容器'),
      N(4, 'textbox', '账号'),
      { nodeId: '5', ignored: true, role: { value: 'button' }, name: { value: '隐藏的按钮' } },
      N(6, 'button', '登录'),
      N(7, 'StaticText', '忘记密码'),
      N(8, 'textbox', '') // 无名且无值 → 没有定位价值
    ]
  });

  const t = await ax.axTree(1);
  const names = t.nodes.map((n) => n.role + ':' + n.name);

  ok(names.indexOf('textbox:账号') !== -1, '输入框被保留（role + name 都有值）');
  ok(names.indexOf('button:登录') !== -1, '按钮被保留');
  eq(names.some((s) => s.startsWith('generic')), false, 'generic 容器被过滤');
  eq(names.some((s) => s.startsWith('StaticText')), false, 'StaticText 被过滤（只贡献文字，不贡献定位）');
  eq(
    t.nodes.some((n) => n.name === '隐藏的按钮'),
    false,
    'ignored 节点被过滤（屏幕阅读器都忽略的，定位也不该看见）'
  );
  eq(
    t.nodes.some((n) => n.role === 'textbox' && n.name === ''),
    false,
    '无名无值的节点被过滤'
  );
  eq(t.total, 8, 'total 报告的是原始节点数（让人知道滤掉了多少）');
}

console.log('\n=========== withGeneric：排查时能要回全部 ===========');
{
  await setFixtures({
    axNodes: [N(1, 'generic', '容器'), N(2, 'generic', ''), N(3, 'button', '登录')]
  });
  const t = await ax.axTree(1, { withGeneric: true });
  ok(t.nodes.length >= 2, 'withGeneric=true 时容器节点回来了（找"为什么没有"时用）');
}

console.log('\n=========== 数量上限：别把上下文撑爆 ===========');
{
  const many = [];
  for (let i = 0; i < 900; i++) many.push(N(i, 'button', '按钮' + i));
  await setFixtures({ axNodes: many });

  const t = await ax.axTree(1);
  eq(t.count, 400, '默认最多 400 个节点');
  eq(t.truncated, true, 'truncated 标记为 true（明确告诉调用方数据被截断了）');
}

// ───────────────────────── 2. 查询 ─────────────────────────

console.log('\n=========== 查询：role + name 精确命中 ===========');
{
  await setFixtures({
    axNodes: [
      N(1, 'textbox', '账号'),
      N(2, 'textbox', '密码'),
      N(3, 'button', '登录'),
      N(4, 'link', '忘记密码')
    ],
    boxModels: { 1001: quad(100, 200, 300, 40), 1002: quad(100, 260, 300, 40) }
  });

  const r = await ax.axQuery(1, { role: 'textbox', name: '账号' });
  eq(r.matched, 1, '精确命中 1 个');
  eq(r.ambiguous, false, '不算歧义');
  eq(r.items[0].name, '账号', '命中的就是这个');
  eq(r.items[0].rect.cx, 250, '中心点 x = 100 + 300/2');
  eq(r.items[0].rect.cy, 220, '中心点 y = 200 + 40/2');
  ok(r.items[0].rect.width === 300 && r.items[0].rect.height === 40, '矩形宽高正确');
}

console.log('\n=========== 查询：nameContains（记不全时用）===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '立即登录'), N(2, 'button', '登录并注册'), N(3, 'button', '取消')],
    boxModels: { 1001: quad(0, 0, 100, 30), 1002: quad(0, 40, 100, 30) }
  });

  const r = await ax.axQuery(1, { role: 'button', nameContains: '登录' });
  eq(r.matched, 2, '包含"登录"的有两个');
  eq(r.ambiguous, true, '标记为歧义（上层会据此要求收紧条件）');
}

console.log('\n=========== 查询：没命中时要给线索，不能只说"没找到" ===========');
{
  await setFixtures({
    axNodes: [N(1, 'textbox', '手机号'), N(2, 'textbox', '验证码'), N(3, 'button', '获取验证码')]
  });

  const r = await ax.axQuery(1, { role: 'textbox', name: '账号' });
  eq(r.matched, 0, '确实没命中');
  ok((r.suggestions || []).length === 2, 'suggestions 列出了页面上所有 textbox（把"页面上都有啥"告诉调用方）');
  ok(
    r.suggestions.every((s) => s.role === 'textbox'),
    'suggestions 按同一个 role 过滤，不是把整页倒出来'
  );
}

console.log('\n=========== 临时附着要在用完后释放（不留"正在调试"黄条）===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '登录')],
    boxModels: { 1001: quad(0, 0, 80, 30) }
  });

  const before = detachCount;
  await ax.axQuery(1, { role: 'button', name: '登录' });
  ok(detachCount > before, '轻量档下用完就 detach（用户浏览器顶部不会常驻黄条）');
  eq(attachedTabs.has(1), false, '附着状态已清干净');
}

console.log('\n=========== 本来就已经附着时不要乱撤（增强档）===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '登录')],
    boxModels: { 1001: quad(0, 0, 80, 30) }
  });
  // 模拟增强档：先真的附着一次（必须走 cdp.attach —— isAttached 读的是 cdp 内部的
  // 附着集合，直接改测试里的 attachedTabs 是改不动的，那样测的就是个假象）
  await cdp.attach(1);
  const before = detachCount;
  await ax.axQuery(1, { role: 'button', name: '登录' });
  eq(detachCount, before, '调用前已附着 → 用完**不**撤（增强档是用户显式选的，不该被查询顺手关掉）');
  eq(cdp.isAttached(1), true, '附着状态保持');
}

// ───────────────────────── 3. 语义点击 ─────────────────────────

console.log('\n=========== 点击：单一命中可以直接点 ===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '登录')],
    boxModels: { 1001: quad(400, 300, 120, 40) }
  });

  const r = await ax.axClick(1, { role: 'button', name: '登录' }, { humanLike: false });
  eq(r.clicked, true, '点击成功');
  eq(r.via, 'cdp', '走的是 CDP 真实事件通道');
  eq(r.at.x, 460, '点在元素中心');
  ok(sendLog.indexOf('Input.dispatchMouseEvent') !== -1, '确实派发了真实鼠标事件');
}

console.log('\n=========== 点击：语义撞车时拒绝猜测（最值钱的一条）===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '确定'), N(2, 'button', '确定'), N(3, 'button', '确定')],
    boxModels: { 1001: quad(0, 0, 50, 30), 1002: quad(0, 40, 50, 30), 1003: quad(0, 80, 50, 30) }
  });

  await throws(
    () => ax.axClick(1, { role: 'button', name: '确定' }, { humanLike: false }),
    /命中 3 个/,
    '三个同名按钮 → 抛错，绝不取第一个'
  );
  await throws(
    () => ax.axClick(1, { role: 'button', name: '确定' }, { humanLike: false }),
    /点错比点不动严重得多/,
    '错误信息说清了为什么拒绝'
  );

  // 人显式指定 index 才放行
  const r = await ax.axClick(1, { role: 'button', name: '确定' }, { index: 2, humanLike: false });
  eq(r.at.y, 95, 'index=2 → 点的是第三个（y = 80 + 30/2）');
}

console.log('\n=========== 点击：没找到时说清页面上有什么 ===========');
{
  await setFixtures({ axNodes: [N(1, 'textbox', '手机号'), N(2, 'button', '下一步')] });
  await throws(
    () => ax.axClick(1, { role: 'textbox', name: '账号' }, { humanLike: false }),
    /手机号/,
    '错误信息里带上页面上的同类节点（可直接照着改条件）'
  );
}

console.log('\n=========== 点击：目标在 iframe 里时明确拒绝 ===========');
{
  await setFixtures({
    axNodes: [N(1, 'textbox', '账号', { frameId: 'F1', backendDOMNodeId: 2001 })],
    boxModels: { 2001: quad(10, 10, 200, 30) }
  });

  await throws(
    () => ax.axClick(1, { role: 'textbox', name: '账号' }, { humanLike: false }),
    /坐标换算|iframe/,
    '跨帧不硬算坐标，明确让上层走元素描述符路径'
  );

  // 但查询本身应该能看见它（这正是 AX 树的价值之一）
  const r = await ax.axQuery(1, { role: 'textbox', name: '账号' });
  eq(r.matched, 1, '查询能看到 iframe 内的节点（节点带 frameId）');
  eq(r.items[0].frameId, 'F1', 'frameId 被如实带回来');
}

console.log('\n=========== 点击：节点没有尺寸时不硬点 ===========');
{
  await setFixtures({
    axNodes: [N(1, 'button', '隐藏按钮')],
    boxModels: { 1001: quad(0, 0, 0, 0) }
  });
  await throws(
    () => ax.axClick(1, { role: 'button', name: '隐藏按钮' }, { humanLike: false }),
    /尺寸/,
    '尺寸为 0（隐藏模板）→ 报错而不是点一个 0×0 的位置'
  );
}

console.log('\n=========== 点击：拿不到 BoxModel 也不炸整条链路 ===========');
{
  await setFixtures({ axNodes: [N(1, 'button', '幽灵按钮')], boxModels: {} });
  const r = await ax.axQuery(1, { role: 'button', name: '幽灵按钮' });
  eq(r.matched, 1, '节点找到了');
  eq(r.items[0].rect, null, 'rect 拿不到就是 null（不抛错，调用方自己判断）');
}

// ───────────────────────── 汇总 ─────────────────────────

console.log('\n' + '='.repeat(60));
if (failed === 0) {
  console.log(` 全部 ${passed} 项通过。`);
} else {
  console.log(` 通过 ${passed} 项，失败 ${failed} 项。`);
}
console.log('='.repeat(60));

process.exit(failed === 0 ? 0 : 1);
