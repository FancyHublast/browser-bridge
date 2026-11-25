/**
 * Browser Bridge · 页内悬浮控制面板（panel）
 *
 * 【为什么用 Shadow DOM 而不是直接往页面塞 div？】
 *   双向隔离：
 *     - 出：站点的高优先级 CSS（!important 的全局 reset 很常见）会把我们的面板样式冲烂；
 *     - 入：我们的样式选择器也可能污染站点里恰好同名的 class。
 *   Shadow root 是浏览器原生的样式隔离边界，是唯一干净的做法。
 *
 * 【为什么面板还值得存在？】
 *   它是「接 agent 之前的能力验证台」：连接状态、当前档位、几个手测按钮。
 *   当 agent 那边报"点不动"时，第一件事就是让人在面板上手动点一下 —— 用来区分
 *   「插件坏了」还是「agent 的指令错了」。这个分诊能力能省掉大量扯皮。
 */
(function () {
  'use strict';

  if (!window.RK || window.RK.__panelLoaded) return;
  const RK = window.RK;

  const HOST_ID = '__bb_panel_host__';
  let hostEl = null;
  let shadow = null;
  let outEl = null;
  let dotEl = null;
  let statusEl = null;
  let hintEl = null;
  let currentMode = 'light';
  let expanded = false;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .wrap {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 12px; line-height: 1.5; color: #E6F1FB;
      user-select: none;
    }

    .fab {
      width: 40px; height: 40px; border-radius: 50%;
      background: #185FA5; border: 1px solid #85B7EB;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-weight: 500; font-size: 12px; letter-spacing: .5px;
      color: #E6F1FB;
    }
    .fab:hover { background: #378ADD; }

    .panel {
      display: none; width: 268px; border-radius: 12px;
      background: #042C53; border: 1px solid #378ADD;
      overflow: hidden;
    }
    .wrap.open .panel { display: block; }
    .wrap.open .fab { display: none; }

    header {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 10px; background: #0C447C; border-bottom: 1px solid #185FA5;
      font-weight: 500;
    }
    header .ver { color: #85B7EB; font-size: 11px; font-weight: 400; }
    header .spacer { flex: 1; }
    header button {
      background: transparent; border: 0; color: #B5D4F4; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 4px;
      font-family: inherit;
    }
    header button:hover { background: #185FA5; color: #fff; }

    .body { padding: 10px; display: flex; flex-direction: column; gap: 9px; }

    .status { display: flex; align-items: center; gap: 7px; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #888780; flex: none;
    }
    .dot.on { background: #5DCAA5; }
    .dot.off { background: #E24B4A; }
    .status .txt { color: #B5D4F4; }

    .row { display: flex; align-items: center; gap: 6px; color: #B5D4F4; }
    .seg { display: flex; border: 1px solid #185FA5; border-radius: 7px; overflow: hidden; }
    .seg button {
      background: transparent; border: 0; color: #B5D4F4; cursor: pointer;
      padding: 3px 10px; font-size: 11px; font-family: inherit;
    }
    .seg button.active { background: #378ADD; color: #fff; }

    .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .btns button {
      background: #0C447C; border: 1px solid #185FA5; color: #E6F1FB;
      border-radius: 7px; padding: 6px 4px; cursor: pointer;
      font-size: 11px; font-family: inherit;
    }
    .btns button:hover { background: #185FA5; }
    .btns button.active { background: #5DCAA5; border-color: #5DCAA5; color: #04342C; }

    .out {
      max-height: 132px; overflow: auto; white-space: pre-wrap; word-break: break-all;
      background: #042C53; border: 1px solid #185FA5; border-radius: 7px;
      padding: 7px; color: #9FE1CB; font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .out:empty::before { content: "待命中"; color: #85B7EB; }

    /* 未连接时的操作指引。默认不占位，连上就消失。 */
    .hint {
      display: none; white-space: pre-wrap; word-break: break-all;
      background: #3A1D1F; border: 1px solid #E24B4A; border-radius: 7px;
      padding: 7px; color: #F5B7B6; font-size: 11px; line-height: 1.55;
    }
  `;

  function html() {
    return (
      '<div class="wrap">' +
      '<div class="fab" title="Browser Bridge（Alt+Shift+Z）">BB</div>' +
      '<div class="panel">' +
      '<header>Browser Bridge <span class="ver">v' + RK.VERSION + '</span>' +
      '<span class="spacer"></span><button data-act="close" title="收起">\u00d7</button></header>' +
      '<div class="body">' +
      '<div class="status"><span class="dot"></span><span class="txt">连接中…</span></div>' +
      '<div class="hint"></div>' +
      '<div class="row">档位<span class="seg">' +
      '<button data-mode="light" class="active">轻量</button>' +
      '<button data-mode="debugger">增强</button>' +
      '</span></div>' +
      '<div class="btns">' +
      '<button data-act="info">页面信息</button>' +
      '<button data-act="shot">截图</button>' +
      '<button data-act="cookie">Cookie</button>' +
      '<button data-act="net">开始抓包</button>' +
      // 拾取：人自己在页面上圈元素，结果存下来给 agent 用（也可用快捷键 Alt+Shift+A）
      '<button data-act="pick" title="按住 Ctrl + 左键连续点选元素，Esc 结束并保存（Alt+Shift+A）">拾取元素</button>' +
      '</div>' +
      '<div class="out"></div>' +
      '</div></div></div>'
    );
  }

  /** 面板 -> service worker 的通道，永远 resolve，不把异常抛回 UI */
  function toSW(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(payload, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: '空响应' });
        });
      } catch (e) {
        // 扩展被重载/卸载后旧 content script 的 chrome.* 会失效，这是预期内的
        resolve({ ok: false, error: '扩展上下文已失效，请刷新页面（F5）' });
      }
    });
  }

  function print(title, data) {
    if (!outEl) return;
    let text;
    if (typeof data === 'string') text = data;
    else {
      try {
        text = JSON.stringify(data, null, 1);
      } catch (e) {
        text = String(data);
      }
    }
    if (text.length > 1400) text = text.slice(0, 1400) + '\n…';
    outEl.textContent = '[' + new Date().toLocaleTimeString() + '] ' + title + '\n' + text;
  }

  function setExpanded(v) {
    expanded = !!v;
    if (!hostEl) return;
    const wrap = shadow.querySelector('.wrap');
    wrap.classList.toggle('open', expanded);
  }

  function setState(st) {
    if (!shadow) return;
    if (st.mode && st.mode !== currentMode) {
      currentMode = st.mode;
      shadow.querySelectorAll('[data-mode]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === currentMode);
      });
    }
    if (st.connected != null) {
      if (dotEl) dotEl.className = 'dot ' + (st.connected ? 'on' : 'off');
    }
    if (statusEl) {
      const parts = [];
      parts.push(st.connected ? '已连接' : '未连接');
      if (st.wsUrl) parts.push(st.wsUrl.replace(/^ws:\/\//, ''));
      // 有 hint 时就不把 reason（"连接已断开"这类）再叠一句，避免同一件事说两遍
      if (st.lenient && !st.hint) parts.push(st.lenient);
      statusEl.textContent = parts.join(' · ');
    }
    if (hintEl) {
      if (st.hint) {
        hintEl.textContent = st.hint;
        hintEl.style.display = 'block';
      } else {
        hintEl.textContent = '';
        hintEl.style.display = 'none';
      }
    }
    if (st.recording != null) {
      const btn = shadow.querySelector('[data-act="net"]');
      if (btn) {
        btn.classList.toggle('active', !!st.recording);
        btn.textContent = st.recording ? '停止抓包' : '开始抓包';
      }
    }
  }

  async function handleAct(act) {
    switch (act) {
      case 'close':
        setExpanded(false);
        return;
      case 'info': {
        print('页面信息', RK.actions.metrics());
        return;
      }
      case 'shot': {
        print('截图', '正在截取…');
        const r = await toSW({ __bb_panel: true, action: 'screenshot' });
        if (!r || !r.ok) print('截图失败', (r && r.error) || '无响应');
        else print('截图完成', r.data);
        return;
      }
      case 'cookie': {
        const r = await toSW({ __bb_panel: true, action: 'cookies' });
        print(r && r.ok ? 'Cookie' : 'Cookie 失败', r && r.ok ? r.data : r && r.error);
        return;
      }
      case 'net': {
        const r = await toSW({ __bb_panel: true, action: 'net_toggle' });
        print('抓包', r && r.ok ? r.data : (r && r.error) || '无响应');
        return;
      }
      case 'pick': {
        // 走 SW 而不是直接调 RK.picker.start：面板是页面里的 UI，
        // 但它发起的拾取必须让 SW 知道（结果要落盘给 browser_picks 取用）。
        // 收起面板再开始，否则悬浮窗会挡住要拾取的元素。
        setExpanded(false);
        const r = await toSW({ __bb_panel: true, action: 'pick' });
        print(r && r.ok ? '拾取' : '拾取失败', r && r.ok ? '已进入拾取模式：按住 Ctrl + 左键点击目标元素，Esc 结束' : (r && r.error) || '无响应');
        return;
      }
      default:
        return;
    }
  }

  function mount() {
    if (hostEl && document.documentElement.contains(hostEl)) return hostEl;

    /**
     * 【先清掉 DOM 里遗留的同 id 节点】
     * 扩展每次重载都会产生一个**新的隔离世界**，而旧世界的 BB 球是页面 DOM 里的
     * 普通节点，不会随之消失 —— 旧实例这时已经"死"了（chrome.* 全部失效，
     * 点它没有任何反应），但它仍然覆盖在页面上。
     *
     * 新世界的 hostEl 变量是空的，光看变量发现不了 DOM 里已经有一个，
     * 于是又挂一个 —— 页面上出现两个球，用户分不清该点哪个，点击常常打到死的那个上。
     * 这里按 id 兜底清理，保证任何时刻页面上只有一个可用的面板。
     */
    try {
      const stale = document.querySelectorAll('[id="' + HOST_ID + '"]');
      for (let i = 0; i < stale.length; i++) {
        if (stale[i] !== hostEl) {
          try {
            stale[i].remove();
          } catch (e) {
            /* 单个删不掉就继续，不影响挂载 */
          }
        }
      }
    } catch (e) {
      /* 忽略 */
    }

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const holder = document.createElement('div');
    holder.innerHTML = html();
    shadow.appendChild(holder);

    outEl = shadow.querySelector('.out');
    dotEl = shadow.querySelector('.dot');
    statusEl = shadow.querySelector('.status .txt');
    hintEl = shadow.querySelector('.hint');

    shadow.querySelector('.fab').addEventListener('click', function () {
      setExpanded(true);
      toSW({ __bb_panel: true, action: 'hello' });
    });

    shadow.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        handleAct(btn.getAttribute('data-act'));
      });
    });

    shadow.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mode = btn.getAttribute('data-mode');
        toSW({ __bb_panel: true, action: 'set_mode', mode: mode }).then(function (r) {
          if (r && r.ok) setState(r.data);
          else print('切换失败', (r && r.error) || '无响应');
        });
      });
    });

    // 宿主元素吃掉所有事件，别让站点的全局快捷键/点击委托看见我们的面板
    ['mousedown', 'mouseup', 'click', 'keydown', 'keypress', 'keyup'].forEach(function (t) {
      hostEl.addEventListener(t, function (e) {
        e.stopPropagation();
      });
    });

    document.documentElement.appendChild(hostEl);

    // 快捷键 Alt+Shift+Z 唤起/收起
    window.addEventListener(
      'keydown',
      function (e) {
        if (e.altKey && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
          setExpanded(!expanded);
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    return hostEl;
  }

  RK.panel = {
    mount: mount,
    setState: setState,
    setExpanded: setExpanded,
    print: print,
    isMounted: function () {
      return !!(hostEl && document.documentElement.contains(hostEl));
    }
  };

  RK.__panelLoaded = true;
})();
