import type { AnnEvent, AnnLevel, AnnPayload, AnnTone, AnnZone } from '../annotTypes';

import type { MwStory } from './mwStory';

export const SIGNAL_PANEL_ID = 'pulsedesk-signals';
export const SIGNAL_STORAGE_KEY = 'pulsedesk.signal-annotations.v2';
export const LEGACY_SIGNAL_STORAGE_KEY = 'pulsedesk.signal-annotations.v1';
export const SIGNAL_TYPES = [
  { id: 'doubleTop', name: '双顶判读', group: 'mw', flow: true, description: '一个双顶一条完整记录：关键位力量、真实成交、诱多候选与颈线反抽。', rule: '只用已收盘K线，保留现有价格形态识别几何。同区重叠结构归并；力量是证据计数，不是胜率。无真实成交覆盖就明确缺失，不用OHLC补造主动买卖。' },
  { id: 'doubleBottom', name: '双底判读', group: 'mw', flow: true, description: '一个双底一条完整记录：关键位力量、真实成交、诱空候选与突破回踩。', rule: '双顶的镜像。首根越位、两根收盘确认、首次触带、收盘守住和失败分开记时；只触带不等于回踩确认。未收盘价格只提供独立提示。' },
  { id: 'keyLevelScenario', name: '突破回踩区', group: 'mw', flow: false, description: '显示同一形态的关键位/颈线观察带，不新增一张信号卡。', rule: '两根收盘越过0.2 ATR确认价格破位；放量≥1.5×均量，或量≥1.2×且真实成交同向。回踩收盘守住、回撤≤61.8%、量≤0.9×才升级；最多两块不同方向区带。不预测一定会回踩或到达时间。' },
  { id: 'keyLevels', name: '支撑 / 阻力', group: 'context', flow: true, description: '可选盘面背景，默认关闭；不抢双顶/双底的主要标签。', rule: '最近288根中未破的摆动位，按距离选择并去重，最多6条。最近触碰有完整真实成交时附单根观察，无覆盖不造方向；与主形态同价线不重复绘制。' },
  { id: 'retest', name: '其他突破回踩', group: 'context', flow: true, description: '普通摆动位的价格回踩，独立于双顶/双底颈线，默认关闭。', rule: '第一次实际回踩并收盘守住才标，时间是确认那根；仅突破K与确认K都有完整真实成交时附两根佐证，不能冒充整段连续订单流。' },
  { id: 'smartMoney', name: '结构补充', group: 'context', flow: false, description: '在双顶/双底详情中补充SMC结构，不再额外生成多张记录。', rule: '沿用现有聪明钱结构检测。命中计数只解释价格事实，不推断机构、止损或盈利；该开关只控制附加详情，不影响主判读。' },
  { id: 'deltaImpulse', name: '成交力度', group: 'context', flow: true, description: '可选盘面背景，默认关闭；真实成交放量时才给主动方向。', rule: '保留既有放量、主动差、收盘位置观察；画布最多4个已收盘标签，形成中预览单独标识。≈ 为OHLC代理，绝不用于双顶双底的成交证据或CVD。' },
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number]['id'];
export type SignalSource = 'price' | 'real' | 'mixed' | 'approx';
export const SOURCE_LABELS: Record<SignalSource, string> = { price: '价格结构', real: '真实成交', mixed: '部分真实 / 代理', approx: 'K线代理' };

export interface SignalPreferences {
  enabled: boolean;
  selected: Record<SignalType, boolean>;
  labels: boolean;
  geometry: boolean;
  allowApprox: boolean;
  preview: boolean;
  lookback: 300 | 600 | 1200;
}
export const DEFAULT_PREFERENCES: SignalPreferences = {
  enabled: true,
  selected: { doubleTop: true, doubleBottom: true, keyLevelScenario: true, keyLevels: false, retest: false, smartMoney: false, deltaImpulse: false },
  labels: true,
  geometry: true,
  allowApprox: false,
  preview: false,
  lookback: 600,
};

