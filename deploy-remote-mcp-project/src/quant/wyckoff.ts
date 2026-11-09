// Wyckoff-inspired price/volume CANDIDATES and three-candle FVG zones.
// This is not a certification of Wyckoff's full schematic method. Phase labels
// are conservative descriptions; public data cannot identify the Composite Man.
import type { Ctx } from './context';
import { findSwingLevels } from './orderflow';
import { findFvgs, type FvgZone } from './smartmoney';

const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
const RIGHT_CONFIRM_BARS = 5;
const FRESH_SPRING_BARS = 32;

export interface EffortResult {
  window: { from: number; to: number; bars: number };
  /** Sum(turnover) / sum(prior-20-bar turnover baseline); null when unavailable. */
  effort: number | null;
  /** Mean true range in the window / PRIOR ATR baseline. */
  result: number | null;
  effPerResult: number | null;
  netMoveAtr: number | null;
  status: 'markup' | 'markdown' | 'absorption' | 'churn' | 'quiet' | 'unknown';
  reason: string;
}

export interface SpringEvent {
  kind: 'spring' | 'upthrust';
  idx: number;
  ts: number;
  ageBars: number;
  level: number;
  depthAtr: number;
  reclaimed: boolean;
  effortRatio: number | null;
  taker: number | null;
  quality: 'strong' | 'moderate' | 'weak';
  reason: string;
}

export interface WyckoffFvg extends FvgZone {
  fromTs: number;
  toTs: number;
}

export interface WyckoffRead {
  effort: EffortResult;
  springs: SpringEvent[];
  phase: 'accumulation' | 'distribution' | 'markup' | 'markdown' | 'balance' | 'unknown';
  phaseReason: string;
  imbalances: WyckoffFvg[];
  bias: 1 | -1 | 0;
  strength: number;
}

const avg = (arr: readonly number[], from: number, to: number) => {
  let sum = 0, count = 0;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) {
    if (!Number.isFinite(arr[i])) continue;
    sum += arr[i];
    count++;
  }
  return count ? sum / count : 0;
};

const unknownEffort = (from: number, to: number, reason: string): EffortResult => ({
  window: { from, to, bars: Math.max(0, to - from + 1) },
  effort: null, result: null, effPerResult: null, netMoveAtr: null, status: 'unknown', reason,
});

