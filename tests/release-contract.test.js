// Contract tests for how this repository ships: exactly one deployed website, and
// one single version number across every place that states it. Both invariants were
// violated before (two build outputs each holding a full app, and a sidebar that
// still said v1.2.0 after v1.2.1 shipped), so they are asserted rather than trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = process.cwd();
const read = path => readFile(resolve(root, path), 'utf8');
const exists = path => existsSync(resolve(root, path));
const manifest = JSON.parse(await read('extension/manifest.json'));
const packageJson = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));

test('every stated version matches the extension manifest', async () => {
  assert.equal(packageJson.version, manifest.version);
  assert.equal(lock.version, manifest.version, 'package-lock.json 顶层版本必须同步');
  assert.equal(lock.packages[''].version, manifest.version, 'package-lock.json 根包版本必须同步');
  const html = await read('extension/index.html');
  const shown = /拾页 SNAPLINE <span>v([\d.]+)<\/span>/.exec(html);
  assert.ok(shown, '工作台侧栏必须显示版本号');
  assert.equal(shown[1], manifest.version, '界面显示的版本号必须与 manifest 一致');
  const privacy = await read('docs/隐私说明.md');
  assert.match(privacy, new RegExp(`版本：${manifest.version.replace(/\./g, '\\.')}（网页版与插件版）`));
});

test('the repository deploys exactly one website', async () => {
  const workflows = await readdir(resolve(root, '.github/workflows'));
  assert.deepEqual(workflows.filter(name => name.endsWith('.yml') || name.endsWith('.yaml')), ['pages.yml'], '只允许一个工作流，避免出现第二个站点');
  const workflow = await read('.github/workflows/pages.yml');
  const uploads = [...workflow.matchAll(/path:\s*(\S+)/g)].map(match => match[1]);
  assert.deepEqual(uploads, ['dist/site'], 'Pages 只允许上传 dist/site 这一个目录');
  assert.match(workflow, /npm run build:web\b/, '部署流程只构建网页版');
  assert.doesNotMatch(workflow, /npm run build:extension|npm run build(?![:\w-])/, '部署流程不应构建插件产物');
  for (const config of ['vercel.json', 'netlify.toml', 'firebase.json', 'wrangler.toml', 'CNAME', 'public/CNAME']) {
    assert.equal(exists(config), false, `${config} 会造成第二处部署`);
  }
});

test('the deployed site and the extension package stay separate', async t => {
  if (!exists('dist/site') || !exists('dist/snapline')) return t.skip('尚未构建，跳过产物检查');
  const site = await readdir(resolve(root, 'dist/site'));
  assert.ok(site.includes('index.html'));
  for (const pluginsOnly of ['manifest.json', 'background.js', 'lib']) {
    assert.equal(site.includes(pluginsOnly), false, `dist/site 不应包含插件专属的 ${pluginsOnly}`);
  }
  const extension = await readdir(resolve(root, 'dist/snapline'));
  assert.ok(extension.includes('manifest.json'), 'dist/snapline 必须是可加载的扩展目录');
  assert.ok((await stat(resolve(root, 'dist/site/app.js'))).size > 100000, '站点需要自带已打包的应用');
});
