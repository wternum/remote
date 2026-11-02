import type { Candle, PatternId, Side } from '@/lib/types';
import {
  DEFAULT_PARAMS,
  FEE_RATE,
  SLIP_RATE,
  MAX_HOLD_5M,
  MAX_HOLD_15M,
  atrSeries,
  approxDeltaAt,
  scanDoubles,
  type ScanSignal,
} from '../../remote/setup-mcp-project-locally/src/lib/engine';
import { FACTORS, FACTOR_INDEX, clamp, scoreEvidence, gradeOf, type FactorKey } from './model';
import type { EntryMode } from './config';

export interface LiveFlow {
  /** 十档盘口失衡度 -1..1 */
  bookImb?: number | null;
  /** 大单主动成交偏向 -1..1 */
  bigBias?: number | null;
  /** 确认K成交量 / 近 20 根均量 */
  volRatio?: number | null;
}

export interface Outcome {
  filled: boolean;
  /** 未成交为 gap；成交为 tp / sl / time / be（保本离场） */
  why: string;
  entryPrice: number;
  entryTs: number;
  exitPrice: number;
  exitTs: number;
  r: number;
  pnlPct: number;
  holdingBars: number;
  costR: number;
}

export interface Candidate {
  id: string;
  idx: number;
  ts: number;
  side: Side;
  pattern: PatternId;
  mode: EntryMode;
  level: number;
  neck: number;
  firstTs: number;
  secondTs: number;
  entry: number;
  stop: number;
  tp: number;
  /** 原项目的结构强度 0-100 */
  structure: number;
  proba: number;
  grade: 'A' | 'B' | 'C' | 'D';
  evidence: (number | null)[];
  /** 出网时可省略：由 evidence × weight × gain 还原 */
  parts?: number[];
  tags: string[];
  note: string;
  rr: number;
  heightAtr: number;
  spanBars: number;
  live: boolean;
  sym?: string;
  bar?: string;
  outcome: Outcome | null;
  /** 五种出场方案的结果一次算好，面板切换方案时无需再请求 */
  exits?: Partial<Record<ExitPlan, Outcome | null>>;
}

export interface ScanPayload {
  symbol: string;
  bar: string;
  live: boolean;
  from: number;
  to: number;
  bars: number;
  lastTs: number;
  generatedAt: number;
  barMs: number;
  maxHold: number;
  factors: { key: FactorKey; label: string; short: string; hint: string; group: string; weight: number; liveOnly: boolean }[];
  confirm: Candidate[];
  touch: Candidate[];
  model: { base: number; gain: number };
}

const r6 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(v >= 1000 ? 2 : 6)) : 0);
const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
const r1 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(1)) : 0);

export interface Ctx {
  cs: Candle[];
  n: number;
  atr: number[];
  delta: number[];
  vols: number[];
  ema20: number[];
  ema50: number[];
  volMa: number[];
  index: Map<number, number>;
}

function emaSeries(cs: Candle[], period: number) {
  const k = 2 / (period + 1);
  const out = new Array<number>(cs.length);
  let e = cs[0]?.c ?? 0;
  for (let i = 0; i < cs.length; i++) {
    e = i === 0 ? cs[i].c : cs[i].c * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function buildContext(cs: Candle[]): Ctx {
  const n = cs.length;
  const atr = atrSeries(cs);
  const delta = new Array<number>(n);
  const vols = new Array<number>(n);
  const volMa = new Array<number>(n).fill(0);
  const index = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    delta[i] = approxDeltaAt(cs, i);
    vols[i] = cs[i].v;
    index.set(cs[i].ts, i);
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    let m = 0;
    for (let q = Math.max(0, i - 20); q < i; q++) {
      s += cs[q].v;
      m++;
    }
    volMa[i] = m ? s / m : cs[i].v;
  }
  return { cs, n, atr, delta, vols, ema20: emaSeries(cs, 20), ema50: emaSeries(cs, 50), volMa, index };
}

const sum = (arr: number[], from: number, to: number) => {
  let s = 0;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) s += arr[i];
  return s;
};

interface Pivot {
  prior: number;
  first: number;
  neck: number;
  second: number;
  level: number;
  neckPrice: number;
  secondPrice: number;
}

