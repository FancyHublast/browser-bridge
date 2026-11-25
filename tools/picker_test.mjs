/**
 * picker.js 单测 —— 重点验 v1.3.0 的协议改造。
 *
 * 不像 locator.js 那样能在纯函数下覆盖所有路径（picker 涉及 DOM/Shadow/事件），
 * 这里只测 _handleSW 入口的三种 type + sessionId 校验，避免真机调试反复开浏览器。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PICKER_PATH = path.resolve(__dirname, '../extension/src/content/picker.js');
const ADAPTER_PATH = path.resolve(__dirname, '../extension/src/content/adapter.js');
const LOCATOR_PATH = path.resolve(__dirname, '../extension/src/content/locator.js');
const CFG_PATH = path.resolve(__dirname, '../extension/src/content/config.js');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}
function eq(a, b, msg) {
  if (a === b) passed++;
  else {
    failed++;
    console.error('  ✗ ' + msg + '：expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
  }
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) <= tol) passed++;
  else {
    failed++;
    console.error('  ✗ ' + msg + '：expected ' + b + '±' + tol + ' got ' + a);
  }
}

function loadIntoSandbox(src, ctx) {
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: path.basename(ctx.__filename) });
}

/**
 * 搭一个能跑 picker.js 的最小沙箱：
 *   - window.RK 已有 adapter/locator 占位
 *   - chrome.runtime.onMessage 收集监听器
 *   - document 是个 stub（picker 调 ensureHost 会动到它）
 */
