import type { Candle } from '@/lib/types';
import { buildContext, type Ctx } from '@/quant/context';
import type { FlowSnapshot } from '@/quant/flow';
import { findSwingLevels, readBreakout, windowFlow } from '@/quant/orderflow';
import { readSmartMoney } from '@/quant/smartmoney';
import { decimalsFor, type AnnPayload, type AnnTone } from '../annotTypes';
import { annotationTolerance, scanAnnotationPatterns, type AnnotationPattern } from './patterns';
import { analyzeKeyLevelScenario, selectScenarios } from './scenario';
import { emptyCounts, emptySignalPayload, SOURCE_LABELS, type SignalItem, type SignalPreferences, type SignalSource, type SignalType } from './store';

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const money = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}K` : v.toFixed(0);
const priceText = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: decimalsFor(n), maximumFractionDigits: decimalsFor(n) });
const priceAt = (cs: Candle[], i: number) => cs[i];
const positive = (v: number) => Number.isFinite(v) && v > 0;

/** A taker-side buy/sell ratio for ONE fully covered candle; never use the OHLC proxy here. */
function takerRatio(ctx: Ctx, flow: FlowSnapshot | null | undefined, i: number): number | null {
  const bar = flow?.bars.get(ctx.cs[i]?.ts);
  if (!bar || ctx.real[i] !== 1 || !positive(bar.buy + bar.sell)) return null;
  return (bar.buy - bar.sell) / (bar.buy + bar.sell);
}

export interface TakerObservation {
  buy: number;
  sell: number;
  total: number;
  delta: number;
  ratio: number;
  /** Aggregate taker total divided by the candle's quote turnover; >= 0.85 is required for `real`. */
  coverage: number;
  volRatio: number;
}

/** Full raw observation for one candle. Returns null rather than a neutral zero when coverage is incomplete. */
export function takerObservation(ctx: Ctx, flow: FlowSnapshot | null | undefined, i: number): TakerObservation | null {
  const candle = ctx.cs[i];
  const bar = flow?.bars.get(candle?.ts);
  if (!candle || !bar || ctx.real[i] !== 1 || !positive(bar.buy + bar.sell)) return null;
  const total = bar.buy + bar.sell;
  return {
    buy: bar.buy,
    sell: bar.sell,
    total,
    delta: bar.buy - bar.sell,
    ratio: (bar.buy - bar.sell) / total,
    coverage: candle.v > 0 ? total / candle.v : 0,
    volRatio: ctx.volMa[i] > 0 ? candle.v / ctx.volMa[i] : 0,
  };
}

export interface LegFlow {
  from: number;
  to: number;
  bars: number;
  covered: number;
  complete: boolean;
  buy: number;
  sell: number;
  total: number;
  delta: number;
  ratio: number | null;
}

/**
 * Aggregate one price-push leg only when every candle is timestamp-contiguous
 * and fully covered by real taker trades. Partial legs retain their covered
 * count for display, but deliberately expose no ratio.
 */
export function legFlow(ctx: Ctx, flow: FlowSnapshot | null | undefined, from: number, to: number, barMs: number): LegFlow {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(ctx.n - 1, Math.max(from, to));
  let covered = 0;
  let buy = 0;
  let sell = 0;
  let complete = end >= start;
  for (let i = start; i <= end; i++) {
    if (i > start && ctx.cs[i].ts - ctx.cs[i - 1].ts !== barMs) complete = false;
    const obs = takerObservation(ctx, flow, i);
    if (!obs) {
      complete = false;
      continue;
    }
    covered++;
    buy += obs.buy;
    sell += obs.sell;
  }
  const total = buy + sell;
  return {
    from: start,
    to: end,
    bars: Math.max(0, end - start + 1),
    covered,
    complete: complete && covered === Math.max(0, end - start + 1) && total > 0,
    buy,
    sell,
    total,
    delta: buy - sell,
    ratio: complete && covered === Math.max(0, end - start + 1) && total > 0 ? (buy - sell) / total : null,
  };
}

/** Continuous actual taker data is required for any cumulative-volume-delta comparison. */
function realCvdBetween(ctx: Ctx, flow: FlowSnapshot | null | undefined, first: number, second: number, barMs: number): number | null {
  if (first < 0 || second <= first || second >= ctx.n) return null;
  let volume = 0;
  let delta = 0;
  for (let i = first; i <= second; i++) {
    const bar = flow?.bars.get(ctx.cs[i].ts);
    if (ctx.real[i] !== 1 || !bar || !positive(bar.buy + bar.sell)) return null;
    if (i > first) {
      if (ctx.cs[i].ts - ctx.cs[i - 1].ts !== barMs) return null;
      volume += bar.buy + bar.sell;
      delta += bar.buy - bar.sell;
    }
  }
  return volume > 0 ? delta / volume : null;
}

export interface SignalAnalysis { items: SignalItem[]; covered: number; bars: number; lastPrice: number }

/**
 * Causal visual annotations, not an execution strategy. ATR/volume cutoffs below
 * are explicit heuristics and have NOT been calibrated as winning probabilities.
 */
export function analyzeSignals(candles: Candle[], barMs: number, preferences: SignalPreferences, flow?: FlowSnapshot | null, now = Date.now()): SignalAnalysis {
  if (!(barMs > 0) || !Number.isFinite(now)) return { items: [], covered: 0, bars: 0, lastPrice: 0 };
  const valid = candles.filter(c =>
    [c.ts, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.ts <= now && c.v >= 0 &&
    c.o > 0 && c.c > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.l > 0,
  ).sort((a, b) => a.ts - b.ts);
  const chronological = [...new Map(valid.map(c => [c.ts, c])).values()];
  const closed = chronological.filter(c => c.ts + barMs <= now);
  // Crypto trades continuously. A missing historical K line must not be treated
  // as an ordinary one-bar pause when testing swing age, breakouts or CVD.
  let contiguousStart = closed.length ? closed.length - 1 : 0;
  while (contiguousStart > 0 && closed[contiguousStart].ts - closed[contiguousStart - 1].ts === barMs) contiguousStart--;
  const cs = closed.slice(contiguousStart).slice(-Math.max(1200, preferences.lookback + 900));
  const inScope = cs.slice(-preferences.lookback);
  const lastPrice = chronological.at(-1)?.c ?? 0;
  if (cs.length < 30) return { items: [], covered: 0, bars: inScope.length, lastPrice };
  const ctx = buildContext(cs, flow);
  const cutoff = inScope[0]?.ts ?? 0;
  const items: SignalItem[] = [];
  const patterns = scanAnnotationPatterns(ctx);

  for (const pattern of patterns) {
    const { idx, first, second, level, neck } = pattern;
    const c = priceAt(cs, idx);
    if (c.ts < cutoff) continue;
    const top = pattern.side === 'top';
    const type: SignalType = top ? 'doubleTop' : 'doubleBottom';
    const tone: AnnTone = top ? 'short' : 'long';
    const label = top ? '双顶' : '双底';
    const fromTs = priceAt(cs, first).ts;
    const key = `${type}:${fromTs}:${c.ts}`;
    const detail = [
      `首次摆动 ${priceText(level)} · 颈线 ${priceText(neck)}`,
      `二次测试 ${priceText(pattern.secondPrice)} · 收盘确认 ${priceText(c.c)}`,
    ];
    items.push({
      id: key, type, ts: c.ts, fromTs, price: level, title: label, detail, source: 'price', confirmed: true, tone,
      event: { id: `pattern:${key}`, ts: c.ts, side: top ? 'above' : 'below', tone, text: label, marker: 'tri', priority: 80, title: label, detail },
      levels: [
        { id: `pattern:${key}:level`, name: top ? '双顶阻力' : '双底支撑', fromTs, toTs: c.ts, price: level, tone, style: 'solid', rank: 'normal', priority: 56, label: false },
        { id: `pattern:${key}:neck`, name: '颈线', fromTs, toTs: c.ts, price: neck, tone: 'neck', style: 'dotted', rank: 'normal', priority: 52, label: false },
      ],
      path: { tone, points: [
        { ts: fromTs, price: level },
        { ts: priceAt(cs, pattern.neckIdx).ts, price: neck },
        { ts: priceAt(cs, second).ts, price: pattern.secondPrice },
        ...(idx !== second ? [{ ts: c.ts, price: c.c }] : []),
      ] },
    });

    // Independent key-level context: this reports what actually traded at the
    // second test. It deliberately does not require the stronger trap rules.
    const testObs = takerObservation(ctx, flow, second);
    const confirmObs = takerObservation(ctx, flow, idx);
    if (testObs || confirmObs) {
      const dir = top ? -1 : 1;
      const testAligned = testObs ? testObs.ratio * dir : null;
      const confirmAligned = confirmObs ? confirmObs.ratio * dir : null;
      const testCandle = priceAt(cs, second);
      const sweepDepth = (top ? testCandle.h - level : level - testCandle.l) / Math.max(ctx.atr[idx], 1e-9);
      const closedInside = top ? c.c < level : c.c > level;
      let stance = '主动成交接近中性';
      if (testObs && confirmObs) {
        if (testAligned! >= 0.06 && confirmAligned! >= 0.06) stance = '反转侧主动成交占优';
        else if (testAligned! <= -0.12 && (confirmAligned! >= 0.04 || (sweepDepth >= 0.05 && closedInside))) stance = '推进侧成交未能站稳';
        else if (testAligned! <= -0.06 && confirmAligned! <= -0.06) stance = '推进侧主动成交占优';
        else if (Math.abs(testAligned!) >= 0.02 && Math.abs(confirmAligned!) >= 0.02 && Math.sign(testAligned!) !== Math.sign(confirmAligned!)) stance = '测试与确认方向分歧';
      } else {
        stance = testObs ? '仅测试K有真实覆盖' : '仅确认K有真实覆盖';
      }
      const leg1 = legFlow(ctx, flow, pattern.firstLegStart, first, barMs);
      const leg2 = legFlow(ctx, flow, pattern.secondLegStart, second, barMs);
      const push1 = leg1.ratio == null ? null : leg1.ratio * (top ? 1 : -1);
      const push2 = leg2.ratio == null ? null : leg2.ratio * (top ? 1 : -1);
      const legDetail = push1 != null && push2 != null
        ? `推进腿真实成交：第一腿推进侧占比 ${pct(push1)}（${leg1.covered}/${leg1.bars}根）→ 第二腿 ${pct(push2)}（${leg2.covered}/${leg2.bars}根）；第二腿${push2 <= push1 - 0.02 ? '弱于' : push2 >= push1 + 0.02 ? '强于' : '接近'}第一腿，相差 ${(Math.abs(push2 - push1) * 100).toFixed(1)} 个百分点。`
        : `推进腿比较：覆盖不足（第一腿 ${leg1.covered}/${leg1.bars}根、第二腿 ${leg2.covered}/${leg2.bars}根），不拼接近似成交。`;
      const obsLine = (label: string, obs: TakerObservation | null) => obs
        ? `${label}：B ${money(obs.buy)} / S ${money(obs.sell)} USDT · Δ ${pct(obs.ratio)} · 覆盖 ${(obs.coverage * 100).toFixed(0)}% · 量比 ${obs.volRatio.toFixed(2)}×`
        : `${label}：无完整真实逐笔覆盖`;
      const flowDetail = second === idx
        ? [obsLine('测试/确认K（同一根）', testObs ?? confirmObs)]
        : [obsLine('测试K', testObs), obsLine('确认K', confirmObs)];
      const detail = [
        `关键位 ${priceText(level)} · 第二次测试 ${priceText(pattern.secondPrice)} · ${sweepDepth >= 0.05 ? `刺穿 ${sweepDepth.toFixed(2)} ATR` : sweepDepth > 0 ? `轻微越位 ${sweepDepth.toFixed(2)} ATR` : '未刺穿关键位'} · 确认收盘 ${priceText(c.c)}（${closedInside ? '已回到关键位内侧' : '未回到关键位内侧'}）`,
        ...flowDetail,
        legDetail,
        '这是 OKX taker 成交观察，不是订单簿 OFI，也不证明止损单、仓位或被动挂单。',
      ];
      const shownRatio = (confirmObs ?? testObs)!.ratio;
      const decisive = stance === '反转侧主动成交占优' || stance === '推进侧成交未能站稳';
      // 这条标记的价值是「关键位当时谁在出力」，数字已经由成交力度标记展示，
      // 这里避免再重复一个 Δ 标签。
      const text = stance === '反转侧主动成交占优'
        ? (top ? '卖方占优' : '买方占优')
        : stance === '推进侧成交未能站稳'
          ? (top ? '冲不上去' : '跌不下去')
          : '';
      void decisive;
      items.push({
        id: `keyflow:${key}`, type: 'keyLevelFlow', ts: c.ts, fromTs, price: level,
        title: `${label}关键位成交反应 · ${stance}`, detail, source: 'real', confirmed: true, tone: stance === '反转侧主动成交占优' || stance === '推进侧成交未能站稳' ? tone : 'neck',
        event: {
          id: `keyflow:${key}`, ts: c.ts, side: top ? 'above' : 'below', tone: stance === '反转侧主动成交占优' || stance === '推进侧成交未能站稳' ? tone : 'neck',
          text: text,
          marker: 'diamond', priority: 76,
          title: `${label}关键位成交反应 · ${stance}`, detail,
        },
        levels: [{ id: `keyflow:${key}:level`, name: top ? '双顶关键位' : '双底关键位', fromTs, toTs: c.ts, price: level, tone: 'neck', style: 'dotted', rank: 'normal', priority: 54, label: false }],
      });
    }

    // ── 聪明钱结构（SMC/ICT 中可验证、可编码的部分）──
    // 只汇总价格结构事实；成交佐证要求该窗口 ≥95% 的真实逐笔覆盖。
    const smcWindow = windowFlow(ctx, Math.max(0, second - 6), idx);
    const smc = readSmartMoney(
      ctx,
      { side: top ? 'top' : 'bottom', idx, first, second, level, neck },
      smcWindow,
      smcWindow.known >= 0.95,
    );
    const ob = smc.orderBlock;
    const alignedFvg = smc.fvgs.find(z => z.aligned && !z.filled) ?? null;
    const swept = !!smc.liquidity?.swept && !!smc.liquidity.reclaimed;
    const structureShift = !!smc.structure && smc.structure.dir === smc.dir && smc.structure.kind === 'CHOCH';
    const meaningful = swept || structureShift || !!alignedFvg || (!!ob && !ob.mitigated);
    if (smc.hits >= 2 && meaningful) {
      const zone = ob && !ob.mitigated
        ? { id: `smc:${key}:ob`, fromTs: priceAt(cs, ob.from).ts, toTs: c.ts, lo: ob.lo, hi: ob.hi, text: top ? '供应区' : '需求区' }
        : alignedFvg
          ? { id: `smc:${key}:fvg`, fromTs: priceAt(cs, alignedFvg.from).ts, toTs: c.ts, lo: alignedFvg.lo, hi: alignedFvg.hi, text: top ? '空头缺口' : '多头缺口' }
          : null;
      const f2 = (v: number) => priceText(v);
      const short: Record<string, string> = {
        liquiditySweep: smc.liquidity ? `扫流动性 ${f2(smc.liquidity.price)}（${smc.liquidity.touches} 次触及）` : '扫流动性',
        structureShift: smc.structure ? `${smc.structure.kind} ${smc.structure.dir > 0 ? '向上' : '向下'} ${f2(smc.structure.price)}` : '结构转向',
        fvg: alignedFvg ? `缺口 ${f2(alignedFvg.lo)}–${f2(alignedFvg.hi)}` : '同向缺口',
        orderBlock: ob ? `${top ? '供应' : '需求'}区 ${f2(ob.lo)}–${f2(ob.hi)}` : '订单块',
        premiumDiscount: `${smc.range.premium ? '溢价' : '折价'} ${(smc.range.position * 100).toFixed(0)}%`,
        takerConfirm: smc.taker ? `taker Δ ${pct(smc.taker.window.ratio)}` : 'taker',
      };
      const lines = smc.evidence.filter(e => e.state === 'hit').map(e => `✓ ${short[e.key]}`);
      const smcTitle = `${top ? '顶' : '底'} SMC ${smc.hits}/5 · 结构计数，非胜率`;
      const strong = swept || (!!ob && !ob.mitigated);
      items.push({
        id: `smc:${key}`,
        type: 'smartMoney',
        ts: c.ts, fromTs, price: level,
        title: smcTitle,
        detail: lines,
        source: smc.source, confirmed: true, tone: strong ? tone : 'neck',
        event: {
          id: `smc:${key}`, ts: c.ts, side: top ? 'above' : 'below', tone: strong ? tone : 'neck',
          text: `SMC ${smc.hits}/5`, marker: 'diamond', priority: 74,
          title: smcTitle, detail: lines,
        },
        ...(zone
          ? {
              zone: {
                id: zone.id, fromTs: zone.fromTs, toTs: zone.toTs, lo: zone.lo, hi: zone.hi,
                tone: 'zone' as AnnTone, text: zone.text, priority: 66,
                title: `${top ? '顶部' : '底部'}关键位结构区`, detail: lines.slice(0, 3),
              },
            }
          : {}),
      });
    }

    // A price sweep alone cannot establish actual stops or trapped traders.
    const a = ctx.atr[idx];
    const test = priceAt(cs, second);
    const depthAtr = (top ? test.h - level : level - test.l) / Math.max(a, 1e-9);
    if (depthAtr >= 0.05 && (top ? c.c < level : c.c > level)) {
      const testRatio = takerRatio(ctx, flow, second);
      const confirmRatio = takerRatio(ctx, flow, idx);
      const dir = top ? -1 : 1;
      const confirmAligned = confirmRatio !== null && confirmRatio * dir >= -0.02;
      const volRatio = ctx.volMa[second] > 0 ? test.v / ctx.volMa[second] : 0;
      // Two observational cases: reversal-side takers take over, or aggressive
      // breakout-side trades are heavy but fail to hold outside the level.
      const reversal = testRatio !== null && testRatio * dir >= 0.06 && confirmAligned;
      const stalledChase = testRatio !== null && testRatio * dir <= -0.12 && volRatio >= 1.3 &&
        (second === idx || confirmRatio !== null && confirmRatio * dir >= 0.04);
      const real = testRatio !== null && confirmRatio !== null && (reversal || stalledChase);
      // Always retain price-only candidates; the display preference is applied
      // by projectSignals, so toggling it need not rescan historical candles.
      if (real || testRatio === null || confirmRatio === null) {
        const trap: SignalType = top ? 'bullTrap' : 'bearTrap';
        const title = real ? (top ? '诱多候选 · 扫高收回' : '诱空候选 · 扫低收回')
          : (top ? '扫高收回 · 仅价格' : '扫低收回 · 仅价格');
        const source: SignalSource = real ? 'real' : 'approx';
        const evidence = real ? [
          `测试K真实主动差 ${pct(testRatio!)} · 确认K ${pct(confirmRatio!)}`,
          reversal ? '扫位时反转侧主动成交占优。' : '突破侧成交放量但收盘回到关键位内（可能有承接，不能直接观测被动挂单）。',
        ] : ['仅能确认价格刺穿并收回；无完整逐笔成交覆盖，不能判断真实主动交易方向。'];
        const reason = [
          `刺穿关键位 ${depthAtr.toFixed(2)} ATR 后收回`, ...evidence,
          '无法观察具体止损单、仓位或谁被套；不代表真实成交结论或胜率。',
        ];
        items.push({
          id: `${trap}:${key}`, type: trap, ts: c.ts, fromTs, price: level, title, detail: reason,
          source, confirmed: true, tone,
          event: { id: `${trap}:${key}`, ts: c.ts, side: top ? 'above' : 'below', tone,
            text: real ? (top ? '诱多候选' : '诱空候选') : (top ? '扫高收回' : '扫低收回'),
            marker: 'diamond', priority: 88, title, detail: reason },
        });
      }
    }

    const cvdRatio = realCvdBetween(ctx, flow, first, second, barMs);
    // Retest of the price extreme + a genuine taker CVD that did NOT confirm it.
    if (cvdRatio !== null && (top ? -cvdRatio : cvdRatio) >= 0.04) {
      const title = top ? '真实成交 CVD 顶背离' : '真实成交 CVD 底背离';
      const cvdDetail = [
        '从一顶/底到二次测试的每根 K 线均有完整的真实 taker 买卖成交。',
        `两次测试间累计净主动成交 / 总成交额 ${pct(cvdRatio)}`,
        '价格回到前高/前低，累计主动成交没有同步创极值；仅为背离观察，不等于预测胜率。',
      ];
      items.push({ id: `cvd:${key}`, type: 'cvdDivergence', ts: c.ts, fromTs, price: level, title, detail: cvdDetail,
        source: 'real', confirmed: true, tone: 'neck',
        event: { id: `cvd:${key}`, ts: c.ts, side: top ? 'above' : 'below', tone: 'neck', text: 'CVD 背离', marker: 'diamond', priority: 72, title, detail: cvdDetail },
      });
    }
  }

  // Keep one evolving decision-zone read per side near the current market.
  // Historical M/W markers remain immutable; this single item is the live
  // status surface the chart uses for trap/break/retest zones.
  // Every M/W in the last 288 bars is evaluated, so an older double bottom that
  // was just broken (or a double top whose neck just gave way) is not hidden by
  // a newer, quieter pattern. selectScenarios keeps at most 3 distinct prices.
  const scenarioReads = patterns
    .filter(p => p.idx >= Math.max(0, ctx.n - 289))
    .map(pattern => analyzeKeyLevelScenario({ pattern, ctx, flow, barMs }));
  items.push(...selectScenarios(scenarioReads, ctx.n));

  // Structural levels are independent of trade costs and order-flow availability.
  const current = cs.at(-1)!.c;
  const swings = findSwingLevels(ctx, { maxAge: 288 });
  const levels = swings.filter(l => l.breakIdx === null && ctx.n - 1 - l.idx <= 288)
    .sort((a, b) => Math.abs(a.price - current) - Math.abs(b.price - current)).slice(0, 8);
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
  }

  // Trade-imbalance impulses require actual taker data. If the user opts into
  // approximation, the name explicitly describes an OHLC price/volume proxy.
  const forming = preferences.preview ? chronological.find(c => c.ts === cs.at(-1)!.ts + barMs && c.ts + barMs > now) : undefined;
  const deltaCs = forming ? [...cs, forming] : cs;
  const deltaCtx = forming ? buildContext(deltaCs, flow) : ctx;
  const lastImpulse = { real: { index: -4, direction: 0 }, approx: { index: -4, direction: 0 } };
  // Collect first, paint later: every qualifying candle used to get its own
  // label, which turned a normal 5m chart into a wall of tags. The sidebar
  // still lists every event; the canvas shows only the most important few.
  const flowMarks: { item: SignalItem; score: number; idx: number }[] = [];
  for (let i = Math.max(20, deltaCtx.n - preferences.lookback); i < deltaCtx.n; i++) {
    const candle = deltaCtx.cs[i];
    const confirmed = candle.ts + barMs <= now;
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
  const broken = swings.filter(l => l.breakIdx !== null && cs[l.breakIdx].ts >= cutoff).slice(-24);
  for (const lv of broken) {
    const b = lv.breakIdx!;
    const end = Math.min(ctx.n - 1, b + 48);
    for (let q = b + 1; q <= end; q++) {
      const read = readBreakout(ctx, lv, b, q);
      if (read.pullback.failed) break;
      if (!read.pullback.held) continue;
      const up = read.dir > 0;
      const firstFlow = takerRatio(ctx, flow, b);
      const holdFlow = takerRatio(ctx, flow, q);
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
  return { items: [...new Map(items.map(i => [i.id, i])).values()].sort((a, b) => b.ts - a.ts), covered, bars: inScope.length, lastPrice };
}

/** Display-only controls never mutate user drawings or the underlying scanner. */
export function projectSignals(analysis: SignalAnalysis, preferences: SignalPreferences): { payload: AnnPayload; visible: SignalItem[]; counts: ReturnType<typeof emptyCounts> } {
  const eligible = analysis.items.filter(i => (i.source === 'price' || i.source === 'real' || preferences.allowApprox) && (i.confirmed || preferences.preview));
  const counts = emptyCounts();
  for (const item of eligible) counts[item.type]++;
  const visible = preferences.enabled ? eligible.filter(i => preferences.selected[i.type]).slice(0, 160) : [];
  const payload = emptySignalPayload();
  payload.decimals = decimalsFor(analysis.lastPrice);
  for (const item of visible) {
    const approximate = item.source === 'mixed' || item.source === 'approx';
    // paint === false 的高频事件只进侧栏列表，不画到图上，避免标签糊成一片。
    if (item.event && item.paint !== false) payload.events.push({ ...item.event, text: preferences.labels ? `${approximate ? '≈ ' : ''}${item.event.text}` : '' });
    if (item.levels && (item.type === 'keyLevels' || preferences.geometry)) payload.levels.push(...item.levels.map(l => ({ ...l, label: l.label && preferences.labels })));
    if (item.zone) payload.zones.push({ ...item.zone, text: preferences.labels ? `${approximate ? '≈ ' : ''}${item.zone.text}` : '' });
    if (item.path && preferences.geometry) payload.paths!.push({ id: `${item.id}:path`, ...item.path });
  }
  return { payload, visible, counts };
}
