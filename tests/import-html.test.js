import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { listHtmlEntries, resolveAssetPath, parseSrcset, MAX_IMPORT_BYTES } from '../extension/lib/import-html.js';

test('asset paths preserve folder hierarchy, decode URL names and ignore query strings', () => {
  assert.equal(resolveAssetPath('../images/a%20b.svg?v=2#mark', 'demo/css/style.css', 'demo'), 'demo/images/a b.svg');
  assert.equal(resolveAssetPath('/assets/logo.svg', 'demo/pages/index.html', 'demo'), 'demo/assets/logo.svg');
  assert.equal(resolveAssetPath('./style.css', 'index.html'), 'style.css');
  assert.equal(resolveAssetPath('../../outside.png', 'demo/index.html', 'demo'), null);
  assert.equal(resolveAssetPath('../style.css', 'demo/pages/index.html'), 'demo/style.css');
});

test('external URLs and same-document SVG fragments are not local file paths', () => {
  for (const reference of ['https://example.com/a.png', '//cdn.example.com/a.png', 'data:image/png;base64,YQ==', '#symbol', 'blob:https://example.com/abc', 'file:///C:/a.png']) {
    assert.equal(resolveAssetPath(reference, 'demo/index.html'), null);
  }
});

test('entry listing prefers index and retains relative paths', () => {
  const entries = listHtmlEntries([
    { name: 'about.html', webkitRelativePath: 'demo/about.html' },
    { name: 'style.css', webkitRelativePath: 'demo/style.css' },
    { name: 'index.HTML', webkitRelativePath: 'demo/index.HTML' },
  ]);
  assert.deepEqual(entries.map(entry => entry.path), ['demo/index.HTML', 'demo/about.html']);
});

test('srcset parser preserves descriptors and data URL commas', () => {
  assert.deepEqual(parseSrcset('small.png 320w, large.png 1024w'), [
    { url: 'small.png', descriptor: '320w' }, { url: 'large.png', descriptor: '1024w' },
  ]);
  assert.deepEqual(parseSrcset('data:image/png;base64,YQ== 1x, next.png 2x'), [
    { url: 'data:image/png;base64,YQ==', descriptor: '1x' }, { url: 'next.png', descriptor: '2x' },
  ]);
  assert.deepEqual(parseSrcset('first.png, second.png'), [
    { url: 'first.png', descriptor: '' }, { url: 'second.png', descriptor: '' },
  ]);
});

