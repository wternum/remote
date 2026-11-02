// ─────────────────────────────────────────────────────────────
//  指针命中修复
//  图表画布（WebGL，覆盖整个绘图区）与 Vela chrome（顶栏下拉、样式菜单、
//  侧栏、工具栏）之间存在偶发的命中翻转：pointerdown 落在 chrome、
//  pointerup 落到画布（或相反）—— 手势断裂，下拉菜单"点不中"。
//  这里跟踪整个手势：
//   · 按下时目标是画布而指针下是 chrome → 吞掉原事件，把手势重放到 chrome
//   · 抬起时目标与按下时的 chrome 不一致 → 把 pointerup/click 补发给按下时的元素
//   · 全程正常时不介入
// ─────────────────────────────────────────────────────────────

const CHROME_SELECTOR = [
  '.vela-ui-layer',
  '.vela-widget-topbar',
  '.vela-widget-bottombar',
  '.vela-sidepanel',
  '.vela-dtb',
  '.vela-dtb-flyout',
].join(', ');

let installed = false;

export function installVelaHitFix(): () => void {
  if (installed) return () => undefined;
  installed = true;
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    installed = false;
  };
}

interface Gesture {
  top: HTMLElement; // 按下时指针下的真实元素
  chrome: Element; // 所属 chrome 根
  syntheticDown: boolean; // 按下事件是否由本模块转发
}
let gesture: Gesture | null = null;

function pointIn(el: HTMLElement, x: number, y: number, pad = 8): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function sameChrome(a: EventTarget | null, b: Element): boolean {
  const el = a as HTMLElement | null;
  if (!el || typeof el.contains !== 'function') return false;
  return el === b || el.contains(b) || b.contains(el);
}

function onDown(e: PointerEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const top = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? target;
  const chrome = top.closest(CHROME_SELECTOR);
  if (!chrome) {
    gesture = null;
    return;
  }
  // 目标是 chrome 本身：记录手势，等待抬起时校验
  if (sameChrome(target, chrome)) {
    gesture = { top, chrome, syntheticDown: false };
    return;
  }
  // 目标是画布等：吞掉并把按下重放到真实 chrome 元素
  e.stopImmediatePropagation();
  e.preventDefault();
  try {
    (target as HTMLElement).releasePointerCapture?.(e.pointerId);
  } catch {
    /* ignore */
  }
  const base = {
    view: window,
    button: e.button,
    clientX: e.clientX,
    clientY: e.clientY,
    pointerId: e.pointerId,
    pointerType: e.pointerType || 'mouse',
    isPrimary: e.isPrimary,
  };
  top.dispatchEvent(new PointerEvent('pointerover', { ...base, bubbles: true, cancelable: true }));
  top.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false, cancelable: true }));
  top.dispatchEvent(new PointerEvent('pointermove', { ...base, bubbles: true, cancelable: true }));
  top.dispatchEvent(new PointerEvent('pointerdown', { ...base, bubbles: true, cancelable: true, buttons: 1 }));
  gesture = { top, chrome, syntheticDown: true };
}

function onUp(e: PointerEvent) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  if (!pointIn(g.top, e.clientX, e.clientY)) return; // 已滑出按下元素：不算点击

  const targetIsChrome = sameChrome(e.target, g.chrome);
  if (!g.syntheticDown && targetIsChrome) return; // 全程正常，浏览器会自动派发 click

  // 抬起事件丢了或被画布吃掉：补发 pointerup + click
  const under = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? g.top;
  const dest = sameChrome(under, g.chrome) ? under : g.top;
  const base = {
    view: window,
    button: e.button,
    clientX: e.clientX,
    clientY: e.clientY,
    pointerId: e.pointerId,
    pointerType: e.pointerType || 'mouse',
    isPrimary: e.isPrimary,
  };
  dest.dispatchEvent(new PointerEvent('pointerup', { ...base, bubbles: true, cancelable: true, buttons: 0 }));
  dest.dispatchEvent(
    new MouseEvent('click', { ...base, bubbles: true, cancelable: true, button: e.button, detail: e.detail }),
  );
}

function onCancel() {
  gesture = null;
}
