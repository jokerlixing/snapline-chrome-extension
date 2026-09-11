import { cp, readFile, readdir, writeFile } from 'node:fs/promises';

export async function writeNotices(out) {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const notices = [];
  for (const [directory, entry] of Object.entries(lock.packages || {})) {
    if (!directory.startsWith('node_modules/') || entry.dev) continue;
    const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
    const names = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
    const texts = await Promise.all(names.map(async name => `${name}\n${await readFile(`${directory}/${name}`, 'utf8')}`));
    notices.push(`${pkg.name} ${pkg.version}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${texts.join('\n\n')}`);
  }
  await writeFile(`${out}/THIRD-PARTY-NOTICES.txt`, notices.join('\n\n-------------------------\n\n'));
  await cp('LICENSE', `${out}/LICENSE.txt`);
}
