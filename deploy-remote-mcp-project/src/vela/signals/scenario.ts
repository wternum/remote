import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { windowFlow } from '@/quant/orderflow';
import { decimalsFor, type AnnTone } from '../annotTypes';
import { annotationTolerance, type AnnotationPattern } from './patterns';
import type { SignalItem, SignalSource } from './store';

const BREAK_ATR = 0.2;
export const RETEST_WINDOW = 48;
const ZONE_BARS = 1;

/**
 * 量价门槛（5m 工程参数，不是校准胜率）。依据：
 * · 突破需明显放量（文献常用 ≥1.5×20 根均量），缩量突破更常是扫单；
 * · 二次测试/回踩应缩量，放量往往意味着原方向仍在推进；
 * · 回踩超过前一段的 61.8% 时，突破更可能失败。
 */
export const MW_VOLUME = {
  breakout: 1.5,
  weakBreak: 1.2,
  contract: 0.9,
  deepRetest: 0.618,
} as const;

const takerShares = (v: number) => `主动买 ${Math.round((1 + v) * 50)}% / 主动卖 ${Math.round((1 - v) * 50)}%`;
const fmt = (v: number) => {
  const d = decimalsFor(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);
const pctVol = (v: number) => `${v.toFixed(1)}×`;

export type LineState = 'pending' | 'broken' | 'touch' | 'retest' | 'continued' | 'failed' | 'expired';

export interface LineRead {
  kind: 'level' | 'neck';
  price: number;
  /** +1 = 向上突破，-1 = 向下跌破 */
  dir: 1 | -1;
  state: LineState;
  firstBreak: number;
  acceptedAt: number;
  reachedIdx: number;
  failedAt: number;
  flowComplete: boolean;
  flowAligned: boolean;
  flowRatio: number | null;
  waited: number;
  distAtr: number;
  lo: number;
  hi: number;
}

/**
 * 同一关键位的因果生命周期：两根已收盘确认后，持续检查收回/触带/守住/延续。
 * 失效后才允许新的一次突破；旧突破不会被永久钉在第一次回抽的状态。
 * 区带以确认时 ATR 固定，不随之后的价格波动回溯漂移。
 */
export function evaluateLine(
  ctx: Ctx, barMs: number, price: number, dir: 1 | -1,
  startIdx: number, kind: LineRead['kind'], flow?: FlowSnapshot | null,
): LineRead | null {
  const { cs, n, atr } = ctx;
  const last = n - 1;
  if (last <= startIdx) return null;
  const aNow = Math.max(atr[last] || 0, 1e-9);
  const beyond = (i: number) => {
    const a = Math.max(atr[i] || 0, 1e-9);
    return dir > 0 ? cs[i].c > price + BREAK_ATR * a : cs[i].c < price - BREAK_ATR * a;
  };
  const backInside = (i: number) => {
    const a = Math.max(atr[i] || 0, 1e-9);
    return dir > 0 ? cs[i].c < price - BREAK_ATR * a : cs[i].c > price + BREAK_ATR * a;
  };
  const band = (i: number) => {
    const a = Math.max(atr[i] || 0, 1e-9);
    const tol = Math.max(annotationTolerance(price, a), 0.15 * a);
    return { lo: price - tol, hi: price + tol };
  };
  let latest: LineRead | null = null;
  for (let i = startIdx + 1; i < last; i++) {
    // Only a NEW crossing starts a cycle. Consecutive closes outside cannot
    // endlessly resurrect an expired break with a fresh timestamp.
    if ((i > startIdx + 1 && beyond(i - 1)) || !beyond(i) || !beyond(i + 1) ||
        cs[i + 1].ts - cs[i].ts !== barMs) continue;
    const acceptedAt = i + 1;
    const { lo, hi } = band(acceptedAt);
    const w = windowFlow(ctx, i, acceptedAt);
    const b1 = flow?.bars.get(cs[i].ts);
    const b2 = flow?.bars.get(cs[acceptedAt].ts);
    const flowComplete = w.known === 1 && !!b1 && !!b2;
    const buy = (b1?.buy ?? 0) + (b2?.buy ?? 0);
    const sell = (b1?.sell ?? 0) + (b2?.sell ?? 0);
    // Normalize by ACTUAL taker turnover, not candle volume (85–95% coverage
    // may be allowed, so candle-volume division would dilute the ratio).
    const flowRatio = flowComplete && buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
    const read: LineRead = {
      kind, price, dir, state: 'broken', firstBreak: i, acceptedAt,
      reachedIdx: -1, failedAt: -1, flowComplete: flowRatio !== null,
      flowAligned: flowRatio !== null && flowRatio * dir >= 0.04,
      flowRatio, waited: 0, distAtr: 0, lo, hi,
    };
    let finishedAt = last;
    for (let j = acceptedAt + 1; j <= last; j++) {
      read.waited = j - acceptedAt;
      if (backInside(j)) {
        read.state = 'failed';
        read.failedAt = j;
        finishedAt = j;
        break;
      }
      if (read.reachedIdx < 0 && cs[j].h >= lo && cs[j].l <= hi) read.reachedIdx = j;
      if (read.reachedIdx >= 0) {
        if (j - read.reachedIdx > 12) { read.state = 'expired'; finishedAt = j; break; }
        if (!beyond(j)) read.state = 'touch';
        else if (j > read.reachedIdx && dir * (cs[j].c - price) > (hi - lo) / 2 + 0.4 * aNow) read.state = 'continued';
        else read.state = 'retest';
      } else if (read.waited >= RETEST_WINDOW) {
        read.state = 'expired'; finishedAt = j; break;
      }
    }
    if (read.state === 'broken') {
      const c = cs[last].c;
      read.waited = last - acceptedAt;
      read.distAtr = c < lo ? (lo - c) / aNow : c > hi ? (c - hi) / aNow : 0;
    }
    latest = read;
    if (finishedAt === last && read.state !== 'failed' && read.state !== 'expired') break;
    i = finishedAt;
  }
  // A single newly closed crossing has no confirmed break yet. Do not replay
  // a past failed/expired cycle as though it were still active.
  if (beyond(last) && !beyond(last - 1) && cs[last].ts - cs[last - 1].ts === barMs) {
    const { lo, hi } = band(last);
    return { kind, price, dir, lo, hi, state: 'pending', firstBreak: last, acceptedAt: -1,
      reachedIdx: -1, failedAt: -1, flowComplete: false, flowAligned: false, flowRatio: null, waited: 0, distAtr: 0 };
  }
  return latest;
}

/** 双顶/双底的当前阶段：只有这几种，不再用模糊的“剧本”措辞。 */
export type MwPhase =
  | 'no-break'        // 二次测试完成，颈线未破：反转候选（买/卖向观察）
  | 'sweep-level'     // 关键位刺破又收回：假突破（诱多/诱空）
  | 'level-broken'    // 关键位被有效突破：形态失效
  | 'break-pending'   // 只有一根收在颈线外，待确认
  | 'break-weak'      // 两根破位但缩量：疑假突破
  | 'break-wait'      // 放量破颈线，尚未回踩：等回踩，不追
  | 'break-retest'    // 已回踩，但守住质量不足
  | 'break-held'      // 回踩守住：真突破延续方向
  | 'break-failed'    // 破位后重新收回：突破失败
  | 'expired';

export type MwSide = 'long' | 'short' | null;

export interface MwEvidence {
  /** 第一腿（推进到第一次极值）单位成交量 */
  leg1Unit: number;
  /** 第二腿（推进到第二次测试）单位成交量 */
  leg2Unit: number;
  /** 第二腿 / 第一腿：<1 缩量，>1.1 放量 */
  secondRatio: number | null;
  /** 颈线确认根成交量 / 20 根均量 */
  breakRatio: number | null;
  /** 回踩根成交量 / 突破确认根成交量 */
  retestVsBreak: number | null;
  /** 回踩深度（0 = 未回撤，1 = 完全回到颈线另一侧） */
  retestDepth: number | null;
  /** 确认两根的真实主动成交方向（可缺） */
  flowRatio: number | null;
  flowSrc: 'rubik' | 'tape' | null;
}

export interface MwPhaseRead {
  phase: MwPhase;
  bias: MwSide;
  evidence: MwEvidence;
  item: SignalItem;
  rank: number;
  price: number;
  tol: number;
  recency: number;
  patternIdx: number;
  side: 'top' | 'bottom';
  direction: 1 | -1;
}

export interface ScenarioRead {
  item: SignalItem;
  /** 4 = 回踩确认；3 = 放量破位/假突破；2 = 待确认；1 = 未突破/刚失效；负数 = 过期 */
  rank: number;
  price: number;
  tol: number;
  recency: number;
  patternIdx: number;
  side: 'top' | 'bottom';
  direction: 1 | -1;
}

export interface KeyLevelScenarioInput {
  pattern: AnnotationPattern;
  ctx: Ctx;
  flow?: FlowSnapshot | null;
  barMs: number;
  /** 仅用于盘中预警，不改变已收盘的突破/回踩判定。 */
  livePrice?: number;
}

function unitVolume(ctx: Ctx, from: number, to: number): number {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(ctx.n - 1, Math.max(from, to));
  let sum = 0;
  for (let i = a; i <= b; i++) sum += ctx.cs[i].v;
  return b >= a ? sum / (b - a + 1) : 0;
}

/**
 * 把一次双顶/双底压缩成一个明确阶段 + 方向。
 * 判定全部只用已收盘 K 线；活跃方向只在二次测试、放量破颈线、
 * 回踩守住三处成立，其余明确写“未突破/疑假/失败”。
 */
export function analyzeMwPhase({ pattern, ctx, flow, barMs, livePrice }: KeyLevelScenarioInput): MwPhaseRead {
  const { cs, atr, volMa } = ctx;
  const last = ctx.n - 1;
  const top = pattern.side === 'top';
  const rev: 1 | -1 = top ? -1 : 1; // 反转方向（双底 +1 买，双顶 -1 卖）
  const name = top ? '双顶' : '双底';
  const key = `${pattern.side}:${cs[pattern.first].ts}:${cs[pattern.idx].ts}`;
  const nowTs = cs[last].ts;
  const aNow = Math.max(atr[last] || 0, 1e-9);
  const priceBand = (price: number) => {
    const tol = Math.max(annotationTolerance(price, aNow), 0.15 * aNow);
    return { lo: price - tol, hi: price + tol, tol };
  };
  const levelBand = priceBand(pattern.level);
  const neckBand = priceBand(pattern.neck);

  const levelRead = evaluateLine(ctx, barMs, pattern.level, top ? 1 : -1, pattern.idx, 'level', flow);
  const neckRead = evaluateLine(ctx, barMs, pattern.neck, top ? -1 : 1, pattern.idx, 'neck', flow);

  const leg1Unit = unitVolume(ctx, pattern.firstLegStart, pattern.first);
  const leg2Unit = unitVolume(ctx, pattern.secondLegStart, pattern.second);
  const secondRatio = leg1Unit > 0 && leg2Unit > 0 ? leg2Unit / leg1Unit : null;
  const volRatioAt = (i: number) => (volMa[i] > 0 ? cs[i].v / volMa[i] : 0);
  const flowAt = (i: number) => {
    const b = flow?.bars.get(cs[i].ts);
    return b && ctx.real[i] === 1 && b.buy + b.sell > 0
      ? { ratio: (b.buy - b.sell) / (b.buy + b.sell), src: b.src as 'rubik' | 'tape' }
      : null;
  };
  const sw = (i: number) => Math.max(0, Math.min(i, last));

  // ── 颈线证据 ──
  const neckAccepted = neckRead && neckRead.acceptedAt >= 0 ? neckRead.acceptedAt : -1;
  const breakIdx = neckAccepted;
  const breakRatio = breakIdx >= 0 ? volRatioAt(breakIdx) : null;
  const breakFlow = breakIdx >= 0 ? flowAt(breakIdx) : null;
  let retestVsBreak: number | null = null;
  let retestDepth: number | null = null;
  if (neckRead && neckRead.reachedIdx >= 0 && breakIdx >= 0) {
    const rIdx = sw(neckRead.reachedIdx);
    const breakVol = Math.max(cs[breakIdx].v, 1e-9);
    retestVsBreak = cs[rIdx].v / breakVol;
    let ext = pattern.neck;
    for (let i = breakIdx; i <= rIdx; i++) ext = neckRead.dir > 0 ? Math.max(ext, cs[i].h) : Math.min(ext, cs[i].l);
    // Retracement is measured on CLOSES against the breakout leg; the leg is
    // floored at 1.5 ATR because a barely-extended break makes ratios unstable.
    const legSpan = Math.max(
      (neckRead.dir > 0 ? ext - pattern.neck : pattern.neck - ext),
      1.5 * Math.max(atr[breakIdx] || 0, 1e-9),
    );
    const back = neckRead.dir > 0 ? ext - cs[rIdx].c : cs[rIdx].c - ext;
    retestDepth = Math.max(0, Math.min(1, back / legSpan));
  }
  const evidence: MwEvidence = {
    leg1Unit, leg2Unit, secondRatio, breakRatio, retestVsBreak, retestDepth,
    flowRatio: breakFlow?.ratio ?? null, flowSrc: breakFlow?.src ?? null,
  };

  const make = (o: {
    phase: MwPhase; bias: MwSide; rank: number; recency: number;
    price: number; band: { lo: number; hi: number; tol: number };
    title: string; label: string; zoneText: string; detail: string[];
    source: SignalSource; fromTs: number; toTs: number;
    showZone?: boolean; failed?: boolean;
    mark?: { idx: number; text: string; tone: AnnTone; side: 'above' | 'below' };
  }): MwPhaseRead => {
    const tone: AnnTone = o.bias === 'long' ? 'long' : o.bias === 'short' ? 'short' : 'warn';
    const item: SignalItem = {
      id: `scenario:${key}`, type: 'keyLevelScenario', ts: nowTs, fromTs: o.fromTs,
      price: o.price, title: o.title, detail: o.detail, source: o.source,
      confirmed: true, tone,
      ...(o.mark ? {
        event: {
          id: `scenario:${key}:mark`, ts: cs[o.mark.idx].ts, side: o.mark.side, tone: o.mark.tone,
          text: o.mark.text, marker: 'diamond' as const, priority: 90, title: o.title, detail: o.detail,
        },
      } : {}),
      ...(o.showZone === false ? {} : {
        zone: {
          id: `scenario:${key}:zone`, fromTs: o.fromTs, toTs: o.toTs,
          lo: o.band.lo, hi: o.band.hi, tone, text: o.zoneText, priority: 92,
          failed: o.failed, title: o.title, detail: o.detail,
        },
      }),
    };
    return {
      phase: o.phase, bias: o.bias, evidence, item, rank: o.rank,
      price: o.price, tol: o.band.tol, recency: o.recency, patternIdx: pattern.idx,
      side: pattern.side, direction: o.bias === 'long' ? 1 : o.bias === 'short' ? -1 : rev,
    };
  };

  const volumeLine = [
    secondRatio == null ? null : `第二腿量 ${pctVol(secondRatio)} 第一腿（${secondRatio < MW_VOLUME.contract ? '缩量，支持反转' : secondRatio > 1.1 ? '放量，更像延续' : '接近'}）`,
    breakRatio == null ? null : `颈线确认量 ${pctVol(breakRatio)} 20 根均量（${breakRatio >= MW_VOLUME.breakout ? '放量' : breakRatio < MW_VOLUME.weakBreak ? '缩量' : '一般'}）`,
    retestVsBreak == null ? null : `回踩量 ${pctVol(retestVsBreak)} 突破量（${retestVsBreak <= MW_VOLUME.contract ? '收缩' : '未收缩'}）`,
  ].filter((x): x is string => !!x);

  const flowLine = breakFlow
    ? `确认两根主动成交：${takerShares(breakFlow.ratio)}（${breakFlow.src === 'rubik' ? 'OKX 官方统计' : '逐笔聚合'}），仅是成交方向，不是订单簿 OFI`
    : '确认两根的买卖额未完整覆盖，不据此声称订单流同向';
  const caveat = '5m 破位约六成会在数根内收回，所以只认两根收盘 + 回踩；这是结构状态，不是胜率或入市建议';

  const fromSecond = cs[pattern.second].ts;
  const nowEdge = nowTs + barMs * ZONE_BARS;

  // ── 1. 关键位假突破（先扫后收回）─ 优先于静态观察 ──
  const levelReclaim = levelRead && levelRead.acceptedAt >= 0 && levelRead.state === 'failed' &&
    levelRead.failedAt >= last - 12;
  const levelHolding = levelRead && levelRead.acceptedAt >= 0 &&
    (levelRead.state === 'broken' || levelRead.state === 'touch' ||
     levelRead.state === 'retest' || levelRead.state === 'continued');
  const neckHeld = neckRead && (neckRead.state === 'retest' || neckRead.state === 'continued');

  if (levelReclaim && !neckHeld) {
    const reclaimIdx = (levelRead as LineRead).failedAt;
    const back = top ? '跌回关键位上方' : '收回关键位下方';
    return make({
      phase: 'sweep-level', bias: rev === 1 ? 'long' : 'short', rank: 3,
      recency: reclaimIdx, price: pattern.level, band: levelBand,
      title: `${name} ${fmt(pattern.level)} 关键位被刺破后收回 · ${rev === 1 ? '买向' : '卖向'}候选`,
      label: top ? '假突破·卖向' : '假跌破·买向',
      zoneText: top ? '假突破·卖向候选' : '假跌破·买向候选',
      detail: [
        `${hhmm(cs[reclaimIdx].ts + barMs)} 收盘重新${back}；刺破不等于有效突破`,
        volumeLine.slice(0, 2).join('；') || '量能数据不足',
        caveat,
      ],
      source: 'price', fromTs: cs[(levelRead as LineRead).firstBreak].ts, toTs: nowEdge,
      mark: { idx: reclaimIdx, text: top ? '假突破' : '假跌破', tone: rev === 1 ? 'long' : 'short', side: top ? 'above' : 'below' },
    });
  }

  // ── 2. 关键位被有效突破：形态失效，方向随突破 ──
  if (levelHolding) {
    const lv = levelRead as LineRead;
    const up = lv.dir > 0;
    const retested = lv.reachedIdx >= 0;
    const bias: MwSide = up ? 'long' : 'short';
    const liveBack = livePrice != null && Number.isFinite(livePrice) &&
      lv.dir * (livePrice - pattern.level) < -BREAK_ATR * aNow;
    return make({
      phase: 'level-broken', bias, rank: retested ? 3 : 2,
      recency: retested ? lv.reachedIdx : lv.acceptedAt,
      price: pattern.level, band: { lo: lv.lo, hi: lv.hi, tol: (lv.hi - lv.lo) / 2 },
      title: `${name} ${fmt(pattern.level)} ${up ? '阻力上破' : '支撑失守'} · ${retested ? (up ? '回踩守住·买向' : '反抽受阻·卖向') : (up ? '等回踩' : '等反抽')}`,
      label: retested ? (up ? '回踩守住·买向' : '反抽受阻·卖向') : (up ? '阻力上破·等回踩' : '支撑失守·等反抽'),
      zoneText: liveBack ? '盘中已回到位内·待收盘' : retested ? (up ? '回踩守住' : '反抽受阻') : (up ? '等回踩区' : '等反抽区'),
      detail: [
        `${hhmm(cs[lv.acceptedAt].ts + barMs)} 两根收盘${up ? '站上' : '跌破'}关键位；原${name}结构被否定`,
        retested
          ? `${hhmm(cs[lv.reachedIdx].ts + barMs)} 首次${up ? '回踩' : '反抽'}${up ? '守住' : '受阻'}；方向${up ? '偏买' : '偏卖'}`
          : `等待首次${up ? '回踩' : '反抽'}；${up ? '回踩守住才是买向' : '反抽受阻才是卖向'}`,
        liveBack ? '盘中价格已回到关键位另一侧；需收盘确认，当前不改状态' : caveat,
      ],
      source: lv.flowComplete ? 'real' : 'price',
      fromTs: cs[lv.firstBreak].ts,
      toTs: retested ? cs[lv.reachedIdx].ts + barMs : nowEdge,
      mark: retested
        ? { idx: lv.reachedIdx, text: up ? '回踩守住' : '反抽受阻', tone: bias === 'long' ? 'long' : 'short', side: up ? 'below' : 'above' }
        : { idx: lv.acceptedAt, text: up ? '阻力上破' : '支撑失守', tone: bias === 'long' ? 'long' : 'short', side: up ? 'below' : 'above' },
      failed: false,
    });
  }

  // ── 3. 颈线已确认突破：分辨真突破/疑假、是否回踩 ──
  if (neckRead && neckRead.acceptedAt >= 0 && neckRead.state !== 'expired') {
    const nr = neckRead;
    const up = nr.dir > 0;
    const breakWord = up ? '上破颈线' : '下破颈线';
    const back = up ? '回踩' : '反抽';
    const strong = (breakRatio ?? 0) >= MW_VOLUME.breakout;
    const weak = (breakRatio ?? 0) < MW_VOLUME.weakBreak;
    const expandedSecond = secondRatio != null && secondRatio > 1.1;
    const flowOk = nr.flowRatio == null ? null : nr.flowRatio * nr.dir >= 0.04;

    if (nr.state === 'failed') {
      const recent = nr.failedAt >= last - 6;
      return make({
        phase: 'break-failed', bias: up ? 'short' : 'long', rank: recent ? 1 : -1,
        recency: nr.failedAt, price: pattern.neck, band: { lo: nr.lo, hi: nr.hi, tol: (nr.hi - nr.lo) / 2 },
        title: `${name} ${breakWord}失败 · 收盘重新收回`,
        label: up ? '上破失败·卖向' : '下破失败·买向',
        zoneText: up ? '上破失败·卖向候选' : '下破失败·买向候选',
        detail: [
          `${hhmm(cs[nr.failedAt].ts + barMs)} 收盘回到颈线${up ? '下' : '上'}方，${up ? '上破' : '下破'}被否定`,
          volumeLine[1] ?? '量能数据不足',
          caveat,
        ],
        source: nr.flowComplete ? 'real' : 'price', fromTs: cs[nr.firstBreak].ts, toTs: nowEdge,
        showZone: recent,
        mark: recent ? { idx: nr.failedAt, text: '突破失败', tone: up ? 'short' : 'long', side: up ? 'above' : 'below' } : undefined,
      });
    }

    if (!strong && !nr.flowAligned) {
      return make({
        phase: 'break-weak', bias: null, rank: 2,
        recency: nr.acceptedAt, price: pattern.neck, band: { lo: nr.lo, hi: nr.hi, tol: (nr.hi - nr.lo) / 2 },
        title: `${name} ${breakWord}但量能不足 · 疑假突破`,
        label: up ? '缩量上破·观望' : '缩量下破·观望',
        zoneText: up ? '缩量上破·观望' : '缩量下破·观望',
        detail: [
          `${hhmm(cs[nr.acceptedAt].ts + barMs)} 两根收盘${breakWord}，但${breakRatio == null ? '量能缺失' : `量仅 ${pctVol(breakRatio)} 均量`}`,
          `${expandedSecond ? '第二腿放量：更像原方向延续，' : ''}缩量破位常见于扫单，不追`,
          caveat,
        ],
        source: 'price', fromTs: cs[nr.firstBreak].ts, toTs: nowEdge,
        mark: { idx: nr.acceptedAt, text: up ? '缩量上破' : '缩量下破', tone: 'warn', side: up ? 'below' : 'above' },
      });
    }

    if (nr.reachedIdx < 0) {
      return make({
        phase: 'break-wait', bias: up ? 'long' : 'short', rank: 3,
        recency: nr.acceptedAt, price: pattern.neck, band: { lo: nr.lo, hi: nr.hi, tol: (nr.hi - nr.lo) / 2 },
        title: `${name} ${breakWord}放量 · ${back}前不追`,
        label: up ? '颈线破·等回踩' : '颈线破·等反抽',
        zoneText: up ? '等回踩区' : '等反抽区',
        detail: [
          `${hhmm(cs[nr.acceptedAt].ts + barMs)} 两根收盘${breakWord}，量 ${pctVol(breakRatio ?? 0)} 均量`,
          `${back}带 ${fmt(nr.lo)}–${fmt(nr.hi)}；已等 ${nr.waited}/${RETEST_WINDOW} 根`,
          flowLine,
        ],
        source: nr.flowComplete ? 'real' : 'price',
        fromTs: cs[nr.firstBreak].ts, toTs: nowEdge,
        mark: { idx: nr.acceptedAt, text: up ? '颈线破' : '颈线破', tone: up ? 'long' : 'short', side: up ? 'below' : 'above' },
      });
    }

    const depth = retestDepth;
    const deep = depth != null && depth > MW_VOLUME.deepRetest;
    const contracting = retestVsBreak != null && retestVsBreak <= MW_VOLUME.contract;
    // 回踩量明显放大（≥1.2× 突破量）不符合“缩量回踩”，即使收盘仍在位外也只算待确认。
    const volumeOk = retestVsBreak == null || retestVsBreak < 1.2;
    const holdState = nr.state === 'retest' || nr.state === 'continued';
    if (holdState && !deep && volumeOk) {
      return make({
        phase: 'break-held', bias: up ? 'long' : 'short', rank: 4,
        recency: nr.reachedIdx, price: pattern.neck, band: { lo: nr.lo, hi: nr.hi, tol: (nr.hi - nr.lo) / 2 },
        title: `${name} ${breakWord}后${back}守住 · ${up ? '买向' : '卖向'}`,
        label: up ? '回踩守住·买向' : '反抽受阻·卖向',
        zoneText: up ? '回踩守住' : '反抽受阻',
        detail: [
          `${hhmm(cs[nr.reachedIdx].ts + barMs)} ${back}到颈线后收盘仍在${up ? '上' : '下'}方；回撤 ${depth == null ? '—' : `${Math.round(depth * 100)}%`}，${deep ? '偏深' : '未破 61.8%'}`,
          `突破量 ${pctVol(breakRatio ?? 0)}、回踩量 ${retestVsBreak == null ? '—' : pctVol(retestVsBreak)} 突破量（${contracting ? '收缩，支持守住' : '未收缩，注意反复'}）`,
          flowLine,
        ],
        source: nr.flowComplete ? 'real' : 'price',
        fromTs: cs[nr.firstBreak].ts, toTs: cs[nr.reachedIdx].ts + barMs * ZONE_BARS,
        mark: { idx: nr.reachedIdx, text: up ? '回踩守住' : '反抽受阻', tone: up ? 'long' : 'short', side: up ? 'below' : 'above' },
      });
    }
    return make({
      phase: 'break-retest', bias: up ? 'long' : 'short', rank: 2,
      recency: nr.reachedIdx, price: pattern.neck, band: { lo: nr.lo, hi: nr.hi, tol: (nr.hi - nr.lo) / 2 },
      title: `${name} ${back}中 · 尚未确认守住`,
      label: up ? '回踩待确认' : '反抽待确认',
      zoneText: up ? '回踩待确认' : '反抽待确认',
      detail: [
        `${hhmm(cs[nr.reachedIdx].ts + barMs)} 已${back}到颈线；回撤 ${depth == null ? '—' : `${Math.round(depth * 100)}%`}${deep ? '（超过 61.8%，突破可能失败）' : ''}`,
        retestVsBreak == null ? '回踩量能不足' : `回踩量 ${pctVol(retestVsBreak)} 突破量（${contracting ? '收缩' : '偏大'}）`,
        caveat,
      ],
      source: 'price', fromTs: cs[nr.firstBreak].ts, toTs: cs[nr.reachedIdx].ts + barMs * ZONE_BARS,
    });
  }

  // ── 4. 单根越位：还不够 ──
  const pending = [neckRead, levelRead].find((r): r is LineRead => !!r && r.state === 'pending');
  if (pending) {
    const up = pending.dir > 0;
    return make({
      phase: 'break-pending', bias: null, rank: 1, recency: last,
      price: pending.price, band: { lo: pending.lo, hi: pending.hi, tol: (pending.hi - pending.lo) / 2 },
      title: `${name} ${pending.kind === 'neck' ? '颈线' : '关键位'}只有一根收在外 · 再看一根`,
      label: up ? '单根上破·待确认' : '单根下破·待确认',
      zoneText: '待第二根收盘',
      detail: ['只有 1 根 K 线收在外面；第二根同向收盘才构成价格突破', '此处不产生买/卖方向'],
      source: 'price', fromTs: cs[Math.max(pattern.second, last - 4)].ts, toTs: nowEdge,
    });
  }

  // ── 5. 没突破：二次测试的反转候选 ──
  if (last - pattern.idx > 48) {
    return make({
      phase: 'expired', bias: null, rank: -1, recency: pattern.idx,
      price: pattern.level, band: levelBand, title: `${name} 旧二次测试`, label: '',
      zoneText: '', showZone: false,
      detail: ['这段结构已超出当前观察范围；历史标记仍在侧栏。'],
      source: 'price', fromTs: fromSecond, toTs: cs[pattern.idx].ts,
    });
  }
  const expanded = secondRatio != null && secondRatio > 1.1;
  const bias: MwSide = expanded ? null : rev === 1 ? 'long' : 'short';
  const label = expanded
    ? (top ? '双顶候选·放量存疑' : '双底候选·放量存疑')
    : (top ? '双顶·卖向候选' : '双底·买向候选');
  const liveAgainst = livePrice != null && Number.isFinite(livePrice) &&
    rev * (livePrice - pattern.level) < -2 * aNow; // 现价远离候选方向
  return make({
    phase: 'no-break', bias, rank: liveAgainst ? 0 : 1, recency: pattern.idx,
    price: pattern.level, band: levelBand,
    title: `${name} ${fmt(pattern.level)} 二次测试 · ${bias === 'long' ? '买向候选' : bias === 'short' ? '卖向候选' : '方向存疑'}`,
    label: liveAgainst ? '已远离·仅历史' : label,
    zoneText: liveAgainst ? '已远离' : label,
    detail: [
      `第二次测试 ${fmt(pattern.secondPrice)}、收盘回到位内；颈线 ${fmt(pattern.neck)} 尚未收盘${top ? '下破' : '上破'}`,
      volumeLine[0] ?? '量能数据不足',
      `${caveat}；${bias === 'long' ? '买向' : bias === 'short' ? '卖向' : '无方向'}只在颈线被放量突破后才升级`,
    ],
    source: 'price', fromTs: fromSecond, toTs: nowEdge,
    showZone: !liveAgainst,
    mark: liveAgainst ? undefined : { idx: pattern.idx, text: label, tone: rev === 1 ? 'long' : 'short', side: top ? 'above' : 'below' },
  });
}

/** 兼容既有调用：把阶段结果转成画布选择所需的读结构。 */
export function analyzeKeyLevelScenario(input: KeyLevelScenarioInput): ScenarioRead {
  const read = analyzeMwPhase(input);
  return read;
}

/**
 * 每个方向只保留一个当前阶段（避免同色区带堆叠）：
 * 回踩确认 > 放量破位/假突破 > 待确认 > 未突破；过期与陈旧的失效不再进画布。
 */
export function selectScenarios(reads: ScenarioRead[], n: number, max = 2): SignalItem[] {
  const latest: Record<'top' | 'bottom', number> = { top: -1, bottom: -1 };
  for (const r of reads) if (r.rank >= 0) latest[r.side] = Math.max(latest[r.side], r.patternIdx);
  const pool = reads
    .filter(r => r.rank > 0 || (r.rank === 0 && r.patternIdx === latest[r.side]))
    .sort((a, b) => b.rank - a.rank || b.recency - a.recency);
  const kept: ScenarioRead[] = [];
  for (const r of pool) {
    if (kept.some(k => k.direction === r.direction || Math.abs(k.price - r.price) <= Math.max(k.tol, r.tol))) continue;
    kept.push(r);
    if (kept.length >= Math.min(max, 2)) break;
  }
  return kept.map(k => k.item);
}

