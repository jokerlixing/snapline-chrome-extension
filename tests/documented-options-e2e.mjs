import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

// Exercise documented settings through the built website and inspect its real
// downloaded files. No production planner or encoder is called by this test.
const root = resolve('dist/site');
const artifacts = resolve('artifacts');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!file.startsWith(root + sep)) throw new Error('Outside site');
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 700 }, acceptDownloads: true });
const page = await context.newPage();
const report = { at: new Date().toISOString(), pdf: [], history: null, raster: [], passed: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
const pass = label => { report.passed.push(label); console.log(`PASS ${label}`); };
const closeTo = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .02, `${label}: ${actual} expected ${expected}`);
async function generate(html) {
  await page.locator('#html-code').fill(html);
  await page.locator('#capture-button').click();
  await page.waitForFunction(() => document.querySelector('#preview-badge.ready') && !document.getElementById('export-button').disabled, null, { timeout: 60000 });
}
async function download(name) {
  const pending = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const output = await pending;
  const file = join(artifacts, name);
  await output.saveAs(file);
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  return readFile(file);
}
async function inspectRaster(bytes, type) {
  return page.evaluate(async ({ bytes, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0);
    const pixels = drawing.getImageData(Math.floor(bitmap.width / 2), 0, 1, bitmap.height).data;
    let red = 0, green = 0;
    for (let y = 0; y < bitmap.height; y++) {
      const pixel = pixels.subarray(y * 4, y * 4 + 3);
      if ([180, 50, 70].every((value, i) => Math.abs(value - pixel[i]) < 9)) red++;
      if ([40, 180, 100].every((value, i) => Math.abs(value - pixel[i]) < 9)) green++;
    }
    const result = { width: bitmap.width, height: bitmap.height, red, green, corner: [...drawing.getImageData(8, 8, 1, 1).data] };
    bitmap.close(); return result;
  }, { bytes: [...bytes], type });
}
function parsePdf(bytes) {
  const text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-'));
  const objects = new Map();
  for (const match of text.matchAll(/(\d+) 0 obj\b([\s\S]*?)\nendobj/g)) {
    const body = match[2];
    const stream = /stream\r?\n/.exec(body);
    const dictionary = stream ? body.slice(0, stream.index) : body;
    let data;
    if (stream) {
      const length = Number(dictionary.match(/\/Length (\d+)/)?.[1]);
      const start = match.index + match[0].indexOf(body) + stream.index + stream[0].length;
      data = bytes.subarray(start, start + length);
      if (/\/FlateDecode\b/.test(dictionary)) data = inflateSync(data);
    }
    objects.set(Number(match[1]), { dictionary, data });
  }
  const aliases = new Map([...text.matchAll(/\/(I\d+) (\d+) 0 R/g)].map(match => [match[1], Number(match[2])]));
  return [...objects.values()].filter(object => /\/Type \/Page\b/.test(object.dictionary)).map(object => {
    const box = object.dictionary.match(/\/MediaBox \[([^\]]+)\]/)[1].trim().split(/\s+/).map(Number);
    const content = objects.get(Number(object.dictionary.match(/\/Contents (\d+) 0 R/)[1])).data.toString();
    const numbers = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
    const transform = content.match(new RegExp(`(${numbers}) 0 0 (${numbers}) (${numbers}) (${numbers}) cm\\s*/(I\\d+) Do`));
    assert.ok(transform, `Expected actual image placement in ${content}`);
    const image = objects.get(aliases.get(transform[5]));
    assert.match(image.dictionary, /\/DCTDecode\b/);
    return { box, placement: transform.slice(1, 5).map(Number), jpeg: image.data };
  });
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#source-code').click();
  await page.locator('#width').selectOption('custom');
  await page.locator('#custom-width').fill('240');
  await page.locator('.advanced summary').click();
  await page.locator('#delay').selectOption('500');
  await page.locator('[data-scale="1"]').click();
  const sample = '<!doctype html><title>PDF setting verification</title><style>html,body{margin:0}main{height:1200px;background:#eef3ff;position:relative}header{height:60px;background:rgb(180,50,70)}footer{position:absolute;bottom:0;height:60px;width:100%;background:rgb(40,180,100)}</style><main><header>START</header><footer>END</footer></main>';
  await generate(sample);
  assert.deepEqual(await page.locator('#preview-image').evaluate(image => [image.naturalWidth, image.naturalHeight]), [240, 1200]);
  await page.locator('[data-format="pdf"]').click();
  for (const layout of ['a4', 'letter', 'long']) for (const margin of [0, 10, 20]) {
    await page.locator('#pdf-layout').selectOption(layout);
    await page.locator('#pdf-margin').selectOption(String(margin));
    const bytes = await download(`documented-${layout}-${margin}mm.pdf`);
    const pages = parsePdf(bytes);
    const paperWidth = layout === 'letter' ? 215.9 : 210;
    const availableWidth = paperWidth - margin * 2;
    const paperHeight = layout === 'long' ? availableWidth * 5 + margin * 2 : layout === 'letter' ? 279.4 : 297;
    const maxRows = layout === 'long' ? 1200 : Math.floor((paperHeight - margin * 2) * 240 / availableWidth);
    assert.equal(pages.length, Math.ceil(1200 / maxRows));
    let rows = 0, red = 0, green = 0;
    const evidence = { layout, margin, bytes: bytes.length, pages: [] };
    for (const [index, pdfPage] of pages.entries()) {
      const image = await inspectRaster(pdfPage.jpeg, 'image/jpeg');
      assert.equal(image.width, 240);
      assert.equal(image.height, Math.min(maxRows, 1200 - rows));
      const mm = 25.4 / 72;
      const [imageWidth, imageHeight, left, bottom] = pdfPage.placement.map(value => value * mm);
      closeTo(pdfPage.box[2] * mm, paperWidth, 'PDF page width');
      closeTo(pdfPage.box[3] * mm, paperHeight, 'PDF page height');
      closeTo(left, margin, 'left margin');
      closeTo(imageWidth, availableWidth, 'image width');
      closeTo(imageHeight, image.height * availableWidth / 240, 'image aspect ratio');
      closeTo(paperHeight - bottom - imageHeight, margin, 'top margin');
      assert.ok(bottom >= margin - .02, 'image remains inside bottom margin');
      rows += image.height; red += image.red; green += image.green;
      evidence.pages.push({ index: index + 1, dimensionsMm: [paperWidth, paperHeight], imagePlacementMm: [left, bottom, imageWidth, imageHeight], image });
    }
    assert.equal(rows, 1200, 'PDF slices cover every source image row exactly once');
    assert.ok(Math.abs(red - 60) <= 2 && Math.abs(green - 60) <= 2, 'PDF retains both end markers');
    report.pdf.push(evidence);
    pass(`Actual PDF ${layout}, ${margin} mm: ${pages.length} pages, placement and complete content verified`);
  }

  await page.locator('#nav-history').click();
  await page.locator('#clear-history').click();
  await page.locator('#nav-workbench').click();
  for (let i = 1; i <= 13; i++) {
    const title = `History ${String(i).padStart(2, '0')}`;
    await generate(`<!doctype html><title>${title}</title><style>body{margin:0;background:#f3dddd}</style><h1>${title}</h1>`);
    assert.equal(Number(await page.locator('#history-count').innerText()), Math.min(i, 12));
  }
  await page.locator('#nav-history').click();
  const names = await page.locator('.history-content h3').allTextContents();
  const expected = Array.from({ length: 12 }, (_, i) => `History ${String(13 - i).padStart(2, '0')}`);
  assert.deepEqual(names, expected);
  await page.reload();
  await page.locator('#nav-history').click();
  assert.deepEqual(await page.locator('.history-content h3').allTextContents(), expected);
  await page.getByRole('button', { name: '删除 History 07', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 11);
  const afterDelete = await page.locator('.history-content h3').allTextContents();
  assert.deepEqual(afterDelete, expected.filter(name => name !== 'History 07'));
  assert.equal(Number(await page.locator('#history-count').innerText()), 11);
  await page.locator('#clear-history').click();
  await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 0);
  assert.equal(Number(await page.locator('#history-count').innerText()), 0);
  await page.reload();
  await page.locator('#nav-history').click();
  assert.equal(await page.locator('.history-item').count(), 0);
  report.history = { generated: 13, retained: names, afterDelete, afterClear: 0, persistedAcrossReload: true };
  pass('13 UI captures retain the newest 12; deletion and clearing persist across reload');

  await page.locator('#nav-workbench').click();
  await page.locator('#source-code').click();
  await page.locator('.advanced summary').click();
  await page.locator('#transparent').check();
  const noise = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const drawing = canvas.getContext('2d'); const pixels = drawing.createImageData(128, 128);
    let seed = 13;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i + channel] = seed & 255; }
      pixels.data[i + 3] = 255;
    }
    drawing.putImageData(pixels, 0, 0); return canvas.toDataURL();
  });
  await generate(`<!doctype html><title>Raster quality and alpha</title><style>html,body{margin:0;background:transparent}img{position:absolute;left:40px;top:40px}</style><img src="${noise}">`);
  for (const format of ['jpeg', 'webp']) {
    const sizes = {};
    await page.locator(`[data-format="${format}"]`).click();
    for (const quality of [30, 100]) {
      await page.locator('#quality').fill(String(quality));
      const bytes = await download(`documented-${format}-${quality}.${format === 'jpeg' ? 'jpg' : 'webp'}`);
      const image = await inspectRaster(bytes, `image/${format}`);
      if (format === 'webp') assert.equal(image.corner[3], 0, 'WebP keeps transparent corner');
      else assert.ok(image.corner.every(value => value >= 250), 'JPEG replaces transparent corner with white');
      sizes[quality] = bytes.length;
      report.raster.push({ format, quality, bytes: bytes.length, image });
    }
    assert.ok(sizes[100] > sizes[30], `${format} quality 100 must preserve more data on a textured sample`);
    pass(`${format} quality 30/100 changes actual download size; transparent/white background verified`);
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack, uiMessage: await page.locator('#message').innerText().catch(() => '') };
  await page.screenshot({ path: join(artifacts, 'documented-options-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'documented-options-e2e.json'), JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
