/**
 * Browser Bridge · 截图（三条路）
 *
 * 【为什么整页截图要分两条路？】
 *   轻量档：content script 拿不到"视口之外"的像素。唯一手段是
 *           scroll → captureVisibleTab → 拼接。可行，但有两个已知缺陷：
 *             a) 固定定位元素（吸顶表头、右侧浮动客服）会在每一屏里重复出现；
 *             b) 滚动触发懒加载时，拼接过程可能拍到未加载完的区域。
 *   增强档：CDP 的 Page.captureScreenshot + captureBeyondViewport，浏览器一次渲染成型，
 *           没有拼接、没有重复元素。所以「要完美的整页图就切增强档」是实话，不是推脱。
 *
 * 【为什么用 OffscreenCanvas 而不是普通 canvas？】
 *   service worker 里没有 document，拿不到 <canvas> 元素。
 *   OffscreenCanvas 是 MV3 在 worker 环境里唯一可用的绘制目标，
 *   且 createImageBitmap / convertToBlob 在 SW 里都是可用的。
 *
 * 【高度上限 16384 是怎么回事？】
 *   Canvas 有实现层的最大尺寸限制（不同平台 16384 / 32767 不等），超过会直接得到空白图。
 *   这里保守取 16384 设备像素并显式告知被截断，好过悄悄给一张废图。
 */

import { getState } from './state.js';
import * as cdp from './cdp.js';
import { contentCall } from './tabs.js';

/** Canvas 安全高度上限（设备像素） */
const MAX_CANVAS_H = 16384;
/** 拼接时最多截多少屏，防止在无限滚动页面上死循环 */
const MAX_TILES = 60;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** dataURL -> Blob（SW 里没有 fetch(dataURL) 的稳定保证，手动解码最保险） */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = /image\/jpe?g/i.test(meta) ? 'image/jpeg' : 'image/png';
  return new Blob([bytes], { type: mime });
}

/** Blob -> base64（分块，避免 String.fromCharCode 参数过多爆栈） */
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
  return btoa(bin);
}

/**
 * captureVisibleTab 只能截「当前窗口的活动标签页」。
 * 所以截非活动页时必须先切过去 —— 这一步会打扰用户，必须在结果里如实告知。
 */
async function ensureActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) return { windowId: tab.windowId, switched: false };
  await chrome.tabs.update(tabId, { active: true });
  await sleep(250);
  return { windowId: tab.windowId, switched: true };
}

/** 截图期间把悬浮面板藏起来，别把 BB 小球拍进图里 */
async function withPanelHidden(tabId, fn) {
  const send = (visible) =>
    chrome.tabs
      .sendMessage(tabId, { __bb: true, action: 'panel_visible', args: { visible: visible } }, { frameId: 0 })
      .catch(() => {});
  await send(false);
  try {
    return await fn();
  } finally {
    await send(true);
  }
}

// ───────────────────────── 轻量档 ─────────────────────────

async function captureViewportLight(tabId, opts) {
  const { windowId, switched } = await ensureActive(tabId);
  const fmt = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: fmt,
    quality: fmt === 'jpeg' ? opts.quality || 85 : undefined
  });
  return {
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mime: fmt === 'jpeg' ? 'image/jpeg' : 'image/png',
    mode: 'light',
    fullPage: false,
    switchedTab: switched
  };
}

/**
 * 整页拼接。
 * 关键点：
 *   - scale 用「首屏位图宽度 ÷ 视口 CSS 宽度」实测得出，而不是信 devicePixelRatio。
 *     在缩放的窗口、多显示器、系统级缩放下这两者经常不一致。
 *   - 每屏等待 260ms 让懒加载和动画落定，否则会出现"半截内容"。
 */
