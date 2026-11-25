/**
 * Browser Bridge · 工具栏弹窗
 *
 * 【定位】它是"接线盒"，不是操作台。
 *   日常操作走 agent；弹窗只负责三件排障要用的事：
 *     看连接通不通、改服务地址/Token、切档位。
 *     看人拾取过的元素清单（agent 用 browser_picks 拉同一份数据，
 *     这里只是给人看的入口）。
 *   操作类的能力（点击、截图、抓包）都放在页内悬浮面板上 ——
 *   因为那才是"人正看着那个页面"时该出现的地方。
 *
 * 【注意】弹窗一关闭，这里的 JS 就停了。任何需要持续运行的逻辑都不能放这里，
 *   必须交给 service worker。
 */

const $ = (id) => document.getElementById(id);

function send(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (r) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(r || { ok: false, error: '空响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

function render(st) {
  const dot = $('dot');
  const conn = $('connText');

  if (st.connected) {
    dot.className = 'dot on';
    conn.textContent = '已连接 ' + String(st.url || '').replace(/^wss?:\/\//, '');
  } else {
    dot.className = 'dot off';
    const why = st.reason ? '（' + st.reason + '）' : '';
    conn.textContent = (st.state === 'connecting' ? '连接中…' : '未连接') + why;
  }

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === (st.mode || 'light'));
  });

  $('recText').textContent = st.recording
    ? '进行中，已缓存 ' + (st.netBuffered == null ? 0 : st.netBuffered) + ' 条'
    : '未开启';
}

function print(text) {
  $('out').textContent = text;
}

async function refresh() {
  const r = await send({ __bb_panel: true, action: 'status' });
  if (r && r.ok) render(r.data);
  else {
    $('dot').className = 'dot off';
    $('connText').textContent = '无法访问后台 service worker';
  }
}

async function loadConfig() {
  // 优先看企业策略（IT 统一下发）。命中就锁死输入框 ——
  // 否则用户照着旧文档填一遍、点了保存，下次重连又被打回策略值，会以为扩展有毛病。
  let managed = null;
  try {
    managed = await chrome.storage.managed.get(['wsUrl', 'wsToken']);
  } catch (e) {
    /* 没有配策略是绝大多数情况，静默走本地配置 */
  }
  if (managed && managed.wsUrl) {
    $('wsUrl').value = managed.wsUrl;
    $('wsToken').value = managed.wsToken || '';
    lockConfigInputs();
    return;
  }

  const cfg = await chrome.storage.local.get(['wsUrl', 'wsToken']);
  $('wsUrl').value = cfg.wsUrl || 'ws://127.0.0.1:8765';
  $('wsToken').value = cfg.wsToken || '';
}

/** 配置由企业策略下发时：输入框只读、保存按钮禁用，并把原因摆在按钮上 */
function lockConfigInputs() {
  const reason = '服务地址与 token 由企业策略统一配置，无法在此修改。如需调整请联系 IT。';
  for (const id of ['wsUrl', 'wsToken']) {
    const el = $(id);
    if (!el) continue;
    el.readOnly = true;
    el.title = reason;
    el.style.opacity = '0.65';
    el.placeholder = '由企业策略配置';
  }
  const save = $('save');
  if (save) {
    save.disabled = true;
    save.textContent = '由企业策略锁定';
    save.title = reason;
  }
}

// ───────────────────────── Tab 切换 ─────────────────────────

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    const name = t.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.pane').forEach((p) =>
      p.classList.toggle('active', p.getAttribute('data-pane') === name)
    );
    if (name === 'picks') refreshPicks();
  });
});

