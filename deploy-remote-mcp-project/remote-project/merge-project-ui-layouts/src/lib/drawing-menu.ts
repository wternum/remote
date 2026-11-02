import { SURFACE_CLOSE_EVENT, SURFACE_OPEN_EVENT, type SurfaceEventDetail } from '@luxalgo/vela/ui';

const SVG_NS = 'http://www.w3.org/2000/svg';
interface Section {
  title: string;
  heading: HTMLElement | null;
  count: HTMLElement | null;
  rows: HTMLButtonElement[];
}
interface MenuState {
  owner: HTMLElement | null;
  update: () => void;
  dispose: (restore?: boolean) => void;
}

export function enhanceDrawingMenus(host: HTMLElement): () => void {
  const menus = new Map<HTMLElement, MenuState>();
  let disposed = false;

  function enhance(fly: HTMLElement, trigger: HTMLElement | null) {
    if (disposed) return;
    menus.get(fly)?.dispose();
    const original = Array.from(fly.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
    if (!original.some(el => el.matches('.vela-dtb-item'))) return;
    const parent = fly.parentElement;
    if (!parent) return;
    const rail = parent.querySelector<HTMLElement>(':scope > .vela-dtb');
    const owner = trigger?.closest<HTMLElement>('.vela-dtb-cell')
      ?? rail?.querySelector<HTMLElement>('.vela-dtb-cell.vela-open') ?? null;
    const arrow = owner?.querySelector<HTMLButtonElement>('.vela-dtb-arrow');
    const originalStyles = {
      left: fly.style.left, top: fly.style.top, maxHeight: fly.style.maxHeight,
      minWidth: fly.style.minWidth, maxWidth: fly.style.maxWidth,
    };
    let active = true;
    let frame = 0;
    const sections: Section[] = [];
    const hints: { el: HTMLElement; text: string; label: string | null }[] = [];
    const icons: HTMLElement[] = [];
    const scroll = document.createElement('div');
    scroll.className = 'quant-drawing-menu-scroll';
    scroll.setAttribute('aria-label', '绘图工具');
    let section: Section | undefined;

    for (const el of original) {
      if (el instanceof HTMLButtonElement && el.matches('.vela-dtb-item')) {
        if (!section) {
          section = { title: '', heading: null, count: null, rows: [] };
          sections.push(section);
        }
        section.rows.push(el);
        const icon = el.querySelector<HTMLElement>(':scope > .vela-dtb-badge');
        if (icon?.querySelector('svg')) {
          icon.classList.add('quant-drawing-menu-icon');
          icons.push(icon);
        }
        const hint = el.querySelector<HTMLElement>('.vela-dtb-hint');
        if (hint?.textContent) {
          const text = hint.textContent;
          hints.push({ el: hint, text, label: hint.getAttribute('aria-label') });
          const keys = text.match(/[\u2318\u2325\u21e7\u2303]|[^\u2318\u2325\u21e7\u2303+\s]+/gu) ?? [text];
          hint.setAttribute('aria-label', keys.join(' + '));
          hint.replaceChildren(...keys.map(key => {
            const kbd = document.createElement('kbd');
            kbd.textContent = key;
            kbd.setAttribute('aria-hidden', 'true');
            return kbd;
          }));
        }
      } else if (el.textContent?.trim()) {
        const title = el.textContent.trim();
        const label = document.createElement('span');
        label.textContent = title;
        const line = document.createElement('span');
        line.className = 'quant-drawing-section-line';
        line.setAttribute('aria-hidden', 'true');
        const count = document.createElement('span');
        count.className = 'quant-drawing-section-count';
        el.classList.add('quant-drawing-section');
        el.replaceChildren(label, line, count);
        section = { title, heading: el, count, rows: [] };
        sections.push(section);
      } else {
        el.classList.add('quant-drawing-section-separator');
      }
      scroll.append(el);
    }

    const rows = sections.flatMap(group => group.rows);
    const search = document.createElement('div');
    search.className = 'quant-drawing-menu-search';
    search.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
    const input = document.createElement('input');
    input.type = 'search';
    input.size = 1;
    input.placeholder = '搜索工具...';
    input.setAttribute('aria-label', '搜索绘图工具');
    input.autocomplete = 'off';
    input.spellcheck = false;
    search.append(input);
    const footer = document.createElement('div');
    footer.className = 'quant-drawing-menu-footer';
    footer.setAttribute('role', 'status');
    footer.textContent = `${rows.length} 个工具`;
    sections.forEach(group => {
      if (group.count) group.count.textContent = String(group.rows.length);
    });

    const outline = document.createElementNS(SVG_NS, 'svg');
    outline.classList.add('quant-drawing-menu-outline');
    outline.setAttribute('aria-hidden', 'true');
    const fill = document.createElementNS(SVG_NS, 'path');
    fill.classList.add('quant-drawing-menu-fill');
    const edge = document.createElementNS(SVG_NS, 'path');
    edge.classList.add('quant-drawing-menu-edge');
    outline.append(fill, edge);
    fly.classList.add('quant-drawing-menu');
    fly.replaceChildren(outline, search, scroll, footer);
    arrow?.setAttribute('aria-expanded', 'true');

    // Measure before filtering so shorter results cannot shrink the menu.
    const naturalWidth = fly.getBoundingClientRect().width;
    fly.style.minWidth = `${naturalWidth}px`;
    const write = (property: 'left' | 'top' | 'maxWidth' | 'minWidth' | 'maxHeight', value: number) => {
      const px = `${value}px`;
      if (fly.style[property] !== px) fly.style[property] = px;
    };

    function update() {
      if (!active || !fly.isConnected || fly.hasAttribute('data-closing')) return;
      const bounds = parent!.getBoundingClientRect();
      const railBounds = rail?.getBoundingClientRect();
      const ownerBounds = owner?.getBoundingClientRect();
      const left = railBounds ? railBounds.right - bounds.left - 1 : parseFloat(originalStyles.left) || 0;
      // The native drawing layer is only rail-wide; the workspace is the horizontal boundary.
      const availableWidth = Math.max(1, Math.min(host.getBoundingClientRect().right, window.innerWidth) - bounds.left - left - 8);
      write('left', left);
      write('maxWidth', availableWidth);
      write('minWidth', Math.min(naturalWidth, availableWidth));
      const anchorTop = ownerBounds ? ownerBounds.top - bounds.top : parseFloat(originalStyles.top) || 0;
      // Low groups remain usable without extending outside a short chart.
      const top = Math.max(16, Math.min(anchorTop, bounds.height - 156));
      write('top', top);
      write('maxHeight', Math.max(80, bounds.height - top - 16));

      const { width, height } = fly.getBoundingClientRect();
      // Both ends return to the rail edge, rather than forming a detached card.
      const path = `M 0.5 0 Q 0.5 16.5 16.5 16.5 H ${width - 10.5} Q ${width - 0.5} 16.5 ${width - 0.5} 26.5 V ${height + 5.5} Q ${width - 0.5} ${height + 15.5} ${width - 10.5} ${height + 15.5} H 16.5 Q 0.5 ${height + 15.5} 0.5 ${height + 32}`;
      const viewBox = `0 0 ${width} ${height + 32}`;
      if (outline.getAttribute('viewBox') !== viewBox) outline.setAttribute('viewBox', viewBox);
      if (edge.getAttribute('d') !== path) {
        edge.setAttribute('d', path);
        fill.setAttribute('d', `${path} H 0 V 0 Z`);
      }
    }

    function schedule() {
      if (frame || !active) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    }
    function filter() {
      const query = input.value.trim().toLocaleLowerCase();
      let total = 0;
      for (const group of sections) {
        let visible = 0;
        for (const row of group.rows) {
          row.hidden = !`${group.title} ${row.getAttribute('aria-label') ?? row.textContent}`.toLocaleLowerCase().includes(query);
          if (!row.hidden) visible++;
        }
        if (group.heading) group.heading.hidden = visible === 0;
        if (group.count) group.count.textContent = String(visible);
        total += visible;
      }
      scroll.scrollTop = 0;
      scroll.removeAttribute('data-quant-hover-visible');
      footer.textContent = total ? `${total} 个工具` : '没有匹配的工具';
      schedule();
    }
    function onKey(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (event.target === input) event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (input.value) { input.value = ''; filter(); input.focus(); }
        else { arrow?.click(); arrow?.focus({ preventScroll: true }); }
        return;
      }
      const visible = rows.filter(row => !row.hidden);
      if (!visible.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.target === input && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.vela-dtb-item') : null;
      const index = current ? visible.indexOf(current) : -1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + visible.length) % visible.length;
      visible[next].focus({ preventScroll: true });
      visible[next].scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', filter);
    fly.addEventListener('keydown', onKey);
    const resize = new ResizeObserver(schedule);
    resize.observe(fly);
    resize.observe(parent);
    update();
    menus.set(fly, {
      owner, update: schedule,
      dispose(restore = false) {
        active = false;
        cancelAnimationFrame(frame);
        resize.disconnect();
        input.removeEventListener('input', filter);
        fly.removeEventListener('keydown', onKey);
        if (!restore) return;
        for (const group of sections) {
          if (group.heading) {
            group.heading.textContent = group.title;
            group.heading.hidden = false;
            group.heading.classList.remove('quant-drawing-section');
          }
        }
        rows.forEach(row => { row.hidden = false; });
        icons.forEach(icon => icon.classList.remove('quant-drawing-menu-icon'));
        hints.forEach(({ el, text, label }) => {
          el.textContent = text;
          if (label === null) el.removeAttribute('aria-label'); else el.setAttribute('aria-label', label);
        });
        original.forEach(el => el.classList.remove('quant-drawing-section-separator'));
        Object.assign(fly.style, originalStyles);
        fly.classList.remove('quant-drawing-menu');
        fly.replaceChildren(...original);
        arrow?.removeAttribute('aria-expanded');
      },
    });
  }

  function onOpen(event: Event) {
    const fly = event.target;
    if (fly instanceof HTMLElement && fly.matches('.vela-dtb-flyout')) {
      enhance(fly, (event as CustomEvent<SurfaceEventDetail>).detail?.trigger ?? null);
    }
  }
  function onClose(event: Event) {
    if (!(event.target instanceof HTMLElement)) return;
    menus.get(event.target)?.owner?.querySelector('.vela-dtb-arrow')?.setAttribute('aria-expanded', 'false');
  }
  function onScroll(event: Event) {
    if (event.target instanceof HTMLElement && event.target.matches('.vela-dtb')) {
      menus.forEach(menu => menu.update());
    }
  }

  // Native surface events run after row creation and before the first paint.
  host.addEventListener(SURFACE_OPEN_EVENT, onOpen);
  host.addEventListener(SURFACE_CLOSE_EVENT, onClose);
  host.addEventListener('scroll', onScroll, true);
  host.querySelectorAll<HTMLElement>('.vela-dtb-flyout').forEach(fly => enhance(fly, null));
  const observer = new MutationObserver(() => {
    for (const [fly, state] of menus) {
      if (!host.contains(fly)) { state.dispose(); menus.delete(fly); }
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  return () => {
    disposed = true;
    observer.disconnect();
    host.removeEventListener(SURFACE_OPEN_EVENT, onOpen);
    host.removeEventListener(SURFACE_CLOSE_EVENT, onClose);
    host.removeEventListener('scroll', onScroll, true);
    menus.forEach(state => state.dispose(true));
    menus.clear();
  };
}