import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserPath } from './browser-path.mjs';

const temp = await mkdtemp(join(tmpdir(), 'snapline-upgrade-'));
const oldSource = join(temp, 'old-source');
const latest = join(temp, 'latest');
const legacy = join(temp, 'legacy');
const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
await mkdir(join(oldSource, 'lib'), { recursive: true });
await cp(resolve('dist/snapline'), latest, { recursive: true });
await cp(latest, legacy, { recursive: true });
for (const file of ['app.js', 'background.js', 'lib/store.js', 'lib/import-html.js', 'lib/export.js', 'lib/capture-utils.js']) {
  await writeFile(join(oldSource, file), execFileSync('git', ['show', `b2a6a52:extension/${file}`]));
}
await build({ entryPoints: [join(oldSource, 'app.js'), join(oldSource, 'background.js')], outdir: legacy, bundle: true, format: 'esm', target: 'chrome120', minify: true, splitting: true, chunkNames: 'chunks/legacy-[name]-[hash]', nodePaths: [resolve('node_modules')] });
for (const file of ['manifest.json', 'index.html', 'styles.css']) await writeFile(join(legacy, file), execFileSync('git', ['show', `b2a6a52:extension/${file}`]));

const html = '<!doctype html><meta charset="utf-8"><title>后台升级回归</title><style>body{margin:0}main{height:1600px;background:#e7f1ff}footer{height:100px;background:#225ddd;color:#fff}</style><main>网页正文</main><footer>完整页面底部</footer>';
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const folder = join(temp, 'html-folder');
await mkdir(join(folder, 'pages'), { recursive: true });
await writeFile(join(folder, 'index.html'), html);
await writeFile(join(folder, 'pages', 'second.html'), html.replace('后台升级回归', '第二个入口'));
const passed = [];
const errors = [];
const pass = label => { passed.push(label); console.log(`PASS ${label}`); };

