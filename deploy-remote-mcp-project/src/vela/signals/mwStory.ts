import type { Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { windowFlow } from '@/quant/orderflow';
import { readSmartMoney } from '@/quant/smartmoney';
import { decimalsFor, type AnnTone } from '../annotTypes';
import { annotationTolerance, type AnnotationPattern } from './patterns';
import { BREAK_ATR, evaluateLine, MW_VOLUME, RECLAIM_WINDOW, RETEST_WINDOW, type LineRead } from './scenario';
import { observationText, pct, readMwEvidence, takerObservation, volumeRatio, type MwEvidence } from './evidence';
import type { SignalItem } from './store';

export type MwPhase = 'no-break' | 'sweep-level' | 'break-pending' | 'break-weak' | 'break-wait' | 'break-retest' | 'break-held' | 'break-failed' | 'target-reached' | 'expired';
export type MwBias = 'long' | 'short' | null;
export interface StorySection { id: 'conclusion' | 'strength' | 'flow' | 'trap' | 'path' | 'targets'; title: string; lines: string[] }
export interface StoryMoment { id: string; at: number; barTs: number; label: string }
export interface StoryTrap {
  kind: 'bull' | 'bear'; form: 'test-sweep' | 'failed-break'; source: 'real' | 'price';
  at: number; barTs: number; active: boolean; label: string;
}
export interface MwStory {
  phase: MwPhase; phaseLabel: string; bias: MwBias; active: boolean; priority: number;
  side: 'top' | 'bottom'; lineKind: 'level' | 'neck' | null; invalidated: boolean;
  level: number; neck: number; referenceAtr: number; distanceAtr: number;
  patternCount: number; testCount: number; lastActivityAt: number;
  origin: { firstTs: number; secondTs: number; confirmedAt: number; level: number; neck: number };
  evidence: MwEvidence; trap: StoryTrap | null; path: LineRead | null;
  breakVolume: number | null; retestVolume: number | null; retestDepth: number | null;
  targets: { first: number; extension: number | null; firstTouchAt: number | null; extensionTouchAt: number | null; suspended: boolean };
  sections: StorySection[]; timeline: StoryMoment[];
  preview: string | null;
  smc: { hits: number; source: string; lines: string[] } | null;
}
export interface MwStoryInput {
  pattern: AnnotationPattern; ctx: Ctx; flow?: FlowSnapshot | null; barMs: number;
  /** Used for a separately labelled preview only; never changes phase, bias, targets or ranking. */
  livePrice?: number; members?: AnnotationPattern[];
}
const price = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: decimalsFor(v), maximumFractionDigits: decimalsFor(v) });
const time = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
const ratio = (v: number | null) => v == null ? '无数据' : `${v.toFixed(2)}×`;
const samePattern = (a: AnnotationPattern, b: AnnotationPattern) => a.side === b.side && a.first === b.first && a.second === b.second && a.idx === b.idx;

/** Combine overlapping descriptions of the same level/neckline, not unrelated episodes days apart. */
export function groupMwPatterns(patterns: AnnotationPattern[], ctx: Ctx): AnnotationPattern[][] {
  const groups: AnnotationPattern[][] = [];
  for (const p of [...patterns].sort((a, b) => a.idx - b.idx || a.first - b.first)) {
    if (!ctx.cs[p.idx] || !ctx.cs[p.first] || !ctx.cs[p.second] || !ctx.cs[p.neckIdx]) continue;
    const match = groups.find(g => {
      const q = g[g.length - 1];
      const atr = Math.max(ctx.atr[p.idx] || 0, ctx.atr[q.idx] || 0, 1e-9);
      const overlaps = Math.max(p.first, q.first) <= Math.min(p.idx, q.idx);
      return q.side === p.side && overlaps && (Math.abs(p.level - q.level) <= atr ||
        Math.abs(p.neck - q.neck) <= Math.max(annotationTolerance(p.neck, atr), annotationTolerance(q.neck, atr)));
    });
    if (!match) groups.push([p]);
    else if (!match.some(q => samePattern(q, p))) match.push(p);
  }
  return groups;
}

