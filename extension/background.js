import { putItem, getItem, pruneCaptures } from './lib/store.js';
import { normalizeCaptureOptions, normalizeWebUrl, isCapturableUrl, calculateCaptureGeometry, utf8ToBase64, base64ToBlob, captureErrorMessage, planSurfaceTiles, SURFACE_LIMIT, MIN_TILE_DIMENSION } from './lib/capture-utils.js';
import { scrollRegion } from './lib/scroll-region.js';
import { RELOAD_SESSION_KEY, validReloadSession } from './lib/reload-session.js';

const UI_URL = chrome.runtime.getURL('index.html');
let currentJob = null;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let reopeningSession;
const SURFACE_ATTEMPTS = 5;
const MAX_SURFACE_TILES = 512;

function reopenAfterUpdate() {
  if (reopeningSession) return reopeningSession;
  reopeningSession = (async () => {
    const values = await chrome.storage.local.get(RELOAD_SESSION_KEY);
    const session = values[RELOAD_SESSION_KEY];
    if (!validReloadSession(session) || session.opened) return;
    await chrome.storage.local.set({ [RELOAD_SESSION_KEY]: { ...session, opened: true } });
    // runtime.reload closes extension pages; the replacement gets a new tab.
    await chrome.tabs.create({ url: `${UI_URL}?resume=${encodeURIComponent(session.id)}` });
  })().catch(() => {}).finally(() => { reopeningSession = null; });
  return reopeningSession;
}
chrome.runtime.onInstalled.addListener(reopenAfterUpdate);
reopenAfterUpdate();

chrome.action.onClicked.addListener(async tab => {
  const values = await chrome.storage.local.get(RELOAD_SESSION_KEY);
  const session = values[RELOAD_SESSION_KEY];
  const query = validReloadSession(session) ? `?resume=${encodeURIComponent(session.id)}` : Number.isInteger(tab.id) ? `?tab=${tab.id}` : '';
  await chrome.tabs.create({ url: `${UI_URL}${query}` });
});

function authorized(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const source = new URL(sender.url);
    const expected = new URL(UI_URL);
    return source.protocol === expected.protocol && source.host === expected.host && source.pathname === expected.pathname
      && (sender.frameId === undefined || sender.frameId === 0);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!authorized(sender) || !message || typeof message !== 'object') return false;
  if (message.type === 'SL_TABS') {
    listTabs().then(tabs => respond({ ok: true, tabs }), error => respond({ ok: false, error: captureErrorMessage(error) }));
    return true;
  }
  if (message.type === 'SL_CAPTURE') {
    if (currentJob) { respond({ ok: false, error: '正在处理另一张截图，请稍等片刻。' }); return false; }
    const job = { canceled: false, ownerTabId: sender.tab?.id, target: null, attached: false };
    currentJob = job;
    capture(message.source, message.options, job)
      .then(result => respond({ ok: true, result }))
      .catch(error => respond({ ok: false, error: captureErrorMessage(error) }))
      .finally(() => { if (currentJob === job) currentJob = null; });
    return true;
  }
  if (message.type === 'SL_CANCEL') {
    if (currentJob && currentJob.ownerTabId === sender.tab?.id) currentJob.canceled = true;
    respond({ ok: true });
    return false;
  }
  return false;
});

chrome.debugger.onDetach.addListener((target, reason) => {
  if (currentJob?.target?.tabId === target.tabId) {
    currentJob.attached = false;
    currentJob.detachedReason = reason;
  }
});

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => tab.id && isCapturableUrl(tab.url)).map(({ id, title, url }) => ({ id, title: title || url, url }));
}

async function progress(stage, percent) {
  try { await chrome.runtime.sendMessage({ type: 'SL_PROGRESS', stage, percent }); } catch { /* The UI may have closed. */ }
}

function checkJob(job) {
  if (job.canceled) throw new Error('已取消截图，原页面已恢复。');
  if (job.detachedReason) throw new Error(job.detachedReason === 'target_closed' ? '原网页已关闭，请重新选择一个页面。' : '截图连接已中断，请重新开始截图。');
}

