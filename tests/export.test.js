import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFilename, planPdfPages, planRasterExport } from '../extension/lib/export.js';
test('download names cannot contain unsafe paths or reserved device names', () => { assert.equal(safeFilename('../../my:page.png', 'jpeg'), '..-..-my-page.jpg'); assert.equal(safeFilename('CON', 'png'), '我的网页.png'); assert.equal(safeFilename('设计稿.pdf', 'pdf'), '设计稿.pdf'); });
test('PDF slicing covers every row exactly once without blank final page', () => { const plan = planPdfPages(1440, 20000); assert.ok(plan.slices.length > 1); assert.equal(plan.slices.reduce((sum, s) => sum + s.height, 0), 20000); for (let i = 1; i < plan.slices.length; i++) assert.equal(plan.slices[i].y, plan.slices[i - 1].y + plan.slices[i - 1].height); assert.ok(plan.slices.every(s => s.height > 0)); });
test('long PDF preserves aspect ratio and rejects pages beyond PDF limits', () => { const plan = planPdfPages(1440, 900, 'long', 0); assert.equal(plan.slices.length, 1); assert.equal(plan.paperHeight, 131.25); assert.throws(() => planPdfPages(390, 20000, 'long', 20), /长度限制/); });
test('fractional long-page dimensions never produce an extra blank page', () => { for (const width of [390, 768, 1440, 2160]) for (const height of [911, 1571, 2837, 7713]) { const plan = planPdfPages(width, height, 'long', 10); assert.equal(plan.slices.length, 1); assert.equal(plan.slices[0].height, height); } });
test('oversized WebP fits its entire canvas within the format dimension limit', () => {
  assert.deepEqual(planRasterExport(1440, 20000, 'webp'), { width: 1179, height: 16383, scaled: true });
  assert.deepEqual(planRasterExport(20000, 1440, 'webp'), { width: 16383, height: 1179, scaled: true });
  assert.deepEqual(planRasterExport(390, 16383, 'webp'), { width: 390, height: 16383, scaled: false });
  for (const format of ['png', 'jpeg', 'pdf']) assert.deepEqual(planRasterExport(1440, 20000, format), { width: 1440, height: 20000, scaled: false });
});
