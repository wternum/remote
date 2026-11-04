// ─────────────────────────────────────────────────────────────
//  配置寻优：入场方式 × 出场方案 × 概率门槛
//  样本内表现好不算数，必须同时在时间上更靠后的样本外区间站得住。
// ─────────────────────────────────────────────────────────────
import type { Candidate, ExitPlan } from './scan';
import { EXIT_PLANS } from './scan';
import type { EntryMode } from './config';
import { summarize, type Summary } from './stats';
import { wilson } from './fit';

export interface Combo {
  id: string;
  entryMode: EntryMode;
  exitPlan: ExitPlan;
  exitLabel: string;
  threshold: number;
  is: Summary;
  oos: SegmentSlim;
  /** 综合评分：样本外为主、样本内为辅，方向矛盾重罚 */
  score: number;
  verdict: 'validated' | 'weak' | 'rejected';
}

export interface SegmentSlim {
  n: number;
  winRate: number;
  avgR: number;
  totalR: number;
  ciLo: number;
  ciHi: number;
}

const tradable = (c: Candidate) => !!c.outcome?.filled && Number.isFinite(c.outcome.r);

// In-sample labels must have exited before the out-of-sample window starts;
// otherwise a position opened in-sample but closed later leaks future prices.
const knownBefore = (c: Candidate, splitTs: number) =>
  c.ts < splitTs && (c.outcome?.exitTs ?? c.ts) < splitTs;

const applyPlan = (rows: Candidate[], plan: ExitPlan): Candidate[] =>
  rows.map(c => ({ ...c, outcome: c.exits?.[plan] ?? c.outcome }));

function slim(rows: Candidate[], threshold: number): SegmentSlim {
  const s = summarize(rows, threshold);
  const ci = wilson(s.wins, s.traded);
  return {
    n: s.traded,
    winRate: s.winRate,
    avgR: s.avgR,
    totalR: s.totalR,
    ciLo: ci.lo * 100,
    ciHi: ci.hi * 100,
  };
}

export interface OptimizeResult {
  combos: Combo[];
  best: Combo | null;
  /** 通过样本外检验的组合数 */
  validated: number;
  splitTs: number;
  totalIs: number;
  totalOos: number;
}

/**
 * 网格搜索。样本按时间排序后切 70/30：
 * 前段用于观察，后段用于检验；只有后段期望为正、笔数够、且与前段不矛盾才算通过。
 */
export function optimize(confirm: Candidate[], touch: Candidate[], oosFrac = 0.3): OptimizeResult {
  const pools: Record<EntryMode, Candidate[]> = {
    confirm: confirm.filter(tradable),
    touch: touch.filter(tradable),
  };
  const main = pools.confirm.length >= pools.touch.length ? pools.confirm : pools.touch;
  if (main.length < 30) return { combos: [], best: null, validated: 0, splitTs: 0, totalIs: 0, totalOos: 0 };
  const sorted = [...main].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * (1 - oosFrac));
  const splitTs = sorted[cut]?.ts ?? 0;

  const thresholds = [0.5, 0.55, 0.58, 0.62, 0.66, 0.7, 0.74];
  const combos: Combo[] = [];
  for (const entryMode of ['confirm', 'touch'] as EntryMode[]) {
    const pool = pools[entryMode];
    if (pool.length < 20) continue;
    for (const plan of EXIT_PLANS) {
      const mapped = applyPlan(pool, plan.id).filter(tradable);
      const isRows = mapped.filter(c => knownBefore(c, splitTs));
      const oosRows = mapped.filter(c => c.ts >= splitTs);
      if (oosRows.length < 8) continue;
      for (const threshold of thresholds) {
        const is = summarize(isRows, threshold);
        const oos = slim(oosRows, threshold);
        if (is.traded < 8 || oos.n < 5) continue;
        const agree = Math.sign(is.avgR) === Math.sign(oos.avgR);
        // 样本外为主：用 sqrt(n) 抑制小样本运气；方向矛盾直接扣到底
        const raw = oos.avgR * Math.sqrt(oos.n) + 0.35 * is.avgR * Math.sqrt(is.traded);
        const score = agree ? raw : raw - Math.abs(raw) - 0.5;
        const verdict: Combo['verdict'] =
          oos.avgR > 0.05 && is.avgR > 0 && oos.n >= 8
            ? 'validated'
            : oos.avgR > 0 || is.avgR > 0
              ? 'weak'
              : 'rejected';
        combos.push({
          id: `${entryMode}|${plan.id}|${threshold}`,
          entryMode,
          exitPlan: plan.id,
          exitLabel: plan.label,
          threshold,
          is,
          oos,
          score,
          verdict,
        });
      }
    }
  }
  // 稳健优先：先按是否通过双重检验分档，再比分数。
  // 否则样本外只有 5 笔的幸运组合会排在 16 笔的稳定组合前面。
  const rank = (c: Combo) => (c.verdict === 'validated' ? 0 : c.verdict === 'weak' ? 1 : 2);
  combos.sort((a, b) => rank(a) - rank(b) || b.score - a.score);
  const validated = combos.filter(c => c.verdict === 'validated').length;
  return {
    combos: combos.slice(0, 6),
    best: combos[0] ?? null,
    validated,
    splitTs,
    totalIs: cut,
    totalOos: sorted.length - cut,
  };
}

/** 当前配置是否真的比“不设门槛”更好 */
export function edgeOverBaseline(gated: Summary, baseline: Summary) {
  const dEv = gated.avgR - baseline.avgR;
  const dWin = gated.winRate - baseline.winRate;
  const enough = gated.traded >= 15 && baseline.traded >= 15;
  return {
    dEv,
    dWin,
    enough,
    better: enough && dEv > 0.02,
    worse: enough && dEv < -0.02,
  };
}
