import {
  DEFAULT_FRAMEWORK_MARK_PREFS,
  normalizeFrameworkMarkPrefs,
  type FrameworkMarkPrefs,
} from '@/quant/frameworkMarks';

export const FRAMEWORK_MARK_STORAGE_KEY = 'pulsedesk.framework-marks.v1';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;

export function createFrameworkMarkStore(storage?: StoragePort) {
  let saved: unknown = null;
  try {
    const text = storage?.getItem(FRAMEWORK_MARK_STORAGE_KEY);
    if (text) saved = JSON.parse(text);
  } catch {
    /* ignore storage parse error */
  }

  let prefs: FrameworkMarkPrefs = normalizeFrameworkMarkPrefs(saved);
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(fn => fn());
  const persist = () => {
    try {
      storage?.setItem(FRAMEWORK_MARK_STORAGE_KEY, JSON.stringify({ ...prefs, version: 1 }));
    } catch {
      /* ignore private mode / quota */
    }
  };

  return {
    getSnapshot: () => prefs,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    patch(next: Partial<FrameworkMarkPrefs>) {
      const normalized = normalizeFrameworkMarkPrefs({ ...prefs, ...next });
      if (
        normalized.enabled === prefs.enabled &&
        normalized.liquidity === prefs.liquidity &&
        normalized.fractals === prefs.fractals &&
        normalized.wyckoffFvg === prefs.wyckoffFvg &&
        normalized.amt === prefs.amt &&
        normalized.labels === prefs.labels
      ) {
        return;
      }
      prefs = normalized;
      persist();
      publish();
    },
    toggle(key: keyof FrameworkMarkPrefs) {
      this.patch({ [key]: !prefs[key] });
    },
    reset() {
      prefs = { ...DEFAULT_FRAMEWORK_MARK_PREFS };
      persist();
      publish();
    },
  };
}

export type FrameworkMarkStore = ReturnType<typeof createFrameworkMarkStore>;

let singleton: FrameworkMarkStore | null = null;
export function getFrameworkMarkStore(): FrameworkMarkStore {
  if (!singleton) {
    let storage: StoragePort | undefined;
    try {
      storage = typeof window !== 'undefined' ? window.localStorage : undefined;
    } catch {
      storage = undefined;
    }
    singleton = createFrameworkMarkStore(storage);
  }
  return singleton;
}
