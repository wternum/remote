import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { decimalsFor, type AnnTone } from '../annotTypes';
import { annotationTolerance, type AnnotationPattern } from './patterns';
import { evaluateLine, type LineRead } from './scenario';
import type { SignalItem, SignalSource } from './store';
import { fmtClock } from '@/lib/displayTime';

/** 关键位判读只看这几件事：谁被套（诱多/诱空）、会不会回调、该买该卖还是等。 */
export type TrapKind = 'bull' | 'bear' | null;
export type KeyBias = 'buy' | 'sell' | 'wait';
export type PullbackTendency = 'strong' | 'medium' | 'weak';

export interface KeyLevelCall {
  item: SignalItem;
  /** side:firstTs:idxTs，用于与双顶/双底形态标记去重 */
  patternKey: string;
  side: 'top' | 'bottom';
  level: number;
  neck: number;
  trap: TrapKind;
  bias: KeyBias;
  pullback: PullbackTendency;
  /** 判读分（工程规则计数，不是概率） */
  score: number;
  reasons: string[];
  distanceAtr: number;
  patternIdx: number;
  source: SignalSource;
}

export interface KeyLevelCallInput {
  patterns: AnnotationPattern[];
  ctx: Ctx;
  flow?: FlowSnapshot | null;
  barMs: number;
  /** 仅提示，不改变已收盘判定 */
  livePrice?: number;
  maxCalls?: number;
}

const fmt = (v: number) => v.toLocaleString('en-US', {
  minimumFractionDigits: decimalsFor(v), maximumFractionDigits: decimalsFor(v),
});
const hhmm = (ts: number) => fmtClock(ts); // 北京时间
const volX = (v: number) => `${v.toFixed(1)}×`;

/** 同一价位被反复识别时只保留最近的一次；否则一条阻力上会叠十几个双顶。 */
function clusterPatterns(patterns: AnnotationPattern[], atrNow: number): AnnotationPattern[] {
  const gap = Math.max(atrNow * 1.0, 1e-9);
  const sorted = [...patterns].sort((a, b) => a.level - b.level || a.idx - b.idx);
  const out: AnnotationPattern[] = [];
  for (const p of sorted) {
    const hit = out.findIndex(q => q.side === p.side && Math.abs(q.level - p.level) <= gap);
    if (hit < 0) { out.push(p); continue; }
    // 同簇：保留更新的确认；更新 = 更贴近当前行情
    if (p.idx > out[hit].idx) out[hit] = p;
  }
  return out;
}

function unitVolume(ctx: Ctx, from: number, to: number): number {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(ctx.n - 1, Math.max(from, to));
  if (b < a) return 0;
  let sum = 0;
  for (let i = a; i <= b; i++) sum += ctx.cs[i].v;
  return sum / (b - a + 1);
}

/**
 * 把每个双顶/双底压缩成一条关键位判读：
 *   · 诱多 = 阻力被上破后收回（追多被套）→ 偏空、等回调
 *   · 诱空 = 支撑被下破后收回（追空被套）→ 偏多、等反弹
 *   · 没被刺破、二次测试缩量 + 反向成交 → 双顶看回调 / 双底看反弹
 *   · 关键位被有效突破并站稳 → 反手方向，明确不做原方向
 * 分数只是规则计数，不输出“胜率”。
 */
