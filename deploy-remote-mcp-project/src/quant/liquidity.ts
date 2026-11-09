// Liquidity / stop-run CANDIDATES from price structure only.
// Public OHLCV cannot observe resting stops, account identity, or institutional intent.
// We reuse the project's confirmed swing detector (left=8, right=5) and never use
// a pivot before its fifth right-hand bar has closed. A tested/broken pool is consumed.
import type { Ctx } from './context';
import { findSwingLevels, type SwingLevel } from './orderflow';
import { latestStructure, type StructureEvent } from './smartmoney';

const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
const RIGHT_CONFIRM_BARS = 5; // Must match findSwingLevels default right window.
const FRESH_EVENT_BARS = 48;

interface ConfirmedLevel extends SwingLevel {
  confirmedIdx: number;
}

export interface LiquidityPoolCluster {
  /** Tested side: above = resistance/swing highs; below = support/swing lows. */
  side: 'above' | 'below';
  price: number;
  /** Number of DISTINCT confirmed swings in the cluster, not adjacent candles. */
  touches: number;
  equal: boolean;
  active: boolean;
  firstTs: number;
  lastTs: number;
  distanceAtr: number;
}

export interface StopHunt {
  side: 'above' | 'below';
  level: number;
  idx: number;
  ts: number;
  ageBars: number;
  depthAtr: number;
  touches: number;
  reclaimed: boolean;
  /** sweep = wick through + close back inside; break = close beyond buffer. */
  kind: 'sweep' | 'break';
  taker: number | null;
  reason: string;
}

export interface LiquidityRead {
  pools: LiquidityPoolCluster[];
  nearestAbove: LiquidityPoolCluster | null;
  nearestBelow: LiquidityPoolCluster | null;
  stopHunts: StopHunt[];
  structure: StructureEvent | null;
  structureTs: number | null;
  structureAgeBars: number | null;
  bias: 1 | -1 | 0;
  strength: number;
  headline: string;
}

const scaleOf = (ctx: Ctx, idx: number) => {
  const a = ctx.atr[idx];
  if (Number.isFinite(a) && a > 0) return a;
  const price = ctx.cs[idx]?.c ?? 1;
  return Math.max(Number.EPSILON, Math.abs(price) * 0.001);
};

function confirmedLevels(ctx: Ctx, maxAge: number): ConfirmedLevel[] {
  const to = ctx.n - 1;
  // Default options hit the per-Ctx WeakMap cache; custom maxAge would rescan.
  return findSwingLevels(ctx)
    .filter(l => l.idx + RIGHT_CONFIRM_BARS <= to && to - l.idx <= maxAge)
    .map(l => ({ ...l, confirmedIdx: l.idx + RIGHT_CONFIRM_BARS }));
}

/** Bounded-width EQH/EQL clusters; single swings are references, not equal-level pools. */
export function equalLevels(ctx: Ctx, maxAge = 480): { tops: LiquidityPoolCluster[]; bottoms: LiquidityPoolCluster[] } {
  const to = ctx.n - 1;
  if (to < 0) return { tops: [], bottoms: [] };
  const price = ctx.cs[to].c;
  const a = scaleOf(ctx, to);
  const levels = confirmedLevels(ctx, maxAge);
  const cluster = (side: 'top' | 'bottom') => {
    const list = levels.filter(l => l.side === side).sort((x, y) => x.price - y.price || x.idx - y.idx);
    const tol = Math.max(0.35 * a, 0.0004 * Math.abs(price));
    const out: LiquidityPoolCluster[] = [];
    let anchor = Infinity;
    for (const p of list) {
      const last = out[out.length - 1];
      // Compare with the cluster anchor too, preventing transitive drift across
      // an arbitrarily wide chain of individually nearby prices.
      const pActive = p.breakIdx == null;
      if (last && Math.abs(last.price - p.price) <= tol && Math.abs(anchor - p.price) <= tol) {
        last.price = (last.price * last.touches + p.price) / (last.touches + 1);
        last.touches++;
        last.equal = last.touches >= 2;
        last.active = last.active || pActive;
        last.firstTs = Math.min(last.firstTs, p.ts);
        last.lastTs = Math.max(last.lastTs, p.ts);
      } else {
        anchor = p.price;
        out.push({ side: side === 'top' ? 'above' : 'below', price: p.price, touches: 1, equal: false, active: pActive, firstTs: p.ts, lastTs: p.ts, distanceAtr: 0 });
      }
    }
    for (const c of out) c.distanceAtr = r3(Math.abs(price - c.price) / a);
    return out;
  };
  return { tops: cluster('top'), bottoms: cluster('bottom') };
}

/**
 * First post-confirmation test of each resting-level candidate. Ambiguous closes
 * near the level are ignored. Once swept or closed through, that pool is consumed.
 */
