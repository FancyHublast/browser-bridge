/**
 * Browser Bridge · 定位适配层（adapter）
 *
 * 【它和 locator.js 的分工 —— 两条路，一个入口】
 *   adapter = 「按选择器找元素」：CSS / XPath / text= / label=，命中即成功。
 *   locator = 「按描述符找元素」：多属性加权打分 + 歧义检测（见 locator.js）。
 *
 *   上层（actions / main）只调用 adapter.resolve / resolveAll：
 *     target 是字符串          → 走本文件的老路径，行为逐字节不变；
 *     target 是描述符对象 {attrs:[...]} → 自动转发给 RK.locator。
 *   调用方不需要知道有两条路 —— 这是"加能力"而不是"换实现"的关键：
 *   22 个现有工具、全部自测脚本、已经跑通的流程，一行都不用改。
 *
 * 【为什么把定位收敛在少数几个文件里】
 *   第三方站点改版是必然事件，不是意外事件。
 *   收敛起来，改版时改动面可控；新增定位策略也只落在这两处。
 *
 * 【选择器铁律 —— 写业务规则时务必遵守】
 *   ✅ 能用：稳定的 id、语义类名、data-* 业务属性、role、aria-label、name、placeholder
 *   ❌ 不能用：Vue scoped 哈希（data-v-7a3c1b2c）、React 内部属性（__reactFiber$xxx）、
 *              CSS-in-JS 生成类（css-1x2y3z）、构建期随机串
 *      —— 这些每次发版都变，写死了必然三天两头挂，且挂了极难定位。
 *
 * 【为什么不用 document.querySelector 一把梭？】
 *   1) 现代前端站点大量使用 Shadow DOM，querySelector 在 document 上穿不透 shadow 边界；
 *   2) 命中多个时需要一个确定的"先用哪个"策略（可见优先、面积大的优先）；
 *   3) agent 经常用人话给目标（"提交订单按钮"），需要文本兜底定位。
 */
