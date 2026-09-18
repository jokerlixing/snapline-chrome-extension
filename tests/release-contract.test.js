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

// The Windows build used to pack the extension with PowerShell's Compress-Archive,
// which writes entry names as `snapline\app.js`. Windows extractors tolerate that,
// so the breakage was invisible locally: macOS/Linux unzip produced a flat pile of
// files literally named `snapline\app.js` and an extension Chrome could not load.
test('the extension archive uses forward slashes and UTF-8 names', async t => {
  const archive = resolve(root, `dist/Snapline-v${manifest.version}.zip`);
  if (!exists(archive)) return t.skip('尚未构建安装包，跳过归档检查');

  // Read the central directory directly: zipfile-style readers silently rewrite
  // `\` to `/` on Windows, which would hide exactly the defect under test.
  const blob = await readFile(archive);
  const signature = Buffer.from('PK\x01\x02', 'latin1');
  const names = [];
  for (let cursor = blob.indexOf(signature); cursor >= 0; cursor = blob.indexOf(signature, cursor + 4)) {
    const length = blob.readUInt16LE(cursor + 28);
    names.push(blob.subarray(cursor + 46, cursor + 46 + length).toString('utf8'));
  }

  assert.ok(names.length > 0, '安装包必须含有文件');
  const backslashed = names.filter(name => name.includes('\\'));
  assert.deepEqual(backslashed, [], `ZIP 条目名必须用正斜杠（APPNOTE 4.4.17.1），违规项：${backslashed.slice(0, 3).join('、')}`);
  assert.ok(names.every(name => name === 'snapline' || name.startsWith('snapline/')), '插件文件必须位于 snapline/ 目录下');
  assert.ok(names.includes('snapline/manifest.json'), '安装包必须包含 snapline/manifest.json');

  const chinese = names.filter(name => /[^\x00-\x7f]/.test(name));
  assert.ok(chinese.length > 0, '安装包应包含中文文档，否则无法覆盖中文名编码');
  for (const name of chinese) {
    assert.ok(/[\u4e00-\u9fff]/.test(name), `中文条目名不应出现乱码：${name}`);
  }
});

// v1.2.1 and v1.2.2 shipped with a tag but no GitHub Release, so `releases/latest`
// still pointed at v1.2.0 while README told users to download `Snapline-v1.2.2.zip`
// from that very page — a file that did not exist there. The version a reader is
// sent to download must be the version this repository is currently at.
test('README points at the archive this version actually ships', async () => {
  const readme = await read('README.md');
  const expected = `Snapline-v${manifest.version}.zip`;
  assert.ok(
    readme.includes(expected),
    `README 必须指引用户下载 ${expected}（当前版本），否则下载链接会指向不存在的文件`,
  );
  const changelog = await read('CHANGELOG.md');
  assert.ok(
    changelog.includes(`## ${manifest.version} `),
    `CHANGELOG 必须有 ${manifest.version} 的条目`,
  );
});
