/**
 * Bundle a user-selected HTML file and its sibling assets without executing it.
 * The returned document must be opened in an isolated browser tab, never mounted
 * in an extension page. No network requests are made by this module.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_PACKED_BYTES = 60 * 1024 * 1024;

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf',
};

function normalizedPath(path) {
  const parts = [];
  for (const part of String(path).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function filePath(file) {
  return normalizedPath(file.webkitRelativePath || file.name);
}

function isExternal(reference) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference);
}

/** Resolve a local URL using POSIX paths, as browsers do inside a selected folder. */
export function resolveAssetPath(reference, basePath, rootPath = '') {
  const value = String(reference || '').trim();
  if (!value || value.startsWith('#') || isExternal(value)) return null;
  let pathname = value.split(/[?#]/, 1)[0];
  try { pathname = decodeURIComponent(pathname); } catch { /* Keep literal malformed escapes. */ }
  if (!pathname) return null;
  const base = String(basePath || '').replaceAll('\\', '/');
  const directory = base.slice(0, base.lastIndexOf('/') + 1);
  return normalizedPath(pathname.startsWith('/')
    ? `${rootPath}/${pathname.slice(1)}`
    : `${directory}${pathname}`);
}

/** HTML entry points, with index.html first and deterministic folder ordering. */
export function listHtmlEntries(files) {
  return Array.from(files || [])
    .filter(file => /\.html?$/i.test(file.name))
    .map(file => ({ path: filePath(file), name: file.name }))
    .filter(entry => entry.path)
    .sort((a, b) => {
      const first = /(?:^|\/)index\.html?$/i;
      return Number(first.test(b.path)) - Number(first.test(a.path)) || a.path.localeCompare(b.path, 'zh-CN');
    });
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  }
  return btoa(binary);
}

function textDataUrl(text, type) {
  return `data:${type};charset=utf-8;base64,${bytesToBase64(new TextEncoder().encode(text))}`;
}

function decodeCss(value) {
  return value.replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, escaped) => {
    if (!hex) return escaped;
    const point = parseInt(hex, 16);
    return point && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
  });
}

function skipQuoted(text, start) {
  const quote = text[start];
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') cursor += 2;
    else if (text[cursor++] === quote) break;
  }
  return cursor;
}

/** Tokenize URL-bearing CSS constructs, ignoring comments and ordinary strings. */
function cssReferences(css) {
  const references = [];
  let cursor = 0;
  let importPending = false;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2);
      cursor = end < 0 ? css.length : end + 2;
      continue;
    }
    if (/^@import\b/i.test(css.slice(cursor, cursor + 8))) {
      importPending = true;
      cursor += 7;
      continue;
    }
    const char = css[cursor];
    if (char === '"' || char === "'") {
      const end = skipQuoted(css, cursor);
      if (importPending) {
        references.push({ start: cursor, end, reference: decodeCss(css.slice(cursor + 1, end - 1)), isImport: true });
        importPending = false;
      }
      cursor = end;
      continue;
    }
    if ((cursor === 0 || !/[\w-]/.test(css[cursor - 1])) && /^url\s*\(/i.test(css.slice(cursor, cursor + 24))) {
      const opening = css.indexOf('(', cursor);
      let start = opening + 1;
      while (/\s/.test(css[start] || '') && start < css.length) start++;
      let end = start;
      let reference;
      if (css[start] === '"' || css[start] === "'") {
        end = skipQuoted(css, start);
        reference = css.slice(start + 1, end - 1);
        while (/\s/.test(css[end] || '') && end < css.length) end++;
      } else {
        while (end < css.length && css[end] !== ')') end += css[end] === '\\' ? 2 : 1;
        reference = css.slice(start, end).trim();
      }
      if (css[end] === ')') {
        references.push({ start: cursor, end: end + 1, reference: decodeCss(reference), isImport: importPending, isUrl: true });
        importPending = false;
        cursor = end + 1;
        continue;
      }
    }
    if (char === ';' || char === '{' || char === '}') importPending = false;
    if (importPending && !/\s/.test(char)) importPending = false;
    cursor++;
  }
  return references;
}

/** Parse srcset without splitting the comma inside a data URL. */
export function parseSrcset(value) {
  const candidates = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\s,]/.test(value[cursor] || '') && cursor < value.length) cursor++;
    const start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor])) cursor++;
    let url = value.slice(start, cursor);
    if (!url) break;
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      if (url) candidates.push({ url, descriptor: '' });
      continue;
    }
    const descriptorStart = cursor;
    let depth = 0;
    while (cursor < value.length) {
      if (value[cursor] === '(') depth++;
      if (value[cursor] === ')') depth--;
      if (!depth && value[cursor] === ',') break;
      cursor++;
    }
    candidates.push({ url, descriptor: value.slice(descriptorStart, cursor).trim() });
    cursor++;
  }
  return candidates;
}