function trapAt(input: MwStoryInput, e: MwEvidence, level: LineRead | null): StoryTrap | null {
  const { pattern: p, ctx, flow, barMs } = input;
  const top = p.side === 'top', dir = top ? -1 : 1, last = ctx.n - 1;
  let idx = p.idx, form: StoryTrap['form'] = 'test-sweep', supported = false;
  if (level?.state === 'failed' && level.failedAt >= 0) {
    idx = level.failedAt; form = 'failed-break';
    const reclaim = takerObservation(ctx, flow, idx);
    supported = level.flowComplete && !!reclaim && reclaim.ratio * dir >= 0.04;
  } else if (e.sweepAtr >= 0.05 && e.closedInside) {
    const t = e.test?.ratio, c = e.confirmation?.ratio;
    supported = t != null && c != null && ((t * dir >= 0.06 && c * dir >= -0.02) ||
      (t * dir <= -0.12 && (e.testVolume ?? 0) >= 1.3 && (p.second === p.idx || c * dir >= 0.04)));
  } else return null;
  const label = supported ? (top ? '诱多候选' : '诱空候选')
    : form === 'failed-break' ? (top ? '假突破（仅价格）' : '假跌破（仅价格）')
      : (top ? '扫高收回（仅价格）' : '扫低收回（仅价格）');
  return { kind: top ? 'bull' : 'bear', form, source: supported ? 'real' : 'price',
    at: ctx.cs[idx].ts + barMs, barTs: ctx.cs[idx].ts, active: last - idx <= RECLAIM_WINDOW, label };
}

