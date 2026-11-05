import { FACTORS, type FactorKey } from './model';
import type { Candidate } from './scan';

export interface Summary {
  detected: number;
  traded: number;
  wins: number;
  losses: number;
  /** R 恰好为 0 的笔数（保本被成本磨平）：不计入胜负 */
  flat: number;
  flatRate: number;
  winRate: number;
  avgR: number;
  totalR: number;
  pf: number;
  maxDD: number;
  avgHold: number;
  tpRate: number;
  slRate: number;
  timeRate: number;
  /** 1R 后保本离场的占比（此前被错误并入 timeRate） */
  beRate: number;
  payoff: number;
  /** 单笔收益标准差（R），衡量策略稳定性 */
  volR: number;
  sharpeR: number;
}

export interface BucketStat extends Summary {
  label: string;
  from: number;
  to: number;
  mid: number;
  ideal: number;
}

export interface FactorAttribution {
  key: FactorKey;
  label: string;
  short: string;
  group: string;
  weight: number;
  coverage: number;
  avgWin: number;
  avgLoss: number;
  edge: number;
  /** 门槛以上被采纳 / 被拒绝的数量 */
  used: number;
  killed: number;
}

const EMPTY: Summary = {
  detected: 0,
  traded: 0,
  wins: 0,
  losses: 0,
  flat: 0,
  flatRate: 0,
  winRate: 0,
  avgR: 0,
  totalR: 0,
  pf: 0,
  maxDD: 0,
  avgHold: 0,
  tpRate: 0,
  slRate: 0,
  timeRate: 0,
  beRate: 0,
  payoff: 0,
  volR: 0,
  sharpeR: 0,
};

const tradable = (c: Candidate) => !!c.outcome?.filled && Number.isFinite(c.outcome.r);