/** 从信号几何里取出「起涨/跌点 · 一顶(底) · 颈线 · 二顶(底)」的索引与价格 */
function pivotOf(ctx: Ctx, sig: ScanSignal): Pivot {
  const pts = sig.geo?.pts ?? [];
  const at = (label: string) => pts.find(p => p.label.includes(label));
  const priorPt = at('起');
  const firstPt = at('一');
  const neckPt = at('颈线');
  const secondPt = at('二');
  const idxOf = (ts: number, fallback: number) => ctx.index.get(ts) ?? fallback;
  const i = sig.idx;
  const prior = idxOf(priorPt?.ts ?? -1, Math.max(0, i - 140));
  const first = idxOf(firstPt?.ts ?? -1, Math.max(0, i - 60));
  const neck = idxOf(neckPt?.ts ?? -1, Math.max(first + 1, i - 12));
  const second = idxOf(secondPt?.ts ?? -1, i);
  return {
    prior,
    first,
    neck,
    second: Math.max(first, second),
    level: firstPt?.price ?? (ctx.cs[first]?.c ?? sig.entry),
    neckPrice: neckPt?.price ?? sig.tp,
    secondPrice: secondPt?.price ?? sig.entry,
  };
}

/**
 * 计算 14 个因子的证据值。
 * dir = +1（做多双底）/ -1（做空双顶），所有方向性因子统一按 dir 归一，
 * 因此模型对两侧使用同一套权重，不额外拟合。
 */
