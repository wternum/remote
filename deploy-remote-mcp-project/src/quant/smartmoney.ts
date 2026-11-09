// ─────────────────────────────────────────────────────────────
//  关键位「聪明钱结构」观察（SMC / ICT 的可编码部分）
//
//  只把有明确价格定义、且能用当前数据验证的概念做成标注：
//   · 流动性池（等高等低）与扫位收回   —— 价格结构
//   · 结构破坏 BOS / 性质转变 CHoCH    —— 价格结构
//   · 公允价值缺口 FVG（三根不重叠）   —— 价格结构
//   · 订单块候选（推进前最后一根反向K）—— 价格结构
//   · 溢价 / 折价（相对当前交易区间）  —— 价格结构
//
//  不做的事：不判断“机构身份/持仓”、不把 FVG 当成必回补承诺、
//  不用未经校准的权重输出“胜率”。有真实 taker 覆盖时才额外标「成交佐证」。
// ─────────────────────────────────────────────────────────────
import type { Ctx } from './context';
import { findSwingLevels, type FlowWindow, windowFlow } from './orderflow';

export interface SmcPatternInput {
  side: 'top' | 'bottom';
  /** 收盘确认第二测试的那根 K 线 */
  idx: number;
  first: number;
  second: number;
  level: number;
  neck: number;
}

export interface DealingRange {
  from: number;
  to: number;
  hi: number;
  lo: number;
  mid: number;
  price: number;
  /** 0 = 区间最低，1 = 区间最高 */
  position: number;
  premium: boolean;
  discount: boolean;
}

export interface FvgZone {
  kind: 'bullish' | 'bearish';
  from: number;
  to: number;
  lo: number;
  hi: number;
  /** 已经回到缺口内（部分回补） */
  touched: boolean;
  /** 完全回补 */
  filled: boolean;
  fillIdx: number | null;
  /** 与当前 M/W 的反转方向一致 */
  aligned: boolean;
}

export interface LiquidityPool {
  side: 'above' | 'below';
  price: number;
  touches: number;
  /** 在第二测试处被刺破 */
  swept: boolean;
  sweptIdx: number | null;
  reclaimed: boolean;
}

export interface OrderBlockCandidate {
  from: number;
  to: number;
  lo: number;
  hi: number;
  /** 推动到关键位的那一段位移幅度（ATR） */
  displacementAtr: number;
  /** 确认前是否已被回踩 */
  mitigated: boolean;
  mitigatedIdx: number | null;
}

export interface StructureEvent {
  kind: 'BOS' | 'CHOCH';
  dir: 1 | -1;
  idx: number;
  price: number;
}

export interface SmcEvidence {
  key: 'liquiditySweep' | 'structureShift' | 'fvg' | 'orderBlock' | 'premiumDiscount' | 'takerConfirm';
  label: string;
  /** 命中 / 未命中 / 无数据 */
  state: 'hit' | 'miss' | 'na';
  detail: string;
}

export interface SmartMoneyRead {
  side: 'top' | 'bottom';
  dir: 1 | -1;
  range: DealingRange;
  liquidity: LiquidityPool | null;
  structure: StructureEvent | null;
  /** 与反转方向一致、且未被完全回补的缺口 */
  fvgs: FvgZone[];
  orderBlock: OrderBlockCandidate | null;
  evidence: SmcEvidence[];
  /** 命中项数量（仅用于展示排序，不是胜率） */
  hits: number;
  headline: string;
  /** 真实 taker 覆盖时才存在 */
  taker: { window: FlowWindow; aligned: boolean } | null;
  source: 'price' | 'real';
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 当前交易区间：以第二测试之前确认的摆动高低点定义，不含未来数据。 */
export function dealingRange(ctx: Ctx, from: number, to: number): DealingRange {
  const a = Math.max(0, Math.min(from, ctx.n - 1));
  const b = Math.max(a, Math.min(to, ctx.n - 1));
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = a; i <= b; i++) {
    hi = Math.max(hi, ctx.cs[i].h);
    lo = Math.min(lo, ctx.cs[i].l);
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) {
    const p = ctx.cs[b]?.c ?? 0;
    hi = p; lo = p;
  }
  const price = ctx.cs[b]?.c ?? lo;
  const mid = (hi + lo) / 2;
  const position = hi > lo ? clamp01((price - lo) / (hi - lo)) : 0.5;
  return { from: a, to: b, hi, lo, mid, price, position, premium: price > mid, discount: price < mid };
}