export function summarize(cands: Candidate[], threshold = 0): Summary {
  const detected = cands.filter(tradable);
  const done = detected
    .filter(c => c.proba >= threshold)
    .map(c => c.outcome!)
    .sort((a, b) => a.exitTs - b.exitTs);
  if (!done.length) return { ...EMPTY, detected: detected.length };
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let tp = 0;
  let sl = 0;
  let time = 0;
  let be = 0;
  let hold = 0;
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  const rs: number[] = [];
  for (const o of done) {
    const r = o.r;
    rs.push(r);
    // r 恰好为 0（保本离场被手续费/滑点磨平）既不是盈利也不是亏损：
    // 旧实现把它计入 losses，会虚增亏损笔数并压低赔付比的分母口径。
    if (r > 0) {
      wins++;
      grossWin += r;
    } else if (r < 0) {
      losses++;
      grossLoss += -r;
    } else {
      flat++;
    }
    if (o.why === 'tp') tp++;
    else if (o.why === 'sl') sl++;
    else if (o.why === 'be') be++;
    else time++;
    hold += o.holdingBars;
    cum += r;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const n = done.length;
  const avgR = cum / n;
  const sd = Math.sqrt(rs.reduce((s, r) => s + (r - avgR) ** 2, 0) / n);
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  return {
    detected: detected.length,
    traded: n,
    wins,
    losses,
    flat,
    flatRate: (flat / n) * 100,
    winRate: (wins / n) * 100,
    avgR,
    totalR: cum,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    maxDD,
    avgHold: hold / n,
    tpRate: (tp / n) * 100,
    slRate: (sl / n) * 100,
    timeRate: (time / n) * 100,
    beRate: (be / n) * 100,
    payoff: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0,
    volR: sd,
    sharpeR: sd > 0 ? avgR / sd : 0,
  };
}

/** 概率校准：把样本按预测概率分桶，对比“预测胜率 vs 实际胜率” */
export function calibration(cands: Candidate[], buckets = 8): BucketStat[] {
  const pool = cands.filter(tradable);
  if (!pool.length) return [];
  let lo = 1;
  let hi = 0;
  for (const c of pool) {
    if (c.proba < lo) lo = c.proba;
    if (c.proba > hi) hi = c.proba;
  }
  if (hi - lo < 0.02) hi = Math.min(1, lo + 0.02);
  const step = (hi - lo) / buckets;
  const out: BucketStat[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = lo + b * step;
    const to = b === buckets - 1 ? hi + 1e-9 : lo + (b + 1) * step;
    const slice = pool.filter(c => c.proba >= from && c.proba < to);
    const stat = summarize(slice);
    out.push({
      ...stat,
      label: `${Math.round(from * 100)}–${Math.round(to * 100)}%`,
      from,
      to,
      mid: (from + Math.min(to, hi)) / 2,
      ideal: (from + Math.min(to, hi)) / 2,
    });
  }
  return out.filter(b => b.traded > 0);
}

/** 门槛扫描：用来判断“门槛应该放在哪里”，以及提高门槛是否真的提升质量 */
export function thresholdSweep(cands: Candidate[], min = 0.42, max = 0.82, points = 21) {
  const step = (max - min) / (points - 1);
  const out: Array<{ thr: number; label: string } & Summary> = [];
  for (let i = 0; i < points; i++) {
    const thr = min + step * i;
    out.push({ thr, label: `${Math.round(thr * 100)}%`, ...summarize(cands, thr) });
  }
  return out;
}

/** 因子有效性：盈利单与亏损单的平均证据差，越大说明该因子在本样本越有区分力 */
export function attribution(cands: Candidate[], threshold: number): FactorAttribution[] {
  const pool = cands.filter(tradable);
  return FACTORS.map((f, i) => {
    let winSum = 0;
    let winN = 0;
    let lossSum = 0;
    let lossN = 0;
    let covered = 0;
    let used = 0;
    let killed = 0;
    for (const c of pool) {
      const e = c.evidence[i];
      if (e == null) continue;
      covered++;
      if (c.proba >= threshold) used++;
      else killed++;
      // r===0 既不是赢也不是亏（与 summarize 的 flat 口径一致），不参与盈亏证据对比
      if (c.outcome!.r > 0) {
        winSum += e;
        winN++;
      } else if (c.outcome!.r < 0) {
        lossSum += e;
        lossN++;
      }
    }
    const avgWin = winN ? winSum / winN : 0;
    const avgLoss = lossN ? lossSum / lossN : 0;
    return {
      key: f.key,
      label: f.label,
      short: f.short,
      group: f.group,
      weight: f.weight,
      coverage: pool.length ? covered / pool.length : 0,
      avgWin,
      avgLoss,
      edge: avgWin - avgLoss,
      used,
      killed,
    };
  }).sort((a, b) => b.edge - a.edge);
}

export function equitySeries(cands: Candidate[], threshold = 0) {
  const done = cands
    .filter(c => tradable(c) && c.proba >= threshold)
    .sort((a, b) => a.outcome!.exitTs - b.outcome!.exitTs);
  let cum = 0;
  return done.map(c => {
    cum += c.outcome!.r;
    return { ts: c.outcome!.exitTs, cumR: Number(cum.toFixed(2)), proba: c.proba, r: c.outcome!.r };
  });
}

/** 被门槛挡掉的单子里，哪几个因子最拖后腿 */
export function topKillers(cands: Candidate[], threshold: number) {
  const rejected = cands.filter(c => tradable(c) && c.proba < threshold);
  if (!rejected.length) return [];
  return FACTORS.map((f, i) => {
    let s = 0;
    let n = 0;
    for (const c of rejected) {
      const e = c.evidence[i];
      if (e == null) continue;
      s += e;
      n++;
    }
    return { key: f.key, label: f.label, short: f.short, avg: n ? s / n : 0, n };
  })
    .filter(k => k.n > 0)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 6);
}

export function gradeDistribution(cands: Candidate[]) {
  const g = { A: 0, B: 0, C: 0, D: 0 };
  // 未知等级直接跳过：此前 g[undefined]++ 会生成一个值为 NaN 的 "undefined" 键，
  // 并作为第 5 个对象带着 NaN 输出。
  for (const c of cands) if (tradable(c) && c.grade in g) g[c.grade]++;
  const total = g.A + g.B + g.C + g.D || 1;
  return (Object.keys(g) as (keyof typeof g)[]).map(k => ({ grade: k, n: g[k], pct: (g[k] / total) * 100 }));
}