export function stopHunts(ctx: Ctx, lookback = 160, minDepthAtr = 0.2, minTouches = 2): StopHunt[] {
  const { cs, n } = ctx;
  const to = n - 1;
  if (to < 1) return [];
  const horizon = Math.max(1, Math.floor(lookback));
  const levels = confirmedLevels(ctx, horizon + 60);
  const out: StopHunt[] = [];
  for (const lv of levels) {
    // If it was already broken before becoming a confirmed reference, it is not
    // a new resting pool. Comparing only to confirmation time avoids future leakage.
    if (lv.breakIdx != null && lv.breakIdx <= lv.confirmedIdx) continue;
    const start = Math.max(lv.confirmedIdx + 1, to - horizon + 1);
    if (start > to) continue;
    const top = lv.side === 'top';
    const confirmAtr = scaleOf(ctx, lv.confirmedIdx);
    const tol = Math.max(0.35 * confirmAtr, 0.0004 * Math.abs(lv.price));
    const peers = levels.filter(p => p.side === lv.side && Math.abs(p.price - lv.price) <= tol);
    for (let q = start; q <= to; q++) {
      const c = cs[q];
      const a = scaleOf(ctx, q);
      const closeBeyond = top ? c.c > lv.price + 0.1 * a : c.c < lv.price - 0.1 * a;
      const closeInside = top ? c.c < lv.price : c.c > lv.price;
      const pierce = top ? c.h - lv.price : lv.price - c.l;
      if (!closeBeyond && pierce < minDepthAtr * a) continue;
      // Distinct swings known strictly BEFORE this test; adjacent wiggles at the
      // same price do not manufacture extra "resting liquidity" counts.
      const touches = peers.filter(p => p.idx < q && p.confirmedIdx < q).length;
      if (touches < minTouches) {
        if (closeBeyond) break; // Consumed single swing; latestStructure handles it.
        continue;
      }
      if (!closeInside && !closeBeyond) continue; // Close too near the edge: unresolved.
      const reclaimed = closeInside;
      const kind: StopHunt['kind'] = reclaimed ? 'sweep' : 'break';
      const isReal = ctx.real[q] === 1;
      const taker = isReal && ctx.vols[q] > 0 ? r3(ctx.delta[q] / ctx.vols[q]) : null;
      const depth = Math.max(0, pierce / a);
      const side = top ? 'above' : 'below';
      const reason = kind === 'sweep'
        ? `${top ? '上方' : '下方'} ${touches} 个已确认摆动参考价被刺穿 ${depth.toFixed(2)} ATR 后收盘收回：扫位收回候选。公共行情无法证明止损单身份或数量。`
        : `${top ? '上方' : '下方'} ${touches} 个已确认摆动参考价被收盘越过缓冲带：越位候选，不等同多根成交接受或“真突破”。`;
      out.push({ side, level: lv.price, idx: q, ts: c.ts, ageBars: to - q, depthAtr: r3(depth), touches, reclaimed, kind, taker, reason });
      break;
    }
  }
  const seen = new Set<string>();
  return out
    .filter(s => {
      const key = `${s.idx}:${s.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.idx - a.idx || b.touches - a.touches || b.depthAtr - a.depthAtr)
    .slice(0, 4);
}

/** Only fresh events drive bias; historical events remain visible but decay to zero. */
export function readLiquidity(ctx: Ctx, lookback = 160): LiquidityRead {
  const to = ctx.n - 1;
  if (to < 0) return { pools: [], nearestAbove: null, nearestBelow: null, stopHunts: [], structure: null, structureTs: null, structureAgeBars: null, bias: 0, strength: 0, headline: '没有已收盘行情。' };
  const price = ctx.cs[to].c;
  const { tops, bottoms } = equalLevels(ctx);
  const pools = [...tops, ...bottoms];
  const pickNearest = (list: LiquidityPoolCluster[], ok: (p: LiquidityPoolCluster) => boolean) =>
    list.filter(ok).sort((x, y) => Number(y.active) - Number(x.active) || x.distanceAtr - y.distanceAtr)[0] ?? null;
  const nearestAbove = pickNearest(tops, p => p.price >= price);
  const nearestBelow = pickNearest(bottoms, p => p.price <= price);
  const hunts = stopHunts(ctx, lookback);
  const structure = latestStructure(ctx, to);
  const structureTs = structure ? ctx.cs[structure.idx]?.ts ?? null : null;
  const structureAgeBars = structure ? to - structure.idx : null;
  const latest = hunts.find(h => h.ageBars <= FRESH_EVENT_BARS);
  let bias: 1 | -1 | 0 = 0;
  let strength = 0;
  if (latest) {
    const freshness = Math.max(0, 1 - latest.ageBars / FRESH_EVENT_BARS);
    bias = latest.kind === 'sweep' ? (latest.side === 'above' ? -1 : 1) : (latest.side === 'above' ? 1 : -1);
    strength = r3((latest.kind === 'sweep' ? 0.6 : 0.45) * freshness);
  } else if (structure && to - structure.idx <= FRESH_EVENT_BARS) {
    bias = structure.dir;
    strength = r3(0.3 * Math.max(0, 1 - (to - structure.idx) / FRESH_EVENT_BARS));
  }
  const headline = latest
    ? `${latest.ageBars} 根前：${latest.side === 'above' ? '上方' : '下方'} ${latest.touches} 个摆动参考价${latest.kind === 'sweep' ? '扫位收回' : '收盘越位'} → 结构偏${bias > 0 ? '多' : '空'}候选（启发式，非胜率）。`
    : structure && to - structure.idx <= FRESH_EVENT_BARS
      ? `近期无新的扫位事件；${to - structure.idx} 根前出现简化 ${structure.kind} 收盘越位事件。`
      : '近期没有足够新的扫位/越位证据；历史关键位仅作参考，方向保持中性。';
  return { pools, nearestAbove, nearestBelow, stopHunts: hunts, structure, structureTs, structureAgeBars, bias, strength, headline };
}
