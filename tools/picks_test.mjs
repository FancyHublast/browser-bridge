/**
 * picks 存储测试 —— 验 v1.3.0 的同名覆盖、action=get/drop/clear。
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
function extractFn(name) {
  // 通过行号定位更稳：找到 `^export async function NAME(`，
  // 再从那行往下逐行累加大括号深度，回到 0 即函数体结束。
  // 【为什么不能直接 l.match(/\{/g)】
  //   字符串字面量里的 `{` / `}` 也算字符。cmdPicks 文档里有一句
  //   "以 { 开头的字符串..." 把字符串里的 `{` 也数进去 → 净 depth 永远不为 0，
  //   看似闭合的函数死都抽不出来。
  // 所以 brace 计算要跳过字符串/模板字符串/注释里的字符。
  const lines = cmdsSrc.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('export async function ' + name + '(') ||
        lines[i].startsWith('async function ' + name + '(') ||
        lines[i].startsWith('export function ' + name + '(') ||
        lines[i].startsWith('function ' + name + '(')) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) throw new Error('未找到函数：' + name);

  let depth = 0;
  let sawBrace = false;
  // 跨行字符串/块注释状态
  let inStr = null; // null | "'" | '"' | '`' | '/*'
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      const n = j + 1 < l.length ? l[j + 1] : '';
      if (inStr === '/*') {
        if (c === '*' && n === '/') { inStr = null; j++; }
        continue;
      }
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && n === '/') break; // 行注释，跳到行末
      if (c === '/' && n === '*') { inStr = '/*'; j++; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '{') { depth++; sawBrace = true; }
      else if (c === '}') { depth--; }
    }
    if (sawBrace && depth === 0 && inStr !== '/*') {
      return lines.slice(startIdx, i + 1).join('\n');
    }
  }
  throw new Error('函数未闭合：' + name);
}

const storeManualPickSrc = extractFn('storeManualPick');
const cmdPicksSrc = extractFn('cmdPicks');
const PICKS_KEY = 'bb_picks';
const PICKS_MAX = 50;

function makeStorage() {
  const data = new Map();
  return {
    get(keys) {
      const out = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => (out[k] = data.get(k)));
      return Promise.resolve(out);
    },
    set(obj) {
      Object.entries(obj).forEach(([k, v]) => data.set(k, v));
      return Promise.resolve();
    },
    remove(k) {
      data.delete(k);
      return Promise.resolve();
    },
    _data: data
  };
}

function loadStore() {
  const ctx = {
    console: console,
    __filename: '<picks>',
    chrome: { storage: { local: makeStorage() } },
    Date: Date,
    Math: Math,
    Promise: Promise
  };
  vm.createContext(ctx);
  ctx.PICKS_KEY = PICKS_KEY;
  ctx.PICKS_MAX = PICKS_MAX;
  // 抠出来的源码是 `export async function storeManualPick(...)`，vm.Script 不认 export，
  // 把它改成 async function 后挂到 globalThis
  const rewritten = storeManualPickSrc.replace(/^export\s+/, '') +
    '\nglobalThis.storeManualPick = storeManualPick;';
  vm.runInContext(rewritten, ctx);
  return ctx;
}

function loadCmdPicks() {
  const ctx = {
    console: console,
    __filename: '<picks>',
    chrome: { storage: { local: makeStorage() } },
    Date: Date,
    Math: Math,
    Promise: Promise
  };
  vm.createContext(ctx);
  ctx.PICKS_KEY = PICKS_KEY;
  ctx.PICKS_MAX = PICKS_MAX;
  // 同样去 export，挂 globalThis
  const rewritten =
    storeManualPickSrc.replace(/^export\s+/, '') +
    '\n' +
    cmdPicksSrc.replace(/^export\s+/, '') +
    '\nglobalThis.storeManualPick = storeManualPick;' +
    '\nglobalThis.cmdPicks = cmdPicks;';
  vm.runInContext(rewritten, ctx);
  return ctx;
}

(async function run() {
  console.log('storeManualPick：基本落盘');
  {
    const ctx = loadStore();
    const data = {
      descriptor: { v: 1, attrs: [{ k: 'id', v: 'submit' }] },
      summary: '提交订单按钮',
      quality: { unique: true },
      url: 'http://a.example/',
      title: '订单',
      name: 'submit-order',
      pickedAt: 1700000000000,
      frameUrl: 'http://iframe.example/',
      frameId: 7
    };
    await ctx.storeManualPick(data, { tab: { url: 'http://a.example/' } });
    const got = await ctx.chrome.storage.local.get(PICKS_KEY);
    eq(got[PICKS_KEY].length, 1, '落盘 1 条');
    eq(got[PICKS_KEY][0].name, 'submit-order', 'name 已写入');
    eq(got[PICKS_KEY][0].frameId, 7, 'frameId 已写入');
    eq(got[PICKS_KEY][0].frameUrl, 'http://iframe.example/', 'frameUrl 来自 item，不是 sender.tab.url');
    ok(got[PICKS_KEY][0].pickedAt === 1700000000000, 'pickedAt 保留原值');
  }

  console.log('\nstoreManualPick：同名覆盖（最新置最前）');
  {
    const ctx = loadStore();
    await ctx.storeManualPick(
      {
        descriptor: { v: 1, attrs: [{ k: 'id', v: 'submit' }] },
        summary: 'old',
        url: 'http://a.example/', title: '订单',
        name: 'submit-order', pickedAt: 100
      },
      { tab: { url: 'http://a.example/' } }
    );
    const before = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY][0];
    await ctx.storeManualPick(
      {
        descriptor: { v: 1, attrs: [{ k: 'id', v: 'submit' }, { k: 'class', v: 'btn-primary' }] },
        summary: 'new',
        url: 'http://a.example/', title: '订单',
        name: 'submit-order', pickedAt: 200
      },
      { tab: { url: 'http://a.example/' } }
    );
    const got = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY];
    eq(got.length, 1, '同名覆盖：仍然 1 条（不是 2）');
    eq(got[0].summary, 'new', 'summary 是最新一次的');
    eq(got[0].pickedAt, 200, 'pickedAt 已更新');
  }

  console.log('\nstoreManualPick：multi=true 一次性落多条');
  {
    const ctx = loadStore();
    await ctx.storeManualPick(
      {
        multi: true,
        // 用户拾取顺序：先点 a，再点 b，最后点 c。最新 = c
        items: [
          { descriptor: { v: 1 }, summary: 'A', url: 'A', title: 'A', name: 'a1' },
          { descriptor: { v: 1 }, summary: 'B', url: 'B', title: 'B', name: 'b1' },
          { descriptor: { v: 1 }, summary: 'C', url: 'C', title: 'C', name: 'c1' }
        ]
      },
      { tab: { url: 'A' } }
    );
    const got = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY];
    eq(got.length, 3, 'multi=true 一次性落 3 条');
    eq(got[0].name, 'c1', '最新（最后点的 c1）在最前');
    eq(got[2].name, 'a1', '最早（先点的 a1）在最后');
  }

  console.log('\nstoreManualPick：上限 PICKS_MAX');
  {
    const ctx = loadStore();
    const items = [];
    for (let i = 0; i < 60; i++) {
      items.push({
        descriptor: { v: 1, attrs: [{ k: 'id', v: 'btn-' + i }] },
        summary: 'item ' + i,
        url: 'x', title: 'x',
        name: 'name-' + i
      });
    }
    await ctx.storeManualPick({ multi: true, items: items }, { tab: { url: 'x' } });
    const got = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY];
    eq(got.length, PICKS_MAX, '上限 ' + PICKS_MAX + ' 条（多余被丢）');
    eq(got[0].name, 'name-59', '最前面的就是最新（name-59）');
  }

  console.log('\nstoreManualPick：同名 batch 整体覆盖（不留旧）');
  {
    const ctx = loadStore();
    // 先存一条 a1
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'a1-old', url: 'x', title: 'x', name: 'a1' },
      { tab: { url: 'x' } }
    );
    // 然后一次 multi 提交 a1+a2
    await ctx.storeManualPick(
      {
        multi: true,
        items: [
          { descriptor: { v: 1 }, summary: 'a1-new', url: 'x', title: 'x', name: 'a1' },
          { descriptor: { v: 1 }, summary: 'a2-new', url: 'x', title: 'x', name: 'a2' }
        ]
      },
      { tab: { url: 'x' } }
    );
    const got = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY];
    eq(got.length, 2, 'a1 旧版本被覆盖，最终 2 条');
    const names = got.map((r) => r.name).sort();
    eq(names.join(','), 'a1,a2', 'a1 + a2 都在；没有"a1-old"残留');
  }

  // ───────────────── cmdPicks ─────────────────
  console.log('\ncmdPicks：list（默认）');
  {
    const ctx = loadCmdPicks();
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'A', url: 'x', title: 'x', name: 'a1' },
      { tab: { url: 'x' } }
    );
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'B', url: 'x', title: 'x', name: 'b1' },
      { tab: { url: 'x' } }
    );
    const r = await ctx.cmdPicks({ action: 'list' });
    eq(r.count, 2, 'list：count=2');
    eq(r.limit, PICKS_MAX, 'list：带回上限');
    eq(Array.isArray(r.items) && r.items.length, 2, 'list：items 数组长度 2');
    ok(typeof r.how_to_use === 'string', 'list：how_to_use 是字符串（agent 拿到能直接做提示）');
  }

  console.log('\ncmdPicks：get（精确 + 包含）');
  {
    const ctx = loadCmdPicks();
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'A', url: 'x', title: 'x', name: 'login-submit' },
      { tab: { url: 'x' } }
    );
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'B', url: 'x', title: 'x', name: 'export-btn' },
      { tab: { url: 'x' } }
    );
    const exact = await ctx.cmdPicks({ action: 'get', name: 'login-submit' });
    eq(exact.found, true, 'get 精确命中：found=true');
    eq(exact.item.summary, 'A', 'get 精确命中：拿到对应元素');

    const fuzzy = await ctx.cmdPicks({ action: 'get', name: 'login' });
    eq(fuzzy.found, true, 'get 模糊匹配（包含 login）：found=true');
    eq(fuzzy.item.name, 'login-submit', 'get 模糊匹配：命中 login-submit');

    const none = await ctx.cmdPicks({ action: 'get', name: 'no-such-thing' });
    eq(none.found, false, 'get 不存在的名字：found=false');
    eq(none.item, null, 'get 不存在：item=null');
  }

  console.log('\ncmdPicks：drop（删指定 name）');
  {
    const ctx = loadCmdPicks();
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'A', url: 'x', title: 'x', name: 'a1' },
      { tab: { url: 'x' } }
    );
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'B', url: 'x', title: 'x', name: 'b1' },
      { tab: { url: 'x' } }
    );
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'C', url: 'x', title: 'x', name: 'c1' },
      { tab: { url: 'x' } }
    );
    const r = await ctx.cmdPicks({ action: 'drop', name: 'b1' });
    eq(r.dropped, 1, 'drop：删掉 1 条');
    eq(r.remaining, 2, 'drop：剩余 2 条');
    const got = (await ctx.chrome.storage.local.get(PICKS_KEY))[PICKS_KEY];
    const names = got.map((x) => x.name).sort();
    eq(names.join(','), 'a1,c1', 'drop 后：a1+c1 都在，b1 没了');

    const noName = await ctx.cmdPicks({ action: 'drop' });
    eq(noName.ok, false, 'drop 不带 name：ok=false');
    ok(/name/.test(noName.error), 'drop 缺 name：error 信息明确');
  }

  console.log('\ncmdPicks：clear');
  {
    const ctx = loadCmdPicks();
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'A', url: 'x', title: 'x', name: 'a1' },
      { tab: { url: 'x' } }
    );
    await ctx.storeManualPick(
      { descriptor: { v: 1 }, summary: 'B', url: 'x', title: 'x', name: 'b1' },
      { tab: { url: 'x' } }
    );
    const r = await ctx.cmdPicks({ action: 'clear' });
    eq(r.cleared, 2, 'clear：清掉 2 条');
    eq(r.remaining, 0, 'clear：剩 0 条');
    const got = await ctx.chrome.storage.local.get(PICKS_KEY);
    eq(got[PICKS_KEY], undefined, 'clear 后键已彻底删除（不是空数组）');
  }

  console.log('\n────────────────────────────────────────────');
  console.log('  Picks 存储：' + passed + ' 项通过，' + failed + ' 项失败');
  process.exit(failed ? 1 : 0);
})();