// ───────────────────────── 拾取的元素 ─────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return d.toLocaleString();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* 降级到旧 API */
  }
  // 降级：textarea + execCommand（popup 里有时 navigator.clipboard 不可用）
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function renderPickList(picks) {
  const list = $('pickList');
  const empty = $('pickEmpty');
  const bottom = $('pickBottom');

  if (!picks || !picks.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    bottom.style.display = 'none';
    $('picksBadge').style.display = 'none';
    $('picksTotal').textContent = '0';
    return;
  }

  empty.style.display = 'none';
  bottom.style.display = 'flex';
  $('picksBadge').style.display = 'inline-block';
  $('picksBadge').textContent = picks.length > 99 ? '99+' : String(picks.length);
  $('picksTotal').textContent = String(picks.length);

  list.innerHTML = picks
    .map((p, i) => {
      const name = p.name || 'unnamed';
      const auto = !p.name ? '<span class="auto">自动命名</span>' : '';
      const summary = escapeHtml(p.summary || '(无描述)');
      const url = escapeHtml(p.url || '');
      const frameTag = p.frameUrl && p.url && p.frameUrl !== p.url ? '🎯 ' + escapeHtml(p.frameUrl) : '';
      return (
        '<div class="pick" data-i="' + i + '">' +
        '<div class="name">' + escapeHtml(name) + auto + '</div>' +
        '<div class="summary">' + summary + '</div>' +
        '<div class="url">' + (p.title ? escapeHtml(p.title) + ' · ' : '') + url + '</div>' +
        '<div class="meta">' +
        (frameTag ? '<span class="f">' + frameTag + '</span>' : '') +
        '<span class="f">抓于 ' + fmtTime(p.pickedAt) + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="tiny copy">复制</button>' +
        '<button class="tiny danger del">删</button>' +
        '<span class="copy-state">已复制 ✓</span>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

async function refreshPicks() {
  // 直接读 chrome.storage.local 的 bb_picks 键，与 SW 落盘同一份
  const cfg = await chrome.storage.local.get(['bb_picks']);
  renderPickList(cfg.bb_picks || []);
}

async function copyAllPicks() {
  const cfg = await chrome.storage.local.get(['bb_picks']);
  const picks = cfg.bb_picks || [];
  if (!picks.length) {
    print('暂无可复制的拾取结果');
    return;
  }
  const ok = await copyText(JSON.stringify(picks, null, 2));
  print(ok ? '已复制 ' + picks.length + ' 条描述符到剪贴板' : '复制失败');
  // 同步一下 tab 标签页，让 pop 焦点切走时也能看到
  if (ok) {
    setTimeout(() => print(''), 1500);
  }
}

async function clearAllPicks() {
  const cfg = await chrome.storage.local.get(['bb_picks']);
  if (!(cfg.bb_picks && cfg.bb_picks.length)) return;
  await chrome.storage.local.remove('bb_picks');
  await refreshPicks();
}

// 事件代理：复制 / 删除
document.addEventListener('click', async (e) => {
  const pickEl = e.target.closest('.pick');
  if (!pickEl) return;
  const i = parseInt(pickEl.getAttribute('data-i'), 10);
  if (e.target.classList.contains('copy')) {
    const cfg = await chrome.storage.local.get(['bb_picks']);
    const item = (cfg.bb_picks || [])[i];
    if (!item) return;
    const ok = await copyText(JSON.stringify(item, null, 2));
    const state = pickEl.querySelector('.copy-state');
    if (state) {
      state.classList.add('show');
      state.textContent = ok ? '已复制 ✓' : '复制失败';
      setTimeout(() => state.classList.remove('show'), 1500);
    }
  } else if (e.target.classList.contains('del')) {
    const cfg = await chrome.storage.local.get(['bb_picks']);
    const arr = cfg.bb_picks || [];
    arr.splice(i, 1);
    await chrome.storage.local.set({ bb_picks: arr });
    await refreshPicks();
  }
});

$('pickCopyAll').addEventListener('click', copyAllPicks);
$('pickClear').addEventListener('click', clearAllPicks);

// ───────────────────────── 原连接 / 诊断 ─────────────────────────

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = btn.getAttribute('data-mode');
    const r = await send({ __bb_panel: true, action: 'set_mode', mode: mode });
    if (r && r.ok) {
      render(Object.assign({ connected: true }, r.data));
      await refresh();
      print(
        mode === 'debugger'
          ? '已切到增强档。注意：浏览器顶部会出现"正在调试此浏览器"提示条，且目标页的 F12 无法同时打开。'
          : '已切回轻量档，调试器已释放。'
      );
    } else {
      print('切换失败：' + ((r && r.error) || '未知错误'));
    }
  });
});

