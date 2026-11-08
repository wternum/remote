/**
 * Deterministic price-action RESEARCH layer (plan.md §§3–7, 10–11).
 * Not the legacy M/W engine, not Brooks' full discretionary method, not an order router.
 * All decisions at bar i use bars[0..i] only. A setup is placed AFTER i closes;
 * the earliest fill is i+1. Unresolved/ambiguous OHLC paths are excluded from wins.
 */
import type { Candle, Side } from '../lib/types';

export const PRICE_ACTION_RULES = 'price-action-research-v1' as const;
export interface PriceActionOptions {
  barMs: number;
  tickSz: number;
  feeRate: number;
  slipRate: number;
  maxHold: number;
  minBars: number;
  requireConfirmed: boolean;
  now: number;
}
export const DEFAULT_PA_OPTIONS: PriceActionOptions = {
  barMs: 300_000, tickSz: 0.1, feeRate: 0.0005, slipRate: 0.0001,
  maxHold: 12, minBars: 60, requireConfirmed: true, now: 0,
};
export type Bias = 'bull' | 'bear' | 'mixed' | 'unknown';
export interface BarAssessment {
  ts: number; closeTime: number; index: number;
  bodyRatio: number; closePosition: number; upperWickRatio: number; lowerWickRatio: number;
  overlapRatio: number; inside: boolean; outside: boolean; doji: boolean;
  ema20: number | null; emaGap: 'above' | 'below' | null; emaTouch: boolean;
  untouchedEmaBars: number; firstEmaTouchAfter20: boolean;
  context: Bias;
  attempt: { side: Side; count: number } | null;
  facts: string[];
}
export interface ResearchPlan {
  id: string; side: Side; attempt: number; signalTs: number; signalCloseTime: number;
  entry: number; stop: number; target: number; expiresAfterTs: number;
  risk: number; breakEvenWinRate: number | null; warnings: string[];
}
export type ReplayStatus = 'expired' | 'skipped_gap' | 'skipped_target' | 'ambiguous' | 'open' | 'tp' | 'sl' | 'time';
export interface ReplayResult {
  planId: string; status: ReplayStatus; entryTs: number | null; exitTs: number | null;
  fill: number | null; exit: number | null; netR: number | null; costR: number | null;
  note: string;
}
export interface DataQuality {
  input: number; invalid: number; duplicates: number; forming: number; unconfirmed: number;
  estimatedVolume: number; missingBars: number; excludedBeforeGap: number;
  accepted: number; contiguous: boolean; usable: boolean; issues: string[];
}
export interface ReplaySummary {
  setups: number; triggered: number; resolved: number; ambiguous: number; open: number;
  expired: number; skipped: number; wins: number; losses: number; flat: number;
  winRate: number | null; avgR: number | null; totalR: number; maxDrawdownR: number;
}
export interface PriceActionReport {
  rules: typeof PRICE_ACTION_RULES; fingerprint: string; options: PriceActionOptions;
  quality: DataQuality; fromTs: number | null; toTs: number | null;
  bars: BarAssessment[]; plans: ResearchPlan[]; results: ReplayResult[];
  summary: ReplaySummary; latestPlan: ResearchPlan | null; causalPrefixCheck: boolean;
  limitations: string[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validBar = (c: Candle) => c && [c.ts, c.o, c.h, c.l, c.c, c.v].every(finite) &&
  Number.isSafeInteger(c.ts) && c.ts > 0 && Math.min(c.o, c.h, c.l, c.c) > 0 && c.v >= 0 &&
  c.h >= c.l && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c);
const closed = (c: Candle, o: PriceActionOptions) => c.confirm === 1 ||
  (!o.requireConfirmed && c.confirm !== 0 && c.ts + o.barMs + 1500 <= o.now);

export function normalizeOptions(input: Partial<PriceActionOptions> = {}): PriceActionOptions {
  const o = { ...DEFAULT_PA_OPTIONS, ...input };
  if (![o.barMs, o.tickSz, o.feeRate, o.slipRate, o.maxHold, o.minBars, o.now].every(finite) ||
      o.barMs < 60_000 || o.barMs > 86_400_000 || o.tickSz <= 0 || o.feeRate < 0 || o.feeRate > 0.01 ||
      o.slipRate < 0 || o.slipRate > 0.01 || !Number.isInteger(o.maxHold) || o.maxHold < 1 || o.maxHold > 288 ||
      !Number.isInteger(o.minBars) || o.minBars < 30 || o.minBars > 1000 || o.now < 0) throw new Error('Invalid price-action options');
  return o;
}

export function auditCandles(input: readonly Candle[], options: PriceActionOptions): { candles: Candle[]; quality: DataQuality } {
  const q: DataQuality = { input: input.length, invalid: 0, duplicates: 0, forming: 0, unconfirmed: 0,
    estimatedVolume: 0, missingBars: 0, excludedBeforeGap: 0, accepted: 0, contiguous: true, usable: false, issues: [] };
  const map = new Map<number, Candle>();
  for (const c of input) {
    if (!validBar(c)) { q.invalid++; continue; }
    if (c.confirm === 0) { q.forming++; continue; }
    if (!closed(c, options)) { q.unconfirmed++; continue; }
    if (c.volumeSource && c.volumeSource !== 'quote') q.estimatedVolume++;
    const old = map.get(c.ts);
    if (old) {
      q.duplicates++;
      // Conflicting duplicates are never silently resolved by arrival order.
      if (old.o !== c.o || old.h !== c.h || old.l !== c.l || old.c !== c.c) { map.delete(c.ts); q.invalid++; }
      continue;
    }
    map.set(c.ts, c);
  }
  let candles = [...map.values()].sort((a, b) => a.ts - b.ts);
  let start = 0;
  for (let i = 1; i < candles.length; i++) {
    const steps = (candles[i].ts - candles[i - 1].ts) / options.barMs;
    if (steps !== 1) { q.missingBars += Number.isInteger(steps) && steps > 1 ? steps - 1 : 1; q.contiguous = false; start = i; }
  }
  q.excludedBeforeGap = start;
  candles = candles.slice(start);
  q.accepted = candles.length;
  q.usable = candles.length >= options.minBars;
  if (q.invalid) q.issues.push(`${q.invalid} 根非法或冲突 K 线已排除`);
  if (q.duplicates) q.issues.push(`${q.duplicates} 根重复时间戳`);
  if (q.forming || q.unconfirmed) q.issues.push(`${q.forming + q.unconfirmed} 根未确认收盘，不参与研究`);
  if (!q.contiguous) q.issues.push(`存在时间缺口，仅使用最近连续 ${candles.length} 根`);
  if (q.estimatedVolume) q.issues.push(`${q.estimatedVolume} 根成交额为估算/合成；本研究只使用 OHLC，不据此验证订单流`);
  if (!q.usable) q.issues.push(`连续已收盘样本不足 ${options.minBars} 根`);
  return { candles, quality: q };
}

/** SMA seed then recursive EMA; no centered window and no future seed. */
export function emaSeries(candles: readonly Candle[], period = 20): (number | null)[] {
  let sum = 0, ema: number | null = null;
  const k = 2 / (period + 1);
  return candles.map((c, i) => {
    sum += c.c;
    if (i >= period) sum -= candles[i - period].c;
    if (i === period - 1) ema = sum / period;
    else if (i >= period && ema !== null) ema = c.c * k + ema * (1 - k);
    return ema;
  });
}

export function assessBars(cs: readonly Candle[], options: PriceActionOptions): BarAssessment[] {
  const ema = emaSeries(cs);
  let anchorHigh = cs[0]?.h ?? 0, anchorLow = cs[0]?.l ?? 0;
  let hCount = 0, lCount = 0, hArmed = false, lArmed = false, untouched = 0;
  const out: BarAssessment[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1], e = ema[i];
    const range = Math.max(c.h - c.l, options.tickSz);
    const body = Math.abs(c.c - c.o), bodyRatio = body / range;
    const overlap = p ? Math.max(0, Math.min(c.h, p.h) - Math.max(c.l, p.l)) / range : 0;
    const slope = i >= 24 && e !== null && ema[i - 5] !== null ? e - ema[i - 5]! : 0;
    // A pullback may cross the EMA; requiring close above it would erase valid H2
    // research setups. This intentionally simple bias uses the 5-bar EMA slope.
    const context: Bias = e === null || i < 24 ? 'unknown' : slope > options.tickSz ? 'bull' : slope < -options.tickSz ? 'bear' : 'mixed';
    let attempt: BarAssessment['attempt'] = null;
    if (p) {
      // A new trend extreme resets the correction. A lower-high/higher-low arms
      // the NEXT resume attempt; consecutive higher-highs are not new H counts.
      if (c.h > anchorHigh) { anchorHigh = c.h; hCount = 0; hArmed = false; }
      else if (c.h < p.h) hArmed = true;
      else if (hArmed && c.h > p.h) { hCount++; hArmed = false; attempt = { side: 'long', count: hCount }; }
      if (c.l < anchorLow) { anchorLow = c.l; lCount = 0; lArmed = false; }
      else if (c.l > p.l) lArmed = true;
      else if (lArmed && c.l < p.l) { lCount++; lArmed = false; attempt = { side: 'short', count: lCount }; }
    }
    const emaGap = e === null ? null : c.h < e ? 'below' : c.l > e ? 'above' : null;
    const emaTouch = e !== null && c.l <= e && c.h >= e;
    untouched = emaGap ? untouched + 1 : 0;
    const firstEmaTouchAfter20 = emaTouch && i > 0 && out[i - 1].untouchedEmaBars >= 20;
    const inside = !!p && c.h <= p.h && c.l >= p.l;
    const outside = !!p && c.h > p.h && c.l < p.l;
    const doji = bodyRatio <= 0.1;
    const facts = [doji ? '小实体/Doji（工程阈值：实体≤10%）' : c.c >= c.o ? '阳线实体' : '阴线实体'];
    if (inside) facts.push('内包：停顿，不单独判方向');
    if (outside) facts.push('外包：双向扩张，需后续触发');
    if (overlap >= 0.7) facts.push('与前棒高度重叠');
    if (emaGap) facts.push(`整棒位于 EMA ${emaGap === 'below' ? '下' : '上'}方（均线缺口棒）`);
    if (firstEmaTouchAfter20) facts.push('连续≥20根未触 EMA 后首次触碰');
    if (attempt) facts.push(`${attempt.side === 'long' ? 'H' : 'L'}${attempt.count}：本棒已发生恢复尝试，不能回填成本棒入场`);
    out.push({ ts: c.ts, closeTime: c.ts + options.barMs, index: i, bodyRatio, closePosition: (c.c - c.l) / range,
      upperWickRatio: (c.h - Math.max(c.o, c.c)) / range, lowerWickRatio: (Math.min(c.o, c.c) - c.l) / range,
      overlapRatio: overlap, inside, outside, doji, ema20: e, emaGap, emaTouch, untouchedEmaBars: untouched,
      firstEmaTouchAfter20, context, attempt, facts });
    // The next bar can only be planned from the state AFTER this close.
    (out[i] as BarAssessment & { _setup?: { side: Side; count: number; anchor: number } })._setup =
      context === 'bull' && hArmed && hCount < 2 ? { side: 'long', count: hCount + 1, anchor: anchorHigh } :
      context === 'bear' && lArmed && lCount < 2 ? { side: 'short', count: lCount + 1, anchor: anchorLow } : undefined;
  }
  return out;
}

