import type { Candle } from '@/lib/types';
import { isClosedCandle, preferCandle, settledCandles } from '@/lib/okxCandles';
import { buildContext } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { findSwingLevels, readBreakout } from '@/quant/orderflow';
import { decimalsFor, type AnnPayload, type AnnTone } from '../annotTypes';
import { annotationTolerance, scanAnnotationPatterns } from './patterns';
import { buildMwStories, selectMwStories } from './mwStory';
import { money, pct, takerObservation } from './evidence';
import { emptyCounts, emptySignalPayload, type SignalItem, type SignalPreferences, type SignalSource } from './store';
export { takerObservation, legFlow } from './evidence';

const priceText = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: decimalsFor(n), maximumFractionDigits: decimalsFor(n) });
const hhmmOf = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
export interface SignalAnalysis {
  items: SignalItem[];
  covered: number;
  /** 实际纳入分析的已收盘根数（可能被历史缺口截断，小于 requested） */
  bars: number;
  /** 用户请求的回看根数 */
  requested: number;
  /** 内部历史缺口把分析范围截断到最新连续段 */
  gapTruncated: boolean;
  /** 没有内部缺口，但实际可用历史根数仍少于用户请求 */
  historyShort: boolean;
  lastPrice: number;
}

/**
 * Causal visual annotations, not an execution strategy. ATR/volume cutoffs below
 * are explicit heuristics and have NOT been calibrated as winning probabilities.
 */
