import { build } from 'esbuild';
import { mkdir, cp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeNotices } from './licenses.mjs';
import { createZip } from './zip.mjs';
import { html2canvasForeignObjectOriginPlugin } from './html2canvas-patch.mjs';

const out = resolve('dist/snapline');
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (out !== resolve(process.cwd(), 'dist', 'snapline')) throw new Error('Invalid build output directory.');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({ entryPoints: ['extension/app.js', 'extension/background.js'], outdir: out, bundle: true, format: 'esm', target: 'chrome120', minify: true, legalComments: 'linked', splitting: true, chunkNames: 'chunks/[name]-[hash]', logLevel: 'info', plugins: [html2canvasForeignObjectOriginPlugin] });
for (const file of ['index.html', 'styles.css', 'manifest.json']) await cp(`extension/${file}`, `${out}/${file}`);
await cp('extension/assets', `${out}/assets`, { recursive: true });
await cp('fixtures/demo.html', `${out}/assets/demo.html`);
await cp('docs/使用指南.md', `${out}/使用指南.md`);
await cp('docs/隐私说明.md', `${out}/隐私说明.md`);
await writeNotices(out);
// One name everywhere: the file this produces is the exact file uploaded as the
// Release asset and the exact name README tells users to download.
const archive = resolve(`dist/Snapline-v${manifest.version}.zip`);
const { entries } = await createZip(out, archive, { prefix: 'snapline' });
console.log(`扩展目录：${out}\n安装压缩包：${archive}（${entries} 个文件）`);