async function command(job, method, params = {}, timeout = 25000, ignoreCancellation = false) {
  if (!ignoreCancellation) checkJob(job);
  let timer;
  try {
    return await Promise.race([
      chrome.debugger.sendCommand(job.target, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('页面响应超时，请检查网页加载情况，或降低清晰度后重试。')), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function evaluate(job, fn, args = [], contextId, ignoreCancellation = false) {
  const result = await command(job, 'Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    ...(contextId ? { contextId } : {}),
    awaitPromise: true,
    returnByValue: true,
    timeout: ignoreCancellation ? 5000 : 20000,
  }, ignoreCancellation ? 5000 : 25000, ignoreCancellation);
  if (result.exceptionDetails) throw new Error('网页在截图时发生了变化，请等待页面稳定后重试。');
  return result.result?.value;
}

function documentChanged(error) {
  return /context|frame|网页在截图时发生了变化|网页正在跳转|navigat|destroy/i.test(error?.message || '');
}

async function isolatedWorld(job, expectedLoaderId, expectNavigation = false, ignoreCancellation = false) {
  const timeout = ignoreCancellation ? 5000 : 25000;
  const { frameTree } = await command(job, 'Page.getFrameTree', {}, timeout, ignoreCancellation);
  if (expectedLoaderId && frameTree.frame.loaderId !== expectedLoaderId) throw new Error('网页正在跳转，请等待页面加载后重试。');
  if (expectNavigation && frameTree.frame.url === 'about:blank') throw new Error('网页正在跳转，请等待页面加载后重试。');
  const { executionContextId } = await command(job, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'snapline-capture' }, timeout, ignoreCancellation);
  return executionContextId;
}

async function waitForDocument(job, expectedLoaderId, expectNavigation = false, ignoreCancellation = false) {
  const deadline = Date.now() + (ignoreCancellation ? 5000 : 25000);
  let contextId;
  let committed = !expectedLoaderId;
  let stableContext;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (!ignoreCancellation) checkJob(job);
    try {
      contextId = await isolatedWorld(job, committed ? undefined : expectedLoaderId, expectNavigation, ignoreCancellation);
      committed = true;
      const state = await evaluate(job, () => document.readyState, [], contextId, ignoreCancellation);
      if (state === 'complete') {
        if (contextId !== stableContext) { stableContext = contextId; stableSince = Date.now(); }
        // During cleanup, allow debounced resize handlers to finish navigating
        // before restoring scroll. The cleanup deadline remains bounded.
        if (!ignoreCancellation || Date.now() - stableSince >= 500) return { contextId, timedOut: false };
      } else stableContext = undefined;
    } catch (error) {
      stableContext = undefined;
      if (!ignoreCancellation) checkJob(job);
      if (!documentChanged(error)) throw error;
    }
    await sleep(250);
  }
  return { contextId: await isolatedWorld(job, committed ? undefined : expectedLoaderId, expectNavigation, ignoreCancellation), timedOut: true };
}

async function waitForAssets(job, contextId) {
  return evaluate(job, async () => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    await Promise.race([document.fonts?.ready ?? Promise.resolve(), pause(3500)]);
    const images = [...document.images];
    await Promise.race([
      Promise.allSettled(images.map(image => image.complete ? Promise.resolve() : image.decode?.() ?? Promise.resolve())),
      pause(3500),
    ]);
    return { failedImages: images.filter(image => !image.complete || image.naturalWidth === 0).length, fontsPending: document.fonts?.status === 'loading' };
  }, [], contextId);
}

async function loadLazyContent(job, contextId, restorePosition) {
  // The try/finally lives in the page's isolated world. If the debugger is
  // detached by Chrome, the bounded scroll task still restores its position.
  return evaluate(job, async (restoreX, restoreY) => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const start = Date.now();
    let previousHeight = 0;
    let atBottom = 0;
    try {
      for (let step = 0; step < 70; step++) {
        const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const top = Math.min(step * Math.max(300, Math.floor(innerHeight * 0.82)), Math.max(0, height - innerHeight));
        window.scrollTo({ top, left: 0, behavior: 'instant' });
        if (top + innerHeight >= height - 2 && height === previousHeight) atBottom++;
        else atBottom = 0;
        if (atBottom >= 2) return false;
        previousHeight = height;
        if (Date.now() - start > 9000 || top > 50000) return true;
        await pause(110);
      }
      return true;
    } finally {
      window.scrollTo({ left: restoreX, top: restoreY, behavior: 'instant' });
    }
  }, [restorePosition.x, restorePosition.y], contextId);
}

