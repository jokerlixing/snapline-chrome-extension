// Minimal, spec-compliant ZIP writer.
//
// Why not `Compress-Archive` (PowerShell) or a shell `zip`?
//  - PowerShell's Compress-Archive stores entry names with **backslashes**
//    (`snapline\app.js`). APPNOTE 4.4.17.1 requires forward slashes, and most
//    Windows extractors tolerate the violation, so the defect only shows up for
//    macOS/Linux users — who end up with a flat pile of files literally named
//    `snapline\app.js` and an extension they cannot load.
//  - It also writes non-ASCII names without the UTF-8 flag, so Chinese docs
//    inside the package arrive garbled on other platforms.
//  - `zip` is not guaranteed to exist on a Windows contributor's machine.
// Doing it here keeps every platform's archive byte-identical in structure.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

const crc32 = buffer => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};

/** MS-DOS packed date/time, as stored in the local and central headers. */
const dosStamp = date => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
});

async function collect(dir, base = dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full, base)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * Write `files` found under `sourceDir` into a ZIP at `destination`.
 *
 * @param {string} sourceDir directory whose contents become the archive body
 * @param {string} destination path of the .zip to create
 * @param {{ prefix?: string, date?: Date }} [options]
 *   prefix — top-level folder name inside the archive; defaults to the source
 *   directory's basename. date — fixed timestamp for reproducible archives.
 */
export async function createZip(sourceDir, destination, options = {}) {
  const prefix = options.prefix ?? sourceDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const paths = await collect(sourceDir);
  if (paths.length === 0) throw new Error(`没有可打包的文件：${sourceDir}`);

  const local = [];
  const central = [];
  let offset = 0;

  for (const path of paths) {
    // The whole point of this module: never let a platform separator through.
    const stored = `${prefix}/${relative(sourceDir, path).split(sep).join('/')}`;
    const name = Buffer.from(stored, 'utf8');
    const content = await readFile(path);
    const deflated = deflateRawSync(content, { level: 9 });
    // Degenerate cases (tiny or already-compressed files) can grow; store raw then.
    const useDeflate = deflated.length < content.length;
    const body = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;
    const info = await stat(path);
    const stamp = dosStamp(options.date ?? info.mtime);
    const crc = crc32(content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed to extract
    header.writeUInt16LE(0x0800, 6); // bit 11: names are UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0x81a40000, 38); // regular file, 0644
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  await writeFile(destination, Buffer.concat([...local, directory, end]));
  return { entries: paths.length, bytes: offset + directory.length + end.length };
}