/** Effort is measured against prior baselines, not against a window that contains itself. */
export function effortResult(ctx: Ctx, windowBars = 96): EffortResult {
  const { cs, n, atr, vols, volMa } = ctx;
  const to = n - 1;
  if (to < 19) return unknownEffort(0, to, '至少需要 20 根已收盘 K 线建立 prior ATR / 成交量基线。');
  const width = Number.isFinite(windowBars) ? Math.max(2, Math.floor(windowBars)) : 96;
  const from = Math.max(14, n - width);
  if (from > to) return unknownEffort(from, to, '基线之后没有可用观察窗口。');
  const baselineAtr = avg(atr, from - 14, from - 1);
  let expectedTurnover = 0, turnover = 0, trueRange = 0;
  for (let i = from; i <= to; i++) {
    expectedTurnover += volMa[i];
    turnover += vols[i];
    const c = cs[i], p = cs[i - 1];
    trueRange += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  if (!(baselineAtr > 0) || !(expectedTurnover > 0) || !(turnover > 0)) {
    return unknownEffort(from, to, ' prior ATR 或成交量基线为零/缺失；不以 1× 或 0 伪造努力/结果。');
  }
  const effort = turnover / expectedTurnover;
  const result = trueRange / (to - from + 1) / baselineAtr;
  const netMove = (cs[to].c - cs[from].o) / baselineAtr;
  const effPerResult = result > 0 ? effort / result : null;
  let status: EffortResult['status'];
  let reason: string;
  if (effort < 0.85) {
    status = 'quiet';
    reason = `成交额为 prior 基线 ${effort.toFixed(2)}×：参与度偏低。`;
  } else if (effort >= 1.25 && result <= 1.1 && Math.abs(netMove) <= 0.75) {
    status = 'absorption';
    reason = `成交额 ${effort.toFixed(2)}×，但平均真区间 ${result.toFixed(2)}× prior ATR、净推进 ${netMove.toFixed(2)} ATR：努力未换来窄幅推进，吸收候选；不证明被动挂单身份。`;
  } else if (Math.abs(netMove) >= 1.5) {
    status = netMove > 0 ? 'markup' : 'markdown';
    reason = `成交额 ${effort.toFixed(2)}×、净推进 ${netMove.toFixed(2)} ATR：窗口内出现明显${netMove > 0 ? '向上' : '向下'}结果。`;
  } else {
    status = 'churn';
    reason = `成交额 ${effort.toFixed(2)}×、净推进 ${netMove.toFixed(2)} ATR：换手存在但方向推进不足；不能仅凭往返净位移为零断言吸收。`;
  }
  return { window: { from, to, bars: to - from + 1 }, effort: r3(effort), result: r3(result), effPerResult: effPerResult == null ? null : r3(effPerResult), netMoveAtr: r3(netMove), status, reason };
}

/** First confirmed post-pivot reclaim; a prior close through the level consumes it. */
export function findSprings(ctx: Ctx, lookback = 160, minDepthAtr = 0.2): SpringEvent[] {
  const { cs, n } = ctx;
  const to = n - 1;
  if (to < 1) return [];
  const horizon = Math.max(1, Math.floor(lookback));
  const levels = findSwingLevels(ctx).filter(l => l.idx + RIGHT_CONFIRM_BARS <= to && to - l.idx <= horizon + 60);
  const out: SpringEvent[] = [];
  for (const lv of levels) {
    const confirmedIdx = lv.idx + RIGHT_CONFIRM_BARS;
    if (lv.breakIdx != null && lv.breakIdx <= confirmedIdx) continue;
    const start = Math.max(confirmedIdx + 1, to - horizon + 1);
    if (start > to) continue;
    const top = lv.side === 'top';
    for (let q = start; q <= to; q++) {
      const c = cs[q];
      const a = ctx.atr[q] > 0 ? ctx.atr[q] : Math.max(Number.EPSILON, c.c * 0.001);
      const closeBeyond = top ? c.c > lv.price + 0.1 * a : c.c < lv.price - 0.1 * a;
      if (closeBeyond) break;
      const pierce = top ? c.h - lv.price : lv.price - c.l;
      const reclaimed = top ? c.c < lv.price : c.c > lv.price;
      if (pierce < minDepthAtr * a || !reclaimed) continue;
      const depth = pierce / a;
      const effortRatio = ctx.volMa[q] > 0 ? ctx.vols[q] / ctx.volMa[q] : null;
      const taker = ctx.real[q] === 1 && ctx.vols[q] > 0 ? r3(ctx.delta[q] / ctx.vols[q]) : null;
      // Explicit heuristic emphasis; not a calibrated probability or win rate.
      let score = Math.min(1, depth / 0.6) * 0.5 + 0.2;
      if (effortRatio != null) score += Math.max(0, Math.min(1, (effortRatio - 1) / 1.5)) * 0.2;
      if (taker != null && (top ? taker < -0.08 : taker > 0.08)) score += 0.1;
      const quality: SpringEvent['quality'] = score >= 0.7 ? 'strong' : score >= 0.45 ? 'moderate' : 'weak';
      const kind = top ? 'upthrust' : 'spring';
      out.push({
        kind, idx: q, ts: c.ts, ageBars: to - q, level: lv.price, depthAtr: r3(depth), reclaimed,
        effortRatio: effortRatio == null ? null : r3(effortRatio), taker, quality,
        reason: `${top ? '冲上前高' : '刺穿前低'} ${depth.toFixed(2)} ATR 后收盘收回：${top ? '上冲回落' : '弹簧'}候选${effortRatio != null ? `，成交额 ${effortRatio.toFixed(1)}×` : '，成交量基线缺失'}。仍需交易区间与后续测试确认。`,
      });
      break;
    }
  }
  const seen = new Set<string>();
  return out.filter(s => {
    const key = `${s.idx}:${s.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.idx - a.idx || b.depthAtr - a.depthAtr).slice(0, 4);
}

/** Conservative phase candidate: a lone old spring cannot relabel an entire trend. */
export function classifyPhase(ctx: Ctx, lookback = 160, springs = findSprings(ctx, lookback)): { phase: WyckoffRead['phase']; reason: string } {
  const { cs } = ctx;
  const to = ctx.n - 1;
  const levels = findSwingLevels(ctx).filter(l => l.idx + RIGHT_CONFIRM_BARS <= to && to - l.idx <= lookback + 60);
  const tops = levels.filter(l => l.side === 'top').sort((a, b) => a.idx - b.idx);
  const bots = levels.filter(l => l.side === 'bottom').sort((a, b) => a.idx - b.idx);
  const lastTop = tops.at(-1), prevTop = tops.at(-2), lastBot = bots.at(-1), prevBot = bots.at(-2);
  if (!lastTop || !prevTop || !lastBot || !prevBot) return { phase: 'unknown', reason: '已确认摆动高低点不足，无法描述阶段。' };
  const a = ctx.atr[to] > 0 ? ctx.atr[to] : Math.max(Number.EPSILON, ctx.cs[to].c * 0.001);
  const tol = 0.1 * a;
  const hh = lastTop.price > prevTop.price + tol, hl = lastBot.price > prevBot.price + tol;
  const lh = lastTop.price < prevTop.price - tol, ll = lastBot.price < prevBot.price - tol;
  const brokenLow = cs.some((c, i) => i > lastBot.idx + RIGHT_CONFIRM_BARS && c.c < lastBot.price - tol);
  const brokenHigh = cs.some((c, i) => i > lastTop.idx + RIGHT_CONFIRM_BARS && c.c > lastTop.price + tol);
  if (hh && hl && !brokenLow) return { phase: 'markup', reason: '已确认 HH/HL 上涨结构。单次上冲不足以证明分发，需先形成区间与后续测试。' };
  if (lh && ll && !brokenHigh) return { phase: 'markdown', reason: '已确认 LH/LL 下跌结构。单次弹簧不足以证明吸筹，需先形成区间与后续测试。' };
  if ((hh && hl && brokenLow) || (lh && ll && brokenHigh)) return { phase: 'balance', reason: '最近确认的防守摆动已被后续收盘破坏；旧趋势标签失效，等待新的结构序列。' };
  const fresh = springs.find(s => s.ageBars <= FRESH_SPRING_BARS);
  const rangeHigh = Math.max(...tops.map(l => l.price));
  const rangeLow = Math.min(...bots.map(l => l.price));
  if (fresh?.kind === 'spring' && Math.abs(fresh.level - rangeLow) <= 0.5 * a && fresh.effortRatio != null) {
    return { phase: 'accumulation', reason: `非单边下跌结构中，${fresh.ageBars} 根前出现区间下沿弹簧收回，并有量价背景：吸筹候选；尚未验证完整 Wyckoff 阶段序列。` };
  }
  if (fresh?.kind === 'upthrust' && Math.abs(fresh.level - rangeHigh) <= 0.5 * a && fresh.effortRatio != null) {
    return { phase: 'distribution', reason: `非单边上涨结构中，${fresh.ageBars} 根前出现区间上沿上冲回落，并有量价背景：分发候选；尚未验证完整 Wyckoff 阶段序列。` };
  }
  return { phase: 'balance', reason: fresh ? '有弹簧/上冲候选，但缺少足够新的区间边缘量价背景；保持均衡描述。' : '高低点未形成连续同向结构，且没有足够新的区间边缘弹簧/上冲证据。' };
}

export function readWyckoff(ctx: Ctx, windowBars = 96, fvgLookback = 160): WyckoffRead {
  const to = ctx.n - 1;
  const effort = effortResult(ctx, windowBars);
  const springs = findSprings(ctx, fvgLookback);
  const { phase, reason: phaseReason } = classifyPhase(ctx, fvgLookback, springs);
  // findFvgs' `from` is the THIRD candle index. Shift by two so the entire
  // three-candle formation stays inside the requested lookback window.
  const windowStart = Math.max(0, to - Math.max(3, fvgLookback) + 1);
  const imbalances: WyckoffFvg[] = findFvgs(ctx, Math.max(2, windowStart + 2), to, to)
    .filter(z => !z.filled).sort((a, b) => b.to - a.to).slice(0, 6)
    .map(z => ({ ...z, fromTs: ctx.cs[z.from]?.ts ?? ctx.cs[to].ts, toTs: ctx.cs[z.to]?.ts ?? ctx.cs[to].ts }));
  let bias: 1 | -1 | 0 = 0;
  let strength = 0;
  if (phase === 'markup' || phase === 'accumulation') bias = 1;
  else if (phase === 'markdown' || phase === 'distribution') bias = -1;
  if (bias) {
    strength = phase === 'markup' || phase === 'markdown' ? 0.4 : 0.35;
    const fresh = springs[0];
    if (fresh && fresh.ageBars <= FRESH_SPRING_BARS && (fresh.kind === 'spring' ? 1 : -1) === bias && fresh.quality === 'strong') strength += 0.1;
  }
  // Absorption by itself has no direction; never invent one from an unrelated spring.
  return { effort, springs, phase, phaseReason, imbalances, bias, strength: r3(Math.min(1, strength)) };
}
