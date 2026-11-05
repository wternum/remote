import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { annotationTolerance } from './patterns';
import { legFlow } from './evidence';

// Explicit engineering thresholds inherited from the annotation implementation; not fitted probabilities.
export const BREAK_ATR = 0.2;
export const RETEST_WINDOW = 48;
export const RECLAIM_WINDOW = 12;
export const MW_VOLUME = { breakout: 1.5, weakBreak: 1.2, contract: 0.9, deepRetest: 0.618 } as const;
export type LineState = 'pending' | 'broken' | 'touch' | 'retest' | 'continued' | 'failed' | 'expired';
export interface LineEvent { kind: 'crossing' | 'accepted' | 'touch' | 'held' | 'continued' | 'failed' | 'expired'; idx: number; at: number }
export interface LineRead {
  kind: 'level' | 'neck'; price: number; dir: 1 | -1; state: LineState;
  firstBreak: number; acceptedAt: number; reachedIdx: number; retestConfirmedAt: number;
  failedAt: number; expiredAt: number; lastEventIdx: number;
  flowComplete: boolean; flowAligned: boolean; flowRatio: number | null;
  waited: number; distAtr: number; lo: number; hi: number;
  events: LineEvent[];
}

/** One forward, causal lifecycle shared by both the level and neckline. No UI/verdict is generated here. */
export function evaluateLine(ctx: Ctx, barMs: number, price: number, dir: 1 | -1,
  startIdx: number, kind: LineRead['kind'], flow?: FlowSnapshot | null): LineRead | null {
  const { cs, atr, n } = ctx;
  if (startIdx < 0 || startIdx >= n - 1 || !(barMs > 0)) return null;
  const a = (i: number) => Math.max(atr[i] || 0, 1e-9);
  const beyond = (i: number) => i >= 0 && dir * (cs[i].c - price) > BREAK_ATR * a(i);
  const inside = (i: number) => dir * (cs[i].c - price) < -BREAK_ATR * a(i);
  const events: LineEvent[] = [];
  let latest: LineRead | null = null, pending = -1;
  const emit = (r: LineRead, event: LineEvent['kind'], i: number) => {
    events.push({ kind: event, idx: i, at: cs[i].ts + barMs });
    r.lastEventIdx = i;
  };
  const make = (i: number, acceptedAt: number): LineRead => {
    const anchor = acceptedAt >= 0 ? acceptedAt : i;
    const tol = Math.max(annotationTolerance(price, a(anchor)), 0.15 * a(anchor));
    const w = acceptedAt >= 0 ? legFlow(ctx, flow, i, acceptedAt, barMs) : null;
    return { kind, price, dir, state: acceptedAt >= 0 ? 'broken' : 'pending', firstBreak: i, acceptedAt,
      reachedIdx: -1, retestConfirmedAt: -1, failedAt: -1, expiredAt: -1, lastEventIdx: anchor,
      flowComplete: !!w?.complete, flowAligned: w?.ratio != null && w.ratio * dir >= 0.04,
      flowRatio: w?.ratio ?? null, waited: 0, distAtr: 0, lo: price - tol, hi: price + tol, events };
  };
  for (let i = startIdx + 1; i < n; i++) {
    if (cs[i].ts - cs[i - 1].ts !== barMs) {
      pending = -1;
      if (latest && !['expired', 'failed'].includes(latest.state)) {
        latest.state = 'expired'; latest.expiredAt = i; emit(latest, 'expired', i);
      }
      continue;
    }
    const active = latest && !['expired', 'failed', 'pending'].includes(latest.state);
    if (active && latest) {
      const r = latest;
      r.waited = i - r.acceptedAt;
      if (inside(i)) { r.state = 'failed'; r.failedAt = i; emit(r, 'failed', i); continue; }
      if (r.reachedIdx < 0 && cs[i].h >= r.lo && cs[i].l <= r.hi) {
        r.reachedIdx = i; emit(r, 'touch', i);
      }
      if ((r.reachedIdx < 0 && r.waited >= RETEST_WINDOW) || (r.reachedIdx >= 0 && i - r.reachedIdx > RECLAIM_WINDOW)) {
        r.state = 'expired'; r.expiredAt = i; emit(r, 'expired', i); continue;
      }
      if (r.reachedIdx >= 0) {
        const old = r.state;
        if (!beyond(i)) r.state = 'touch';
        else {
          r.state = 'retest';
          if (r.retestConfirmedAt < 0) { r.retestConfirmedAt = i; emit(r, 'held', i); }
          if (i > r.retestConfirmedAt && dir * (cs[i].c - price) > (r.hi - r.lo) / 2 + 0.4 * a(i)) r.state = 'continued';
          if (r.state === 'continued' && old !== 'continued') emit(r, 'continued', i);
        }
      }
      r.distAtr = cs[i].c < r.lo ? (r.lo - cs[i].c) / a(i) : cs[i].c > r.hi ? (cs[i].c - r.hi) / a(i) : 0;
      continue;
    }
    if (pending === i - 1 && beyond(i)) {
      latest = make(pending, i); emit(latest, 'accepted', i); pending = -1; continue;
    }
    pending = -1;
    // A cycle starts on a new crossing, never on an indefinitely continuing outside close.
    if (beyond(i) && (i === startIdx + 1 || !beyond(i - 1))) {
      pending = i;
      events.push({ kind: 'crossing', idx: i, at: cs[i].ts + barMs });
    }
  }
  if (pending === n - 1) return make(pending, -1);
  return latest;
}
