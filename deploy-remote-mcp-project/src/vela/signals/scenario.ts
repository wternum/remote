import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { windowFlow } from '@/quant/orderflow';
import { decimalsFor, type AnnTone } from '../annotTypes';
import { annotationTolerance, type AnnotationPattern } from './patterns';
import type { SignalItem, SignalSource } from './store';

const BREAK_ATR = 0.2;
const SWEEP_ATR = 0.05;
export const RETEST_WINDOW = 48;
const FUTURE_BARS = 12;

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
const pctAbs = (v: number) => `${Math.abs(v * 100).toFixed(0)}%`;
const fmt = (v: number) => {
  const d = decimalsFor(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);

export type LineState = 'pending' | 'broken' | 'touch' | 'retest' | 'failed' | 'expired';

export interface LineRead {
  kind: 'level' | 'neck';
  price: number;
  /** +1 = 向上突破，-1 = 向下跌破 */
  dir: 1 | -1;
  state: LineState;
  firstBreak: number;
  acceptedAt: number;
  reachedIdx: number;
  flowComplete: boolean;
  flowAligned: boolean;
  flowRatio: number | null;
  waited: number;
  distAtr: number;
  lo: number;
  hi: number;
}

/**
 * 一条水平线（关键位或颈线）在 startIdx 之后的突破生命周期：
 * 单根越位(pending) → 两根收盘确认(broken) → 首次回抽触带(touch) →
 * 守住(retest) / 收回(failed) / 观察窗内未回抽(expired)。
 */
export function evaluateLine(ctx: Ctx, barMs: number, price: number, dir: 1 | -1, startIdx: number, kind: LineRead['kind']): LineRead | null {
  const { cs, n, atr } = ctx;
  const last = n - 1;
  const aNow = Math.max(atr[last] || 0, 1e-9);
  const tol = Math.max(annotationTolerance(price, aNow), 0.15 * aNow);
  const lo = price - tol;
  const hi = price + tol;
  const beyond = (i: number) => {
    const a = Math.max(atr[i] || 0, 1e-9);
    return dir > 0 ? cs[i].c > price + BREAK_ATR * a : cs[i].c < price - BREAK_ATR * a;
  };
  const backInside = (i: number) => {
    const a = Math.max(atr[i] || 0, 1e-9);
    return dir > 0 ? cs[i].c < price - BREAK_ATR * a : cs[i].c > price + BREAK_ATR * a;
  };
  const base = { kind, price, dir, lo, hi, reachedIdx: -1, flowComplete: false, flowAligned: false, flowRatio: null as number | null, waited: 0, distAtr: 0 };

  let firstBreak = -1;
  for (let i = startIdx + 1; i < last; i++) {
    if (beyond(i) && beyond(i + 1)) { firstBreak = i; break; }
  }
  if (firstBreak < 0) {
    if (last > startIdx && beyond(last)) return { ...base, state: 'pending', firstBreak: last, acceptedAt: -1 };
    return null;
  }
  const acceptedAt = firstBreak + 1;
  const contiguous = cs[acceptedAt].ts - cs[firstBreak].ts === barMs;
  const w = windowFlow(ctx, firstBreak, acceptedAt);
  const flowComplete = contiguous && w.known === 1 && w.vol > 0;
  const flowRatio = flowComplete ? w.ratio : null;
  const flowAligned = flowComplete && w.ratio * dir >= 0.04;
  const read: LineRead = { ...base, state: 'broken', firstBreak, acceptedAt, flowComplete, flowAligned, flowRatio };

  for (let i = acceptedAt + 1; i <= last; i++) {
    if (cs[i].h < lo || cs[i].l > hi) continue;
    read.reachedIdx = i;
    read.waited = i - acceptedAt;
    read.state = backInside(i) ? 'failed' : beyond(i) ? 'retest' : 'touch';
    return read;
  }
  read.waited = last - acceptedAt;
  if (read.waited >= RETEST_WINDOW) {
    read.state = 'expired';
  } else {
    const c = cs[last].c;
    read.distAtr = c < lo ? (lo - c) / aNow : c > hi ? (c - hi) / aNow : 0;
  }
  return read;
}

export interface ScenarioRead {
  item: SignalItem;
  /** 越大越值得展示：3 = 已突破生命周期，2 = 待确认/真实扫位，1 = 价格扫位，0 = 静态观察 */
  rank: number;
  price: number;
  tol: number;
  recency: number;
  patternIdx: number;
  side: 'top' | 'bottom';
}

export interface KeyLevelScenarioInput {
  pattern: AnnotationPattern;
  ctx: Ctx;
  flow?: FlowSnapshot | null;
  barMs: number;
}

/**
 * 一个 M/W 的当前剧本：同时跟踪「关键位被反向突破（形态失效）」与
 * 「颈线被突破（形态完成）」，取最近发生的那一个；都没发生时看第二测试是否扫位收回。
 * 文字只保留结论、成交依据和回抽进度，不预测到达时间。
 */
export function analyzeKeyLevelScenario({ pattern, ctx, flow, barMs }: KeyLevelScenarioInput): ScenarioRead {
  const { cs, n, atr } = ctx;
  const last = n - 1;
  const top = pattern.side === 'top';
  const name = top ? '双顶' : '双底';
  const key = `${pattern.side}:${cs[pattern.first].ts}:${cs[pattern.idx].ts}`;
  const nowTs = cs[last].ts;
  /** One candle's effort: real taker side/Δ when covered, otherwise volume only. */
  const effort = (i: number) => {
    const b = flow?.bars.get(cs[i].ts);
    const vr = ctx.volMa[i] > 0 ? cs[i].v / ctx.volMa[i] : 0;
    if (b && ctx.real[i] === 1 && b.buy + b.sell > 0) {
      const ratio = (b.buy - b.sell) / (b.buy + b.sell);
      return { real: true, ratio, vr, text: `${ratio >= 0 ? '买' : '卖'} ${pct(ratio)} · ${vr.toFixed(1)}×` };
    }
    return { real: false, ratio: null as number | null, vr, text: `量 ${vr.toFixed(1)}×` };
  };

  const levelRead = evaluateLine(ctx, barMs, pattern.level, top ? 1 : -1, pattern.idx, 'level');
  const neckRead = evaluateLine(ctx, barMs, pattern.neck, top ? -1 : 1, pattern.idx, 'neck');
  const accepted = [levelRead, neckRead].filter((r): r is LineRead => !!r && r.acceptedAt >= 0)
    .sort((a, b) => b.acceptedAt - a.acceptedAt);
  const pending = [levelRead, neckRead].find((r): r is LineRead => !!r && r.state === 'pending');

  const make = (o: {
    rank: number; price: number; lo: number; hi: number; zoneText: string; title: string; detail: string[];
    tone: AnnTone; source: SignalSource; fromTs: number; toTs: number; failed?: boolean; recency: number;
    mark?: { idx: number; text: string; tone: AnnTone; side: 'above' | 'below' };
  }): ScenarioRead => ({
    rank: o.rank,
    price: o.price,
    tol: (o.hi - o.lo) / 2,
    recency: o.recency,
    patternIdx: pattern.idx,
    side: pattern.side,
    item: {
      id: `scenario:${key}`,
      type: 'keyLevelScenario',
      ts: nowTs,
      fromTs: o.fromTs,
      price: o.price,
      title: o.title,
      detail: o.detail,
      source: o.source,
      confirmed: true,
      tone: o.tone,
      ...(o.mark ? {
        event: {
          id: `scenario:${key}:mark`, ts: cs[o.mark.idx].ts, side: o.mark.side, tone: o.mark.tone,
          text: o.mark.text, marker: 'diamond' as const, priority: 88, title: o.title, detail: o.detail,
        },
      } : {}),
      zone: {
        id: `scenario:${key}:zone`,
        fromTs: o.fromTs, toTs: o.toTs, lo: o.lo, hi: o.hi,
        tone: o.tone, text: o.zoneText, priority: 92, failed: o.failed,
        title: o.title, detail: o.detail,
      },
    },
  });

  // ── 1. 已发生两根收盘突破：形态失效（关键位）或形态完成（颈线）──
  const r = accepted[0];
  if (r) {
    const down = r.dir < 0;
    const breakWord = r.kind === 'level' ? (down ? '跌破' : '涨破') : (down ? '跌破颈线' : '涨破颈线');
    const back = r.dir > 0 ? '回踩' : '回抽';
    // 大白话：谁出力更多，而不是主动买卖差。
    const flowTxt = !r.flowComplete
      ? '没有逐笔数据'
      : r.flowAligned ? `${down ? '卖方' : '买方'}更多（${pctAbs(r.flowRatio!)}）` : `买卖有分歧（${pctAbs(r.flowRatio!)}）`;
    const dirTone: AnnTone = r.dir > 0 ? 'long' : 'short';
    const tone: AnnTone = r.state === 'failed' || r.state === 'touch' || (r.flowComplete && !r.flowAligned) ? 'warn' : dirTone;
    const zoneText = {
      broken: `${breakWord}后等${back}`,
      touch: `${back}到了·看收盘`,
      retest: `${back}到了·站住了`,
      failed: `${back}又收回`,
      expired: `一直没${back}`,
      pending: `刚${breakWord}?`,
    }[r.state];
    const progress =
      r.state === 'broken' ? `可能${back}的位置 ${fmt(r.lo)}–${fmt(r.hi)}；已等 ${r.waited} 根（最多看 ${RETEST_WINDOW} 根），现在离那里 ${r.distAtr.toFixed(1)} 个波动单位`
        : r.state === 'expired' ? `${RETEST_WINDOW} 根内一直没有${back}到 ${fmt(r.lo)}–${fmt(r.hi)}`
          : r.state === 'failed' ? `${hhmm(cs[r.reachedIdx].ts)} ${back}上来后又收回去，之前这个破位就不算了`
            : r.state === 'retest' ? `${hhmm(cs[r.reachedIdx].ts)} 第一次${back}到这里并站住（第 ${r.waited} 根）`
              : `${hhmm(cs[r.reachedIdx].ts)} ${back}到了，等这根收盘看站不站得住`;
    const toTs = r.state === 'failed' ? cs[r.reachedIdx].ts + barMs * 3
      : r.state === 'expired' ? cs[Math.min(last, r.acceptedAt + RETEST_WINDOW)].ts
        : nowTs + barMs * FUTURE_BARS;
    const e = effort(r.firstBreak);
    const eLine = `破位那根：${e.real ? `${e.ratio! < 0 ? '卖方' : '买方'}更多（${pctAbs(e.ratio!)}）` : '没有逐笔数据'}，量是平时的 ${e.vr.toFixed(1)} 倍`;
    return make({
      rank: 3,
      mark: { idx: r.firstBreak, text: r.kind === 'neck' ? breakWord : (down ? '跌破了' : '涨破了'), tone: dirTone, side: r.dir > 0 ? 'below' : 'above' },
      price: r.price, lo: r.lo, hi: r.hi,
      zoneText,
      title: `${name} ${fmt(r.price)} ${breakWord}了 · ${flowTxt}`,
      detail: [`${hhmm(cs[r.acceptedAt].ts)} 连续两根 K 线收在 ${fmt(r.price)} ${down ? '下方' : '上方'}，${flowTxt}`, eLine, progress],
      tone, source: r.flowComplete ? 'real' : 'price',
      fromTs: cs[r.firstBreak].ts, toTs, failed: r.state === 'failed',
      recency: r.acceptedAt,
    });
  }

  // ── 2. 单根收盘越位：只提示待确认 ──
  if (pending) {
    const breakWord = pending.kind === 'level' ? (top ? '涨破' : '跌破') : (top ? '跌破颈线' : '涨破颈线');
    return make({
      rank: 2,
      price: pending.price, lo: pending.lo, hi: pending.hi,
      zoneText: `刚${breakWord}? 再看一根`,
      title: `${name} ${fmt(pending.price)} 只有一根收在外面 · 还不算`,
      detail: ['只有 1 根 K 线收在外面，要第 2 根也收在同一边才算真破'],
      tone: 'warn', source: 'price',
      fromTs: cs[Math.max(pattern.second, last - 6)].ts, toTs: nowTs + barMs * FUTURE_BARS,
      recency: last,
    });
  }

  // ── 3. 第二测试扫位收回：诱多 / 诱空候选 ──
  const aNow = Math.max(atr[last] || 0, 1e-9);
  const tol = Math.max(annotationTolerance(pattern.level, aNow), 0.15 * aNow);
  const lo = pattern.level - tol;
  const hi = pattern.level + tol;
  const test = cs[pattern.second];
  const confirm = cs[pattern.idx];
  const depth = (top ? test.h - pattern.level : pattern.level - test.l) / Math.max(atr[pattern.idx] || 0, 1e-9);
  const swept = depth >= SWEEP_ATR && (top ? confirm.c < pattern.level : confirm.c > pattern.level);
  const ratioAt = (i: number) => {
    const b = flow?.bars.get(cs[i].ts);
    return b && ctx.real[i] === 1 && b.buy + b.sell > 0 ? (b.buy - b.sell) / (b.buy + b.sell) : null;
  };
  const rev = top ? -1 : 1;
  const fromTs = cs[pattern.second].ts;
  const toTs = nowTs + barMs * FUTURE_BARS;
  const te = effort(pattern.second);
  // At a double bottom the question is whether buyers absorbed the test; at a
  // double top, whether sellers did. Show the test candle's actual effort.
  const testMark = { idx: pattern.second, text: te.real ? (top ? (te.ratio! * rev > 0 ? '有人卖' : '买方在接') : (te.ratio! * rev > 0 ? '有人接' : '卖方在压')) : '没逐笔数据', tone: (te.real ? (te.ratio! * rev > 0 ? (top ? 'short' : 'long') : 'warn') : 'neck') as AnnTone, side: (top ? 'above' : 'below') as 'above' | 'below' };
  if (swept) {
    const tr = ratioAt(pattern.second);
    const cr = ratioAt(pattern.idx);
    const real = tr != null && cr != null;
    const volRatio = ctx.volMa[pattern.second] > 0 ? test.v / ctx.volMa[pattern.second] : 0;
    const takeover = real && tr! * rev >= 0.06 && cr! * rev >= -0.02;
    const stalled = real && tr! * rev <= -0.12 && volRatio >= 1.3 && cr! * rev >= 0.04;
    const sweepWord = top ? '冲高又收回' : '跌破又收回';
    const trap = top ? '像假突破' : '像假跌破';
    const deltaLine = real ? `测试那根${tr! < 0 ? '卖方' : '买方'}更多（${pctAbs(tr!)}），确认那根 ${pctAbs(cr!)}` : '没有逐笔数据，不判断是不是假动作';
    if (takeover || stalled) {
      return make({
        rank: 2, price: pattern.level, lo, hi,
        zoneText: trap,
        title: `${name} ${fmt(pattern.level)} ${sweepWord} · ${takeover ? '另一方向有人在接' : '追进去的没守住'}`,
        detail: [`最低/最高价越过这条线 ${depth.toFixed(2)} 个波动单位，收盘又收回来了`, deltaLine],
        tone: top ? 'short' : 'long', source: 'real', fromTs, toTs, recency: pattern.idx, mark: testMark,
      });
    }
    return make({
      rank: 1, price: pattern.level, lo, hi,
      zoneText: real ? `${sweepWord}·力度不够` : sweepWord,
      title: `${name} ${fmt(pattern.level)} ${sweepWord} · ${real ? '买卖力度不够明确' : '没有逐笔数据'}`,
      detail: [`价格越过这条线 ${depth.toFixed(2)} 个波动单位，收盘又收回里面`, deltaLine],
      tone: 'warn', source: real ? 'real' : 'price', fromTs, toTs, recency: pattern.idx, mark: testMark,
    });
  }

  // ── 4. 静态观察 ──
  return make({
    rank: 0, price: pattern.level, lo, hi,
    zoneText: top ? '压力位' : '支撑位',
    title: `${name} ${fmt(pattern.level)} ${top ? '压力位' : '支撑位'} · 还没破`,
    detail: [`注意的价格带 ${fmt(lo)}–${fmt(hi)}；颈线在 ${fmt(pattern.neck)}`, `第二次回到这里时：${te.real ? `${te.ratio! < 0 ? '卖方' : '买方'}更多（${pctAbs(te.ratio!)}）` : '没有逐笔数据'}，量是平时的 ${te.vr.toFixed(1)} 倍`],
    tone: top ? 'short' : 'long', source: 'price', fromTs, toTs, recency: pattern.idx, mark: testMark,
  });
}

/**
 * 从近期全部 M/W 中挑出值得画的剧本区：
 * 已突破/回抽的优先，同价位只留一个，最多 3 块；静态观察只保留每侧最新一个。
 */
export function selectScenarios(reads: ScenarioRead[], n: number, max = 3): SignalItem[] {
  const latest: Record<'top' | 'bottom', number> = { top: -1, bottom: -1 };
  for (const r of reads) latest[r.side] = Math.max(latest[r.side], r.patternIdx);
  const pool = reads
    .filter(r => r.rank > 0 || (r.patternIdx === latest[r.side] && r.patternIdx >= n - 97))
    .sort((a, b) => b.rank - a.rank || b.recency - a.recency);
  const kept: ScenarioRead[] = [];
  for (const r of pool) {
    if (kept.some(k => Math.abs(k.price - r.price) <= Math.max(k.tol, r.tol))) continue;
    kept.push(r);
    if (kept.length >= max) break;
  }
  return kept.map(k => k.item);
}