// Chromium refuses `Page.captureScreenshot` with -32000 "Unable to capture
// screenshot" as soon as one compositor surface exceeds the GPU texture limit
// (16384 device pixels on Chrome 153, see SURFACE_LIMIT). Long pages and high
// clarity factors both cross it, so a single request cannot cover them.
function surfaceRefused(error) {
  return /Unable to capture screenshot|-32000/i.test(error?.message || '');
}

function screenshotRequest(clip, captureBeyondViewport) {
  return { format: 'png', fromSurface: true, captureBeyondViewport, clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }, optimizeForSpeed: false };
}

// Capture one region of the page. A region that fits in a single surface keeps
// the original single request; a larger one is split into a tile grid and
// stitched, and a refused request halves the surface budget and retries, so a GPU
// with a lower texture limit than the measured one degrades to smaller tiles
// instead of failing.
async function captureSurface(job, clip, scale, contextId, captureBeyondViewport = true, onProgress) {
  let limit = SURFACE_LIMIT;
  let lastError;
  for (let attempt = 0; attempt < SURFACE_ATTEMPTS; attempt++) {
    const plan = planSurfaceTiles(clip, scale, limit);
    if (plan.tiles.length > MAX_SURFACE_TILES) throw new Error('这张截图的尺寸超出浏览器可处理的范围，请降低清晰度或改为「当前可见区域」后重试。');
    let canvas;
    try {
      if (plan.tiles.length === 1) {
        const shot = await command(job, 'Page.captureScreenshot', screenshotRequest(plan.tiles[0], captureBeyondViewport), 60000);
        if (!shot.data) throw new Error('没有收到截图数据，请重新生成。');
        return { data: shot.data };
      }
      // The stitched canvas matches the requested region exactly; the final tile
      // may extend past it and is clipped by drawImage.
      canvas = new OffscreenCanvas(Math.ceil(clip.width) * scale, Math.ceil(clip.height) * scale);
      const drawing = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!drawing) throw new Error('无法分配长网页画布，请降低清晰度后重试。');
      const deadline = Date.now() + 180000;
      for (let index = 0; index < plan.tiles.length; index++) {
        checkJob(job);
        if (Date.now() > deadline) throw new Error('分段截图耗时过长，请等待网页加载稳定或降低清晰度后重试。');
        const tile = plan.tiles[index];
        const shot = await command(job, 'Page.captureScreenshot', screenshotRequest(tile, true), 60000);
        if (!shot.data) throw new Error('没有收到截图数据，请重新生成。');
        const bitmap = await createImageBitmap(base64ToBlob(shot.data), { colorSpaceConversion: 'default' });
        try {
          // Tiles are captured from document coordinates, so they land on the
          // canvas at their own offset and no page scrolling is needed.
          drawing.drawImage(bitmap, Math.round((tile.x - plan.origin.x) * scale), Math.round((tile.y - plan.origin.y) * scale));
        } finally { bitmap.close(); }
        onProgress?.(Math.round(((index + 1) / plan.tiles.length) * 100));
      }
      return { canvas };
    } catch (error) {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      lastError = error;
      const reduced = Math.floor(limit / 2);
      if (!surfaceRefused(error) || reduced < MIN_TILE_DIMENSION) throw error;
      limit = Math.max(MIN_TILE_DIMENSION, reduced);
    }
  }
  throw lastError;
}

async function captureSurfaceBlob(job, clip, scale, contextId, captureBeyondViewport, onProgress) {
  const surface = await captureSurface(job, clip, scale, contextId, captureBeyondViewport, onProgress);
  if (surface.data) return base64ToBlob(surface.data);
  try { return await surface.canvas.convertToBlob({ type: 'image/png' }); }
  finally { surface.canvas.width = 0; surface.canvas.height = 0; }
}