const align = (price: number, tick: number, up: boolean) => Number(((up ? Math.ceil(price / tick) : Math.floor(price / tick)) * tick).toFixed(10));
export function makePlan(c: Candle, a: BarAssessment, symbol: string, o: PriceActionOptions): ResearchPlan | null {
  const setup = (a as BarAssessment & { _setup?: { side: Side; count: number; anchor: number } })._setup;
  if (!setup) return null;
  const dir = setup.side === 'long' ? 1 : -1;
  const entry = align(setup.side === 'long' ? c.h + o.tickSz : c.l - o.tickSz, o.tickSz, setup.side === 'long');
  const stop = align(setup.side === 'long' ? c.l - o.tickSz : c.h + o.tickSz, o.tickSz, setup.side === 'short');
  const target = setup.anchor;
  const risk = (entry - stop) * dir;
  if (risk <= 0 || (target - entry) * dir <= 0 || stop <= 0) return null;
  const stopAdj = stop * (1 - dir * o.slipRate);
  const netReward = (target - entry) * dir / risk - (entry + target) * o.feeRate / risk;
  const netLoss = (entry - stopAdj) * dir / risk + (entry + stopAdj) * o.feeRate / risk;
  const warnings = ['研究架构，不是交易建议；背景分类仅为 EMA 斜率/位置的简化规则', '止损采用信号棒另一端±1 tick 的明确变体，不等同完整结构止损'];
  if (a.doji) warnings.push('信号棒为小实体，质量需另行评估');
  if (a.overlapRatio >= 0.7) warnings.push('高度重叠，可能处于窄区间');
  if (netReward <= 0) warnings.push('目标毛利不足以覆盖假设成本');
  return { id: `${symbol}|${o.barMs}|${c.ts}|${setup.side}|H/L${setup.count}`, side: setup.side, attempt: setup.count,
    signalTs: c.ts, signalCloseTime: a.closeTime, entry, stop, target, expiresAfterTs: c.ts + 2 * o.barMs,
    risk, breakEvenWinRate: netReward > 0 ? netLoss / (netReward + netLoss) : null, warnings };
}

