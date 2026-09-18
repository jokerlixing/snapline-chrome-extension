import { createIcons, ScanLine, PanelsTopLeft, History, ShieldCheck, CircleHelp, ArrowUpRight, BookOpen, Scan, FileCode2, Globe2, FolderUp, RefreshCw, Link, Info, ArrowRight, Minus, Plus, Asterisk, ArrowDownRight, Image, SlidersHorizontal, FileText, ChevronDown, Download, Trash2, Sparkles, X } from 'lucide';
import { putItem, getItem, deleteItem, listItems, pruneCaptures } from './lib/store.js';
import { packHtml, listHtmlEntries } from './lib/import-html.js';
import { encodeExport, planRasterExport, safeFilename } from './lib/export.js';
import { RELOAD_SESSION_KEY, validReloadSession } from './lib/reload-session.js';

const $ = id => document.getElementById(id);
const icons = { ScanLine, PanelsTopLeft, History, ShieldCheck, CircleHelp, ArrowUpRight, BookOpen, Scan, FileCode2, Globe2, FolderUp, RefreshCw, Link, Info, ArrowRight, Minus, Plus, Asterisk, ArrowDownRight, Image, SlidersHorizontal, FileText, ChevronDown, Download, Trash2, Sparkles, X };
const renderIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const isExtension = location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.runtime?.id);
const state = { source: 'html', format: 'png', scale: 1, files: [], entryPath: null, htmlId: null, record: null, stale: false, busy: false, capturing: false, zoom: 'fit', previewUrl: null, historyUrls: [], importWarnings: [] };
let toastTimer;
let importVersion = 0;
let tabsVersion = 0;
let initialTabId = new URLSearchParams(location.search).get('tab');
let tabSelectionCleared = false;
const ephemeralHtml = new Set();
const downloadUrls = new Map();
let preferencesReady = false;
let extensionReloading = false;
let reloadAttempted = new URLSearchParams(location.search).has('resume');
let webCaptureController = null;
const OLD_WIDTH_ERROR = '请选择原始宽度、手机、平板或桌面尺寸。';

