// Regression cover for the reported `{"code":-32000,"message":"Unable to capture
// screenshot"}`. Chromium renders a screenshot into one compositor surface and
// refuses once either side exceeds the GPU texture limit (16384 device pixels on
// Chrome 153), so a long page or a high clarity factor used to fail with the raw
// protocol error. These pages are taller or wider than one surface and must still
// come back complete, with every band exactly where it belongs.
//
// The last check stages a copy of the extension with a larger surface budget than
// the browser really accepts, which forces the refused-request retry path that a
// GPU with a lower texture limit would hit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'snapline-surface-tests-'));
const artifacts = path.join(root, 'artifacts');
const startedAt = new Date().toISOString();
const results = [];
const BAND = 2000;
// Distinct colours only: the inspector identifies a band by its exact colour, so a
// repeated colour would make a missing or duplicated tile invisible.
const palette = [[180, 50, 70], [60, 100, 200], [40, 180, 100], [230, 190, 40], [150, 60, 190], [30, 160, 190], [200, 90, 30], [90, 90, 90], [40, 40, 40], [120, 200, 60], [210, 120, 160], [70, 60, 140], [250, 240, 200], [100, 20, 60], [20, 90, 60], [160, 160, 60]];
const stripeColor = [255, 0, 255];
const bandColor = index => {
  assert.ok(index < palette.length, `fixture needs a distinct colour for band ${index}`);
  return palette[index];
};
const bandCount = height => Math.ceil(height / BAND);
const bandSpans = (height, scale) => Array.from({ length: bandCount(height) }, (_, index) => {
  const first = index * BAND * scale;
  const last = Math.min(height, (index + 1) * BAND) * scale - 1;
  return { color: bandColor(index), first, last, count: last - first + 1 };
});
let server;

function fixture({ height, stripe = null }) {
  const bands = [];
  for (let index = 0; index < bandCount(height); index++) {
    const top = index * BAND;
    const size = Math.min(BAND, height - top);
    bands.push(`<div class="band" style="top:${top}px;height:${size}px;background:rgb(${bandColor(index).join(',')})"></div>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tall surface fixture</title><style>
  html,body{margin:0;background:rgb(5,5,5)}
  body{position:relative;height:${height}px}
  .band{position:absolute;left:0;right:0}
  .stripe{position:absolute;top:0;bottom:0;left:${stripe ? stripe.left : 0}px;width:${stripe ? stripe.width : 0}px;background:rgb(${stripeColor.join(',')})}
  </style></head><body>${bands.join('')}${stripe ? '<div class="stripe"></div>' : ''}</body></html>`;
}

async function stage(name, { refuseFirstSurface } = {}) {
  const directory = path.join(temporary, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(path.join(root, 'extension', 'lib'), path.join(directory, 'lib'), { recursive: true });
  await fs.writeFile(path.join(directory, 'background.js'), await fs.readFile(path.join(root, 'extension', 'background.js')));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  delete manifest.icons;
  delete manifest.action.default_icon;
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Surface capture tests</title>');
  if (refuseFirstSurface) {
    // Fault injection at the CDP boundary: the browser's refusal threshold differs
    // per build, so the exact `-32000` payload is thrown once where a real refusal
    // would arrive. Everything else, including the recovery, stays production code.
    const file = path.join(directory, 'background.js');
    const source = await fs.readFile(file, 'utf8');
    const call = "const shot = await command(job, 'Page.captureScreenshot', screenshotRequest(plan.tiles[0], captureBeyondViewport), 60000);";
    const patched = source.replace(call, `if (!globalThis.__snaplineInjectedRefusal) { globalThis.__snaplineInjectedRefusal = true; throw new Error('{"code":-32000,"message":"Unable to capture screenshot"}'); }\n        ${call}`);
    assert.notEqual(patched, source, 'the staged copy injects one refusal at the single-surface attempt');
    await fs.writeFile(file, patched);
  }
  return directory;
}

// One browser plus the helpers that talk to the extension it loaded.
async function session(name, staged) {
  const context = await chromium.launchPersistentContext(path.join(temporary, `profile-${name}`), {
    executablePath: browserPath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`, '--window-size=1280,900', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await ui.evaluate(() => {
    globalThis.__stages = [];
    chrome.runtime.onMessage.addListener(message => { if (message?.type === 'SL_PROGRESS') globalThis.__stages.push(message.stage); });
  });
  const send = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  return {
    context,
    send,
    stages: () => ui.evaluate(() => globalThis.__stages.splice(0, globalThis.__stages.length)),
    capture: (tabId, options = {}) => send({ type: 'SL_CAPTURE', source: { kind: 'tab', tabId }, options: { width: 0, scale: 1, scope: 'full', delay: 0, lazyLoad: false, ...options } }),
    // Reads the stored screenshot and reports the exact device-pixel span of every
    // expected band, so a missing, duplicated, or shifted tile cannot pass.
    inspect: (id, { columnX = 0, points = [], bands = true }) => ui.evaluate(async ({ id, columnX, points, bands }) => {
      const { getItem } = await import('./lib/store.js');
      const record = await getItem(id);
      const bitmap = await createImageBitmap(record.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const drawing = canvas.getContext('2d');
      drawing.drawImage(bitmap, 0, 0);
      const pixels = points.map(([x, y]) => [...drawing.getImageData(x, y, 1, 1).data]);
      let spans = null;
      if (bands) {
        const column = drawing.getImageData(columnX, 0, 1, bitmap.height).data;
        const seen = new Map();
        for (let y = 0; y < bitmap.height; y++) {
          const key = `${column[y * 4]},${column[y * 4 + 1]},${column[y * 4 + 2]}`;
          const entry = seen.get(key) ?? { first: y, last: y, count: 0 };
          entry.last = y; entry.count++;
          seen.set(key, entry);
        }
        spans = [...seen.entries()].map(([color, span]) => ({ color: color.split(',').map(Number), ...span }));
      }
      const result = { width: bitmap.width, height: bitmap.height, pixels, spans };
      bitmap.close();
      return result;
    }, { id, columnX, points, bands }),
    open: async (query, scrollTo = 0) => {
      const url = `http://127.0.0.1:${server.address().port}/tall?${query}`;
      const page = await context.newPage();
      await page.goto(url);
      if (scrollTo) {
        await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), scrollTo);
        await page.waitForTimeout(80);
      }
      const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === url);
      assert.ok(tab, 'source tab is discoverable');
      const before = await page.evaluate(() => ({ scrollY, innerWidth, innerHeight }));
      return { page, url, tabId: tab.id, before };
    },
  };
}

