#!/usr/bin/env node
/**
 * Browser Bridge · locator 单测与全量语法检查
 *
 * 【为什么要单独测 locator】
 *   locator.js 是纯逻辑（打分、阈值、裁剪），不碰 DOM 的真实行为 ——
 *   这类代码的正确性完全靠断言兜住，靠"在浏览器里点两下看看"是测不出边界的：
 *   阈值差 0.01 会不会漏、歧义分差算不算够、裁剪会不会裁过头，
 *   这些只有在断言里才看得清。
 *
 * 【为什么用 fake DOM 而不是 jsdom】
 *   locator 只用到 4 个 DOM 能力：读属性、读文本、读几何、querySelectorAll。
 *   装一个 jsdom 只为这四件事，得不偿失。自己搭一个 40 行的假元素足够，
 *   而且**测试用例里的元素属性一目了然**，比读 jsdom 的解析结果直观得多。
 *
 * 【顺带做语法检查的原因】
 *   content 层是 IIFE、SW 层是 ESM，两类文件的解析规则不同。
 *   这里一次性把它们全过一遍 —— 改完代码忘了检查语法，
 *   代价是"插件加载成功但整个不工作"，排查成本极高。
 *
 * 用法：node tools/locator_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'extension', 'src', 'content');
const SW = path.join(ROOT, 'extension', 'src', 'sw');
const POPUP = path.join(ROOT, 'extension', 'src', 'popup');
const LOCATOR_PATH = path.join(CONTENT, 'locator.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    failures.push(name);
    console.log('  \u2717 ' + name);
  }
}

function eq(actual, expected, name) {
  const good = actual === expected;
  ok(good, good ? name : name + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

function near(actual, expected, tol, name) {
  const good = Math.abs(actual - expected) <= tol;
  ok(good, good ? name : name + '（期望 ' + expected + '±' + tol + '，实际 ' + actual + '）');
}

function throws(fn, name, pattern) {
  try {
    fn();
    ok(false, name + '（应该抛错，但没有）');
  } catch (e) {
    const msg = String((e && e.message) || e);
    const good = !pattern || pattern.test(msg);
    ok(good, good ? name : name + '（错误信息不符：' + msg.split('\n')[0] + '）');
  }
}

// ───────────────────────── 语法检查 ─────────────────────────

console.log('语法检查');

// content 层：IIFE，用 new Function 解析即可（解析即执行前的完整语法校验）
const IIFE_FILES = [
  'config.js',
  'adapter.js',
  'locator.js',
  'picker.js',
  'router.js',
  'actions.js',
  'panel.js',
  'main.js',
  'net-hook.js',
  'net-relay.js'
];
for (const f of IIFE_FILES) {
  const p = path.join(CONTENT, f);
  try {
    const src = fs.readFileSync(p, 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(src);
    ok(true, 'content/' + f);
  } catch (e) {
    ok(false, 'content/' + f + ' → ' + String((e && e.message) || e));
  }
}

// SW / popup 层：ESM。node --check 需要 .mjs 扩展名才会按模块解析，所以复制到临时文件过一遍
const ESM_FILES = [
  [SW, ['service-worker.js', 'ws-client.js', 'state.js', 'cdp.js', 'screenshot.js', 'tabs.js', 'commands.js']],
  [POPUP, ['index.js']]
];
for (const [dir, files] of ESM_FILES) {
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) {
      ok(false, path.basename(dir) + '/' + f + ' → 文件不存在');
      continue;
    }
    const tmp = path.join(os.tmpdir(), 'bb_syntax_' + path.basename(dir) + '_' + f.replace(/\.js$/, '') + '.mjs');
    try {
      fs.copyFileSync(p, tmp);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      ok(true, path.basename(dir) + '/' + f);
    } catch (e) {
      const out = String((e && e.stderr) || (e && e.message) || e);
      ok(false, path.basename(dir) + '/' + f + ' → ' + out.split('\n').slice(0, 3).join(' '));
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* 忽略 */
      }
    }
  }
}

// ───────────────────────── fake DOM ─────────────────────────

