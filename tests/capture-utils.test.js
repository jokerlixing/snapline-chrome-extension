import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCaptureOptions, normalizeWebUrl, isCapturableUrl, calculateCaptureGeometry, captureResizeWarning, CAPTURE_LIMITS, utf8ToBase64, base64ToBlob, captureErrorMessage, planSurfaceTiles, SURFACE_LIMIT, MIN_TILE_DIMENSION } from '../extension/lib/capture-utils.js';

const metrics = { cssContentSize: { width: 1440, height: 3000 }, cssVisualViewport: { pageX: 5, pageY: 900, clientWidth: 1440, clientHeight: 900 } };

test('capture options have useful defaults and reject oversized or malformed values', () => {
  assert.deepEqual(normalizeCaptureOptions(), { width: 0, scale: 1, scope: 'full', delay: 1000, lazyLoad: true, transparent: false });
  for (const input of [{ width: 100000 }, { scale: 10 }, { scope: 'all' }, { delay: Infinity }, { delay: -1 }, null]) assert.throws(() => normalizeCaptureOptions(input));
  assert.equal(normalizeCaptureOptions({ delay: 0, transparent: true }).delay, 0);
});

test('custom capture widths accept integer pixel sizes and reject invalid values', () => {
  for (const width of [0, 200, 390, 768, 1024, 1440, 2560, 7680]) assert.equal(normalizeCaptureOptions({ width }).width, width);
  for (const width of [199, 7681, -1, 200.5, NaN, Infinity, '1024', 'custom', '']) assert.throws(() => normalizeCaptureOptions({ width }), /200 到 7680/);
});

test('web address normalization accepts normal web pages and rejects credentials and executable schemes', () => {
  assert.equal(normalizeWebUrl('example.com/path?q=hello'), 'https://example.com/path?q=hello');
  assert.equal(normalizeWebUrl(' http://localhost:3000/test '), 'http://localhost:3000/test');
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,hi', 'file:///test.html', 'chrome://settings', 'https://user:pass@example.com', 'https://chromewebstore.google.com/detail/x']) assert.throws(() => normalizeWebUrl(url));
});

test('tab eligibility excludes browser-internal pages and Chrome Web Store', () => {
  assert.equal(isCapturableUrl('file:///C:/demo/index.html'), true);
  assert.equal(isCapturableUrl('https://example.com/'), true);
  for (const url of ['chrome://extensions', 'about:blank', 'chrome-extension://abc/index.html', 'https://chrome.google.com/webstore/detail/foo', 'data:text/html,test']) assert.equal(isCapturableUrl(url), false);
});

test('full-page output accounts for DPR while viewport capture preserves scroll coordinates', () => {
  assert.deepEqual(calculateCaptureGeometry(metrics, { scope: 'full', scale: 2 }), { clip: { x: 0, y: 0, width: 1440, height: 3000, scale: 1 }, width: 2880, height: 6000, outputScale: 2, downscaled: false });
  assert.deepEqual(calculateCaptureGeometry(metrics, { scope: 'viewport', scale: 1 }).clip, { x: 5, y: 900, width: 1440, height: 900, scale: 1 });
});

test('the reported 2352 × 45498 capture fits the full page automatically and tells the user its output size', () => {
  const options = { scope: 'full', scale: 3 };
  const geometry = calculateCaptureGeometry({ ...metrics, cssContentSize: { width: 784, height: 15166 } }, options);
  assert.equal(geometry.downscaled, true);
  assert.equal(geometry.clip.height, 15166);
  assert.ok(geometry.height <= CAPTURE_LIMITS.autoDimension);
  assert.ok(geometry.width * geometry.height <= CAPTURE_LIMITS.autoPixels);
  assert.ok(geometry.width / geometry.height > 784 / 15166 - 0.001);
  assert.match(captureResizeWarning(geometry, options), /2,352 × 45,498.*已等比缩小.*完整内容/);
});

test('oversized captures on either axis are resized, while invalid page dimensions still fail', () => {
  for (const content of [{ width: 100, height: 40000 }, { width: 9000, height: 9000 }]) {
    const geometry = calculateCaptureGeometry({ ...metrics, cssContentSize: content }, { scope: 'full', scale: 1 });
    assert.equal(geometry.downscaled, true);
    assert.ok(geometry.width <= CAPTURE_LIMITS.maxDimension && geometry.height <= CAPTURE_LIMITS.maxDimension);
    assert.ok(geometry.width * geometry.height <= CAPTURE_LIMITS.maxPixels);
  }
  assert.throws(() => calculateCaptureGeometry({ ...metrics, cssContentSize: { width: 0, height: 100 } }, { scope: 'full', scale: 1 }), /尺寸为空/);
});