(function () {
  'use strict';

  if (!window.RK || window.RK.__adapterLoaded) return;
  const RK = window.RK;

  /** Shadow DOM 遍历上限，防止在超大 DOM 上卡死主线程 */
  const MAX_SHADOW_ROOTS = 300;
  /** 收集 shadow root 时最多扫描的元素数 */
  const MAX_SCAN_ELEMENTS = 20000;

  /**
   * 收集 document 下所有 shadow root（BFS，带上限）。
   * 只在普通查询失败或需要深度查找时调用 —— 全量扫描很贵。
   */
  function collectShadowRoots() {
    const roots = [document];
    const queue = [document];
    let scanned = 0;

    while (queue.length && roots.length < MAX_SHADOW_ROOTS && scanned < MAX_SCAN_ELEMENTS) {
      const root = queue.shift();
      let all;
      try {
        all = root.querySelectorAll('*');
      } catch (e) {
        continue;
      }
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        scanned++;
        if (scanned > MAX_SCAN_ELEMENTS) break;
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    return roots;
  }

  /** 元素是否真实可见（有尺寸、未被 visibility/opacity 干掉、不在 display:none 子树里） */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  /** 取元素的可视面积，用于多个命中时排序 */
  function area(el) {
    try {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch (e) {
      return 0;
    }
  }

  /** 归一化文本：去首尾空白、压缩连续空白 */
  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** 取元素自身可见文本（不含隐藏子节点，但简化处理：直接 innerText 兜底 textContent） */
  function ownText(el) {
    if (!el) return '';
    const t = el.innerText != null ? el.innerText : el.textContent;
    return normText(t);
  }

  /**
   * 解析定位表达式，返回 {kind, value}
   *
   * 支持四种写法（借鉴 Playwright，但只保留最常用的）：
   *   css=#app .btn        显式 CSS
   *   #app .btn            裸 CSS（默认）
   *   xpath=//button[1]    显式 XPath
   *   //button[1]          裸 XPath
   *   text=提交订单         按可见文本包含匹配
   *   label=用户名         按 <label> 文本找关联控件
   */
  function parseTarget(target) {
    const raw = String(target == null ? '' : target).trim();
    if (!raw) throw new Error('定位表达式为空');

    if (raw.indexOf('css=') === 0) return { kind: 'css', value: raw.slice(4).trim() };
    if (raw.indexOf('xpath=') === 0) return { kind: 'xpath', value: raw.slice(6).trim() };
    if (raw.indexOf('text=') === 0) return { kind: 'text', value: raw.slice(5).trim() };
    if (raw.indexOf('label=') === 0) return { kind: 'label', value: raw.slice(6).trim() };
    if (raw.indexOf('//') === 0 || raw.indexOf('(') === 0) return { kind: 'xpath', value: raw };
    return { kind: 'css', value: raw };
  }

  function queryByXPath(expr) {
    const out = [];
    const roots = collectShadowRoots();
    for (let i = 0; i < roots.length; i++) {
      try {
        const r = document.evaluate(
          expr,
          roots[i],
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        for (let j = 0; j < r.snapshotLength; j++) {
          const node = r.snapshotItem(j);
          if (node && node.nodeType === 1) out.push(node);
        }
      } catch (e) {
        /* 某个 shadow root 里语法不适用，跳过 */
      }
      if (out.length) break; // 找到即止，避免重复命中
    }
    return out;
  }

  function queryByCss(sel, deep) {
    const out = [];
    if (!deep) {
      try {
        return Array.prototype.slice.call(document.querySelectorAll(sel));
      } catch (e) {
        throw new Error('CSS 选择器语法错误：' + sel);
      }
    }
    const roots = collectShadowRoots();
    for (let i = 0; i < roots.length; i++) {
      try {
        const list = roots[i].querySelectorAll(sel);
        for (let j = 0; j < list.length; j++) out.push(list[j]);
      } catch (e) {
        throw new Error('CSS 选择器语法错误：' + sel);
      }
    }
    return out;
  }

  function queryByText(text, exact) {
    const needle = normText(text);
    if (!needle) return [];
    const hit = [];
    const roots = collectShadowRoots();
    for (let i = 0; i < roots.length; i++) {
      let all;
      try {
        all = roots[i].querySelectorAll(
          'button, a, input[type=button], input[type=submit], [role=button], [role=link], ' +
            'label, li, td, th, span, div, p, h1, h2, h3, h4, option, summary'
        );
      } catch (e) {
        continue;
      }
      for (let j = 0; j < all.length; j++) {
        const el = all[j];
        const t = ownText(el);
        if (!t) continue;
        const matched = exact ? t === needle : t.indexOf(needle) !== -1;
        if (matched) hit.push(el);
      }
    }
    // 文本命中的往往是"包了一层的容器"，优先取文本最短的（最贴近真正可点的那个）
    hit.sort(function (a, b) {
      return ownText(a).length - ownText(b).length;
    });
    return dedupeNested(hit);
  }

  function queryByLabel(text) {
    const needle = normText(text);
    const out = [];
    const roots = collectShadowRoots();
    for (let i = 0; i < roots.length; i++) {
      let labels;
      try {
        labels = roots[i].querySelectorAll('label');
      } catch (e) {
        continue;
      }
      for (let j = 0; j < labels.length; j++) {
        const lb = labels[j];
        if (ownText(lb).indexOf(needle) === -1) continue;
        const forId = lb.getAttribute('for');
        if (forId) {
          const t = document.getElementById(forId);
          if (t) out.push(t);
        }
        const nested = lb.querySelector('input, textarea, select');
        if (nested) out.push(nested);
      }
    }
    return out;
  }

  /** 去掉互相嵌套的结果，只保留最外层（避免同一个按钮被算成 3 个元素） */
  function dedupeNested(list) {
    return list.filter(function (el, i) {
      return !list.some(function (other, j) {
        return i !== j && other.contains && other.contains(el);
      });
    });
  }

  /**
   * 解析目标 -> 元素数组
   * @param {string} target 定位表达式
   * @param {object} [opt] { deep: boolean, visible: boolean, all: boolean, index: number }
   */
  function resolveAll(target, opt) {
    opt = opt || {};
    // 描述符对象 → 交给 locator 做多属性加权打分（宽松模式：只排序，不抛错）
    // locator 缺失时要明确报错，否则会掉进下面的字符串分支：parseTarget 拿到一个对象，
    // 报出来的错会指向一个完全无关的方向，排查成本极高。
    if (isDescriptor(target)) {
      if (!RK.locator) throw new Error('locator 未加载，无法按描述符定位（请刷新页面后重试）');
      return RK.locator.locateAll(target, opt);
    }

    const parsed = parseTarget(target);
    let found = [];

    if (parsed.kind === 'css') found = queryByCss(parsed.value, opt.deep !== false);
    else if (parsed.kind === 'xpath') found = queryByXPath(parsed.value);
    else if (parsed.kind === 'text') found = queryByText(parsed.value, !!opt.exactText);
    else if (parsed.kind === 'label') found = queryByLabel(parsed.value);

    // 可见性过滤（默认开）—— 命中一堆隐藏模板节点是最常见的"点了没反应"根因
    if (opt.visible !== false) {
      const vis = found.filter(isVisible);
      // 全部不可见时不强行清空，交给上层报错，错误信息更有诊断价值
      if (vis.length) found = vis;
    }

    // 可见面积大的优先（过滤掉 1x1 的埋点元素、装饰性 span）
    if (found.length > 1) {
      const original = found.slice();
      found.sort(function (a, b) {
        return area(b) - area(a) || original.indexOf(a) - original.indexOf(b);
      });
    }

    if (opt.all) return found;
    return found;
  }

  /** 目标是不是 locator 描述符（而不是选择器字符串） */
  function isDescriptor(t) {
    return !!t && typeof t === 'object' && (Array.isArray(t.attrs) || (t.v != null && t.attrs));
  }

  /**
   * 解析描述符 → 元素，并带上打分详情（score / runnerUp / 未命中属性）。
   * 与 resolve 的区别：resolve 只关心"给个元素"，本函数给的是"这个结论有多可信"。
   * 歧义、阈值不达标时抛错 —— 宁可失败，也不猜。
   */
  function resolveDesc(target, opt) {
    if (!RK.locator) throw new Error('locator 未加载，无法按描述符定位');
    return RK.locator.locate(target, opt || {});
  }

  /** 解析单个元素；支持 index 指定第几个 */
  function resolve(target, opt) {
    opt = opt || {};
    // 描述符走严格模式：三条接受条件（够像 / 不撞车 / 证据足）全过才算数
    if (isDescriptor(target)) {
      if (!RK.locator) throw new Error('locator 未加载，无法按描述符定位（请刷新页面后重试）');
      return RK.locator.locate(target, opt).el;
    }

    const list = resolveAll(target, opt);
    if (!list.length) {
      throw new Error(
        '未找到元素：' + target + '（当前页面 ' + location.href.slice(0, 120) + '）'
      );
    }
    const idx = opt.index ? Number(opt.index) : 0;
    if (idx >= list.length) {
      throw new Error('元素数量不足：' + target + ' 只命中 ' + list.length + ' 个，请求第 ' + idx + ' 个');
    }
    return list[idx];
  }

  /** 元素中心点（视口坐标），可直接喂给 CDP 的 Input.dispatchMouseEvent */
  function center(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    };
  }

  /**
   * 穿透 Shadow DOM 的 elementFromPoint。
   * 页面用 Web Components 时，document.elementFromPoint 只会返回宿主元素，
   * 真正的可点节点在它内部的 shadowRoot 里。
   */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard++ < 20) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** 生成一个尽量稳定的 CSS 路径，供 agent 在后续步骤里复用 */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;

    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let seg = node.tagName.toLowerCase();
      const testId = node.getAttribute && node.getAttribute('data-testid');
      const dataId = node.getAttribute && (node.getAttribute('data-id') || node.getAttribute('data-key'));
      if (testId) {
        parts.unshift(seg + '[data-testid="' + testId + '"]');
        break;
      }
      if (dataId) {
        parts.unshift(seg + '[data-id="' + dataId + '"]');
        break;
      }
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(seg + '#' + node.id);
        break;
      }
      // 同类兄弟中排第几（nth-of-type 比 nth-child 稳，不受文本节点影响）
      if (node.parentElement) {
        const sibs = Array.prototype.filter.call(node.parentElement.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /**
   * 给 agent 回一个"这元素长啥样"的摘要。
   * 不返回 outerHTML —— 一个报表表格的 outerHTML 能到几 MB，直接撑爆 agent 上下文。
   */
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    const attrs = {};
    const wanted = ['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'value', 'href', 'title', 'data-testid'];
    for (let i = 0; i < wanted.length; i++) {
      const v = el.getAttribute && el.getAttribute(wanted[i]);
      if (v != null && v !== '') attrs[wanted[i]] = String(v).slice(0, 200);
    }
    const classes = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).slice(0, 6)
      : [];

    return {
      tag: el.tagName.toLowerCase(),
      path: cssPath(el),
      classes: classes,
      attrs: attrs,
      text: ownText(el).slice(0, 300),
      // 控件状态：agent 常需要知道"这个 checkbox 勾没勾"
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
      disabled: !!el.disabled,
      visible: isVisible(el),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      },
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
    };
  }

  RK.adapter = {
    parseTarget: parseTarget,
    isDescriptor: isDescriptor,
    resolve: resolve,
    resolveAll: resolveAll,
    resolveDesc: resolveDesc,
    isVisible: isVisible,
    center: center,
    deepElementFromPoint: deepElementFromPoint,
    cssPath: cssPath,
    describe: describe,
    ownText: ownText,
    normText: normText,
    collectShadowRoots: collectShadowRoots
  };

  RK.__adapterLoaded = true;
})();