class El {
  constructor(tag, attrs, text) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this._a = attrs || {};
    this.innerText = text || '';
    this.textContent = text || '';
    this.id = this._a.id || '';
    this.className = this._a.class || '';
    this.__visible = true;
  }
  getAttribute(n) {
    const v = this._a[n];
    return v == null ? null : String(v);
  }
  hasAttribute(n) {
    return this._a[n] != null;
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50 };
  }
  contains() {
    return false;
  }
}

const cssShim = {
  escape: (s) => String(s).replace(/["\\\]]/g, '\\$&')
};

function unescapeCss(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

function matchesSel(el, sel) {
  const s = String(sel).trim();
  if (s === '*') return true;
  if (s.indexOf(',') !== -1) return s.split(',').some((x) => matchesSel(el, x));
  if (s[0] === '#') return el.id === unescapeCss(s.slice(1));
  const m = /^\[([a-zA-Z-]+)="(.*)"\]$/.exec(s);
  if (m) {
    const v = el.getAttribute(m[1]);
    return v != null && v === unescapeCss(m[2]);
  }
  if (s[0] === '[' && s.endsWith(']')) return el.getAttribute(s.slice(1, -1)) != null;
  return el.tagName.toLowerCase() === s.toLowerCase();
}

/** 造一个干净的 RK 环境：每次用例重新加载 locator.js，顺带绕开它内部的 500ms 缓存 */
function createRK(elements) {
  const root = {
    querySelectorAll: (sel) => elements.filter((el) => matchesSel(el, sel))
  };
  const win = {
    RK: {
      adapter: {
        ownText: (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim(),
        isVisible: (el) => el.__visible !== false,
        collectShadowRoots: () => [root],
        describe: (el) => ({ tag: el.tagName.toLowerCase(), text: el.innerText }),
        normText: (s) => String(s || '').replace(/\s+/g, ' ').trim()
      }
    },
    CSS: cssShim
  };
  const src = fs.readFileSync(LOCATOR_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  if (!win.RK.locator) throw new Error('locator.js 未能挂载 RK.locator');
  return win.RK;
}

const D = (k, v, m, w, pf) => {
  const o = { k, v };
  if (m) o.m = m;
  if (w != null) o.w = w;
  if (pf) o.pf = true;
  return o;
};

// ───────────────────────── 纯函数 ─────────────────────────

console.log('\n纯函数：编辑距离与属性读取');
{
  const RK = createRK([]);
  const L = RK.locator;
  eq(L.editDistance('abc', 'abd'), 1, 'editDistance 替换一位 = 1');
  eq(L.editDistance('abc', 'abc'), 0, 'editDistance 相同 = 0');
  eq(L.editDistance('', 'abc'), 3, 'editDistance 空串 = 长度');
  eq(L.editDistance('kitten', 'sitting'), 3, 'editDistance kitten/sitting = 3');

  eq(L.readAttr(new El('button', {}, '登录'), 'tag'), 'button', 'readAttr tag');
  eq(L.readAttr(new El('input', { type: 'checkbox' }), 'role'), 'checkbox', 'readAttr role 由 input 类型推断');
  eq(L.readAttr(new El('a', { href: '#' }), 'role'), 'link', 'readAttr role：带 href 的 a 是 link');
  eq(L.readAttr(new El('a', {}), 'role'), '', 'readAttr role：无 href 的 a 没有 role');
  eq(
    L.readAttr(new El('div', { class: 'a b c' }), 'cls'),
    'a b c',
    'readAttr cls 把 class 归一成空格分隔'
  );
}

console.log('\n纯函数：易变属性识别');
{
  const RK = createRK([]);
  const L = RK.locator;
  eq(L.volatileId('app'), false, '稳定 id：app');
  eq(L.volatileId('nc_1_n1z'), false, '稳定 id：nc_1_n1z（数字是单个的，不算编号）');
  eq(L.volatileId('a1b2c3d4e5f6'), true, '易变 id：十六进制串');
  eq(L.volatileId('item12345'), true, '易变 id：含 3 位以上连续数字');
  eq(L.volatileId(':r7:'), true, '易变 id：React useId 产物');

  eq(L.volatileClass('btn'), false, '稳定 class：btn');
  eq(L.volatileClass('css-1x2y3z'), true, '易变 class：CSS-in-JS');
  eq(L.volatileClass('data-v-7a3c1b2c'), true, '易变 class：Vue scoped 哈希');
  eq(L.volatileClass('sc-bdVaJa'), true, '易变 class：styled-components');
}

console.log('\n纯函数：文本属性生成');
{
  const RK = createRK([]);
  const L = RK.locator;

  const plain = L.textSpec('登录');
  eq(plain.k, 'text', 'textSpec：普通文本用 text 属性');
  eq(plain.m, 'eq', 'textSpec：纯文字用等值匹配');

  const dyn = L.textSpec('共 23 条');
  eq(dyn.m, 'regex', 'textSpec：含数字的文本转正则');
  ok(dyn.v.indexOf('\\d+') !== -1, 'textSpec：正则里数字被替换成 \\d+ → ' + dyn.v);
  eq(new RegExp(dyn.v).test('共 31 条'), true, 'textSpec：换个数还是能匹配（这就是它存在的意义）');
  eq(new RegExp(dyn.v).test('共 31 件'), false, 'textSpec：单位变了不匹配');

  eq(L.textSpec('23'), null, 'textSpec：纯数字文本没有区分度，丢弃');
  eq(L.textSpec(''), null, 'textSpec：空文本丢弃');
  eq(L.textSpec('x'.repeat(200)), null, 'textSpec：超长文本丢弃');
}

// ───────────────────────── 匹配算法 ─────────────────────────

console.log('\n匹配算法：每种模式');
{
  const RK = createRK([]);
  const m = RK.locator.matchOne;

  eq(m('a', D('id', 'a', 'eq')), 1, 'eq 相等 = 1');
  eq(m('ab', D('id', 'a', 'eq')), 0, 'eq 不等 = 0');

  eq(m('abc', D('id', 'abc', 'contains')), 1, 'contains 完全相同 = 1');
  near(m('abcde', D('id', 'abc', 'contains')), 0.84, 0.01, 'contains 部分包含按覆盖比例给分');
  eq(m('ab', D('id', 'zzz', 'contains')), 0, 'contains 不包含 = 0');

  eq(m('btn btn-primary', D('cls', 'btn', 'words')), 1, 'words 命中全部词 = 1');
  near(m('btn', D('cls', 'btn btn-primary', 'words')), 0.8, 0.01, 'words 命中一半词 = 0.8');
  eq(m('btn', D('cls', 'xxx', 'words')), 0, 'words 一个都没中 = 0');

  near(m('共 23 条', D('text', '^共 \\d+ 条$', 'regex')), 0.9, 0.001, 'regex 命中 = 0.9');
  eq(m('abc', D('text', '[', 'regex')), 0, 'regex 写法非法时返回 0，不抛异常');

  near(m('abcd', D('text', 'abce', 'fuzzy')), 0.75, 0.001, 'fuzzy 相差一位 = 0.75');
  eq(m('abcd', D('text', 'zzzz', 'fuzzy')), 0, 'fuzzy 相似度低于 0.7 直接归零（不给"差一点点"开口子）');
  eq(m('', D('text', 'abc', 'eq')), 0, '空的实际值不匹配任何东西');
}

// ───────────────────────── 打分 ─────────────────────────

console.log('\n打分：score 与 coverage 的分工');
{
  const btn = new El('button', { id: 'submit', class: 'btn' }, '登录');
  const RK = createRK([btn]);
  const attrs = RK.locator.normAttrs({
    attrs: [D('id', 'submit', 'eq', 3), D('text', '登录', 'eq', 2), D('tag', 'button', 'eq', 1)]
  });

  const r = RK.locator.scoreOf(btn, attrs);
  near(r.score, 1, 0.001, '全部命中：score = 1');
  near(r.coverage, 1, 0.001, '全部命中：coverage = 1');
  eq(r.misses.length, 0, '全部命中：没有未命中属性');

  const partial = RK.locator.normAttrs({
    attrs: [D('id', 'submit', 'eq', 3), D('text', '注册', 'eq', 2), D('tag', 'button', 'eq', 1)]
  });
  const r2 = RK.locator.scoreOf(btn, partial);
  near(r2.score, 4 / 6, 0.001, '一条不匹配：score 按权重折算');
  near(r2.coverage, 4 / 6, 0.001, '一条不匹配：coverage 同步下降');
  eq(r2.misses.length, 1, '未命中清单里能看到是哪条属性不对');
  eq(r2.misses[0].k, 'text', '未命中属性被准确定位到 text');
}

// ───────────────────────── 定位：正常路径 ─────────────────────────

console.log('\n定位：唯一命中与"次高分"');
{
  const b1 = new El('button', { class: 'btn btn-primary' }, '登录');
  const b2 = new El('button', { class: 'btn btn-default' }, '取消');
  const RK = createRK([b1, b2]);

  const desc = {
    attrs: [
      D('text', '登录', 'eq', 2),
      D('cls', 'btn-primary', 'words', 1),
      D('tag', 'button', 'eq', 1, true)
    ]
  };

  const r = RK.locator.locate(desc);
  eq(r.el === b1, true, '命中的是目标元素');
  near(r.score, 1, 0.001, '相似度 1');
  near(r.runnerUp, 0.25, 0.01, '次高分 0.25（另一个按钮只有 tag 对上）');
  eq(r.candidateCount, 2, '候选数 2（tag 粗筛保住了召回）');
}

console.log('\n定位：粗筛会收窄候选集（这是性能的来源）');
{
  const b1 = new El('button', { id: 'submit', 'data-testid': 'login-submit' }, '登录');
  const b2 = new El('button', { class: 'btn' }, '取消');
  const RK = createRK([b1, b2]);

  const r = RK.locator.locate({
    attrs: [
      D('testid', 'login-submit', 'eq', 3),
      D('text', '登录', 'eq', 2),
      D('tag', 'button', 'eq', 1, true)
    ]
  });
  eq(r.el === b1, true, 'data-testid 唯一时直接锁定目标');
  eq(r.candidateCount, 1, '候选只有 1 个 —— 粗筛把范围压到了最小');
  eq(r.runnerUp, null, '没有次高分可报');
}

console.log('\n定位：拒绝凑合');
{
  const b1 = new El('button', { class: 'btn' }, '登录');
  const b2 = new El('button', { class: 'btn' }, '取消');
  const RK = createRK([b1, b2]);

  throws(
    () => RK.locator.locate({ attrs: [D('text', '提交', 'eq', 2), D('tag', 'button', 'eq', 1, true)] }),
    '分数低于阈值时抛错，而不是返回最像的那个',
    /低于阈值/
  );

  const noCand = createRK([b1]);
  throws(
    () => noCand.locator.locate({ attrs: [D('id', 'nope', 'eq', 3), D('text', '不存在的文本', 'eq', 2)] }),
    '一个候选都没有时抛错',
    /最高分|没有候选/
  );

  throws(() => RK.locator.locate({ attrs: [] }), '空描述符直接拒绝', /没有任何属性/);
}

console.log('\n定位：歧义检测（这套机制最值钱的一条）');
{
  const a1 = new El('button', { class: 'btn' }, '确定');
  const a2 = new El('button', { class: 'btn' }, '确定');
  const RK = createRK([a1, a2]);

  const desc = {
    attrs: [D('text', '确定', 'eq', 2), D('cls', 'btn', 'words', 1), D('tag', 'button', 'eq', 1, true)]
  };

  let caught = null;
  try {
    RK.locator.locate(desc);
  } catch (e) {
    caught = e;
  }
  ok(!!caught, '两个一模一样的元素 → 抛错，绝不猜');
  if (caught) {
    eq(caught.ambiguous, true, '错误对象上带 ambiguous 标记（上层可据此提示用户消歧）');
    ok(/拒绝猜测/.test(caught.message), '错误信息说清了"拒绝猜测"');
    ok(/index/.test(caught.message), '错误信息给出了可行动的下一步：传 index');
  }

  const picked = RK.locator.locate(desc, { index: 1 });
  eq(picked.el === a2, true, '显式传 index 后可以人工消歧，取到第二个');
  eq(picked.viaIndex, 1, '返回值里标明这次是人指定的 index');
  eq(picked.ambiguous, true, '仍然如实告知"其实是有歧义的"');
}

console.log('\n定位：证据不足拦截');
{
  // 所有属性都只"勉强沾边"：分数够高，但没有一条是完全对上的
  const x = new El('div', { title: 'abc' }, '登录成功按钮文字');
  const RK = createRK([x]);

  const desc = {
    attrs: [D('text', '登录成功', 'contains', 5), D('title', 'abcdefgh', 'contains', 5)]
  };

  const raw = RK.locator.normAttrs(desc);
  const s = RK.locator.scoreOf(x, raw);
  ok(s.score >= 0.62, '这个例子里 score 确实够高（' + Math.round(s.score * 100) / 100 + '）');
  eq(s.coverage, 0, '但 coverage 为 0：一条满分命中都没有');

  throws(() => RK.locator.locate(desc), '全是"勉强沾边"的高分 → 以证据不足为由拒绝', /证据不足/);
}

console.log('\n定位：改版容错（描述符存在的全部意义）');
{
  const btn = new El('button', { class: 'btn primary-v2' }, '登录'); // 类名被改过：primary → primary-v2
  const other = new El('button', { class: 'btn ghost' }, '取消');
  const RK = createRK([btn, other]);

  const desc = {
    attrs: [
      D('role', 'button', 'eq', 2),
      D('text', '登录', 'eq', 2),
      D('cls', 'primary', 'words', 1),
      D('tag', 'button', 'eq', 1, true)
    ]
  };

  const r = RK.locator.locate(desc);
  eq(r.el === btn, true, '类名改掉了，定位依然命中（选择器写法这里已经归零）');
  near(r.score, 5 / 6, 0.01, '相似度 0.83：丢掉的那条属性按权重扣分，但不致命');
  eq(r.misses.length, 1, '未命中属性如实列出');
  eq(r.misses[0].k, 'cls', '明确指出是 class 对不上');
}

console.log('\n定位：粗筛失效时的全量重扫');
{
  // 陷阱：页面里恰好有个元素 id 还叫 submit，但它不是我们要的
  const trap = new El('div', { id: 'submit' }, '随便一段文字');
  // 目标：id 在改版中被改成了 submit-old，其余属性没动
  const target = new El('button', { id: 'submit-old' }, '登录');
  const RK = createRK([trap, target]);

  const desc = {
    attrs: [
      D('id', 'submit', 'eq', 3),
      D('role', 'button', 'eq', 2),
      D('text', '登录', 'eq', 2),
      D('tag', 'button', 'eq', 1, true)
    ]
  };

  const r = RK.locator.locate(desc);
  eq(r.el === target, true, 'id 变了也照样找回来（靠 role + text + tag 兜住）');
  near(r.score, 0.625, 0.01, '相似度 0.63，刚好过线');
  eq(r.misses.length, 1, '如实报告 id 对不上');

  // 佐证这不是蒙对的：干扰元素在窄扫里只有 0.375 分（不够线），
  // 而目标元素压根不在 #submit 的结果集里 —— 全靠全量重扫才看见它
  const attrsAll = RK.locator.normAttrs(desc);
  near(RK.locator.scoreOf(trap, attrsAll).score, 0.375, 0.01, '干扰元素只有 0.38 分（窄扫会停在这里）');
  near(RK.locator.scoreOf(target, attrsAll).score, 0.625, 0.01, '目标 0.63 分 —— 只有全量重扫才看得到它');
}

// ───────────────────────── 描述符生成 ─────────────────────────

console.log('\n生成描述符：过滤易变属性');
{
  // 页面上有两个文本相同的按钮，只有 class 能区分 ——
  // 这样才逼着裁剪逻辑必须把 class 留下来，而不是"随便留两条够用就行"
  // 两个干扰元素分别逼住 text 和 class —— 少任何一条都无法唯一命中，
  // 这样才检验得出裁剪是"真的在读页面"而不是"固定留两条"
  const btn = new El('button', { id: 'a1b2c3d4e5f6', class: 'css-1x2y3z primary' }, '确定');
  const twinText = new El('button', { class: 'css-9z8y7x primary' }, '取消');
  const twinCls = new El('button', { class: 'css-9z8y7x secondary' }, '确定');
  const RK = createRK([btn, twinText, twinCls]);

  const built = RK.locator.buildFrom(btn);
  const keys = built.descriptor.attrs.map((a) => a.k);
  const byKey = {};
  built.descriptor.attrs.forEach((a) => (byKey[a.k] = a.v));

  ok(keys.indexOf('id') === -1, '十六进制 id 被丢弃（每次发版都变）');
  eq(byKey.cls, 'primary', 'class 只保留稳定部分：primary');
  ok(String(byKey.cls || '').indexOf('css-1x2y3z') === -1, 'CSS-in-JS 生成的类名被剔除');
  eq(byKey.text, '确定', '文本进了描述符（被 twinText 逼着必须留）');
  ok(keys.indexOf('tag') !== -1, 'tag 始终保留（用于粗筛）');
  ok(built.dropped.length >= 1, '被丢弃的属性记录在 dropped 里（可解释，不静默）');
  eq(built.quality.unique, true, '两个干扰元素下仍然唯一命中');
  ok(/唯一命中/.test(built.summary), 'summary 给出结论：唯一命中');
}

console.log('\n生成描述符：最小充分裁剪');
{
  const only = new El('button', { class: 'btn primary' }, '提交订单');
  const RK = createRK([only]);
  const built = RK.locator.buildFrom(only);
  const meaningful = built.descriptor.attrs.filter((a) => !a.pf);
  ok(
    meaningful.length >= 2,
    '即使页面只有一个这样的元素，也保留至少 2 条实义属性（' + meaningful.length + ' 条）—— 不给改版留"一击必杀"的空档'
  );
  eq(built.quality.unique, true, '裁剪后仍然唯一命中');
}

console.log('\n生成描述符：不唯一时如实上报');
{
  const t1 = new El('button', { class: 'btn' }, '确定');
  const t2 = new El('button', { class: 'btn' }, '确定');
  const t3 = new El('button', { class: 'btn' }, '确定');
  const RK = createRK([t1, t2, t3]);

  const built = RK.locator.buildFrom(t1);
  eq(built.quality.unique, false, '页面上有三个一模一样的元素 → quality.unique = false');
  ok(/不唯一/.test(built.summary), 'summary 里明确警告不唯一');
  eq(
    built.descriptor.attrs.filter((a) => !a.pf).length,
    3,
    '不唯一时不做裁剪（裁剪的前提是"能唯一命中"，否则裁了只会更糟）'
  );
}

// ───────────────────────── 候选与排行 ─────────────────────────

console.log('\n候选排序与排行榜');
{
  // 三个按钮分数各不相同，用来验证排序确实按分数走
  const good = new El('button', { class: 'btn primary' }, '保存');
  const mid = new El('button', { class: 'btn' }, '保存');
  const bad = new El('button', { class: 'btn' }, '取消');
  const RK = createRK([bad, mid, good]);

  const desc = {
    attrs: [D('text', '保存', 'eq', 2), D('cls', 'primary', 'words', 1), D('tag', 'button', 'eq', 1, true)]
  };

  const all = RK.locator.locateAll(desc);
  eq(all.length, 3, 'locateAll 返回全部候选（不抛错）');
  eq(all[0] === good, true, '候选按分数降序，目标排第一');

  const ranked = RK.locator.rank(desc);
  eq(ranked[0].brief.indexOf('保存') !== -1, true, '排行榜带人话摘要');
  ok(ranked[0].rect && ranked[0].rect.w > 0, '排行榜带矩形（排查位置问题时用得上）');
  eq(ranked[0].score > ranked[1].score, true, '排行榜内也是降序');
}

// ───────────────────────── 汇总 ─────────────────────────

console.log('\n' + '='.repeat(62));
if (fail) {
  console.log(' ' + pass + ' 项通过，' + fail + ' 项失败：');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
} else {
  console.log(' 全部 ' + pass + ' 项通过。');
}
console.log('='.repeat(62));
process.exit(fail ? 1 : 0);