export function buildKeyLevelCalls(input: KeyLevelCallInput): KeyLevelCall[] {
  const { patterns, ctx, flow, barMs, livePrice, maxCalls = 3 } = input;
  const { cs, atr, volMa } = ctx;
  const last = ctx.n - 1;
  if (!cs.length) return [];
  const atrNow = Math.max(atr[last] || 0, 1e-9);
  const today = cs[last].c;
  const current = livePrice != null && Number.isFinite(livePrice) ? livePrice : today;
  const calls: KeyLevelCall[] = [];

  for (const pattern of clusterPatterns(patterns, atrNow)) {
    const top = pattern.side === 'top';
    const level = pattern.level;
    const neck = pattern.neck;
    const testBar = cs[pattern.second];
    const confBar = cs[pattern.idx];
    const a = Math.max(atr[pattern.idx] || 0, 1e-9);
    const tol = Math.max(annotationTolerance(level, atrNow), 0.15 * atrNow);
    const distanceAtr = Math.abs(current - level) / atrNow;
    const ageBars = last - pattern.idx;

    const leg1 = unitVolume(ctx, pattern.firstLegStart, pattern.first);
    const leg2 = unitVolume(ctx, pattern.secondLegStart, pattern.second);
    const secondRatio = leg1 > 0 && leg2 > 0 ? leg2 / leg1 : null;
    const testVol = volMa[pattern.second] > 0 ? testBar.v / volMa[pattern.second] : 0;
    const testRange = Math.max(testBar.h - testBar.l, 1e-9);
    const upperWick = (testBar.h - Math.max(testBar.o, testBar.c)) / testRange;
    const lowerWick = (Math.min(testBar.o, testBar.c) - testBar.l) / testRange;
    const rejectionWick = top ? upperWick : lowerWick;
    const swept = top
      ? testBar.h - level >= 0.05 * a && confBar.c < level
      : level - testBar.l >= 0.05 * a && confBar.c > level;
    const closedInside = top ? confBar.c < level : confBar.c > level;

    const flowAt = (i: number) => {
      const b = flow?.bars.get(cs[i].ts);
      if (!b || ctx.real[i] !== 1 || !(b.buy + b.sell > 0)) return null;
      return { ratio: (b.buy - b.sell) / (b.buy + b.sell), src: b.src as 'rubik' | 'tape' };
    };
    const testFlow = flowAt(pattern.second);
    const confFlow = flowAt(pattern.idx);
    const rev: 1 | -1 = top ? -1 : 1;

    // 关键位本体：上破/下破的生命周期
    const up = evaluateLine(ctx, barMs, level, 1, pattern.idx, 'level', flow);
    const down = evaluateLine(ctx, barMs, level, -1, pattern.idx, 'level', flow);
    const held = (r: LineRead | null) => !!r && r.acceptedAt >= 0 &&
      (r.state === 'broken' || r.state === 'touch' || r.state === 'retest' || r.state === 'continued');
    const recentFail = (r: LineRead | null) => !!r && r.state === 'failed' && r.failedAt >= last - 24;
    // 只认与形态方向匹配的刺破：
    // 双顶（阻力）上破后收回 = 诱多；双底（支撑）下破后收回 = 诱空。
    // 反向穿越（双顶跌破阻力 / 双底涨破支撑）只是关键位失守，不是套人陷阱。
    const trap: TrapKind = top
      ? (recentFail(up) ? 'bull' : null)
      : (recentFail(down) ? 'bear' : null);
    // 形态失效只看同方向的有效突破：双顶怕向上突破，双底怕向下跌破。
    const accepted = top ? held(up) : held(down);

    let score = 0;
    const reasons: string[] = [];
    if (secondRatio != null && secondRatio <= 0.9) {
      score += 1;
      reasons.push(`第二腿缩量 ${volX(secondRatio)} 第一腿（推动力衰减）`);
    } else if (secondRatio != null && secondRatio >= 1.1) {
      score -= 1;
      reasons.push(`第二腿放量 ${volX(secondRatio)} 第一腿（更像延续，不是反转）`);
    }
    if (rejectionWick >= 0.35) {
      score += 1;
      reasons.push(`测试 K ${top ? '上' : '下'}影 ${Math.round(rejectionWick * 100)}%（有关键位拒绝）`);
    }
    if (swept && closedInside) {
      score += 1;
      reasons.push(top ? '刺破阻力后收盘收回（追多被套）' : '刺破支撑后收盘收回（追空被套）');
    }
    if (testFlow && testFlow.ratio * rev >= 0.06) {
      score += 1;
      reasons.push(`测试 K 主动${top ? '卖' : '买'}占优（${Math.round((1 + testFlow.ratio) * 50)}% 主动买 / ${Math.round((1 - testFlow.ratio) * 50)}% 主动卖）`);
    } else if (testFlow && testFlow.ratio * rev <= -0.12) {
      score -= 1;
      reasons.push(`测试 K 主动成交仍在突破侧（${Math.round((1 + testFlow.ratio) * 50)}% 主动买）`);
    }
    if (trap === 'bull') { score += 2; reasons.unshift('阻力被上破后收盘收回：追多被套（诱多）'); }
    if (trap === 'bear') { score += 2; reasons.unshift('支撑被下破后收盘收回：追空被套（诱空）'); }
    if (accepted) score -= 3;

    // 距离太远的历史形态不进画布（同一形态仍在侧栏列表里）。
    // 活跃判读只留近处的关键位；已走完的历史关键位允许更远，但排到最后。
    const limit = 12;
    if (distanceAtr > limit && !trap && !accepted) continue;
    if (distanceAtr > 4 && !trap && !accepted && !(rev * (current - level) > 0)) continue;
    if (ageBars > 96 && !trap && !accepted) continue;
    // 已经朝预期方向走远 = 回调/反弹已发生：保留记录，但改成“已兑现·不追”，
    // 不再提示还在等回调，避免追高/追空。
    const traveled = rev * (current - level) / atrNow; // >0 表示已朝反转方向运行
    const realized = traveled > 1.5 && ageBars > 12;


    const pullback: PullbackTendency = trap || score >= 3 ? 'strong' : score >= 1 ? 'medium' : 'weak';
    const moveWord = top ? '回调' : '反弹';
    let bias: KeyBias;
    let shortLabel: string;
    let title: string;
    let marker: string;
    let verdictText: string;

    if (realized && !accepted) {
      bias = 'wait';
      verdictText = `${moveWord}已走出 ${traveled.toFixed(1)} ATR，不追${moveWord}`;
      shortLabel = top ? '已回调·不追' : '已反弹·不追';
      marker = '已兑现';
      title = `${top ? '双顶阻力' : '双底支撑'} ${fmt(level)} · ${moveWord}已兑现 ${traveled.toFixed(1)} ATR`;
    } else if (trap === 'bull') {
      bias = 'sell';
      verdictText = '偏空（卖），等回调';
      shortLabel = '诱多·等回调';
      marker = '诱多';
      title = `双顶 ${fmt(level)} 诱多 · 冲高收回，多头被套（偏空）`;
    } else if (trap === 'bear') {
      bias = 'buy';
      verdictText = '偏多（买），等反弹';
      shortLabel = '诱空·等反弹';
      marker = '诱空';
      title = `双底 ${fmt(level)} 诱空 · 跌破收回，空头被套（偏多）`;
    } else if (accepted) {
      bias = 'wait';
      verdictText = top ? '观望：原形态失效，不在这里做空' : '观望：原形态失效，不在这里做多';
      shortLabel = top ? '上破·不做空' : '跌破·不做多';
      marker = top ? '上破' : '跌破';
      title = `${top ? '双顶' : '双底'} ${fmt(level)} 关键位已破 · 反手方向，原形态失效`;
    } else if (pullback === 'strong') {
      bias = rev === 1 ? 'buy' : 'sell';
      verdictText = rev === 1 ? '偏多（买）' : '偏空（卖）';
      shortLabel = top ? '双顶·等回调' : '双底·看反弹';
      marker = top ? '看回调' : '看反弹';
      title = `${top ? '双顶阻力' : '双底支撑'} ${fmt(level)} · ${moveWord}倾向强（${rev === 1 ? '偏多' : '偏空'}）`;
    } else if (pullback === 'medium') {
      bias = rev === 1 ? 'buy' : 'sell';
      verdictText = rev === 1 ? '偏多（买）但证据一般' : '偏空（卖）但证据一般';
      shortLabel = top ? '双顶·回调一般' : '双底·反弹一般';
      marker = top ? '回调' : '反弹';
      title = `${top ? '双顶阻力' : '双底支撑'} ${fmt(level)} · ${moveWord}倾向一般`;
    } else {
      bias = 'wait';
      verdictText = '观望：证据不足';
      shortLabel = top ? '双顶·观望' : '双底·观望';
      marker = '观望';
      title = `${top ? '双顶阻力' : '双底支撑'} ${fmt(level)} · 证据不足，观望`;
    }

    const tone: AnnTone = bias === 'buy' ? 'long' : bias === 'sell' ? 'short' : 'warn';
    const flowLine = testFlow
      ? `测试 K 主动成交：主动买 ${Math.round((1 + testFlow.ratio) * 50)}% / 主动卖 ${Math.round((1 - testFlow.ratio) * 50)}%（${testFlow.src === 'rubik' ? 'OKX 官方统计' : '逐笔聚合'}）；仅成交方向，不是订单簿 OFI`
      : '测试 K 买卖额未完整覆盖：不判断主动方向，只用价格与成交量';
    const target1 = neck;
    const target2 = 2 * neck - level;
    const invalidate = top ? `收盘站稳 ${fmt(level + 0.3 * atrNow)} 上方` : `收盘跌破 ${fmt(level - 0.3 * atrNow)}`;
    const targetAtr = Math.abs(target1 - level) / atrNow;
    const targetNote = targetAtr > 4 ? `（距关键位 ${targetAtr.toFixed(1)} ATR，偏远）` : '';
    const detail = [
      `结论：${verdictText} · ${moveWord}倾向 ${pullback === 'strong' ? '强' : pullback === 'medium' ? '一般' : '弱'}${bias === 'wait' ? '' : `；第一目标 ${fmt(target1)}${targetNote}，延伸 ${fmt(target2)}`}`,
      `${top ? '阻力' : '支撑'} ${fmt(level)} · 二次测试 ${fmt(pattern.secondPrice)} · 颈线(第一目标) ${fmt(neck)} · 距现价 ${distanceAtr.toFixed(1)} ATR`,
      `证据：${reasons.join('；') || '缩量/拒绝影线/反向成交均未出现'}`,
      flowLine,
      `失效条件：${invalidate}（收盘才算）`,
    ];

    const id = `keycall:${pattern.side}:${cs[pattern.first].ts}:${cs[pattern.idx].ts}`;
    const item: SignalItem = {
      id,
      type: 'keyLevelScenario',
      ts: cs[pattern.idx].ts,
      fromTs: cs[pattern.first].ts,
      price: level,
      title,
      detail,
      source: testFlow ? 'real' : 'price',
      confirmed: true,
      tone,
      event: {
        id: `${id}:mark`,
        ts: cs[pattern.idx].ts,
        side: top ? 'above' : 'below',
        tone,
        text: marker,
        marker: 'diamond',
        priority: 96,
        title,
        detail,
      },
      levels: [{
        id: `${id}:level`,
        name: shortLabel,
        fromTs: cs[pattern.first].ts,
        toTs: null,
        price: level,
        tone,
        style: 'solid',
        rank: 'read',
        priority: 98,
        label: true,
        detail,
      }],
    };

    calls.push({
      patternKey: `${pattern.side}:${cs[pattern.first].ts}:${cs[pattern.idx].ts}`,
      item, side: pattern.side, level, neck, trap, bias, pullback, score, reasons,
      distanceAtr, patternIdx: pattern.idx, source: item.source,
    });
  }

  // 先给仍在起作用的诱多/诱空，其次离现价最近的明确方向；同方向只留一条。
  const priority = (c: KeyLevelCall) =>
    (c.item.event?.text === '已兑现' ? 3 : c.trap ? 0 : c.bias === 'wait' ? 2 : 1);
  const ranked = calls.sort((a, b) =>
    priority(a) - priority(b) || a.distanceAtr - b.distanceAtr || b.patternIdx - a.patternIdx);
  const kept: KeyLevelCall[] = [];
  const seenSide = new Set<string>();
  for (const c of ranked) {
    const key = `${c.side}:${c.item.tone}`;
    if (c.bias !== 'wait' && seenSide.has(key)) continue;
    seenSide.add(key);
    kept.push(c);
    if (kept.length >= maxCalls) break;
  }
  return kept;
}

/** 画布只需要 item；侧栏仍可拿到完整判读。 */
export function keyLevelCallItems(calls: KeyLevelCall[]): SignalItem[] {
  return calls.map(c => c.item);
}

export const KEY_LEVEL_CALL_LABELS = {
  strong: '强',
  medium: '一般',
  weak: '弱',
} as const;

void hhmm;