function makeSandbox(url) {
  const listeners = [];
  const ctx = {
    console: console,
    __filename: '<picker>',
    location: { href: url || 'http://web.iframe/' },
    // 完整 mock：picker 会构造 Shadow DOM host + 各类元素
    document: {
      title: '拾取测试页',
      hidden: false,
      getElementById: function () { return null; },
      body: { appendChild: function () {} },
      documentElement: { style: {}, appendChild: function () {}, addEventListener: function () {} },
      body: { appendChild: function () {}, addEventListener: function () {} },
      createElement: function (tag) {
        return {
          id: '',
          tagName: (tag || 'div').toUpperCase(),
          style: { cssText: '' },
          classList: { add: function () {}, remove: function () {} },
          setAttribute: function () {},
          getAttribute: function () { return null; },
          addEventListener: function () {},
          removeEventListener: function () {},
          appendChild: function () {},
          attachShadow: function () {
            const sr = {
              innerHTML: '',
              __bbEls: {},
              appendChild: function () {},
              addEventListener: function () {},
              querySelector: function () { return null; }
            };
            return sr;
          }
        };
      },
      addEventListener: function () {},
      removeEventListener: function () {},
      readyState: 'complete'
    },
    setInterval: function (fn) { return setInterval(fn, 60000); },
    clearInterval: clearInterval,
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame: function (id) { clearTimeout(id); },
    chrome: {
      runtime: {
        onMessage: {
          addListener: function (fn) { listeners.push(fn); }
        },
        sendMessage: function (_msg, cb) { if (cb) setTimeout(function () { cb(); }, 0); }
      }
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    RK: {}
  };
  ctx.window = ctx;
  ctx.RK = {
    log: function () {},
    warn: function () {},
    // adapter 的最小占位 —— picker 不调它们（除非真正进入拾取流程），但构造器会查
    adapter: {
      describe: function (el) {
        return { tag: el && el.tagName ? el.tagName : 'DIV', text: '' };
      },
      deepElementFromPoint: function (x, y) {
        return { x: x, y: y };
      },
      isVisible: function () { return true; }
    },
    locator: {
      buildFrom: function () {
        return { descriptor: { v: 1, attrs: [] }, summary: 'mocked', quality: { unique: true } };
      }
    },
    panel: { hide: function () {}, show: function () {} }
  };
  return { ctx: ctx, listeners: listeners };
}

console.log('加载 picker.js（最小沙箱）');
{
  const sb = makeSandbox();
  loadIntoSandbox(fs.readFileSync(CFG_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(ADAPTER_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(LOCATOR_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(PICKER_PATH, 'utf8'), sb.ctx);

  const picker = sb.ctx.RK.picker;
  ok(picker, '加载完成，RK.picker 已挂载');
  ok(typeof picker._handleSW === 'function', '_handleSW 已暴露（测试入口）');
  ok(typeof picker.active === 'function', 'active 已暴露');
  eq(picker.active(), false, '初始无会话');
  ok(sb.listeners.length >= 1, 'chrome.runtime.onMessage 注册了监听器（v1.3.0 每帧都注册）');
}

// ═════════════════════════ 协议层 ═════════════════════════
console.log('\nhandleSWMessage：三种 type');
{
  const sb = makeSandbox('http://main.example/');
  loadIntoSandbox(fs.readFileSync(CFG_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(ADAPTER_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(LOCATOR_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(PICKER_PATH, 'utf8'), sb.ctx);

  const p = sb.ctx.RK.picker;
  const H = p._handleSW;

  // ── 非拾取指令直接拒 ──
  const r0 = H({ __bb_panel: true, action: 'status' });
  eq(r0.accepted, false, '非 __bb_picker 消息：拒收');

  // ── pick_start ──
  const r1 = H({
    __bb_picker: true,
    type: 'pick_start',
    sessionId: 'sid_test_1',
    args: { hint: '请按 Ctrl 点' },
    origin: 'sw'
  });
  eq(r1.accepted, true, 'pick_start 接受');
  ok(r1.sessionId === 'sid_test_1', '返回的 sessionId 与请求一致');
  ok(p.active(), '本地会话已激活');
  eq(p.state().sessionId, 'sid_test_1', 'state 看到的也是同一个 sid');

  // ── pick_start 同 sid 幂等 ──
  const r2 = H({
    __bb_picker: true,
    type: 'pick_start',
    sessionId: 'sid_test_1',
    args: {},
    origin: 'sw'
  });
  eq(r2.accepted, true, '同 sid 的二次 start：accepted=true（不视为冲突）');
  eq(r2.deduped, true, '返回值 deduped=true（避免重复启动成本）');

  // ── pick_start 不同 sid：本地已占着 → 拒收 ──
  const r3 = H({
    __bb_picker: true,
    type: 'pick_start',
    sessionId: 'sid_test_2',
    args: {},
    origin: 'sw'
  });
  eq(r3.accepted, false, '本帧已占着，新 sid 进来：拒收（防串号）');
  ok(/拾取会话/.test(r3.reason), '拒收理由含"拾取会话"');

  // ── pick_query 在占用期间 ──
  const r4 = H({ __bb_picker: true, type: 'pick_query' });
  eq(r4.active, true, 'pick_query：当前活跃');
  eq(r4.sessionId, 'sid_test_1', 'pick_query：sessionId 是 sid_test_1');

  // ── pick_end 带 sid ──
  const r5 = H({
    __bb_picker: true,
    type: 'pick_end',
    sessionId: 'sid_test_1',
    reason: '测试收尾'
  });
  eq(r5.accepted, true, 'pick_end 带正确 sid：接受');
  eq(p.active(), false, '本地会话已清理');

  // ── pick_end 不带 sid：清一切 ──
  H({ __bb_picker: true, type: 'pick_start', sessionId: 'sid_A', args: {} });
  ok(p.active(), '再次起 sid_A');
  const r6 = H({ __bb_picker: true, type: 'pick_end', reason: '强制清理' });
  eq(r6.accepted, true, 'pick_end 不带 sid：仍接受 —— 用于强制清理');
  eq(p.active(), false, 'sid_A 被强制清理');

  // ── pick_end 在 idle 上仍是 no-op，不应该出 crash ──
  const r7 = H({ __bb_picker: true, type: 'pick_end' });
  eq(r7.idle, true, 'idle 状态下的 pick_end：返回 idle=true');
}

console.log('\nhandleSWMessage：异常类型');
{
  const sb = makeSandbox('http://iframe-x.example/');
  loadIntoSandbox(fs.readFileSync(CFG_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(ADAPTER_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(LOCATOR_PATH, 'utf8'), sb.ctx);
  loadIntoSandbox(fs.readFileSync(PICKER_PATH, 'utf8'), sb.ctx);

  const r = sb.ctx.RK.picker._handleSW({ __bb_picker: true, type: 'pick_what' });
  eq(r.accepted, false, '未知 type：拒收');
  ok(/未知/.test(r.reason), '拒绝原因明确');
  ok(typeof r.frame === 'string', '返回值仍带 frame 字段（排查用）');
}

console.log('\n多 frame 隔离（每个 sandbox 一个 picker 实例）');
{
  const sb1 = makeSandbox('http://main.example/');
  const sb2 = makeSandbox('http://iframe.example/');
  for (const sb of [sb1, sb2]) {
    loadIntoSandbox(fs.readFileSync(CFG_PATH, 'utf8'), sb.ctx);
    loadIntoSandbox(fs.readFileSync(ADAPTER_PATH, 'utf8'), sb.ctx);
    loadIntoSandbox(fs.readFileSync(LOCATOR_PATH, 'utf8'), sb.ctx);
    loadIntoSandbox(fs.readFileSync(PICKER_PATH, 'utf8'), sb.ctx);
  }
  sb1.ctx.RK.picker._handleSW({
    __bb_picker: true,
    type: 'pick_start',
    sessionId: 'sid_iso',
    args: { hint: 'h' }
  });
  eq(sb1.ctx.RK.picker.active(), true, 'frame1 已激活');
  eq(sb2.ctx.RK.picker.active(), false, 'frame2 仍是 idle（实例独立）');
  // frame2 的 pick_query 不应该误报 frame1 的 sid
  const q2 = sb2.ctx.RK.picker._handleSW({ __bb_picker: true, type: 'pick_query' });
  eq(q2.active, false, 'frame2 自己的 pick_query：active=false');
  eq(q2.sessionId, null, 'frame2 自己的 pick_query：sessionId=null');
}

console.log('\n────────────────────────────────────────────');
console.log('  Picker 协议：' + passed + ' 项通过，' + failed + ' 项失败');
process.exit(failed ? 1 : 0);