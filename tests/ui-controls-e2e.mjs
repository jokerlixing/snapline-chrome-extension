import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import { browserPath } from './browser-path.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>自定义宽度测试</title><style>body{margin:0;background:#edf3ff}main{height:1800px;padding:24px;box-sizing:border-box}footer{background:#245cd5;color:white;height:100px}</style><main>自定义预览宽度</main><footer>完整页面底部</footer>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/custom`;
const profile = await mkdtemp(join(tmpdir(), 'snapline-controls-'));
const extension = resolve('dist/snapline');
const context = await chromium.launchPersistentContext(profile, { executablePath: browserPath(), headless: true, viewport: { width: 1440, height: 1060 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'] });
const passed = [];
const errors = [];
const pass = text => { passed.push(text); console.log(`PASS ${text}`); };
let page;

async function generate() {
  await page.locator('#capture-button').click();
  await page.waitForFunction(() => document.querySelector('#preview-badge.ready') && !document.getElementById('export-button').disabled, null, { timeout: 120000 });
}
async function assertReset(source) {
  const historyCount = await page.locator('#history-count').innerText();
  const width = await page.locator('#width').inputValue();
  const format = await page.locator('[data-format][aria-pressed=true]').getAttribute('data-format');
  await page.locator('#reset-source').click();
  assert.equal(await page.locator(`[data-source=${source}]`).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#preview-image').isVisible(), false);
  assert.equal(await page.locator('#empty-preview').isVisible(), true);
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  assert.equal(await page.locator('#export-hint').innerText(), '先生成预览，再保存到电脑');
  assert.equal(await page.locator('#history-count').innerText(), historyCount);
  assert.equal(await page.locator('#width').inputValue(), width);
  assert.equal(await page.locator('[data-format][aria-pressed=true]').getAttribute('data-format'), format);
  for (const id of ['file-input', 'folder-input', 'url-input', 'filename', 'tab-select']) assert.equal(await page.locator(`#${id}`).inputValue(), '');
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
  assert.equal(await page.locator('#zoom-fit').innerText(), '适应');
  assert.equal(await page.locator('#preview-image').getAttribute('src'), null);
  assert.equal(await page.locator('#preview-image').evaluate(image => image.style.width), '');
  assert.equal(await page.locator('#html-entry option').count(), 0);
  assert.equal(await page.locator('#entry-wrap').isVisible(), false);
  assert.equal(await page.locator('#warning-box').isVisible(), false);
  assert.equal(await page.locator('#message').isVisible(), false);
  assert.equal(await page.locator('#file-title').innerText(), '把 HTML 文件拖到这里');
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const sourceTab = await context.newPage();
  await sourceTab.goto(url);
  const tabId = await worker.evaluate(async address => (await chrome.tabs.query({})).find(tab => tab.url === address).id, url);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/index.html?tab=${tabId}`);
  await page.waitForFunction(expected => document.getElementById('tab-select').value === String(expected), tabId);
  await page.locator('#source-url').click();
  await page.locator('#url-input').fill(url);
  await page.locator('#width').selectOption('custom');
  assert.equal(await page.locator('#custom-width').inputValue(), '1024');
  await generate();
  assert.equal(await page.locator('#preview-image').evaluate(image => image.naturalWidth), 1024);
  assert.equal(await page.locator('#preview-image').evaluate(image => image.naturalHeight), 1900);
  pass('自定义 1024px 真实完整网页预览');

  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.captureRequests = 0;
    chrome.runtime.sendMessage = (payload, ...args) => { if (payload?.type === 'SL_CAPTURE') globalThis.captureRequests++; return send(payload, ...args); };
  });
  for (const value of ['', '199', '7681', '200.5']) {
    await page.locator('#custom-width').fill(value);
    assert.equal(await page.locator('#export-button').isDisabled(), true);
    await page.locator('#capture-button').click();
    await page.locator('#message.error').filter({ hasText: '200–7680' }).waitFor();
  }
  assert.equal(await page.evaluate(() => globalThis.captureRequests), 0);
  pass('空白、超范围、小数宽度阻止截图请求并使旧预览失效');

  await page.locator('#custom-width').fill('1024');
  await page.waitForFunction(async () => (await chrome.storage.local.get('preferences')).preferences.width === 1024);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('width').value === 'custom');
  assert.equal(await page.locator('#custom-width').inputValue(), '1024');
  await page.locator('#width').selectOption('390');
  await page.waitForFunction(async () => (await chrome.storage.local.get('preferences')).preferences.width === 390);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('width').value === '390');
  assert.equal(await page.locator('#custom-width-field').isVisible(), false);
  await page.locator('#nav-history').click();
  await page.locator('.history-actions .text-button').first().click();
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.equal(await page.locator('#width').inputValue(), 'custom');
  assert.equal(await page.locator('#custom-width').inputValue(), '1024');
  pass('自定义宽度和手机预设重开保留，历史还原自定义宽度');

  await page.locator('#source-url').click();
  await page.locator('#url-input').fill(url);
  await generate();
  await page.locator('#zoom-in').click();
  await page.locator('[data-format=webp]').click();
  await assertReset('url');
  await page.locator('#capture-button').click();
  await page.locator('#message.error').filter({ hasText: '请先粘贴' }).waitFor();
  await page.locator('#url-input').fill(url);
  await generate();
  pass('网页链接重置清空预览和来源，保留历史及导出设置，重新输入可生成');

  await page.locator('#source-html').click();
  await page.locator('#folder-input').setInputFiles(resolve('fixtures/demo-folder'));
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await generate();
  await assertReset('html');
  await page.locator('#capture-button').click();
  await page.locator('#message.error').filter({ hasText: '请先选择一个 HTML' }).waitFor();
  await page.locator('#file-input').setInputFiles('fixtures/demo.html');
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await generate();
  pass('文件夹重置清除导入状态，重新导入单文件后正常生成');

  await page.locator('#source-tab').click();
  await page.waitForFunction(expected => [...document.getElementById('tab-select').options].some(option => option.value === String(expected)), tabId);
  await page.locator('#tab-select').selectOption(String(tabId));
  await generate();
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let delayNextTabs = true;
    chrome.runtime.sendMessage = (payload, ...args) => {
      const response = send(payload, ...args);
      if (payload?.type !== 'SL_TABS' || !delayNextTabs) return response;
      delayNextTabs = false;
      return new Promise(resolve => { globalThis.releaseOldTabs = async () => resolve(await response); });
    };
  });
  await page.locator('#refresh-tabs').click();
  await page.waitForFunction(() => Boolean(globalThis.releaseOldTabs));
  await assertReset('tab');
  await page.evaluate(() => globalThis.releaseOldTabs());
  await page.locator('#source-html').click();
  await page.locator('#source-tab').click();
  await page.waitForFunction(expected => [...document.getElementById('tab-select').options].some(option => option.value === String(expected)), tabId);
  assert.equal(await page.locator('#tab-select').inputValue(), '');
  await page.locator('#capture-button').click();
  await page.locator('#message.error').filter({ hasText: '请先选择一个已打开' }).waitFor();
  await page.locator('#tab-select').selectOption(String(tabId));
  await generate();
  pass('标签页重置抵御旧 query 和在途刷新，重新选择后可生成');

  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 页面无横向溢出`);
    await page.locator('#custom-width').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#custom-width').evaluate(input => { const r = input.getBoundingClientRect(); return r.width > 100 && r.left >= 0 && r.right <= innerWidth; }), true);
    await page.screenshot({ path: join(artifacts, `custom-controls-${width}.png`), fullPage: true });
  }
  pass('390px 和 768px 界面自定义宽度与重置按钮无横向溢出');
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.locator('#nav-history').click();
  await page.locator('#clear-history').click();
  await page.locator('.history-empty').waitFor();
  await page.locator('#nav-workbench').click();
  assert.equal(await page.locator('#export-hint').innerText(), '先生成预览，再保存到电脑');
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  assert.deepEqual(errors, []);
  pass('清空历史重置导出提示，整个流程无页面脚本错误');
} catch (error) {
  if (page) { console.log('UI MESSAGE:', await page.locator('#message').innerText().catch(() => '')); await page.screenshot({ path: join(artifacts, 'ui-controls-failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await writeFile(join(artifacts, 'ui-controls-results.json'), JSON.stringify({ passed, errors, at: new Date().toISOString() }, null, 2));
  await context.close();
  await new Promise(resolve => server.close(resolve));
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('snapline-controls-')) throw new Error('Unexpected temporary profile path');
  await rm(profile, { recursive: true, force: true });
}
