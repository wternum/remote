// Keep Vela's tool selection and favorites; enhance only its flyout chrome.
export function installToolbarHover(root: HTMLElement): () => void {
  const enhanced = new WeakSet<HTMLElement>();
  let hoveredCell: HTMLElement | null = null;
  let hoverTimer = 0;
  let leaveTimer = 0;

  function enhance(flyout: HTMLElement) {
    if (enhanced.has(flyout)) return;
    enhanced.add(flyout);
    flyout.classList.add('pd-tool-menu');

    const search = document.createElement('label');
    search.className = 'pd-tool-search';
    search.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg>';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索工具...';
    input.setAttribute('aria-label', '搜索绘图工具');
    search.append(input);

    const count = document.createElement('span');
    count.className = 'pd-tool-count';
    const empty = document.createElement('div');
    empty.className = 'pd-tool-empty';
    empty.textContent = '没有匹配的工具';
    const footer = document.createElement('div');
    footer.className = 'pd-tool-footer';
    footer.append(count);

    flyout.prepend(search);
    flyout.append(empty, footer);
    const filter = () => {
      const rows = [...flyout.querySelectorAll<HTMLElement>('.vela-dtb-item')];
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const row of rows) {
        const match = row.textContent?.toLocaleLowerCase().includes(query) ?? false;
        row.hidden = !match;
        if (match) visible++;
      }
      // Native group headings and separators are unclassed divs.
      for (const node of [...flyout.children]) {
        if (node instanceof HTMLDivElement && node !== empty && node !== footer) node.hidden = !!query;
      }
      empty.hidden = visible !== 0;
      count.textContent = `${visible} 个工具`;
    };
    input.addEventListener('input', filter);
    queueMicrotask(filter);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches('.vela-dtb-flyout')) enhance(node);
        node.querySelectorAll<HTMLElement>('.vela-dtb-flyout').forEach(enhance);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  root.querySelectorAll<HTMLElement>('.vela-dtb-flyout').forEach(enhance);

  function onPointerOver(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest('.vela-dtb-flyout')) {
      window.clearTimeout(leaveTimer);
      return;
    }
    const cell = target.closest<HTMLElement>('.vela-dtb-cell');
    if (!cell || cell === hoveredCell || !cell.querySelector('.vela-dtb-arrow')) return;
    window.clearTimeout(hoverTimer);
    window.clearTimeout(leaveTimer);
    hoveredCell = cell;
    hoverTimer = window.setTimeout(() => {
      if (hoveredCell === cell && !cell.classList.contains('vela-open')) {
        cell.querySelector<HTMLButtonElement>('.vela-dtb-arrow')?.click();
      }
    }, 190);
  }

  function onPointerOut(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.vela-dtb, .vela-dtb-flyout')) return;
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest('.vela-dtb, .vela-dtb-flyout')) return;
    window.clearTimeout(hoverTimer);
    leaveTimer = window.setTimeout(() => {
      if (hoveredCell?.classList.contains('vela-open')) {
        hoveredCell.querySelector<HTMLButtonElement>('.vela-dtb-arrow')?.click();
      }
      hoveredCell = null;
    }, 240);
  }

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  return () => {
    observer.disconnect();
    window.clearTimeout(hoverTimer);
    window.clearTimeout(leaveTimer);
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointerout', onPointerOut);
  };
}