async function captureFullLight(tabId, opts) {
  const { windowId, switched } = await ensureActive(tabId);

  const metrics = await contentCall(tabId, 'metrics');
  const originalY = metrics.scrollY || 0;
  const vh = metrics.viewportHeight;
  const totalH = metrics.pageHeight;
  const warnings = [];

  if (switched) warnings.push('目标标签页原本不在前台，已临时切到前台才能截图。');
  if (vh <= 0 || totalH <= 0) throw new Error('页面尺寸异常，无法整页截图');

  const tiles = [];
  const seen = new Set();
  let pos = 0;

  try {
    while (pos < totalH && tiles.length < MAX_TILES) {
      const real = await contentCall(tabId, 'scroll_to_y', { y: pos });
      await sleep(260);

      const key = real.scrollY;
      if (seen.has(key)) break; // 滚不动了（内层滚动容器 / 极短页），收工
      seen.add(key);

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      tiles.push({ y: real.scrollY, dataUrl: dataUrl });

      if (real.scrollY + vh >= totalH) break;
      pos = real.scrollY + vh;
    }
  } finally {
    await contentCall(tabId, 'scroll_to_y', { y: originalY }).catch(() => {});
  }

  if (!tiles.length) throw new Error('未能截取到任何画面');

  // ── 拼接 ──
  const firstBmp = await createImageBitmap(dataUrlToBlob(tiles[0].dataUrl));
  const scale = firstBmp.width / Math.max(1, metrics.viewportWidth || 1);
  const canvasW = firstBmp.width;
  const desiredH = Math.ceil(totalH * scale);
  const canvasH = Math.min(desiredH, MAX_CANVAS_H);

  if (desiredH > MAX_CANVAS_H) {
    warnings.push('页面高度 ' + desiredH + 'px 超出生图上限 ' + MAX_CANVAS_H + 'px，图片底部已截断。需要完整长图请切「增强档」。');
  }
  if (tiles.length >= MAX_TILES) {
    warnings.push('页面过长，达到 ' + MAX_TILES + ' 屏上限后停止，图可能不完整。');
  }

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let i = 0; i < tiles.length; i++) {
    const bmp = i === 0 ? firstBmp : await createImageBitmap(dataUrlToBlob(tiles[i].dataUrl));
    const drawY = Math.round(tiles[i].y * scale);
    const remain = canvasH - drawY;
    if (remain <= 0) {
      if (i !== 0) bmp.close();
      continue;
    }
    const sh = Math.min(bmp.height, remain);
    ctx.drawImage(bmp, 0, 0, bmp.width, sh, 0, drawY, bmp.width, sh);
    if (i !== 0) bmp.close();
  }
  firstBmp.close();

  const fmt = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await canvas.convertToBlob({
    type: fmt,
    quality: fmt === 'image/jpeg' ? opts.quality || 85 : undefined
  });

  const out = await blobToBase64(blob);

  warnings.push(
    '轻量档拼接：固定定位元素（吸顶表头、浮动客服等）可能在图中重复出现；要干净的整页图请切「增强档」。'
  );

  return {
    data: out,
    mime: fmt,
    mode: 'light',
    fullPage: true,
    tiles: tiles.length,
    width: canvasW,
    height: canvasH,
    bytes: blob.size,
    warnings: warnings,
    switchedTab: switched
  };
}

/** 元素截图：先滚到元素，截可见区，再按元素矩形裁剪 */
async function captureElementLight(tabId, opts) {
  const { windowId, switched } = await ensureActive(tabId);
  const info = await contentCall(tabId, 'resolve_point', { target: opts.target, index: opts.index });
  await sleep(220);

  const rect = (await contentCall(tabId, 'query_one_rect', { target: opts.target, index: opts.index }))
    .rect;

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const m = await contentCall(tabId, 'metrics');
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));

  // 视口坐标 -> 位图坐标。scale 用实测值（位图宽 ÷ 视口 CSS 宽），
  // 不能信 devicePixelRatio —— 系统缩放 / 多显示器下两者经常不一致，会导致裁歪。
  const scale = bmp.width / Math.max(1, m.viewportWidth || 1);
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bmp.width - sx, Math.max(1, Math.round(rect.w * scale)));
  const sh = Math.min(bmp.height - sy, Math.max(1, Math.round(rect.h * scale)));

  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();

  const fmt = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await canvas.convertToBlob({
    type: fmt,
    quality: fmt === 'image/jpeg' ? opts.quality || 85 : undefined
  });

  return {
    data: await blobToBase64(blob),
    mime: fmt,
    mode: 'light',
    fullPage: false,
    element: info.el,
    width: sw,
    height: sh,
    bytes: blob.size,
    warning: '元素截图基于可见区裁剪，元素超出视口的部分不会出现在图中；完整元素请用增强档。'
  };
}

// ───────────────────────── 统一入口 ─────────────────────────

/**
 * @param {number} tabId
 * @param {object} opts { fullPage, target, format, quality }
 */
export async function capture(tabId, opts) {
  opts = opts || {};
  const mode = getState().mode;

  return await withPanelHidden(tabId, async () => {
    // 增强档：CDP 一次成型，优先走它
    if (mode === 'debugger') {
      try {
        const isFull = opts.fullPage !== false && !opts.target;
        let clip = null;

        if (opts.target) {
          const info = await contentCall(tabId, 'resolve_point', { target: opts.target, index: opts.index });
          const r = info.rect;
          clip = { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 };
        }

        const data = await cdp.captureScreenshot(tabId, {
          format: opts.format,
          quality: opts.quality,
          fullPage: isFull,
          clip: clip
        });
        if (!data) throw new Error('CDP 未返回图像数据');

        return {
          data: data,
          mime: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          mode: 'debugger',
          fullPage: isFull,
          element: !!opts.target,
          bytes: Math.round((data.length * 3) / 4)
        };
      } catch (e) {
        // 增强档失败就降级到轻量档，但要把原因带回给调用方
        const light = opts.target
          ? await captureElementLight(tabId, opts)
          : opts.fullPage !== false
            ? await captureFullLight(tabId, opts)
            : await captureViewportLight(tabId, opts);
        light.warnings = (light.warnings || []).concat([
          '增强档截图失败已自动降级：' + String((e && e.message) || e)
        ]);
        return light;
      }
    }

    if (opts.target) return await captureElementLight(tabId, opts);
    if (opts.fullPage === false) return await captureViewportLight(tabId, opts);
    return await captureFullLight(tabId, opts);
  });
}
