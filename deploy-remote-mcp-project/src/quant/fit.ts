// ─────────────────────────────────────────────────────────────
//  概率模型的统计检验层
//  · MAP 逻辑回归：以人工先验权重为中心做 L2 收缩，样本少时不会被噪音带跑
//  · 严格时间切分的 walk-forward：训练段拟合 → 测试段检验，测试段不参与拟合
//  · AUC / Brier / Wilson 区间：胜率是否可信，而不是看着高就下注
// ─────────────────────────────────────────────────────────────
import { FACTORS, MODEL, clamp, sigmoid } from './model';
import type { Candidate } from './scan';

export interface FitResult {
  weights: number[];
  base: number;
  iterations: number;
  converged: boolean;
  n: number;
}

export interface FitOptions {
  /** 收缩强度：越大越贴近先验 */
  l2?: number;
  prior?: number[];
  priorBase?: number;
  maxIter?: number;
}

export const priorWeights = () => FACTORS.map(f => MODEL.gain * f.weight);

const fill = (row: (number | null)[]) => row.map(v => (v == null || !Number.isFinite(v) ? 0 : clamp(v)));

/**
 * 牛顿法（IRLS）求解带先验的 L2 逻辑回归。
 * 目标：最大化 Σ loglik − l2/2 · ||w − prior||²
 */
export function fitLogistic(rows: (number | null)[][], y: number[], opts: FitOptions = {}): FitResult {
  const prior = opts.prior ?? priorWeights();
  const priorBase = opts.priorBase ?? MODEL.base;
  const l2 = opts.l2 ?? 6;
  const maxIter = opts.maxIter ?? 40;
  const d = FACTORS.length + 1; // 含截距
  const X = rows.map(r => [1, ...fill(r)]);
  const n = X.length;
  const center = [priorBase, ...prior];
  let w = [...center];
  if (n < 12) return { weights: prior, base: priorBase, iterations: 0, converged: false, n };

  let converged = false;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const grad = new Array<number>(d).fill(0);
    const hess: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * xi[j];
      const p = sigmoid(z);
      const err = y[i] - p;
      const s = Math.max(1e-6, p * (1 - p));
      for (let j = 0; j < d; j++) {
        grad[j] += err * xi[j];
        for (let k = j; k < d; k++) hess[j][k] += s * xi[j] * xi[k];
      }
    }
    // 先验（截距用很弱的收缩）
    for (let j = 0; j < d; j++) {
      const lam = j === 0 ? l2 * 0.15 : l2;
      grad[j] -= lam * (w[j] - center[j]);
      hess[j][j] += lam;
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) hess[j][k] = hess[k][j];
    const step = solve(hess, grad);
    if (!step) break;
    let maxDelta = 0;
    for (let j = 0; j < d; j++) {
      const clipped = Math.max(-1, Math.min(1, step[j]));
      w[j] += clipped;
      maxDelta = Math.max(maxDelta, Math.abs(clipped));
    }
    if (maxDelta < 1e-6) {
      converged = true;
      break;
    }
  }
  return { weights: w.slice(1), base: w[0], iterations: iter + 1, converged, n };
}

/** 高斯消元解 H·x = g（带主元选取） */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-10) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

