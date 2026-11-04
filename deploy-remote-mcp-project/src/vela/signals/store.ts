import type { AnnEvent, AnnLevel, AnnPayload, AnnTone, AnnZone } from '../annotTypes';

export const SIGNAL_PANEL_ID = 'pulsedesk-signals';
export const SIGNAL_STORAGE_KEY = 'pulsedesk.signal-annotations.v1';
export const SIGNAL_TYPES = [
  { id: 'doubleTop', name: '双顶', en: 'Double top', group: 'structure', color: '#f58b9a', description: '两次测试前高、第二次收盘回落，先标为双顶候选。', rule: '只用已收盘 K 线、ATR 与左 8 / 右 5 根确认摆动点。二次测试不是已完成反转；需要之后收盘下破颈线，且即使破位也可能失效。图上不做交易成本或胜率承诺。' },
  { id: 'doubleBottom', name: '双底', en: 'Double bottom', group: 'structure', color: '#65d6ad', description: '两次测试前低、第二次收盘收回，先标为双底候选。', rule: '与双顶镜像对称；颈线上破前只是二次测试候选，不能解释为确定上涨。只用已收盘 K 线；ATR 价格容差最多 0.7 ATR。' },
  { id: 'keyLevels', name: '支撑 / 阻力', en: 'Key levels', group: 'structure', color: '#91adf8', description: '最近已确认、尚未收盘破坏且靠近现价的摆动关键位。', rule: '左 8 / 右 5 根已收盘 K 线确认摆动点；最近 288 根内尚未收盘破位、距现价不超过 max(3 ATR, 现价 1.2%)；最多展示 8 条。' },
  { id: 'retest', name: '突破回踩', en: 'Breakout & retest', group: 'structure', color: '#e4c17c', description: '价格突破一条线后第一次回来，并且收盘站住，才标。', rule: '价格结构信号：关键位收盘突破后回踩、再次收盘守住才标注；事件时间是首次确认那根。只有突破 K 与回踩确认 K 均有真实 taker 成交、方向不冲突时才额外提供成交佐证；否则不冒充订单流确认。' },
  { id: 'smartMoney', name: '聪明钱结构', en: 'Key-level SMC context', group: 'structure', color: '#c8a2f8', description: '关键位旁边有没有反复被摸、破结构、留下没补的缺口', rule: '在双顶/双底的关键位旁边看四件事：这里是不是反复被摸过、有没有破过结构、有没有留下没补的价格缺口、是不是刚有一根反向 K 线被越过。默认关闭，避免图上太乱。只讲看到的价格事实，不猜机构身份，命中数量不是胜率。' },
  { id: 'keyLevelScenario', name: '双顶双底阶段', en: 'M/W phase', group: 'flow', color: '#e9b86e', description: '每个双顶/双底现在只有一种状态：没突破（买/卖向候选）、假突破、放量真突破等回踩、回踩确认（买/卖向）、突破失败。', rule: '只用已收盘 K 线。没突破：二次测试成立、颈线未破 → 只给方向候选；假突破：关键位被刺破后收盘收回；真突破：两根收盘越位且放量 ≥1.5×20 根均量 → 等回踩，不追；回踩确认：回踩缩量（≤0.9× 突破量）且回撤 ≤61.8% → 延续方向；缩量破位/第二腿放量 → 疑假，不给方向。同一方向最多一块区带。这是结构状态，不是胜率。' },

  { id: 'keyLevelFlow', name: '关键位成交反应', en: 'Key-level taker flow', group: 'flow', color: '#7dd3fc', description: '二次测试的主动买卖额来自 OKX 官方统计或逐笔成交聚合；不完整就不说谁占优。', rule: '附属于已收盘的 M/W 二次测试。rubik 统计总额需与 K 线成交额相符（95%–110%）；逐笔聚合至少覆盖 85%、最多 110%。显示金额、来源及覆盖率；两条推进腿连续完整覆盖时才比较。买卖差不是订单簿 OFI，不代表止损成交。' },
  { id: 'bullTrap', name: '诱多候选', en: 'High sweep / reclaim', group: 'flow', color: '#f4a073', description: '冲上去又掉回来，追高的人被套住的样子（要有真实成交佐证）。', rule: '须二次测试刺破前高并收回；真实标注还须测试与确认 K 都有完整 taker 成交，且反转侧主动成交接管或追多成交放量未能守住。看不到具体止损单，故只称“候选”。手动开启近似时，仅显示 ≈ 扫高收回（价格），不声称观察到主动买卖。' },
  { id: 'bearTrap', name: '诱空候选', en: 'Low sweep / reclaim', group: 'flow', color: '#71d5c7', description: '跌下去又拉回来，追空的人被套住的样子（要有真实成交佐证）。', rule: '双底镜像：须扫低后收盘收回，且测试／确认 K 的真实 taker 成交满足反转或放量追空未续。无完整逐笔覆盖时只允许明确标为 ≈ 价格代理；不能据此声称止损真的触发。' },
  { id: 'cvdDivergence', name: 'CVD 背离', en: 'Taker CVD divergence', group: 'flow', color: '#ba9cfa', description: '价格创新高/新低，但一路累积的主动买卖力量没跟上。需要连续逐笔数据。', rule: '一顶/底至二次测试之间的每根 K 线都需要完整真实 taker 买卖成交；累计净主动成交变化与价格二次测试方向相背才标注。缺任一根即不拼接 OHLC 代理，也不输出 CVD 背离。' },
  { id: 'deltaImpulse', name: '成交力度', en: 'Taker effort vs result', group: 'flow', color: '#73c5e7', description: '放量的 K 线里，谁在出力、价格跟没跟', rule: '放量的 K 线会标一句人话：卖得猛 / 买得猛（一边倒）、跌不下去 / 涨不上去（力气大但价格没跟着走）、爆量（买卖两边都很大）。图上最多只画 4 个最重要的，其余在侧栏列表里。必须用真实逐笔成交，没有数据就不猜方向。' },
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
  selected: { doubleTop: true, doubleBottom: true, keyLevels: true, smartMoney: false, keyLevelScenario: true, bullTrap: true, bearTrap: true, cvdDivergence: false, deltaImpulse: true, retest: false, keyLevelFlow: true },
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
  /**
   * false = 只在侧栏「最近标记」里列出，不画到图上。
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