export function collectEvidence(ctx: Ctx, sig: ScanSignal, live?: LiveFlow): (number | null)[] {
  const { cs, n, atr, delta, vols, ema20, ema50, volMa } = ctx;
  const i = Math.min(sig.idx, n - 1);
  const a = Math.max(atr[i] || 0, 1e-9);
  const pv = pivotOf(ctx, sig);
  const dir = sig.side === 'long' ? 1 : -1;
  const out: (number | null)[] = new Array(FACTORS.length).fill(null);

  // 两腿区间（进入第一极值 / 进入第二极值）
  let l1a = Math.min(pv.prior, pv.first);
  let l1b = Math.max(pv.prior, pv.first);
  let l2a = Math.min(pv.neck, pv.second);
  let l2b = Math.max(pv.neck, pv.second);
  if (l1b - l1a < 2) {
    l1a = Math.max(0, pv.first - 24);
    l1b = pv.first;
  }
  if (l2b - l2a < 2) {
    l2a = Math.max(pv.first + 1, pv.second - 24);
    l2b = pv.second;
  }

  const set = (key: FactorKey, v: number | null) => {
    out[FACTOR_INDEX[key]] = v == null || !Number.isFinite(v) ? null : clamp(v);
  };

  // 1) 二次测试缩量：单位根成交量对比
  const v1 = sum(vols, l1a, l1b) / Math.max(1, l1b - l1a + 1);
  const v2 = sum(vols, l2a, l2b) / Math.max(1, l2b - l2a + 1);
  set('volDiverge', v1 + v2 > 0 ? ((v1 - v2) / ((v1 + v2) / 2)) * 1.1 : 0);

  // 2) 主动成交差背离
  const vol1 = Math.max(1e-9, sum(vols, l1a, l1b));
  const vol2 = Math.max(1e-9, sum(vols, l2a, l2b));
  const r1 = sum(delta, l1a, l1b) / vol1;
  const r2 = sum(delta, l2a, l2b) / vol2;
  set('deltaDiverge', (r2 - r1) * dir * 6);

  // 3) 关键位吸收（测试窗口 i..i）
  const from = Math.max(0, Math.min(pv.second, i));
  const to = Math.min(n - 1, Math.max(i, pv.second));
  let absorb = 0;
  let breach = 0;
  let sweepReclaim = false;
  let deepest = cs[from];
  for (let q = from; q <= to; q++) {
    const c = cs[q];
    const avg = volMa[q] > 0 ? volMa[q] : c.v || 1;
    if (dir > 0) {
      if (c.l <= pv.level + 0.1 * a && c.c >= pv.level + 0.25 * a && c.v >= avg * 1.1) absorb++;
      if (c.c < pv.level - 0.2 * a) breach++;
      if (c.l < pv.level - 0.05 * a && c.c >= pv.level) sweepReclaim = true;
      if (!deepest || c.l < deepest.l) deepest = c;
    } else {
      if (c.h >= pv.level - 0.1 * a && c.c <= pv.level - 0.25 * a && c.v >= avg * 1.1) absorb++;
      if (c.c > pv.level + 0.2 * a) breach++;
      if (c.h > pv.level + 0.05 * a && c.c <= pv.level) sweepReclaim = true;
      if (!deepest || c.h > deepest.h) deepest = c;
    }
  }
  set('absorption', (absorb - breach) / 2);

  // 4) 拒绝影线 + 确认K收盘位置
  const dr = Math.max(1e-9, deepest.h - deepest.l);
  const tail = dir > 0 ? (Math.min(deepest.o, deepest.c) - deepest.l) / dr : (deepest.h - Math.max(deepest.o, deepest.c)) / dr;
  const cb = cs[i];
  const cRange = Math.max(1e-9, cb.h - cb.l);
  const closePos = (cb.c - cb.l) / cRange;
  set('wickReject', (tail - 0.3) * 1.8 + (dir > 0 ? closePos - 0.5 : 0.5 - closePos) * 1.6);

  // 5-7) 仅实时可得的订单流因子
  if (live) {
    set('thrustVolume', live.volRatio == null ? null : ((live.volRatio || 0) - 1) / 1.0);
    set('bookImbalance', live.bookImb == null ? null : (live.bookImb || 0) * 2 * dir);
    set('tapeBias', live.bigBias == null ? null : (live.bigBias || 0) * 1.5 * dir);
  }

  // 8) 关键位完整度：测试次数、期间是否收盘击穿、扫损回收
  let touches = 0;
  let broken = false;
  for (let q = Math.max(0, pv.first); q <= to; q++) {
    const c = cs[q];
    const extreme = dir > 0 ? c.l : c.h;
    if (Math.abs(extreme - pv.level) <= 0.25 * a) touches++;
    if (dir > 0 ? c.c < pv.level - 0.15 * a : c.c > pv.level + 0.15 * a) broken = true;
  }
  set('levelIntegrity', 0.4 - (Math.min(touches, 5) - 2) * 0.3 + (sweepReclaim ? 0.35 : 0) - (broken ? 0.6 : 0));

  // 9) 形态高度（ATR）
  const height = (pv.neckPrice - pv.level) * dir;
  const heightAtr = height / a;
  set('patternHeight', (heightAtr - 2.2) / 2.5);

  // 10) 时间跨度：对数最优区间
  const span = Math.max(1, i - pv.first);
  set('patternSpan', 1 - clamp(Math.abs(Math.log(span / 110)) / Math.log(4), 0, 1) * 2);

  // 11) 趋势衰竭度：需要“有趋势但已伸展乏力”
  // stretch > 0 = 仍在逆势推进（做多时均线空头排列）。二次测试要成立，
  // 逆势压力必须已经释放：最优在轻微转向（-0.3）附近，强逆势重罚。
  const stretch = ((ema20[i] - ema50[i]) / a) * -dir;
  set('trendExhaust', 1 - clamp(Math.abs(stretch + 0.3) / 1.9, 0, 1) * 2);

  // 12) 推进减速
  const mag1 = Math.abs(pv.level - (dir > 0 ? cs[Math.min(l1a, n - 1)]?.h ?? pv.level : cs[Math.min(l1a, n - 1)]?.l ?? pv.level));
  const slope1 = mag1 / Math.max(1, l1b - l1a);
  const slope2 = Math.abs(pv.neckPrice - pv.secondPrice) / Math.max(1, l2b - l2a);
  set('legDecel', slope2 > 0 ? (slope1 / slope2 - 1) * 0.8 : 0);

  // 13) 波动环境分位
  const look = 500;
  let below = 0;
  let seen = 0;
  for (let q = Math.max(1, i - look); q <= i; q++) {
    if (atr[q] <= 0) continue;
    seen++;
    if (atr[q] <= a) below++;
  }
  const pct = seen > 20 ? below / seen : 0.5;
  set('volRegime', 1 - clamp(Math.abs(pct - 0.6) / 0.42, 0, 1) * 1.7);

  // 14) 净盈亏比 + 成本占比
  const risk = Math.abs(sig.entry - sig.stop);
  const rr = risk > 0 ? Math.abs(sig.tp - sig.entry) / risk : 0;
  const costDrag = sig.entry > 0 && risk > 0 ? (Math.abs(sig.entry) * 2 * (FEE_RATE + SLIP_RATE)) / risk : 9;
  // 预测胜率：目标越近越容易兑现（高 R:R 是负证据）；成本占风险过高再扣分
  set('rrQuality', clamp((2.1 - rr) / 1.1) - clamp((costDrag - 0.18) / 0.5, 0, 1) * 0.8);

  return out;
}

