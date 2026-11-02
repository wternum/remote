import type { Vela } from '@luxalgo/vela';

// 顶栏动作与 React 弹窗之间的最小事件桥
type Listener = (chart: Vela) => void;
const listeners = new Set<Listener>();

export function openIndicatorPicker(chart: Vela) {
  listeners.forEach(fn => fn(chart));
}

export function onIndicatorPicker(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
