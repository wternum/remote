import { SURFACE_CLOSE_EVENT, SURFACE_OPEN_EVENT } from '@luxalgo/vela/ui';

export function installToolbarHover(root: HTMLElement): () => void {
  let openTimer = 0;
  let closeTimer = 0;
  let hoveredOwner: HTMLElement | null = null;
  let openingFromHover = false;
  const menuOf = (owner: HTMLElement) => owner.closest('.vela-dtb')?.parentElement
    ?.querySelector<HTMLElement>(':scope > .vela-dtb-flyout:not([data-closing])');
  const inHoveredMenu = (node: EventTarget | null) => node instanceof Node && hoveredOwner
    && (hoveredOwner.contains(node) || menuOf(hoveredOwner)?.contains(node));
  const cancelOpen = () => { window.clearTimeout(openTimer); openTimer = 0; };
  const cancelClose = () => { window.clearTimeout(closeTimer); closeTimer = 0; };
  const pin = () => { cancelOpen(); cancelClose(); hoveredOwner = null; };

  function onOver(event: PointerEvent) {
    if (event.pointerType === 'touch' || event.buttons || !(event.target instanceof Element)) return;
    if (inHoveredMenu(event.target)) cancelClose();
    const cell = event.target.closest<HTMLElement>('.vela-dtb > .vela-dtb-cell');
    if (!cell || !root.contains(cell) || (event.relatedTarget instanceof Node && cell.contains(event.relatedTarget))) return;
    cancelOpen();
    const arrow = cell.querySelector<HTMLButtonElement>('.vela-dtb-arrow');
    if (!arrow || arrow.disabled || cell.classList.contains('vela-open')) return;
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      if (!cell.isConnected || cell.closest('[data-collapsed="1"]') || arrow.disabled || cell.classList.contains('vela-open')) return;
      cancelClose();
      openingFromHover = true;
      try { arrow.click(); } finally { openingFromHover = false; }
      hoveredOwner = cell.classList.contains('vela-open') ? cell : null;
    }, 150);
  }
  function onOut(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    const cell = event.target instanceof Element ? event.target.closest('.vela-dtb-cell') : null;
    if (cell && !(event.relatedTarget instanceof Node && cell.contains(event.relatedTarget))) cancelOpen();
    if (inHoveredMenu(event.relatedTarget)) { cancelClose(); return; }
    if (!inHoveredMenu(event.target)) return;
    cancelClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      const owner = hoveredOwner;
      hoveredOwner = null;
      if (owner?.classList.contains('vela-open') && !menuOf(owner)?.contains(document.activeElement)) {
        owner.querySelector<HTMLButtonElement>('.vela-dtb-arrow')?.click();
      }
    }, 220);
  }
  function onSurface(event: Event) {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('.vela-dtb-flyout')) return;
    if (event.type === SURFACE_OPEN_EVENT && !openingFromHover) pin();
    if (event.type === SURFACE_CLOSE_EVENT) { cancelClose(); hoveredOwner = null; }
  }
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('pointerdown', pin, true);
  root.addEventListener('keydown', pin, true);
  root.addEventListener(SURFACE_OPEN_EVENT, onSurface);
  root.addEventListener(SURFACE_CLOSE_EVENT, onSurface);
  return () => {
    pin();
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('pointerdown', pin, true);
    root.removeEventListener('keydown', pin, true);
    root.removeEventListener(SURFACE_OPEN_EVENT, onSurface);
    root.removeEventListener(SURFACE_CLOSE_EVENT, onSurface);
  };
}