/** 与远程引擎完全一致的成交/离场规则，只把“是否入场”交给概率门槛 */
export function simulateOutcome(
  ctx: Ctx,
  sig: ScanSignal,
  mode: EntryMode,
  maxHold: number,
): Outcome | null {
  const { cs, n } = ctx;
  const i = sig.idx;
  if (i < 30 || i > n - 2) return null;
  const limit = mode === 'touch';
  const next = cs[i + 1];
  let entryPrice: number;
  let entryTs: number;
  if (limit) {
    entryPrice = sig.entry;
    entryTs = sig.ts;
  } else {
    if (sig.side === 'long' ? next.o <= sig.stop : next.o >= sig.stop) {
      return {
        filled: false,
        why: 'gap',
        entryPrice: 0,
        entryTs: 0,
        exitPrice: 0,
        exitTs: 0,
        r: 0,
        pnlPct: 0,
        holdingBars: 0,
        costR: 0,
      };
    }
    entryPrice = sig.side === 'long' ? next.o * (1 + SLIP_RATE) : next.o * (1 - SLIP_RATE);
    entryTs = next.ts;
  }
  let exitPrice: number | null = null;
  let exitTs = 0;
  let why: Outcome['why'] = 'time';
  let exitIdx = -1;
  const endJ = Math.min(i + maxHold, n - 1);
  for (let j = limit ? i : i + 1; j <= endJ; j++) {
    const k = cs[j];
    const hitSL = sig.side === 'long' ? k.l <= sig.stop : k.h >= sig.stop;
    const hitTP = !(limit && j === i) && (sig.side === 'long' ? k.h >= sig.tp : k.l <= sig.tp);
    if (hitSL) {
      exitPrice = sig.stop;
      why = 'sl';
    } else if (hitTP) {
      exitPrice = sig.tp;
      why = 'tp';
    }
    if (exitPrice != null) {
      exitTs = k.ts;
      exitIdx = j;
      break;
    }
  }
  if (exitPrice == null) {
    exitPrice = cs[endJ].c;
    exitTs = cs[endJ].ts;
    exitIdx = endJ;
  }
  const exitAdj = sig.side === 'long' ? exitPrice * (1 - SLIP_RATE) : exitPrice * (1 + SLIP_RATE);
  const gross = sig.side === 'long' ? exitAdj - entryPrice : entryPrice - exitAdj;
  const fee = (entryPrice + exitAdj) * FEE_RATE;
  const slipCost = (limit ? exitPrice : next.o + exitPrice) * SLIP_RATE;
  const pnl = gross - fee;
  const risk = sig.side === 'long' ? entryPrice - sig.stop : sig.stop - entryPrice;
  return {
    filled: true,
    why,
    entryPrice: r6(entryPrice),
    entryTs,
    exitPrice: r6(exitAdj),
    exitTs,
    r: r3(risk > 0 ? pnl / risk : 0),
    pnlPct: r3((pnl / entryPrice) * 100),
    holdingBars: Math.max(1, exitIdx - i),
    costR: r3(risk > 0 ? (fee + slipCost) / risk : 0),
  };
}