export interface SignalItem {
  id: string;
  type: SignalType;
  ts: number;
  fromTs: number;
  price: number;
  title: string;
  detail: string[];
  source: SignalSource;
  confirmed: boolean;
  /** One evolving M/W record; origin/evidence stay anchored to its confirmation. */
  story?: MwStory;
  tone: AnnTone;
  event?: AnnEvent;
  levels?: AnnLevel[];
  zone?: AnnZone;
  path?: { points: { ts: number; price: number }[]; tone: AnnTone };
  /**
   * false = 只在侧栏列出；所有图层元素都不绘制。M/W画布选择另由selectMwStories控制。
   * 用于放量 K 线这类高频事件：全部保留在列表，画布只画最重要的几个。
   */
  paint?: boolean;
}
export const emptyCounts = (): Record<SignalType, number> => Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, 0])) as Record<SignalType, number>;
export interface SignalRuntimeState {
  symbol: string;
  timeframe: string;
  status: 'loading' | 'ready' | 'paused' | 'error';
  message: string;
  bars: number;
  /** 用户请求的回看根数；bars < requested 说明历史不足或被缺口截断 */
  requested: number;
  /** 历史缺口把分析范围截断到最新连续段 */
  gapTruncated: boolean;
  covered: number;
  flowSupported: boolean;
  flowConnected: boolean;
  flowSyncing: boolean;
  updatedAt: number;
  counts: Record<SignalType, number>;
  visible: SignalItem[];
  total: number;
}
export const EMPTY_RUNTIME: SignalRuntimeState = { symbol: '', timeframe: '', status: 'loading', message: '', bars: 0, requested: 600, gapTruncated: false, covered: 0, flowSupported: true, flowConnected: false, flowSyncing: false, updatedAt: 0, counts: emptyCounts(), visible: [], total: 0 };
export interface SignalSnapshot { preferences: SignalPreferences; runtime: SignalRuntimeState; focusId: string | null }

/** Stored preferences are untrusted; invalid/obsolete values never reach the scanner. */
export function normalizePreferences(value: unknown): SignalPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<SignalPreferences> : {};
  const selected = { ...DEFAULT_PREFERENCES.selected };
  for (const { id } of SIGNAL_TYPES) if (typeof raw.selected?.[id] === 'boolean') selected[id] = raw.selected[id];
  const flag = (key: 'enabled' | 'labels' | 'geometry' | 'allowApprox' | 'preview') => typeof raw[key] === 'boolean' ? raw[key]! : DEFAULT_PREFERENCES[key];
  return { enabled: flag('enabled'), selected, labels: flag('labels'), geometry: flag('geometry'), allowApprox: flag('allowApprox'), preview: flag('preview'), lookback: raw.lookback === 300 || raw.lookback === 1200 ? raw.lookback : 600 };
}

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export function createSignalStore(storage?: StoragePort) {
  let saved: unknown;
  let migrated = false;
  try { saved = JSON.parse(storage?.getItem(SIGNAL_STORAGE_KEY) ?? 'null'); } catch { /* try the previous version */ }
  if (saved == null) {
    try { saved = JSON.parse(storage?.getItem(LEGACY_SIGNAL_STORAGE_KEY) ?? 'null'); migrated = saved != null; } catch { /* defaults */ }
  }
  let snapshot: SignalSnapshot = { preferences: normalizePreferences(saved), runtime: { ...EMPTY_RUNTIME, counts: emptyCounts() }, focusId: null };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(fn => fn());
  const persist = () => { try { storage?.setItem(SIGNAL_STORAGE_KEY, JSON.stringify({ ...snapshot.preferences, version: 2 })); } catch { /* private mode */ } };
  if (migrated) persist(); // Keep shared flags, discard merged evidence-only toggles; retain the legacy value for rollback.
  return {
    firstVisit: saved == null,
    focus(id: string | null) { if (snapshot.focusId !== id) { snapshot = { ...snapshot, focusId: id }; publish(); } },
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    patch(patch: Partial<SignalPreferences>) {
      snapshot = { ...snapshot, preferences: normalizePreferences({ ...snapshot.preferences, ...patch }) };
      persist(); publish();
    },
    toggle(id: SignalType) {
      snapshot = { ...snapshot, preferences: { ...snapshot.preferences, selected: { ...snapshot.preferences.selected, [id]: !snapshot.preferences.selected[id] } } };
      persist(); publish();
    },
    allOn() {
      snapshot = { ...snapshot, preferences: { ...snapshot.preferences, enabled: true, selected: Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, true])) as Record<SignalType, boolean> } };
      persist(); publish();
    },
    allOff() {
      // Preserve individual choices; the master switch restores the selected combination.
      snapshot = { ...snapshot, preferences: { ...snapshot.preferences, enabled: false } };
      persist(); publish();
    },
    updateRuntime(runtime: SignalRuntimeState) { snapshot = { ...snapshot, runtime }; publish(); },
    persist,
  };
}
export type SignalStore = ReturnType<typeof createSignalStore>;
const stores = new WeakMap<HTMLElement, SignalStore>();
export function signalStoreFor(host: HTMLElement): SignalStore {
  let store = stores.get(host);
  if (!store) {
    let storage: StoragePort | undefined;
    try { storage = window.localStorage; } catch { /* private mode */ }
    store = createSignalStore(storage);
    stores.set(host, store);
  }
  return store;
}
export function emptySignalPayload(): AnnPayload {
  return { events: [], levels: [], zones: [], paths: [], position: null, obstacles: [], decimals: 2, rev: 0 };
}

export const flowRequested = (p: SignalPreferences) => p.enabled && SIGNAL_TYPES.some(t => t.flow && p.selected[t.id]);
