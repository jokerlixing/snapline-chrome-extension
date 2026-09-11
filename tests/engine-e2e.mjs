import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'snapline-engine-tests-'));
const staged = path.join(temporary, 'extension');
const artifacts = path.join(root, 'artifacts');
const results = [];
let context;
let server;
const startedAt = new Date().toISOString();
const visibleInfobar = process.env.SNAPLINE_DEBUG_INFOBAR === '1';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Engine fixture · 中文</title><style>
html,body{margin:0;padding:0;font:24px Arial,sans-serif}main{height:2400px;background:linear-gradient(#e8eef4,#dce7df)}
header{height:200px;box-sizing:border-box;padding:30px;background:#113355;color:white}.middle{padding:40px}.bottom{position:absolute;top:2250px;height:150px;width:100%;background:rgb(80,180,130)}
</style></head><body><main><header>Snapline · 中文高清截图</header><div class="middle">真实 Chrome 截图验证</div><div class="bottom">BOTTOM</div></main></body></html>`;

try {
  await fs.mkdir(staged, { recursive: true });
  await fs.cp(path.join(root, 'extension', 'lib'), path.join(staged, 'lib'), { recursive: true });
  await fs.copyFile(path.join(root, 'extension', 'background.js'), path.join(staged, 'background.js'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  delete manifest.icons;
  delete manifest.action.default_icon;
  await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest));
  // The real capture worker is tested without coupling it to UI bundle timing.
  await fs.writeFile(path.join(staged, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Snapline engine tests</title></head><body>Engine tests</body></html>');
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/transparent') response.end('<!doctype html><title>Transparent</title><style>html,body{margin:0;height:600px}div{width:200px;height:100px;background:#db2777}</style><div></div>');
    else if (request.url === '/huge') response.end('<!doctype html><title>Huge</title><style>html,body{margin:0}div{height:40000px;background:#abc}</style><div></div>');
    else if (request.url === '/missing.png') { response.statusCode = 404; response.end('missing'); }
    else if (request.url === '/broken') response.end('<!doctype html><title>Broken image</title><img src="/missing.png"><div style="height:300px">Visible content</div>');
    else if (request.url === '/auth') response.end(`<title>Authenticated</title><div style="width:100px;height:100px;background:${request.headers.cookie?.includes('session=valid') ? '#00ff00' : '#ff0000'}"></div>`);
    else if (request.url === '/responsive-loop') response.end(`<!doctype html><title>Repeated responsive reload</title><style>html,body{margin:0}div{height:1800px;background:#7c3aed}</style><div>Reloading content</div><script>
      let pending = false;
      function reloadWhenNarrow() {
        if (innerWidth <= 800 && !pending) {
          pending = true;
          setTimeout(() => location.reload(), 400);
        }
      }
      addEventListener('resize', reloadWhenNarrow);
      reloadWhenNarrow();
    </script>`);
    else if (request.url.startsWith('/responsive-reload')) {
      const params = new URL(request.url, 'http://localhost').searchParams;
      const delay = Number(params.get('delay')) || 0;
      const restoreDelay = Number(params.get('restoreDelay')) || 0;
      response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Responsive reload fixture</title>
        <style>html,body{margin:0}.content{height:1800px;background:rgb(200,40,40)}@media(max-width:800px){.content{background:rgb(40,170,100)}}@media(max-width:500px){.content{background:rgb(120,60,210)}}</style>
        <div class="content">Responsive content</div><script>
          if (${restoreDelay}) history.scrollRestoration = 'manual';
          addEventListener('resize', () => {
            const key = 'resized-' + location.pathname + location.search;
            if (innerWidth <= 800 && !sessionStorage.getItem(key)) {
              sessionStorage.setItem(key, 'yes');
              setTimeout(() => location.reload(), ${delay});
            } else if (${restoreDelay} && innerWidth > 800 && sessionStorage.getItem(key) && !sessionStorage.getItem(key + '-restored')) {
              sessionStorage.setItem(key + '-restored', 'yes');
              setTimeout(() => location.reload(), ${restoreDelay});
            }
          });
        </script>`);
    }
    else response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const executablePath = browserPath();
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath,
    headless: true,
    viewport: null,
    args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`, '--window-size=1280,900', ...(visibleInfobar ? [] : ['--silent-debugger-extension-api']), '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/index.html`);
  const send = payload => ui.evaluate(message => chrome.runtime.sendMessage(message), payload);
  const capture = (source, options = {}) => send({ type: 'SL_CAPTURE', source, options: { width: 390, scale: 1, scope: 'full', delay: 0, lazyLoad: false, ...options } });
  const inspect = (id, sampleX = 10, sampleY = 10) => ui.evaluate(async ({ id, sampleX, sampleY }) => {
    const { getItem } = await import('./lib/store.js');
    const record = await getItem(id);
    const bytes = new Uint8Array(await record.blob.arrayBuffer());
    const header = new DataView(bytes.buffer);
    const bitmap = await createImageBitmap(record.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const drawing = canvas.getContext('2d');
    drawing.drawImage(bitmap, 0, 0);
    const pixel = [...drawing.getImageData(sampleX, sampleY, 1, 1).data];
    const dimensions = { width: header.getUint32(16), height: header.getUint32(20) };
    bitmap.close();
    return { dimensions, pixel, type: record.blob.type, byteSize: bytes.length, options: record.options };
  }, { id, sampleX, sampleY });
  const savePng = async (id, filename) => {
    const bytes = await ui.evaluate(async id => {
      const { getItem } = await import('./lib/store.js');
      return [...new Uint8Array(await (await getItem(id)).blob.arrayBuffer())];
    }, id);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, filename), Uint8Array.from(bytes));
  };
  const test = async (name, run) => {
    const start = Date.now();
    try { const evidence = await run(); results.push({ name, ok: true, ms: Date.now() - start, evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, ok: false, ms: Date.now() - start, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); throw error; }
  };
  const settledViewport = async page => {
    // Chrome animates its debugger connection infobar after detach.
    await new Promise(resolve => setTimeout(resolve, 700));
    return page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));
  };

  await test('URL capture renders full page, correct bottom pixels, and closes temporary tab', async () => {
    const before = await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
    const response = await capture({ kind: 'url', url: `${baseUrl}/fixture` });
    assert.equal(response.ok, true, response.error);
    const actual = await inspect(response.result.id, 30, 2350);
    assert.deepEqual(actual.dimensions, { width: 390, height: 2400 });
    assert.deepEqual(actual.pixel, [80, 180, 130, 255]);
    assert.equal(response.result.width, actual.dimensions.width);
    assert.equal(response.result.height, actual.dimensions.height);
    assert.equal(actual.type, 'image/png');
    assert.equal(await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length)), before);
    await savePng(response.result.id, 'engine-full-page.png');
    return { result: response.result, actual };
  });

  await test('2x capture is rendered at doubled PNG dimensions', async () => {
    const response = await capture({ kind: 'url', url: `${baseUrl}/fixture` }, { scale: 2 });
    assert.equal(response.ok, true, response.error);
    const actual = await inspect(response.result.id, 60, 4700);
    assert.deepEqual(actual.dimensions, { width: 780, height: 4800 });
    assert.deepEqual(actual.pixel, [80, 180, 130, 255]);
    await savePng(response.result.id, 'engine-full-page-2x.png');
    return actual;
  });

  for (const width of [390, 768]) {
    const expectedPixel = width === 390 ? [120, 60, 210, 255] : [40, 170, 100, 255];
    await test(`${width}px URL capture survives delayed responsive reload and closes temporary tab`, async () => {
      const url = `${baseUrl}/responsive-reload?delay=400&width=${width}`;
      const before = await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
      const response = await capture({ kind: 'url', url }, { width, delay: 800 });
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, 30, 1500);
      assert.deepEqual(actual.dimensions, { width, height: 1800 });
      assert.deepEqual(actual.pixel, expectedPixel);
      assert.equal(response.result.width, actual.dimensions.width);
      assert.equal(response.result.height, actual.dimensions.height);
      assert.equal(response.result.title, 'Responsive reload fixture');
      assert.equal(response.result.url, url);
      assert.equal(await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length)), before);
      return { result: response.result, actual };
    });

    await test(`${width}px existing tab capture survives immediate responsive reload and restores page`, async () => {
      const responsivePage = await context.newPage();
      try {
        const url = `${baseUrl}/responsive-reload?delay=0&width=${width}`;
        await responsivePage.goto(url);
        await responsivePage.evaluate(() => scrollTo(0, 600));
        const original = await responsivePage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));
        const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === url);
        assert.ok(tab, 'responsive source tab is discoverable');
        const response = await capture({ kind: 'tab', tabId: tab.id }, { width, scale: 2 });
        assert.equal(response.ok, true, response.error);
        const actual = await inspect(response.result.id, 60, 3000);
        assert.deepEqual(actual.dimensions, { width: width * 2, height: 3600 });
        assert.deepEqual(actual.pixel, expectedPixel);
        assert.equal(response.result.width, actual.dimensions.width);
        assert.equal(response.result.height, actual.dimensions.height);
        assert.equal(response.result.title, 'Responsive reload fixture');
        assert.equal(response.result.url, url);
        const restored = await settledViewport(responsivePage);
        if (visibleInfobar) {
          assert.equal(restored.width, original.width);
          assert.equal(restored.dpr, original.dpr);
          assert.equal(restored.scrollY, original.scrollY);
          assert.ok(Math.abs(restored.height - original.height) <= 60);
        } else assert.deepEqual(restored, original);
        assert.equal(await responsivePage.evaluate(() => sessionStorage.getItem('resized-' + location.pathname + location.search)), 'yes');
        return { result: response.result, actual, original, restored };
      } finally { await responsivePage.close(); }
    });
  }

  await test('restoring desktop width waits for delayed reload before restoring scroll', async () => {
    const responsivePage = await context.newPage();
    try {
      const url = `${baseUrl}/responsive-reload?delay=0&restoreDelay=400`;
      await responsivePage.goto(url);
      await responsivePage.evaluate(() => scrollTo(0, 600));
      const original = await responsivePage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));
      const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === url);
      assert.ok(tab, 'responsive source tab is discoverable');
      const response = await capture({ kind: 'tab', tabId: tab.id }, { width: 390 });
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, 30, 1500);
      assert.deepEqual(actual.dimensions, { width: 390, height: 1800 });
      assert.deepEqual(actual.pixel, [120, 60, 210, 255]);
      const restored = await settledViewport(responsivePage);
      assert.equal(restored.scrollY, 600);
      assert.equal(restored.width, original.width);
      assert.equal(restored.dpr, original.dpr);
      if (visibleInfobar) assert.ok(Math.abs(restored.height - original.height) <= 60);
      else assert.equal(restored.height, original.height);
      const restoration = await responsivePage.evaluate(() => ({ mode: history.scrollRestoration, reloaded: sessionStorage.getItem('resized-' + location.pathname + location.search + '-restored') }));
      assert.deepEqual(restoration, { mode: 'manual', reloaded: 'yes' });
      return { result: response.result, actual, original, restored, restoration };
    } finally { await responsivePage.close(); }
  });

  await test('continuous responsive reload returns actionable error and releases capture resources', async () => {
    const before = await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
    const started = Date.now();
    const response = await capture({ kind: 'url', url: `${baseUrl}/responsive-loop` }, { width: 390, delay: 800 });
    const elapsed = Date.now() - started;
    assert.equal(response.ok, false);
    assert.match(response.error, /持续刷新或跳转/);
    assert.match(response.error, /等待页面稳定后重新生成预览/);
    assert.ok(elapsed < 15000, `retries must stop within a bounded interval, took ${elapsed} ms`);
    assert.equal(await ui.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length)), before);
    const next = await capture({ kind: 'url', url: `${baseUrl}/transparent` });
    assert.equal(next.ok, true, next.error);
    return { error: response.error, elapsed, nextCapture: next.result.id };
  });

  const sourcePage = await context.newPage();
  await sourcePage.goto(`${baseUrl}/fixture`);
  const sourceTab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === `${baseUrl}/fixture`);
  assert.ok(sourceTab, 'source tab is discoverable');
  await sourcePage.evaluate(() => scrollTo(0, 800));
  const original = await sourcePage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));

  await test('existing tab capture restores scroll, viewport and DPR', async () => {
    const response = await capture({ kind: 'tab', tabId: sourceTab.id }, { scale: 2, lazyLoad: true });
    assert.equal(response.ok, true, response.error);
    const restored = await settledViewport(sourcePage);
    if (visibleInfobar) {
      assert.equal(restored.width, original.width);
      assert.equal(restored.dpr, original.dpr);
      assert.equal(restored.scrollY, original.scrollY);
      assert.ok(Math.abs(restored.height - original.height) <= 60, 'only Chrome infobar may change native viewport height');
    } else assert.deepEqual(restored, original);
    assert.equal(sourcePage.isClosed(), false);
    return { original, restored };
  });

  await test('viewport capture keeps current scroll and original viewport dimensions', async () => {
    const response = await capture({ kind: 'tab', tabId: sourceTab.id }, { scope: 'viewport', width: 0 });
    assert.equal(response.ok, true, response.error);
    const actual = await inspect(response.result.id);
    assert.equal(actual.dimensions.width, original.width);
    if (visibleInfobar) assert.ok(Math.abs(actual.dimensions.height - original.height) <= 60);
    else assert.equal(actual.dimensions.height, original.height);
    assert.notDeepEqual(actual.pixel, [17, 51, 85, 255], 'viewport starts below header');
    assert.equal(await sourcePage.evaluate(() => scrollY), 800);
    return actual;
  });

  await test('transparent capture preserves alpha in unpainted page background', async () => {
    const response = await capture({ kind: 'url', url: `${baseUrl}/transparent` }, { transparent: true });
    assert.equal(response.ok, true, response.error);
    const actual = await inspect(response.result.id, 300, 300);
    assert.equal(actual.pixel[3], 0);
    return actual;
  });

  await test('imported HTML is rendered from isolated opaque origin with Unicode intact', async () => {
    const id = await ui.evaluate(async () => {
      const { putItem } = await import('./lib/store.js');
      const id = `html-${crypto.randomUUID()}`;
      await putItem({ id, kind: 'html', title: '中文测试.html', html: '<!doctype html><meta charset="utf-8"><title>中文本地</title><style>html,body{margin:0}div{height:1200px;background:red;color:white}</style><div>本地 HTML · 你好</div><script>if(location.origin === "null" && !globalThis.chrome?.runtime?.id)document.querySelector("div").style.background = "#7c3aed";</script>' });
      return id;
    });
    const response = await capture({ kind: 'html', htmlId: id });
    assert.equal(response.ok, true, response.error);
    assert.equal(response.result.title, '中文测试.html');
    assert.equal(response.result.url, 'local-html');
    const actual = await inspect(response.result.id, 100, 600);
    assert.deepEqual(actual.dimensions, { width: 390, height: 1200 });
    assert.deepEqual(actual.pixel, [124, 58, 237, 255]);
    return actual;
  });

  await test('loaded login session is preserved in captured tab', async () => {
    await context.addCookies([{ name: 'session', value: 'valid', url: baseUrl }]);
    const authPage = await context.newPage();
    await authPage.goto(`${baseUrl}/auth`);
    const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === `${baseUrl}/auth`);
    const response = await capture({ kind: 'tab', tabId: tab.id });
    assert.equal(response.ok, true, response.error);
    const actual = await inspect(response.result.id, 50, 50);
    assert.deepEqual(actual.pixel, [0, 255, 0, 255]);
    return actual;
  });

  await test('failed image loading gives useful warning and retains visible content', async () => {
    const response = await capture({ kind: 'url', url: `${baseUrl}/broken` });
    assert.equal(response.ok, true, response.error);
    assert.ok(response.result.warnings.some(warning => warning.includes('图片未加载成功')));
    return response.result.warnings;
  });

  await test('oversized capture returns actionable error and restores original page', async () => {
    await sourcePage.goto(`${baseUrl}/huge`);
    await sourcePage.evaluate(() => scrollTo(0, 700));
    const before = await sourcePage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));
    const response = await capture({ kind: 'tab', tabId: sourceTab.id }, { scale: 2 });
    assert.equal(response.ok, false);
    assert.match(response.error, /尺寸过大/);
    const after = await sourcePage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY }));
    if (visibleInfobar) {
      assert.equal(after.width, before.width);
      assert.equal(after.dpr, before.dpr);
      assert.equal(after.scrollY, before.scrollY);
      assert.ok(Math.abs(after.height - before.height) <= 60);
    } else assert.deepEqual(after, before);
    return { error: response.error, before, after };
  });

  await test('UI cancellation restores existing tab and releases busy capture lock', async () => {
    await sourcePage.goto(`${baseUrl}/fixture`);
    await sourcePage.evaluate(() => scrollTo(0, 600));
    const pending = capture({ kind: 'tab', tabId: sourceTab.id }, { delay: 10000, scale: 2 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    await send({ type: 'SL_CANCEL' });
    const response = await pending;
    assert.equal(response.ok, false);
    assert.match(response.error, /取消/);
    assert.equal(await sourcePage.evaluate(() => scrollY), 600);
    assert.equal(await sourcePage.evaluate(() => devicePixelRatio), original.dpr);
    const next = await capture({ kind: 'url', url: `${baseUrl}/transparent` });
    assert.equal(next.ok, true, next.error);
    return { cancellation: response.error, nextCapture: next.result.id };
  });
} catch (error) {
  process.exitCode = 1;
  if (!results.some(result => !result.ok)) results.push({ name: 'test infrastructure', ok: false, error: error.stack });
  console.error(error.stack);
} finally {
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, visibleInfobar ? 'engine-e2e-normal-infobar.json' : 'engine-e2e.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), visibleInfobar, results }, null, 2));
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('snapline-engine-tests-')) throw new Error('Refusing to clean unexpected test directory');
  await fs.rm(resolved, { recursive: true, force: true }).catch(error => console.warn(`Temporary browser files retained: ${error.message}`));
}
