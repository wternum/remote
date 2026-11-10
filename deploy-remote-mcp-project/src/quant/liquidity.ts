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
  confirmedTs: number;
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
  /** Open time of the confirming bar when this reference/cluster became known. */
  firstConfirmedTs: number;
  confirmedTs: number;
  distanceAtr: number;
}

/**
 * 待确认摆动点：左侧 8 根都更低/更高，右侧已收盘 2–4 根还没被越过，只差右侧凑满 5 根。
 * 只做"提前看见"的参考线，不参与扫位/越位、等高等低池和方向判断。
 */
export interface PendingSwing {
  side: 'above' | 'below';
  price: number;
  idx: number;
  ts: number;
  /** 右侧已收盘根数（2–4） */
  rightBars: number;
  /** 确认所需右侧根数（5） */
  needBars: number;
  /** 若右侧继续不越过，将在这根收盘后确认（开盘时间） */
  confirmTs: number;
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
  /** 最近的未破等高 / 等低池（≥2 个摆动）。常比更近的单个前高/前低更重要，单独给出。 */
  poolAbove: LiquidityPoolCluster | null;
  poolBelow: LiquidityPoolCluster | null;
  /** 待确认前高/前低（右侧 2–4 根），确认前只作提示 */
  pendingAbove: PendingSwing | null;
  pendingBelow: PendingSwing | null;
  stopHunts: StopHunt[];
  structure: StructureEvent | null;
  structureTs: number | null;
  structureAgeBars: number | null;
  /** 最近 48 根里的突破 / 跌破 / 假突破 / 假跌破（图上统一用这四个词） */
  tests: LevelTest[];
  /** 最近 160 根内已确认的摆动高低点 */
  swings: RecentSwing[];
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

const levelTol = (ctx: Ctx, lv: ConfirmedLevel) =>
  Math.max(0.2 * scaleOf(ctx, lv.confirmedIdx), 0.0004 * Math.abs(lv.price));

function confirmedLevels(ctx: Ctx, maxAge: number): ConfirmedLevel[] {
  const to = ctx.n - 1;
  // Default options hit the per-Ctx WeakMap cache; custom maxAge would rescan.
  return findSwingLevels(ctx)
    .filter(l => l.idx + RIGHT_CONFIRM_BARS <= to && to - l.idx <= maxAge)
    .map(l => {
      const confirmedIdx = l.idx + RIGHT_CONFIRM_BARS;
      return { ...l, confirmedIdx, confirmedTs: ctx.cs[confirmedIdx]?.ts ?? l.ts };
    });
}

const PENDING_MIN_RIGHT = 2;

/**
 * 与 findSwingLevels 同一判定（左 8 严格、右侧不越过、前段至少 1.5 ATR 趋势腿），
 * 只是右侧只收盘了 2–4 根。每侧至多一个（新的候选必然落在旧候选的右窗内而矛盾）。
 */
export function pendingSwings(ctx: Ctx, left = 8, priorAtr = 1.5): { above: PendingSwing | null; below: PendingSwing | null } {
  const { cs, n } = ctx;
  const to = n - 1;
  const out: { above: PendingSwing | null; below: PendingSwing | null } = { above: null, below: null };
  if (to < left + PENDING_MIN_RIGHT + 1) return out;
  const step = cs[to].ts - cs[to - 1].ts;
  const a = scaleOf(ctx, to);
  const price = cs[to].c;
  for (let r = RIGHT_CONFIRM_BARS - 1; r >= PENDING_MIN_RIGHT; r--) {
    const j = to - r;
    if (j - left < 0) continue;
    for (const side of ['top', 'bottom'] as const) {
      const key = side === 'top' ? 'above' : 'below';
      if (out[key]) continue;
      const ext = side === 'top' ? cs[j].h : cs[j].l;
      let ok = true;
      for (let k = j - left; k < j && ok; k++) if (side === 'top' ? cs[k].h >= ext : cs[k].l <= ext) ok = false;
      for (let k = j + 1; k <= to && ok; k++) if (side === 'top' ? cs[k].h > ext : cs[k].l < ext) ok = false;
      if (!ok) continue;
      let prior = side === 'top' ? Infinity : -Infinity;
      for (let k = Math.max(0, j - 24); k < j; k++) prior = side === 'top' ? Math.min(prior, cs[k].l) : Math.max(prior, cs[k].h);
      const atrJ = Number.isFinite(ctx.atr[j]) && ctx.atr[j] > 0 ? ctx.atr[j] : a;
      if (!(Math.abs(ext - prior) >= priorAtr * atrJ)) continue;
      out[key] = {
        side: key, price: ext, idx: j, ts: cs[j].ts, rightBars: r, needBars: RIGHT_CONFIRM_BARS,
        confirmTs: cs[to].ts + (RIGHT_CONFIRM_BARS - r) * step,
        distanceAtr: r3(Math.abs(price - ext) / a),
      };
    }
  }
  return out;
}

/** Bounded-width EQH/EQL clusters; only unbroken swings form active equal-level pools. */
export function equalLevels(ctx: Ctx, maxAge = 480): { tops: LiquidityPoolCluster[]; bottoms: LiquidityPoolCluster[] } {
  const to = ctx.n - 1;
  if (to < 0) return { tops: [], bottoms: [] };
  const price = ctx.cs[to].c;
  const currentAtr = scaleOf(ctx, to);
  const levels = confirmedLevels(ctx, maxAge);
  const cluster = (side: 'top' | 'bottom') => {
    const active = levels
      .filter(l => l.side === side && l.breakIdx == null)
      .sort((x, y) => x.price - y.price || x.idx - y.idx);
    const broken = levels.filter(l => l.side === side && l.breakIdx != null);
    const out: LiquidityPoolCluster[] = [];
    let anchorLevel: ConfirmedLevel | null = null;
    let lastTol = 0;
    for (const p of active) {
      const last = out[out.length - 1];
      const pTol = levelTol(ctx, p);
      // Compare with the cluster anchor too, using each pivot's own confirmation ATR.
      const pairTol = Math.min(lastTol, pTol);
      const anchorTol = anchorLevel ? Math.min(levelTol(ctx, anchorLevel), pTol) : pTol;
      if (last && anchorLevel && Math.abs(last.price - p.price) <= pairTol && Math.abs(anchorLevel.price - p.price) <= anchorTol) {
        last.price = (last.price * last.touches + p.price) / (last.touches + 1);
        last.touches++;
        last.equal = last.touches >= 2;
        last.firstTs = Math.min(last.firstTs, p.ts);
        last.lastTs = Math.max(last.lastTs, p.ts);
        last.firstConfirmedTs = Math.min(last.firstConfirmedTs, p.confirmedTs);
        last.confirmedTs = Math.max(last.confirmedTs, p.confirmedTs);
        lastTol = Math.min(lastTol, pTol);
      } else {
        anchorLevel = p;
        lastTol = pTol;
        out.push({
          side: side === 'top' ? 'above' : 'below',
          price: p.price,
          touches: 1,
          equal: false,
          active: true,
          firstTs: p.ts,
          lastTs: p.ts,
          firstConfirmedTs: p.confirmedTs,
          confirmedTs: p.confirmedTs,
          distanceAtr: 0,
        });
      }
    }
    // Previously broken swings stay single consumed references; never merge into EQH/EQL pools.
    for (const p of broken) {
      out.push({
        side: side === 'top' ? 'above' : 'below',
        price: p.price,
        touches: 1,
        equal: false,
        active: false,
        firstTs: p.ts,
        lastTs: p.ts,
        firstConfirmedTs: p.confirmedTs,
        confirmedTs: p.confirmedTs,
        distanceAtr: 0,
      });
    }
    for (const c of out) c.distanceAtr = r3(Math.abs(price - c.price) / currentAtr);
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
  const windowStart = Math.max(0, to - horizon + 1);
  const levels = confirmedLevels(ctx, horizon + 60);

  // First bar after confirmation where each swing was swept (>= minDepthAtr) or broken.
  const firstConsumedIdx = new Map<ConfirmedLevel, number>();
  for (const lv of levels) {
    if (lv.breakIdx != null && lv.breakIdx <= lv.confirmedIdx) {
      firstConsumedIdx.set(lv, lv.breakIdx);
      continue;
    }
    const top = lv.side === 'top';
    for (let q = lv.confirmedIdx + 1; q <= to; q++) {
      const c = cs[q];
      const a = scaleOf(ctx, q);
      const closeBeyond = top ? c.c > lv.price + 0.1 * a : c.c < lv.price - 0.1 * a;
      const closeInside = top ? c.c < lv.price : c.c > lv.price;
      const pierce = top ? c.h - lv.price : lv.price - c.l;
      if (closeBeyond || (pierce >= minDepthAtr * a && closeInside)) {
        firstConsumedIdx.set(lv, q);
        break;
      }
    }
  }

  const out: StopHunt[] = [];
  for (const lv of levels) {
    // If it was already broken before becoming a confirmed reference, it is not
    // a new resting pool. Comparing only to confirmation time avoids future leakage.
    if (lv.breakIdx != null && lv.breakIdx <= lv.confirmedIdx) continue;
    // A level consumed before the requested lookback window is history, not a fresh event.
    const consumedAt = firstConsumedIdx.get(lv);
    if (consumedAt != null && consumedAt < windowStart) continue;
    const top = lv.side === 'top';
    const lvTol = levelTol(ctx, lv);
    const peers = levels.filter(p => p.side === lv.side && Math.abs(p.price - lv.price) <= Math.min(lvTol, levelTol(ctx, p)));
    // Start at the lookback boundary so old confirmations do not hide newer tests.
    const start = Math.max(lv.confirmedIdx + 1, windowStart);
    for (let q = start; q <= to; q++) {
      const c = cs[q];
      const a = scaleOf(ctx, q);
      const closeBeyond = top ? c.c > lv.price + 0.1 * a : c.c < lv.price - 0.1 * a;
      const closeInside = top ? c.c < lv.price : c.c > lv.price;
      const pierce = top ? c.h - lv.price : lv.price - c.l;
      if (!closeBeyond && pierce < minDepthAtr * a) continue;
      // Only count peers confirmed strictly before q that have NOT already been
      // broken or consumed prior to q.
      const touches = peers.filter(p => {
        if (!(p.idx < q && p.confirmedIdx < q)) return false;
        if (p.breakIdx != null && p.breakIdx < q) return false;
        const peerConsumedAt = firstConsumedIdx.get(p);
        return peerConsumedAt == null || peerConsumedAt >= q;
      }).length;
      if (touches < minTouches) {
        if (closeBeyond || (pierce >= minDepthAtr * a && closeInside)) break; // Consumed single swing.
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
        ? `${top ? '上方' : '下方'} ${touches} 个未破摆动参考价被刺穿 ${depth.toFixed(2)} ATR 后收盘收回：扫位收回候选。公共行情无法证明止损单身份或数量。`
        : `${top ? '上方' : '下方'} ${touches} 个未破摆动参考价被收盘越过缓冲带：越位候选，不等同多根成交接受或“真突破”。`;
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

/**
 * 图上统一的四种事件：突破 / 跌破（收盘越过缓冲带）与假突破 / 假跌破（刺穿后收盘收回）。
 * 每个已确认的摆动高低点（左 8 右 5）只看确认之后的第一次测试；单个摆动也算，touches 只用来说分量。
 * · 刺穿那根收盘正好卡在价位和缓冲带之间：等后面 3 根收盘来定 —— 收回 → 假（标在刺穿那根，confirmTs 指向收回那根），
 *   越过缓冲 → 真（标在越过那根）。
 * · 假的之后 3 根内又被收盘越过：并成一次真突破 / 真跌破（falseFirstTs = 那次假的）。更晚才越过同样并进去。
 * · 同一价位后来又被刺穿收回：记进 retests，不再另画一个。
 * · 真的之后收盘又回到原来那一侧（越过缓冲）：记进 reclaim；now = 最新一根收盘仍在原来那一侧（这次突破 / 跌破失败）。
 */
export interface LevelTest {
  kind: 'break' | 'false';
  /** above = 测试的是高点（突破 / 假突破）；below = 低点（跌破 / 假跌破） */
  side: 'above' | 'below';
  level: number;
  /** 被测试的摆动点所在 K 线 */
  levelTs: number;
  /** 测试那一刻同价位还没破的摆动点个数（≥1） */
  touches: number;
  /** 标记所在 K 线：假 = 刺穿那根；真 = 收盘越过那根 */
  ts: number;
  idx: number;
  ageBars: number;
  /** 标记那根的影线极值（刺得最远的价） */
  extreme: number;
  /** 标记那根的收盘价 */
  close: number;
  /** 假：刺穿那根没收回、后面才收回时，收回那根的开盘时间与收盘价 */
  confirmTs: number | null;
  confirmClose: number | null;
  effortRatio: number | null;
  /** 真：之前那次假的时间（先假后真） */
  falseFirstTs: number | null;
  /** 假：后来又刺穿又收回的那几根 */
  retests: { ts: number; extreme: number }[];
  /** 真：之后收盘回到原来那一侧的根数 */
  reclaim: { count: number; firstTs: number; lastTs: number; now: boolean } | null;
}

export interface RecentSwing {
  side: 'above' | 'below';
  price: number;
  ts: number;
  confirmedTs: number;
  /** 之后被收盘越过缓冲带 */
  broken: boolean;
}

const RESOLVE_BARS = 3;

export function levelTests(ctx: Ctx, lookback = FRESH_EVENT_BARS, minDepthAtr = 0.2): LevelTest[] {
  const { cs, n } = ctx;
  const to = n - 1;
  if (to < 1) return [];
  const windowStart = Math.max(0, to - Math.max(1, Math.floor(lookback)) + 1);
  // 与结构事件同一回看（findSwingLevels 默认 576 根）：今天早些时候的高低点今天下午被破也要看得到
  const levels = confirmedLevels(ctx, 576);
  const effort = (q: number) => (ctx.volMa[q] > 0 ? r3(ctx.vols[q] / ctx.volMa[q]) : null);
  const out: LevelTest[] = [];
  for (const lv of levels) {
    if (lv.breakIdx != null && lv.breakIdx <= lv.confirmedIdx) continue;
    const top = lv.side === 'top';
    const tol = levelTol(ctx, lv);
    const peers = levels.filter(p => p.side === lv.side && Math.abs(p.price - lv.price) <= Math.min(tol, levelTol(ctx, p)));
    const touchesAt = (q: number) => Math.max(1, peers.filter(p => p.idx < q && p.confirmedIdx < q && (p.breakIdx == null || p.breakIdx >= q)).length);
    const beyondAt = (q: number) => (top ? cs[q].c > lv.price + 0.1 * scaleOf(ctx, q) : cs[q].c < lv.price - 0.1 * scaleOf(ctx, q));
    const insideAt = (q: number) => (top ? cs[q].c < lv.price : cs[q].c > lv.price);
    const pierceAt = (q: number) => (top ? cs[q].h - lv.price : lv.price - cs[q].l);
    const extremeAt = (q: number) => (top ? cs[q].h : cs[q].l);
    let falseTest: LevelTest | null = null;
    let breakTest: LevelTest | null = null;
    let pendingPierce = -1;
    for (let q = lv.confirmedIdx + 1; q <= to; q++) {
      const a = scaleOf(ctx, q);
      if (breakTest) {
        // 越过之后：收盘回到原来那一侧（越过缓冲）的根数
        const back = top ? cs[q].c < lv.price - 0.1 * a : cs[q].c > lv.price + 0.1 * a;
        if (back) {
          const r = breakTest.reclaim ?? { count: 0, firstTs: cs[q].ts, lastTs: cs[q].ts, now: false };
          r.count++;
          r.lastTs = cs[q].ts;
          breakTest.reclaim = r;
        }
        continue;
      }
      if (beyondAt(q)) {
        breakTest = {
          kind: 'break', side: top ? 'above' : 'below', level: lv.price, levelTs: lv.ts, touches: touchesAt(q),
          ts: cs[q].ts, idx: q, ageBars: to - q, extreme: extremeAt(q), close: cs[q].c, confirmTs: null, confirmClose: null,
          effortRatio: effort(q), falseFirstTs: falseTest?.ts ?? null, retests: [], reclaim: null,
        };
        pendingPierce = -1;
        continue;
      }
      if (pendingPierce >= 0) {
        if (insideAt(q)) {
          if (!falseTest) {
            falseTest = {
              kind: 'false', side: top ? 'above' : 'below', level: lv.price, levelTs: lv.ts, touches: touchesAt(pendingPierce),
              ts: cs[pendingPierce].ts, idx: pendingPierce, ageBars: to - pendingPierce, extreme: extremeAt(pendingPierce),
              close: cs[pendingPierce].c, confirmTs: cs[q].ts, confirmClose: cs[q].c, effortRatio: effort(pendingPierce),
              falseFirstTs: null, retests: [], reclaim: null,
            };
          } else {
            falseTest.retests.push({ ts: cs[pendingPierce].ts, extreme: extremeAt(pendingPierce) });
          }
          pendingPierce = -1;
        } else if (q - pendingPierce >= RESOLVE_BARS) {
          pendingPierce = -1; // 一直卡在价位附近：不算假也不算真
        }
        continue;
      }
      if (pierceAt(q) >= minDepthAtr * a) {
        if (insideAt(q)) {
          if (!falseTest) {
            falseTest = {
              kind: 'false', side: top ? 'above' : 'below', level: lv.price, levelTs: lv.ts, touches: touchesAt(q),
              ts: cs[q].ts, idx: q, ageBars: to - q, extreme: extremeAt(q), close: cs[q].c, confirmTs: null, confirmClose: null,
              effortRatio: effort(q), falseFirstTs: null, retests: [], reclaim: null,
            };
          } else {
            falseTest.retests.push({ ts: cs[q].ts, extreme: extremeAt(q) });
          }
        } else {
          pendingPierce = q;
        }
      }
    }
    const ev = breakTest ?? falseTest;
    if (!ev || ev.idx < windowStart) continue;
    if (breakTest?.reclaim) {
      const last = cs[to];
      const a = scaleOf(ctx, to);
      breakTest.reclaim.now = top ? last.c < lv.price - 0.1 * a : last.c > lv.price + 0.1 * a;
    }
    out.push(ev);
  }
  // 同一根上被测试的几个价位都保留：挑哪个来说（亚盘价、碰过几次）由图层决定
  return out.sort((a, b) => b.idx - a.idx || b.touches - a.touches);
}

/** 最近 maxAge 根内已确认的摆动高低点（给盘面说「哪几次碰到这一带」用） */
export function recentSwings(ctx: Ctx, maxAge = 160): RecentSwing[] {
  return confirmedLevels(ctx, maxAge).map(l => ({
    side: l.side === 'top' ? 'above' as const : 'below' as const,
    price: l.price, ts: l.ts, confirmedTs: l.confirmedTs, broken: l.breakIdx != null,
  })).sort((a, b) => a.ts - b.ts);
}

/** Only fresh events drive bias; historical events remain visible but decay to zero. */
export function readLiquidity(ctx: Ctx, lookback = 160): LiquidityRead {
  const to = ctx.n - 1;
  if (to < 0) return { pools: [], nearestAbove: null, nearestBelow: null, poolAbove: null, poolBelow: null, pendingAbove: null, pendingBelow: null, stopHunts: [], structure: null, structureTs: null, structureAgeBars: null, tests: [], swings: [], bias: 0, strength: 0, headline: '没有已收盘行情。' };
  const price = ctx.cs[to].c;
  const { tops, bottoms } = equalLevels(ctx);
  const pools = [...tops, ...bottoms];
  const pickNearest = (list: LiquidityPoolCluster[], ok: (p: LiquidityPoolCluster) => boolean) =>
    list.filter(ok).sort((x, y) => Number(y.active) - Number(x.active) || x.distanceAtr - y.distanceAtr)[0] ?? null;
  const nearestAbove = pickNearest(tops, p => p.price >= price);
  const nearestBelow = pickNearest(bottoms, p => p.price <= price);
  const poolAbove = pickNearest(tops, p => p.price >= price && p.active && p.equal);
  const poolBelow = pickNearest(bottoms, p => p.price <= price && p.active && p.equal);
  const hunts = stopHunts(ctx, lookback);
  const pending = pendingSwings(ctx);
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
  return { pools, nearestAbove, nearestBelow, poolAbove, poolBelow, pendingAbove: pending.above, pendingBelow: pending.below, stopHunts: hunts, structure, structureTs, structureAgeBars, tests: levelTests(ctx), swings: recentSwings(ctx), bias, strength, headline };
}