export function candidateFrom(
  ctx: Ctx,
  sig: ScanSignal,
  mode: EntryMode,
  maxHold: number,
  live?: LiveFlow,
  sym?: string,
  bar?: string,
  plan: ExitPlan = 'neck',
): Candidate | null {
  if (sig.idx < 30 || sig.idx > ctx.n - 1) return null;
  const evidence = collectEvidence(ctx, sig, sig.idx >= ctx.n - 1 ? live : undefined);
  const score = scoreEvidence(evidence);
  const pv = pivotOf(ctx, sig);
  const risk = Math.abs(sig.entry - sig.stop);
  const rr = risk > 0 ? Math.abs(sig.tp - sig.entry) / risk : 0;
  const outcome = simulateWithPlan(ctx, sig, mode, maxHold, plan);
  const proba = r3(score.proba);
  return {
    id: `${mode}_${sig.ts}_${sig.pattern}_${sig.side}`,
    idx: sig.idx,
    ts: sig.ts,
    side: sig.side,
    pattern: sig.pattern,
    mode,
    level: r6(pv.level),
    neck: r6(pv.neckPrice),
    firstTs: ctx.cs[pv.first]?.ts ?? sig.ts,
    secondTs: ctx.cs[pv.second]?.ts ?? sig.ts,
    entry: r6(sig.entry),
    stop: r6(sig.stop),
    tp: r6(sig.tp),
    structure: Math.round(sig.strength ?? sig.conf),
    proba,
    grade: gradeOf(proba),
    evidence: evidence.map(v => (v == null ? null : r3(v))),
    parts: score.parts.map(v => r3(v)),
    tags: sig.tags ?? [],
    note: sig.note ?? '',
    rr: r1(rr),
    heightAtr: r1((pv.neckPrice - pv.level) * (sig.side === 'long' ? 1 : -1) / Math.max(1e-9, ctx.atr[sig.idx])),
    spanBars: Math.max(0, sig.idx - pv.first),
    live: sig.idx >= ctx.n - 2,
    sym,
    bar,
    outcome,
    exits: {
      neck: plan === 'neck' ? outcome : simulateWithPlan(ctx, sig, mode, maxHold, 'neck'),
      r15: plan === 'r15' ? outcome : simulateWithPlan(ctx, sig, mode, maxHold, 'r15'),
      r10: plan === 'r10' ? outcome : simulateWithPlan(ctx, sig, mode, maxHold, 'r10'),
      be: plan === 'be' ? outcome : simulateWithPlan(ctx, sig, mode, maxHold, 'be'),
      partial: plan === 'partial' ? outcome : simulateWithPlan(ctx, sig, mode, maxHold, 'partial'),
    },
  };
}

/** 双轨扫描：confirm = 等确认K；touch = 触价即成交（原逻辑），用于同一批形态上的 A/B 对照 */
export function runScan(
  cs: Candle[],
  bar: string,
  live?: LiveFlow,
  sym?: string,
  plan: ExitPlan = 'neck',
): { confirm: Candidate[]; touch: Candidate[]; ctx: Ctx } {
  const ctx = buildContext(cs);
  const maxHold = bar === '15m' ? MAX_HOLD_15M : MAX_HOLD_5M;
  const pick = (mode: EntryMode) => {
    const p = { ...DEFAULT_PARAMS, entryMode: mode === 'touch' ? ('limit' as const) : ('confirm' as const) };
    return scanDoubles(cs, p).signals
      .map(s => candidateFrom(ctx, s, mode, maxHold, live, sym, bar, plan))
      .filter((c): c is Candidate => !!c);
  };
  return { confirm: pick('confirm'), touch: pick('touch'), ctx };
}

export function liveFlowOf(cs: Candle[], bookImb?: number | null, bigBias?: number | null): LiveFlow {
  const n = cs.length;
  if (n < 2) return { bookImb: null, bigBias: null, volRatio: null };
  let av = 0;
  let m = 0;
  for (let q = Math.max(0, n - 21); q < n - 1; q++) {
    av += cs[q].v;
    m++;
  }
  const last = cs[n - 1];
  return { bookImb: bookImb ?? null, bigBias: bigBias ?? null, volRatio: m && av > 0 ? last.v / (av / m) : null };
}

export const SCAN_BARS = (bar: string) => (bar === '15m' ? 4320 : 8640);

// ─────────────────────────────────────────────────────────────
//  出场方案：入场概率解决“做不做”，出场方案解决“赚多少”
//  双顶/双底的颈线目标常常太远，超时平仓把胜率吃掉；这里给出可对照的替代方案。
// ─────────────────────────────────────────────────────────────
export type ExitPlan = 'neck' | 'r15' | 'r10' | 'be' | 'partial';

export const EXIT_PLANS: { id: ExitPlan; label: string; hint: string }[] = [
  { id: 'neck', label: '颈线目标', hint: '原方案：目标看颈线（受 maxRR 封顶），超时按收盘价平仓' },
  { id: 'r15', label: '固定 1.5R', hint: '目标 = 入场 ± 1.5 倍风险，放弃远端颈线，换取更高兑现率' },
  { id: 'r10', label: '固定 1.0R', hint: '目标 = 入场 ± 1 倍风险，胜率最高但赔付比最低，成本占比敏感' },
  { id: 'be', label: '1R 保本', hint: '盈利达到 1R 后把止损移到成本价，剩余仓位继续看颈线，杜绝盈利单变亏损' },
  { id: 'partial', label: '1R 减半 + 保本', hint: '1R 处平掉一半并锁定成本，剩余一半跑颈线目标' },
];

