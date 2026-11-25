/**
 * 拾取会话「投递通道」测试 —— 护住 v1.3.2 的核心修复，防止回退。
 *
 * 【为什么专门为这一件事写测试】
 *   拾取曾经两次被"消息发不到"坑掉，且两次的症状都是含糊的"点了没反应"：
 *     · v1.2.0：broadcastFrames 时 iframe 里根本没有 picker（all_frames:false）；
 *     · v1.3.0：改成 chrome.runtime.sendMessage 广播 —— 从 SW 发出会投给
 *       **每一个标签页的每一帧**，开着多个标签页时所有页面一起进拾取模式，
 *       而 picker 侧拿不到"我是不是目标标签页"（content 收 onMessage 时
 *       sender 指向发消息方即 SW），等于没有过滤手段。
 *   v1.3.2 定稿：一律走 broadcastFrames（枚举帧 → 逐帧 ensureInjected → 定向投递）。
 *
 *   这套断言里最值钱的是 **「不许再出现 runtime.sendMessage」** ——
 *   它是唯一能拦住"下次顺手改回广播"的护栏。
 *
 * 用法（在 browser-bridge 目录下）：
 *     node tools/pick_dispatch_test.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const cmdsSrc = fs.readFileSync(path.resolve(__dirname, '../extension/src/sw/commands.js'), 'utf8');

/**
 * 抠出一个顶层函数。与 picks_test.mjs 同一套算法 ——
 * 关键是 brace 计数必须跳过字符串/模板字符串/注释里的 `{` `}`，
 * 否则文档注释里一句 "以 { 开头…" 就能让 depth 永远回不到 0。
 */
function extractFn(name) {
  const lines = cmdsSrc.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].startsWith('export async function ' + name + '(') ||
      lines[i].startsWith('async function ' + name + '(') ||
      lines[i].startsWith('export function ' + name + '(') ||
      lines[i].startsWith('function ' + name + '(')
    ) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) throw new Error('未找到函数：' + name);

  let depth = 0;
  let sawBrace = false;
  let inStr = null;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      const n = j + 1 < l.length ? l[j + 1] : '';
      if (inStr === '/*') {
        if (c === '*' && n === '/') {
          inStr = null;
          j++;
        }
        continue;
      }
      if (inStr) {
        if (c === '\\') {
          j++;
          continue;
        }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') {
        inStr = '/*';
        j++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        inStr = c;
        continue;
      }
      if (c === '{') {
        depth++;
        sawBrace = true;
      } else if (c === '}') {
        depth--;
      }
    }
    if (sawBrace && depth === 0 && inStr !== '/*') {
      return lines.slice(startIdx, i + 1).join('\n');
    }
  }
  throw new Error('函数未闭合：' + name);
}

const startSrc = extractFn('startPickSession').replace(/^export\s+/, '');
const stopSrc = extractFn('stopPickSession').replace(/^export\s+/, '');

/**
 * 造一个 SW 侧的假运行环境。
 * @param delivered  broadcastFrames 要返回的「真正送达的 frameId 列表」
 * @param throwOnCall broadcastFrames 是否抛错（模拟页面正在跳转 / 禁止注入）
 */
function loadCtx(delivered, throwOnCall) {
  const broadcastCalls = [];
  const runtimeCalls = [];

  const ctx = {
    console: console,
    Date: Date,
    Math: Math,
    Promise: Promise,
    JSON: JSON,
    String: String,
    // 被抠出的函数体里会引用模块级的 broadcastFrames（原本是 import 进来的）
    broadcastFrames: async (tabId, payload) => {
      broadcastCalls.push({ tabId, payload });
      if (throwOnCall) throw new Error('模拟：该页禁止注入脚本');
      return delivered;
    },
    // 【护栏】正常情况下这条路一次都不该被走到
    chrome: {
      runtime: {
        sendMessage: function () {
          runtimeCalls.push(Array.prototype.slice.call(arguments));
        }
      }
    }
  };

  vm.createContext(ctx);
  vm.runInContext(
    startSrc + '\n' + stopSrc + '\nglobalThis.startPickSession = startPickSession;\nglobalThis.stopPickSession = stopPickSession;',
    ctx
  );
  return { ctx, broadcastCalls, runtimeCalls };
}

// ── 1. startPickSession：走 broadcastFrames，且只走它 ──
{
  const { ctx, broadcastCalls, runtimeCalls } = loadCtx([0, 169]);

  const r = await ctx.startPickSession(12345, {
    hint: '点账号框',
    anchor: 'raw',
    multi: true,
    manual: true,
    name: 'login-account'
  });

  eq(broadcastCalls.length, 1, 'startPickSession 应恰好调用一次 broadcastFrames');
  eq(runtimeCalls.length, 0, 'startPickSession 不得使用 chrome.runtime.sendMessage（会污染所有标签页）');

  const call = broadcastCalls[0] || {};
  eq(call.tabId, 12345, 'broadcastFrames 必须收到目标 tabId');
  const p = call.payload || {};
  eq(p.__bb_picker, true, 'payload 必须带 __bb_picker 标记');
  eq(p.type, 'pick_start', 'payload.type 必须是 pick_start');
  eq(p.tabId, 12345, 'payload 里也要带 tabId（便于日志与二次校验）');
  ok(typeof p.sessionId === 'string' && p.sessionId.indexOf('pk_') === 0, 'sessionId 应由 SW 统一生成且以 pk_ 开头');
  eq(p.args.hint, '点账号框', 'hint 应透传');
  eq(p.args.anchor, 'raw', 'anchor=raw 应透传');
  eq(p.args.multi, true, 'multi 应透传');
  eq(p.args.manual, true, 'manual 应透传（决定结果是否落盘）');
  eq(p.args.name, 'login-account', 'name 应透传');
  eq(p.args.sessionId, p.sessionId, 'args.sessionId 必须与顶层 sessionId 一致');

  eq(r.sessionId, p.sessionId, '返回值应回带同一个 sessionId');
  eq(JSON.stringify(r.frames), JSON.stringify([0, 169]), '返回值应带上真正送达的帧列表');
}

