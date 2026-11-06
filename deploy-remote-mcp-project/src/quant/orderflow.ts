// ─────────────────────────────────────────────────────────────
//  订单流判读：双顶/双底二次测试 · 诱多/诱空 · 突破后的回调是否可跟随
//  · 全部基于已收盘 K 线 + 每根的主动买卖差（真实优先，近似兜底）
//  · 这里只产出“证据 + 结论 + 理由”，概率由 model.ts 的证据模型 / 历史统计给出
// ─────────────────────────────────────────────────────────────
import type { Ctx } from './context';
import type { ScanSignal } from '../../remote/setup-mcp-project-locally/src/lib/engine';

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampR = (v: number, lo = -1, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;

// ─── 窗口订单流 ───────────────────────────────────────────────
export interface FlowWindow {
  from: number;
  to: number;
  bars: number;
  /** 成交额合计 */
  vol: number;
  /** 主动买卖差合计 */
  delta: number;
  /** delta / vol ∈ [-1, 1]（>0 主动买入占优） */
  ratio: number;
  /** 真实主动成交覆盖比例 */
  known: number;
  /** 单位根成交额 / 近 20 根均量 */
  volRatio: number;
}

export function windowFlow(ctx: Ctx, from: number, to: number): FlowWindow {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(ctx.n - 1, Math.max(from, to));
  let vol = 0;
  let delta = 0;
  let known = 0;
  let base = 0;
  let bars = 0;
  for (let i = a; i <= b; i++) {
    vol += ctx.vols[i];
    delta += ctx.delta[i];
    known += ctx.real[i];
    base += ctx.volMa[i];
    bars++;
  }
  return {
    from: a,
    to: b,
    bars,
    vol,
    delta,
    ratio: vol > 0 ? delta / vol : 0,
    known: bars ? known / bars : 0,
    volRatio: base > 0 ? vol / base : 1,
  };
}

// ─── 形态几何 ─────────────────────────────────────────────────
export interface Pivot {
  prior: number;
  first: number;
  neck: number;
  second: number;
  level: number;
  neckPrice: number;
  secondPrice: number;
}

/** 从信号几何里取出「起涨/跌点 · 一顶(底) · 颈线 · 二顶(底)」的索引与价格 */
export function pivotOf(ctx: Ctx, sig: ScanSignal): Pivot {
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

/** 两腿区间：进入第一极值 / 进入第二极值 */
export function legsOf(pv: Pivot) {
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
  return { l1a, l1b, l2a, l2b };
}

// ─── 触顶 / 触底：真突破还是假突破（订单流判读） ──────────────
//  场景：
//   ① 前高(低)已被标出，价格再次逼近/触及但没有超过 → 订单流判断“拒绝”还是“继续冲”
//   ② 等高双顶(底)，二顶(底)略微刺破前高(低) → 订单流判断是扫损假突破还是真突破
//  判据（均按突破方向归一，正数 = 有利于“被拒绝/假突破”）：
//   e1 冲向关键位的主动成交是否强劲、是否放量推进（越强越像真突破）
//   e2 触及那一根：放量却收在位内且突破方没赢得主动成交 = 被吸收；缩量 = 追价不足；放量收在位外 = 突破方主导
//   e3 触及那一根的拒绝影线
//   e4 近 12 根累计主动成交（CVD）有没有跟上价格
//   e5 触及之后（若已有收盘 K）反方向主动成交是否接管
export type TouchKind = 'approach' | 'touch' | 'sweep' | 'accepted';
export type TouchVerdict = 'reject' | 'breakout' | 'uncertain';

export interface TouchPlan {
  entry: number;
  stop: number;
  tp: number;
  rr: number;
}

export interface TouchRead {
  side: 'top' | 'bottom';
  /** 反转方向：顶 = -1（做空），底 = +1（做多） */
  dir: 1 | -1;
  level: number;
  /** 触及那一根（最逼近/刺破关键位） */
  testIdx: number;
  kind: TouchKind;
  /** 刺破关键位的深度（ATR）：>0 越过；<0 尚未触及 */
  depthAtr: number;
  /** 接近段（触及前 5 根）订单流，ratio 为原始符号（买入为正） */
  approach: FlowWindow;
  /** 突破方向的主动成交压力 −1..1（>0 = 突破方占优） */
  pressure: number;
  bar: { deltaRatio: number; volRatio: number; wick: number; known: boolean };
  /** 给评分模型的证据 −1..1（>0 = 假突破/被拒绝） */
  evidence: number;
  /** 假突破（被拒绝）概率：顶 = 回落概率，底 = 反弹概率 */
  fakeProb: number;
  /** 真突破概率 */
  breakProb: number;
  verdict: TouchVerdict;
  reasons: string[];
  headline: string;
  /** 触及即反手的交易计划（突破已被接受时为 null） */
  plan: TouchPlan | null;
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const roundPx = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(v >= 1000 ? 2 : 6)) : 0);

export function readTouch(
  ctx: Ctx,
  level: { price: number; side: 'top' | 'bottom'; idx?: number },
  idx: number,
  testIdx?: number,
): TouchRead {
  const { cs, n, atr, delta, vols, volMa } = ctx;
  const i = Math.max(0, Math.min(idx, n - 1));
  const a = Math.max(atr[i] || 0, 1e-9);
  const top = level.side === 'top';
  const dir: 1 | -1 = top ? -1 : 1;
  const up = top ? 1 : -1; // 突破方向（顶 = 向上）
  const px = level.price;
  const over = (v: number) => (top ? v - px : px - v) / a; // >0：越过关键位

  let t = Math.max(0, Math.min(testIdx ?? i, n - 1));
  if (testIdx == null) {
    for (let q = Math.max(0, i - 5); q <= i; q++) if (top ? cs[q].h > cs[t].h : cs[q].l < cs[t].l) t = q;
  }
  const tb = cs[t];
  const depth = over(top ? tb.h : tb.l);
  const approach = windowFlow(ctx, Math.max(0, t - 4), t);
  const wide = windowFlow(ctx, Math.max(0, t - 12), t);
  const after = i > t ? windowFlow(ctx, t + 1, i) : null;
  const tvol = vols[t];
  const tRatio = tvol > 0 ? delta[t] / tvol : 0;
  const tVol = volMa[t] > 0 ? tvol / volMa[t] : 1;
  const range = Math.max(1e-9, tb.h - tb.l);
  const wick = top ? (tb.h - Math.max(tb.o, tb.c)) / range : (Math.min(tb.o, tb.c) - tb.l) / range;
  const known = ctx.real[t] === 1;
  const inside = over(tb.c) <= 0.05;
  let beyondCloses = 0;
  for (let q = t; q <= i; q++) if (over(cs[q].c) > 0.1) beyondCloses++;
  const accepted = over(cs[i].c) > 0.2 || beyondCloses >= 2;
  const near = depth > -0.5;

  const pressure = clampR(approach.ratio * up * 4);
  const thrust = clamp01((approach.volRatio - 1.2) / 1.0) * clamp01(pressure * 1.5);
  // 仅对依赖主动买卖差的项按真实覆盖率收缩，保留客观 OHLCV 量价与影线拒绝证据
  const e1 = clampR(-pressure - 0.6 * thrust) * approach.known;
  let e2 = 0;
  if (known) {
    if (inside && tVol >= 1.1 && tRatio * up <= 0.05) e2 = 0.8;
    else if (inside && tVol < 0.9) e2 = 0.4;
    else if (!inside && tRatio * up > 0.1 && tVol >= 1.2) e2 = -0.9;
    else if (!inside) e2 = -0.3;
  } else {
    if (inside && tVol < 0.9) e2 = 0.35;
    else if (!inside) e2 = -0.35;
  }
  const e3 = near ? clampR((wick - 0.3) * 2) : 0;
  const e4 = clampR(-wide.ratio * up * 5) * wide.known;
  const e5 = after ? clampR(-after.ratio * up * 4) * after.known : null;
  const wsum = 0.3 + 0.25 + 0.12 + 0.13 + (e5 == null ? 0 : 0.2);
  let ev = (0.3 * e1 + 0.25 * e2 + 0.12 * e3 + 0.13 * e4 + (e5 == null ? 0 : 0.2 * e5)) / wsum;
  if (accepted) ev = Math.min(ev, -0.6);
  ev = clampR(ev * 1.6);

  const buy = top ? '主动买入' : '主动卖出'; // 突破方
  const sell = top ? '主动卖出' : '主动买入'; // 反转方
  const word = top ? '前高' : '前低';
  const src = known ? '' : '（近似）';
  const reasons: string[] = [];
  if (accepted) reasons.push(`收盘已站在${word}外侧（${beyondCloses} 根）：突破被接受`);
  if (depth > 0.05 && !accepted) reasons.push(`刺破${word} ${depth.toFixed(2)} ATR${inside ? '后收回' : '，尚未收回'}`);
  if (pressure <= -0.15) reasons.push(`冲向${word}时${sell}已占优（${pct(approach.ratio * -up)}）：推进动能不在突破方${src}`);
  else if (pressure < 0.2) reasons.push(`冲向${word}时${buy}偏弱（${pct(approach.ratio * up)}）：缺少突破动能${src}`);
  else reasons.push(`冲向${word}的${buy}强劲（${pct(approach.ratio * up)}${thrust > 0.3 ? `，放量 ${approach.volRatio.toFixed(1)}x` : ''}）：存在真突破风险${src}`);
  if (e2 >= 0.8) reasons.push(`触${word}那根放量 ${tVol.toFixed(1)}x 却收在位内、${buy}未占优：突破盘被吸收`);
  else if (e2 > 0) reasons.push(`触${word}那根缩量 ${tVol.toFixed(1)}x 且收在位内：追价意愿不足`);
  else if (e2 <= -0.9) reasons.push(`触${word}那根放量 ${tVol.toFixed(1)}x、${buy} ${pct(tRatio * up)} 且收在位外：突破方主导`);
  if (near && wick >= 0.45) reasons.push(`触${word}那根${top ? '上' : '下'}影线占 ${Math.round(wick * 100)}%：拒绝明显`);
  if (e4 > 0.3) reasons.push(`近 12 根累计${buy}没有跟上价格：CVD 背离`);
  if (after && e5 != null && e5 > 0.25) reasons.push(`触及之后${sell}接管（${pct(-after.ratio * up)}）`);
  else if (after && e5 != null && e5 < -0.25) reasons.push(`触及之后${buy}继续占优（${pct(after.ratio * up)}）`);

  const fakeProb = clamp01(logistic(ev * 1.6));
  const breakProb = 1 - fakeProb;
  const kind: TouchKind = accepted ? 'accepted' : depth > 0.05 ? 'sweep' : depth > -0.35 ? 'touch' : 'approach';
  const verdict: TouchVerdict = accepted ? 'breakout' : fakeProb >= 0.62 ? 'reject' : fakeProb <= 0.4 ? 'breakout' : 'uncertain';
  const pc = Math.round(fakeProb * 100);
  const act = top ? '做空' : '做多';
  const tag = top ? '触顶' : '触底';
  const headline = accepted
    ? top
      ? '收盘站上前高：真突破，不做空'
      : '收盘跌破前低：真跌破，不做多'
    : verdict === 'reject'
      ? kind === 'approach'
        ? `接近${word}：订单流偏向被拒绝（假突破 ${pc}%），触及后可${act}`
        : `${tag}订单流：假突破概率 ${pc}% → 可${act}`
      : verdict === 'breakout'
        ? `${tag}订单流：突破概率 ${100 - pc}%（${buy}仍在推进），不抢${top ? '空' : '多'}`
        : `${tag}订单流不明朗（假突破 ${pc}%）：等拒绝K或突破确认`;

  let plan: TouchPlan | null = null;
  if (!accepted) {
    let ext = px;
    for (let q = t; q <= i; q++) ext = top ? Math.max(ext, cs[q].h) : Math.min(ext, cs[q].l);
    const entry = px + dir * 0.1 * a;
    const stop = ext - dir * 0.75 * a;
    const risk = Math.abs(entry - stop);
    let neck = entry;
    for (let q = Math.max(0, level.idx ?? i - 60); q <= i; q++) neck = top ? Math.min(neck, cs[q].l) : Math.max(neck, cs[q].h);
    const dist = Math.min(Math.max(Math.abs(entry - neck), 1.2 * risk), 4 * risk);
    if (risk > 0) plan = { entry: roundPx(entry), stop: roundPx(stop), tp: roundPx(entry + dir * dist), rr: Number((dist / risk).toFixed(1)) };
  }

  return {
    side: level.side,
    dir,
    level: px,
    testIdx: t,
    kind,
    depthAtr: r3(depth),
    approach,
    pressure: r3(pressure),
    bar: { deltaRatio: r3(tRatio), volRatio: r3(tVol), wick: r3(wick), known },
    evidence: r3(ev),
    fakeProb: r3(fakeProb),
    breakProb: r3(breakProb),
    verdict,
    reasons,
    headline,
    plan,
  };
}

// ─── 触顶 / 触底历史统计：本图里同类触及，订单流判“拒绝”后到底兑现了多少 ───
export interface TouchEvent {
  idx: number;
  ts: number;
  price: number;
  side: 'top' | 'bottom';
  fakeProb: number;
  /** reject = 12 根内先回撤 ≥1 ATR；break = 先收盘越过关键位；drift = 两者都没发生 */
  outcome: 'reject' | 'break' | 'drift';
}

export interface TouchStats {
  n: number;
  reject: number;
  /** 订单流判“假突破”（≥60%）的次数 / 其中被拒绝 */
  hiN: number;
  hiReject: number;
  /** 订单流判“真突破”（≤45%）的次数 / 其中被拒绝 */
  loN: number;
  loReject: number;
}

export function scanTouches(ctx: Ctx, horizon = 12): { events: TouchEvent[]; stats: TouchStats } {
  const { cs, n, atr } = ctx;
  const events: TouchEvent[] = [];
  const stats: TouchStats = { n: 0, reject: 0, hiN: 0, hiReject: 0, loN: 0, loReject: 0 };
  for (const lv of findSwingLevels(ctx)) {
    const top = lv.side === 'top';
    const end = Math.min(lv.breakIdx ?? n - 1, n - 1 - horizon);
    for (let q = lv.idx + 8; q <= end; q++) {
      const a = atr[q];
      if (!(a > 0)) continue;
      const hit = top ? cs[q].h >= lv.price - 0.2 * a : cs[q].l <= lv.price + 0.2 * a;
      if (!hit) continue;
      const rd = readTouch(ctx, lv, q, q);
      let outcome: TouchEvent['outcome'] = 'drift';
      for (let k = q; k <= Math.min(n - 1, q + horizon); k++) {
        const c = cs[k];
        if (top ? c.c > lv.price + 0.2 * a : c.c < lv.price - 0.2 * a) {
          outcome = 'break';
          break;
        }
        if (top ? c.l <= lv.price - a : c.h >= lv.price + a) {
          outcome = 'reject';
          break;
        }
      }
      events.push({ idx: q, ts: cs[q].ts, price: lv.price, side: lv.side, fakeProb: rd.fakeProb, outcome });
      stats.n++;
      if (outcome === 'reject') stats.reject++;
      if (rd.fakeProb >= 0.6) {
        stats.hiN++;
        if (outcome === 'reject') stats.hiReject++;
      } else if (rd.fakeProb <= 0.45) {
        stats.loN++;
        if (outcome === 'reject') stats.loReject++;
      }
      q += horizon; // 同一次触碰只计一次
    }
  }
  return { events, stats };
}

// ─── 二次测试判读 ─────────────────────────────────────────────
export type TrapKind = 'bullTrap' | 'bearTrap' | null;
export type FlowSource = 'taker' | 'approx' | 'mixed';

export interface SecondTestRead {
  scene: 'doubleTop' | 'doubleBottom';
  dir: 1 | -1;
  level: number;
  neck: number;
  leg1: FlowWindow;
  leg2: FlowWindow;
  /** CVD 极值背离（>0 支持反转） */
  cvdDiv: number;
  /** 第二腿相对第一腿的主动成交衰减（>0 支持反转） */
  legDeltaDiff: number;
  /** 第二腿单位成交量 / 第一腿 */
  legVolRatio: number;
  test: { idx: number; deltaRatio: number; volRatio: number; known: boolean };
  confirm: { idx: number; deltaRatio: number; volRatio: number; known: boolean; closedInside: boolean };
  sweep: {
    occurred: boolean;
    depthAtr: number;
    bars: number;
    flow: FlowWindow | null;
    /** 收盘站稳在关键位外侧（突破被接受） */
    accepted: boolean;
  };
  absorption: { count: number; breach: number };
  oi: { pct: number | null };
  trap: { kind: TrapKind; score: number; reasons: string[] };
  /** 触顶/触底订单流：真突破还是假突破 */
  touch: TouchRead;
  /** 订单流对反转方向的净倾向 0..1（未经校准，供未确认阶段参考） */
  lean: number;
  flowSource: FlowSource;
  headline: string;
}

const sourceOf = (known: number): FlowSource => (known >= 0.95 ? 'taker' : known <= 0.05 ? 'approx' : 'mixed');

export function readSecondTest(ctx: Ctx, sig: ScanSignal): SecondTestRead {
  const { cs, n, atr, delta, vols, volMa, oi } = ctx;
  const i = Math.min(sig.idx, n - 1);
  const a = Math.max(atr[i] || 0, 1e-9);
  const pv = pivotOf(ctx, sig);
  const dir: 1 | -1 = sig.side === 'long' ? 1 : -1;
  const top = dir < 0;
  const { l1a, l1b, l2a, l2b } = legsOf(pv);
  const leg1 = windowFlow(ctx, l1a, l1b);
  const leg2 = windowFlow(ctx, l2a, l2b);

  // CVD 极值背离：从第一腿起点累计到一顶/底 vs 累计到二顶/底
  let cvdFirst = 0;
  let cvdSecond = 0;
  let totalVol = 0;
  let betweenKnown = 0;
  let betweenBars = 0;
  for (let q = l1a; q <= Math.min(n - 1, pv.second); q++) {
    if (q <= pv.first) cvdFirst += delta[q];
    else {
      betweenKnown += ctx.real[q];
      betweenBars++;
    }
    cvdSecond += delta[q];
    totalVol += vols[q];
  }
  const norm = Math.max(1e-9, totalVol * 0.08);
  // 覆盖率加权：cvdSecond - cvdFirst 实际求和区间为 (pv.first, pv.second]，按该区间真实覆盖比例缩放
  const cvdCov = betweenBars > 0 ? betweenKnown / betweenBars : 0;
  const flowCov = Math.min(leg1.known, leg2.known);
  const cvdDiv = clampR((((cvdSecond - cvdFirst) * dir) / norm) * cvdCov);
  const legDeltaDiff = clampR(((leg2.ratio - leg1.ratio) * dir * 6) * flowCov);
  const v1 = leg1.vol / Math.max(1, leg1.bars);
  const v2 = leg2.vol / Math.max(1, leg2.bars);
  const legVolRatio = v1 > 0 ? v2 / v1 : 1;

  // 测试窗口：二顶/底 → 确认K
  const from = Math.max(0, Math.min(pv.second, i));
  const to = Math.min(n - 1, Math.max(i, pv.second));
  let absorb = 0;
  let breach = 0;
  let deepestIdx = from;
  let depth = 0;
  let sweepBars = 0;
  let sweepFrom = -1;
  let sweepTo = -1;
  for (let q = from; q <= to; q++) {
    const c = cs[q];
    const avg = volMa[q] > 0 ? volMa[q] : c.v || 1;
    const beyond = top ? c.h - pv.level : pv.level - c.l;
    if (beyond > depth) {
      depth = beyond;
    }
    if (top ? c.h > cs[deepestIdx].h : c.l < cs[deepestIdx].l) deepestIdx = q;
    if (beyond > 0.05 * a) {
      sweepBars++;
      if (sweepFrom < 0) sweepFrom = q;
      sweepTo = q;
    }
    if (top) {
      if (c.h >= pv.level - 0.1 * a && c.c <= pv.level - 0.25 * a && c.v >= avg * 1.1) absorb++;
      if (c.c > pv.level + 0.2 * a) breach++;
    } else {
      if (c.l <= pv.level + 0.1 * a && c.c >= pv.level + 0.25 * a && c.v >= avg * 1.1) absorb++;
      if (c.c < pv.level - 0.2 * a) breach++;
    }
  }
  const sweepFlow = sweepFrom >= 0 ? windowFlow(ctx, sweepFrom, sweepTo) : null;
  const last = cs[to];
  const closedInside = top ? last.c <= pv.level : last.c >= pv.level;
  const accepted = top ? last.c > pv.level + 0.2 * a : last.c < pv.level - 0.2 * a;
  const barOf = (q: number) => ({
    idx: q,
    deltaRatio: vols[q] > 0 ? delta[q] / vols[q] : 0,
    volRatio: volMa[q] > 0 ? vols[q] / volMa[q] : 1,
    known: ctx.real[q] === 1,
  });
  const test = barOf(deepestIdx);
  const confirm = { ...barOf(to), closedInside };

  // 持仓量：第二腿期间变化
  let oiPct: number | null = null;
  const oiStart = oi[l2a];
  const oiEnd = oi[Math.min(n - 1, pv.second)];
  if (Number.isFinite(oiStart) && Number.isFinite(oiEnd) && oiStart > 0) oiPct = oiEnd / oiStart - 1;

  // ── 诱多 / 诱空评分 ──
  const reasons: string[] = [];
  let score = 0;
  const depthAtr = depth / a;
  const occurred = sweepBars > 0 && depthAtr >= 0.05;
  const sideWord = top ? '阻力' : '支撑';
  if (occurred) {
    score += 0.3 + clamp01((depthAtr - 0.1) / 0.5) * 0.15;
    reasons.push(`${top ? '上穿' : '下破'}${sideWord} ${depthAtr.toFixed(2)} ATR（扫损）${closedInside ? '后收回' : '，尚未收回'}`);
    if (sweepFlow) {
      const w = sweepFlow.known >= 0.5 ? 1 : 0.5;
      const against = sweepFlow.ratio * dir; // >0：扫损期间主动成交站在反转一侧
      if (against > 0.05) {
        score += 0.2 * w;
        reasons.push(top ? `扫高期间主动卖出占优（${pct(sweepFlow.ratio)}）：追多盘被反手` : `扫低期间主动买入占优（${pct(sweepFlow.ratio)}）：破位卖盘被承接`);
      } else if (against < -0.12 && sweepFlow.volRatio >= 1.3 && closedInside) {
        score += 0.2 * w;
        reasons.push(top ? `追多成交放量 ${sweepFlow.volRatio.toFixed(1)}x 却被吸收，价格收回` : `恐慌卖出放量 ${sweepFlow.volRatio.toFixed(1)}x 却被吸收，价格收回`);
      } else if (against < -0.12 && !closedInside) {
        score -= 0.3;
        reasons.push(`突破方向主动成交占优（${pct(sweepFlow.ratio)}）且未收回：更像真突破`);
      }
    }
  }
  if (cvdDiv > 0.25) {
    score += 0.15;
    reasons.push(top ? 'CVD 背离：价格再创新高，累计主动买入未跟上' : 'CVD 背离：价格再创新低，累计主动卖出未跟上');
  }
  if (legDeltaDiff > 0.3) {
    score += 0.1;
    reasons.push(top ? `第二腿主动买入 ${pct(leg2.ratio)} 弱于第一腿 ${pct(leg1.ratio)}` : `第二腿主动卖出 ${pct(-leg2.ratio)} 弱于第一腿 ${pct(-leg1.ratio)}`);
  }
  if (oiPct != null && oiPct > 0.003) {
    score += 0.1;
    reasons.push(top ? `冲高段持仓 +${(oiPct * 100).toFixed(2)}%：新多在顶部被套` : `杀跌段持仓 +${(oiPct * 100).toFixed(2)}%：新空在底部被套`);
  }
  if (absorb > 0) {
    score += 0.1;
    reasons.push(`${sideWord}位出现 ${absorb} 根放量刺破后收回的吸收K`);
  }
  if (breach > 0 && !closedInside) {
    score -= 0.25;
    reasons.push(`已有 ${breach} 根收盘停在${sideWord}外侧`);
  }
  score = clamp01(score);
  const kind: TrapKind = !accepted && score >= 0.5 ? (top ? 'bullTrap' : 'bearTrap') : null;

  // 未校准的净倾向
  const lean = clamp01(
    0.5 +
      0.14 * cvdDiv +
      0.1 * legDeltaDiff +
      0.08 * clampR((1 - legVolRatio) * 2) +
      (sweepFlow ? 0.1 * clampR(sweepFlow.ratio * dir * 4) : 0) +
      0.08 * clampR(confirm.deltaRatio * dir * 3) -
      (accepted ? 0.25 : 0),
  );
  const knownAll = (leg1.known * leg1.bars + leg2.known * leg2.bars) / Math.max(1, leg1.bars + leg2.bars);
  const flowSource = sourceOf(knownAll);
  const headline = accepted
    ? top
      ? '价格收盘站上阻力：双顶失效，可能是真突破'
      : '价格收盘跌破支撑：双底失效，可能是真跌破'
    : kind
      ? top
        ? '诱多：扫过前高后收回，突破买盘被套'
        : '诱空：扫过前低后收回，破位卖盘被套'
      : occurred
        ? `${top ? '扫高' : '扫低'}后收回，但订单流确认不足`
        : top
          ? '等高二次测试：未扫前高'
          : '等低二次测试：未扫前低';

  return {
    scene: top ? 'doubleTop' : 'doubleBottom',
    dir,
    level: pv.level,
    neck: pv.neckPrice,
    leg1,
    leg2,
    cvdDiv: r3(cvdDiv),
    legDeltaDiff: r3(legDeltaDiff),
    legVolRatio: r3(legVolRatio),
    test,
    confirm,
    sweep: { occurred, depthAtr: r3(depthAtr), bars: sweepBars, flow: sweepFlow, accepted },
    absorption: { count: absorb, breach },
    oi: { pct: oiPct == null ? null : r3(oiPct) },
    trap: { kind, score: r3(score), reasons },
    touch: readTouch(ctx, { price: pv.level, side: top ? 'top' : 'bottom', idx: pv.first }, i, deepestIdx),
    lean: r3(lean),
    flowSource,
    headline,
  };
}

// ─── 摆动关键位（突破分析用，独立于形态引擎） ─────────────────
export interface SwingLevel {
  idx: number;
  ts: number;
  price: number;
  side: 'top' | 'bottom';
  /** 首根收盘越过关键位（± 0.1 ATR）的 K 线；未突破为 null */
  breakIdx: number | null;
}

const swingCache = new WeakMap<Ctx, SwingLevel[]>();

export function findSwingLevels(ctx: Ctx, opts: { left?: number; right?: number; priorAtr?: number; maxAge?: number } = {}): SwingLevel[] {
  const isDefault =
    opts.left == null && opts.right == null && opts.priorAtr == null && opts.maxAge == null;
  if (isDefault) {
    const hit = swingCache.get(ctx);
    if (hit) return hit.map(l => ({ ...l }));
  }
  const { cs, n, atr } = ctx;
  const L = opts.left ?? 8;
  const R = opts.right ?? 5;
  const priorAtr = opts.priorAtr ?? 1.5;
  const maxAge = opts.maxAge ?? 576;
  const out: SwingLevel[] = [];
  const active: SwingLevel[] = [];
  for (let i = L + R; i < n; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    // 推进未突破的关键位
    for (let q = active.length - 1; q >= 0; q--) {
      const lv = active[q];
      const c = cs[i];
      const broke = lv.side === 'top' ? c.c > lv.price + 0.1 * a : c.c < lv.price - 0.1 * a;
      if (broke) {
        lv.breakIdx = i;
        active.splice(q, 1);
      } else if (i - lv.idx > maxAge) {
        active.splice(q, 1);
      }
    }
    const j = i - R;
    for (const side of ['top', 'bottom'] as const) {
      const ext = side === 'top' ? cs[j].h : cs[j].l;
      let ok = true;
      for (let k = j - L; k < j && ok; k++) {
        if (side === 'top' ? cs[k].h >= ext : cs[k].l <= ext) ok = false;
      }
      for (let k = j + 1; k <= i && ok; k++) {
        if (side === 'top' ? cs[k].h > ext : cs[k].l < ext) ok = false;
      }
      if (!ok) continue;
      // 之前必须有一段趋势腿
      let prior = side === 'top' ? Infinity : -Infinity;
      for (let k = Math.max(0, j - 24); k < j; k++) prior = side === 'top' ? Math.min(prior, cs[k].l) : Math.max(prior, cs[k].h);
      if (!(Math.abs(ext - prior) >= priorAtr * a)) continue;
      const tol = Math.max(0.35 * a, 0.0004 * Math.abs(ext));
      if (active.some(lv => lv.side === side && Math.abs(lv.price - ext) <= tol)) continue;
      const lv: SwingLevel = { idx: j, ts: cs[j].ts, price: ext, side, breakIdx: null };
      active.push(lv);
      out.push(lv);
    }
  }
  if (isDefault) swingCache.set(ctx, out.map(l => ({ ...l })));
  return out;
}

// ─── 突破 → 回调是否可跟随 ───────────────────────────────────
export type BreakoutVerdict = 'chase_risk' | 'wait_pullback' | 'follow' | 'follow_weak' | 'avoid' | 'failed' | 'strong_hold';
export type PullbackBucket = 'retest_hold' | 'retest_heavy' | 'no_retest';

export interface BreakoutStats {
  buckets: Record<PullbackBucket, { n: number; win: number }>;
  /** 突破K收盘直接追单的结果 */
  chase: { n: number; win: number };
}

export const emptyBreakoutStats = (): BreakoutStats => ({
  buckets: { retest_hold: { n: 0, win: 0 }, retest_heavy: { n: 0, win: 0 }, no_retest: { n: 0, win: 0 } },
  chase: { n: 0, win: 0 },
});

export interface BreakoutRead {
  dir: 1 | -1;
  level: number;
  levelTs: number;
  breakIdx: number;
  breakTs: number;
  barsSince: number;
  impulse: { bars: number; volRatio: number; deltaRatio: number; known: number; extensionAtr: number; climax: boolean; peak: number; peakIdx: number };
  pullback: {
    started: boolean;
    depth: number;
    bars: number;
    volRatio: number;
    deltaRatio: number;
    known: number;
    touched: boolean;
    held: boolean;
    failed: boolean;
    extreme: number;
  };
  oiPct: number | null;
  bucket: PullbackBucket;
  verdict: BreakoutVerdict;
  /** 回调后继续的概率（先验 + 本图历史） */
  followProb: number;
  /** 突破K收盘直接追单的历史胜率（无样本为 null） */
  chaseRate: number | null;
  empiricalN: number;
  reasons: string[];
  headline: string;
  flowSource: FlowSource;
  /** 回踩区：关键位 ± 0.3 ATR */
  zone: { lo: number; hi: number };
}

export function readBreakout(ctx: Ctx, level: { price: number; side: 'top' | 'bottom'; ts: number }, breakIdx: number, uptoIdx: number, stats?: BreakoutStats): BreakoutRead {
  const { cs, n, atr, oi } = ctx;
  const upto = Math.min(n - 1, Math.max(breakIdx, uptoIdx));
  const dir: 1 | -1 = level.side === 'top' ? 1 : -1;
  const a = Math.max(atr[breakIdx] || atr[upto] || 0, 1e-9);
  const L = level.price;
  const up = dir > 0;
  const brk = cs[breakIdx];
  const breakFlow = windowFlow(ctx, breakIdx, breakIdx);
  const extensionAtr = ((brk.c - L) * dir) / a;

  // 冲击段：突破K → 极值
  let peak = up ? brk.h : brk.l;
  let peakIdx = breakIdx;
  for (let q = breakIdx + 1; q <= upto; q++) {
    const c = cs[q];
    if (up ? c.h > peak : c.l < peak) {
      peak = up ? c.h : c.l;
      peakIdx = q;
    }
  }
  const impulseFlow = windowFlow(ctx, breakIdx, peakIdx);
  const climax = breakFlow.volRatio >= 2.5 || extensionAtr >= 1.2;

  // 回调段：极值之后
  const legSize = Math.max((peak - L) * dir, 0.5 * a);
  let extreme = peak;
  let touched = false;
  let held = false;
  let failed = false;
  let touchIdx = -1;
  let runPeak = up ? brk.h : brk.l;
  let runPeakIdx = breakIdx;
  for (let q = breakIdx + 1; q <= upto; q++) {
    const c = cs[q];
    if (q > peakIdx) {
      const e = up ? c.l : c.h;
      if (up ? e < extreme : e > extreme) extreme = e;
    }
    const madeHigh = up ? c.h > runPeak : c.l < runPeak;
    if (madeHigh) {
      runPeak = up ? c.h : c.l;
      runPeakIdx = q;
    }
    // 回踩只在冲击段之后计：当前根不是新极值根，且冲击已离开关键位 ≥ 0.4 ATR
    const near = up ? c.l <= L + 0.3 * a : c.h >= L - 0.3 * a;
    if (near && !madeHigh && q > runPeakIdx && (runPeak - L) * dir >= 0.4 * a) {
      touched = true;
      if (touchIdx < 0) touchIdx = q;
    }
    const back = up ? c.c < L - 0.2 * a : c.c > L + 0.2 * a;
    if (back) failed = true;
    if (touched && !failed && (up ? c.c >= L + 0.1 * a : c.c <= L - 0.1 * a)) {
      const range = Math.max(1e-9, c.h - c.l);
      const pos = (c.c - c.l) / range;
      if (up ? pos >= 0.5 : pos <= 0.5) held = true;
    }
  }
  const pullbackBars = upto > peakIdx ? upto - peakIdx : 0;
  const pullbackFlow = pullbackBars > 0 ? windowFlow(ctx, peakIdx + 1, upto) : null;
  const depth = clamp01(((peak - extreme) * dir) / legSize);
  const started = pullbackBars > 0 && (depth >= 0.25 || touched);
  const impulsePer = impulseFlow.vol / Math.max(1, impulseFlow.bars);
  const pullPer = pullbackFlow ? pullbackFlow.vol / Math.max(1, pullbackFlow.bars) : 0;
  const pbVolRatio = pullbackFlow && impulsePer > 0 ? pullPer / impulsePer : 0;
  const pbDelta = pullbackFlow ? pullbackFlow.ratio : 0;
  const healthy = started && pbVolRatio <= 0.8 && pbDelta * dir > -0.15;
  const heavy = started && (pbVolRatio > 0.8 && pbDelta * dir < -0.05);

  let oiPct: number | null = null;
  const oi0 = oi[Math.max(0, breakIdx - 1)];
  const oi1 = oi[peakIdx];
  if (Number.isFinite(oi0) && Number.isFinite(oi1) && oi0 > 0) oiPct = oi1 / oi0 - 1;

  // 分桶（与历史统计一致）
  const bucket: PullbackBucket = touched ? (healthy || held ? 'retest_hold' : 'retest_heavy') : 'no_retest';

  // 先验概率
  const reasons: string[] = [];
  let p = 0.5;
  const dConf = clampR((breakFlow.ratio * dir) / 0.15);
  p += 0.1 * dConf;
  reasons.push(
    breakFlow.ratio * dir >= 0.08
      ? `突破K主动${up ? '买入' : '卖出'}占优（${pct(breakFlow.ratio)}）`
      : breakFlow.ratio * dir <= -0.05
        ? `突破K主动成交反向（${pct(breakFlow.ratio)}）：靠被动盘推动，可信度低`
        : `突破K主动成交均衡（${pct(breakFlow.ratio)}）`,
  );
  if (breakFlow.volRatio >= 1.3 && breakFlow.volRatio < 2.5) {
    p += 0.08;
    reasons.push(`突破放量 ${breakFlow.volRatio.toFixed(1)}x`);
  } else if (breakFlow.volRatio < 1) {
    p -= 0.06;
    reasons.push(`突破缩量 ${breakFlow.volRatio.toFixed(1)}x：参与不足`);
  }
  if (climax) {
    p -= 0.08;
    reasons.push(`冲高${up ? '' : '/杀跌'}过急（${breakFlow.volRatio.toFixed(1)}x 量 · 离位 ${extensionAtr.toFixed(1)} ATR）：追单多半要被回调洗`);
  }
  if (oiPct != null && oiPct > 0.002) {
    p += 0.04;
    reasons.push(`突破段持仓 +${(oiPct * 100).toFixed(2)}%：有新资金跟进`);
  }
  if (started) {
    if (healthy) {
      p += 0.12;
      reasons.push(`回调缩量 ${pbVolRatio.toFixed(2)}x · 回调中主动${up ? '卖' : '买'}压不重（${pct(pbDelta)}）`);
    } else if (heavy) {
      p -= 0.12;
      reasons.push(`回调放量 ${pbVolRatio.toFixed(2)}x 且主动${up ? '卖出' : '买入'}占优（${pct(pbDelta)}）`);
    } else {
      reasons.push(`回调量能 ${pbVolRatio.toFixed(2)}x · 主动差 ${pct(pbDelta)}`);
    }
  }
  if (held) {
    p += 0.15;
    reasons.push(`回踩 ${L} 后收盘站回${up ? '上方' : '下方'}：${up ? '阻力转支撑' : '支撑转阻力'}成立`);
  }
  if (failed) {
    p = 0.15;
    reasons.push(`已有收盘回到关键位${up ? '下方' : '上方'}：突破失败，${up ? '追多' : '追空'}盘被套`);
  }
  // 本图历史
  let empiricalN = 0;
  let chaseRate: number | null = null;
  if (stats && !failed) {
    const b = stats.buckets[bucket];
    if (b.n >= 8) {
      empiricalN = b.n;
      p = (p * 8 + (b.win / b.n) * b.n) / (8 + b.n);
    }
    if (stats.chase.n >= 8) chaseRate = stats.chase.win / stats.chase.n;
  }
  const followProb = failed ? 0.15 : r3(clampR(p, 0.08, empiricalN ? 0.92 : 0.85));

  let verdict: BreakoutVerdict;
  if (failed) verdict = 'failed';
  else if (held) verdict = followProb >= 0.5 ? 'follow' : 'follow_weak'; // 回踩守住但本图历史兑现率偏低 → 轻仓/观望
  else if (started) verdict = heavy ? 'avoid' : 'wait_pullback';
  else if (climax || extensionAtr >= 0.8) verdict = 'chase_risk';
  else if (upto - breakIdx >= 6 && depth < 0.25) verdict = 'strong_hold';
  else verdict = 'chase_risk';

  const headline =
    verdict === 'failed'
      ? up
        ? '假突破 / 诱多：不跟，反向机会'
        : '假跌破 / 诱空：不跟，反向机会'
      : verdict === 'follow'
        ? `回踩确认，可跟随（${Math.round(followProb * 100)}%）`
        : verdict === 'follow_weak'
          ? `回踩守住，但本图历史兑现率仅 ${Math.round(followProb * 100)}%：轻仓或观望`
          : verdict === 'wait_pullback'
          ? '缩量回调中：等回踩到位再跟'
          : verdict === 'avoid'
            ? '回调放量抛压重：暂不跟随'
            : verdict === 'strong_hold'
              ? '强势不回调：只能轻仓或等首次缩量回踩'
              : '刚突破不追：等回踩';

  const known = (impulseFlow.known * impulseFlow.bars + (pullbackFlow?.known ?? 0) * pullbackBars) / Math.max(1, impulseFlow.bars + pullbackBars);
  return {
    dir,
    level: L,
    levelTs: level.ts,
    breakIdx,
    breakTs: brk.ts,
    barsSince: upto - breakIdx,
    impulse: {
      bars: impulseFlow.bars,
      volRatio: r3(breakFlow.volRatio),
      deltaRatio: r3(breakFlow.ratio),
      known: r3(impulseFlow.known),
      extensionAtr: r3(extensionAtr),
      climax,
      peak,
      peakIdx,
    },
    pullback: {
      started,
      depth: r3(depth),
      bars: pullbackBars,
      volRatio: r3(pbVolRatio),
      deltaRatio: r3(pbDelta),
      known: r3(pullbackFlow?.known ?? 0),
      touched,
      held,
      failed,
      extreme,
    },
    oiPct: oiPct == null ? null : r3(oiPct),
    bucket,
    verdict,
    followProb,
    chaseRate: chaseRate == null ? null : r3(chaseRate),
    empiricalN,
    reasons,
    headline,
    flowSource: sourceOf(known),
    zone: up ? { lo: L - 0.1 * a, hi: L + 0.3 * a } : { lo: L - 0.3 * a, hi: L + 0.1 * a },
  };
}

export interface BreakoutEvent {
  level: SwingLevel;
  breakIdx: number;
  bucket: PullbackBucket;
  /** 等回踩后再跟：是否在收盘回到关键位另一侧之前到达 关键位 ± 1.5 ATR */
  win: boolean | null;
  /** 突破K收盘直接追：是否先到 +1.5 ATR 再被打回 */
  chaseWin: boolean | null;
}

/**
 * 历史突破统计：对每个被收盘突破的摆动关键位，按回调质量分桶，
 * 统计「等回踩后跟随」与「突破即追」的兑现率；用于给实时结论配上本图样本。
 */
export function scanBreakouts(ctx: Ctx, horizon = 48): { events: BreakoutEvent[]; stats: BreakoutStats } {
  const { cs, n, atr } = ctx;
  const levels = findSwingLevels(ctx);
  const stats = emptyBreakoutStats();
  const events: BreakoutEvent[] = [];
  for (const lv of levels) {
    if (lv.breakIdx == null) continue;
    const b = lv.breakIdx;
    if (b + 2 >= n) continue;
    const dir = lv.side === 'top' ? 1 : -1;
    const a = Math.max(atr[b] || 0, 1e-9);
    const end = Math.min(n - 1, b + horizon);
    const read = readBreakout(ctx, lv, b, Math.min(end, b + 12));
    // 回踩分桶要看完整视野内的回调，重新用全视野判读一次
    const full = readBreakout(ctx, lv, b, end);
    const bucket = full.bucket;
    // 等回踩后跟随：从首次触及回踩区开始计
    let win: boolean | null = null;
    let touchIdx = -1;
    let runPeak = dir > 0 ? cs[b].h : cs[b].l;
    for (let q = b + 1; q <= end; q++) {
      const c = cs[q];
      const madeHigh = dir > 0 ? c.h > runPeak : c.l < runPeak;
      if (madeHigh) runPeak = dir > 0 ? c.h : c.l;
      const near = dir > 0 ? c.l <= lv.price + 0.3 * a : c.h >= lv.price - 0.3 * a;
      if (near && !madeHigh && (runPeak - lv.price) * dir >= 0.4 * a) {
        touchIdx = q;
        break;
      }
    }
    if (touchIdx > 0) {
      win = false;
      for (let q = touchIdx; q <= end; q++) {
        const c = cs[q];
        if (dir > 0 ? c.c < lv.price - 0.2 * a : c.c > lv.price + 0.2 * a) break;
        if (dir > 0 ? c.h >= lv.price + 1.5 * a : c.l <= lv.price - 1.5 * a) {
          win = true;
          break;
        }
      }
    }
    // 突破即追：以突破K收盘为入场
    let chaseWin: boolean | null = false;
    const entry = cs[b].c;
    for (let q = b + 1; q <= end; q++) {
      const c = cs[q];
      if (dir > 0 ? c.c < lv.price - 0.2 * a : c.c > lv.price + 0.2 * a) break;
      if (dir > 0 ? c.h >= entry + 1.5 * a : c.l <= entry - 1.5 * a) {
        chaseWin = true;
        break;
      }
    }
    if (end - b < 12) chaseWin = null; // 视野不足，不计入
    const ev: BreakoutEvent = { level: lv, breakIdx: b, bucket, win, chaseWin };
    events.push(ev);
    if (win != null && (bucket !== 'no_retest' || end - b >= horizon)) {
      const cell = stats.buckets[bucket];
      cell.n++;
      if (win) cell.win++;
    }
    if (chaseWin != null) {
      stats.chase.n++;
      if (chaseWin) stats.chase.win++;
    }
    void read;
  }
  return { events, stats };
}