/**
 * 三根 K 线的公允价值缺口。
 * 多头缺口：第 3 根的最低价 > 第 1 根的最高价；空头缺口镜像。
 * 只统计到 `upto` 为止的 K 线，回补状态也在同一范围内判定。
 */
export function findFvgs(ctx: Ctx, from: number, to: number, upto: number): FvgZone[] {
  const start = Math.max(2, from);
  const end = Math.min(upto, ctx.n - 1);
  const out: FvgZone[] = [];
  for (let i = start; i <= end; i++) {
    const a = ctx.cs[i - 2];
    const c = ctx.cs[i];
    const bullish = c.l > a.h;
    const bearish = c.h < a.l;
    if (!bullish && !bearish) continue;
    // 需要真正的位移：缺口高度至少 0.1 ATR，避免把微小点差当缺口。
    const gap = bullish ? c.l - a.h : a.l - c.h;
    const atr = Math.max(ctx.atr[i] ?? 0, 1e-9);
    if (gap < 0.1 * atr) continue;
    const lo = bullish ? a.h : c.h;
    const hi = bullish ? c.l : a.l;
    let touched = false;
    let filled = false;
    let fillIdx: number | null = null;
    for (let q = i + 1; q <= end; q++) {
      const bar = ctx.cs[q];
      if (bullish) {
        if (bar.l <= hi) touched = true;
        if (bar.l <= lo) { filled = true; fillIdx = q; break; }
      } else {
        if (bar.h >= lo) touched = true;
        if (bar.h >= hi) { filled = true; fillIdx = q; break; }
      }
    }
    out.push({ kind: bullish ? 'bullish' : 'bearish', from: i - 2, to: i, lo, hi, touched, filled, fillIdx, aligned: false });
  }
  return out;
}

/**
 * 第 `idx` 根为止最近一次结构事件：收盘越过此前的已确认摆动位。
 * 同一方向的第一次越位记为 BOS；与原方向相反的第一次越位记为 CHoCH。
 */
export function latestStructure(ctx: Ctx, idx: number): StructureEvent | null {
  const raw = findSwingLevels(ctx)
    .map(l => ({ level: l, breakIdx: l.breakIdx }))
    .filter((x): x is { level: typeof x.level; breakIdx: number } => x.breakIdx != null && x.breakIdx <= idx)
    .sort((a, b) => a.breakIdx - b.breakIdx || a.level.idx - b.level.idx);
  if (!raw.length) return null;
  // 同一根 K 线同向突破多个等高/等低摆动位只记一次结构突破
  const known: typeof raw = [];
  for (const item of raw) {
    const tail = known[known.length - 1];
    if (tail && tail.breakIdx === item.breakIdx && tail.level.side === item.level.side) {
      known[known.length - 1] = item;
    } else {
      known.push(item);
    }
  }
  const last = known[known.length - 1];
  const prev = known.length > 1 ? known[known.length - 2] : null;
  // 最近一次越位方向与上一次相反 → 性质转变（CHoCH），否则为延续（BOS）。
  const kind: StructureEvent['kind'] = prev && prev.level.side !== last.level.side ? 'CHOCH' : 'BOS';
  return {
    kind,
    dir: last.level.side === 'top' ? 1 : -1,
    idx: last.breakIdx,
    price: last.level.price,
  };
}

/** 等高等低形成的流动性池；只回看 `lookback` 根，且不使用第二测试之后的数据。 */
export function liquidityPool(ctx: Ctx, p: SmcPatternInput, lookback = 160): LiquidityPool | null {
  const from = Math.max(0, p.second - lookback);
  const a = Math.max(ctx.atr[p.idx] ?? 0, 1e-9);
  const tol = Math.max(0.15 * a, 0.0004 * Math.abs(p.level));
  const top = p.side === 'top';
  let touches = 0;
  for (let i = from; i < p.second; i++) {
    const ext = top ? ctx.cs[i].h : ctx.cs[i].l;
    if (Math.abs(ext - p.level) <= tol) touches++;
  }
  if (touches < 1) return null;
  const test = ctx.cs[p.second];
  const beyond = top ? test.h - p.level : p.level - test.l;
  const swept = beyond >= 0.05 * a;
  const confirm = ctx.cs[p.idx];
  const reclaimed = top ? confirm.c < p.level : confirm.c > p.level;
  return {
    side: top ? 'above' : 'below',
    price: p.level,
    touches,
    swept,
    sweptIdx: swept ? p.second : null,
    reclaimed,
  };
}

