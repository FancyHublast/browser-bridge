/**
 * Browser Bridge · content 层公共底座（config）
 *
 * 【为什么用 window.RK 全局命名空间，而不是 ESM import？】
 *   MV3 的 content script 不支持 `import` / `export`，写了直接语法错误、脚本整体不执行。
 *   多文件的依赖顺序靠 manifest.json 里 content_scripts[].js 数组的顺序保证：
 *     config.js → adapter.js → locator.js → picker.js → actions.js → panel.js → main.js
 *   这是一个「装配顺序即依赖顺序」的隐式契约，改动数组顺序会静默炸掉后面所有文件。
 *   （adaptor 与 locator 谁先都行：两者只在运行时互相引用，不在加载期取用。）
 *
 * 【R K 是什么？】Render Kit 的缩写，隔离世界里的私有命名空间。
 *   页面脚本看不到 `window.RK`（隔离世界有独立的 window 包装），所以不会与站点变量冲突。
 */
(function () {
  'use strict';

  // 幂等守卫：扩展热重载 / executeScript 重复注入时，不重复初始化
  if (window.RK && window.RK.__loaded) return;

  const RK = (window.RK = window.RK || {});

  const VERSION = '1.3.3';

  const DEFAULTS = {
    /** 所有动作的默认超时（毫秒） */
    timeout: 15000,
    /** 合成点击的默认延迟（按下与抬起之间，毫秒）——太快会被某些风控判定为机器 */
    clickHoldMs: 28,
    /** 拖拽插值步数 —— 步数越多轨迹越像人手，但越慢 */
    dragSteps: 24,
    /** 拖拽每步间隔（毫秒） */
    dragStepMs: 12,
    /** 逐字符输入的字符间隔（毫秒） */
    typeDelayMs: 24,
    /** 是否打印调试日志 */
    debug: false
  };

  /** 网络抓包单条 body 的最大截取长度（字符），防止大响应把 SW 内存吃掉 */
  const MAX_BODY_CHARS = 20000;

  /** 网络抓包环形缓冲上限（条） */
  const MAX_NET_RECORDS = 2000;

  /**
   * 永不落缓存的敏感请求头。
   * 抓包是为了给 agent 看接口结构，不是为了把凭据抄一份存到磁盘上。
   */
  const SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'x-csrf-token',
    'x-xsrf-token',
    'x-auth-token'
  ];

  RK.VERSION = VERSION;
  RK.DEFAULTS = DEFAULTS;
  RK.MAX_BODY_CHARS = MAX_BODY_CHARS;
  RK.MAX_NET_RECORDS = MAX_NET_RECORDS;
  RK.SENSITIVE_HEADERS = SENSITIVE_HEADERS;

  /** 调试日志开关（由弹窗/指令动态设置，避免生产环境刷屏） */
  RK.debug = DEFAULTS.debug;

  RK.log = function () {
    if (!RK.debug) return;
    // eslint-disable-next-line no-console
    console.log.apply(console, ['%c[BB·content]', 'color:#5DCAA5'].concat([].slice.call(arguments)));
  };

  RK.warn = function () {
    // eslint-disable-next-line no-console
    console.warn.apply(console, ['[BB·content]'].concat([].slice.call(arguments)));
  };

  /** 统一 sleep，动作层到处要用 */
  RK.sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, Math.max(0, ms | 0));
    });
  };

  /** 带超时的 Promise 包装：任何动作都不允许无限期挂住 agent */
  RK.withTimeout = function (promise, ms, label) {
    let timer = null;
    const guard = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error('动作超时（' + ms + 'ms）：' + (label || '未命名动作')));
      }, ms);
    });
    return Promise.race([promise, guard]).finally(function () {
      if (timer) clearTimeout(timer);
    });
  };

  RK.__loaded = true;
  RK.__version = VERSION;
})();