export async function packHtml(inputFiles, requestedEntryPath) {
  const files = Array.from(inputFiles || []);
  if (!files.length) throw new Error('请先选择一个 HTML 文件，或包含 HTML 的文件夹。');
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) {
    throw new Error('文件总大小超过 25 MB。请移除无关文件或压缩图片后重试。');
  }
  const entries = listHtmlEntries(files);
  if (!entries.length) throw new Error('没有找到 HTML 文件，请选择 .html 或 .htm 文件。');
  const entryPath = requestedEntryPath ? normalizedPath(requestedEntryPath) : entries[0].path;
  if (!entries.some(entry => entry.path === entryPath)) throw new Error('找不到所选 HTML 页面，请重新选择文件。');
  if (typeof DOMParser === 'undefined') throw new Error('此功能需要在浏览器中运行。');

  const warnings = new Set();
  const fileMap = new Map();
  for (const file of files) {
    const path = filePath(file);
    if (!path) continue;
    if (fileMap.has(path)) throw new Error(`发现同名文件“${path}”，请选择整个文件夹以保留目录结构。`);
    fileMap.set(path, file);
  }
  const folderPaths = files.map(file => file.webkitRelativePath).filter(Boolean);
  const firstRoot = folderPaths[0]?.split('/')[0];
  const rootPath = folderPaths.length === files.length && folderPaths.every(path => path.startsWith(`${firstRoot}/`)) ? firstRoot : '';
  const dataCache = new Map();
  let packedBudget = 0;
  function account(value) {
    packedBudget += value.length;
    if (packedBudget > MAX_PACKED_BYTES) throw new Error('打包后的页面过大。请减少重复的大图片或精简文件后重试。');
    return value;
  }
  function warnExternal(reference) {
    if (/^(?:https?:)?\/\//i.test(reference)) warnings.add('页面包含在线图片、字体或脚本，打开及导出时需要联网；资源能否加载取决于原网站。');
    else if (/^blob:/i.test(reference)) warnings.add('页面包含临时 blob 资源，离开原页面后可能无法加载。');
  }
  function warnScript(code, module = false) {
    if (module || /\bimport\s*\(/.test(code)) warnings.add('页面使用 JavaScript 模块；相对路径 import 和动态导入不会被自动打包，建议先构建为静态页面。');
    if (/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|Worker\s*\()/.test(code)) warnings.add('页面通过脚本读取接口、文件或后台任务；这些动态请求在本地预览中可能受跨域限制。');
  }

  async function assetUrl(reference, basePath, kind = 'asset', stack = [], externalBase = null) {
    const value = reference.trim();
    if (!value || value.startsWith('#')) return reference;
    if (isExternal(value)) {
      warnExternal(value);
      if (/^file:/i.test(value)) warnings.add('页面引用了电脑上的绝对文件路径，请改为相对路径并导入完整文件夹。');
      return value.startsWith('//') ? `https:${value}` : reference;
    }
    if (externalBase) {
      try {
        const resolved = new URL(value, externalBase).href;
        warnExternal(resolved);
        return resolved;
      } catch { return reference; }
    }
    const path = resolveAssetPath(value, basePath, rootPath);
    const file = path && fileMap.get(path);
    if (!file) {
      warnings.add(`未找到本地资源：${value}（来自 ${basePath}）。请导入包含资源的完整文件夹。`);
      return reference;
    }
    const hash = value.includes('#') ? value.slice(value.indexOf('#')) : '';
    const key = `${kind}:${path}`;
    if (kind === 'css' && stack.includes(path)) {
      warnings.add(`样式表存在循环引用：${path}，已跳过重复引用。`);
      return textDataUrl('', 'text/css');
    }
    if (!dataCache.has(key)) {
      let data;
      if (kind === 'css') {
        const css = await rewriteCss(await file.text(), path, [...stack, path]);
        data = textDataUrl(css, 'text/css');
      } else if (kind === 'script') {
        const code = await file.text();
        warnScript(code);
        data = textDataUrl(code, 'text/javascript');
      } else {
        const extension = path.split('.').pop().toLowerCase();
        const mime = MIME[extension] || file.type || 'application/octet-stream';
        data = `data:${mime};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
      }
      dataCache.set(key, data);
    }
    return account(dataCache.get(key) + hash);
  }

  async function rewriteCss(css, basePath, stack = [], externalBase = null) {
    const references = cssReferences(css);
    let result = '';
    let cursor = 0;
    for (const token of references) {
      const replacement = await assetUrl(token.reference, basePath, token.isImport ? 'css' : 'asset', stack, externalBase);
      result += css.slice(cursor, token.start);
      if (replacement === token.reference) result += css.slice(token.start, token.end);
      else {
        const quoted = `"${replacement.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ')}"`;
        result += token.isUrl ? `url(${quoted})` : quoted;
      }
      cursor = token.end;
    }
    return result + css.slice(cursor);
  }

  const source = await fileMap.get(entryPath).text();
  const document = new DOMParser().parseFromString(source, 'text/html');
  const title = document.title.trim() || entries.find(entry => entry.path === entryPath).name.replace(/\.html?$/i, '');
  let contextPath = entryPath;
  let externalBase = null;
  const base = document.querySelector('base[href]');
  if (base) {
    const href = base.getAttribute('href').trim();
    if (/^(?:https?:)?\/\//i.test(href)) {
      externalBase = href.startsWith('//') ? `https:${href}` : href;
      warnExternal(externalBase);
    } else {
      const resolved = resolveAssetPath(href, entryPath, rootPath);
      if (resolved) contextPath = href.endsWith('/') ? `${resolved}/__base__.html` : resolved;
    }
    // Relative resources are resolved above; local base URLs would point at data:.
    for (const element of document.querySelectorAll('base')) element.remove();
  }

  for (const element of document.querySelectorAll('link[href]')) {
    const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = element.getAttribute('href');
    if (rel.includes('stylesheet')) {
      const packed = await assetUrl(href, contextPath, 'css', [], externalBase);
      element.setAttribute('href', packed);
      if (packed.startsWith('data:')) { element.removeAttribute('integrity'); element.removeAttribute('crossorigin'); }
    } else if (rel.some(value => ['icon', 'apple-touch-icon', 'mask-icon'].includes(value))) {
      element.setAttribute('href', await assetUrl(href, contextPath, 'asset', [], externalBase));
    } else if (rel.includes('modulepreload')) {
      warnings.add('页面使用 JavaScript 模块；相对路径 import 和动态导入不会被自动打包，建议先构建为静态页面。');
      element.remove();
    } else if (rel.includes('preload') || rel.includes('prefetch')) {
      // Resource URLs are rewritten at their point of use; stale hints duplicate requests.
      element.remove();
    }
  }
  for (const element of document.querySelectorAll('style')) element.textContent = await rewriteCss(element.textContent, contextPath, [], externalBase);
  for (const element of document.querySelectorAll('[style]')) element.setAttribute('style', await rewriteCss(element.getAttribute('style'), contextPath, [], externalBase));

  for (const script of document.querySelectorAll('script')) {
    const module = script.getAttribute('type')?.toLowerCase() === 'module';
    warnScript(script.textContent, module);
    if (script.hasAttribute('src')) {
      const src = await assetUrl(script.getAttribute('src'), contextPath, 'script', [], externalBase);
      script.setAttribute('src', src);
      if (src.startsWith('data:')) { script.removeAttribute('integrity'); script.removeAttribute('crossorigin'); }
    }
  }

  const attributes = [
    ['img[src],source[src],video[src],audio[src],track[src],input[type="image"][src],embed[src],iframe[src]', 'src'],
    ['video[poster]', 'poster'], ['object[data]', 'data'], ['image[href],use[href]', 'href'],
    ['image[xlink\\:href],use[xlink\\:href]', 'xlink:href'],
  ];
  for (const [selector, attribute] of attributes) {
    for (const element of document.querySelectorAll(selector)) {
      const reference = element.getAttribute(attribute);
      if (element.localName === 'iframe' && !isExternal(reference)) warnings.add('页面包含本地内嵌子页面，子页面内部的相对资源不会自动打包。');
      element.setAttribute(attribute, await assetUrl(reference, contextPath, 'asset', [], externalBase));
    }
  }
  for (const element of document.querySelectorAll('img[srcset],source[srcset]')) {
    const candidates = parseSrcset(element.getAttribute('srcset'));
    const packed = [];
    for (const candidate of candidates) {
      const url = await assetUrl(candidate.url, contextPath, 'asset', [], externalBase);
      packed.push(`${url}${candidate.descriptor ? ` ${candidate.descriptor}` : ''}`);
    }
    element.setAttribute('srcset', packed.join(', '));
  }
  for (const element of document.querySelectorAll('meta[http-equiv]')) {
    if (element.getAttribute('http-equiv').toLowerCase() === 'content-security-policy') {
      warnings.add('原页面的资源安全策略已移除，以便加载打包后的本地资源。');
      element.remove();
    } else if (element.getAttribute('http-equiv').toLowerCase() === 'content-type') {
      element.setAttribute('content', 'text/html; charset=utf-8');
    }
  }
  // File.text() and data URL output both use UTF-8, even if source metadata is old.
  for (const element of document.querySelectorAll('meta[charset]')) element.setAttribute('charset', 'utf-8');
  if (!document.querySelector('meta[charset]')) {
    const charset = document.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    document.head.prepend(charset);
  }
  // Keep the original rendering mode; adding a doctype changes older pages.
  const doctype = document.doctype ? `${new XMLSerializer().serializeToString(document.doctype)}\n` : '';
  const html = `${doctype}${document.documentElement.outerHTML}`;
  if (new TextEncoder().encode(html).length > MAX_PACKED_BYTES) throw new Error('打包后的页面超过 60 MB，请压缩图片后重试。');
  return { html, title, warnings: Array.from(warnings).slice(0, 100), entryPath };
}