async function scenario(kind, { broken = false, closeTarget = false } = {}) {
  const name = `${kind}${broken ? '-broken' : ''}${closeTarget ? '-closed' : ''}`;
  const live = join(temp, name, 'extension');
  await cp(legacy, live, { recursive: true });
  const context = await chromium.launchPersistentContext(join(temp, name, 'profile'), { executablePath: browserPath(), headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${live}`, `--load-extension=${live}`, '--no-first-run'] });
  let ui;
  let reloads = 0;
  let target;
  try {
    // Unpacked installations require developer mode to remain enabled during
    // runtime.reload; a command-line load alone bypasses only the initial check.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions');
    await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await manager.close();
    await context.exposeBinding('beforeTestReload', async () => { reloads++; if (closeTarget && target && !target.isClosed()) await target.close(); });
    await context.addInitScript(() => {
      if (!globalThis.chrome?.runtime?.reload) return;
      const reload = chrome.runtime.reload.bind(chrome.runtime);
      chrome.runtime.reload = () => { globalThis.beforeTestReload().then(() => reload()); };
    });
    context.on('page', page => page.on('pageerror', error => errors.push(`${name}: ${error.message}`)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const first = await context.newPage(); await first.goto(`${url}/first`);
    target = await context.newPage(); await target.goto(`${url}/target`);
    const targetId = await worker.evaluate(async address => (await chrome.tabs.query({})).find(tab => tab.url === address).id, `${url}/target`);
    ui = await context.newPage(); await ui.goto(`chrome-extension://${id}/index.html`);
    const original = await ui.evaluate(address => chrome.runtime.sendMessage({ type: 'SL_CAPTURE', source: { kind: 'url', url: address }, options: { width: 390, scale: 1, scope: 'full', delay: 0, lazyLoad: false } }), `${url}/seed`);
    assert.equal(original.ok, true);
    await cp(latest, live, { recursive: true });
    if (broken) {
      // A deliberately incomplete upgrade: current restart support paired with
      // the legacy width validator. It must stop after one recovery attempt.
      await build({ entryPoints: [resolve('extension/background.js')], outfile: join(live, 'background.js'), bundle: true, format: 'esm', target: 'chrome120', minify: true, plugins: [{ name: 'legacy-validator', setup(builder) { builder.onLoad({ filter: /capture-utils\.js$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/^  if \(width !== 0.*$/m, "  if (![0, 390, 768, 1440].includes(width)) throw new Error('请选择原始宽度、手机、平板或桌面尺寸。');"), loader: 'js' })); } }] });
    }
    await ui.reload();
    await ui.locator('#width option[value=custom]').waitFor({ state: 'attached' });
    assert.equal(await ui.evaluate(() => chrome.runtime.getManifest().version), '1.0.0');
    const rejection = await ui.evaluate(address => chrome.runtime.sendMessage({ type: 'SL_CAPTURE', source: { kind: 'url', url: address }, options: { width: 1024 } }), `${url}/target`);
    assert.equal(rejection.error, '请选择原始宽度、手机、平板或桌面尺寸。');
    await ui.locator(`#source-${kind}`).click();
    if (kind === 'url') await ui.locator('#url-input').fill(`${url}/target`);
    if (kind === 'html') { await ui.locator('#folder-input').setInputFiles(folder); await ui.locator('#file-description').filter({ hasText: '已准备好' }).waitFor(); }
    if (kind === 'tab') { await ui.locator('#tab-select').selectOption(String(targetId)); assert.notEqual(await ui.locator('#tab-select option').first().getAttribute('value'), String(targetId)); }
    await ui.locator('#width').selectOption('custom');
    await ui.locator('#custom-width').fill('1024');
    await ui.locator('[data-format=webp]').click();
    await ui.locator('#quality').fill('73');
    await ui.locator('[data-format=pdf]').click();
    await ui.locator('#pdf-layout').selectOption('long');
    await ui.locator('#pdf-margin').selectOption('20');
    await ui.locator('[data-format=webp]').click();
    const replacement = context.waitForEvent('page', { timeout: 20000 });
    await ui.locator('#capture-button').click();
    ui = await replacement;
    await ui.waitForLoadState();
    if (broken || closeTarget) {
      await ui.locator('#message.error').filter({ hasText: broken ? '后台仍是旧版' : '原网页已关闭' }).waitFor({ timeout: 30000 });
      assert.equal(await ui.locator('#export-button').isDisabled(), true);
      if (closeTarget) assert.equal(await ui.locator('#tab-select').inputValue(), '');
      if (broken) { await ui.locator('#capture-button').click(); await ui.locator('#message.error').filter({ hasText: '后台仍是旧版' }).waitFor(); }
      assert.equal(reloads, 1);
      assert.equal(await ui.locator('#history-count').innerText(), '1');
      pass(broken ? '不完整升级仅恢复一次并给出更新提示，不陷入重载循环' : '恢复前原标签页关闭时停止自动截图，不误拍列表第一项');
    } else {
      await ui.waitForFunction(() => document.querySelector('#preview-badge.ready') && !document.getElementById('export-button').disabled, null, { timeout: 120000 });
      assert.equal(await ui.locator('#preview-image').evaluate(image => image.naturalWidth), 1024);
      assert.equal(await ui.locator(`#source-${kind}`).getAttribute('aria-selected'), 'true');
      assert.equal(await ui.locator('#custom-width').inputValue(), '1024');
      assert.equal(await ui.locator('#quality').inputValue(), '73');
      assert.equal(await ui.locator('#pdf-layout').inputValue(), 'long');
      assert.equal(await ui.locator('#pdf-margin').inputValue(), '20');
      assert.equal(await ui.locator('[data-format=webp]').getAttribute('aria-pressed'), 'true');
      assert.equal(await ui.locator('#history-count').innerText(), '2');
      assert.equal(reloads, 1);
      assert.equal(new URL(ui.url()).search, '');
      assert.equal(await ui.evaluate(async () => (await chrome.storage.local.get('snaplinePendingReload')).snaplinePendingReload), undefined);
      if (kind === 'url') assert.equal(await ui.locator('#url-input').inputValue(), `${url}/target`);
      if (kind === 'tab') assert.equal(await ui.locator('#tab-select').inputValue(), String(targetId));
      if (kind === 'html') {
        assert.equal(await ui.locator('#html-entry option').count(), 2);
        const second = await ui.locator('#html-entry option').allTextContents();
        await ui.locator('#html-entry').selectOption(second.find(value => value.includes('second.html')));
        await ui.locator('#file-title').filter({ hasText: '第二个入口' }).waitFor();
        await ui.waitForFunction(() => !document.getElementById('capture-button').disabled);
        await ui.locator('#capture-button').click();
        await ui.waitForFunction(() => !document.getElementById('export-button').disabled, null, { timeout: 120000 });
      }
      pass(`旧版后台+新版工作台 ${kind} 来源自动升级，1024px预览成功，来源/设置/历史保留`);
    }
  } catch (error) {
    console.error('UPGRADE STATE', name, { reloads, pages: context.pages().map(page => page.url()), workers: context.serviceWorkers().map(worker => worker.url()), errors });
    if (ui && !ui.isClosed()) console.error('PENDING', await ui.evaluate(async () => ({ pending: await chrome.storage.local.get('snaplinePendingReload'), runtime: chrome.runtime.getManifest().version })).catch(error => error.message));
    if (ui && !ui.isClosed()) { console.error(name, await ui.locator('#message').innerText().catch(() => '')); await ui.screenshot({ path: join(artifacts, `upgrade-${name}-failure.png`), fullPage: true }).catch(() => {}); }
    throw error;
  } finally { await context.close(); }
}

try {
  await scenario('url');
  await scenario('html');
  await scenario('tab');
  await scenario('tab', { closeTarget: true });
  await scenario('url', { broken: true });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(artifacts, 'upgrade-e2e-results.json'), JSON.stringify({ passed, errors, at: new Date().toISOString() }, null, 2));
  await new Promise(resolve => server.close(resolve));
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('snapline-upgrade-')) throw new Error('Invalid upgrade test path');
  await rm(temp, { recursive: true, force: true });
}