test('local HTML bundling in browser DOM', async t => {
  const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({ headless: true, ...(existsSync(windowsChrome) ? { executablePath: windowsChrome } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const source = await readFile(new URL('../extension/lib/import-html.js', import.meta.url), 'utf8');
  await page.evaluate(async source => {
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    window.importer = await import(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    window.packTestFiles = (entries, entryPath) => {
      const files = entries.map(([path, contents]) => {
        const file = new File([contents], path.split('/').pop());
        if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
        return file;
      });
      return window.importer.packHtml(files, entryPath);
    };
  }, source);

  await t.test('embeds sibling CSS, nested imports, SVG, font, JS and srcset without executing scripts', async () => {
    const result = await page.evaluate(async () => {
      const packed = await window.packTestFiles([
        ['demo/index.html', '<title>中文预览</title><link rel="stylesheet" href="css/main.css"><script src="main.js"></script><img src="logo.svg"><img srcset="logo.svg 1x, logo.svg 2x"><div style="background:url(logo.svg#shape)"></div>'],
        ['demo/css/main.css', '@import "more.css" screen; .logo { background:url(../logo.svg); } @font-face {font-family:test;src:url(../font.woff2)}'],
        ['demo/css/more.css', 'body {color:rgb(15, 25, 35)}'],
        ['demo/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path id="shape"/></svg>'],
        ['demo/font.woff2', 'font bytes'],
        ['demo/main.js', 'window.importedScriptExecuted = true;'],
      ]);
      const document = new DOMParser().parseFromString(packed.html, 'text/html');
      const css = atob(document.querySelector('link').getAttribute('href').split(',')[1]);
      return { packed, css, scriptExecuted: Boolean(window.importedScriptExecuted), image: document.querySelector('img').src, inline: document.querySelector('div').getAttribute('style') };
    });
    assert.equal(result.packed.title, '中文预览');
    assert.equal(result.scriptExecuted, false);
    assert.equal(result.packed.warnings.length, 0);
    assert.match(result.css, /@import "data:text\/css;charset=utf-8;base64,/);
    assert.match(result.css, /data:image\/svg\+xml;base64,/);
    assert.match(result.css, /data:font\/woff2;base64,/);
    assert.match(result.image, /^data:image\/svg\+xml;base64,/);
    assert.match(result.inline, /#shape/);
    assert.match(result.packed.html, /srcset="data:image\/svg\+xml;base64,[^ ]+ 1x, data:image\/svg\+xml;base64,[^ ]+ 2x"/);
  });

  await t.test('keeps external assets and reports missing files with actionable messages', async () => {
    const result = await page.evaluate(() => window.packTestFiles([
      ['page.html', '<title>Warnings</title><img src="missing.png"><img src="https://example.com/a.png"><img src="//example.com/b.png"><script type="module">import "./module.js"; fetch("api.json")</script>'],
    ]));
    assert.match(result.html, /https:\/\/example.com\/a.png/);
    assert.match(result.html, /https:\/\/example.com\/b.png/);
    assert.ok(result.warnings.some(warning => warning.includes('missing.png')));
    assert.ok(result.warnings.some(warning => warning.includes('需要联网')));
    assert.ok(result.warnings.some(warning => warning.includes('JavaScript 模块')));
    assert.ok(result.warnings.some(warning => warning.includes('动态请求')));
  });

  await t.test('CSS cycles terminate and URL text in comments and content stays untouched', async () => {
    const result = await page.evaluate(async () => {
      const packed = await window.packTestFiles([
        ['demo/index.html', '<link rel="stylesheet" href="a.css">'],
        ['demo/a.css', '@import url("b.css"); /* url(missing.png) */ .x:before{content:"url(other.png)"}'],
        ['demo/b.css', '@import "a.css"; .x{color:red}'],
      ]);
      const document = new DOMParser().parseFromString(packed.html, 'text/html');
      return { packed, css: atob(document.querySelector('link').getAttribute('href').split(',')[1]) };
    });
    assert.equal(result.packed.warnings.length, 1);
    assert.match(result.packed.warnings[0], /循环引用/);
    assert.match(result.css, /\/\* url\(missing\.png\) \*\//);
    assert.match(result.css, /content:"url\(other\.png\)"/);
  });

  await t.test('relative and root absolute base paths resolve against selected folder', async () => {
    for (const href of ['assets/', '/assets/']) {
      const result = await page.evaluate(href => window.packTestFiles([
        ['demo/index.html', `<base href="${href}"><img src="logo.svg">`],
        ['demo/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ]), href);
      assert.equal(result.warnings.length, 0);
      assert.match(result.html, /src="data:image\/svg\+xml;base64,/);
      assert.doesNotMatch(result.html, /<base/);
    }
  });

  await t.test('external base resolves assets to absolute URLs', async () => {
    const result = await page.evaluate(() => window.packTestFiles([
      ['index.html', '<base href="https://example.com/assets/"><style>.x{background:url(bg.jpg)}</style><img src="logo.svg">'],
    ]));
    assert.match(result.html, /https:\/\/example.com\/assets\/logo.svg/);
    assert.match(result.html, /https:\/\/example.com\/assets\/bg.jpg/);
  });

  await t.test('invalid entry, duplicate inputs and oversize folders fail clearly', async () => {
    const results = await page.evaluate(async max => {
      const errors = [];
      const cases = [
        () => window.packTestFiles([['x.html', 'a']], 'missing.html'),
        () => window.packTestFiles([['x.html', 'a'], ['x.html', 'b']]),
        () => window.importer.packHtml([{ name: 'big.html', size: max + 1 }]),
      ];
      for (const action of cases) { try { await action(); } catch (error) { errors.push(error.message); } }
      return errors;
    }, MAX_IMPORT_BYTES);
    assert.equal(results.length, 3);
    assert.match(results[0], /找不到/);
    assert.match(results[1], /同名文件/);
    assert.match(results[2], /25 MB/);
  });

  await t.test('the folder fixture renders styles and images, and runs JS only in its own data tab', async () => {
    const entries = await Promise.all(['index.html', 'style.css', 'tokens.css', 'script.js', 'logo.svg'].map(async name => [
      `demo-folder/${name}`, await readFile(new URL(`../fixtures/demo-folder/${name}`, import.meta.url), 'utf8'),
    ]));
    const packed = await page.evaluate(entries => window.packTestFiles(entries), entries);
    assert.equal(packed.warnings.length, 0);
    const preview = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await preview.goto(`data:text/html;base64,${Buffer.from(packed.html).toString('base64')}`);
    const actual = await preview.evaluate(() => ({
      script: document.documentElement.dataset.demoScript,
      background: getComputedStyle(document.body).backgroundColor,
      imageWidth: document.querySelector('img').naturalWidth,
      height: document.documentElement.scrollHeight,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      title: document.title,
    }));
    assert.equal(actual.script, 'loaded');
    assert.equal(actual.background, 'rgb(250, 249, 246)');
    assert.equal(actual.imageWidth, 36);
    assert.ok(actual.height > 1400, `Expected a full page fixture, got ${actual.height}px`);
    assert.equal(actual.overflow, false);
    assert.match(actual.title, /把灵感/);
    await preview.close();
  });
});
