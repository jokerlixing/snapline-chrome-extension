import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';
import { html2canvasForeignObjectOriginPlugin } from '../scripts/html2canvas-patch.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'snapline-web-capture-'));
const artifacts = path.join(root, 'artifacts');
const results = [];
let server;
let browser;
const colorFixture = `<!doctype html><html><head><meta charset="utf-8"><title>Color fidelity fixture</title><style>
*{box-sizing:border-box}html,body{margin:0;width:800px;min-height:1200px;background:#f3efe4}
.band{width:800px;height:200px}.solid{background:rgb(243,239,228)}.alpha{background:rgba(255,255,255,.35)}
.gradient{background:linear-gradient(90deg,#f7f4ed 0%,#f3efe4 100%)}
.shadow{background:#f7f4ed;box-shadow:inset 0 0 160px rgba(23,43,37,.16)}
.p3{background:color(display-p3 .92 .72 .36)}.oklch{background:oklch(80% .12 210)}
</style></head><body><div class="band solid"></div><div class="band alpha"></div><div class="band gradient"></div><div class="band shadow"></div><div class="band p3"></div><div class="band oklch"></div></body></html>`;
const colorPoints = [[0,0],[100,100],[100,300],[100,500],[400,500],[700,500],[100,700],[400,700],[100,900],[100,1100],[799,1199]];

