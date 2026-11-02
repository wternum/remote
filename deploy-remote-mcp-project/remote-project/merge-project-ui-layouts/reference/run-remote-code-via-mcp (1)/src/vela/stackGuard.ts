// ─────────────────────────────────────────────────────────────
//  命中保护
//  Vela 的弹层（顶栏下拉、样式菜单、工具 flyout、对话框）与图表画布之间
//  存在偶发的命中翻转：弹层视觉在上、命中却在画布上（合成层失效导致），
//  表现为"周期/样式点不中"。
//  只要任意 Vela chrome 弹层处于打开状态，就把图表画布的 pointer-events
//  关掉（图表本来就不该在弹层下面响应），弹层关闭后恢复。
// ─────────────────────────────────────────────────────────────

const OPEN_SELECTOR = [
  '.vela-menu[data-state="open"]',
  '.vela-dtb-flyout',
  '[role="dialog"][data-state="open"]',
  '.vela-popover[data-state="open"]',
  '[data-state="open"][aria-haspopup]',
].join(', ');

export function installStackGuard(root: HTMLElement): () => void {
  let cls = false;
  let timer: number | null = null;
  const check = () => {
    const open = !!root.querySelector(OPEN_SELECTOR);
    if (open === cls) return;
    cls = open;
    root.classList.toggle('vela-chrome-open', open);
  };
  // 状态变化监听（只盯 data-state，噪音小）+ 低频轮询兜底
  const mo = new MutationObserver(check);
  mo.observe(root, { attributes: true, attributeFilter: ['data-state'], subtree: true });
  timer = window.setInterval(check, 120);
  check();
  return () => {
    mo.disconnect();
    if (timer) window.clearInterval(timer);
    root.classList.remove('vela-chrome-open');
  };
}
