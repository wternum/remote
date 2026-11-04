import type { AnnEvent, AnnLevel, AnnPayload, AnnTone, AnnZone } from '../annotTypes';

export const SIGNAL_PANEL_ID = 'pulsedesk-signals';
export const SIGNAL_STORAGE_KEY = 'pulsedesk.signal-annotations.v1';
export const SIGNAL_TYPES = [
  { id: 'doubleTop', name: '双顶', en: 'Double top', group: 'structure', color: '#f58b9a', description: '已确认的 M 型二次测试收盘拒绝', rule: '只用已收盘价格、ATR 和左 8 / 右 5 根确认摆动点；两次测试相隔至少 8 根、颈线高度至少 2 ATR。图上识别不受交易手续费、止损空间或盈亏比过滤，不代表可执行交易。' },
  { id: 'doubleBottom', name: '双底', en: 'Double bottom', group: 'structure', color: '#65d6ad', description: '已确认的 W 型二次测试收盘拒绝', rule: '与双顶镜像对称；等待已确认摆动底、第二次测试与收盘拒绝。使用 ATR 容差（最多 0.7 ATR），不以历史交易胜率或未来 K 线修订信号。' },
  { id: 'keyLevels', name: '支撑 / 阻力', en: 'Key levels', group: 'structure', color: '#91adf8', description: '当前尚未收盘突破的摆动价位', rule: '左 8 / 右 5 根已收盘 K 线确认摆动点；保留最近 288 根内未收盘突破的价位，按现价距离排序最多 8 条。' },
  { id: 'retest', name: '突破回踩', en: 'Breakout & retest', group: 'structure', color: '#e4c17c', description: '价格突破后首次回踩并收盘守住', rule: '价格结构信号：关键位收盘突破后回踩、再次收盘守住才标注；事件时间是首次确认那根。只有突破 K 与回踩确认 K 均有真实 taker 成交、方向不冲突时才额外提供成交佐证；否则不冒充订单流确认。' },
  { id: 'keyLevelFlow', name: '关键位成交反应', en: 'Key-level taker flow', group: 'flow', color: '#7dd3fc', description: '双顶/双底第二次测试处的真实 taker 买卖差与覆盖', rule: '只附属于已确认的 M/W 第二次测试。测试 K 或确认 K 至少一根具备完整真实逐笔覆盖（聚合 ≥ K 线成交额 85%）才显示；详情列出两根的 B/S 名义额、(B−S)/(B+S)、覆盖率、扫位深度和收盘结果。两条推进腿完整连续覆盖时才比较推进强弱。它是成交观察，不是订单簿 OFI，也不输出胜率。' },
  { id: 'bullTrap', name: '诱多候选', en: 'High sweep / reclaim', group: 'flow', color: '#f4a073', description: '扫高收回且测试／确认 K 有真实成交证据', rule: '须二次测试刺破前高并收回；真实标注还须测试与确认 K 都有完整 taker 成交，且反转侧主动成交接管或追多成交放量未能守住。看不到具体止损单，故只称“候选”。手动开启近似时，仅显示 ≈ 扫高收回（价格），不声称观察到主动买卖。' },
  { id: 'bearTrap', name: '诱空候选', en: 'Low sweep / reclaim', group: 'flow', color: '#71d5c7', description: '扫低收回且测试／确认 K 有真实成交证据', rule: '双底镜像：须扫低后收盘收回，且测试／确认 K 的真实 taker 成交满足反转或放量追空未续。无完整逐笔覆盖时只允许明确标为 ≈ 价格代理；不能据此声称止损真的触发。' },
  { id: 'cvdDivergence', name: 'CVD 背离', en: 'Taker CVD divergence', group: 'flow', color: '#ba9cfa', description: '二次测试时连续真实主动成交累计量未确认极值', rule: '一顶/底至二次测试之间的每根 K 线都需要完整真实 taker 买卖成交；累计净主动成交变化与价格二次测试方向相背才标注。缺任一根即不拼接 OHLC 代理，也不输出 CVD 背离。' },
  { id: 'deltaImpulse', name: '主动成交异动', en: 'Taker trade imbalance', group: 'flow', color: '#73c5e7', description: '真实 taker 买卖差显著且成交量放大', rule: '完整成交覆盖下，K 线成交额 ≥ 前 20 根均量的 1.5 倍，|真实 taker 买卖差 / 实际成交额| ≥ 25%。阈值是未校准的工程观察值，不代表预测胜率；打开近似后可另看 ≈ K 线量价代理，绝不称真实主动成交。' },
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number]['id'];
export type SignalSource = 'price' | 'real' | 'mixed' | 'approx';
export const SOURCE_LABELS: Record<SignalSource, string> = { price: '价格结构', real: '真实逐笔', mixed: '部分真实 / 代理', approx: 'K 线代理' };

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
  selected: { doubleTop: true, doubleBottom: true, keyLevels: true, bullTrap: true, bearTrap: true, cvdDivergence: false, deltaImpulse: true, retest: false, keyLevelFlow: true },
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
  tone: AnnTone;
  event?: AnnEvent;
  levels?: AnnLevel[];
  zone?: AnnZone;
  path?: { points: { ts: number; price: number }[]; tone: AnnTone };
}
export const emptyCounts = (): Record<SignalType, number> => Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, 0])) as Record<SignalType, number>;
export interface SignalRuntimeState {
  symbol: string;
  timeframe: string;
  status: 'loading' | 'ready' | 'paused' | 'error';
  message: string;
  bars: number;
  covered: number;
  flowSupported: boolean;
  flowConnected: boolean;
  flowSyncing: boolean;
  updatedAt: number;
  counts: Record<SignalType, number>;
  visible: SignalItem[];
  total: number;
}
export const EMPTY_RUNTIME: SignalRuntimeState = { symbol: '', timeframe: '', status: 'loading', message: '', bars: 0, covered: 0, flowSupported: true, flowConnected: false, flowSyncing: false, updatedAt: 0, counts: emptyCounts(), visible: [], total: 0 };
export interface SignalSnapshot { preferences: SignalPreferences; runtime: SignalRuntimeState }

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
  try { saved = JSON.parse(storage?.getItem(SIGNAL_STORAGE_KEY) ?? 'null'); } catch { /* corrupt/private storage: use defaults */ }
  let snapshot: SignalSnapshot = { preferences: normalizePreferences(saved), runtime: { ...EMPTY_RUNTIME, counts: emptyCounts() } };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(fn => fn());
  const persist = () => { try { storage?.setItem(SIGNAL_STORAGE_KEY, JSON.stringify(snapshot.preferences)); } catch { /* private mode */ } };
  return {
    firstVisit: saved == null,
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