async function captureScrollRegion(job, contextId, options, warnings) {
  let region = await evaluate(job, scrollRegion, ['prepare'], contextId);
  if (!region) return null;
  let canvas;
  try {
    if (options.lazyLoad) {
      await progress('正在加载网页主滚动区域', 45);
      const deadline = Date.now() + 9000;
      let previousHeight = 0;
      let stableBottom = 0;
      for (let step = 0, top = 0; step < 150; step++) {
        checkJob(job);
        region = await evaluate(job, scrollRegion, ['scroll', { top, assets: true }], contextId);
        const atBottom = region.top + region.clientHeight >= region.totalHeight - 2;
        stableBottom = atBottom && previousHeight === region.totalHeight ? stableBottom + 1 : 0;
        if (stableBottom >= 2) break;
        if (Date.now() > deadline || step === 149) { warnings.push('已停止自动加载持续增长的滚动区域，将截取当前已加载的内容。'); break; }
        previousHeight = region.totalHeight;
        top = Math.min(region.totalHeight - region.clientHeight, region.top + Math.max(100, Math.floor(region.height * .8)));
      }
    }
    region = await evaluate(job, scrollRegion, ['scroll', { top: 0, assets: options.lazyLoad }], contextId);
    const geometry = calculateCaptureGeometry({ cssVisualViewport: { clientWidth: region.width, clientHeight: region.height }, cssContentSize: { width: region.width, height: region.totalHeight } }, options);
    canvas = new OffscreenCanvas(geometry.width, geometry.height);
    const drawing = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!drawing) throw new Error('无法分配长网页画布，请降低清晰度后重试。');
    const totalHeight = region.totalHeight;
    const deadline = Date.now() + 90000;
    let covered = 0;
    for (let step = 0; covered < geometry.height; step++) {
      checkJob(job);
      if (step >= 200 || Date.now() > deadline) throw new Error('滚动区域截图耗时过长，请等待网页加载稳定或降低清晰度后重试。');
      region = await evaluate(job, scrollRegion, ['scroll', { top: covered / options.scale, assets: options.lazyLoad, wait: Math.max(180, Math.min(options.delay, 1000)) }], contextId);
      if (Math.abs(region.totalHeight - totalHeight) > 2) throw new Error('滚动区域的内容仍在变化，请等待网页加载完成后重新生成预览。');
      await progress('正在拼接完整滚动区域', 65 + Math.round(covered / geometry.height * 22));
      // A wide region at high clarity can still overflow one surface, so this
      // goes through the same tiling path as the full-page capture.
      const tile = await captureSurface(job, { x: region.x, y: region.y, width: region.width, height: region.height }, options.scale, contextId, false);
      const bitmap = tile.canvas || await createImageBitmap(base64ToBlob(tile.data), { colorSpaceConversion: 'default' });
      try {
        // The last scroll is clamped by the browser. Skip its already-captured
        // overlap so every output row is covered once, including the page end.
        const offset = covered - Math.round(region.top * options.scale);
        const rows = Math.min(bitmap.height - offset, geometry.height - covered);
        if (offset < 0 || rows <= 0) throw new Error('无法继续滚动到网页末尾，请检查页面滚动区域后重试。');
        drawing.drawImage(bitmap, 0, offset, bitmap.width, rows, 0, covered, geometry.width, rows);
        covered += rows;
      } finally {
        if (tile.canvas) { tile.canvas.width = 0; tile.canvas.height = 0; }
        else bitmap.close();
      }
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    warnings.push('已完整截取网页的主滚动区域。');
    return { blob, geometry };
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    await evaluate(job, scrollRegion, ['restore'], contextId, true).catch(() => {});
  }
}