test('HTML serialization preserves UTF-8 text and Blob bytes', async () => {
  const source = '<html><body>你好，世界 🎨</body></html>';
  const encoded = utf8ToBase64(source);
  assert.equal(await base64ToBlob(encoded, 'text/html').text(), source);
});

test('browser errors become actionable messages', () => {
  assert.match(captureErrorMessage(new Error('Another debugger is already attached')), /开发者工具/);
  assert.match(captureErrorMessage(new DOMException('space', 'QuotaExceededError')), /存储空间/);
  assert.match(captureErrorMessage(new Error('Cannot access a file URL')), /允许访问文件网址/);
});

test('a refused compositor surface is explained instead of leaking the raw protocol error', () => {
  const raw = new Error('{"code":-32000,"message":"Unable to capture screenshot"}');
  const message = captureErrorMessage(raw);
  assert.match(message, /超出显卡可处理的最大尺寸/);
  assert.doesNotMatch(message, /-32000|Unable to capture/);
  assert.match(message, /降低清晰度|当前可见区域/);
});

test('a region inside one surface stays a single screenshot request', () => {
  assert.equal(SURFACE_LIMIT, 16384);
  const plan = planSurfaceTiles({ x: 0, y: 0, width: 1440, height: 12000 }, 1);
  assert.equal(plan.tiles.length, 1);
  assert.deepEqual(plan.tiles[0], { x: 0, y: 0, width: 1440, height: 12000 });
});

test('a region past the surface limit is split into full-coverage tiles on both axes', () => {
  const tall = planSurfaceTiles({ x: 0, y: 0, width: 1440, height: 20000 }, 1);
  assert.equal(tall.rows, 2);
  assert.equal(tall.columns, 1);
  assert.deepEqual(tall.tiles, [{ x: 0, y: 0, width: 1440, height: 10000 }, { x: 0, y: 10000, width: 1440, height: 10000 }]);

  // 6000 CSS px at 3x is 18000 device px wide, so only the width needs tiling.
  const wide = planSurfaceTiles({ x: 0, y: 0, width: 6000, height: 1200 }, 3);
  assert.equal(wide.columns, 2);
  assert.equal(wide.rows, 1);
  assert.equal(wide.tiles[1].x, 3000);
  assert.ok(wide.tiles[0].width * 3 <= SURFACE_LIMIT && wide.tiles[1].width * 3 <= SURFACE_LIMIT);
});

test('tiles cover the clipped region exactly, including fractional origins and odd sizes', () => {
  for (const [clip, scale] of [
    [{ x: 0, y: 0, width: 1440, height: 20001 }, 1],
    [{ x: 0, y: 0, width: 7680, height: 32760 }, 3],
    [{ x: 12.5, y: 40.25, width: 390, height: 19000 }, 2],
    [{ x: 0, y: 0, width: 200, height: 16385 }, 1],
  ]) {
    const plan = planSurfaceTiles(clip, scale);
    const right = plan.tiles.reduce((most, tile) => Math.max(most, tile.x + tile.width), 0);
    const bottom = plan.tiles.reduce((most, tile) => Math.max(most, tile.y + tile.height), 0);
    assert.equal(right, plan.origin.x + Math.ceil(clip.width), `horizontal coverage for ${JSON.stringify(clip)} at ${scale}x`);
    assert.equal(bottom, plan.origin.y + Math.ceil(clip.height), `vertical coverage for ${JSON.stringify(clip)} at ${scale}x`);
    assert.equal(plan.tiles[0].x, plan.origin.x);
    assert.equal(plan.tiles[0].y, plan.origin.y);
    for (const tile of plan.tiles) {
      assert.ok(tile.width * scale <= SURFACE_LIMIT && tile.height * scale <= SURFACE_LIMIT, `tile ${JSON.stringify(tile)} fits the surface at ${scale}x`);
    }
    // Every row and column of the region is claimed by exactly one tile.
    const rows = new Set(plan.tiles.map(tile => tile.y - plan.origin.y));
    const columns = new Set(plan.tiles.map(tile => tile.x - plan.origin.x));
    assert.equal(rows.size * columns.size, plan.tiles.length);
  }
});

test('smaller surface budgets still tile instead of throwing away content', () => {
  const plan = planSurfaceTiles({ x: 0, y: 0, width: 1440, height: 20000 }, 1, 4096);
  assert.ok(plan.rows >= 5);
  assert.equal(plan.tiles.reduce((most, tile) => Math.max(most, tile.y + tile.height), 0), 20000);
  assert.ok(plan.tiles.every(tile => tile.height <= 4096));
  assert.ok(MIN_TILE_DIMENSION <= 4096);
});
