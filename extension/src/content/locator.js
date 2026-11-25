/**
 * Browser Bridge · 多属性相似度定位引擎（locator）
 *
 * 【为什么需要它 —— 从"精确选择器"到"相似度检索"】
 *   adapter.js 的定位语义是"命中即成功"：CSS / XPath 查出什么就是什么，
 *   命中多个时按可见面积排序取第一个。这套机制在两种场景下必然翻车：
 *     a) 站点改版 —— 类名加个哈希、DOM 多包一层，选择器直接归零；
 *     b) 命中多个 —— 谁才是"对的那个"完全没有语义判断，靠面积猜。
 *
 *   桌面 RPA（影刀那类）走的不是这条路：它把"元素"存成一个**带权重的属性集合**
 *   （id / name / role / 文本 / 类名 / 层级），定位时给每个候选逐属性算相似度、
 *   加权求和、择优录取。所以只要属性没被全改光，改版后它还能认出来。
 *   本文件就是把这套机制搬进浏览器。
 *
 * 【三条接受条件，缺一不可】
 *   ① score    ≥ minScore       够像（默认 0.62）
 *   ② score − Top2 ≥ minGap      不和别的候选撞车（默认 0.12）← 最值钱的一条
 *   ③ coverage ≥ minCoverage    至少有一部分属性是"完全对上"的铁证（默认 0.4）
 *
 *   第 ② 条是这套机制的核心价值所在：宁可报"歧义"让人来看，也绝不猜。
 *   猜错的代价是点到删除 / 提交 / 付款按钮上，比"点不动"严重得多 ——
 *   这也是 adapter.js 里跨帧坐标换算宁可降级也不硬点的同一条原则。
 *
 * 【和 adapter 的关系：加法，不是替换】
 *   target 传字符串  → 一切照旧走 adapter 的老路径，行为零变化；
 *   target 传描述符对象 {attrs:[...]} → 才进入本文件。
 *   所以 22 个现有工具、全部自测脚本、已经跑通的所有流程都一行不用改。
 *
 * 【描述符长什么样】
 *   {
 *     "v": 1,
 *     "note": "登录页提交按钮",
 *     "attrs": [
 *       {"k": "testid", "v": "login-submit", "m": "eq",     "w": 3},
 *       {"k": "text",   "v": "登录",           "m": "eq",     "w": 2},
 *       {"k": "tag",    "v": "button",         "m": "eq",     "w": 1, "pf": true}
 *     ]
 *   }
 *   k = 属性名（见 readAttr），v = 期望值，m = 匹配方式，w = 权重，pf = 仅用于粗筛
 *
 * 【m 匹配方式】
 *   eq       完全相等（1.0 / 0）
 *   contains 双向包含，按"覆盖比例"给 0.6~1.0 分
 *   words    词级包含（class 用：a b c 里命中几个算几分）
 *   regex    正则命中给 0.9（文本含动态数字时自动降级成这个）
 *   fuzzy    编辑距离归一化，相似度低于 0.7 直接归零（避免"差一点点"也算命中）
 */
