import type { WidgetContext } from '@luxalgo/vela';

// 顶栏动作与 React 弹窗之间的最小事件桥（传递完整 WidgetContext，指标库需要 ctx.host / addNativeIndicator）
type Listener = (ctx: WidgetContext) => void;
const listeners = new Set<Listener>();

export function openIndicatorPicker(ctx: WidgetContext) {
  listeners.forEach(fn => fn(ctx));
}

export function onIndicatorPicker(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
