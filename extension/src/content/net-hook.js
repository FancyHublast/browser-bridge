/**
 * Browser Bridge · 页面主世界网络探针（net-hook）
 *
 * 【为什么必须跑在 MAIN world？】
 *   要 hook 页面的 fetch / XMLHttpRequest，就必须拿到页面那个 window 上的真实函数引用。
 *   content script 默认跑在隔离世界（ISOLATED），那里看到的 fetch 是包装过的、
 *   改了也不影响页面实际发起请求。所以本文件在 manifest 里声明 `"world": "MAIN"`。
 *
 * 【MAIN world 拿不到 chrome.* API】
 *   主世界没有扩展 API，所以抓到数据只能用 window.postMessage 抛给隔离世界的 content script，
 *   再由它转发给 service worker。协议标记：{ __bb_net: true, payload: {...} }
 *
 * 【run_at: document_start】
 *   必须早于页面脚本执行，否则页面的 fetch 早被别人的工具包装/缓存走了，我们 hook 不到。
 *
 * 【隐私边界】
 *   只抓「页面自己主动发起的」fetch/XHR 的 URL、方法、状态码、请求体、响应体摘要。
 *   请求头里的 Authorization / Cookie 一律不落缓存（见 config.js 的 SENSITIVE_HEADERS）。
 *   响应体截断到 MAX_BODY_CHARS，避免大文件把 service worker 撑爆。
 */