/** One-bar stop entry; no same-bar optimistic TP assumption; unresolved paths excluded. */
export function replayPlan(cs: readonly Candle[], index: number, p: ResearchPlan, o: PriceActionOptions): ReplayResult {
  const base: ReplayResult = { planId: p.id, status: 'expired', entryTs: null, exitTs: null, fill: null, exit: null, netR: null, costR: null, note: '下一根未触发，订单到期' };
  const next = cs[index + 1];
  if (!next) return { ...base, status: 'open', note: '尚无下一根已收盘 K 线' };
  const dir = p.side === 'long' ? 1 : -1;
  if ((next.o - p.stop) * dir <= 0) return { ...base, status: 'skipped_gap', note: '开盘已越过失效价，不追单' };
  if ((next.o - p.target) * dir >= 0) return { ...base, status: 'skipped_target', note: '开盘已到目标，剩余空间不足' };
  const triggered = dir > 0 ? next.h >= p.entry : next.l <= p.entry;
  if (!triggered) return base;
  const rawFill = dir > 0 ? Math.max(next.o, p.entry) : Math.min(next.o, p.entry);
  const fill = rawFill * (1 + dir * o.slipRate);
  const risk = (fill - p.stop) * dir;
  if (!(risk > 0)) return { ...base, status: 'skipped_gap', note: '滑点后风险无效' };
  const end = Math.min(index + o.maxHold, cs.length - 1);
  for (let j = index + 1; j <= end; j++) {
    const b = cs[j];
    const hitStop = dir > 0 ? b.l <= p.stop : b.h >= p.stop;
    const hitTarget = dir > 0 ? b.h >= p.target : b.l <= p.target;
    if (hitStop && hitTarget) return { ...base, status: 'ambiguous', entryTs: next.ts, fill, note: '同一 OHLC 棒同时触及止损和目标，无逐笔路径；排除胜负统计' };
    if (hitStop || hitTarget || j === end) {
      const status: ReplayStatus = hitStop ? 'sl' : hitTarget ? 'tp' : 'time';
      const rawExit = hitStop ? p.stop : hitTarget ? p.target : b.c;
      const exit = hitTarget ? rawExit : rawExit * (1 - dir * o.slipRate);
      const fee = (fill + exit) * o.feeRate / risk;
      const slipCost = (Math.abs(fill - rawFill) + Math.abs(exit - rawExit)) / risk;
      const netR = (exit - fill) * dir / risk - fee;
      return { planId: p.id, status, entryTs: next.ts, exitTs: b.ts + o.barMs, fill, exit, netR, costR: fee + slipCost,
        note: status === 'tp' ? '目标先到（限价成交假设）' : status === 'sl' ? '止损先到（含不利滑点）' : '到期收盘退出' };
    }
  }
  return { ...base, status: 'open', entryTs: next.ts, fill, note: '持仓尚未结束' };
}