const test = async (name, run) => {
  if (process.env.SNAPLINE_SURFACE_FILTER && !name.includes(process.env.SNAPLINE_SURFACE_FILTER)) return;
  const start = Date.now();
  try {
    const evidence = await run();
    results.push({ name, ok: true, ms: Date.now() - start, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - start, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
  }
};

let standard;
let reduced;
try {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const height = Number(url.searchParams.get('height'));
    const stripe = url.searchParams.get('stripe');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname !== '/tall' || !Number.isFinite(height)) { response.statusCode = 404; return response.end('not found'); }
    response.end(fixture({ height, stripe: stripe ? { left: Number(stripe), width: 20 } : null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  standard = await session('standard', await stage('extension'));

  await test('a 30000px page past one surface comes back complete and unshifted', async () => {
    const { page, tabId, before } = await standard.open('height=30000');
    try {
      const response = await standard.capture(tabId, { width: 1440, scale: 1 });
      const observed = await standard.stages();
      assert.equal(response.ok, true, response.error);
      assert.deepEqual([response.result.width, response.result.height], [1440, 30000], 'the output keeps the requested size');
      const actual = await standard.inspect(response.result.id, { columnX: 700 });
      assert.deepEqual(actual.spans, bandSpans(30000, 1), 'every band occupies exactly its own rows');
      const after = await page.evaluate(() => ({ scrollY }));
      assert.equal(after.scrollY, before.scrollY, 'the source page keeps its scroll position');
      return { size: [actual.width, actual.height], bands: actual.spans.length, stages: observed };
    } finally { await page.close(); }
  });

  await test('3x clarity on a 7000px page stays complete instead of being refused', async () => {
    const { page, tabId } = await standard.open('height=7000');
    try {
      const response = await standard.capture(tabId, { width: 390, scale: 3 });
      const observed = await standard.stages();
      assert.equal(response.ok, true, response.error);
      assert.deepEqual([response.result.width, response.result.height], [390 * 3, 7000 * 3]);
      const actual = await standard.inspect(response.result.id, { columnX: 500 });
      assert.deepEqual(actual.spans, bandSpans(7000, 3), 'the 3x image scales every band exactly');
      return { size: [actual.width, actual.height], stages: observed };
    } finally { await page.close(); }
  });

  await test('a custom width wider than one surface tiles horizontally without shifting content', async () => {
    const { page, tabId } = await standard.open('height=1200&stripe=2790');
    try {
      const response = await standard.capture(tabId, { width: 5600, scale: 3 });
      const observed = await standard.stages();
      assert.equal(response.ok, true, response.error);
      assert.deepEqual([response.result.width, response.result.height], [5600 * 3, 1200 * 3]);
      // The marked stripe spans CSS 2790–2810, and at 3x the tile boundary sits at
      // device 8400, so probing 8385 and 8415 proves the two tiles line up.
      const actual = await standard.inspect(response.result.id, {
        bands: false,
        points: [[8385, 1500], [8415, 1500], [8360, 1500], [8440, 1500], [16770, 1500]],
      });
      assert.deepEqual(actual.pixels, [
        [...stripeColor, 255], [...stripeColor, 255],
        [...bandColor(0), 255], [...bandColor(0), 255],
        [...bandColor(0), 255],
      ], 'the marked stripe survives the horizontal seam and the right edge is covered');
      return { size: [actual.width, actual.height], source: { stripeLeft: 2790, width: 20 }, stages: observed };
    } finally { await page.close(); }
  });

  await test('a page that fits one surface is unchanged and restores scrolling', async () => {
    const { page, tabId, before } = await standard.open('height=6000', 1500);
    try {
      const response = await standard.capture(tabId, { width: 768, scale: 1 });
      const observed = await standard.stages();
      assert.equal(response.ok, true, response.error);
      assert.deepEqual([response.result.width, response.result.height], [768, 6000]);
      const actual = await standard.inspect(response.result.id, { columnX: 300 });
      assert.deepEqual(actual.spans, bandSpans(6000, 1), 'the whole page is present in one piece');
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({ scrollY }));
      assert.equal(before.scrollY, 1500);
      assert.equal(after.scrollY, 1500, 'the source page scroll is restored after a full-page capture');
      return { size: [actual.width, actual.height], singleSurface: !observed.some(stage => stage.includes('分段')), stages: observed };
    } finally { await page.close(); }
  });

  // A GPU whose texture limit is lower than the measured one gets its first request
  // refused. The refusal is injected at the CDP boundary because the real threshold
  // varies between browser builds, so this stays deterministic on every machine.
  reduced = await session('reduced', await stage('extension-refused-surface', { refuseFirstSurface: true }));
  await test('a refused request halves the surface budget and still returns the whole page', async () => {
    const { page, tabId, before } = await reduced.open('height=12000', 800);
    try {
      const response = await reduced.capture(tabId, { width: 1440, scale: 1 });
      const observed = await reduced.stages();
      assert.equal(response.ok, true, `the refused request recovers: ${response.error ?? ''}`);
      assert.deepEqual([response.result.width, response.result.height], [1440, 12000]);
      assert.ok(observed.some(stage => stage.includes('分段')), `the fallback stitched smaller surfaces, saw ${JSON.stringify(observed)}`);
      const actual = await reduced.inspect(response.result.id, { columnX: 700 });
      assert.deepEqual(actual.spans, bandSpans(12000, 1), 'the recovered capture is pixel complete');
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({ scrollY }));
      assert.equal(before.scrollY, 800);
      assert.equal(after.scrollY, 800, 'the source page scroll is restored after the recovered capture');
      return { size: [actual.width, actual.height], bands: actual.spans.length, stages: observed, injection: 'one -32000 refusal at the single-surface attempt' };
    } finally { await page.close(); }
  });
} catch (error) {
  results.push({ name: 'test infrastructure', ok: false, error: error.stack });
  console.error(error.stack);
} finally {
  await standard?.context.close();
  await reduced?.context.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'tall-surface-e2e.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), results }, null, 2));
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('snapline-surface-tests-')) throw new Error('Refusing to clean an unexpected test directory');
  await fs.rm(temporary, { recursive: true, force: true }).catch(error => console.warn(`Temporary browser files retained: ${error.message}`));
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