function notify(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); $('message').hidden = !text; }
function warnings(items) { $('warning-box').replaceChildren(); const unique = [...new Set(items || [])]; $('warning-box').hidden = !unique.length; if (unique.length) { const ul = document.createElement('ul'); for (const warning of unique) { const li = document.createElement('li'); li.textContent = warning; ul.append(li); } $('warning-box').append(ul); } }
function bytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
function customWidth() {
  const raw = $('custom-width').value.trim();
  const width = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(width) || width < 200 || width > 7680) throw new Error('自定义宽度请输入 200–7680 之间的整数（px）。');
  return width;
}
function updateWidthField() { $('custom-width-field').hidden = $('width').value !== 'custom'; }
function captureOptions() { return { width: $('width').value === 'custom' ? customWidth() : Number($('width').value), scope: $('scope').value, scale: state.scale, delay: Number($('delay').value), lazyLoad: $('lazy-load').checked, transparent: $('transparent').checked }; }
function setBusy(value, capture = false) {
  state.busy = value; state.capturing = value && capture;
  for (const element of document.querySelectorAll('.source-card button, .source-card input, .source-card select, .source-card textarea, .settings-card input, .settings-card select, .settings-card button, #clear-history, #nav-history, #nav-workbench')) element.disabled = value;
  $('capture-button').disabled = (value && !capture) || (!isExtension && state.source === 'url');
  $('capture-button').querySelector('span').textContent = capture && value ? '取消生成' : '生成预览';
  $('export-button').disabled = value || !state.record || state.stale;
  $('progress-wrap').hidden = !value;
  if (value) progress(capture ? '准备生成预览…' : '正在准备文件…', 4);
}
function progress(stage, percent) { $('progress-text').textContent = stage; $('progress-bar').style.width = `${Math.min(100, Math.max(0, percent))}%`; }
function markStale() { if (!state.record) return; state.stale = true; $('preview-badge').textContent = '需要重新生成'; $('preview-badge').className = 'badge stale'; $('export-button').disabled = true; $('export-hint').textContent = '设置已改变，请重新生成预览'; }
function updateExportHint() {
  if (!state.record) { $('export-hint').textContent = '先生成预览，再保存到电脑'; return; }
  if (state.stale) { $('export-hint').textContent = '设置已改变，请重新生成预览'; return; }
  const plan = planRasterExport(state.record.width, state.record.height, state.format);
  $('export-hint').textContent = plan.scaled ? `超长网页按 WebP 格式上限等比缩小至 ${plan.width} × ${plan.height} px，保留完整内容` : '预览已就绪，可以切换格式导出';
}
function selectSource(kind, stale = true) {
  if (!isExtension && kind === 'tab') kind = 'html';
  state.source = kind;
  for (const button of document.querySelectorAll('[data-source]')) { const selected = button.dataset.source === kind; button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  for (const panel of ['tab', 'html', 'code', 'url']) $(`panel-${panel}`).hidden = kind !== panel;
  if (!state.busy) $('capture-button').disabled = !isExtension && kind === 'url';
  if (stale) markStale();
  if (kind === 'tab') refreshTabs().catch(error => message(error.message, true));
}
function selectFormat(format) {
  state.format = format;
  for (const button of document.querySelectorAll('[data-format]')) { const selected = button.dataset.format === format; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
  $('quality-field').hidden = !['jpeg', 'webp'].includes(format);
  $('pdf-fields').hidden = format !== 'pdf';
  $('export-button').querySelector('span').textContent = `导出 ${format === 'jpeg' ? 'JPG' : format === 'webp' ? 'WebP' : format.toUpperCase()}`;
  updateExportHint();
  savePreferences();
}
function selectScale(scale, stale = true) { state.scale = scale; for (const button of document.querySelectorAll('[data-scale]')) { const selected = Number(button.dataset.scale) === scale; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); } $('scale-description').textContent = { 1: '日常使用', 2: '适合分享与放大', 3: '更多细节，更大文件' }[scale]; if (stale) markStale(); savePreferences(); }
async function rpc(payload) { if (!isExtension) throw new Error('请先将拾页安装到 Chrome，再进行网页转换。点击左下方「使用帮助」查看安装步骤。'); const response = await chrome.runtime.sendMessage(payload); if (!response?.ok) throw new Error(response?.error || '插件连接中断，请刷新拾页后重试。'); return response; }
async function refreshTabs() {
  if (!isExtension) { $('tab-select').replaceChildren(new Option('安装扩展后可选择浏览器标签页', '')); return; }
  const version = ++tabsVersion;
  const previous = $('tab-select').value || (!tabSelectionCleared ? initialTabId : '');
  initialTabId = null;
  const { tabs } = await rpc({ type: 'SL_TABS' });
  if (version !== tabsVersion) return;
  $('tab-select').replaceChildren();
  if (tabSelectionCleared && tabs.length) $('tab-select').append(new Option('请选择一个已打开的网页', ''));
  for (const tab of tabs) { let host; try { host = new URL(tab.url).hostname || '本地文件'; } catch { host = ''; } $('tab-select').append(new Option(`${tab.title.slice(0, 55)} · ${host}`, String(tab.id))); }
  if (!tabs.length) $('tab-select').append(new Option('没有可转换的网页，请先打开一个网页', ''));
  if (tabs.some(tab => String(tab.id) === previous)) $('tab-select').value = previous;
  if (previous && $('tab-select').value !== previous && state.source === 'tab') markStale();
}
async function importFiles(files, entryPath) {
  if (state.busy) return;
  const version = ++importVersion;
  try {
    if (!files.length) return;
    setBusy(true);
    const entries = listHtmlEntries(files);
    if (!entries.length) throw new Error('没有找到 HTML 文件，请选择 .html / .htm 文件或包含网页的文件夹。');
    if (!entryPath) entryPath = entries.find(entry => /(^|\/)index\.html?$/i.test(entry.path))?.path || entries[0].path;
    const packed = await packHtml(files, entryPath);
    if (version !== importVersion) return;
    const id = `html-${crypto.randomUUID()}`;
    await putItem({ id, kind: 'html', title: packed.title, html: packed.html });
    ephemeralHtml.add(id);
    state.files = files;
    state.entryPath = packed.entryPath;
    $('html-entry').replaceChildren(...entries.map(entry => new Option(entry.path, entry.path)));
    $('html-entry').value = state.entryPath;
    $('entry-wrap').hidden = entries.length < 2;
    const previous = state.htmlId; state.htmlId = id;
    if (previous) { await deleteItem(previous); ephemeralHtml.delete(previous); }
    $('file-title').textContent = packed.title || packed.entryPath;
    $('file-description').textContent = `${files.length} 个文件 · ${bytes(files.reduce((n, file) => n + file.size, 0))} · 已准备好`;
    state.importWarnings = packed.warnings;
    selectSource('html');
    warnings(packed.warnings); message('文件已导入，点击「生成预览」查看效果。');
  } catch (error) { if (state.entryPath) $('html-entry').value = state.entryPath; message(error.message, true); } finally { setBusy(false); }
}
async function capture() {
  if (state.capturing) { $('capture-button').disabled = true; $('capture-button').querySelector('span').textContent = '正在取消…'; if (isExtension) await rpc({ type: 'SL_CANCEL' }).catch(error => message(error.message, true)); else webCaptureController?.abort(); return; }
  if (state.busy) return;
  let source;
  try {
    if (state.source === 'html') { if (!state.htmlId) throw new Error('请先选择一个 HTML 文件，或点击「试试示例网页」。'); source = { kind: 'html', htmlId: state.htmlId }; }
    if (state.source === 'code') { if (!$('html-code').value.trim()) throw new Error('请先粘贴一段 HTML 代码，或点击「试试示例网页」。'); source = { kind: 'code', html: $('html-code').value }; }
    if (state.source === 'tab') { if (!$('tab-select').value) throw new Error('请先选择一个已打开的网页。'); source = { kind: 'tab', tabId: Number($('tab-select').value) }; }
    if (state.source === 'url') { if (!isExtension) throw new Error('在线网站请使用拾页 Chrome 插件；网页版可导入本地 HTML 或粘贴代码。'); if (!$('url-input').value.trim()) throw new Error('请先粘贴网页链接。'); source = { kind: 'url', url: $('url-input').value.trim() }; }
    const options = captureOptions();
    setBusy(true, true); message(''); warnings([]);
    let record;
    let captureWarnings;
    if (isExtension) {
      const { result } = await rpc({ type: 'SL_CAPTURE', source, options });
      record = await getItem(result.id);
      captureWarnings = [...(state.source === 'html' ? state.importWarnings : []), ...(result.warnings || [])];
    } else {
      webCaptureController = new AbortController();
      const input = source.kind === 'code' ? await packHtml([new File([source.html], '粘贴的网页.html', { type: 'text/html' })]) : await getItem(source.htmlId);
      if (!input?.html) throw new Error('本地网页未能读取，请重新导入。');
      webCaptureController.signal.throwIfAborted();
      const { captureWebHtml } = await import('./lib/web-capture.js');
      const result = await captureWebHtml({ html: input.html, title: input.title || '我的网页' }, options, { signal: webCaptureController.signal, onProgress: ({ stage, percent }) => progress(stage, percent) });
      captureWarnings = [...(state.source === 'html' ? state.importWarnings : input.warnings || []), ...(result.warnings || [])];
      record = { id: `capture-${crypto.randomUUID()}`, kind: 'capture', title: String(result.title || input.title || '我的网页').slice(0, 240), width: result.width, height: result.height, blob: result.blob, byteSize: result.blob.size, createdAt: Date.now(), options, warnings: captureWarnings };
      await putItem(record);
      await pruneCaptures(12);
    }
    if (!record) throw new Error('本地预览未能读取，请重新生成。');
    await showRecord(record);
    warnings(captureWarnings);
    message('预览已生成。选择格式，即可保存到电脑。');
    await updateHistoryCount();
    if (reloadAttempted) { reloadAttempted = false; history.replaceState(null, '', location.pathname); }
  } catch (error) {
    if (!isExtension && (error.name === 'AbortError' || webCaptureController?.signal.aborted)) message('已取消生成，可以调整设置后重试。');
    else if (isExtension && error.message === OLD_WIDTH_ERROR && !reloadAttempted) {
      try { await reloadOldEngine(); } catch (reloadError) { message(`重新加载失败：${reloadError.message}。请在扩展管理页重新加载拾页后重试。`, true); }
    } else message(error.message === OLD_WIDTH_ERROR ? '拾页后台仍是旧版。请完整解压最新版插件，在扩展管理页重新加载后再试；网页来源已保留。' : error.message, true);
  } finally { webCaptureController = null; if (!extensionReloading) setBusy(false); }
}
async function reloadOldEngine() {
  // Only the old engine's explicit validation error triggers this path. A busy
  // worker or another capture failure must never reload other workbenches.
  reloadAttempted = true;
  setBusy(true);
  message('检测到旧版截图后台，正在重新加载拾页并恢复网页来源…');
  const id = `reload-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const selectedTab = state.source === 'tab' ? await chrome.tabs.get(Number($('tab-select').value)).catch(() => null) : null;
  const snapshot = {
    id, kind: 'reload', createdAt, source: state.source, htmlId: state.htmlId,
    files: state.files.map(file => ({ file, path: file.webkitRelativePath })), entryPath: state.entryPath,
    entries: [...$('html-entry').options].map(option => ({ text: option.text, value: option.value })),
    fileTitle: $('file-title').textContent, fileDescription: $('file-description').textContent,
    importWarnings: state.importWarnings, url: $('url-input').value, tabId: $('tab-select').value, tabUrl: selectedTab?.url,
    options: { ...captureOptions(), widthMode: $('width').value === 'custom' ? 'custom' : 'preset', customWidth: Number($('custom-width').value) || 1024 },
    format: state.format, quality: $('quality').value, pdfLayout: $('pdf-layout').value, pdfMargin: $('pdf-margin').value,
  };
  await putItem(snapshot);
  await chrome.storage.local.set({ [RELOAD_SESSION_KEY]: { id, createdAt, opened: false } });
  extensionReloading = true;
  try { chrome.runtime.reload(); } catch (error) { extensionReloading = false; throw error; }
}

async function restoreReloadSession() {
  if (!isExtension) return false;
  const values = await chrome.storage.local.get(RELOAD_SESSION_KEY);
  const pending = values[RELOAD_SESSION_KEY];
  const requested = new URLSearchParams(location.search).get('resume');
  if (!validReloadSession(pending) || (requested && pending.id !== requested)) return false;
  const snapshot = await getItem(pending.id);
  if (!snapshot || snapshot.kind !== 'reload') { await chrome.storage.local.remove(RELOAD_SESSION_KEY); return false; }
  reloadAttempted = true;
  state.htmlId = snapshot.htmlId;
  if (state.htmlId) ephemeralHtml.add(state.htmlId);
  state.files = (snapshot.files || []).map(({ file, path }) => { if (path) Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file; });
  state.entryPath = snapshot.entryPath; state.importWarnings = snapshot.importWarnings || [];
  $('html-entry').replaceChildren(...(snapshot.entries || []).map(entry => new Option(entry.text, entry.value)));
  $('html-entry').value = snapshot.entryPath || ''; $('entry-wrap').hidden = $('html-entry').options.length < 2;
  $('file-title').textContent = snapshot.fileTitle; $('file-description').textContent = snapshot.fileDescription;
  $('url-input').value = snapshot.url || ''; initialTabId = snapshot.tabId || null; tabSelectionCleared = !snapshot.tabId;
  $('tab-select').replaceChildren(new Option(snapshot.tabId ? '正在恢复标签页…' : '请选择一个已打开的网页', snapshot.tabId || ''));
  applyCaptureOptions(snapshot.options);
  selectFormat(snapshot.format); $('quality').value = snapshot.quality; $('quality-value').textContent = `${snapshot.quality}%`;
  $('pdf-layout').value = snapshot.pdfLayout; $('pdf-margin').value = snapshot.pdfMargin;
  selectSource(snapshot.source, false);
  let sourceAvailable = true;
  if (snapshot.source === 'tab') {
    await refreshTabs();
    const tab = snapshot.tabId ? await chrome.tabs.get(Number(snapshot.tabId)).catch(() => null) : null;
    sourceAvailable = $('tab-select').value === snapshot.tabId && Boolean(snapshot.tabUrl) && tab?.url === snapshot.tabUrl;
    if (!sourceAvailable) { initialTabId = null; tabSelectionCleared = true; $('tab-select').value = ''; }
  }
  await chrome.storage.local.remove(RELOAD_SESSION_KEY);
  await deleteItem(snapshot.id);
  await savePreferences();
  if (!sourceAvailable) { message('原网页已关闭或地址已改变，请重新选择标签页后生成预览。', true); return true; }
  await capture();
  return true;
}
async function showRecord(record) {
  state.record = record; state.stale = false; state.zoom = 'fit';
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(record.blob);
  const preview = $('preview-image');
  preview.src = state.previewUrl;
  await preview.decode();
  preview.hidden = false; $('empty-preview').hidden = true;
  $('preview-badge').textContent = '已就绪'; $('preview-badge').className = 'badge ready';
  $('preview-meta').textContent = `${record.width.toLocaleString()} × ${record.height.toLocaleString()} px`;
  $('preview-size').textContent = `${bytes(record.byteSize)} · 原始 PNG`;
  updateExportHint();
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) $(id).disabled = false;
  $('export-button').disabled = state.busy;
  updateZoom();
}
function stageContentWidth() {
  // clientWidth already excludes the scrollbar; subtract the real padding because
  // the narrow breakpoints use 16px instead of 24px. Reading it back keeps the
  // preview flush with the stage instead of relying on a hardcoded inset.
  const stage = $('preview-stage');
  const style = getComputedStyle(stage);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return stage.clientWidth - (Number.isFinite(padding) ? padding : 0);
}
function updateZoom() {
  const label = state.zoom === 'fit' ? '适应' : `${Math.round(state.zoom * 100)}%`;
  if ($('zoom-fit').textContent !== label) $('zoom-fit').textContent = label;
  if (!state.record) return;
  let width;
  if (state.zoom === 'fit') {
    const available = stageContentWidth();
    // The stage reports 0 while the workbench is hidden; keep the last width.
    if (available <= 0) return;
    width = Math.max(1, Math.min(state.record.width, Math.floor(available)));
  } else width = Math.round(state.record.width * state.zoom);
  const applied = `${width}px`;
  if ($('preview-image').style.width !== applied) $('preview-image').style.width = applied;
}
function changeZoom(delta) { if (!state.record) return; const available = stageContentWidth(); const current = state.zoom === 'fit' ? Math.min(1, (available > 0 ? available : state.record.width) / state.record.width) : state.zoom; state.zoom = Math.max(.1, Math.min(3, current + delta)); updateZoom(); }
async function download() {
  if (state.busy || !state.record || state.stale) return;
  try {
    setBusy(true); message('');
    const blob = await encodeExport(state.record, { format: state.format, quality: Number($('quality').value), layout: $('pdf-layout').value, margin: Number($('pdf-margin').value) });
    const url = URL.createObjectURL(blob);
    const filename = safeFilename(state.record.title, state.format);
    if (isExtension) {
      try { const id = await chrome.downloads.download({ url, filename, saveAs: true }); downloadUrls.set(id, url); }
      catch (error) { URL.revokeObjectURL(url); throw error; }
    } else { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    const plan = planRasterExport(state.record.width, state.record.height, state.format);
    message(`已创建 ${filename}（${bytes(blob.size)}${plan.scaled ? ` · ${plan.width} × ${plan.height} px，保留完整内容` : ''}），${isExtension ? '请在下载窗口选择保存位置。' : '请在浏览器下载记录中查看。'}`);
  } catch (error) { if (/canceled|cancelled/i.test(error.message)) message('已取消保存，你仍然可以重新导出。'); else message(error.message || '导出失败，请降低清晰度后重试。', true); }
  finally { setBusy(false); }
}
async function updateHistoryCount() { $('history-count').textContent = (await listItems('capture')).length; }
function setView(history) { $('workbench').hidden = history; $('history-view').hidden = !history; $('nav-workbench').classList.toggle('active', !history); $('nav-history').classList.toggle('active', history); $('page-label').textContent = history ? '最近的网页' : '转换工作台'; if (!history) requestAnimationFrame(updateZoom); }
async function showHistory() {
  setView(true); state.historyUrls.forEach(url => URL.revokeObjectURL(url)); state.historyUrls = [];
  const records = await listItems('capture'); $('history-grid').replaceChildren(); $('clear-history').disabled = !records.length;
  if (!records.length) { const empty = document.createElement('div'); empty.className = 'history-empty'; empty.innerHTML = '<i data-lucide="history"></i><p>这里还没有网页。生成第一张预览，就会自动保存在这里。</p>'; $('history-grid').append(empty); }
  for (const record of records) {
    const item = document.createElement('article'); item.className = 'history-item';
    const image = document.createElement('img'); image.className = 'history-thumb'; image.alt = record.title; image.loading = 'lazy'; image.src = URL.createObjectURL(record.blob); state.historyUrls.push(image.src);
    const content = document.createElement('div'); content.className = 'history-content';
    const title = document.createElement('h3'); title.textContent = record.title; title.title = record.title;
    const description = document.createElement('p'); description.textContent = `${record.width} × ${record.height} · ${new Date(record.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    const actions = document.createElement('div'); actions.className = 'history-actions';
    const open = document.createElement('button'); open.className = 'text-button'; open.textContent = '打开并导出 →'; open.addEventListener('click', async () => { setView(false); if (record.options) applyCaptureOptions(record.options); await showRecord(record); warnings(record.warnings); message('已打开历史预览，可以选择任意格式导出。'); });
    const remove = document.createElement('button'); remove.className = 'icon-button'; remove.setAttribute('aria-label', `删除 ${record.title}`); remove.innerHTML = '<i data-lucide="trash-2"></i>'; remove.addEventListener('click', async () => { await deleteItem(record.id); if (state.record?.id === record.id) resetPreview(); await showHistory(); await updateHistoryCount(); notify('这条记录已删除'); });
    actions.append(open, remove); content.append(title, description, actions); item.append(image, content); $('history-grid').append(item);
  }
  renderIcons();
}
function resetPreview() { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); state.record = null; state.previewUrl = null; state.stale = false; state.zoom = 'fit'; $('preview-image').removeAttribute('src'); $('preview-image').style.removeProperty('width'); $('preview-image').hidden = true; $('empty-preview').hidden = false; $('preview-stage').scrollTo(0, 0); $('zoom-fit').textContent = '适应'; $('preview-badge').textContent = '等待导入'; $('preview-badge').className = 'badge'; $('preview-meta').textContent = '完整呈现网页的每一个细节'; $('preview-size').textContent = 'PNG · JPG · WebP · PDF'; $('export-hint').textContent = '先生成预览，再保存到电脑'; $('export-button').disabled = true; for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) $(id).disabled = true; message(''); warnings([]); }
async function resetSource() {
  if (state.busy) return;
  ++importVersion; ++tabsVersion;
  initialTabId = null; tabSelectionCleared = true;
  const previous = state.htmlId;
  state.files = []; state.entryPath = null; state.htmlId = null; state.importWarnings = [];
  for (const id of ['file-input', 'folder-input', 'url-input', 'html-code']) $(id).value = '';
  $('html-entry').replaceChildren(); $('entry-wrap').hidden = true;
  $('tab-select').replaceChildren(new Option('请选择一个已打开的网页', ''));
  $('file-title').textContent = '把 HTML 文件拖到这里';
  $('file-description').textContent = '支持 .html / .htm，有配套资源时可导入整个文件夹';
  $('dropzone').classList.remove('drag-over');
  clearTimeout(toastTimer); $('toast').textContent = ''; $('toast').hidden = true;
  $('progress-wrap').hidden = true; $('progress-bar').style.width = '0%'; $('progress-text').textContent = '准备中…';
  resetPreview();
  if (previous) { ephemeralHtml.delete(previous); await deleteItem(previous).catch(() => {}); }
  if (state.source === 'tab') await refreshTabs().catch(error => message(error.message, true));
}
function applyCaptureOptions(options) {
  const width = options.width === '' || options.width == null ? NaN : Number(options.width);
  const validWidth = Number.isInteger(width) && width >= 200 && width <= 7680;
  if (validWidth && (options.widthMode === 'custom' || ![1440, 768, 390].includes(width))) { $('width').value = 'custom'; $('custom-width').value = String(width); }
  else $('width').value = [0, 1440, 768, 390].includes(width) ? String(width) : '0';
  if ($('width').value !== 'custom' && Number.isInteger(options.customWidth) && options.customWidth >= 200 && options.customWidth <= 7680) $('custom-width').value = String(options.customWidth);
  updateWidthField();
  for (const id of ['scope', 'delay']) if (options[id] !== undefined) $(id).value = String(options[id]);
  $('lazy-load').checked = options.lazyLoad !== false; $('transparent').checked = options.transparent === true;
  selectScale([1, 2, 3].includes(options.scale) ? options.scale : 1, false);
}
async function savePreferences() {
  if (!preferencesReady) return;
  let options;
  try { options = captureOptions(); } catch { return; }
  let preferredCustomWidth = 1024;
  try { preferredCustomWidth = customWidth(); } catch {}
  const preferences = { ...options, widthMode: $('width').value === 'custom' ? 'custom' : 'preset', customWidth: preferredCustomWidth, format: state.format, quality: Number($('quality').value), pdfLayout: $('pdf-layout').value, pdfMargin: $('pdf-margin').value };
  if (isExtension) await chrome.storage.local.set({ preferences }).catch(() => {});
  else { try { localStorage.setItem('snapline.preferences', JSON.stringify(preferences)); } catch {} }
}
function showHelp() { if (!$('help-dialog').open) $('help-dialog').showModal(); }
function configureWebInterface() {
  document.body.classList.add('web-mode');
  document.title = '拾页 Snapline 网页版 · HTML 转图片与 PDF';
  $('browser-notice').hidden = false;
  $('source-tab').hidden = true; $('source-code').hidden = false;
  $('extension-url-input').hidden = true; $('web-url-guide').hidden = false;
  $('width').querySelector('option[value="0"]').textContent = '使用当前窗口宽度';
  document.querySelector('.page-heading p').textContent = '本地 HTML、网页代码，一键留下完整的精彩。';
  const steps = [...document.querySelectorAll('#help-dialog .help-step')];
  document.querySelector('#help-dialog .dialog-heading h2').textContent = '拾页网页版使用说明';
  steps[0].querySelector('h3').textContent = '导入文件，或粘贴代码';
  steps[0].querySelector('p').textContent = '选择本地 HTML 文件；有配套图片或 CSS 时导入整个文件夹。也可以切换到「粘贴 HTML」，直接输入网页代码，或点击「试试示例网页」。';
  steps[1].querySelector('h3').textContent = '选好尺寸，生成预览';
  steps[1].querySelector('p').textContent = '选择完整网页或当前可见区域，设置手机、平板、桌面或自定义宽度，再点击「生成预览」。修改代码、宽度或清晰度后，需要重新生成。';
  steps[2].querySelector('h3').textContent = '下载图片与 PDF';
  steps[2].querySelector('p').textContent = '预览就绪后，可保存为 PNG、JPG、WebP 或 PDF。最近 12 次预览保存在当前浏览器中，可重新打开导出；重置来源不会删除历史记录。';
  document.querySelector('#help-dialog .help-note p').innerHTML = '在线网站、已登录网页和需要执行脚本的动态页面，请使用<a href="https://github.com/jokerlixing/snapline-chrome-extension/releases/latest" target="_blank" rel="noopener noreferrer">拾页 Chrome 插件</a>。网页版不执行导入网页的脚本；图片和样式建议随文件夹一起导入。';
}

