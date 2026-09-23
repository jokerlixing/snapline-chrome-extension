import html2canvas from 'html2canvas';
import { CAPTURE_LIMITS, normalizeCaptureOptions, calculateCaptureGeometry, captureResizeWarning } from './capture-utils.js';

const STATIC_WARNING = '网页版不会执行导入网页的脚本；动态内容请使用浏览器扩展。';
const abortError = () => new DOMException('已取消预览。', 'AbortError');

function assertActive(signal) {
  if (signal?.aborted) throw abortError();
}

function wait(milliseconds, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function abortable(promise, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
  });
}

function prepareDocument(html, options) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.title;
  const warnings = [STATIC_WARNING];
  // These removals avoid navigation and broken embedded content. The security
  // boundary is the iframe sandbox below, not HTML string sanitization.
  const embeds = doc.querySelectorAll('iframe,frame,object,embed');
  if (embeds.length) warnings.push('网页中的嵌入页面或插件内容已略过；请使用浏览器扩展截取。');
  doc.querySelectorAll('script,base,iframe,frame,object,embed,meta[http-equiv]').forEach(node => node.remove());
  for (const node of doc.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) if (attribute.name.toLowerCase().startsWith('on')) node.removeAttribute(attribute.name);
  }
  if (options.lazyLoad) for (const image of doc.images) image.loading = 'eager';
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, title, warnings };
}

function selectContent(doc, options, viewportHeight) {
  const pageHeight = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
  if (options.scope !== 'full' || pageHeight > viewportHeight * 1.2) return doc.documentElement;
  let best;
  let score = 0;
  const view = doc.defaultView;
  for (const node of doc.querySelectorAll('body,body *')) {
    if (node === doc.scrollingElement || node.closest('aside,nav,[role="navigation"],pre,textarea')) continue;
    if (node.scrollHeight <= node.clientHeight + 2 || node.clientHeight < viewportHeight * .35) continue;
    if (!/auto|scroll|overlay/.test(view.getComputedStyle(node).overflowY)) continue;
    const bounds = node.getBoundingClientRect();
    const candidate = bounds.width * bounds.height * (node.closest('main,[role="main"]') ? 2 : 1);
    if (bounds.width >= view.innerWidth * .3 && candidate > score) { best = node; score = candidate; }
  }
  if (!best) return doc.documentElement;
  const height = best.scrollHeight;
  best.style.setProperty('height', `${height}px`, 'important');
  best.style.setProperty('min-height', `${height}px`, 'important');
  best.style.setProperty('max-height', 'none', 'important');
  best.style.setProperty('overflow', 'visible', 'important');
  best.style.setProperty('flex-shrink', '0', 'important');
  best.scrollTop = 0;
  return best;
}

