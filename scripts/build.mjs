import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const out = resolve('dist/snapline');
if (out !== resolve(process.cwd(), 'dist', 'snapline')) throw new Error('Invalid build output directory.');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({ entryPoints: ['extension/app.js', 'extension/background.js'], outdir: out, bundle: true, format: 'esm', target: 'chrome120', minify: true, legalComments: 'linked', splitting: true, chunkNames: 'chunks/[name]-[hash]', logLevel: 'info' });
for (const file of ['index.html', 'styles.css', 'manifest.json']) await cp(`extension/${file}`, `${out}/${file}`);
await cp('extension/assets', `${out}/assets`, { recursive: true });
await cp('fixtures/demo.html', `${out}/assets/demo.html`);
await cp('docs/使用指南.md', `${out}/使用指南.md`);
await cp('docs/隐私说明.md', `${out}/隐私说明.md`);
const licenses = [];
for (const name of ['jspdf', 'lucide', 'fflate', 'fast-png', 'iobuffer', 'pako', '@babel/runtime']) {
  try { const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')); let license = ''; for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) { try { license = await readFile(`node_modules/${name}/${file}`, 'utf8'); break; } catch {} } licenses.push(`${name} ${pkg.version}\n${license || pkg.license}\n`); } catch {}
}
await writeFile(`${out}/THIRD-PARTY-NOTICES.txt`, licenses.join('\n-------------------------\n\n'));
if (process.platform === 'win32') {
  const archive = resolve('dist/拾页-Snapline-v1.0.0.zip');
  const escape = value => `'${value.replaceAll("'", "''")}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${escape(out)} -DestinationPath ${escape(archive)} -Force`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(`扩展目录：${out}\n安装压缩包：${archive}`);
}