/** One verdict for one M/W. A later opposing failure can supersede an older neckline episode. */
export function analyzeMwStory(input: MwStoryInput): SignalItem {
  const { pattern: p, ctx, flow, barMs, livePrice, members = [p] } = input;
  const { cs, atr } = ctx, last = ctx.n - 1;
  const top = p.side === 'top', rev: 1 | -1 = top ? -1 : 1, name = top ? '双顶' : '双底';
  const a = Math.max(atr[p.idx] || 0, 1e-9), aNow = Math.max(atr[last] || a, 1e-9);
  const anchorFirst = Math.min(...members.map(m => m.first));
  const id = `mw:${p.side}:${cs[anchorFirst].ts}`;
  const e = readMwEvidence(ctx, p, barMs, flow);
  const level = evaluateLine(ctx, barMs, p.level, top ? 1 : -1, p.idx, 'level', flow);
  const neck = evaluateLine(ctx, barMs, p.neck, rev, p.idx, 'neck', flow);
  const trap = trapAt(input, e, level);
  const validReads = [neck, level].filter((r): r is LineRead => r !== null);
  // A newer crossing/failure is actionable; do not prioritize an obsolete neckline above a later invalidation.
  const line = validReads.sort((x, y) => y.lastEventIdx - x.lastEventIdx || (x.kind === 'neck' ? -1 : 1))[0] ?? null;
  const liveStates = ['broken', 'touch', 'retest', 'continued'];
  const invalidated = !!level && level.acceptedAt >= 0 && level.state !== 'failed' &&
    (liveStates.includes(level.state) || (level.state === 'expired' && (top ? cs[last].c > p.level : cs[last].c < p.level)));
  let phase: MwPhase = 'no-break', label = '二次测试·待突破', bias: MwBias = null;
  let activityIdx = p.idx, priority = 1;
  let breakVolume: number | null = null, retestVolume: number | null = null, retestDepth: number | null = null;
  const pathLines: string[] = [];
  const side = (dir: number): MwBias => dir > 0 ? 'long' : 'short';

  if (line) {
    activityIdx = Math.max(activityIdx, line.lastEventIdx);
    const up = line.dir > 0, atLine = line.kind === 'neck' ? '颈线' : (top ? '阻力' : '支撑');
    const back = up ? '回踩' : '反抽';
    breakVolume = line.acceptedAt >= 0 ? volumeRatio(ctx, line.acceptedAt) : null;
    const rIdx = line.retestConfirmedAt >= 0 ? line.retestConfirmedAt : line.reachedIdx;
    if (rIdx >= 0 && line.acceptedAt >= 0) {
      retestVolume = cs[line.acceptedAt].v > 0 ? cs[rIdx].v / cs[line.acceptedAt].v : null;
      let extreme = line.price;
      for (let i = line.acceptedAt; i <= line.reachedIdx; i++) extreme = up ? Math.max(extreme, cs[i].h) : Math.min(extreme, cs[i].l);
      // 回撤深度按回踩区间的真实价格极值（影线）度量，避免长影线被收盘价掩盖
      let pullExt = up ? cs[line.reachedIdx].l : cs[line.reachedIdx].h;
      for (let i = line.reachedIdx; i <= rIdx; i++) pullExt = up ? Math.min(pullExt, cs[i].l) : Math.max(pullExt, cs[i].h);
      const span = Math.max(Math.abs(extreme - line.price), 1.5 * Math.max(atr[line.acceptedAt] || a, 1e-9));
      retestDepth = Math.max(0, Math.min(1, line.dir * (extreme - pullExt) / span));
    }
    if (line.kind === 'level' && invalidated) pathLines.push(`原${name}方向已被关键位突破否定；此处跟踪${up ? '向上' : '向下'}突破的${back}，不是原形态继续成立。`);
    if (line.acceptedAt >= 0) {
      pathLines.push(`${time(cs[line.acceptedAt].ts + barMs)} 两根连续收盘${up ? '上破' : '下破'}${atLine} ${price(line.price)}；确认K量比 ${ratio(breakVolume)}。`);
      pathLines.push(line.flowComplete && line.flowRatio !== null
        ? `两根确认K合计真实 Δ ${pct(line.flowRatio)}（按真实买卖总额计算），${line.flowAligned ? '与突破同向' : '未同向'}；不是订单簿 OFI。`
        : '两根确认K成交覆盖不全：只确认价格突破，不声称成交同向。');
    }
    if (line.state === 'pending') {
      phase = 'break-pending'; label = `${up ? '上破' : '下破'}待第二根`; priority = 3;
      pathLines.push(`${time(cs[line.firstBreak].ts + barMs)} 仅一根收盘越过${atLine}；等待第二根，盘中越位不算确认。`);
    } else if (line.state === 'expired') {
      phase = 'expired'; label = '观察窗结束'; priority = -1;
      pathLines.push('该突破已超过观察窗；保留历史证据，不延伸旧区带，不把一直在位外当成新突破。');
    } else if (line.state === 'failed') {
      phase = line.kind === 'level' ? 'sweep-level' : 'break-failed';
      label = line.kind === 'level' ? (trap?.label ?? '关键位收回') : (up ? '上破失败·卖向候选' : '下破失败·买向候选');
      bias = side(-line.dir); priority = last - line.failedAt <= RECLAIM_WINDOW ? 3 : -1;
      pathLines.push(`${time(cs[line.failedAt].ts + barMs)} 收盘重回${atLine}${up ? '下' : '上'}方，原突破已失败；反向仅为候选。`);
    } else {
      const strong = (breakVolume ?? 0) >= MW_VOLUME.breakout;
      const supported = strong || ((breakVolume ?? 0) >= MW_VOLUME.weakBreak && line.flowAligned);
      if (!supported) {
        phase = 'break-weak'; label = (breakVolume ?? 0) < MW_VOLUME.weakBreak ? `${up ? '缩量上破' : '缩量下破'}·观望` : '突破证据不足'; priority = 2;
      } else if (line.reachedIdx < 0) {
        phase = 'break-wait'; label = `${strong ? '放量破位' : '破位'}·等${back}`; bias = side(line.dir); priority = 4;
      } else {
        const held = ['retest', 'continued'].includes(line.state) && line.retestConfirmedAt >= 0;
        const quality = retestDepth !== null && retestDepth <= MW_VOLUME.deepRetest && retestVolume !== null && retestVolume <= MW_VOLUME.contract;
        if (held && quality) {
          phase = 'break-held'; label = up ? '回踩守住·买向' : '反抽受阻·卖向'; bias = side(line.dir); priority = 5;
        } else { phase = 'break-retest'; label = `${back}中·待确认`; priority = 3; }
      }
      if (line.reachedIdx < 0) {
        pathLines.push(`${back}带 ${price(line.lo)}–${price(line.hi)}；已等 ${line.waited}/${RETEST_WINDOW} 根，距带 ${line.distAtr.toFixed(2)} ATR。`);
        pathLines.push('尚未回到区带；不能据此判断一定会回踩，也不能预测到达时间，不追突破。');
      } else {
        pathLines.push(`${time(cs[line.reachedIdx].ts + barMs)} 首次触及${back}带 ${price(line.lo)}–${price(line.hi)}。`);
        pathLines.push(line.retestConfirmedAt < 0 ? '只是触及区带，尚无收盘重新守在突破侧的确认。'
          : `${time(cs[line.retestConfirmedAt].ts + barMs)} 收盘守在突破侧；回撤 ${retestDepth == null ? '无数据' : `${(retestDepth * 100).toFixed(1)}%`}，回踩量 ${ratio(retestVolume)} 突破量。`);
        pathLines.push('回踩质量门槛：回撤 ≤61.8%、量 ≤0.9× 突破确认K；不满足只显示待确认。');
        pathLines.push(observationText('回踩确认K', line.retestConfirmedAt >= 0 ? takerObservation(ctx, flow, line.retestConfirmedAt) : null));
      }
    }
  } else {
    pathLines.push(`颈线 ${price(p.neck)} 尚未形成两根收盘${top ? '下破' : '上破'}；二次测试不是已完成反转。`);
  }

  if (!line || (line.state === 'failed' && line.kind === 'level')) {
    if (trap?.active) {
      phase = 'sweep-level'; label = trap.label; bias = side(rev); priority = 3;
      activityIdx = Math.max(activityIdx, ctx.index.get(trap.barTs) ?? p.idx);
    } else if (!line) {
      if ((e.secondRatio ?? 0) > 1.1 || e.strength.label === '分歧') label = '二测力量分歧';
      else if (e.strength.score >= 1) { bias = side(rev); label = top ? '二测拒绝·卖向候选' : '二测拒绝·买向候选'; }
      else label = '二测证据不足';
      if (last - p.idx > 96) { phase = 'expired'; label = '历史二次测试'; priority = -1; bias = null; }
    }
  }

  const extension = 2 * p.neck - p.level;
  const firstTouch = cs.findIndex((c, i) => i > p.idx && (rev > 0 ? c.h >= p.neck : c.l <= p.neck));
  let extensionIdx = -1;
  if (extension > 0 && neck && neck.acceptedAt >= 0) {
    // A touch in the acceptance candle has unknown intrabar ordering; only subsequent closed bars qualify.
    const end = Math.min(last, neck.failedAt >= 0 ? neck.failedAt - 1 : last, level?.acceptedAt != null && level.acceptedAt > neck.acceptedAt ? level.acceptedAt - 1 : last);
    for (let i = neck.acceptedAt + 1; i <= end; i++) {
      if (rev > 0 ? cs[i].h >= extension : cs[i].l <= extension) { extensionIdx = i; break; }
    }
  }
  if (extensionIdx >= 0 && !invalidated && !(neck?.state === 'failed' && neck.failedAt > extensionIdx) && phase !== 'expired') {
    phase = 'target-reached'; label = '延伸位已到·不追'; priority = 0; bias = null;
    activityIdx = Math.max(activityIdx, extensionIdx);
  }
  const endActivity = cs[activityIdx].ts + barMs;
  const active = priority >= 0 && last - activityIdx <= 96;
  const targets = { first: p.neck, extension: extension > 0 ? extension : null,
    firstTouchAt: firstTouch >= 0 ? cs[firstTouch].ts + barMs : null,
    extensionTouchAt: extensionIdx >= 0 ? cs[extensionIdx].ts + barMs : null, suspended: invalidated };
  const focus = line?.price ?? p.level;
  const distanceAtr = Math.abs(cs[last].c - focus) / aNow;
  const testCount = new Set([cs[anchorFirst].ts, ...members.map(m => cs[m.second].ts)]).size;
  const timeline: StoryMoment[] = [
    ...[...new Map(members.map(m => [cs[m.idx].ts, m])).values()].map((m, k) => ({ id: `${id}:confirm:${cs[m.idx].ts}`, at: cs[m.idx].ts + barMs, barTs: cs[m.idx].ts, label: `${name}第${k + 2}次已识别测试收盘确认` })),
    ...validReads.flatMap(r => r.events.map(v => ({ id: `${id}:${r.kind}:${v.kind}:${v.idx}`, at: v.at, barTs: cs[v.idx].ts,
      label: `${r.kind === 'neck' ? '颈线' : '关键位'} · ${{ crossing: '首根越位', accepted: '两根收盘破位', touch: '首次触带', held: '收盘守在突破侧', continued: '离带延续', failed: '收盘收回，突破失败', expired: '观察窗结束' }[v.kind]}` }))),
  ];
  if (extensionIdx >= 0) timeline.push({ id: `${id}:target`, at: cs[extensionIdx].ts + barMs, barTs: cs[extensionIdx].ts, label: '延伸参考位触达（不等于已盈利）' });
  timeline.sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
  let preview: string | null = null;
  if (livePrice != null && Number.isFinite(livePrice)) {
    const nearNeck = line ? line.kind === 'neck' : rev * (livePrice - p.neck) > 0 || Math.abs(livePrice - p.neck) < Math.abs(livePrice - p.level);
    const atLine = nearNeck ? '颈线' : '关键位';
    const reference = line?.price ?? (nearNeck ? p.neck : p.level);
    const tol = line ? (line.hi - line.lo) / 2 : annotationTolerance(reference, aNow);
    const status = Math.abs(livePrice - reference) <= tol ? '已触及观察带' : `在位${livePrice > reference ? '上' : '下'}方`;
    preview = `盘中 ${price(livePrice)} · ${atLine} ${price(reference)} ${status}，距离 ${(Math.abs(livePrice - reference) / aNow).toFixed(2)} ATR。待收盘，不改变已确认阶段。`;
  }
  const flows = p.second === p.idx ? [observationText('测试/确认K（同一根）', e.test)]
    : [observationText('测试K', e.test), observationText('确认K', e.confirmation)];
  if (e.firstLeg.ratio !== null && e.secondLeg.ratio !== null) {
    const push = top ? 1 : -1, diff = (e.secondLeg.ratio - e.firstLeg.ratio) * push;
    flows.push(`推进腿真实成交：第一腿 Δ ${pct(e.firstLeg.ratio * push)} → 第二腿 Δ ${pct(e.secondLeg.ratio * push)}；第二腿${diff < -0.02 ? '弱于' : diff > 0.02 ? '强于' : '接近'}第一腿，相差 ${(Math.abs(diff) * 100).toFixed(1)} 个百分点。`);
  } else flows.push(`推进腿比较：覆盖不足（第一腿 ${e.firstLeg.covered}/${e.firstLeg.bars} 根、第二腿 ${e.secondLeg.covered}/${e.secondLeg.bars} 根），不拼接近似成交。`);
  flows.push(e.cvdRatio === null ? 'CVD：两次测试之间缺少连续真实覆盖，不计算背离。'
    : `连续真实 CVD 变化 / 同期成交额 ${pct(e.cvdRatio)}；${e.cvdDivergence ? '与价格二次测试背离' : '未出现对应方向背离'}。`);
  flows.push('taker 主动成交差不是订单簿 OFI，无法观察具体止损单、持仓身份或被动挂单。');
  const biasLabel = bias === 'long' ? '买向候选' : bias === 'short' ? '卖向候选' : '观望';
  const verdict = label + (bias ? (label.includes(bias === 'long' ? '买向' : '卖向') ? '' : ` · ${biasLabel}`) : (label.includes('观望') ? '' : ' · 观望'));
  const sections: StorySection[] = [
    { id: 'conclusion', title: '当前结论', lines: [verdict, `依据截至 ${time(cs[last].ts + barMs)} 的已收盘K线。形态与成交观察不是校准胜率，也不执行下单。`] },
    { id: 'strength', title: '关键区域力量', lines: [
      `反转证据${e.strength.label}；规则计数 ${e.strength.score}（不是概率），${testCount} 次已识别测试 / ${members.length} 个归并形态。`,
      `第二腿量 ${ratio(e.secondRatio)} 第一腿；测试K ${ratio(e.testVolume)} / 确认K ${ratio(e.confirmVolume)} 过去20根均量。`,
      `拒绝影线 ${(e.wickRatio * 100).toFixed(1)}%；扫位 ${e.sweepAtr.toFixed(2)} ATR；${e.absorbed ? '真实成交放量但价格未跟随（吸收候选）' : '未满足真实吸收观察条件'}。`,
      `支持：${e.strength.positive.join('、') || '不足'}；反证：${e.strength.negative.join('、') || '未见'}；缺失：${e.strength.missing.join('、') || '测试/确认成交齐全'}。`,
    ] },
    { id: 'flow', title: '真实成交证据', lines: [e.stance, ...flows] },
    { id: 'trap', title: '诱多 / 诱空', lines: trap ? [
      `${trap.label} · ${trap.form === 'test-sweep' ? '测试扫位型' : '破位后收回型'} · ${time(trap.at)}`,
      `${trap.active ? '最近12根内，仍在观察' : '已超过12根，只保留历史事实'}；${trap.source === 'real' ? '局部真实成交支持收回方向' : '只有价格收回事实，成交未提供完整同向佐证'}。`,
      '候选不等于观察到追单被套或真实止损；颈线后续事件可以取代它作为当前阶段。',
    ] : ['未出现符合条件的扫位或破位收回；不强行归类为诱多/诱空。'] },
    { id: 'path', title: '突破 → 回踩 / 反抽', lines: pathLines },
    { id: 'targets', title: '参考位与失效', lines: [
      `第一参考位（颈线）${price(p.neck)}${firstTouch >= 0 ? `，${time(targets.firstTouchAt!)} 已触及` : '，尚未触及'}；触及颈线不等于已兑现。`,
      `延伸参考位 ${targets.extension === null ? '无有效正价格' : price(targets.extension)}${targets.extensionTouchAt ? `，${time(targets.extensionTouchAt)} 已触及` : '，尚未确认触达'}；价格触达不是账户利润。`,
      invalidated ? '外侧关键位已破，原形态的方向和目标参考暂停，不把它当成反转信号。'
        : `原形态失效检查：连续两根收盘${top ? '上破阻力' : '下破支撑'} ${price(p.level)}，每根超出 ${BREAK_ATR} ATR；当前对应约 ${price(p.level + (top ? 1 : -1) * BREAK_ATR * aNow)}。`,
    ] },
  ];
  const w = windowFlow(ctx, Math.max(0, p.second - 6), p.idx);
  const smcRead = readSmartMoney(ctx, { side: p.side, idx: p.idx, first: p.first, second: p.second, level: p.level, neck: p.neck }, w, w.known >= 0.95);
  const smc = { hits: smcRead.hits, source: smcRead.source, lines: smcRead.evidence.filter(v => v.state === 'hit').map(v => v.label + '：' + v.detail) };
  const tone: AnnTone = bias === 'long' ? 'long' : bias === 'short' ? 'short' : 'warn';
  const shortDetails = [sections[0].lines[0], `反转证据${e.strength.label} · ${e.stance}`,
    `关键位 ${price(p.level)} / 颈线 ${price(p.neck)}`, pathLines.at(-1) ?? '',
    '完整力量、成交、陷阱与时间线见侧栏「双顶双底」。'];
  const story: MwStory = { phase, phaseLabel: label, bias, active, priority, side: p.side, lineKind: line?.kind ?? null,
    invalidated, level: p.level, neck: p.neck, referenceAtr: a, distanceAtr, patternCount: members.length, testCount,
    origin: { firstTs: cs[p.first].ts, secondTs: cs[p.second].ts, confirmedAt: cs[p.idx].ts + barMs, level: p.level, neck: p.neck },
    lastActivityAt: endActivity, evidence: e, trap, path: line, breakVolume, retestVolume, retestDepth, targets, sections, timeline, preview, smc };
  const bandAtr = a;
  const tol = Math.max(annotationTolerance(p.level, bandAtr), 0.15 * bandAtr);
  const zlo = line?.lo ?? p.level - tol, zhi = line?.hi ?? p.level + tol;
  const zstart = line ? cs[line.firstBreak].ts : cs[p.second].ts;
  const endTs = phase === 'break-failed' || phase === 'expired' || phase === 'target-reached' ? cs[activityIdx].ts + barMs : cs[last].ts + barMs;
  const confirmed = phase !== 'break-pending' && cs[p.idx].confirm !== 0;
  return { id, type: top ? 'doubleTop' : 'doubleBottom', ts: cs[activityIdx].ts, fromTs: cs[anchorFirst].ts,
    price: p.level, title: `${name} ${price(p.level)} · ${label}`, detail: sections.flatMap(s => [s.title, ...s.lines]),
    source: 'price', confirmed, tone, story,
    event: { id: `${id}:event`, ts: cs[activityIdx].ts, side: (bias ?? side(rev)) === 'long' ? 'below' : 'above', tone,
      text: `${top ? 'M' : 'W'} ${label}`, marker: 'diamond', priority: 96, title: `${name} · ${label}`, detail: shortDetails },
    levels: [
      { id: `${id}:level`, fromTs: cs[anchorFirst].ts, toTs: active ? null : cs[activityIdx].ts, price: p.level,
        tone, name: `${name} · ${label}`, style: 'solid', rank: 'read', priority: 98, label: true, detail: shortDetails },
      { id: `${id}:neck`, fromTs: cs[p.first].ts, toTs: active ? null : cs[activityIdx].ts, price: p.neck,
        tone: 'neck', name: '颈线', style: 'dotted', rank: 'normal', priority: 70, label: false, detail: shortDetails },
    ],
    ...(phase === 'expired' ? {} : { zone: { id: `${id}:zone`, fromTs: zstart, toTs: endTs, lo: zlo, hi: zhi, tone,
      text: `${line?.kind === 'neck' ? '颈线' : '关键位'} · ${label}`, priority: 92, failed: phase === 'break-failed', title: `${name} · ${label}`, detail: shortDetails } }),
    path: { tone: top ? 'short' : 'long', points: [ { ts: cs[p.first].ts, price: p.level },
      { ts: cs[p.neckIdx].ts, price: p.neck }, { ts: cs[p.second].ts, price: p.secondPrice },
      ...(p.idx !== p.second ? [{ ts: cs[p.idx].ts, price: cs[p.idx].c }] : []) ] },
  };
}

export function buildMwStories(input: Omit<MwStoryInput, 'pattern' | 'members'> & { patterns: AnnotationPattern[] }): SignalItem[] {
  return groupMwPatterns(input.patterns, input.ctx).map(members => analyzeMwStory({ ...input, pattern: members[members.length - 1], members }));
}
/** Selection changes presentation only. Historical evidence remains in the sidebar, never silently deleted. */
export function selectMwStories(items: SignalItem[], max = 3): SignalItem[] {
  const ranked = items.filter(i => i.story?.active && i.story.distanceAtr <= 12)
    .sort((a, b) => b.story!.priority - a.story!.priority || b.story!.lastActivityAt - a.story!.lastActivityAt || a.story!.distanceAtr - b.story!.distanceAtr);
  const kept: SignalItem[] = [], directions = new Set<string>();
  for (const item of ranked) {
    const s = item.story!, direction = s.bias ?? 'wait';
    if (directions.has(direction)) continue;
    if (kept.some(k => k.story!.side === s.side && Math.abs(k.story!.level - s.level) <= Math.max(k.story!.referenceAtr, s.referenceAtr))) continue;
    kept.push(item); directions.add(direction);
    if (kept.length >= max) break;
  }
  return kept;
}
