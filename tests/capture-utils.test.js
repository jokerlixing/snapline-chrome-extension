import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCaptureOptions, normalizeWebUrl, isCapturableUrl, calculateCaptureGeometry, utf8ToBase64, base64ToBlob, captureErrorMessage } from '../extension/lib/capture-utils.js';

const metrics = { cssContentSize: { width: 1440, height: 3000 }, cssVisualViewport: { pageX: 5, pageY: 900, clientWidth: 1440, clientHeight: 900 } };

test('capture options have useful defaults and reject oversized or malformed values', () => {
  assert.deepEqual(normalizeCaptureOptions(), { width: 0, scale: 1, scope: 'full', delay: 1000, lazyLoad: true, transparent: false });
  for (const input of [{ width: 100000 }, { scale: 10 }, { scope: 'all' }, { delay: Infinity }, { delay: -1 }, null]) assert.throws(() => normalizeCaptureOptions(input));
  assert.equal(normalizeCaptureOptions({ delay: 0, transparent: true }).delay, 0);
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
  assert.deepEqual(calculateCaptureGeometry(metrics, { scope: 'full', scale: 2 }), { clip: { x: 0, y: 0, width: 1440, height: 3000, scale: 1 }, width: 2880, height: 6000 });
  assert.deepEqual(calculateCaptureGeometry(metrics, { scope: 'viewport', scale: 1 }).clip, { x: 5, y: 900, width: 1440, height: 900, scale: 1 });
});

test('capture geometry enforces both edge and total area limits without silent cropping', () => {
  assert.throws(() => calculateCaptureGeometry({ ...metrics, cssContentSize: { width: 100, height: 40000 } }, { scope: 'full', scale: 1 }), /尺寸过大/);
  assert.throws(() => calculateCaptureGeometry({ ...metrics, cssContentSize: { width: 9000, height: 9000 } }, { scope: 'full', scale: 1 }), /尺寸过大/);
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
