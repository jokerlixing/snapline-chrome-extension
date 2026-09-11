import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'snapline-scroll-tests-'));
const staged = path.join(temporary, 'extension');
const artifacts = path.join(root, 'artifacts');
const baseline = process.env.SNAPLINE_SCROLL_BASELINE === '1';
const startedAt = new Date().toISOString();
const results = [];
const colors = [[180, 50, 70, 255], [60, 100, 200, 255], [40, 180, 100, 255]];
let context;
let server;

function fixture({ height = 6000, virtual = false, mainScroll = true, sticky = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Chat-style scroll fixture</title><style>
  *{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;font:16px Arial}body{display:flex;background:#eee}
  aside{flex:0 0 200px;height:100vh;overflow:auto;background:rgb(25,35,45)}aside>div{height:18000px;color:white}
  .shell{display:flex;flex:1;min-width:0;flex-direction:column;height:100vh}header,footer{height:64px;flex-shrink:0;background:rgb(210,210,210)}
  main{flex:1;min-height:0;overflow:${mainScroll ? 'auto' : 'hidden'};position:relative;background:rgb(240,230,210);scroll-behavior:smooth;scrollbar-width:none}
  main::-webkit-scrollbar,aside::-webkit-scrollbar{display:none}.segment{height:${height / 3}px;position:relative}
  .segment:first-child{background:rgb(180,50,70)}.segment:nth-child(2){background:rgb(60,100,200)}.segment:nth-child(3){background:rgb(40,180,100)}
  pre{margin:0;position:absolute;left:16px;top:24px;width:160px;height:96px;overflow:auto;background:#101010;color:white}code{display:block;height:25000px}
  .virtual-row{position:absolute;left:0;right:0;height:100px}.virtual-spacer{height:${height}px;position:relative}
  .sticky-thread{position:sticky;top:0}.sticky-title{position:sticky;top:0;height:64px;margin:0;background:rgb(230,190,40)}.sticky-title.second{background:rgb(170,50,190)}
  </style></head><body><aside><div>Conversation sidebar, taller than the main content</div></aside><div class="shell"><header>Conversation header</header>
  <main id="conversation" aria-label="Conversation">${virtual ? '<div class="virtual-spacer"></div>' : mainScroll ? `${sticky ? '<section class="sticky-thread">' : ''}<div class="segment">${sticky ? '<h2 class="sticky-title">First section</h2>' : '<pre><code>Nested code sample</code></pre>'}</div><div class="segment">${sticky ? '<h2 class="sticky-title second">Second section</h2>' : ''}</div><div class="segment"></div>${sticky ? '</section>' : ''}` : '<pre><code>Only this small code sample and the sidebar can scroll.</code></pre>'}</main><footer>Message composer</footer></div>
  <script>
  window.scrollEvents=[];const conversation=document.querySelector('#conversation');
  ${virtual ? `const palette=['rgb(180,50,70)','rgb(60,100,200)','rgb(40,180,100)'];
  function renderVisible(){const first=Math.max(0,Math.floor(conversation.scrollTop/100)-1);const last=Math.min(${height / 100},Math.ceil((conversation.scrollTop+conversation.clientHeight)/100)+1);const nodes=[];
  for(let index=first;index<last;index++){const row=document.createElement('div');row.className='virtual-row';row.style.top=(index*100)+'px';row.style.background=palette[Math.min(2,Math.floor(index/${height / 300}))];row.textContent='Virtual row '+index;nodes.push(row)}
  document.querySelector('.virtual-spacer').replaceChildren(...nodes)}renderVisible();` : ''}
  conversation.addEventListener('scroll',()=>{window.scrollEvents.push(conversation.scrollTop);${virtual ? 'renderVisible();' : ''}});
  </script></body></html>`;
}

try {
  await fs.mkdir(staged, { recursive: true });
  await fs.cp(path.join(root, 'extension', 'lib'), path.join(staged, 'lib'), { recursive: true });
  const background = baseline
    ? execFileSync('git', ['show', 'HEAD:extension/background.js'], { cwd: root })
    : await fs.readFile(path.join(root, 'extension', 'background.js'));
  await fs.writeFile(path.join(staged, 'background.js'), background);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  delete manifest.icons;
  delete manifest.action.default_icon;
  await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(staged, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Scroll capture tests</title>');
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const mode = new URL(request.url, 'http://localhost').pathname;
    response.end(fixture(mode === '/huge' ? { height: 42000 } : mode === '/virtual' ? { height: 18000, virtual: true } : mode === '/cancel' ? { height: 24000 } : mode === '/small-scrolls' ? { mainScroll: false } : mode === '/sticky' ? { sticky: true } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: browserPath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`, '--window-size=1280,900', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  const send = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  const capture = (tabId, options = {}) => send({ type: 'SL_CAPTURE', source: { kind: 'tab', tabId }, options: { width: 0, scale: 1, scope: 'full', delay: 0, lazyLoad: false, ...options } });
  const readState = page => page.evaluate(() => {
    const main = document.querySelector('#conversation');
    return { width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight, scrollY, scrollTop: main.scrollTop, mainWidth: main.clientWidth, mainHeight: main.clientHeight, fullHeight: main.scrollHeight, sidebarTop: document.querySelector('aside').scrollTop, codeTop: document.querySelector('pre')?.scrollTop ?? null, mainStyle: main.getAttribute('style'), stickyStyles: [...document.querySelectorAll('.sticky-thread,.sticky-title')].map(node => ({ style: node.getAttribute('style'), position: getComputedStyle(node).position, top: getComputedStyle(node).top })), dpr: devicePixelRatio };
  });
  const source = async (route = '/conversation', scrollTop = 713) => {
    const page = await context.newPage();
    await page.goto(`${baseUrl}${route}`);
    await page.evaluate(top => {
      document.querySelector('#conversation').scrollTo({ top, behavior: 'instant' });
      document.querySelector('aside').scrollTop = 311;
      if (document.querySelector('pre')) document.querySelector('pre').scrollTop = 117;
    }, scrollTop);
    await page.waitForTimeout(50);
    const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === `${baseUrl}${route}`);
    assert.ok(tab, 'source tab is discoverable');
    const before = await readState(page);
    assert.equal(before.documentHeight, before.height, 'fixture document is only one viewport tall');
    return { page, tabId: tab.id, before };
  };
  const inspect = (id, points, bandColors = []) => ui.evaluate(async ({ id, points, bandColors }) => {
    const { getItem } = await import('./lib/store.js');
    const record = await getItem(id);
    const bitmap = await createImageBitmap(record.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const pixels = points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    const column = bandColors.length ? ctx.getImageData(Math.floor(bitmap.width * .7), 0, 1, bitmap.height).data : [];
    const bands = bandColors.map(color => {
      const rows = [];
      for (let y = 0; y < bitmap.height; y++) if (color.every((value, i) => column[y * 4 + i] === value)) rows.push(y);
      return { count: rows.length, first: rows[0], last: rows.at(-1) };
    });
    const result = { width: bitmap.width, height: bitmap.height, pixels, ...(bands.length ? { bands } : {}) };
    bitmap.close(); return result;
  }, { id, points, bandColors });
  const restore = async (page, before) => {
    await page.waitForTimeout(700);
    const after = await readState(page);
    assert.deepEqual(after, before, 'the source viewport, DPR, scroll positions, and inline styles are restored');
    return after;
  };
  const test = async (name, run) => {
    if (process.env.SNAPLINE_SCROLL_FILTER && !name.includes(process.env.SNAPLINE_SCROLL_FILTER)) return;
    const start = Date.now();
    try { const evidence = await run(); results.push({ name, ok: true, ms: Date.now() - start, evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, ok: false, ms: Date.now() - start, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
  };

  await test('full capture chooses the main conversation over the taller sidebar and nested code block', async () => {
    const { page, tabId, before } = await source();
    try {
      const response = await capture(tabId);
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, [100, 2100, 5900].map(y => [500, y]));
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [before.mainWidth, before.fullHeight], JSON.stringify({ actual, before }));
      assert.deepEqual(actual.pixels, colors, 'capture retains the top, middle, and final content');
      assert.deepEqual([response.result.width, response.result.height], [actual.width, actual.height]);
      return { actual, before, after };
    } finally { await page.close(); }
  });

  await test('tablet width and 2x scale capture every main-scroll pixel and restore the original scroll', async () => {
    const { page, tabId, before } = await source();
    try {
      const response = await capture(tabId, { width: 768, scale: 2 });
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, [100, 2100, 5900].map(y => [800, y * 2]));
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [(768 - 200) * 2, before.fullHeight * 2]);
      assert.deepEqual(actual.pixels, colors);
      return { actual, before, after };
    } finally { await page.close(); }
  });

  await test('viewport mode includes the original sidebar, header, and current conversation position', async () => {
    const { page, tabId, before } = await source('/conversation', 2100);
    try {
      const response = await capture(tabId, { scope: 'viewport' });
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, [[100, 100], [500, 30], [700, 150]]);
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [before.width, before.height]);
      assert.deepEqual(actual.pixels, [[25, 35, 45, 255], [210, 210, 210, 255], colors[1]]);
      return { actual, before, after };
    } finally { await page.close(); }
  });

  await test('small code scroll areas and the sidebar do not replace a non-scrolling main page', async () => {
    const { page, tabId, before } = await source('/small-scrolls', 0);
    try {
      const response = await capture(tabId);
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, [[100, 100], [700, 200]]);
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [before.width, before.height]);
      assert.deepEqual(actual.pixels, [[25, 35, 45, 255], [240, 230, 210, 255]]);
      return { actual, before, after };
    } finally { await page.close(); }
  });

  await test('virtualized main scroll content is stitched while each row exists in the DOM', async () => {
    const { page, tabId, before } = await source('/virtual', 7213);
    try {
      const response = await capture(tabId);
      assert.equal(response.ok, true, response.error);
      const points = Array.from({ length: 180 }, (_, index) => [500, index * 100 + 50]);
      const actual = await inspect(response.result.id, points);
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [before.mainWidth, 18000]);
      actual.pixels.forEach((pixel, index) => assert.deepEqual(pixel, colors[Math.floor(index / 60)], `virtual row ${index} remains in stitched screenshot`));
      return { dimensions: [actual.width, actual.height], rowsVerified: actual.pixels.length, before, after };
    } finally { await page.close(); }
  });

  await test('sticky content wrappers and section titles remain visible exactly once and regain their original styles', async () => {
    const { page, tabId, before } = await source('/sticky', 713);
    try {
      const response = await capture(tabId);
      assert.equal(response.ok, true, response.error);
      const actual = await inspect(response.result.id, [100, 2100, 5900].map(y => [500, y]), [[230, 190, 40, 255], [170, 50, 190, 255]]);
      const after = await restore(page, before);
      assert.deepEqual([actual.width, actual.height], [before.mainWidth, 6000]);
      assert.deepEqual(actual.pixels, colors, 'the sticky wrapper must not hide any conversation content');
      assert.deepEqual(actual.bands, [{ count: 64, first: 0, last: 63 }, { count: 64, first: 2000, last: 2063 }], 'each sticky heading is captured exactly once at its original document position');
      return { actual, before, after };
    } finally { await page.close(); }
  });

  await test('oversized main scroll capture reports the size limit and restores source state', async () => {
    const { page, tabId, before } = await source('/huge', 3173);
    try {
      const response = await capture(tabId);
      const after = await restore(page, before);
      assert.equal(response.ok, false);
      assert.match(response.error, /尺寸过大/);
      return { error: response.error, before, after };
    } finally { await page.close(); }
  });

  await test('canceling during main-scroll capture restores source state and releases the capture lock', async () => {
    const { page, tabId, before } = await source('/cancel', 5173);
    let pending;
    try {
      await page.evaluate(() => { window.scrollEvents = []; });
      pending = capture(tabId);
      await page.waitForFunction(() => window.scrollEvents.some(top => top > 0 && top < 5000), null, { timeout: 10000 });
      await send({ type: 'SL_CANCEL' });
      const response = await pending;
      const after = await restore(page, before);
      assert.equal(response.ok, false);
      assert.match(response.error, /取消/);
      const next = await capture(tabId, { scope: 'viewport' });
      assert.equal(next.ok, true, next.error);
      return { cancellation: response.error, before, after, nextCapture: next.result.id };
    } finally { await send({ type: 'SL_CANCEL' }); await pending?.catch(() => {}); await page.close(); }
  });
} catch (error) {
  results.push({ name: 'test infrastructure', ok: false, error: error.stack }); console.error(error.stack);
} finally {
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, baseline ? 'scroll-before.json' : 'scroll-capture-e2e.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), baseline, results }, null, 2));
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('snapline-scroll-tests-')) throw new Error('Refusing to clean an unexpected test directory');
  await fs.rm(temporary, { recursive: true, force: true }).catch(error => console.warn(`Temporary browser files retained: ${error.message}`));
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
