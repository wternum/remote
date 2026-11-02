const ROW = '.vela-dtb-cell, .vela-dtb-btn, .vela-dtb-item';

export function installQuantHover(root: HTMLElement): () => void {
  const touched = new Set<HTMLElement>();
  let container: HTMLElement | null = null;
  let selectedRow: HTMLElement | null = null;
  let frame = 0;
  function clear() {
    container?.removeAttribute('data-quant-hover-visible');
    selectedRow = null;
  }
  function paint(target: EventTarget | null) {
    if (!(target instanceof Element)) { clear(); return; }
    const row = target.closest<HTMLElement>(ROW);
    const next = row?.closest<HTMLElement>('.vela-dtb, .quant-drawing-menu-scroll');
    if (!row || !next || !root.contains(next) || row.matches(':disabled, .vela-open')) { clear(); return; }
    if (row === selectedRow && next.hasAttribute('data-quant-hover-visible')) return;
    if (container !== next) clear();
    const moving = next.hasAttribute('data-quant-hover-visible');
    const box = next.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    next.classList.add('quant-drawing-hover');
    next.toggleAttribute('data-quant-hover-moving', moving);
    // Account for scrolling instead of relying on the row's offsetParent.
    next.style.setProperty('--quant-hover-x', `${rect.left - box.left - next.clientLeft + next.scrollLeft}px`);
    next.style.setProperty('--quant-hover-y', `${rect.top - box.top - next.clientTop + next.scrollTop}px`);
    next.style.setProperty('--quant-hover-width', `${rect.width}px`);
    next.style.setProperty('--quant-hover-height', `${rect.height}px`);
    next.setAttribute('data-quant-hover-visible', '');
    touched.forEach(el => { if (!el.isConnected) touched.delete(el); });
    touched.add(next);
    container = next;
    selectedRow = row;
  }
  function onOver(event: PointerEvent) { if (event.pointerType !== 'touch') paint(event.target); }
  function onOut(event: PointerEvent) {
    if (!(event.relatedTarget instanceof Node) || !container?.contains(event.relatedTarget)) clear();
  }
  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      selectedRow = null;
      paint(root.querySelector('.vela-dtb-cell:hover, .vela-dtb-btn:hover, .vela-dtb-item:hover'));
    });
  }
  function onScroll(event: Event) { if (event.target === container) refresh(); }
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('click', refresh, true);
  root.addEventListener('scroll', onScroll, true);
  return () => {
    cancelAnimationFrame(frame);
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('click', refresh, true);
    root.removeEventListener('scroll', onScroll, true);
    touched.forEach(el => {
      el.classList.remove('quant-drawing-hover');
      el.removeAttribute('data-quant-hover-visible');
      el.removeAttribute('data-quant-hover-moving');
      ['x', 'y', 'width', 'height'].forEach(key => el.style.removeProperty(`--quant-hover-${key}`));
    });
    touched.clear();
  };
}