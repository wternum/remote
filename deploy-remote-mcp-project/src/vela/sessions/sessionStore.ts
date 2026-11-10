// ─────────────────────────────────────────────────────────────
//  交易时段偏好设置与状态同步 Store
//  持久化键：pulsedesk.sessions.v1
// ─────────────────────────────────────────────────────────────
import type { AsiaRangeSummary, SessionMode } from './sessionMath';

export const SESSION_STORAGE_KEY = 'pulsedesk.sessions.v1';

export interface SessionPreferences {
  /** 是否开启交易时段图表标注（主开关） */
  enabled: boolean;
  /** 时段预设模式：'macro' 三大宏观时段 | 'killzone' ICT 猎杀区 */
  mode: SessionMode;
  /** fixed=固定UTC教学预设；local=伦敦/纽约本地时间自动夏令时 */
  clockMode: 'fixed' | 'local';
  /** 是否绘制时段底色色带 */
  showBands: boolean;
  /** 背景浓度 0–100%：0 全透明，100 使用各时段原始填充强度 */
  bandOpacity: number;
  /** 是否绘制顶部时段胶囊徽标 */
  showBadges: boolean;
  /** 是否绘制亚太交易时段高低点 (AH / AL) 延伸线与扫荡状态 */
  showAsiaRange: boolean;
  /** 是否绘制日界分割线（北京时间 00:00） */
  showDailyOpen: boolean;
  /** 是否高亮欧美重叠期 / 伦敦收盘区 */
  showOverlap: boolean;
  /** 三大主时段各自独立开关 */
  enabledSessions: {
    asia: boolean;
    london: boolean;
    ny: boolean;
  };
}

export const DEFAULT_SESSION_PREFERENCES: SessionPreferences = {
  enabled: true,
  mode: 'macro',
  clockMode: 'fixed',
  showBands: true,
  bandOpacity: 65,
  showBadges: true,
  showAsiaRange: true,
  showDailyOpen: true,
  showOverlap: true,
  enabledSessions: {
    asia: true,
    london: true,
    ny: true,
  },
};

export interface SessionRuntimeSummary {
  /** 当前周期是否为日内周期（日/周线自动折叠时段色带） */
  intraday: boolean;
  /** 当前图表最新交易日的亚太交易时段高低点统计 */
  latestAsia: AsiaRangeSummary | null;
  /** 当前视口内可见的时段块数量 */
  visibleSpans: number;
}

export interface SessionStoreSnapshot {
  preferences: SessionPreferences;
  summary: SessionRuntimeSummary;
}

const DEFAULT_SUMMARY: SessionRuntimeSummary = {
  intraday: true,
  latestAsia: null,
  visibleSpans: 0,
};

export function normalizeSessionPreferences(raw: unknown): SessionPreferences {
  const obj = raw && typeof raw === 'object' ? (raw as Partial<SessionPreferences>) : {};
  const bool = (val: unknown, fallback: boolean) => (typeof val === 'boolean' ? val : fallback);
  const mode: SessionMode = obj.mode === 'killzone' ? 'killzone' : 'macro';
  const rawSessions = obj.enabledSessions && typeof obj.enabledSessions === 'object' ? obj.enabledSessions : undefined;

  return {
    enabled: bool(obj.enabled, DEFAULT_SESSION_PREFERENCES.enabled),
    mode,
    clockMode: obj.clockMode === 'local' ? 'local' : 'fixed',
    showBands: bool(obj.showBands, DEFAULT_SESSION_PREFERENCES.showBands),
    bandOpacity: typeof obj.bandOpacity === 'number' && Number.isFinite(obj.bandOpacity)
      ? Math.round(Math.min(100, Math.max(0, obj.bandOpacity))) : DEFAULT_SESSION_PREFERENCES.bandOpacity,
    showBadges: bool(obj.showBadges, DEFAULT_SESSION_PREFERENCES.showBadges),
    showAsiaRange: bool(obj.showAsiaRange, DEFAULT_SESSION_PREFERENCES.showAsiaRange),
    showDailyOpen: bool(obj.showDailyOpen, DEFAULT_SESSION_PREFERENCES.showDailyOpen),
    showOverlap: bool(obj.showOverlap, DEFAULT_SESSION_PREFERENCES.showOverlap),
    enabledSessions: {
      asia: bool(rawSessions?.asia, DEFAULT_SESSION_PREFERENCES.enabledSessions.asia),
      london: bool(rawSessions?.london, DEFAULT_SESSION_PREFERENCES.enabledSessions.london),
      ny: bool(rawSessions?.ny, DEFAULT_SESSION_PREFERENCES.enabledSessions.ny),
    },
  };
}

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;

export function createSessionStore(storage?: StoragePort) {
  let saved: unknown = null;
  try {
    const text = storage?.getItem(SESSION_STORAGE_KEY);
    if (text) saved = JSON.parse(text);
  } catch {
    /* ignore storage parse error */
  }

  let snapshot: SessionStoreSnapshot = {
    preferences: normalizeSessionPreferences(saved),
    summary: { ...DEFAULT_SUMMARY },
  };

  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(fn => fn());
  const persist = () => {
    try {
      storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...snapshot.preferences, version: 1 }));
    } catch {
      /* ignore private mode quota */
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    patch(partial: Partial<SessionPreferences>) {
      snapshot = {
        ...snapshot,
        preferences: normalizeSessionPreferences({
          ...snapshot.preferences,
          ...partial,
          enabledSessions: partial.enabledSessions
            ? { ...snapshot.preferences.enabledSessions, ...partial.enabledSessions }
            : snapshot.preferences.enabledSessions,
        }),
      };
      persist();
      publish();
    },
    toggleSession(key: 'asia' | 'london' | 'ny') {
      const next = !snapshot.preferences.enabledSessions[key];
      snapshot = {
        ...snapshot,
        preferences: {
          ...snapshot.preferences,
          enabledSessions: {
            ...snapshot.preferences.enabledSessions,
            [key]: next,
          },
        },
      };
      persist();
      publish();
    },
    reset() {
      snapshot = {
        ...snapshot,
        preferences: {
          ...DEFAULT_SESSION_PREFERENCES,
          enabledSessions: { ...DEFAULT_SESSION_PREFERENCES.enabledSessions },
        },
      };
      persist();
      publish();
    },
    updateSummary(next: SessionRuntimeSummary) {
      const prev = snapshot.summary;
      const sameAsia =
        prev.latestAsia?.dayStartMs === next.latestAsia?.dayStartMs &&
        prev.latestAsia?.high === next.latestAsia?.high &&
        prev.latestAsia?.low === next.latestAsia?.low &&
        prev.latestAsia?.highState === next.latestAsia?.highState &&
        prev.latestAsia?.lowState === next.latestAsia?.lowState;
      if (prev.intraday === next.intraday && prev.visibleSpans === next.visibleSpans && sameAsia) {
        return;
      }
      snapshot = { ...snapshot, summary: next };
      publish();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

let globalSessionStore: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!globalSessionStore) {
    let storage: StoragePort | undefined;
    try {
      if (typeof window !== 'undefined') storage = window.localStorage;
    } catch {
      /* SSR or restricted iframe */
    }
    globalSessionStore = createSessionStore(storage);
  }
  return globalSessionStore;
}