export function analyzeSignals(candles: Candle[], barMs: number, preferences: SignalPreferences, flow?: FlowSnapshot | null, now = Date.now()): SignalAnalysis {
  if (!(barMs > 0) || !Number.isFinite(now)) return { items: [], covered: 0, bars: 0, requested: preferences.lookback, gapTruncated: false, historyShort: false, lastPrice: 0 };
  const valid = candles.filter(c =>
    [c.ts, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.ts <= now && c.v >= 0 &&
    c.o > 0 && c.c > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.l > 0,
  ).sort((a, b) => a.ts - b.ts);
  const byTs = new Map<number, Candle>();
  for (const c of valid) {
    const old = byTs.get(c.ts);
    byTs.set(c.ts, preferCandle(old, c, old?.v ?? 0, c.v, isClosedCandle(c, barMs, now)));
  }
  const chronological = [...byTs.values()];
  // 与四框架同一口径：中间漏推 confirm=1 的 K 线不能被当成历史缺口截断连续段
  const closed = settledCandles(chronological.filter(c => c.ts < now), barMs, now).candles;
  // Crypto trades continuously. A missing historical K line must not be treated
  // as an ordinary one-bar pause when testing swing age, breakouts or CVD.
  let contiguousStart = closed.length ? closed.length - 1 : 0;
  while (contiguousStart > 0 && closed[contiguousStart].ts - closed[contiguousStart - 1].ts === barMs) contiguousStart--;
  const cs = closed.slice(contiguousStart).slice(-Math.max(1200, preferences.lookback + 900));
  const inScope = cs.slice(-preferences.lookback);
  const newest = chronological.at(-1);
  const lastPrice = newest?.c ?? 0;
  // 形成中 K 线只用于盘中预警；confirm 优先于本机时钟
  const forming = cs.length > 0 && newest && newest.ts === cs[cs.length - 1].ts + barMs && !isClosedCandle(newest, barMs, now)
    ? newest : undefined;
  if (cs.length < 30) {
    const gapTruncated = contiguousStart > 0 && inScope.length < preferences.lookback;
    return {
      items: [], covered: 0, bars: inScope.length, requested: preferences.lookback,
      gapTruncated,
      historyShort: !gapTruncated && inScope.length < preferences.lookback,
      lastPrice,
    };
  }
  const ctx = buildContext(cs, flow);
  const cutoff = inScope[0]?.ts ?? 0;
  const items: SignalItem[] = [];
  const patterns = scanAnnotationPatterns(ctx);

  // One source of truth: one composite record per overlapping M/W structure.
  // Keep old formations if a newer neckline/level event still falls in the requested range.
  const stories = buildMwStories({ patterns, ctx, flow, barMs, livePrice: preferences.preview ? forming?.c : undefined });
  items.push(...stories.filter(i => i.ts >= cutoff || (i.story?.origin.confirmedAt ?? 0) > cutoff));

  // Structural levels are independent of trade costs and order-flow availability.
  const current = cs.at(-1)!.c;
  const swings = findSwingLevels(ctx, { maxAge: 288 });
  // 远离现价的历史摆动不该挤占当前右侧价格轨道；仍只依据已收盘 K 线。
  const levelReach = Math.max(3 * (ctx.atr.at(-1) ?? 0), current * 0.012);
  const levelGap = Math.max(0.6 * (ctx.atr.at(-1) ?? 0), current * 0.002);
  // 同一侧、几乎同一价位的摆动位只保留更极端（支撑取更低、阻力取更高）或更早的锚点，
  // 避免后续在同区形成的较浅回踩把真正的外沿关键位挤掉，再按距现价由近到远选取最多 6 条。
  const levelCandidates = swings
    .filter(l => l.breakIdx === null && ctx.n - 1 - l.idx <= 288 && Math.abs(l.price - current) <= levelReach)
    .sort((a, b) => a.idx - b.idx);
  const dedupedLevels: typeof swings = [];
  for (const lv of levelCandidates) {
    const existingIdx = dedupedLevels.findIndex(k => k.side === lv.side && Math.abs(k.price - lv.price) <= levelGap);
    if (existingIdx >= 0) {
      const ex = dedupedLevels[existingIdx];
      const moreExtreme = lv.side === 'top' ? lv.price > ex.price : lv.price < ex.price;
      if (moreExtreme) dedupedLevels[existingIdx] = lv;
    } else {
      dedupedLevels.push(lv);
    }
  }
  const levels = dedupedLevels
    .sort((a, b) => Math.abs(a.price - current) - Math.abs(b.price - current))
    .slice(0, 6);
  for (const lv of levels) {
    const top = lv.side === 'top';
    const tone = top ? 'top' : 'bottom';
    const id = `level:${lv.side}:${lv.ts}`;
    const title = `${top ? '阻力' : '支撑'} ${priceText(lv.price)}`;
    const tested = patterns.some(p => p.side === lv.side && p.first === lv.idx);
    const detail = ['已确认摆动关键位 · 目前未见收盘突破', tested ? '已发生二次测试' : '等待二次测试'];
    items.push({ id, type: 'keyLevels', ts: lv.ts, fromTs: lv.ts, price: lv.price, title, detail, source: 'price', confirmed: true, tone,
      levels: [{ id, fromTs: lv.ts, toTs: null, price: lv.price, tone, style: 'dashed', name: top ? '阻力' : '支撑', priority: 45, rank: 'normal', label: true, detail }],
    });

    // 关键位成交反应不只挂在 M/W 二次测试上：普通支撑/阻力最近一次被触碰的那根，
    // 若具备完整真实逐笔覆盖，同样给出**单根**成交观察。无覆盖不产出（不伪造方向）。
    const tol = annotationTolerance(lv.price, ctx.atr.at(-1) ?? 0);
    let touchIdx = -1;
    if (tol > 0) {
      for (let q = ctx.n - 1; q > lv.idx; q--) {
        const c = ctx.cs[q];
        if (top ? c.h >= lv.price - tol : c.l <= lv.price + tol) { touchIdx = q; break; }
      }
    }
    const touchObs = touchIdx >= 0 ? takerObservation(ctx, flow, touchIdx) : null;
    if (touchObs) {
      const tc = ctx.cs[touchIdx];
      const ratio = touchObs.ratio;                 // (B−S)/(B+S)，>0 = 主动买占优
      const range = Math.max(tc.h - tc.l, 1e-12);
      const closePos = (tc.c - tc.l) / range;
      const held = top ? tc.c < lv.price : tc.c > lv.price;   // 收盘仍在位的防守一侧
      const stalled = top ? ratio >= 0.12 && closePos <= 0.45 : ratio <= -0.12 && closePos >= 0.55;
      const text = (stalled && held)
        ? (top ? '冲不上去' : '跌不下去')
        : held && (top ? ratio <= -0.06 : ratio >= 0.06)
          ? (top ? '卖方占优' : '买方占优')
          : !held && (top ? ratio >= 0.06 : ratio <= -0.06)
            ? (top ? '买方占优' : '卖方占优')
            : '';
      if (text) {
        const side = top ? '阻力' : '支撑';
        const flowTitle = `${side} ${priceText(lv.price)} 最近触碰成交 · ${text}`;
        const touchDetail = [
          `最近一次触碰 ${priceText(lv.price)}：${hhmmOf(tc.ts)} 那根，收盘 ${priceText(tc.c)}（${held ? `仍在${side}内侧` : `已收在${side}外侧`}）`,
          `该根主动买 ${money(touchObs.buy)} / 主动卖 ${money(touchObs.sell)} USDT；买占 ${Math.round((1 + ratio) * 50)}% / 卖占 ${Math.round((1 - ratio) * 50)}%；${touchObs.src === 'rubik' ? 'OKX 官方统计' : '逐笔聚合'}，覆盖 ${(touchObs.coverage * 100).toFixed(0)}% · 量比 ${touchObs.volRatio.toFixed(2)}×`,
          stalled ? '主动成交很猛但收盘没跟上：力气没换成价格（单根观察）。' : '只反映这一根的主动成交方向与收盘位置。',
          '这是单根 taker 成交观察，不是订单簿 OFI，也不证明止损单、仓位或被动挂单；关键位本身仍是价格结构。',
        ];
        const owner = items.find(i => i.id === id)!;
        owner.detail = [...owner.detail, ...touchDetail];
        owner.levels![0].detail = owner.detail;
        owner.event = { id: `${id}:flow`, ts: tc.ts, side: top ? 'above' : 'below',
          tone: text === '买方占优' || text === '跌不下去' ? 'long' : 'short',
          text, marker: 'diamond', priority: 50, title: flowTitle, detail: touchDetail };

      }
    }
  }

  // Trade-imbalance impulses require actual taker data. If the user opts into
  // approximation, the name explicitly describes an OHLC price/volume proxy.
  const deltaCs = preferences.preview && forming ? [...cs, forming] : cs;
  const deltaCtx = deltaCs === cs ? ctx : buildContext(deltaCs, flow);
  const lastImpulse = { real: { index: -4, direction: 0 }, approx: { index: -4, direction: 0 } };
  // Collect first, paint later: every qualifying candle used to get its own
  // label, which turned a normal 5m chart into a wall of tags. The sidebar
  // still lists every event; the canvas shows only the most important few.
  const flowMarks: { item: SignalItem; score: number; idx: number }[] = [];
  for (let i = Math.max(20, deltaCtx.n - preferences.lookback); i < deltaCtx.n; i++) {
    const candle = deltaCtx.cs[i];
    const confirmed = candle.ts < now && isClosedCandle(candle, barMs, now);
    const real = deltaCtx.real[i] === 1;
    const fb = flow?.bars.get(candle.ts);
    const denominator = real && fb ? fb.buy + fb.sell : candle.v;
    const ratio = denominator > 0 ? deltaCtx.delta[i] / denominator : 0;
    const volRatio = deltaCtx.volMa[i] > 0 ? candle.v / deltaCtx.volMa[i] : 0;
    const range = Math.max(candle.h - candle.l, 1e-12);
    const closePos = (candle.c - candle.l) / range;
    // 努力与结果：放量猛卖却收在高位 = 有人在接；反过来是有人在出。
    const absorption = real && volRatio >= 2 && Math.abs(ratio) >= 0.15 &&
      (ratio < 0 ? closePos >= 0.55 && candle.c >= candle.o : closePos <= 0.45 && candle.c <= candle.o);
    const impulse = (Math.abs(ratio) >= 0.25 && volRatio >= 1.5) || (real && Math.abs(ratio) >= 0.12 && volRatio >= 2.5);
    // 爆量：量极大但买卖接近均衡，说明双方都在大额成交（常见于插针/清算）。
    const climax = real && !absorption && volRatio >= 4 && Math.abs(ratio) < 0.12;
    if (!absorption && !impulse && !climax) continue;
    const direction = Math.sign(ratio);
    const source: 'real' | 'approx' = real ? 'real' : 'approx';
    const previous = lastImpulse[source];
    if (!absorption && !climax && direction === previous.direction && i - previous.index < 3) continue;
    previous.index = i;
    previous.direction = direction;
    const buy = ratio > 0;
    const id = `delta:${candle.ts}`;
    const pv = `${pct(ratio).replace('.0%', '%')} · ${volRatio.toFixed(1)}×`;
    const preview = confirmed ? '' : ' · 预览';
    const tone: AnnTone = climax ? 'warn' : absorption ? (buy ? 'short' : 'long') : buy ? 'long' : 'short';
    // 图上只放一句大白话；具体数字留给悬停。
    const text = climax ? `爆量${preview}` : absorption ? `${buy ? '涨不上去' : '跌不下去'}${preview}` : real ? `${buy ? '买得猛' : '卖得猛'}${preview}` : `${buy ? '偏强' : '偏弱'}${preview}`;
    const title = climax
      ? `成交量突然放大 ${volRatio.toFixed(1)} 倍，买和卖都很多${preview}`
      : absorption
        ? `${buy ? '主动买入' : '主动卖出'}很多，价格却没跟着走${preview}`
        : real
          ? `这一根以${buy ? '主动买入' : '主动卖出'}为主（${pv}）${preview}`
          : `K 线量价偏${buy ? '强' : '弱'}，方向靠收盘位置推测（${pv}）${preview}`;
    const notional = real && fb ? `买 ${money(fb.buy)} / 卖 ${money(fb.sell)} USDT` : '没有逐笔数据，按收盘位置推测，不代表真实买卖方向';
    const detail = [`${notional} · 量是近 20 根的 ${volRatio.toFixed(1)} 倍`];
    if (climax) detail.push('买卖两边都很大，不是单边行情；看下一根能不能收在这根中间位置上方/下方。');
    if (absorption) detail.push(`主动差 ${pct(ratio)}，但收在整根的 ${(closePos * 100).toFixed(0)}% 位置：力气没换成价格。`);
    const score = climax ? 3.2 : absorption ? 2.6 : 1 + Math.min(3, Math.abs(ratio) * 3) + Math.min(1.5, volRatio / 4);
    flowMarks.push({
      idx: i,
      score,
      item: {
        id, type: 'deltaImpulse', ts: candle.ts, fromTs: candle.ts, price: candle.c, title, detail, source, confirmed, tone,
        event: {
          id, ts: candle.ts,
          side: climax ? (candle.c < candle.o ? 'below' : 'above') : absorption ? (buy ? 'above' : 'below') : buy ? 'below' : 'above',
          tone, text, marker: 'diamond', priority: climax ? 72 : absorption ? 70 : confirmed ? 62 : 40, title, detail,
        },
      },
    });
  }
  // 真实逐笔永远优先于 OHLC 近似；同源再按力度排序。
  const ranked = flowMarks
    .map(c => ({ ...c, rank: (c.item.source === 'real' ? 10 : 0) + c.score }))
    .sort((a, b) => b.rank - a.rank);
  const painted: typeof flowMarks = [];
  for (const c of ranked) {
    // 未收盘的预览永远画：那是"正在发生"的一根，不该被密度上限裁掉。
    const preview = c.item.confirmed === false;
    const keep = preview || (painted.length < 4 && !painted.some(p => Math.abs(p.idx - c.idx) < 6));
    if (keep) painted.push(c);
    c.item.paint = keep;
  }
  // 全部保留在 items（侧栏列表完整），只是没被选中的不画到画布。
  items.push(...flowMarks.map(c => c.item));

  // First confirmed price retest. Re-evaluate at each then-known close; never
  // backdate a later hold to an earlier bar. Real flow is optional corroboration,
  // not a prerequisite for a PRICE-STRUCTURE retest annotation.
  const brokenByBarSide = new Map<string, (typeof swings)[number]>();
  for (const l of swings) {
    if (l.breakIdx !== null && cs[l.breakIdx].ts >= cutoff) {
      brokenByBarSide.set(`${l.breakIdx}:${l.side}`, l);
    }
  }
  const broken = [...brokenByBarSide.values()].slice(-24);
  for (const lv of broken) {
    const b = lv.breakIdx!;
    const end = Math.min(ctx.n - 1, b + 48);
    for (let q = b + 1; q <= end; q++) {
      const read = readBreakout(ctx, lv, b, q);
      if (read.pullback.failed) break;
      if (!read.pullback.held) continue;
      const up = read.dir > 0;
      const firstFlow = takerObservation(ctx, flow, b)?.ratio ?? null;
      const holdFlow = takerObservation(ctx, flow, q)?.ratio ?? null;
      const corroborated = firstFlow !== null && holdFlow !== null && firstFlow * read.dir >= 0.08 && holdFlow * read.dir >= -0.12;
      const source: SignalSource = corroborated ? 'real' : 'price';
      const id = `retest:${lv.ts}:${cs[b].ts}`;
      const title = up ? '突破回踩 · 守住支撑' : '跌破反抽 · 阻力有效';
      const detail = [
        '突破后首次收盘守住关键位（价格结构，不是预设盈利目标）。',
        corroborated
          ? `突破K真实主动差 ${pct(firstFlow!)} · 确认K ${pct(holdFlow!)}；仅这两根具备成交佐证，中间不代表连续覆盖。`
          : '无两根完整同向主动成交佐证；此标注仅说明价格回踩，不声称订单流确认。',
      ];
      items.push({ id, type: 'retest', ts: cs[q].ts, fromTs: cs[b].ts, price: lv.price, title, detail, source, confirmed: true, tone: 'zone',
        event: { id, ts: cs[q].ts, side: up ? 'below' : 'above', tone: 'zone', text: up ? '回踩确认' : '反抽确认', marker: 'tri', priority: 70, title, detail },
        zone: { id: `${id}:zone`, fromTs: cs[b].ts, toTs: cs[q].ts + barMs, lo: read.zone.lo, hi: read.zone.hi, tone: 'zone', text: up ? '回踩区' : '反抽区', priority: 70, title, detail },
      });
      break;
    }
  }

  const covered = [...ctx.real].slice(-preferences.lookback).reduce((sum, n) => sum + n, 0);
  return {
    items: [...new Map(items.map(i => [i.id, i])).values()].sort((a, b) => b.ts - a.ts),
    covered,
    bars: inScope.length,
    requested: preferences.lookback,
    // 加密货币连续交易：历史缺口会让分析只覆盖最新连续段。范围变小必须对用户可见，
    // 否则「识别数 0」看起来像检测器坏了，其实是没有那么多连续历史。
    gapTruncated: contiguousStart > 0 && inScope.length < preferences.lookback,
    historyShort: contiguousStart === 0 && inScope.length < preferences.lookback,
    lastPrice,
  };
}

/** Selection is presentation-only: calculations and user drawings remain untouched. */
export function projectSignals(analysis: SignalAnalysis, preferences: SignalPreferences, focusId: string | null = null): { payload: AnnPayload; visible: SignalItem[]; counts: ReturnType<typeof emptyCounts> } {
  const eligible = analysis.items.filter(i => (i.source === 'price' || i.source === 'real' || preferences.allowApprox) && (i.confirmed || preferences.preview));
  const counts = emptyCounts();
  for (const i of eligible) {
    counts[i.type]++;
    if (i.story?.active && i.zone) counts.keyLevelScenario++;
    if (i.story?.smc && i.story.smc.hits >= 2) counts.smartMoney++;
  }
  const visible = preferences.enabled ? eligible.filter(i => preferences.selected[i.type])
    .sort((a, b) => Number(!!b.story) - Number(!!a.story) || b.ts - a.ts).slice(0, 160) : [];
  const payload = emptySignalPayload();
  payload.decimals = decimalsFor(analysis.lastPrice);
  const selected = visible.find(i => i.story && i.id === focusId);
  const rankedStories = selectMwStories(visible.filter(i => i.story));
  // A historical record may be inspected without declaring it active or extending it into the future.
  const paintedStories = selected ? [selected, ...rankedStories.filter(i => i.id !== selected.id &&
    Math.abs(i.price - selected.price) > Math.max(i.story!.referenceAtr, selected.story!.referenceAtr))].slice(0, 3) : rankedStories;
  const storyIds = new Set(paintedStories.map(i => i.id));
  const directions = new Set<string>();
  const byText = new Map<string, NonNullable<SignalItem['event']>>();
  for (const item of visible) {
    if (item.paint === false || (item.story && !storyIds.has(item.id))) continue;
    // Context must not repaint a line already owned by an M/W record.
    if (item.type === 'keyLevels' && paintedStories.some(i =>
      Math.min(Math.abs(i.story!.level - item.price), Math.abs(i.story!.neck - item.price)) <= annotationTolerance(item.price, i.story!.referenceAtr))) continue;
    const approximate = item.source === 'mixed' || item.source === 'approx';
    if (item.event) {
      const event = { ...item.event, text: preferences.labels ? `${approximate ? '≈ ' : ''}${item.event.text}` : '' };
      const key = `${event.ts}|${event.text || event.id}`;
      const prev = byText.get(key);
      if (!prev || event.priority > prev.priority) byText.set(key, event);
    }
    if (item.levels) {
      const levels = item.story ? item.levels.filter(l => preferences.geometry || l.id.endsWith(':level'))
        : item.type === 'keyLevels' || preferences.geometry ? item.levels : [];
      payload.levels.push(...levels.map(l => ({ ...l, ...(item.id === focusId ? { rank: 'focus' as const, priority: 100 } : {}), label: l.label && preferences.labels })));
    }
    if (item.zone && (!item.story || preferences.selected.keyLevelScenario)) {
      const direction = item.story?.bias ?? item.story?.side ?? item.id;
      if (!item.story || (!directions.has(direction) && directions.size < 2)) {
        payload.zones.push({ ...item.zone, text: preferences.labels ? `${approximate ? '≈ ' : ''}${item.zone.text}` : '' });
        if (item.story) directions.add(direction);
      }
    }
    if (item.path && preferences.geometry) payload.paths!.push({ id: `${item.id}:path`, ...item.path });
  }
  payload.events.push(...byText.values());
  return { payload, visible, counts };
}
