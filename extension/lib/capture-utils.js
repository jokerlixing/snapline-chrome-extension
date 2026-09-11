export const CAPTURE_LIMITS = Object.freeze({
  maxDimension: 32760,
  maxPixels: 64_000_000,
  maxHtmlBytes: 60 * 1024 * 1024,
  maxDelay: 10000,
  minWidth: 200,
  maxWidth: 7680,
});

export function normalizeCaptureOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('截图设置无效，请重新选择。');
  const width = input.width ?? 0;
  const scale = input.scale ?? 1;
  const scope = input.scope ?? 'full';
  const delay = input.delay ?? 1000;
  if (width !== 0 && (!Number.isInteger(width) || width < CAPTURE_LIMITS.minWidth || width > CAPTURE_LIMITS.maxWidth)) throw new Error('自定义宽度请输入 200 到 7680 之间的整数像素。');
  if (![1, 2, 3].includes(scale)) throw new Error('清晰度仅支持 1×、2× 和 3×。');
  if (!['full', 'viewport'].includes(scope)) throw new Error('请选择整页或当前可见区域。');
  if (!Number.isFinite(delay) || delay < 0 || delay > CAPTURE_LIMITS.maxDelay) throw new Error('等待时间应为 0 到 10 秒。');
  return { width, scale, scope, delay: Math.round(delay), lazyLoad: input.lazyLoad !== false, transparent: input.transparent === true };
}

export function normalizeWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请先输入网页地址。');
  const text = value.trim();
  // Only add a scheme when none exists; never turn javascript: or file: into a web URL.
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error('网页地址不正确，请输入完整的网址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网址仅支持 http:// 或 https://；本地文件请从「本地 HTML」导入。');
  if (parsed.username || parsed.password) throw new Error('请使用不含账号密码的网址，登录后可从「浏览器页面」选择。');
  if (isRestrictedWebHost(parsed)) throw new Error('Chrome 应用商店不允许扩展截图，请选择其他网页。');
  return parsed.href;
}

function isRestrictedWebHost(url) {
  return url.hostname === 'chromewebstore.google.com'
    || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
}

export function isCapturableUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) && !isRestrictedWebHost(parsed);
  } catch { return false; }
}

export function calculateCaptureGeometry(metrics, options) {
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport;
  const content = metrics.cssContentSize;
  if (!viewport || !content) throw new Error('暂时无法读取页面尺寸，请等待网页加载后重试。');
  const full = options.scope === 'full';
  const width = Math.ceil(full ? content.width : viewport.clientWidth);
  const height = Math.ceil(full ? content.height : viewport.clientHeight);
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('网页尺寸为空，请检查页面内容后重试。');
  const pixelWidth = Math.ceil(width * options.scale);
  const pixelHeight = Math.ceil(height * options.scale);
  if (pixelWidth > CAPTURE_LIMITS.maxDimension || pixelHeight > CAPTURE_LIMITS.maxDimension || pixelWidth * pixelHeight > CAPTURE_LIMITS.maxPixels) {
    throw new Error(`图片尺寸过大（${pixelWidth.toLocaleString()} × ${pixelHeight.toLocaleString()} 像素）。请降低清晰度或改为「当前可见区域」；单边最多 32,760 像素，总像素最多 6,400 万。`);
  }
  return {
    clip: { x: full ? 0 : Math.max(0, viewport.pageX || 0), y: full ? 0 : Math.max(0, viewport.pageY || 0), width, height, scale: 1 },
    width: pixelWidth,
    height: pixelHeight,
  };
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > CAPTURE_LIMITS.maxHtmlBytes) throw new Error('HTML 和资源打包后超过 60 MB，请精简文件后重试。');
  const parts = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(''));
}

export function base64ToBlob(base64, mimeType = 'image/png') {
  const binary = atob(base64);
  const parts = [];
  for (let offset = 0; offset < binary.length; offset += 65536) {
    const chunk = binary.slice(offset, offset + 65536);
    parts.push(Uint8Array.from(chunk, character => character.charCodeAt(0)));
  }
  return new Blob(parts, { type: mimeType });
}

export function captureErrorMessage(error) {
  const message = error?.message || String(error);
  if (/QuotaExceeded/i.test(error?.name || '') || /quota/i.test(message)) return '本地存储空间不足，请删除几条历史记录后重试。';
  if (/another debugger|already attached|DevTools/i.test(message)) return '这个页面已打开开发者工具或被其他截图工具占用，请关闭它们后重试。';
  if (/file.*access|file.*permission|Cannot access a file/i.test(message)) return '请在 Chrome 扩展详情中开启「允许访问文件网址」，或直接导入本地 HTML。';
  if (/restricted by policy|policy.*restrict/i.test(message)) return '当前浏览器的管理策略禁止截图，请联系设备管理员。';
  if (/Cannot access|Cannot attach|not allowed/i.test(message)) return 'Chrome 不允许截取这个页面，请选择普通网页或导入 HTML。';
  if (/No tab|No target|target.*closed|tab.*closed/i.test(message)) return '原网页已关闭，请重新选择一个页面。';
  if (/not attached|Detached|canceled_by_user/i.test(message)) return '截图连接已中断。请保持原网页打开，并不要关闭 Chrome 顶部的截图连接提示。';
  if (/net::ERR_/i.test(message)) return `网页未能打开：${message.replace(/^.*?(net::ERR_)/, '$1')}。请检查网址或先在浏览器中打开它。`;
  return message || '截图失败，请稍后重试。';
}
