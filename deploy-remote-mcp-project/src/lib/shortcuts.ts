export type PanelShortcut = 'engine' | 'frameworks';

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat'>;

/**
 * 只认纯 Shift+C / Shift+F：Ctrl/⌘+Shift+C 是浏览器「检查元素」，
 * Alt 组合留给输入法与系统；按住不放的自动重复也不能让面板连续开合。
 */
export function panelShortcut(e: KeyLike): PanelShortcut | null {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  const k = e.key.toLowerCase();
  return k === 'c' ? 'engine' : k === 'f' ? 'frameworks' : null;
}