(function () {
  'use strict';

  if (!window.RK || window.RK.__locatorLoaded) return;
  const RK = window.RK;

  // ───────────────────────── 默认阈值 ─────────────────────────

  const DEFAULTS = {
    /** 最低相似度。低于它就当作"没找到"，而不是"凑合用" */
    minScore: 0.62,
    /** Top1 与 Top2 的最小分差。小于它视为歧义，拒绝执行 */
    minGap: 0.12,
    /**
     * 「铁证」属性的权重占比下限：至少要有这么大比例的属性是**完全对上**的。
     *
     * 【为什么不和 minScore 冗余】
     *   一开始把 coverage 定义成"沾边的属性占比"，那样它与 score 存在恒等关系
     *   （score ≤ coverage 永远成立），minCoverage 只要不大于 minScore，
     *   这个检查就永远不可能触发 —— 是段死代码。
     *   现在改成"只认满分命中"，两者才真正正交：
     *   score 衡量整体像不像（部分匹配也算分），coverage 衡量有几条是硬证据。
     *   于是"所有属性都只勉强沾边"这种虚假高分会被拦下 —— 分数好看，但一条实锤都没有。
     */
    minCoverage: 0.4,
    /** 是否只认可见元素 */
    visible: true,
    /** 指定第几个（给了就跳过歧义检查，等于人工消歧） */
    index: null,
    /** 返回的候选上限（诊断用） */
    maxCandidates: 6
  };

  /** 属性权重基线。描述符里带 w 时以描述符为准 */
  const WEIGHT = {
    testid: 3,
    id: 3,
    role: 2,
    name: 2,
    text: 2,
    'aria-label': 2,
    placeholder: 2,
    tag: 1,
    type: 1,
    title: 1,
    cls: 1
  };

  /** 全量扫描兜底时的元素上限，防止在巨型 DOM 上卡住主线程 */
  const MAX_SCAN = 8000;
  /** shadow root 收集结果的短时缓存（一次定位里会被调用很多次） */
  const ROOTS_TTL_MS = 500;

  let rootsCache = null;
  let rootsCacheAt = 0;

  function roots() {
    const now = Date.now();
    if (rootsCache && now - rootsCacheAt < ROOTS_TTL_MS) return rootsCache;
    rootsCache = RK.adapter.collectShadowRoots();
    rootsCacheAt = now;
    return rootsCache;
  }

  // ───────────────────────── 元素属性读取 ─────────────────────────

  /**
   * window.RK 命名空间是隔离世界的，但 content script 拿到的元素仍然是页面的真实元素。
   * 这里全部走 DOM 只读接口，不碰任何页面状态。
   */
  function clsOf(el) {
    if (!el) return [];
    const c = el.className;
    if (typeof c === 'string') return c.trim() ? c.trim().split(/\s+/) : [];
    if (c && typeof c.baseVal === 'string') return c.baseVal.trim() ? c.baseVal.trim().split(/\s+/) : [];
    const attr = el.getAttribute && el.getAttribute('class');
    return attr ? attr.trim().split(/\s+/) : [];
  }

  /**
   * 隐式 role —— 这是"语义树"思路的轻量版。
   * 页面上绝大多数按钮根本没写 role="button"，它就是 <button>。
   * 不补这一层，role 属性就只能对显式声明过的元素生效，覆盖率会低得没法用。
   */
  const IMPLICIT_ROLE = {
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
    option: 'option',
    li: 'listitem',
    table: 'table',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    img: 'img',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading'
  };

  function implicitRole(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute && el.hasAttribute('href') ? 'link' : '';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return IMPLICIT_ROLE[tag] || '';
  }

  /** 统一的属性读取入口。k 不认识的按原生属性名兜底读 */
  function readAttr(el, k) {
    if (!el || el.nodeType !== 1) return '';
    switch (k) {
      case 'tag':
        return el.tagName ? el.tagName.toLowerCase() : '';
      case 'text':
        return RK.adapter.ownText(el);
      case 'cls':
        return clsOf(el).join(' ');
      case 'role':
        return el.getAttribute('role') || implicitRole(el);
      case 'testid':
        return el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-test-id') || '';
      case 'aria-label':
        return el.getAttribute('aria-label') || '';
      case 'id':
        return el.id || '';
      case 'type':
        return el.getAttribute('type') || '';
      case 'value':
        return el.value != null ? String(el.value) : '';
      default:
        return (el.getAttribute && el.getAttribute(k)) || '';
    }
  }

  // ───────────────────────── 匹配算法 ─────────────────────────

  /** 标准编辑距离。超长字符串不做 DP（几 KB 的文本不该拖慢定位），退化成长度差 */
  function editDistance(a, b) {
    const la = a.length;
    const lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    if (la > 64 || lb > 64) return Math.abs(la - lb);

    let prev = new Array(lb + 1);
    let cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        const del = prev[j] + 1;
        const ins = cur[j - 1] + 1;
        const sub = prev[j - 1] + cost;
        cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    return prev[lb];
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * 单个属性的匹配度 → 0~1。
   * 所有分支都保证"不匹配一定返回 0"，因为打分是加权的，
   * 让不匹配的属性贡献一点点分会让阈值失去意义。
   */
  function matchOne(actual, spec) {
    const a = actual == null ? '' : String(actual);
    const b = spec && spec.v != null ? String(spec.v) : '';
    if (!a || !b) return 0;

    const m = (spec && spec.m) || 'eq';

    if (m === 'regex') {
      try {
        return new RegExp(b).test(a) ? 0.9 : 0;
      } catch (e) {
        return 0;
      }
    }

    if (m === 'fuzzy') {
      const L = Math.max(a.length, b.length);
      if (!L) return 0;
      const s = 1 - editDistance(a, b) / L;
      return s >= 0.7 ? s : 0;
    }

    if (m === 'words') {
      const A = a.split(/\s+/).filter(Boolean);
      const B = b.split(/\s+/).filter(Boolean);
      if (!A.length || !B.length) return 0;
      let hit = 0;
      for (let i = 0; i < B.length; i++) if (A.indexOf(B[i]) !== -1) hit++;
      if (!hit) return 0;
      return 0.6 + 0.4 * (hit / B.length);
    }

    if (a === b) return 1;
    if (m === 'eq') return 0;

    // contains：双向包含，命中部分的"覆盖比例"越高越可信
    let ratio = 0;
    if (a.indexOf(b) !== -1) ratio = b.length / a.length;
    else if (b.indexOf(a) !== -1) ratio = a.length / b.length;
    else return 0;
    return 0.6 + 0.4 * ratio;
  }

  // ───────────────────────── 描述符归一化 ─────────────────────────

  function isDescriptor(t) {
    return !!t && typeof t === 'object' && Array.isArray(t.attrs);
  }

  function normAttrs(descriptor) {
    const out = [];
    const attrs = descriptor.attrs || [];
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (!a || typeof a !== 'object') continue;
      // 兼容简写：{"k":"text","v":"登录"} —— 不写 w / m 时按属性名取默认
      const k = String(a.k || '').trim();
      if (!k) continue;
      out.push({
        k: k,
        v: a.v == null ? '' : String(a.v),
        m: a.m || (k === 'cls' ? 'words' : k === 'text' || k === 'placeholder' || k === 'title' ? 'contains' : 'eq'),
        w: a.w != null ? Number(a.w) : WEIGHT[k] != null ? WEIGHT[k] : 1,
        pf: !!a.pf
      });
    }
    return out;
  }

  // ───────────────────────── 候选集 ─────────────────────────

  function esc(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\\]]/g, '\\$&');
  }

  /**
   * 挑一个"粗筛条件"，把候选集从"全页所有元素"压到"几十个"。
   * 优先级 = 唯一性强度：testid > id > name > tag > role。
   * tag 排前面是因为它几乎总在描述符里，且 querySelectorAll('button') 非常便宜。
   */
  function pickPrefilter(attrs) {
    const find = (k) => attrs.find((a) => a.k === k && a.v);
    const testid = find('testid');
    if (testid) return '[data-testid="' + esc(testid.v) + '"]';
    const id = find('id');
    if (id) return '#' + esc(id.v);
    const name = find('name');
    if (name) return '[name="' + esc(name.v) + '"]';
    const tag = find('tag');
    if (tag && /^[a-z][a-z0-9-]*$/i.test(tag.v)) return tag.v.toLowerCase();
    const role = find('role');
    if (role) return '[role="' + esc(role.v) + '"]';
    return '';
  }

  function collectCandidates(attrs, forceAll) {
    const out = [];
    const seen = new Set();
    const list = roots();

    function push(el) {
      if (!el || el.nodeType !== 1 || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    }

    const sel = forceAll ? '' : pickPrefilter(attrs);
    if (sel) {
      for (let i = 0; i < list.length; i++) {
        let nodes;
        try {
          nodes = list[i].querySelectorAll(sel);
        } catch (e) {
          nodes = null;
        }
        if (!nodes) continue;
        for (let j = 0; j < nodes.length; j++) push(nodes[j]);
      }
    }

    // 粗筛落空（描述符里只有 text 这类没法做 CSS 的属性，或页面是 shadow 嵌套）→ 全量扫
    if (!out.length || forceAll) {
      if (forceAll) {
        out.length = 0;
        seen.clear();
      }
      const tags = attrs.filter((a) => a.k === 'tag' && a.v).map((a) => a.v.toLowerCase());
      const all = tags.filter((t) => /^[a-z][a-z0-9-]*$/i.test(t)).join(',') || '*';
      let scanned = 0;
      for (let i = 0; i < list.length && scanned < MAX_SCAN; i++) {
        let nodes;
        try {
          nodes = list[i].querySelectorAll(all);
        } catch (e) {
          continue;
        }
        for (let j = 0; j < nodes.length; j++) {
          if (++scanned > MAX_SCAN) break;
          push(nodes[j]);
        }
      }
    }

    return out;
  }

  // ───────────────────────── 打分 ─────────────────────────

  /**
   * 给一个元素按描述符打分。
   * 返回 {score, coverage, hits, misses}：
   *   score    加权平均匹配度（0~1）
   *   coverage 完全对上（满分）的属性权重占比 —— "铁证"有多少份量
   *   misses   未命中的属性清单 —— 失败时报出来，是排障的第一手材料
   */
  function scoreOf(el, attrs) {
    let total = 0;
    let got = 0;
    let covW = 0;
    const hits = [];
    const misses = [];

    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      total += a.w;
      const actual = readAttr(el, a.k);
      const s = matchOne(actual, a);
      if (s > 0) {
        got += a.w * s;
        // coverage 只认"完全对上"的属性 —— 部分匹配不算铁证，这是它和 score 的分工所在
        if (s >= 0.999) covW += a.w;
        hits.push({ k: a.k, s: round2(s) });
      } else {
        misses.push({ k: a.k, want: String(a.v).slice(0, 60), actual: String(actual).slice(0, 60) });
      }
    }

    return {
      score: total > 0 ? got / total : 0,
      coverage: total > 0 ? covW / total : 0,
      hits: hits,
      misses: misses
    };
  }

  function scoreAll(attrs, forceAll) {
    const cands = collectCandidates(attrs, forceAll);
    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      const r = scoreOf(el, attrs);
      out.push({ el: el, score: r.score, coverage: r.coverage, hits: r.hits, misses: r.misses });
    }
    out.sort(function (a, b) {
      return b.score - a.score || b.coverage - a.coverage;
    });
    return out;
  }

  /**
   * 候选排序：先窄扫（拿最有选择性的属性做一次 CSS 粗筛），结果不理想时再全量重扫。
   *
   * 【为什么必须补这一次重扫】
   *   粗筛是把双刃剑。它把候选集从几千压到几十（这是性能的全部来源），
   *   但一旦粗筛用的那个属性本身对不上了（站点改版把它改了、页面上换了 id），
   *   目标元素**压根不在候选集里** —— 打分算法再准也救不回来，
   *   表现出来就是"莫名其妙找不到"，而且错误信息会指向一个很迷惑的方向。
   *   用几毫秒换回这种召回率，而"老描述符遇上改版页面"恰恰是最需要它发挥作用的场景。
   */
  function ranking(attrs, o) {
    const narrow = scoreAll(attrs);
    if (narrow.length && narrow[0].score >= o.minScore) return narrow;

    const wide = scoreAll(attrs, true);
    // 全量结果确实更好才采用，否则白白多扫一遍全页
    if (wide.length && (!narrow.length || wide[0].score > narrow[0].score)) return wide;
    return narrow;
  }

  // ───────────────────────── 错误构造 ─────────────────────────

  /**
   * 定位类错误一律带三样东西：分数、候选、下一步。
   * 光说"未找到元素"等于没说 —— agent 和人都拿不到任何可行动信息。
   */
  function locateError(head, ranked, attrs) {
    const lines = [head];
    if (ranked.length) {
      lines.push('  候选 ' + ranked.length + ' 个，最高分 ' + round2(ranked[0].score));
      const top = ranked[0].el;
      lines.push('  最高分候选：' + brief(top));
      if (ranked[0].misses.length) {
        const m = ranked[0].misses
          .slice(0, 4)
          .map((x) => x.k + '（要 "' + x.want + '"，实际 "' + x.actual + '"）')
          .join('、');
        lines.push('  未命中：' + m);
      }
    } else {
      lines.push('  粗筛阶段就没有候选 —— 描述符里的属性值和页面现状可能完全对不上');
    }
    lines.push('  描述符属性：' + attrs.map((a) => a.k + '=' + String(a.v).slice(0, 30)).join(' | '));
    const err = new Error(lines.join('\n'));
    err.locatorFailure = true;
    err.ranked = ranked;
    return err;
  }

  /** 元素的一行人话摘要，用于日志与错误信息 */
  function brief(el) {
    if (!el) return '(空)';
    const tag = (el.tagName || '?').toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = clsOf(el).slice(0, 2).join('.');
    const t = RK.adapter.ownText(el).slice(0, 30);
    return '<' + tag + id + (cls ? '.' + cls : '') + '>' + (t ? ' “' + t + '”' : '');
  }

  // ───────────────────────── 对外定位 ─────────────────────────

  /** 宽松版：返回按分数排序的候选数组，不抛错。给 resolveAll 用 */
  function locateAll(descriptor, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const attrs = normAttrs(descriptor);
    if (!attrs.length) return [];

    let ranked = ranking(attrs, o);
    if (o.visible !== false) {
      const vis = ranked.filter((r) => RK.adapter.isVisible(r.el));
      if (vis.length) ranked = vis; // 全不可见时保留原结果，交给上层报错（错误信息更有诊断价值）
    }
    return ranked.map((r) => r.el);
  }

  /**
   * 严格版：三条接受条件全过才返回元素，否则抛错。给 resolve 用。
   */
  function locate(descriptor, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const attrs = normAttrs(descriptor);
    if (!attrs.length) {
      throw new Error('描述符里没有任何属性（attrs 为空），无法定位');
    }

    let ranked = ranking(attrs, o);
    if (o.visible !== false) {
      const vis = ranked.filter((r) => RK.adapter.isVisible(r.el));
      if (vis.length) ranked = vis;
    }

    if (!ranked.length) {
      throw locateError('描述符定位失败：页面里没有任何候选元素', ranked, attrs);
    }

    const top = ranked[0];
    const second = ranked[1];

    // 显式指定 index = 人工消歧，此时跳过歧义检查（但仍要求最高分够像）
    const explicitIndex = o.index != null && o.index !== '' ? Number(o.index) : null;
    if (explicitIndex != null && !Number.isNaN(explicitIndex)) {
      if (top.score < o.minScore) {
        throw locateError(
          '描述符定位失败：最高分只有 ' + round2(top.score) + '（低于阈值 ' + o.minScore + '），未采用 index',
          ranked,
          attrs
        );
      }
      if (explicitIndex >= ranked.length) {
        throw new Error('候选不足：只找到 ' + ranked.length + ' 个，请求第 ' + explicitIndex + ' 个');
      }
      const pick = ranked[explicitIndex];
      return attach(pick.el, pick, ranked, attrs, { viaIndex: explicitIndex, ambiguous: ranked.length > 1 });
    }

    if (top.score < o.minScore) {
      throw locateError(
        '描述符定位失败：最高分只有 ' + round2(top.score) + '，低于阈值 ' + o.minScore + '。' +
          '说明页面结构和描述符已经对不上 —— 应该重新拾取，而不是降低阈值硬点。',
        ranked,
        attrs
      );
    }

    if (second && top.score - second.score < o.minGap) {
      const err = locateError(
        '定位到多个高度相似的元素，拒绝猜测（Top1=' +
          round2(top.score) +
          '，Top2=' +
          round2(second.score) +
          '，差 ' +
          round2(top.score - second.score) +
          ' < ' + o.minGap + '）。' +
          '请补充更具区分度的属性（text / data-testid / role），或显式传 index 指定第几个。',
        ranked,
        attrs
      );
      err.ambiguous = true;
      throw err;
    }

    if (top.coverage < o.minCoverage) {
      throw locateError(
        '描述符定位证据不足：完全命中的属性权重占比只有 ' +
          round2(top.coverage) +
          '（低于 ' + o.minCoverage + '）。' +
          '分数虽然够了，但没有一条属性是硬证据 —— 多半是几条属性都只勉强沾边凑出来的高分。' +
          '这种情况宁可重新拾取，也不要硬点。',
        ranked,
        attrs
      );
    }

    return attach(top.el, top, ranked, attrs, {});
  }

  /** 把打分详情一并返回 —— agent 拿到分数才知道这次定位有多可信 */
  function attach(el, pick, ranked, attrs, extra) {    return Object.assign(
      {
        el: el,
        score: round2(pick.score),
        coverage: round2(pick.coverage),
        runnerUp: ranked[1] ? round2(ranked[1].score) : null,
        candidateCount: ranked.length,
        hits: pick.hits,
        misses: pick.misses,
        attrs: attrs.map((a) => a.k + '=' + String(a.v).slice(0, 40)).join(' | '),
        brief: brief(el)
      },
      extra || {}
    );
  }

  /**
   * 候选排行榜（前 N 名，含打分明细）。
   * 用途只有一个：让"为什么点到了这个元素"变得可解释 —— 排查歧义时没有它等于盲查。
   * 判定逻辑本身不依赖它。
   */
  function rank(descriptor, opt) {
    const o = Object.assign({}, DEFAULTS, opt || {});
    const attrs = normAttrs(descriptor);
    if (!attrs.length) return [];

    let ranked = ranking(attrs, o);
    if (o.visible !== false) {
      const vis = ranked.filter((r) => RK.adapter.isVisible(r.el));
      if (vis.length) ranked = vis;
    }

    return ranked.slice(0, o.maxCandidates).map(function (r) {
      return {
        score: round2(r.score),
        coverage: round2(r.coverage),
        brief: brief(r.el),
        rect: (function () {
          const b = r.el.getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
        })(),
        hits: r.hits,
        misses: r.misses
      };
    });
  }

  // ───────────────────────── 描述符生成（供拾取器使用）─────────────────────────

  /** 看起来像"每次发版都会变"的 id：长十六进制、连续数字编号 */
  function volatileId(v) {
    if (!v) return true;
    if (v.length > 64) return true;
    if (/^[0-9a-f]{8,}$/i.test(v)) return true;
    if (/\d{3,}/.test(v)) return true;
    if (/^:/.test(v)) return true; // React useId 产物，形如 :r7:
    return false;
  }

  /** 看起来像构建期生成的类名：css-1x2y3z / sc-bdVaJa / data-v-7a3c1b2c / 一串哈希 */
  function volatileClass(v) {
    if (!v) return true;
    if (v.length > 40) return true;
    if (/^data-v-/.test(v)) return true; // Vue scoped 哈希：data-v-7a3c1b2c
    if (/^(css|sc|jsx|emotion|svelte|chakra)-[0-9a-z]{4,}$/i.test(v)) return true;
    if (/^[a-z]+-[0-9a-f]{6,}$/i.test(v)) return true; // css-1x2y3z / a1b2c3d4 形态
    if (/\d{4,}/.test(v)) return true;
    return false;
  }

  /**
   * 文本 → 属性规格。
   *
   * 【为什么含数字的文本要转正则】
   *   "共 23 条" 这种文本里的数字是动的（翻页就变），写成等值匹配，
   *   下次页面显示 31 条时定位立刻失效。转成 ^共 \d+ 条$ 就稳定了。
   * 【为什么"数字占比太高"的文本直接丢掉】
   *   "23" 本身毫无区分度 —— 全页面到处是数字，留着它只会制造歧义。
   */
  function textSpec(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 80) return null;

    const stripped = t.replace(/\d+/g, '');
    if (!/\d/.test(t)) return { k: 'text', v: t, m: 'eq' };

    // 去掉数字后剩下的实义字符太少 → 这个文本不足以定位
    if (stripped.replace(/\s+/g, '').length < 2) return null;

    const pattern = '^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+') + '$';
    return { k: 'text', v: pattern, m: 'regex' };
  }

  /**
   * 用一组属性去定位，判断"是否唯一命中目标"。
   * 这是最小充分裁剪的裁判。
   */
  function evaluate(el, attrs) {
    const ranked = scoreAll(attrs);
    const idx = ranked.findIndex((r) => r.el === el);
    if (idx < 0) return { unique: false, score: 0, count: ranked.length, rank: -1 };
    const top = ranked[0];
    const second = ranked[1];
    const unique =
      idx === 0 &&
      top.score >= 0.85 &&
      (!second || top.score - second.score >= DEFAULTS.minGap);
    return { unique: unique, score: top.score, count: ranked.length, rank: idx };
  }

  /**
   * 最小充分裁剪 —— 影刀最精髓的一步，也是"手写选择器"和"自动生成描述符"的分水岭。
   *
   * 【为什么必须裁】
   *   属性太少的描述符会误匹配（页面上三个"提交"按钮全中），
   *   属性太多的描述符一改版就废（10 条属性里改掉 1 条就认不出来）。
   *   最优解是"刚好够唯一的那个最小集合"，而这个集合只能实测出来 ——
   *   所以做法是：从全量出发，逐条试着删，删掉仍然唯一就确认删。
   *
   * 代价是 n 次全量打分（n = 属性条数，通常 5~8），
   * 每次几毫秒，合计几十毫秒 —— 拾取是交互式操作，人根本感知不到。
   */
  /** 裁剪后至少要留几条"实义属性"（tag 这种只用于粗筛的不算） */
  const MIN_MEANINGFUL = 2;

  function prune(el, attrs) {
    const base = evaluate(el, attrs);
    if (!base.unique) return { attrs: attrs, quality: base };

    let cur = attrs.slice();
    for (let i = cur.length - 1; i >= 0; i--) {
      if (cur[i].pf) continue; // 粗筛属性不参与裁剪：删了它，候选集会退化成全页扫描
      const trial = cur.slice(0, i).concat(cur.slice(i + 1));
      if (!trial.length) continue;

      // 少于两条实义属性就停止裁剪。
      // 纯"最小"会裁到只剩一条 —— 看着干净，但页面一改就彻底失效，没有任何兜底。
      // 留两条是为了"改版改掉其中一条时，另一条还能把元素框住"。
      let meaningful = 0;
      for (let j = 0; j < trial.length; j++) if (!trial[j].pf) meaningful++;
      if (meaningful < MIN_MEANINGFUL) continue;

      const r = evaluate(el, trial);
      if (r.unique) cur = trial;
    }
    return { attrs: cur, quality: evaluate(el, cur) };
  }

  /**
   * 从一个真实元素反向生成描述符。
   * 拾取器点一下，产出的就是这个东西 —— 它会被 agent 存下来复用。
   */
  function buildFrom(el, opt) {
    const o = Object.assign({ note: '' }, opt || {});
    if (!el || el.nodeType !== 1) throw new Error('拾取目标不是元素节点');

    const attrs = [];
    const dropped = [];

    const testid = readAttr(el, 'testid');
    if (testid) attrs.push({ k: 'testid', v: testid, m: 'eq' });

    const id = el.id || '';
    if (id) {
      if (volatileId(id)) dropped.push('id=' + id + '（像运行期生成的）');
      else attrs.push({ k: 'id', v: id, m: 'eq' });
    }

    const role = readAttr(el, 'role');
    if (role) attrs.push({ k: 'role', v: role, m: 'eq' });

    const name = readAttr(el, 'name');
    if (name) attrs.push({ k: 'name', v: name, m: 'eq' });

    const aria = readAttr(el, 'aria-label');
    if (aria && aria.length <= 60) attrs.push({ k: 'aria-label', v: aria, m: 'eq' });

    const ph = readAttr(el, 'placeholder');
    if (ph && ph.length <= 60) attrs.push({ k: 'placeholder', v: ph, m: 'contains' });

    const title = readAttr(el, 'title');
    if (title && title.length <= 60) attrs.push({ k: 'title', v: title, m: 'contains' });

    const ts = textSpec(readAttr(el, 'text'));
    if (ts) attrs.push(ts);

    const type = readAttr(el, 'type');
    if (type) attrs.push({ k: 'type', v: type, m: 'eq' });

    // class 单独处理：逐个过滤易变值，剩下的才有资格进描述符
    const rawCls = clsOf(el);
    const keepCls = rawCls.filter((c) => !volatileClass(c));
    if (rawCls.length && !keepCls.length) dropped.push('class="' + rawCls.join(' ') + '"（全是构建期生成的）');
    else if (keepCls.length && keepCls.length <= 3) attrs.push({ k: 'cls', v: keepCls.join(' '), m: 'words' });
    else if (keepCls.length > 3) attrs.push({ k: 'cls', v: keepCls.slice(0, 3).join(' '), m: 'words' });

    // tag 永远放最后，标记 pf（仅用于粗筛，不参与裁剪）
    const tag = (el.tagName || '').toLowerCase();
    if (tag) attrs.push({ k: 'tag', v: tag, m: 'eq', pf: true });

    // 权重补齐 + 按权重降序（人看描述符时，最可信的属性排最前）
    const weighted = attrs.map((a) => Object.assign({}, a, { w: a.w != null ? a.w : WEIGHT[a.k] || 1 }));
    weighted.sort((a, b) => (a.pf ? 1 : 0) - (b.pf ? 1 : 0) || b.w - a.w);

    const pruned = prune(el, weighted);
    const finalAttrs = pruned.attrs;

    return {
      descriptor: {
        v: 1,
        note: o.note || '',
        attrs: finalAttrs
      },
      quality: {
        unique: pruned.quality.unique,
        score: round2(pruned.quality.score),
        candidateCount: pruned.quality.count,
        rank: pruned.quality.rank
      },
      dropped: dropped,
      summary: summarize(finalAttrs, pruned.quality)
    };
  }

  /** 把描述符说成一句人话，给面板和 agent 看 */
  function summarize(attrs, quality) {
    const parts = attrs
      .filter((a) => !a.pf)
      .map((a) => {
        const v = String(a.v);
        const short = v.length > 24 ? v.slice(0, 24) + '…' : v;
        return a.k + '=' + (a.m === 'eq' ? '"' + short + '"' : short);
      });
    const q = quality
      ? quality.unique
        ? '唯一命中（' + round2(quality.score) + '）'
        : '⚠ 不唯一：页面上还有 ' + Math.max(0, quality.count - 1) + ' 个相似元素，建议补充区分条件'
      : '';
    return parts.join(' + ') + (q ? ' → ' + q : '');
  }

  // ───────────────────────── 导出 ─────────────────────────

  RK.locator = {
    DEFAULTS: DEFAULTS,
    WEIGHT: WEIGHT,

    isDescriptor: isDescriptor,
    readAttr: readAttr,
    matchOne: matchOne,
    editDistance: editDistance,
    scoreOf: scoreOf,
    scoreAll: scoreAll,
    collectCandidates: collectCandidates,

    locate: locate,
    locateAll: locateAll,
    rank: rank,
    normAttrs: normAttrs,
    buildFrom: buildFrom,
    summarize: summarize,
    brief: brief,
    volatileId: volatileId,
    volatileClass: volatileClass,
    textSpec: textSpec,

    /** 内部函数，仅供单测断言用（不要在生产代码里依赖） */
    __test: {
      prune: prune,
      evaluate: evaluate,
      pickPrefilter: pickPrefilter,
      implicitRole: implicitRole,
      clsOf: clsOf
    }
  };

  RK.__locatorLoaded = true;
})();