// ── 2. 一帧都没接受 → 明确报错，而不是让调用方干等超时 ──
{
  const { ctx } = loadCtx([]);
  const r = await ctx.startPickSession(1, {});
  ok(!!r.error, '零帧接受时必须返回 error');
  ok(!r.frames || r.frames.length === 0, '零帧接受时 frames 应为空数组');
  ok(typeof r.sessionId === 'string' && r.sessionId.length > 0, '即使失败也要回带 sessionId（便于收尾）');
}

// ── 3. broadcastFrames 抛错 → 降级为返回值，不把异常甩给上层 ──
{
  const { ctx } = loadCtx(null, true);
  let threw = false;
  let r = null;
  try {
    r = await ctx.startPickSession(1, {});
  } catch (e) {
    threw = true;
  }
  eq(threw, false, 'broadcastFrames 抛错时 startPickSession 不应向外抛');
  ok(r && !!r.error, '应把失败原因放进返回值');
}

// ── 4. anchor 只认 raw，其余一律语义档 ──
{
  const { ctx, broadcastCalls } = loadCtx([0]);
  await ctx.startPickSession(7, { anchor: 'whatever' });
  eq(broadcastCalls[0].payload.args.anchor, 'semantic', '非法 anchor 应回落到 semantic');
}

// ── 5. stopPickSession：同一条定向通道，收尾不能撒到所有标签页 ──
{
  const { ctx, broadcastCalls, runtimeCalls } = loadCtx([0]);

  await ctx.stopPickSession(999, '拾取超时', 'pk_abc');

  eq(broadcastCalls.length, 1, 'stopPickSession 应调用一次 broadcastFrames');
  eq(runtimeCalls.length, 0, 'stopPickSession 不得使用 chrome.runtime.sendMessage');
  eq(broadcastCalls[0].tabId, 999, '收尾也要定向到目标标签页');
  const p = broadcastCalls[0].payload || {};
  eq(p.__bb_picker, true, '收尾消息同样带 __bb_picker');
  eq(p.type, 'pick_end', 'payload.type 必须是 pick_end');
  eq(p.sessionId, 'pk_abc', 'sessionId 应透传');
  eq(p.reason, '拾取超时', 'reason 应透传');
}

// ── 6. stopPickSession 的默认值 + 收尾失败不能把调用方卡住 ──
{
  const { ctx, broadcastCalls, runtimeCalls } = loadCtx([0]);

  await ctx.stopPickSession(5);
  eq(runtimeCalls.length, 0, 'stopPickSession 任何路径都不得走 runtime.sendMessage');
  eq(broadcastCalls[0].payload.sessionId, null, '不带 sessionId 时应传 null（= 收掉所有活跃会话）');
  eq(broadcastCalls[0].payload.reason, '拾取结束', 'reason 缺省应为「拾取结束」');

  const boom = loadCtx(null, true);
  let threw = false;
  try {
    await boom.ctx.stopPickSession(5, 'x', 'y');
  } catch (e) {
    threw = true;
  }
  eq(threw, false, '收尾失败不应向外抛（超时那条路会兜底）');
}

// ── 7. 静态护栏：源码里不该再出现被证伪的那条广播写法 ──
{
  /**
   * 先剥注释再检查。这段代码的注释里**故意**写着"为什么不用 runtime.sendMessage"——
   * 那是文档，不是调用。要拦的是可执行的调用，不是这几个字。
   * 剥注释时保护 `http://` 里的双斜杠（前面是 `:` 就不当行注释）。
   */
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const startBody = stripComments(startSrc);
  const stopBody = stripComments(stopSrc);

  ok(
    startBody.indexOf('broadcastFrames(') !== -1,
    'startPickSession 必须通过 broadcastFrames 投递'
  );
  ok(
    stopBody.indexOf('broadcastFrames(') !== -1,
    'stopPickSession 必须通过 broadcastFrames 投递'
  );
  eq(
    /chrome\.runtime\.sendMessage\s*\(/.test(startBody),
    false,
    'startPickSession 不得调用 chrome.runtime.sendMessage（会污染所有标签页）'
  );
  eq(
    /chrome\.runtime\.sendMessage\s*\(/.test(stopBody),
    false,
    'stopPickSession 不得调用 chrome.runtime.sendMessage'
  );
  // 全文件层面：投递给 picker 的那两条消息也只能走定向通道
  ok(
    cmdsSrc.indexOf('broadcastFrames(tabId') !== -1,
    'commands.js 里应存在 broadcastFrames(tabId, ...) 的定向投递'
  );
}

console.log('拾取投递通道：' + passed + ' 项通过，' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
