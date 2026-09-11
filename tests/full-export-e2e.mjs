import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { browserPath } from './browser-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'snapline-full-export-'));
const staged = path.join(temporary, 'extension');
const artifacts = path.join(root, 'artifacts');
const baseline = process.env.SNAPLINE_BASELINE === '1';
const results = [];
let context;
let server;

try {
  await fs.mkdir(staged, { recursive: true });
  await fs.cp(path.join(root, 'extension', 'lib'), path.join(staged, 'lib'), { recursive: true });
  // Exercise serialization of isolated-world functions after release-style
  // bundling/minification as well as the actual image encoder.
  await build({ entryPoints: [path.join(root, 'extension/background.js')], outfile: path.join(staged, 'background.js'), bundle: true, minify: true, format: 'esm', target: 'chrome120', logLevel: 'silent' });
  await build({ entryPoints: [path.join(root, 'extension/lib/export.js')], outfile: path.join(staged, 'export.js'), bundle: true, minify: true, format: 'esm', target: 'chrome120', logLevel: 'silent' });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  delete manifest.icons;
  delete manifest.action.default_icon;
  await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(staged, 'index.html'), '<!doctype html><title>Full export tests</title>');
  const fixtures = await Promise.all(['full-page', 'nested-scroll'].map(async name => [name, await fs.readFile(path.join(root, 'fixtures', `${name}.html`))]));
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixtures.find(([name]) => request.url.split('?')[0] === `/${name}`)?.[1] || fixtures[0][1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath: browserPath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`, '--window-size=1280,900', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/index.html`);
  const send = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  const inspectBlob = async (bytes, type) => ui.evaluate(async ({ bytes, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const x = Math.floor(bitmap.width * .6);
    const matches = (pixel, color) => color.every((value, i) => Math.abs(value - pixel[i]) <= 8);
    const colors = { top: [180, 50, 70], middle: [60, 100, 200], bottom: [40, 180, 100] };
    const colorRows = Object.fromEntries(Object.keys(colors).map(name => [name, []]));
    const pixels = ctx.getImageData(x, 0, 1, bitmap.height).data;
    for (let y = 0; y < bitmap.height; y++) for (const [name, color] of Object.entries(colors)) {
      if (matches(pixels.subarray(y * 4, y * 4 + 4), color)) colorRows[name].push(y);
    }
    const result = { width: bitmap.width, height: bitmap.height, colors: Object.fromEntries(Object.entries(colorRows).map(([name, rows]) => [name, { count: rows.length, first: rows[0], last: rows.at(-1) }])) };
    bitmap.close(); return result;
  }, { bytes: [...bytes], type });
  const pdfImages = bytes => {
    const text = bytes.toString('latin1');
    const images = [];
    const objects = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
    for (const match of text.matchAll(objects)) {
      if (!/\/Subtype \/Image\b/.test(match[1]) || !/\/Filter \/DCTDecode\b/.test(match[1])) continue;
      const length = Number(match[1].match(/\/Length (\d+)/)?.[1]);
      const start = match.index + match[0].length;
      images.push(bytes.subarray(start, start + length));
    }
    return images;
  };

  const scenarios = [
    { name: 'full-page', width: 768, scale: 1 },
    { name: 'nested-scroll', width: 768, scale: 1 },
    { name: 'nested-scroll', width: 768, scale: 2 },
    { name: 'nested-scroll', width: 621, scale: 1 },
    { name: 'nested-scroll', width: 768, scale: 1, virtual: true },
  ];
  for (const scenario of scenarios) {
    const { name, width, scale } = scenario;
    const sourceUrl = `${baseUrl}/${name}${scenario.virtual ? '?virtual=1' : ''}`;
    const label = `${name}-${width}-${scale}x${scenario.virtual ? '-virtual' : ''}`;
    const sourcePage = await context.newPage();
    await sourcePage.goto(sourceUrl);
    if (name === 'nested-scroll') await sourcePage.evaluate(() => document.querySelector('.conversation').scrollTo({ top: 713, behavior: 'instant' }));
    const original = await sourcePage.evaluate(() => ({ scrollY, innerWidth, innerHeight, nested: document.querySelector('.conversation')?.scrollTop, nestedStyle: document.querySelector('.conversation')?.getAttribute('style') }));
    const tab = (await send({ type: 'SL_TABS' })).tabs.find(tab => tab.url === sourceUrl);
    const response = await send({ type: 'SL_CAPTURE', source: { kind: 'tab', tabId: tab.id }, options: { width, scale, scope: 'full', delay: 0, lazyLoad: false } });
    assert.equal(response.ok, true, response.error);
    const row = { name: label, capture: response.result, formats: {} }; results.push(row);
    for (const variant of ['png', 'jpeg', 'webp', 'pdf', 'pdf-long']) {
      const format = variant === 'pdf-long' ? 'pdf' : variant;
      const output = await ui.evaluate(async ({ id, format, layout }) => {
        const { getItem } = await import('./lib/store.js');
        const { encodeExport } = await import('./export.js');
        const blob = await encodeExport(await getItem(id), { format, quality: 92, layout, margin: 10 });
        return { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
      }, { id: response.result.id, format, layout: variant === 'pdf-long' ? 'long' : 'a4' });
      const bytes = Buffer.from(output.bytes);
      if (format !== 'pdf') {
        const image = await inspectBlob(bytes, output.type);
        row.formats[variant] = image;
        assert.equal(image.width, response.result.width);
        assert.equal(image.height, response.result.height);
        if (!baseline || name === 'full-page') {
          for (const color of ['top', 'middle', 'bottom']) {
            assert.ok(image.colors[color].count >= 195 * scale && image.colors[color].count <= 202 * scale, `${label} ${variant} must retain ${color} content once: ${JSON.stringify(image)}`);
          }
          assert.ok(Math.abs(image.colors.middle.first - image.colors.top.first - 1700 * scale) <= 3, 'middle marker keeps its original position');
          assert.ok(Math.abs(image.colors.bottom.first - image.colors.top.first - 3400 * scale) <= 3, 'bottom marker keeps its original position');
        }
      } else {
        const images = pdfImages(bytes);
        const pages = await Promise.all(images.map(image => inspectBlob(image, 'image/jpeg')));
        row.formats[variant] = { pageCount: (bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length, images: pages };
        assert.equal(pages.reduce((height, image) => height + image.height, 0), response.result.height, 'PDF slices cover entire original PNG height');
        if (!baseline || name === 'full-page') for (const color of ['top', 'middle', 'bottom']) {
          const count = pages.reduce((count, image) => count + image.colors[color].count, 0);
          assert.ok(count >= 194 * scale && count <= 202 * scale, `${label} ${variant} retains ${color} content once`);
        }
        assert.equal(row.formats[variant].pageCount, images.length);
        if (variant === 'pdf-long') assert.equal(images.length, 1);
      }
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(path.join(artifacts, `${baseline ? 'baseline-' : ''}${label}${variant === 'pdf-long' ? '-long' : ''}.${format === 'jpeg' ? 'jpg' : format}`), bytes);
      console.log(`PASS ${label} ${variant}: ${JSON.stringify(row.formats[variant])}`);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    const restored = await sourcePage.evaluate(() => ({ scrollY, innerWidth, innerHeight, nested: document.querySelector('.conversation')?.scrollTop, nestedStyle: document.querySelector('.conversation')?.getAttribute('style') }));
    assert.deepEqual(restored, original, 'source viewport and internal scroll position restored');
    row.restoration = { original, restored };
    await sourcePage.close();
  }
  const webpLimit = await ui.evaluate(async () => {
    const { encodeExport, planRasterExport } = await import('./export.js');
    const tests = [];
    for (const height of [16383, 16384, 20000]) {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e7ebef'; ctx.fillRect(0, 0, 64, height);
      ctx.fillStyle = '#b43246'; ctx.fillRect(0, 0, 64, 200);
      ctx.fillStyle = '#28b464'; ctx.fillRect(0, height - 200, 64, 200);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      try {
        const encoded = await encodeExport({ blob }, { format: 'webp' });
        const image = await createImageBitmap(encoded);
        const decoded = new OffscreenCanvas(image.width, image.height); const drawing = decoded.getContext('2d'); drawing.drawImage(image, 0, 0);
        const bottomPixel = [...drawing.getImageData(Math.floor(image.width / 2), image.height - 50, 1, 1).data];
        tests.push({ sourceHeight: height, width: image.width, height: image.height, type: encoded.type, plan: planRasterExport(64, height, 'webp'), bottomPixel }); image.close();
      } catch (error) { tests.push({ sourceHeight: height, error: error.message }); }
      canvas.width = canvas.height = 0;
    }
    return tests;
  });
  results.push({ name: 'WebP dimension limit', tests: webpLimit });
  for (const sample of webpLimit) {
    assert.equal(sample.error, undefined);
    assert.equal(sample.width, sample.plan.width);
    assert.equal(sample.height, sample.plan.height);
    assert.ok([40, 180, 100].every((channel, index) => Math.abs(channel - sample.bottomPixel[index]) <= 8), 'oversized WebP keeps the original bottom marker instead of cropping');
  }
  console.log('WEBP LIMIT', JSON.stringify(webpLimit));
} catch (error) {
  results.push({ name: 'failure', error: error.stack }); process.exitCode = 1; console.error(error.stack);
} finally {
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, `${baseline ? 'baseline-' : ''}full-export-e2e.json`), JSON.stringify({ at: new Date().toISOString(), baseline, results }, null, 2));
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('snapline-full-export-')) throw new Error('Unexpected test directory');
  await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
}