export function predict(row: (number | null)[], fit: FitResult): number {
  const x = fill(row);
  let z = fit.base;
  for (let i = 0; i < x.length; i++) z += (fit.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

// ── 判别与校准指标 ───────────────────────────────────────────

/** AUC：随机取一胜一负，模型给胜率更高分的概率（0.5 = 无区分力） */
export function auc(scores: number[], y: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < y.length; i++) (y[i] > 0 ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Brier：越小越好；0.25 相当于永远猜 50% */
export function brier(scores: number[], y: number[]): number {
  if (!scores.length) return 0.25;
  return scores.reduce((s, p, i) => s + (p - (y[i] > 0 ? 1 : 0)) ** 2, 0) / scores.length;
}

export function logLoss(scores: number[], y: number[]): number {
  if (!scores.length) return Math.LN2;
  return (
    -scores.reduce((s, p, i) => {
      const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
      return s + (y[i] > 0 ? Math.log(q) : Math.log(1 - q));
    }, 0) / scores.length
  );
}

/** Wilson 95% 置信区间：小样本胜率的诚实误差带 */
export function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (!n) return { lo: 0, hi: 1 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

export interface SegmentStat {
  n: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
  auc: number;
  brier: number;
  ciLo: number;
  ciHi: number;
}

const tradable = (c: Candidate) => !!c.outcome?.filled && Number.isFinite(c.outcome.r);

/**
 * A training label is available only after the trade has exited.  Signal-time
 * slicing alone lets a trade that exits inside the test window leak its future
 * outcome into fitting, so purge those overlapping training samples.
 */
const knownBefore = (c: Candidate, splitTs: number) =>
  c.ts < splitTs && (c.outcome?.exitTs ?? c.ts) < splitTs;

function evaluate(rows: Candidate[], scores: number[], threshold: number): SegmentStat {
  const idx = rows.map((_, i) => i).filter(i => scores[i] >= threshold);
  const n = idx.length;
  const wins = idx.filter(i => rows[i].outcome!.r > 0).length;
  const totalR = idx.reduce((s, i) => s + rows[i].outcome!.r, 0);
  const y = rows.map(c => (c.outcome!.r > 0 ? 1 : 0));
  const ci = wilson(wins, n);
  return {
    n,
    wins,
    winRate: n ? (wins / n) * 100 : 0,
    avgR: n ? totalR / n : 0,
    totalR,
    auc: auc(scores, y),
    brier: brier(scores, y),
    ciLo: ci.lo * 100,
    ciHi: ci.hi * 100,
  };
}

/**
 * 按分数取前 N 笔评估。
 * 不同模型的概率尺度不同（精简模型分数天然更靠近 50%），
 * 用同一个绝对门槛比较不公平；改为同等录取笔数，比的才是排序能力。
 */
function evaluateTop(rows: Candidate[], scores: number[], take: number): SegmentStat {
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const chosen = new Set(order.slice(0, Math.max(0, take)).map(o => o.i));
  const picked = rows.map((_, i) => (chosen.has(i) ? 1 : 0));
  const selected = evaluate(rows, picked, 0.5);
  // `picked` is only a selection mask for the top-N experiment.  Using it as
  // the model score made AUC/Brier describe a binary 0/1 vector instead of the
  // fitted model.  Keep top-N trading stats, but evaluate discrimination and
  // calibration with the actual continuous scores over the full test set.
  const y = rows.map(c => (c.outcome!.r > 0 ? 1 : 0));
  return { ...selected, auc: auc(scores, y), brier: brier(scores, y) };
}

export interface FactorDiagnostic {
  key: string;
  label: string;
  group: string;
  liveOnly: boolean;
  /** 训练段单变量 AUC（>0.5 = 证据越大越容易赢） */
  trainAuc: number;
  /** 测试段单变量 AUC */
  testAuc: number;
  /** 两段方向一致且都偏离 0.5 至少 0.03 才算稳定 */
  stable: boolean;
  n: number;
}

/** 单因子诊断：这条关系在训练段和测试段是否都真的指向胜率 */
export function factorDiagnostics(train: Candidate[], test: Candidate[]): FactorDiagnostic[] {
  return FACTORS.map((f, i) => {
    const slice = (rows: Candidate[]) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of rows) {
        const e = c.evidence[i];
        if (e == null) continue;
        xs.push(e);
        ys.push(c.outcome!.r > 0 ? 1 : 0);
      }
      return { xs, ys, n: xs.length };
    };
    const a = slice(train);
    const b = slice(test);
    const trainAuc = a.n >= 8 ? auc(a.xs, a.ys) : 0.5;
    const testAuc = b.n >= 8 ? auc(b.xs, b.ys) : 0.5;
    const sameSide = (trainAuc - 0.5) * (testAuc - 0.5) > 0;
    return {
      key: f.key,
      label: f.label,
      group: f.group,
      liveOnly: !!f.liveOnly,
      trainAuc,
      testAuc,
      stable: sameSide && Math.abs(trainAuc - 0.5) >= 0.03 && Math.abs(testAuc - 0.5) >= 0.03,
      n: a.n + b.n,
    };
  }).sort((x, y) => y.testAuc - x.testAuc);
}

export interface WalkForward {
  trainN: number;
  testN: number;
  splitTs: number;
  fit: FitResult;
  /** 测试段：人工先验模型 */
  prior: SegmentStat;
  /** 测试段：训练段拟合后的模型 */
  fitted: SegmentStat;
  /** 测试段：不设门槛的全部形态 */
  raw: SegmentStat;
  /** 测试段：训练段自动筛选出的精简模型 */
  sparse: SegmentStat;
  sparseKept: string[];
  trainStat: SegmentStat;
  /** 逐折滚动验证（时间顺序，训练窗永远在测试窗之前） */
  folds: { i: number; trainN: number; testN: number; prior: SegmentStat; fitted: SegmentStat }[];
  coefficients: { key: string; label: string; group: string; prior: number; fitted: number; delta: number }[];
  diagnostics: FactorDiagnostic[];
  /** 通过两段一致性检验的因子数量 */
  stableCount: number;
}

/**
 * 时间序列 walk-forward：
 * 前 trainFrac 的时间用于拟合，其余用于检验；再做 3 折滚动确认稳定性。
 */
export function walkForward(cands: Candidate[], threshold: number, trainFrac = 0.7): WalkForward | null {
  const pool = cands.filter(tradable).sort((a, b) => a.ts - b.ts);
  if (pool.length < 40) return null;
  const cut = Math.floor(pool.length * trainFrac);
  const splitTs = pool[cut]?.ts ?? 0;
  const train = pool.slice(0, cut).filter(c => knownBefore(c, splitTs));
  const test = pool.slice(cut);
  if (train.length < 20 || test.length < 10) return null;

  const fit = fitLogistic(
    train.map(c => c.evidence),
    train.map(c => (c.outcome!.r > 0 ? 1 : 0)),
    { l2: 6 },
  );
  const sparseFit = fitSparse(train);
  const priorScores = test.map(c => c.proba);
  const fittedScores = test.map(c => predict(c.evidence, fit));
  const sparseScores = test.map(c => predict(c.evidence, sparseFit));
  const trainScores = train.map(c => predict(c.evidence, fit));

  const folds: WalkForward['folds'] = [];
  const foldCount = 3;
  const foldSize = Math.floor(pool.length / (foldCount + 1));
  for (let k = 1; k <= foldCount; k++) {
    const end = foldSize * k;
    const te = pool.slice(end, end + foldSize);
    const foldSplitTs = te[0]?.ts ?? 0;
    const tr = pool.slice(0, end).filter(c => knownBefore(c, foldSplitTs));
    if (tr.length < 20 || te.length < 8) continue;
    const f = fitLogistic(
      tr.map(c => c.evidence),
      tr.map(c => (c.outcome!.r > 0 ? 1 : 0)),
      { l2: 6 },
    );
    folds.push({
      i: k,
      trainN: tr.length,
      testN: te.length,
      prior: evaluate(te, te.map(c => c.proba), threshold),
      fitted: evaluate(te, te.map(c => predict(c.evidence, f)), threshold),
    });
  }

  const pw = priorWeights();
  const diagnostics = factorDiagnostics(train, test);
  const priorStat = evaluate(test, priorScores, threshold);
  const take = priorStat.n; // 同等录取笔数
  return {
    diagnostics,
    stableCount: diagnostics.filter(d => d.stable).length,
    trainN: train.length,
    testN: test.length,
    splitTs,
    fit,
    prior: priorStat,
    fitted: evaluateTop(test, fittedScores, take),
    raw: evaluate(test, test.map(() => 0), 0),
    sparse: evaluateTop(test, sparseScores, take),
    sparseKept: sparseFit.kept,
    trainStat: evaluate(train, trainScores, threshold),
    folds,
    coefficients: FACTORS.map((f, i) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      prior: pw[i],
      fitted: fit.weights[i],
      delta: fit.weights[i] - pw[i],
    })),
  };
}

