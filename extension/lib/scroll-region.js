// Runs in the capture isolated world. Only the selected primary scroll region
// is touched; ordinary document scrolling and small embedded panels stay intact.
export async function scrollRegion(action, options = {}) {
  const key = '__snaplineScrollRegion';
  const findRegion = () => {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    if (pageHeight > innerHeight * 1.2) return null;
    let best = null;
    let bestScore = 0;
    for (const element of document.querySelectorAll('body, body *')) {
      if (element === document.scrollingElement || element.closest('aside,nav,[role="navigation"],pre,textarea')) continue;
      if (element.scrollHeight <= element.clientHeight + 2 || element.clientHeight < Math.max(160, innerHeight * .35)) continue;
      if (!/auto|scroll|overlay/.test(getComputedStyle(element).overflowY)) continue;
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
      const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
      if (width < innerWidth * .3 || width * height < innerWidth * innerHeight * .2) continue;
      const main = element.closest('main,[role="main"]') || element.querySelector('main,[role="main"]');
      const score = width * height * (main ? 2 : 1);
      if (score > bestScore) { best = element; bestScore = score; }
    }
    return best;
  };
  if (action === 'position') {
    const element = findRegion();
    if (!element) return null;
    if (options.top !== undefined) element.scrollTo({ left: options.left, top: options.top, behavior: 'instant' });
    return { top: element.scrollTop, left: element.scrollLeft };
  }
  if (action === 'prepare') {
    globalThis[key]?.restore();
    const element = findRegion();
    if (!element) return null;
    const saved = [];
    const hadStyle = new Map();
    const position = { top: element.scrollTop, left: element.scrollLeft };
    const change = (node, property, value) => {
      if (!hadStyle.has(node)) hadStyle.set(node, node.hasAttribute('style'));
      saved.push({ node, property, value: node.style.getPropertyValue(property), priority: node.style.getPropertyPriority(property) });
      node.style.setProperty(property, value, 'important');
    };
    const state = {
      element, timer: null,
      restore() {
        clearTimeout(this.timer);
        for (const item of saved.reverse()) {
          if (item.value) item.node.style.setProperty(item.property, item.value, item.priority);
          else item.node.style.removeProperty(item.property);
        }
        for (const [node, existed] of hadStyle) {
          // Flush Chromium's pending CSSOM serialization before removing an
          // attribute we introduced; otherwise a later layout can recreate it.
          if (!existed && !node.style.length && node.getAttribute('style') !== null) node.removeAttribute('style');
        }
        element.scrollTo({ ...position, behavior: 'instant' });
        delete globalThis[key];
      },
      measure() {
        if (!element.isConnected) throw new Error('网页在截图时发生了变化');
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, rect.left + element.clientLeft);
        const y = Math.max(0, rect.top + element.clientTop);
        return { x: x + scrollX, y: y + scrollY, width: Math.min(element.clientWidth, innerWidth - x), height: Math.min(element.clientHeight, innerHeight - y), top: element.scrollTop, totalHeight: element.scrollHeight, clientHeight: element.clientHeight };
      },
    };
    globalThis[key] = state;
    // If Chrome detaches while capturing, these temporary changes still expire.
    state.timer = setTimeout(() => state.restore(), 120000);
    change(element, 'scroll-behavior', 'auto');
    change(element, 'scroll-snap-type', 'none');
    change(element, 'overflow-anchor', 'none');
    const bounds = element.getBoundingClientRect();
    for (const node of document.querySelectorAll('body *')) {
      if (node === element || node.contains(element)) continue;
      const style = getComputedStyle(node);
      const inside = element.contains(node);
      if (inside && style.position === 'sticky') {
        // Sticky headings and wrappers are document content. Keep their normal
        // flow and containing block, but prevent them repeating in later tiles.
        change(node, 'position', 'relative');
        for (const inset of ['top', 'right', 'bottom', 'left']) change(node, inset, 'auto');
        continue;
      }
      if (!['fixed', 'sticky'].includes(style.position) && !(style.position === 'absolute' && !inside)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
      // Remove small floating controls, never an entire fixed content panel.
      if (rect.height < bounds.height * .45 && (inside || rect.width > bounds.width * .35)) change(node, 'visibility', 'hidden');
    }
    return state.measure();
  }
  const state = globalThis[key];
  if (!state) throw new Error('网页在截图时发生了变化');
  if (action === 'restore') { state.restore(); return null; }
  if (action === 'scroll') {
    state.element.scrollTo({ top: options.top, left: 0, behavior: 'instant' });
    // Allow virtualized content and intersection observers to paint each tile.
    await new Promise(resolve => setTimeout(resolve, options.wait ?? 180));
    if (options.assets) {
      const bounds = state.element.getBoundingClientRect();
      const visible = [...state.element.querySelectorAll('img')].filter(image => { const rect = image.getBoundingClientRect(); return rect.bottom >= bounds.top && rect.top <= bounds.bottom; });
      await Promise.race([Promise.allSettled(visible.map(image => image.decode?.())), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
  }
  return state.measure();
}