export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function auditPriceAction(input: readonly Candle[], symbol: string, inputOptions: Partial<PriceActionOptions> = {}): PriceActionReport {
  const options = normalizeOptions(inputOptions);
  const { candles, quality } = auditCandles(input, options);
  const bars = quality.usable ? assessBars(candles, options) : [];
  const plans: ResearchPlan[] = [], results: ReplayResult[] = [];
  let causal = true;
  bars.forEach((a, i) => {
    const p = makePlan(candles[i], a, symbol, options);
    if (!p) return;
    plans.push(p); results.push(replayPlan(candles, i, p, options));
    const prefix = assessBars(candles.slice(0, i + 1), options).at(-1)!;
    const strip = (x: BarAssessment) => { const { index: _i, ...rest } = x as BarAssessment & { _setup?: unknown }; void _i; return rest; };
    if (JSON.stringify(strip(prefix)) !== JSON.stringify(strip(a))) causal = false;
  });
  const resolved = results.filter(r => r.netR !== null && (r.status === 'tp' || r.status === 'sl' || r.status === 'time'));
  const wins = resolved.filter(r => r.netR! > 1e-9).length, losses = resolved.filter(r => r.netR! < -1e-9).length;
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of resolved) { cum += r.netR!; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const summary: ReplaySummary = { setups: plans.length, triggered: results.filter(r => r.entryTs !== null).length,
    resolved: resolved.length, ambiguous: results.filter(r => r.status === 'ambiguous').length,
    open: results.filter(r => r.status === 'open').length, expired: results.filter(r => r.status === 'expired').length,
    skipped: results.filter(r => r.status.startsWith('skipped')).length, wins, losses, flat: resolved.length - wins - losses,
    winRate: resolved.length ? wins / resolved.length : null, avgR: resolved.length ? cum / resolved.length : null,
    totalR: cum, maxDrawdownR: maxDD };
  const canonicalOptions = { ...options, now: options.requireConfirmed ? 0 : options.now };
  return { rules: PRICE_ACTION_RULES, fingerprint: fingerprint({ candles, options: canonicalOptions, symbol }), options, quality,
    fromTs: candles[0]?.ts ?? null, toTs: candles.at(-1)?.ts ?? null, bars, plans, results, summary,
    latestPlan: plans.at(-1) ?? null, causalPrefixCheck: causal,
    limitations: ['独立研究回放，可与旧 M/W 引擎结果不同；不是 Brooks 全套方法的认证实现',
      '背景/Doji 阈值为公开工程参数，不是胜率；重叠候选是独立实验，不是可同时执行的账户组合',
      '同棒止盈止损先后不明则排除；未计资金费率、真实排队、部分成交、冲击成本与杠杆/强平',
      '样本内描述统计，不是样本外验证或未来收益承诺'] };
}
