import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const root = resolve('.');
const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const html = await readFile('fixtures/demo.html');
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/demo`;
const profile = await mkdtemp(join(tmpdir(), 'snapline-ui-'));
const extension = resolve('dist/snapline');
const context = await chromium.launchPersistentContext(profile, { executablePath: browserPath(), headless: true, viewport: { width: 1440, height: 1060 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'] });
const errors = [];
const passed = [];
let page;
const recordPass = text => { passed.push(text); console.log(`PASS ${text}`); };
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.locator('#source-html[aria-selected=true]').waitFor();
  await page.screenshot({ path: join(artifacts, 'workbench-empty.png'), fullPage: true });
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  assert.equal(await page.locator('.brand-mark svg').count(), 1);
  await page.locator('#capture-button').click();
  await page.locator('#message.error').filter({ hasText: '请先选择' }).waitFor();
  recordPass('空白工作台、图标和未选择来源的错误反馈');

  await page.locator('#source-url').click();
  await page.locator('#url-input').fill(url);
  await page.locator('#width').selectOption('768');
  await page.locator('#capture-button').click();
  await page.locator('#preview-badge.ready').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.equal(await page.locator('#preview-image').evaluate(img => img.naturalWidth), 768);
  await page.screenshot({ path: join(artifacts, 'workbench-ready.png'), fullPage: true });
  recordPass('网页链接生成真实预览');

  for (const format of ['png', 'jpeg', 'webp', 'pdf']) {
    await page.locator(`[data-format=${format}]`).click();
    const pending = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('#export-button').click();
    const download = await pending;
    const path = join(artifacts, `export.${format === 'jpeg' ? 'jpg' : format}`);
    await download.saveAs(path);
    const buffer = await readFile(path);
    if (format === 'png') assert.equal(buffer.toString('hex', 0, 8), '89504e470d0a1a0a');
    if (format === 'jpeg') assert.equal(buffer.toString('hex', 0, 3), 'ffd8ff');
    if (format === 'webp') assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
    if (format === 'pdf') { assert.equal(buffer.toString('ascii', 0, 5), '%PDF-'); assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2); }
    await page.waitForFunction(() => !document.getElementById('export-button').disabled);
    recordPass(`${format} 下载与文件头验证`);
  }
  await page.locator('#pdf-layout').selectOption('long');
  const longPending = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const longPdf = await longPending;
  await longPdf.saveAs(join(artifacts, 'export-long.pdf'));
  const longBuffer = await readFile(join(artifacts, 'export-long.pdf'));
  assert.equal((longBuffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  recordPass('长页 PDF 仅生成一页');

  await page.locator('[data-scale="2"]').click();
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  assert.match(await page.locator('#preview-badge').innerText(), /重新生成/);
  recordPass('修改截图设置后要求重新预览');
  await page.locator('#nav-history').click();
  await page.locator('.history-item').waitFor();
  await page.locator('.history-actions .text-button').first().click();
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.equal(await page.locator('[data-scale="1"]').getAttribute('aria-pressed'), 'true');
  recordPass('历史预览重新打开并恢复截图参数');

  const firstTab = await context.newPage(); await firstTab.goto(`${url}?tab=first`);
  const secondTab = await context.newPage(); await secondTab.goto(`${url}?tab=second`);
  await page.locator('#source-tab').click();
  const firstTabId = await page.evaluate(async address => (await chrome.tabs.query({})).find(tab => tab.url === address).id, `${url}?tab=first`);
  await page.locator('#tab-select').selectOption(String(firstTabId));
  await page.locator('#capture-button').click();
  await page.locator('#preview-badge.ready').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  await firstTab.close();
  await page.locator('#refresh-tabs').click();
  await page.locator('#preview-badge.stale').waitFor();
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  await secondTab.close();
  recordPass('关闭来源标签页后刷新会使旧预览失效');

  await page.locator('#source-html').click();
  await page.locator('#file-input').setInputFiles('fixtures/demo.html');
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await page.locator('#capture-button').click();
  await page.locator('#preview-badge.ready').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  recordPass('本地单文件 HTML 完整转换');

  await page.locator('#folder-input').setInputFiles(resolve('fixtures/demo-folder'));
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await page.locator('#capture-button').click();
  await page.locator('#preview-badge.ready').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.ok(await page.locator('#preview-image').evaluate(img => img.naturalHeight) > 1400);
  recordPass('含 CSS 图片脚本的文件夹导入');

  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'workbench-mobile.png'), fullPage: true });
  recordPass('帮助对话框、键盘关闭与窄屏布局');
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.locator('#nav-history').click();
  await page.locator('#clear-history').click();
  await page.locator('.history-empty').waitFor();
  assert.equal(await page.locator('#history-count').innerText(), '0');
  recordPass('清空本机历史记录');
  await page.locator('#nav-workbench').click();
  await page.locator('[data-format=jpeg]').click();
  await page.locator('#quality').fill('74');
  await page.locator('[data-format=pdf]').click();
  await page.locator('#pdf-layout').selectOption('letter');
  await page.locator('#pdf-margin').selectOption('20');
  await page.waitForFunction(async () => (await chrome.storage.local.get('preferences')).preferences.pdfMargin === '20');
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('pdf-margin').value === '20');
    assert.equal(await page.locator('#quality').inputValue(), '74');
    assert.equal(await page.locator('#pdf-layout').inputValue(), 'letter');
    assert.equal(await page.locator('#pdf-margin').inputValue(), '20');
  }
  recordPass('导出质量及 PDF 设置连续重开两次仍保留');
  assert.deepEqual(errors, []);
  recordPass('整个流程没有浏览器脚本或 CSP 错误');
} catch (error) {
  if (page) { console.log('UI MESSAGE:', await page.locator('#message').innerText().catch(() => '')); await page.screenshot({ path: join(artifacts, 'test-failure.png'), fullPage: true }).catch(() => {}); }
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await writeFile(join(artifacts, 'ui-test-results.json'), JSON.stringify({ passed, errors, at: new Date().toISOString() }, null, 2));
  await context.close(); await new Promise(resolve => server.close(resolve));
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('snapline-ui-')) throw new Error('Unexpected temporary profile path');
  await rm(profile, { recursive: true, force: true });
}