async function capture(source, rawOptions, job) {
  const options = normalizeCaptureOptions(rawOptions);
  if (!source || !['tab', 'url', 'html'].includes(source.kind)) throw new Error('请先选择要转换的网页或 HTML 文件。');
  let temporaryTab = null;
  let contextId;
  let original;
  let metricsChanged = false;
  let backgroundChanged = false;
  const warnings = [];
  let title = '';
  let sourceUrl = '';
  let navigationUrl;
  let navigationLoaderId;
  try {
    await progress('正在连接网页', 8);
    checkJob(job);
    if (source.kind === 'tab') {
      if (!Number.isInteger(source.tabId) || source.tabId < 0) throw new Error('请选择一个有效的浏览器页面。');
      const tab = await chrome.tabs.get(source.tabId);
      if (!isCapturableUrl(tab.url)) throw new Error('Chrome 不允许截取设置页、扩展页面或应用商店，请选择普通网页。');
      if (tab.url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) throw new Error('请在 Chrome 扩展详情中开启「允许访问文件网址」，或直接导入本地 HTML。');
      job.target = { tabId: tab.id };
      title = tab.title || '网页截图';
      sourceUrl = tab.url;
    } else {
      if (source.kind === 'url') {
        navigationUrl = normalizeWebUrl(source.url);
        sourceUrl = navigationUrl;
      } else {
        if (typeof source.htmlId !== 'string') throw new Error('请重新选择 HTML 文件。');
        const record = await getItem(source.htmlId);
        if (record?.kind !== 'html' || typeof record.html !== 'string' || !record.html.trim()) throw new Error('找不到已导入的 HTML，请重新选择文件。');
        navigationUrl = `data:text/html;charset=utf-8;base64,${utf8ToBase64(record.html)}`;
        title = typeof record.title === 'string' ? record.title : '本地 HTML';
        sourceUrl = 'local-html';
      }
      // Chrome may block a debugger-initiated top-level data: navigation. Tabs
      // navigation is extension initiated and retains the opaque data origin.
      const tab = await chrome.tabs.create({ url: source.kind === 'html' ? navigationUrl : 'about:blank', active: false });
      if (source.kind === 'html') navigationUrl = undefined;
      temporaryTab = tab.id;
      job.target = { tabId: tab.id };
    }
    checkJob(job);
    await chrome.debugger.attach(job.target, '1.3');
    job.attached = true;
    await command(job, 'Page.enable');
    if (navigationUrl) {
      // Imported documents are rendered at an opaque data origin, never in the
      // extension origin. The extension does not receive code from the page.
      const navigation = await command(job, 'Page.navigate', { url: navigationUrl });
      if (navigation.errorText) throw new Error(navigation.errorText);
      navigationLoaderId = navigation.loaderId;
    }
    await progress('正在等待页面加载', 20);
    const ready = await waitForDocument(job, navigationLoaderId, source.kind !== 'tab');
    contextId = ready.contextId;
    if (ready.timedOut) warnings.push('网页加载超过 25 秒，已按当前加载的内容生成。');
    original = await evaluate(job, () => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, title: document.title, url: location.href }), [], contextId);
    if (options.scope === 'full') original.innerScroll = await evaluate(job, scrollRegion, ['position'], contextId);
    if (source.kind !== 'html') {
      if (!isCapturableUrl(original.url)) throw new Error('网页跳转到了 Chrome 不允许截图的页面，请选择其他网页。');
      sourceUrl = original.url;
      title = original.title || title || new URL(sourceUrl).hostname;
    }
    const width = options.width || Math.max(1, Math.round(original.width));
    const height = options.width === 390 ? 844 : options.width === 768 ? 1024 : options.width === 1440 ? 900 : Math.max(1, Math.round(original.height));
    await command(job, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: options.scale, mobile: false });
    metricsChanged = true;
    if (options.transparent) {
      await command(job, 'Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      backgroundChanged = true;
      warnings.push('透明背景只作用于网页原本没有设置背景色的区域。');
    }
    await sleep(180);
    let geometry;
    let blob;
    // Responsive pages may reload or redirect when their width changes. Each
    // attempt uses the current document; keep the original viewport for cleanup.
    for (let attempt = 0; attempt < 3; attempt++) {
      const attemptWarnings = [];
      try {
        const resized = await waitForDocument(job, undefined, source.kind !== 'tab');
        contextId = resized.contextId;
        if (resized.timedOut) attemptWarnings.push('网页加载超过 25 秒，已按当前加载的内容生成。');
        if (options.lazyLoad && options.scope === 'full') {
          await progress('正在加载长页面和图片', 38);
          if (await loadLazyContent(job, contextId, original)) attemptWarnings.push('页面很长或会持续加载新内容，已停止自动滚动并截取当前已加载的部分。');
        }
        const assets = await waitForAssets(job, contextId);
        if (assets?.failedImages) attemptWarnings.push(`有 ${assets.failedImages} 张图片未加载成功，可能需要增加等待时间或检查资源路径。`);
        if (assets?.fontsPending) attemptWarnings.push('部分在线字体仍在加载，当前使用网页已显示的字体。');
        await progress('正在整理页面', 57);
        if (options.delay) {
          const until = Date.now() + options.delay;
          while (Date.now() < until) { checkJob(job); await sleep(Math.min(200, until - Date.now())); }
        }
        if (options.scope === 'full') await evaluate(job, () => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }), [], contextId);
        else await evaluate(job, (x, y) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), [original.x, original.y], contextId);
        await sleep(160);
        const nested = options.scope === 'full' ? await captureScrollRegion(job, contextId, options, attemptWarnings) : null;
        if (nested) { geometry = nested.geometry; blob = nested.blob; }
        else {
          const metrics = await command(job, 'Page.getLayoutMetrics');
          geometry = calculateCaptureGeometry(metrics, options);
          await progress('正在生成高清截图', 72);
          // The callback only fires when the capture really splits into tiles,
          // including when a refused request had to fall back to smaller ones.
          blob = await captureSurfaceBlob(job, geometry.clip, options.scale, contextId, options.scope === 'full',
            percent => progress('正在分段拼接完整截图', 72 + Math.round(percent * 0.14)));
        }
        checkJob(job);
        // Verify that the document used to prepare the screenshot still exists,
        // and keep history metadata in sync with any responsive redirect.
        const captured = await evaluate(job, () => ({ title: document.title, url: location.href }), [], contextId);
        if (source.kind !== 'html') {
          if (!isCapturableUrl(captured.url)) throw new Error('网页跳转到了 Chrome 不允许截图的页面，请选择其他网页。');
          sourceUrl = captured.url;
          title = captured.title || title;
        }
        warnings.push(...attemptWarnings);
        break;
      } catch (error) {
        checkJob(job);
        if (!documentChanged(error)) throw error;
        if (attempt === 2) throw new Error('网页在切换尺寸后持续刷新或跳转，请等待页面稳定后重新生成预览。');
        await progress('网页正在重新加载，等待后继续预览', 25);
        await sleep(250);
      }
    }
    await progress('正在保存到本地记录', 92);
    const result = { id: `capture-${crypto.randomUUID()}`, title: String(title || '网页截图').slice(0, 240), url: sourceUrl, width: geometry.width, height: geometry.height, createdAt: Date.now(), byteSize: blob.size, warnings };
    await putItem({ ...result, kind: 'capture', blob, options });
    await pruneCaptures(12).catch(() => { warnings.push('旧的截图记录暂时未能清理，可稍后手动删除。'); });
    await progress('截图已就绪', 100);
    return result;
  } finally {
    if (job.attached) {
      // Cleanup does not honor cancellation: it must run on every success and
      // failure path, and one failed cleanup operation cannot skip the others.
      if (backgroundChanged) await command(job, 'Emulation.setDefaultBackgroundColorOverride', {}, 5000, true).catch(() => {});
      if (metricsChanged) await command(job, 'Emulation.clearDeviceMetricsOverride', {}, 5000, true).catch(() => {});
      if (original) {
        // Clearing the width override can also reload responsive pages. Restore
        // scroll in the current document, even after cancellation or failure.
        await sleep(180);
        await (async () => {
          const restored = await waitForDocument(job, undefined, false, true);
          await evaluate(job, (x, y) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), [original.x, original.y], restored.contextId, true);
          if (original.innerScroll) await evaluate(job, scrollRegion, ['position', original.innerScroll], restored.contextId, true);
        })().catch(() => {});
      }
      await chrome.debugger.detach(job.target).catch(() => {});
      job.attached = false;
    }
    if (temporaryTab !== null) await chrome.tabs.remove(temporaryTab).catch(() => {});
  }
}