/** Render imported HTML locally. Imported code never runs in the site origin. */
export async function captureWebHtml(source, inputOptions = {}, { signal, onProgress } = {}) {
  assertActive(signal);
  if (typeof source?.html !== 'string' || !source.html.trim()) throw new Error('请先导入本地 HTML 文件。');
  if (new TextEncoder().encode(source.html).byteLength > CAPTURE_LIMITS.maxHtmlBytes) throw new Error('HTML 和资源超过 60 MB，请精简文件后重试。');
  const options = normalizeCaptureOptions(inputOptions);
  const width = options.width || Math.max(CAPTURE_LIMITS.minWidth, Math.min(CAPTURE_LIMITS.maxWidth, Math.round(innerWidth)));
  const height = options.width === 390 ? 844 : options.width === 768 ? 1024 : options.width === 1440 ? 900 : Math.max(200, Math.round(innerHeight));
  const prepared = prepareDocument(source.html, options);
  const warnings = [...prepared.warnings];
  const frame = document.createElement('iframe');
  // Never add allow-scripts: same-origin access is needed only by our trusted
  // html2canvas caller. Its clone lives in this ownerDocument and inherits the
  // scripting prohibition. User DOM is never inserted into the host document.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.title = '本地网页隔离预览';
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;`;
  let canvas;
  const remove = () => frame.remove();
  signal?.addEventListener('abort', remove, { once: true });
  const report = (stage, percent) => { assertActive(signal); onProgress?.({ stage, percent }); };
  try {
    report('正在安全加载本地网页', 15);
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    frame.srcdoc = prepared.html;
    document.body.append(frame);
    const timedOut = await abortable(Promise.race([loaded.then(() => false), wait(10000, signal).then(() => true)]), signal);
    if (timedOut) warnings.push('部分网页资源加载较慢，已按当前可用内容生成。');
    const doc = frame.contentDocument;
    if (!doc?.documentElement) throw new Error('本地网页无法加载，请检查 HTML 后重试。');
    report('正在加载图片和字体', 32);
    await abortable(Promise.race([
      Promise.allSettled([doc.fonts?.ready, ...[...doc.images].map(image => image.decode?.())]),
      wait(5000, signal),
    ]), signal);
    if (options.delay) { report('正在等待网页排版完成', 45); await wait(options.delay, signal); }
    assertActive(signal);
    const failedImages = [...doc.images].filter(image => !image.complete || !image.naturalWidth).length;
    if (failedImages) warnings.push(`有 ${failedImages} 张图片未加载，在线图片可能限制跨站读取；导入包含资源的完整文件夹可改善结果。`);
    const target = selectContent(doc, options, height);
    const isRoot = target === doc.documentElement;
    const contentWidth = isRoot ? Math.max(width, doc.documentElement.scrollWidth, doc.body?.scrollWidth || 0) : Math.max(target.clientWidth, target.scrollWidth);
    const contentHeight = isRoot ? Math.max(height, doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0) : Math.max(target.clientHeight, target.scrollHeight);
    const geometry = calculateCaptureGeometry({ cssVisualViewport: { clientWidth: width, clientHeight: height }, cssContentSize: { width: contentWidth, height: contentHeight } }, options);
    const resizeWarning = captureResizeWarning(geometry, options);
    if (resizeWarning) warnings.push(resizeWarning);
    report('正在生成网页预览', 65);
    // Use Chromium's own DOM renderer so gradients, alpha compositing and modern
    // colour functions are painted the same way as the extension's native page
    // screenshot. Lock the destination to sRGB so both capture paths produce the
    // same portable pixel values regardless of the monitor colour profile.
    const renderCanvas = document.createElement('canvas');
    if (!renderCanvas.getContext('2d', { colorSpace: 'srgb' })) throw new Error('浏览器无法创建标准色彩画布，请更新浏览器后重试。');
    const targetBounds = target.getBoundingClientRect();
    const render = html2canvas(target, {
      canvas: renderCanvas,
      backgroundColor: options.transparent ? null : '#ffffff',
      scale: geometry.outputScale,
      width: geometry.clip.width,
      height: geometry.clip.height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
      // Cancel the selected node's document offset for nested scroll areas.
      x: -targetBounds.left,
      y: -targetBounds.top,
      allowTaint: false,
      useCORS: true,
      imageTimeout: 5000,
      logging: false,
      removeContainer: true,
      foreignObjectRendering: true,
    });
    render.then(result => { if (signal?.aborted) { result.width = 0; result.height = 0; } }, () => {});
    canvas = await abortable(render, signal);
    assertActive(signal);
    if (canvas.width !== geometry.width || canvas.height !== geometry.height) throw new Error('图片尺寸不完整，请降低清晰度后重试。');
    report('正在保存预览', 92);
    const blob = await abortable(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), signal);
    if (!blob) throw new Error('浏览器无法生成图片，请降低清晰度后重试。');
    assertActive(signal);
    const result = { blob, width: canvas.width, height: canvas.height, title: source.title || prepared.title || '本地网页', warnings };
    report('预览已生成', 100);
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error?.name === 'SecurityError') throw new Error('部分网页资源限制读取，请导入完整资源文件夹，或使用浏览器扩展截图。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', remove);
    frame.remove();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