$('save').addEventListener('click', async () => {
  const url = $('wsUrl').value.trim();
  const token = $('wsToken').value;
  if (!/^wss?:\/\//i.test(url)) {
    print('地址必须以 ws:// 或 wss:// 开头');
    return;
  }

  // 最常见的填错：把 agent 用的 HTTP 端口（8766，路径 /mcp）填到扩展这里。
  // 扩展走的是 WebSocket，连一个 HTTP 端点必然握手失败，报 code=1006 —— 而
  // 这个错误码本身完全不提示"你端口填错了"，很容易被当成服务没启动。
  // 这里直接拦住，省得人对着"未连接"乱猜。
  if (/:8766\b/.test(url) || /\/mcp\b/.test(url)) {
    print(
      '⚠️ 这个地址看起来是给 agent 用的 HTTP 端口。\n' +
        '   扩展要连的是 WebSocket 端口，请改成：ws://127.0.0.1:8765\n' +
        '\n' +
        '   两个端口的分工：\n' +
        '     · 8765        WebSocket，给这个浏览器扩展\n' +
        '     · 8766/mcp    HTTP，给 agent（MCP over HTTP）'
    );
    return;
  }

  print('正在重连…');
  const r = await send({ __bb_panel: true, action: 'reconnect', wsUrl: url, wsToken: token });
  await refresh();
  if (r && r.ok && r.data && r.data.rejected) {
    print('⚠️ ' + r.data.rejected.reason);
    return;
  }
  print(r && r.ok ? '配置已保存。' + (r.data.connected ? '连接正常。' : '尚未连上，请确认本地服务已启动。') : '保存失败：' + ((r && r.error) || ''));
});

$('retry').addEventListener('click', async () => {
  print('正在重连…');
  const r = await send({ __bb_panel: true, action: 'reconnect' });
  await refresh();
  print(r && r.ok && r.data.connected ? '已连接。' : '仍未连上：' + ((r && r.data && r.data.reason) || '请确认本地服务已启动'));
});

$('probe').addEventListener('click', async () => {
  print('读取中…');
  const r = await send({ __bb_panel: true, action: 'probe' });
  if (!r || !r.ok) {
    print('失败：' + ((r && r.error) || '无响应'));
    return;
  }
  const d = r.data;
  print(
    [
      '标题：' + (d.title || '(空)'),
      '地址：' + (d.url || ''),
      '状态：' + (d.status || ''),
      '标签页 ID：' + d.tabId,
      '',
      '页面尺寸：' + (d.metrics && d.metrics.pageWidth) + ' × ' + (d.metrics && d.metrics.pageHeight),
      '视口：' + (d.metrics && d.metrics.viewportWidth) + ' × ' + (d.metrics && d.metrics.viewportHeight),
      '滚动位置：' + (d.metrics && d.metrics.scrollY),
      '含 Shadow DOM：' + (d.metrics && d.metrics.hasShadowRoots ? '是' : '否')
    ].join('\n')
  );
});

(async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  await loadConfig();
  await refresh();
  // 弹窗打开时顺便把 picks 计数显示出来（即便用户没切到那个 tab）
  const cfg = await chrome.storage.local.get(['bb_picks']);
  if (cfg.bb_picks && cfg.bb_picks.length) {
    $('picksBadge').style.display = 'inline-block';
    $('picksBadge').textContent = cfg.bb_picks.length > 99 ? '99+' : String(cfg.bb_picks.length);
  }
})();