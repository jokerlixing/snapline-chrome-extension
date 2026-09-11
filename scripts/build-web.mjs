import { build } from 'esbuild';
import { mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeNotices } from './licenses.mjs';

const out = resolve('dist/site');
if (out !== resolve(process.cwd(), 'dist', 'site')) throw new Error('Invalid web build directory.');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({ entryPoints: ['extension/app.js'], outdir: out, bundle: true, format: 'esm', target: 'es2020', minify: true, splitting: true, legalComments: 'linked', chunkNames: 'chunks/[name]-[hash]', logLevel: 'info' });
for (const file of ['index.html', 'styles.css']) await cp(`extension/${file}`, `${out}/${file}`);
await cp('extension/assets', `${out}/assets`, { recursive: true });
await cp('fixtures/demo.html', `${out}/assets/demo.html`);
await cp('docs/使用指南.md', `${out}/使用指南.md`);
await cp('docs/隐私说明.md', `${out}/隐私说明.md`);
await writeFile(`${out}/.nojekyll`, '');
await writeNotices(out);
console.log(`网页版目录：${out}`);