renderIcons();
for (const button of document.querySelectorAll('[data-source]')) button.addEventListener('click', () => selectSource(button.dataset.source));
document.querySelector('.source-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const tabs = [...document.querySelectorAll('[data-source]')].filter(tab => !tab.hidden); const index = tabs.findIndex(tab => tab.dataset.source === state.source); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; selectSource(tabs[next].dataset.source); tabs[next].focus(); });
for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => selectFormat(button.dataset.format));
for (const button of document.querySelectorAll('[data-scale]')) button.addEventListener('click', () => selectScale(Number(button.dataset.scale)));
for (const id of ['width', 'scope', 'delay', 'lazy-load', 'transparent']) $(id).addEventListener('change', () => { updateWidthField(); markStale(); savePreferences(); });
$('custom-width').addEventListener('input', () => { markStale(); savePreferences(); });
for (const id of ['url-input', 'tab-select', 'html-code']) $(id).addEventListener('input', markStale);
$('tab-select').addEventListener('input', () => { tabSelectionCleared = !$('tab-select').value; });
$('quality').addEventListener('input', () => { $('quality-value').textContent = `${$('quality').value}%`; savePreferences(); });
for (const id of ['pdf-layout', 'pdf-margin']) $(id).addEventListener('change', savePreferences);
$('choose-file').addEventListener('click', () => $('file-input').click()); $('choose-folder').addEventListener('click', () => $('folder-input').click());
for (const id of ['file-input', 'folder-input']) $(id).addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); });
$('html-entry').addEventListener('change', () => importFiles(state.files, $('html-entry').value));
$('dropzone').addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) $('dropzone').classList.add('drag-over'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag-over'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); if (!state.busy) importFiles([...event.dataTransfer.files]); });
$('demo-button').addEventListener('click', async () => { const version = importVersion; try { const response = await fetch('assets/demo.html'); if (!response.ok) throw new Error('示例文件未找到，请刷新页面后重试。'); const html = await response.text(); if (version !== importVersion) return; await importFiles([new File([html], '拾页示例.html', { type: 'text/html' })]); if (state.htmlId) await capture(); } catch (error) { if (version === importVersion) message(error.message, true); } });
$('refresh-tabs').addEventListener('click', () => refreshTabs().catch(error => message(error.message, true)));
$('reset-source').addEventListener('click', resetSource);
$('capture-button').addEventListener('click', capture); $('export-button').addEventListener('click', download);
$('zoom-out').addEventListener('click', () => changeZoom(-.15)); $('zoom-in').addEventListener('click', () => changeZoom(.15)); $('zoom-fit').addEventListener('click', () => { state.zoom = 'fit'; updateZoom(); }); new ResizeObserver(updateZoom).observe($('preview-stage'));
$('nav-history').addEventListener('click', () => showHistory().catch(error => notify(error.message))); $('nav-workbench').addEventListener('click', () => setView(false));
$('clear-history').addEventListener('click', async () => { const records = await listItems('capture'); for (const record of records) await deleteItem(record.id); resetPreview(); await showHistory(); await updateHistoryCount(); notify('本机预览记录已清空'); });
for (const id of ['help-button', 'top-help', 'install-help']) $(id).addEventListener('click', showHelp); $('close-help').addEventListener('click', () => $('help-dialog').close()); $('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = $('help-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('help-dialog').close(); } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('help-dialog').open && !state.busy) { event.preventDefault(); capture(); } });
window.addEventListener('pagehide', () => { if (extensionReloading) return; for (const id of ephemeralHtml) deleteItem(id).catch(() => {}); if (state.capturing) { if (isExtension) chrome.runtime.sendMessage({ type: 'SL_CANCEL' }).catch(() => {}); else webCaptureController?.abort(); } });