/** 按指定出场方案模拟；同一根内先判止损（保守），与原引擎一致 */
export function simulateWithPlan(
  ctx: Ctx,
  sig: ScanSignal,
  mode: EntryMode,
  maxHold: number,
  plan: ExitPlan,
): Outcome | null {
  if (plan === 'neck') return simulateOutcome(ctx, sig, mode, maxHold);
  const { cs, n, atr } = ctx;
  const i = sig.idx;
  if (i < 30 || i > n - 2) return null;
  const limit = mode === 'touch';
  const next = cs[i + 1];
  const dir = sig.side === 'long' ? 1 : -1;
  let entryPrice: number;
  let entryTs: number;
  if (limit) {
    entryPrice = sig.entry;
    entryTs = sig.ts;
  } else {
    if (dir > 0 ? next.o <= sig.stop : next.o >= sig.stop) {
      return { filled: false, why: 'gap', entryPrice: 0, entryTs: 0, exitPrice: 0, exitTs: 0, r: 0, pnlPct: 0, holdingBars: 0, costR: 0 };
    }
    entryPrice = dir > 0 ? next.o * (1 + SLIP_RATE) : next.o * (1 - SLIP_RATE);
    entryTs = next.ts;
  }
  const risk = (entryPrice - sig.stop) * dir;
  if (!(risk > 0)) return null;
  const target = plan === 'r10' ? entryPrice + dir * risk : plan === 'r15' ? entryPrice + dir * 1.5 * risk : sig.tp;
  const trigger = entryPrice + dir * risk; // 1R 触发点
  const useBe = plan === 'be' || plan === 'partial';
  const half = plan === 'partial';

  let stop = sig.stop;
  let armed = false;
  let tookHalf = false;
  let lockedR = 0;
  let exitPrice: number | null = null;
  let exitTs = 0;
  let why: Outcome['why'] = 'time';
  let exitIdx = -1;
  const endJ = Math.min(i + maxHold, n - 1);
  const feePct = FEE_RATE;

  for (let j = limit ? i : i + 1; j <= endJ; j++) {
    const k = cs[j];
    const hitStop = dir > 0 ? k.l <= stop : k.h >= stop;
    const hitTrig = useBe && !armed && (dir > 0 ? k.h >= trigger : k.l <= trigger);
    const hitTarget = !(limit && j === i) && (dir > 0 ? k.h >= target : k.l <= target);

    // 保守：同根内先算止损
    if (hitStop) {
      exitPrice = stop;
      why = armed ? 'be' : 'sl';
      exitTs = k.ts;
      exitIdx = j;
      break;
    }
    if (hitTrig) {
      armed = true;
      stop = entryPrice * (1 + dir * feePct * 2); // 移到成本 + 双边手续费
      if (half && !tookHalf) {
        tookHalf = true;
        lockedR = 0.5; // 半仓在 1R 处兑现
      }
      continue;
    }
    if (hitTarget) {
      exitPrice = target;
      why = 'tp';
      exitTs = k.ts;
      exitIdx = j;
      break;
    }
  }
  if (exitPrice == null) {
    exitPrice = cs[endJ].c;
    exitTs = cs[endJ].ts;
    exitIdx = endJ;
  }
  const exitAdj = dir > 0 ? exitPrice * (1 - SLIP_RATE) : exitPrice * (1 + SLIP_RATE);
  const gross = (exitAdj - entryPrice) * dir;
  const fee = (entryPrice + exitAdj) * FEE_RATE;
  const pnl = gross - fee;
  const restR = pnl / risk;
  const r = tookHalf ? lockedR + 0.5 * restR : restR;
  void atr;
  return {
    filled: true,
    why: why === 'be' ? (r > 0 ? 'be' : 'sl') : why,
    entryPrice: r6(entryPrice),
    entryTs,
    exitPrice: r6(exitAdj),
    exitTs,
    r: r3(r),
    pnlPct: r3((pnl / entryPrice) * 100),
    holdingBars: Math.max(1, exitIdx - i),
    costR: r3((fee + (limit ? exitPrice : next.o + exitPrice) * SLIP_RATE) / risk),
  };
}
