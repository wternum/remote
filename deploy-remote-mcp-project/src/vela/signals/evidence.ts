import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import type { AnnotationPattern } from './patterns';

export interface TakerObservation {
  buy: number; sell: number; total: number; delta: number; ratio: number;
  src: 'rubik' | 'tape'; coverage: number; volRatio: number;
}

/** Never replace missing taker data with the OHLC delta stored in ctx.delta. */
export function takerObservation(ctx: Ctx, flow: FlowSnapshot | null | undefined, i: number): TakerObservation | null {
  const c = ctx.cs[i], b = c && flow?.bars.get(c.ts);
  if (!c || !b || ctx.real[i] !== 1 || !(b.buy + b.sell > 0)) return null;
  const total = b.buy + b.sell;
  return { buy: b.buy, sell: b.sell, total, delta: b.buy - b.sell, ratio: (b.buy - b.sell) / total,
    src: b.src, coverage: c.v > 0 ? total / c.v : 0, volRatio: volumeRatio(ctx, i) ?? 0 };
}
export function volumeRatio(ctx: Ctx, i: number): number | null {
  return ctx.cs[i] && ctx.volMa[i] > 0 ? ctx.cs[i].v / ctx.volMa[i] : null;
}
export interface LegFlow {
  from: number; to: number; bars: number; covered: number; complete: boolean;
  buy: number; sell: number; total: number; delta: number; ratio: number | null;
}
export function legFlow(ctx: Ctx, flow: FlowSnapshot | null | undefined, from: number, to: number, barMs: number): LegFlow {
  const start = Math.max(0, Math.min(from, to)), end = Math.min(ctx.n - 1, Math.max(from, to));
  let covered = 0, buy = 0, sell = 0, continuous = end >= start;
  for (let i = start; i <= end; i++) {
    if (i > start && ctx.cs[i].ts - ctx.cs[i - 1].ts !== barMs) continuous = false;
    const obs = takerObservation(ctx, flow, i);
    if (!obs) { continuous = false; continue; }
    covered++; buy += obs.buy; sell += obs.sell;
  }
  const bars = Math.max(0, end - start + 1), total = buy + sell;
  const complete = continuous && covered === bars && total > 0;
  return { from: start, to: end, bars, covered, complete, buy, sell, total, delta: buy - sell, ratio: complete ? (buy - sell) / total : null };
}
export function realCvdBetween(ctx: Ctx, flow: FlowSnapshot | null | undefined, first: number, second: number, barMs: number): number | null {
  if (first < 0 || second <= first || second >= ctx.n) return null;
  const interval = legFlow(ctx, flow, first, second, barMs);
  if (!interval.complete) return null;
  // First pivot is the reference point; accumulate the subsequent, fully covered bars.
  return legFlow(ctx, flow, first + 1, second, barMs).ratio;
}
export function unitVolume(ctx: Ctx, from: number, to: number): number {
  const a = Math.max(0, from), b = Math.min(ctx.n - 1, to);
  if (a > b) return 0;
  let sum = 0;
  for (let i = a; i <= b; i++) sum += ctx.cs[i].v;
  return sum / (b - a + 1);
}
export const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
export const money = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
export function observationText(name: string, o: TakerObservation | null): string {
  if (!o) return `${name}：未完整覆盖，不判断主动方向`;
  return `${name}：买 ${money(o.buy)} / 卖 ${money(o.sell)} USDT；买占 ${((1 + o.ratio) * 50).toFixed(1)}% / 卖占 ${((1 - o.ratio) * 50).toFixed(1)}%；Δ ${pct(o.ratio)}；${o.src === 'rubik' ? 'OKX 官方统计' : '逐笔聚合'}，覆盖 ${(o.coverage * 100).toFixed(1)}%`;
}

