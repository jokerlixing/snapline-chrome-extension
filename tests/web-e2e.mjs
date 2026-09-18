import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const root = resolve('dist/site');
const artifacts = resolve('artifacts');
const prefix = '/snapline-chrome-extension/';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) throw new Error();
    const path = resolve(root, decodeURIComponent(pathname.slice(prefix.length) || 'index.html'));
    if (!path.startsWith(root + sep)) throw new Error();
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'text/plain' });
    response.end(content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
// Set SNAPLINE_WEB_URL to repeat the same workflow against the deployed site.
const url = process.env.SNAPLINE_WEB_URL || localUrl;
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const passed = [];
page.on('pageerror', error => errors.push(error.message));
const pass = label => { passed.push(label); console.log(`PASS ${label}`); };
const sample = `<!doctype html><meta charset="utf-8"><title>网页版本地测试</title><style>html,body{margin:0}main{height:2400px;background:#eef3ff;position:relative}header{height:160px;background:rgb(180,50,70)}footer{position:absolute;bottom:0;height:160px;width:100%;background:rgb(40,180,100)}</style><main><header>START</header><footer>END</footer></main><script>parent.localStorage.setItem('snapline-test-attacked','yes')</script>`;
async function generate() {
  await page.locator('#capture-button').click();
  await page.waitForFunction(() => document.querySelector('#preview-badge.ready') && !document.getElementById('export-button').disabled, null, { timeout: 60000 });
}
try {
  await page.goto(url);
  await page.locator('#source-html[aria-selected=true]').waitFor();
  assert.equal(await page.locator('#source-tab').isVisible(), false);
  assert.equal(await page.locator('#source-code').isVisible(), true);
  assert.equal(await page.locator('#filename').count(), 0);
  await page.evaluate(() => localStorage.setItem('snapline-test-attacked', 'no'));
  pass('公开路径下加载真正网页版，显示可用来源并移除插件专属标签页');

  await page.locator('#demo-button').click();
  await page.waitForFunction(() => document.querySelector('#preview-badge.ready') && !document.getElementById('export-button').disabled, null, { timeout: 60000 });
  assert.ok(await page.locator('#preview-image').evaluate(image => image.naturalHeight > 500));
  pass('示例网页一键生成真实预览');

  await page.locator('#file-input').setInputFiles({ name: 'sample.html', mimeType: 'text/html', buffer: Buffer.from(sample) });
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await page.locator('#width').selectOption('custom');
  await page.locator('#custom-width').fill('621');
  await page.locator('[data-scale="2"]').click();
  await generate();
  const pixels = await page.locator('#preview-image').evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, top: [...drawing.getImageData(300, 10, 1, 1).data], bottom: [...drawing.getImageData(300, canvas.height - 10, 1, 1).data] };
  });
  assert.equal(pixels.width, 1242); assert.equal(pixels.height, 4800);
  assert.deepEqual(pixels.top, [180, 50, 70, 255]); assert.deepEqual(pixels.bottom, [40, 180, 100, 255]);
  assert.equal(await page.evaluate(() => localStorage.getItem('snapline-test-attacked')), 'no');
  assert.match(await page.locator('#warning-box').innerText(), /脚本/);
  pass('本地HTML自定义621px×2完整导出首尾像素，脚本未接触工作台');

  for (const format of ['png', 'jpeg', 'webp', 'pdf']) {
    await page.locator(`[data-format=${format}]`).click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#export-button').click();
    const download = await downloadEvent;
    const file = join(artifacts, `web-download.${format === 'jpeg' ? 'jpg' : format}`);
    await download.saveAs(file);
    const bytes = await readFile(file);
    assert.ok(bytes.length > 500);
    if (format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    if (format === 'jpeg') assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
    if (format === 'webp') assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
  }
  pass('PNG/JPG/WebP/PDF四种格式实际下载成功');

  await page.locator('#reset-source').click();
  assert.equal(await page.locator('#preview-image').isVisible(), false);
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  await page.locator('#source-code').click();
  await page.locator('#html-code').fill(sample.replace('网页版本地测试', '粘贴代码测试'));
  await page.locator('[data-scale="1"]').click();
  await page.locator('#width').selectOption('390');
  await generate();
  assert.equal(await page.locator('#preview-image').evaluate(image => image.naturalWidth), 390);
  await page.locator('#reset-source').click();
  assert.equal(await page.locator('#html-code').inputValue(), '');
  pass('粘贴HTML生成手机宽度预览，重置同时清空代码和预览');

  await page.locator('#source-html').click();
  await page.locator('#folder-input').setInputFiles(resolve('fixtures/demo-folder'));
  await page.locator('#file-description').filter({ hasText: '已准备好' }).waitFor();
  await generate();
  assert.ok(await page.locator('#preview-image').evaluate(image => image.naturalHeight > 500));
  pass('完整资源文件夹导入并生成预览');

  await page.locator('#source-url').click();
  assert.equal(await page.locator('#url-input').isVisible(), false);
  assert.equal(await page.locator('#web-url-guide').isVisible(), true);
  assert.equal(await page.locator('#capture-button').isDisabled(), true);
  assert.ok(await page.locator('#web-url-guide a[href*="github.com"]').count());
  pass('在线网页清晰引导插件，不提供无法执行的跨站截图入口');

  const gutter = await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter);
  assert.equal(gutter, 'stable', '根元素必须预留滚动条槽位，否则通知出现时会推动整页重排');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('preview-stage')).scrollbarGutter), 'stable');
  const measureLayout = () => page.evaluate(() => ({
    page: document.documentElement.clientWidth,
    grid: Math.round(document.querySelector('.workspace-grid').getBoundingClientRect().width),
    stage: document.getElementById('preview-stage').clientWidth,
    image: Math.round(document.getElementById('preview-image').getBoundingClientRect().width),
  }));
  const settled = await measureLayout();
  await page.evaluate(() => {
    const notice = document.getElementById('message'); notice.textContent = '已创建 拾页示例.png（1.2 MB），请在浏览器下载记录中查看。'; notice.hidden = false;
    document.getElementById('warning-box').hidden = false;
    document.getElementById('browser-notice').hidden = false;
  });
  await page.waitForTimeout(200);
  assert.deepEqual(await measureLayout(), settled, '通知出现后页面宽度和预览图尺寸都不应变化');
  await page.evaluate(() => { document.getElementById('message').hidden = true; document.getElementById('warning-box').hidden = true; });
  pass('通知出现不改变页面宽度与预览图尺寸，滚动条槽位已预留');

  await page.reload();
  await page.waitForFunction(() => document.getElementById('width').value === '390');
  assert.ok(Number(await page.locator('#history-count').innerText()) >= 4);
  await page.locator('#nav-history').click();
  await page.locator('.history-actions .text-button').first().click();
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  pass('网页版偏好与历史在重新打开后保留，并能再次打开预览');

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `web-workbench-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  pass('桌面/平板/手机布局无横向溢出，全部流程无脚本错误');
} catch (error) {
  console.error('WEB UI:', await page.locator('#message').innerText().catch(() => ''));
  await page.screenshot({ path: join(artifacts, 'web-ui-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, 'web-e2e-results.json'), JSON.stringify({ url, passed, errors, at: new Date().toISOString() }, null, 2));
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