/**
 * 订单块候选：
 * · 顶部供应区（Bearish OB）：一顶离开下跌位移前的最后一根阳线
 * · 底部需求区（Bullish OB）：一底离开上涨位移前的最后一根阴线
 * 必须先形成有效离开位移后，才判定二测前是否已被回踩（mitigated）。
 */
export function orderBlockCandidate(ctx: Ctx, p: SmcPatternInput): OrderBlockCandidate | null {
  const top = p.side === 'top';
  const a = Math.max(ctx.atr[p.idx] ?? 0, 1e-9);
  let pivot = -1;
  let displacement = 0;
  const searchStart = Math.min(ctx.n - 1, p.first);
  const searchEnd = Math.max(0, p.first - 20);
  for (let i = searchStart; i >= searchEnd; i--) {
    const c = ctx.cs[i];
    // 供应区：下跌位移前的最后一根阳线；需求区：上涨位移前的最后一根阴线
    const preMoveCandle = top ? c.c > c.o : c.c < c.o;
    if (!preMoveCandle) continue;
    const obLo = Math.min(c.o, c.c);
    const obHi = Math.max(c.o, c.c);
    let ext = top ? Infinity : -Infinity;
    for (let k = i + 1; k < p.second; k++) {
      ext = top ? Math.min(ext, ctx.cs[k].l) : Math.max(ext, ctx.cs[k].h);
    }
    const disp = top ? obHi - ext : ext - obLo;
    if (Number.isFinite(disp) && disp >= 0.5 * a) {
      pivot = i;
      displacement = disp;
      break;
    }
  }
  if (pivot < 0) return null;
  const bar = ctx.cs[pivot];
  const lo = Math.min(bar.o, bar.c);
  const hi = Math.max(bar.o, bar.c);

  // 必须先走出离开订单块的有效位移，才算离开；紧挨着的下一根不再直接判为已回踩
  let departedIdx = -1;
  for (let k = pivot + 1; k < p.second; k++) {
    const c = ctx.cs[k];
    const departed = top
      ? c.c < lo && lo - c.l >= 0.5 * a
      : c.c > hi && c.h - hi >= 0.5 * a;
    if (departed) {
      departedIdx = k;
      break;
    }
  }
  if (departedIdx < 0) return null;

  let mitigated = false;
  let mitigatedIdx: number | null = null;
  // 只检查离开后到二测到达之前的区间，二测本身不算"此前已被回踩"
  for (let q = departedIdx + 1; q < p.second; q++) {
    const c = ctx.cs[q];
    if (c.h >= lo && c.l <= hi) {
      mitigated = true;
      mitigatedIdx = q;
      break;
    }
  }
  return {
    from: pivot, to: p.idx, lo, hi,
    displacementAtr: Number((displacement / a).toFixed(2)),
    mitigated, mitigatedIdx,
  };
}

/**
 * 汇总一次 M/W 关键位上的 SMC 结构观察。
 * `flow` 仅用于在真实覆盖存在时附加成交佐证；没有覆盖时 taker = null。
 */