try {
  await build({ entryPoints: [path.join(root, 'extension/lib/web-capture.js')], outfile: path.join(temporary, 'capture.js'), bundle: true, format: 'esm', target: 'chrome120', logLevel: 'silent', plugins: [html2canvasForeignObjectOriginPlugin] });
  await build({ entryPoints: [path.join(root, 'extension/lib/import-html.js')], outfile: path.join(temporary, 'import-html.js'), bundle: true, format: 'esm', target: 'chrome120', logLevel: 'silent' });
  const bundle = await fs.readFile(path.join(temporary, 'capture.js'));
  const importer = await fs.readFile(path.join(temporary, 'import-html.js'));
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
    if (request.url === '/capture.js') response.end(bundle);
    else if (request.url === '/import-html.js') response.end(importer);
    else if (request.url === '/malicious') response.end('<script>parent.localStorage.setItem("sentinel", "nested-owned");top.document.body.dataset.owned="nested";</script>');
    else if (request.url === '/color-fixture') response.end(colorFixture);
    else response.end('<!doctype html><title>Web capture tests</title><script type="module">import {captureWebHtml} from "./capture.js";import {packHtml} from "./import-html.js";window.captureWebHtml=captureWebHtml;window.packHtml=packHtml;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof captureWebHtml === 'function');
  const fixture = await fs.readFile(path.join(root, 'fixtures/full-page.html'), 'utf8');
  const test = async (name, run) => {
    const start = Date.now();
    const evidence = await run();
    results.push({ name, ok: true, ms: Date.now() - start, evidence });
    console.log(`PASS ${name}: ${JSON.stringify(evidence)}`);
  };
  const render = (html, options, sample = { x: 100, y: 3500 }) => page.evaluate(async ({ html, options, sample }) => {
    const stages = [];
    const capture = await captureWebHtml({ html }, options, { onProgress: value => stages.push(value) });
    const bitmap = await createImageBitmap(capture.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const pixel = [...ctx.getImageData(Math.min(bitmap.width - 1, sample.x), Math.min(bitmap.height - 1, sample.y), 1, 1).data];
    const result = { width: capture.width, height: capture.height, pixel, type: capture.blob.type, title: capture.title, warnings: capture.warnings, stages, remainingFrames: document.querySelectorAll('iframe').length };
    bitmap.close(); return result;
  }, { html, options, sample });

  for (const width of [390, 768, 1024]) for (const scale of [1, 2, 3]) {
    await test(`local full HTML ${width}px ${scale}x retains bottom`, async () => {
      const result = await render(fixture, { width, scale, delay: 0 }, { x: 100 * scale, y: 3500 * scale });
      assert.equal(result.width, width * scale); assert.equal(result.height, 3600 * scale);
      assert.deepEqual(result.pixel, [40, 180, 100, 255]); assert.equal(result.remainingFrames, 0);
      assert.equal(result.stages.at(-1).percent, 100); return result;
    });
  }
  await test('viewport scope keeps responsive viewport dimensions', async () => {
    const result = await render(fixture, { width: 390, scale: 2, scope: 'viewport', delay: 0 }, { x: 300, y: 1500 });
    assert.equal(result.width, 780); assert.equal(result.height, 1688);
    assert.notDeepEqual(result.pixel, [40, 180, 100, 255]); return result;
  });
  await test('width zero uses the browser viewport', async () => {
    const result = await render(fixture, { width: 0, delay: 0 });
    assert.equal(result.width, 1280); return result;
  });
  await test('web output matches Chromium native colors used by the extension', async () => {
    const referencePage = await browser.newPage({ viewport: { width: 800, height: 900 } });
    let reference;
    try {
      await referencePage.goto(`http://127.0.0.1:${server.address().port}/color-fixture`);
      reference = await referencePage.screenshot({ fullPage: true });
    } finally { await referencePage.close(); }
    const result = await page.evaluate(async ({ html, points, reference }) => {
      const sample = async blob => {
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'default' });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const drawing = canvas.getContext('2d', { colorSpace: 'srgb' });
        drawing.drawImage(bitmap, 0, 0);
        const colors = points.map(([x, y]) => [...drawing.getImageData(x, y, 1, 1).data]);
        const size = [bitmap.width, bitmap.height]; bitmap.close(); return { size, colors };
      };
      const nativeBytes = Uint8Array.from(atob(reference), character => character.charCodeAt(0));
      const native = await sample(new Blob([nativeBytes], { type: 'image/png' }));
      const capture = await captureWebHtml({ html }, { width: 800, scale: 1, scope: 'full', delay: 0 });
      return { native, web: await sample(capture.blob) };
    }, { html: colorFixture, points: colorPoints, reference: reference.toString('base64') });
    assert.deepEqual(result.native.size, [800, 1200]);
    assert.deepEqual(result.web.size, result.native.size);
    assert.deepEqual(result.web.colors[0], [243, 239, 228, 255], 'solid sRGB stays exact');
    const delta = result.web.colors.flatMap((color, index) => color.slice(0, 3).map((channel, channelIndex) => Math.abs(channel - result.native.colors[index][channelIndex])));
    assert.ok(Math.max(...delta) <= 1, `web and native color channels differ by ${Math.max(...delta)}`);
    return { points: colorPoints, maxChannelDelta: Math.max(...delta), native: result.native.colors, web: result.web.colors };
  });
  await test('transparent capture keeps alpha', async () => {
    const result = await render('<!doctype html><style>html,body{margin:0}div{width:80px;height:80px;background:red}</style><div></div>', { width: 390, delay: 0, transparent: true }, { x: 300, y: 500 });
    assert.equal(result.pixel[3], 0); return result;
  });
  await test('static internal scrolling includes full content', async () => {
    const html = await fs.readFile(path.join(root, 'fixtures/nested-scroll.html'), 'utf8');
    const result = await render(html, { width: 768, scale: 1, delay: 0 });
    assert.equal(result.height, 3600); assert.deepEqual(result.pixel, [40, 180, 100, 255]); return result;
  });
  await test('packed HTML folder includes CSS imports and SVG image locally', async () => {
    const files = await Promise.all((await fs.readdir(path.join(root, 'fixtures/demo-folder'))).map(async name => ({ name, content: await fs.readFile(path.join(root, 'fixtures/demo-folder', name), 'utf8') })));
    const result = await page.evaluate(async files => {
      const input = files.map(({ name, content }) => {
        const file = new File([content], name); Object.defineProperty(file, 'webkitRelativePath', { value: `demo-folder/${name}` }); return file;
      });
      const packed = await packHtml(input);
      const capture = await captureWebHtml(packed, { width: 768, delay: 0 });
      const bitmap = await createImageBitmap(capture.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const result = { width: capture.width, height: capture.height, warnings: capture.warnings, packedWarnings: packed.warnings, bottomPixel: [...ctx.getImageData(20, bitmap.height - 20, 1, 1).data] };
      bitmap.close(); return result;
    }, files);
    assert.equal(result.width, 768); assert.ok(result.height >= 1400); assert.ok(!result.warnings.some(message => /张图片未加载/.test(message))); assert.deepEqual(result.packedWarnings, []); return result;
  });
  await test('scripts, SVG handlers, images and nested frames never gain host access', async () => {
    const result = await page.evaluate(async () => {
      localStorage.setItem('sentinel', 'host-only');
      const html = `<!doctype html><meta http-equiv="refresh" content="0;url=/malicious"><style>html,body{margin:0}main{height:1200px;background:rgb(40,180,100)}</style><main>SAFE STATIC CONTENT</main>
        <script>top.localStorage.setItem('sentinel','script-owned');top.document.body.dataset.owned='script';<\/script>
        <body onload="top.localStorage.setItem('sentinel','body-owned')">
        <img src="data:image/png;base64,INVALID" onerror="top.localStorage.setItem('sentinel','image-owned')">
        <svg onload="top.localStorage.setItem('sentinel','svg-owned')"></svg>
        <iframe src="/malicious"></iframe><iframe srcdoc="&lt;script&gt;top.localStorage.setItem('sentinel','srcdoc-owned')&lt;/script&gt;"></iframe>`;
      const result = await captureWebHtml({ html }, { width: 390, delay: 0 });
      return { width: result.width, height: result.height, sentinel: localStorage.sentinel, owned: document.body.dataset.owned, frames: document.querySelectorAll('iframe').length, warnings: result.warnings };
    });
    assert.equal(result.sentinel, 'host-only'); assert.equal(result.owned, undefined); assert.equal(result.frames, 0); assert.ok(result.warnings.some(message => message.includes('不会执行'))); return result;
  });
  await test('renderer and all clones stay in a script-disabled sandbox', async () => {
    const result = await page.evaluate(async () => {
      localStorage.setItem('sentinel', 'host-only');
      const checkpoints = [];
      await captureWebHtml({ html: '<!doctype html><div style="height:1600px;background:green">TEST</div>' }, { width: 768, delay: 0 }, {
        onProgress({ percent }) {
          if (percent !== 65) return;
          const frame = document.querySelector('iframe');
          checkpoints.push(frame.getAttribute('sandbox'));
          // Bypass source cleanup to verify the sandbox itself blocks scripts
          // and handlers even when html2canvas clones these nodes.
          const doc = frame.contentDocument;
          const img = doc.createElement('img'); img.setAttribute('onerror', "top.localStorage.setItem('sentinel','clone-owned')"); img.src = 'data:image/png;base64,BAD'; doc.body.append(img);
          const nested = doc.createElement('iframe'); nested.srcdoc = '<script>top.localStorage.setItem("sentinel","nested-owned")<\/script>'; doc.body.append(nested);
        },
      });
      return { checkpoints, sentinel: localStorage.sentinel, remainingFrames: document.querySelectorAll('iframe').length };
    });
    assert.deepEqual(result.checkpoints, ['allow-same-origin']); assert.equal(result.sentinel, 'host-only'); assert.equal(result.remainingFrames, 0); return result;
  });
  await test('canceling a delayed capture removes its sandbox and permits another capture', async () => {
    const result = await page.evaluate(async html => {
      const controller = new AbortController();
      const pending = captureWebHtml({ html }, { width: 390, delay: 10000 }, { signal: controller.signal, onProgress({ percent }) { if (percent === 45) controller.abort(); } });
      let error;
      try { await pending; } catch (value) { error = { name: value.name, message: value.message }; }
      const frames = document.querySelectorAll('iframe').length;
      const next = await captureWebHtml({ html }, { width: 390, delay: 0 });
      return { error, frames, nextHeight: next.height };
    }, fixture);
    assert.equal(result.error.name, 'AbortError'); assert.equal(result.frames, 0); assert.equal(result.nextHeight, 3600); return result;
  });
  await test('oversized capture rejects before creating a giant canvas', async () => {
    const result = await page.evaluate(async () => {
      try { await captureWebHtml({ html: '<!doctype html><div style="height:40000px"></div>' }, { width: 390, delay: 0 }); }
      catch (error) { return { message: error.message, frames: document.querySelectorAll('iframe').length }; }
    });
    assert.match(result.message, /尺寸过大/); assert.equal(result.frames, 0); return result;
  });
} catch (error) {
  results.push({ name: 'failure', ok: false, error: error.stack }); process.exitCode = 1; console.error(error.stack);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'web-capture-e2e.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('snapline-web-capture-')) throw new Error('Unexpected test directory');
  await fs.rm(temporary, { recursive: true, force: true });
}