/**
 * 精简模型：只用训练段自己筛出来的因子。
 * 筛选与方向判定都只看训练段（单变量 AUC 偏离 0.5 至少 0.04），
 * 未入选的因子权重强制为 0，避免把噪音方向写进模型。
 */
export function fitSparse(train: Candidate[], l2 = 8): FitResult & { kept: string[] } {
  const prior = priorWeights();
  const ys = train.map(c => (c.outcome!.r > 0 ? 1 : 0));
  const kept: string[] = [];
  const mask = FACTORS.map((f, i) => {
    const xs: number[] = [];
    const yy: number[] = [];
    train.forEach((c, k) => {
      const e = c.evidence[i];
      if (e == null) return;
      xs.push(e);
      yy.push(ys[k]);
    });
    if (xs.length < 12) return false;
    const a = auc(xs, yy);
    const ok = Math.abs(a - 0.5) >= 0.04;
    if (ok) kept.push(f.label);
    return ok;
  });
  const centered = prior.map((w, i) => {
    if (!mask[i]) return 0;
    const xs: number[] = [];
    const yy: number[] = [];
    train.forEach((c, k) => {
      const e = c.evidence[i];
      if (e == null) return;
      xs.push(e);
      yy.push(ys[k]);
    });
    const a = auc(xs, yy);
    return Math.abs(w) * (a >= 0.5 ? 1 : -1);
  });
  const rows = train.map(c => c.evidence.map((v, i) => (mask[i] ? v : 0)));
  const fit = fitLogistic(rows, ys, { l2, prior: centered });
  fit.weights = fit.weights.map((w, i) => (mask[i] ? w : 0));
  return { ...fit, kept };
}

/** 用训练段拟合出的模型，对全样本重新打分（仅用于面板展示，不参与实时判定） */
export function rescore(cands: Candidate[], fit: FitResult) {
  return cands.map(c => ({ ...c, proba: Number(predict(c.evidence, fit).toFixed(3)) }));
}