export function readSmartMoney(
  ctx: Ctx,
  p: SmcPatternInput,
  flow?: FlowWindow | null,
  flowKnown = false,
): SmartMoneyRead {
  const top = p.side === 'top';
  const dir: 1 | -1 = top ? -1 : 1;
  const range = dealingRange(ctx, Math.max(0, p.first - 24), p.idx);
  const liquidity = liquidityPool(ctx, p);
  const structure = latestStructure(ctx, p.idx);
  const fvgs = findFvgs(ctx, Math.max(0, p.second - 60), p.idx, p.idx)
    .map(z => ({ ...z, aligned: top ? z.kind === 'bearish' : z.kind === 'bullish' }))
    .sort((x, y) => Number(y.aligned) - Number(x.aligned) || y.to - x.to);
  const orderBlock = orderBlockCandidate(ctx, p);
  const taker = flow && flowKnown && flow.known >= 0.5
    ? { window: flow, aligned: flow.ratio * dir > 0.05 }
    : null;

  const evidence: SmcEvidence[] = [];
  const liquidityHit = !!liquidity?.swept && liquidity.reclaimed;
  evidence.push({
    key: 'liquiditySweep',
    label: '扫流动性后收回',
    state: liquidity ? (liquidityHit ? 'hit' : 'miss') : 'na',
    detail: liquidity
      ? `${liquidity.side === 'above' ? '等高等低上方' : '下方'}流动性位 ${liquidity.price}，${liquidity.touches} 次触及；${liquidity.swept ? '本次刺破并' : '未刺破，'}${liquidity.reclaimed ? '收盘收回关键位内。' : '收盘未收回。'}`
      : '关键位附近没有形成可识别的等高等低流动性池。',
  });

  const structureAligned = !!structure && structure.dir === dir;
  evidence.push({
    key: 'structureShift',
    label: '结构事件同向',
    state: structure ? (structureAligned ? 'hit' : 'miss') : 'na',
    detail: structure
      ? `${structure.kind}（${structure.dir > 0 ? '向上' : '向下'}收盘越过摆动位 ${structure.price}），${structureAligned ? '与本次反转方向一致。' : '方向与本次反转方向相反。'}`
      : '确认前没有出现收盘越位型结构事件。',
  });

  const alignedFvg = fvgs.find(z => z.aligned && !z.filled);
  evidence.push({
    key: 'fvg',
    label: '同向未回补缺口',
    state: alignedFvg ? 'hit' : fvgs.length ? 'miss' : 'na',
    detail: alignedFvg
      ? `${top ? '空头' : '多头'}缺口 ${alignedFvg.lo.toFixed(2)}–${alignedFvg.hi.toFixed(2)} 尚未完全回补${alignedFvg.touched ? '（已被部分回踩）' : ''}。`
      : fvgs.length
        ? '存在缺口，但同向缺口已经回补或不存在。'
        : '第二测试前后没有达到 0.1 ATR 的三根不重叠缺口。',
  });

  const obHit = !!orderBlock && !orderBlock.mitigated;
  evidence.push({
    key: 'orderBlock',
    label: '未回踩订单块候选',
    state: orderBlock ? (obHit ? 'hit' : 'miss') : 'na',
    detail: orderBlock
      ? `${top ? '供应' : '需求'}区 ${orderBlock.lo.toFixed(2)}–${orderBlock.hi.toFixed(2)}（位移 ${orderBlock.displacementAtr} ATR），确认前${orderBlock.mitigated ? `已在第 ${orderBlock.mitigatedIdx} 根被回踩。` : '尚未被回踩。'}`
      : '第二测试前的推进段没有找到满足条件的反向 K 线。',
  });

  const pdHit = top ? range.premium : range.discount;
  evidence.push({
    key: 'premiumDiscount',
    label: '溢价/折价位置',
    state: pdHit ? 'hit' : 'miss',
    detail: `交易区间 ${range.lo.toFixed(2)}–${range.hi.toFixed(2)}，确认收盘位于 ${(range.position * 100).toFixed(0)}% 分位（${range.premium ? '溢价区' : range.discount ? '折价区' : '均衡线'}）。`,
  });

  if (taker) {
    evidence.push({
      key: 'takerConfirm',
      label: '真实 taker 成交佐证',
      state: taker.aligned ? 'hit' : 'miss',
      detail: `窗口真实主动差 ${(taker.window.ratio * 100).toFixed(0)}%，覆盖 ${(taker.window.known * 100).toFixed(0)}%；${taker.aligned ? '与反转方向一致。' : '未站在反转一侧。'} 这是 taker 成交方向，不是订单簿 OFI，也不证明具体止损或机构仓位。`,
    });
  } else {
    evidence.push({
      key: 'takerConfirm',
      label: '真实 taker 成交佐证',
      state: 'na',
      detail: '该窗口没有完整真实逐笔覆盖，因此不输出成交佐证，也不据此推断机构行为。',
    });
  }

  const hits = evidence.filter(e => e.state === 'hit').length;
  const tags = evidence.filter(e => e.state === 'hit').map(e => e.label);
  const headline = hits
    ? `${top ? '顶部' : '底部'}关键位 SMC 观察：${tags.slice(0, 3).join(' · ')}（结构命中 ${hits}/${evidence.length}，不是胜率）`
    : `${top ? '顶部' : '底部'}关键位 SMC 观察：没有命中可验证的结构条件`;

  return {
    side: p.side,
    dir,
    range,
    liquidity,
    structure,
    fvgs,
    orderBlock,
    evidence,
    hits,
    headline,
    taker,
    source: taker ? 'real' : 'price',
  };
}