async function initialize() {
  let preferences;
  if (isExtension) ({ preferences } = await chrome.storage.local.get('preferences'));
  else {
    try { preferences = JSON.parse(localStorage.getItem('snapline.preferences')); } catch {}
    configureWebInterface();
  }
  if (preferences) { applyCaptureOptions(preferences); if (['png', 'jpeg', 'webp', 'pdf'].includes(preferences.format)) selectFormat(preferences.format); $('quality').value = preferences.quality || 92; $('quality-value').textContent = `${$('quality').value}%`; if (['a4', 'letter', 'long'].includes(preferences.pdfLayout)) $('pdf-layout').value = preferences.pdfLayout; if (['0', '10', '20'].includes(preferences.pdfMargin)) $('pdf-margin').value = preferences.pdfMargin; }
  if (isExtension) {
    chrome.runtime.onMessage.addListener(message => { if (message.type === 'SL_PROGRESS' && state.capturing) progress(message.stage, message.percent); });
    chrome.downloads.onChanged.addListener(delta => { if (!downloadUrls.has(delta.id) || !delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return; URL.revokeObjectURL(downloadUrls.get(delta.id)); downloadUrls.delete(delta.id); if (delta.state.current === 'complete') notify('文件已保存到电脑'); else notify('下载已取消或中断，可以再次导出'); });
  }
  preferencesReady = true;
  if (await restoreReloadSession()) { await updateHistoryCount(); return; }
  selectSource(isExtension && new URLSearchParams(location.search).has('tab') ? 'tab' : 'html', false);
  await updateHistoryCount();
}
initialize().catch(error => message(error.message, true));