export interface MwEvidence {
  test: TakerObservation | null; confirmation: TakerObservation | null;
  firstLeg: LegFlow; secondLeg: LegFlow; cvdRatio: number | null; cvdDivergence: boolean;
  secondRatio: number | null; testVolume: number | null; confirmVolume: number | null;
  wickRatio: number; sweepAtr: number; closedInside: boolean; absorbed: boolean;
  stance: string;
  strength: { score: number; label: '较强' | '一般' | '不足' | '分歧'; positive: string[]; negative: string[]; missing: string[] };
}
/** Evidence is anchored at pattern confirmation, not at the latest candle. Scores are rule counts, never probabilities. */
export function readMwEvidence(ctx: Ctx, p: AnnotationPattern, barMs: number, flow?: FlowSnapshot | null): MwEvidence {
  const top = p.side === 'top', dir = top ? -1 : 1;
  const c = ctx.cs[p.second], confirm = ctx.cs[p.idx], atr = Math.max(ctx.atr[p.idx] || 0, 1e-9);
  const test = takerObservation(ctx, flow, p.second), confirmation = takerObservation(ctx, flow, p.idx);
  const firstLeg = legFlow(ctx, flow, p.firstLegStart, p.first, barMs);
  const secondLeg = legFlow(ctx, flow, p.secondLegStart, p.second, barMs);
  const v1 = unitVolume(ctx, p.firstLegStart, p.first), v2 = unitVolume(ctx, p.secondLegStart, p.second);
  const secondRatio = v1 > 0 && v2 > 0 ? v2 / v1 : null;
  const range = Math.max(c.h - c.l, 1e-9), closePos = (c.c - c.l) / range;
  const wickRatio = top ? (c.h - Math.max(c.o, c.c)) / range : (Math.min(c.o, c.c) - c.l) / range;
  const sweepAtr = Math.max(0, (top ? c.h - p.level : p.level - c.l) / atr);
  const closedInside = top ? confirm.c < p.level : confirm.c > p.level;
  const testVolume = volumeRatio(ctx, p.second), confirmVolume = volumeRatio(ctx, p.idx);
  const absorbed = !!test && (testVolume ?? 0) >= 2 && test.ratio * dir <= -0.15 &&
    (top ? closePos <= 0.45 && c.c <= c.o : closePos >= 0.55 && c.c >= c.o);
  const cvdRatio = realCvdBetween(ctx, flow, p.first, p.second, barMs);
  let stance = '未完整覆盖，不判断主动方向';
  if (test && confirmation) {
    const t = test.ratio * dir, k = confirmation.ratio * dir;
    stance = t >= 0.06 && k >= 0.06 ? '反转侧主动成交占优'
      : t <= -0.12 && (k >= 0.04 || (sweepAtr >= 0.05 && closedInside)) ? '推进侧成交未能站稳'
      : t <= -0.06 && k <= -0.06 ? '推进侧主动成交占优'
      : Math.abs(t) >= 0.02 && Math.abs(k) >= 0.02 && Math.sign(t) !== Math.sign(k) ? '测试与确认方向分歧'
      : '主动成交接近中性';
  } else if (test || confirmation) stance = test ? '仅测试K有真实覆盖' : '仅确认K有真实覆盖';
  const positive: string[] = [], negative: string[] = [], missing: string[] = [];
  if (secondRatio === null) missing.push('推进腿量比缺失');
  else if (secondRatio <= 0.9) positive.push('第二腿缩量');
  else if (secondRatio > 1.1) negative.push('第二腿放量，更像延续');
  if (wickRatio >= 0.35) positive.push('关键位拒绝影线');
  if (sweepAtr >= 0.05 && closedInside) positive.push('价格扫位收回');
  if ((confirmVolume ?? 0) >= 1.5) positive.push('确认K放量');
  if (test && confirmation) {
    if (test.ratio * dir >= 0.06 && confirmation.ratio * dir >= -0.02) positive.push('真实成交支持反转方向');
    if (test.ratio * dir <= -0.12 && confirmation.ratio * dir <= -0.12) negative.push('真实成交仍偏突破侧');
  } else missing.push('测试/确认K成交覆盖不全');
  if (absorbed) positive.push('放量推进但价格未跟随（吸收候选）');
  const score = positive.length - negative.length;
  const label = negative.length && positive.length ? '分歧' : score >= 3 ? '较强' : score >= 1 ? '一般' : '不足';
  return { test, confirmation, firstLeg, secondLeg, secondRatio, testVolume, confirmVolume,
    wickRatio, sweepAtr, closedInside, absorbed, cvdRatio, cvdDivergence: cvdRatio !== null && cvdRatio * dir >= 0.04,
    stance, strength: { score, label, positive, negative, missing } };
}
