/**
 * 扫帧择优逻辑的单元测试（纯函数，不碰 chrome API）
 *
 * 【为什么单独测它】
 *   这是 v1.0.4 修掉的那个真机 bug 的核心：淘宝 nc 滑块在页面里同时存在
 *   「隐藏模板」（rect 全 0）与「真实实例」，而模板所在帧的 frameId 更小。
 *   旧逻辑"第一个非空结果就返回"会命中模板，agent 拿到 0×0 的元素，拖拽直接打空。
 *   现在改成"有可见命中就优先用可见的"。这个判定错了，整个修复就白做。
 *
 * 用法（Node 直接跑，无需依赖）：
 *   node tools/frame_logic_test.mjs
 */

import { hasVisibleResult, listFrames } from '../extension/src/sw/tabs.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name);
    console.log('      期望: ' + JSON.stringify(expected));
    console.log('      实际: ' + JSON.stringify(actual));
  }
}

console.log('');
console.log('=========== hasVisibleResult（扫帧择优的判据）===========');

// ── query 形态：元素列表 ──
check(
  'query：列表里有可见元素 → true',
  hasVisibleResult({ count: 2, total: 2, elements: [{ visible: false }, { visible: true }] }),
  true
);
check(
  'query：列表里全是隐藏（淘宝滑块模板就是这个形态）→ false',
  hasVisibleResult({
    count: 1,
    total: 1,
    elements: [{ tag: 'span', path: '#nc_1_n1z', visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } }]
  }),
  false
);
check('query：空列表 → false', hasVisibleResult({ count: 0, total: 0, elements: [] }), false);

// ── element_at 形态：单个元素 ──
check('element_at：元素可见 → true', hasVisibleResult({ el: { tag: 'button', visible: true } }), true);
check('element_at：元素不可见 → false', hasVisibleResult({ el: { tag: 'button', visible: false } }), false);
check('element_at：该点没有元素（返回 null）→ false', hasVisibleResult({ el: null }), false);

// ── resolve_point 形态：矩形 ──
check('resolve_point：rect 有尺寸 → true', hasVisibleResult({ x: 100, y: 200, rect: { x: 90, y: 190, w: 20, h: 20 } }), true);
check(
  'resolve_point：rect 全 0（隐藏模板）→ false',
  hasVisibleResult({ x: 0, y: 0, rect: { x: 0, y: 0, w: 0, h: 0 } }),
  false
);

// ── 退化输入 ──
check('null → false', hasVisibleResult(null), false);
check('字符串 → false', hasVisibleResult('oops'), false);
check('无相关字段的对象 → false', hasVisibleResult({ pong: true }), false);

console.log('');
console.log('=========== 模拟真机场景：隐藏模板 vs 可见实例 ===========');

// 真机上就是这样：frameId 更小的帧里是隐藏模板，真实滑块在 frameId 更大的帧里
const hiddenTpl = {
  frameId: 68,
  url: 'https://havanalogin.taobao.com/mini_login.htm',
  data: {
    count: 1,
    total: 1,
    elements: [{ tag: 'span', path: '#nc_1_n1z', visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } }]
  }
};
const realOne = {
  frameId: 91,
  url: 'https://havanalogin.taobao.com/newlogin/login.do/_____tmd_____/punish',
  data: {
    count: 1,
    total: 1,
    elements: [{ tag: 'span', path: '#nc_2_n1z', visible: true, rect: { x: 18, y: 138, w: 40, h: 40 } }]
  }
};

// 旧逻辑（第一个非空就返回）会选中 hiddenTpl —— 这正是 bug
const legacyPick = [hiddenTpl, realOne].find((r) => !(Number(r.data.total) === 0));
check('旧逻辑：会错误地选中隐藏模板的帧', legacyPick.frameId, 68);

// 新逻辑：优先可见
const hits = [hiddenTpl, realOne];
const newPick = hits.find((r) => hasVisibleResult(r.data)) || hits[0];
check('新逻辑：正确选中可见实例所在的帧', newPick.frameId, 91);
check('新逻辑：拿到的滑块尺寸非 0', newPick.data.elements[0].rect.w, 40);

// 都没有可见命中时，退回第一个非空结果（至少让调用方看到元素在哪一帧）
const onlyHidden = [hiddenTpl, { frameId: 92, url: 'x', data: { count: 0, total: 0, elements: [] } }];
const fallbackPick = onlyHidden.find((r) => hasVisibleResult(r.data)) || onlyHidden[0];
check('全不可见时：退回第一个非空结果（不返回空）', fallbackPick.frameId, 68);

console.log('');
console.log('=========== 模块可加载性 ===========');
check('listFrames 已导出（SW 侧依赖它建帧链）', typeof listFrames, 'function');

console.log('');
console.log('================================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('================================================');
process.exit(fail === 0 ? 0 : 1);