(function () {
  'use strict';

  if (window.__BB_NET_HOOKED__) return;
  window.__BB_NET_HOOKED__ = true;

  // 这两个常量与 content/config.js 保持一致；MAIN world 读不到隔离世界的 window.RK
  var MAX_BODY_CHARS = 20000;
  var SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'x-csrf-token',
    'x-xsrf-token',
    'x-auth-token'
  ];

  var seq = 0;

  function post(payload) {
    try {
      window.postMessage({ __bb_net: true, payload: payload }, '*');
    } catch (e) {
      /* 结构化克隆失败（如包含函数），丢弃即可，不能影响页面 */
    }
  }

  /** 把 Headers / 普通对象统一成扁平对象，并抹掉敏感头 */
  function normalizeHeaders(h) {
    var out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) {
          out[k] = v;
        });
      } else if (Array.isArray(h)) {
        h.forEach(function (pair) {
          if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
        });
      } else if (typeof h === 'object') {
        Object.keys(h).forEach(function (k) {
          out[k] = String(h[k]);
        });
      }
    } catch (e) {
      /* 忽略 */
    }

    var redacted = false;
    Object.keys(out).forEach(function (k) {
      if (SENSITIVE_HEADERS.indexOf(k.toLowerCase()) !== -1) {
        out[k] = '<已隐藏>';
        redacted = true;
      }
    });
    if (redacted) out['__bb_redacted'] = true;
    return out;
  }

  function clip(text) {
    if (text == null) return null;
    var s = String(text);
    if (s.length <= MAX_BODY_CHARS) return s;
    return s.slice(0, MAX_BODY_CHARS) + '\n…[已截断，原文 ' + s.length + ' 字符]';
  }

  function safeUrl(u) {
    try {
      return String(u).slice(0, 2000);
    } catch (e) {
      return '';
    }
  }

  /** 从 URL 里剥掉 query，留一个便于聚合的短名 */
  function shortName(u) {
    try {
      var url = new URL(u, location.href);
      var path = url.pathname;
      var parts = path.split('/').filter(Boolean);
      return (parts.length ? parts[parts.length - 1] : url.host).slice(0, 80);
    } catch (e) {
      return '';
    }
  }

  // ─────────────────────────────── fetch ───────────────────────────────
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;

    window.fetch = function (input, init) {
      var id = ++seq;
      var method = 'GET';
      var url = '';
      var reqBody = null;
      var reqHeaders = {};

      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          method = input.method || 'GET';
          url = input.url;
          reqHeaders = normalizeHeaders(input.headers);
        } else {
          url = String(input);
          method = (init && init.method) || 'GET';
          reqHeaders = normalizeHeaders(init && init.headers);
        }
        if (init && init.body) {
          reqBody = typeof init.body === 'string' ? clip(init.body) : '<非文本请求体:' + (init.body.constructor && init.body.constructor.name) + '>';
        }
      } catch (e) {
        /* 归一化失败不影响页面请求 */
      }

      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

      post({
        id: id,
        kind: 'fetch',
        phase: 'request',
        method: method.toUpperCase(),
        url: safeUrl(url),
        name: shortName(url),
        headers: reqHeaders,
        body: reqBody,
        t: Date.now(),
        pageUrl: location.href
      });

      var p;
      try {
        p = origFetch.apply(this, arguments);
      } catch (e) {
        post({ id: id, kind: 'fetch', phase: 'error', method: method, url: safeUrl(url), error: String(e && e.message || e), t: Date.now() });
        throw e;
      }

      return p.then(
        function (res) {
          var ms = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
          var respHeaders = {};
          try {
            respHeaders = normalizeHeaders(res.headers);
          } catch (e) {
            /* 忽略 */
          }

          // clone 一份读 body，绝不消费原始流（否则页面自己读不到响应了）
          var bodyPromise;
          try {
            bodyPromise = res.clone().text();
          } catch (e) {
            bodyPromise = Promise.resolve(null);
          }

          bodyPromise
            .then(function (text) {
              post({
                id: id,
                kind: 'fetch',
                phase: 'response',
                method: method.toUpperCase(),
                url: safeUrl(res.url || url),
                name: shortName(res.url || url),
                status: res.status,
                ok: res.ok,
                statusText: res.statusText,
                headers: respHeaders,
                body: clip(text),
                ms: Math.round(ms),
                t: Date.now()
              });
            })
            .catch(function () {
              post({
                id: id,
                kind: 'fetch',
                phase: 'response',
                method: method.toUpperCase(),
                url: safeUrl(res.url || url),
                status: res.status,
                ok: res.ok,
                body: '<响应体读取失败>',
                ms: Math.round(ms),
                t: Date.now()
              });
            });

          return res;
        },
        function (err) {
          var ms = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
          post({
            id: id,
            kind: 'fetch',
            phase: 'error',
            method: method.toUpperCase(),
            url: safeUrl(url),
            error: String(err && err.message || err),
            ms: Math.round(ms),
            t: Date.now()
          });
          throw err;
        }
      );
    };

    // 保留原函数的 name / length，减少被指纹检测发现"fetch 被换过"的概率
    try {
      Object.defineProperty(window.fetch, 'name', { value: origFetch.name });
      Object.defineProperty(window.fetch, 'length', { value: origFetch.length });
    } catch (e) {
      /* 忽略 */
    }
  }

  // ──────────────────────────── XMLHttpRequest ────────────────────────────
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var XP = window.XMLHttpRequest.prototype;
    var origOpen = XP.open;
    var origSend = XP.send;
    var origSetHeader = XP.setRequestHeader;

    XP.open = function (method, url) {
      this.__bb = {
        id: ++seq,
        method: String(method || 'GET').toUpperCase(),
        url: safeUrl(url),
        headers: {},
        t0: null
      };
      return origOpen.apply(this, arguments);
    };

    XP.setRequestHeader = function (k, v) {
      try {
        if (this.__bb && k) {
          if (SENSITIVE_HEADERS.indexOf(String(k).toLowerCase()) !== -1) {
            this.__bb.headers[k] = '<已隐藏>';
            this.__bb.headers.__bb_redacted = true;
          } else {
            this.__bb.headers[k] = String(v);
          }
        }
      } catch (e) {
        /* 忽略 */
      }
      return origSetHeader.apply(this, arguments);
    };

    XP.send = function (body) {
      var meta = this.__bb;
      if (meta) {
        meta.t0 = (window.performance && performance.now) ? performance.now() : Date.now();
        var self = this;

        post({
          id: meta.id,
          kind: 'xhr',
          phase: 'request',
          method: meta.method,
          url: meta.url,
          name: shortName(meta.url),
          headers: meta.headers,
          body: typeof body === 'string' ? clip(body) : (body ? '<非文本请求体>' : null),
          t: Date.now(),
          pageUrl: location.href
        });

        var finish = function (phase) {
          var ms = ((window.performance && performance.now) ? performance.now() : Date.now()) - meta.t0;
          var respBody = null;
          // 只读文本响应；blob/arraybuffer 读了会破坏页面自己的读取
          try {
            var rt = self.responseType;
            if (rt === '' || rt === 'text') respBody = clip(self.responseText);
            else if (rt === 'json') respBody = clip(JSON.stringify(self.response));
          } catch (e) {
            respBody = '<响应体读取失败>';
          }

          var respHeaders = {};
          try {
            var raw = self.getAllResponseHeaders ? self.getAllResponseHeaders() : '';
            raw.split(/\r?\n/).forEach(function (line) {
              var i = line.indexOf(':');
              if (i > 0) {
                var k = line.slice(0, i).trim();
                if (SENSITIVE_HEADERS.indexOf(k.toLowerCase()) !== -1) respHeaders[k] = '<已隐藏>';
                else respHeaders[k] = line.slice(i + 1).trim();
              }
            });
          } catch (e) {
            /* 忽略 */
          }

          post({
            id: meta.id,
            kind: 'xhr',
            phase: phase,
            method: meta.method,
            url: meta.url,
            name: shortName(meta.url),
            status: self.status,
            ok: self.status >= 200 && self.status < 300,
            headers: respHeaders,
            body: respBody,
            ms: Math.round(ms),
            t: Date.now()
          });
        };

        this.addEventListener('load', function () {
          finish('response');
        });
        this.addEventListener('error', function () {
          finish('error');
        });
        this.addEventListener('timeout', function () {
          finish('error');
        });
      }

      return origSend.apply(this, arguments);
    };
  }

  // 告诉隔离世界：探针已就位
  post({ kind: 'hook', phase: 'ready', t: Date.now(), pageUrl: location.href });
})();
