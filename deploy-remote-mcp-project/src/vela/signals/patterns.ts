import type { Candle } from '@/lib/types';
import { DEFAULT_PARAMS } from '../../../remote/setup-mcp-project-locally/src/lib/engine';
import type { Ctx } from '@/quant/context';

/** Price structure only. This is NOT the original execution scanner or a probability model. */
export interface AnnotationPattern {
  side: 'top' | 'bottom';
  /** Index of the bar whose CLOSE first confirmed the second test. */
  idx: number;
  first: number;
  second: number;
  neckIdx: number;
  /** Start of the price move that formed the first pivot (an opposite extreme). */
  firstLegStart: number;
  /** Neck extreme between the two tests; start of the second push into the level. */
  secondLegStart: number;
  level: number;
  neck: number;
  secondPrice: number;
}

interface ActiveLevel {
  first: number;
  firstLegStart: number;
  price: number;
  neck: number;
  neckIdx: number;
  pending: number | null;
}

const p = DEFAULT_PARAMS;
const L = p.pivotLeft;
const R = p.pivotRight;
const MAX_TOL_ATR = 0.7;

/**
 * A causal double test: the first pivot only exists after R *closed* right bars;
 * the second test needs enough neck-to-level height and a close back inside.
 * No fees, risk/reward, stop placement, trend filter, or future bar volume is used.
 * Numeric ATR tolerances are inherited engineering heuristics, not fitted win rates.
 */
export function scanAnnotationPatterns(ctx: Ctx): AnnotationPattern[] {
  const { cs, atr } = ctx;
  if (cs.length < L + R + p.minGap) return [];
  const out: AnnotationPattern[] = [];
  // Mirror the price axis for tops so both directions use exactly the same rules.
  for (const side of ['bottom', 'top'] as const) {
    const sign = side === 'bottom' ? 1 : -1;
    const view = side === 'bottom'
      ? cs
      : cs.map(c => ({ ts: c.ts, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v } satisfies Candle));
    const active: ActiveLevel[] = [];
    const width = (price: number, a: number) => Math.min(
      Math.max(p.tolAtr * a, p.tolPct * Math.abs(price)),
      MAX_TOL_ATR * a,
    );

    for (let i = 1; i < view.length; i++) {
      const c = view[i];
      const a = atr[i];
      if (!(a > 0)) continue;
      for (let k = active.length - 1; k >= 0; k--) {
        const lv = active[k];
        const tol = width(lv.price, a);
        if (i - lv.first > p.lookback || c.l < lv.price - p.sweepAtr * a || c.c < lv.price - tol) {
          active.splice(k, 1);
          continue;
        }
        const range = Math.max(c.h - c.l, 1e-9);
        const closePos = (c.c - c.l) / range;
        const wick = (Math.min(c.o, c.c) - c.l) / range;
        const rejection = c.c >= lv.price + p.closeBufAtr * a && closePos >= 0.5 &&
          (c.c > c.o || wick >= 0.35);
        const emit = (second: number) => {
          out.push({
            side,
            idx: i,
            first: lv.first,
            second,
            neckIdx: lv.neckIdx,
            firstLegStart: lv.firstLegStart,
            secondLegStart: lv.neckIdx,
            level: sign * lv.price,
            neck: sign * lv.neck,
            secondPrice: sign * view[second].l,
          });
          active.splice(k, 1); // One second test per confirmed first pivot.
        };
        if (lv.pending !== null) {
          const test = view[lv.pending];
          // A touch may be confirmed by the immediately following closed candle only.
          if (i === lv.pending + 1 && rejection && c.c > test.c) emit(lv.pending);
          else active.splice(k, 1);
          continue;
        }
        const qualified = i - lv.first >= p.minGap && lv.neck - lv.price >= p.minHeightAtr * a;
        if (qualified && c.l <= lv.price + tol) {
          if (rejection) emit(i);
          else lv.pending = i;
        } else if (c.h > lv.neck) {
          lv.neck = c.h;
          lv.neckIdx = i;
        }
      }

      // A first extreme is only known at j + R; no bars beyond i are inspected.
      const j = i - R;
      if (j < L) continue;
      const low = view[j].l;
      let pivot = true;
      for (let q = j - L; q < j && pivot; q++) if (view[q].l <= low) pivot = false;
      for (let q = j + 1; q <= i && pivot; q++) if (view[q].l < low) pivot = false;
      if (!pivot) continue;
      const priorBars = Math.max(3 * L, 24);
      let prior = -Infinity;
      let priorIdx = j;
      for (let q = Math.max(0, j - priorBars); q < j; q++) {
        if (view[q].h > prior) {
          prior = view[q].h;
          priorIdx = q;
        }
      }
      if (prior - low < p.priorMoveAtr * a) continue;
      const tol = width(low, a);
      if (active.some(lv => Math.abs(lv.price - low) <= tol)) continue;
      let neck = -Infinity;
      let neckIdx = j;
      for (let q = j + 1; q <= i; q++) {
        if (view[q].h > neck) { neck = view[q].h; neckIdx = q; }
      }
      active.push({ first: j, firstLegStart: priorIdx, price: low, neck, neckIdx, pending: null });
    }
  }
  return out.sort((a, b) => a.idx - b.idx || a.first - b.first);
}
