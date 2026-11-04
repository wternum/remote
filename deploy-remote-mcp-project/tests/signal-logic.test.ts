import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, scanDoubles } from '../remote/setup-mcp-project-locally/src/lib/engine';
import type { Candle } from '../src/lib/types';
import { analyzeSignals, projectSignals } from '../src/vela/signals/analyze';
import { scanAnnotationPatterns } from '../src/vela/signals/patterns';
import { buildContext } from '../src/quant/context';
import { DEFAULT_PREFERENCES, type SignalPreferences } from '../src/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';

const NOW = 1_800_000_000_000;
const MS = 300_000;
const prefs: SignalPreferences = { ...DEFAULT_PREFERENCES, selected: Object.fromEntries(Object.keys(DEFAULT_PREFERENCES.selected).map(k => [k, true])) as SignalPreferences['selected'] };
const top = annotationCandles(true, 90, NOW);
const bottom = annotationCandles(false, 90, NOW);
const topSignal = (cs: Candle[], now = NOW) => analyzeSignals(cs, MS, prefs, null, now).items.find(x => x.type === 'doubleTop');

const causal = topSignal(top)!;
assert.ok(causal, 'confirmed price-only M structure exists');
assert.ok(analyzeSignals(bottom, MS, prefs, null, NOW).items.some(i => i.type === 'doubleBottom'), 'mirror W structure exists');
assert.deepEqual(scanAnnotationPatterns(buildContext(top)).map(p => p.idx), [70]);
console.log('PASS causal price-only M/W detection at second-test close');

// The old trade scanner rejects if expected round-trip cost is too large vs stop.
// That restriction belongs to execution/backtests, NOT the visual shape detector.
const expensive: Candle[] = top.map(c => {
  const at = (price: number) => 100_000 + (price - 100) * 20;
  return { ...c, o: at(c.o), h: at(c.h), l: at(c.l), c: at(c.c) };
});
const old = scanDoubles(expensive, { ...DEFAULT_PARAMS, entryMode: 'confirm', trendBlock: 50 });
assert.equal(old.signals.filter(s => s.pattern === 'dt_reject').length, 0, 'legacy scanner should reject expensive-to-trade shape');
assert.ok(topSignal(expensive), 'price-only scanner should still annotate the real shape');
console.log('PASS trading economics cannot hide a valid visual pattern');

// No future K line may alter an already-placed marker or its details/path.
const untilEvent = top.slice(0, 71);
const eventNow = top[70].ts + MS;
const before = topSignal(untilEvent, eventNow)!;
assert.ok(before, 'event should exist at the first confirmed close');
const future = top.map((c, i) => i > 70 ? { ...c, v: c.v * 1000, h: c.h + 0.005 * (i - 70) } : c);
const after = topSignal(future, NOW)!;
assert.deepEqual(after, before, 'future K/volume may not change price-event metadata');
assert.ok(!topSignal(untilEvent, eventNow - 1), 'unclosed signal candle cannot produce a confirmed M');
assert.ok(before.path?.points.every(p => p.ts <= before.ts));
console.log('PASS no hindsight, first close is confirmation time');

const noFlow = analyzeSignals(top, MS, prefs, null, NOW);
const hidden = projectSignals(noFlow, prefs);
assert.ok(hidden.visible.every(i => i.source === 'price'), 'default must not claim real taker signals without trades');
const approximated = projectSignals(noFlow, { ...prefs, allowApprox: true });
const priceSweep = approximated.visible.find(i => i.type === 'bullTrap');
assert.ok(priceSweep, 'a price sweep may be optionally shown with explicit provenance');
assert.equal(priceSweep.source, 'approx');
assert.ok(priceSweep.title.includes('仅价格') && !priceSweep.title.includes('诱多'));
// 诱多/诱空明细仍保留在侧栏，但图上由关键位判读统一给出结论，避免同一根 K 线重复标注。
assert.ok(priceSweep.paint === false, 'trap detail stays in the sidebar, not painted twice');
assert.ok(!approximated.payload.events.some(e => e.id.startsWith('bullTrap')), 'no duplicate trap marker on the canvas');
assert.ok(approximated.visible.filter(i => i.type === 'deltaImpulse').every(i => i.title.includes('K 线量价') && !i.title.includes('主动买入') && !i.title.includes('主动卖出')));
assert.ok(!approximated.visible.some(i => i.type === 'cvdDivergence'), 'OHLC approximation must never be presented as real CVD');
console.log('PASS missing taker data remains price-only; optional proxy cannot masquerade as real flow');

const fullFlow = annotationFlow(top);
const localFlow = { ...fullFlow, bars: new Map([[top[70].ts, fullFlow.bars.get(top[70].ts)!]]) };
const local = projectSignals(analyzeSignals(top, MS, prefs, localFlow, NOW), prefs);
const trap = local.visible.find(i => i.type === 'bullTrap');
assert.ok(trap && trap.source === 'real', 'only the event bar has real taker data, but that is sufficient for a local sweep + reclaim');
assert.ok(trap.title.includes('候选') && trap.detail.some(line => line.includes('无法观察具体止损单')));
assert.ok(!local.visible.some(i => i.type === 'cvdDivergence'), 'local flow must not be mistaken for continuous CVD');
const splitFlow = { ...fullFlow, bars: new Map([[top[40].ts, fullFlow.bars.get(top[40].ts)!], [top[70].ts, fullFlow.bars.get(top[70].ts)!]]) };
assert.ok(!analyzeSignals(top, MS, prefs, splitFlow, NOW).items.some(i => i.type === 'cvdDivergence' && i.source === 'real'), 'CVD rejects gaps between tests');
const continuous = analyzeSignals(top, MS, prefs, fullFlow, NOW);
assert.ok(continuous.items.some(i => i.type === 'cvdDivergence' && i.source === 'real'), 'contiguous real taker flow enables CVD');
const opposite = analyzeSignals(top, MS, prefs, annotationFlow(top, 0.85), NOW);
assert.ok(!opposite.items.some(i => i.type === 'cvdDivergence'), 'taker flow confirming the price high is not a divergence');
const mirror = analyzeSignals(bottom, MS, prefs, annotationFlow(bottom, 0.85), NOW);
assert.ok(mirror.items.some(i => i.type === 'bearTrap' && i.source === 'real'), 'mirrored low sweep is symmetric');
console.log('PASS local real sweep evidence works, continuous real CVD rejects missing bars and respects direction');

// ── Key-level taker-flow context (K1/K2/K3) ─────────────────────
const keyOf = (analysis: ReturnType<typeof analyzeSignals> | ReturnType<typeof projectSignals>) =>
  ('items' in analysis ? analysis.items : analysis.visible).find(i => i.type === 'keyLevelFlow');
const keyFull = keyOf(continuous);
assert.ok(keyFull && keyFull.source === 'real', 'second test with real taker coverage gets a key-level flow marker');
assert.ok(keyFull.title.includes('反转侧主动成交占优'), `fixture sell pressure should be reversal-aligned for a top: ${keyFull.title}`);
assert.equal(keyFull.event?.text, '卖方占优', 'key-level label states the side in plain words, numbers live in the hover');
assert.ok(keyFull.detail.some(line => line.includes('测试/确认K（同一根）') && line.includes('覆盖 100%')));
assert.ok(keyFull.detail.some(line => line.includes('推进腿真实成交')), 'fully covered legs should be compared');
assert.ok(keyFull.detail.some(line => line.includes('不是订单簿 OFI')));
assert.ok(!keyOf(noFlow), 'no taker data means no real key-level flow marker');
assert.ok(!keyOf(approximated), 'OHLC approximation must not create a real key-level flow marker');
const keyOff = projectSignals(continuous, { ...prefs, selected: { ...prefs.selected, keyLevelFlow: false } });
assert.ok(!keyOff.visible.some(i => i.type === 'keyLevelFlow') && keyOff.visible.some(i => i.type === 'doubleTop'), 'key-level switch is independent');
console.log('PASS key-level marker reports real test/confirm flow without becoming a probability');

for (const [scale, expected] of [[0.849, false], [0.851, true]] as const) {
  const boundary = annotationFlow(top);
  const bar = boundary.bars.get(top[70].ts)!;
  bar.buy *= scale;
  bar.sell *= scale;
  assert.equal(!!keyOf(analyzeSignals(top, MS, prefs, boundary, NOW)), expected, `aggregate coverage ${(scale * 100).toFixed(1)}% must respect the 85% real-flow boundary`);
}
const neutralFlow = annotationFlow(top);
neutralFlow.bars.set(top[70].ts, { ts: top[70].ts, buy: 900_000, sell: 900_000, src: 'tape', trades: 100 });
const neutralKey = keyOf(analyzeSignals(top, MS, prefs, { ...neutralFlow, bars: new Map([[top[70].ts, neutralFlow.bars.get(top[70].ts)!]]) }, NOW));
assert.ok(neutralKey?.title.includes('主动成交接近中性'), `balanced taker flow must stay neutral: ${neutralKey?.title}`);
const advanceFlow = annotationFlow(top, 0.85);
const advanceKey = keyOf(analyzeSignals(top, MS, prefs, advanceFlow, NOW));
assert.ok(advanceKey?.title.includes('推进侧成交未能站稳'), `buy-dominant flow that sweeps and closes back inside is a failed push, not reversal-side evidence: ${advanceKey?.title}`);
assert.ok(analyzeSignals(top, MS, prefs, advanceFlow, NOW).items.some(i => i.type === 'bullTrap' && i.detail.some(line => line.includes('无法观察具体止损单'))), 'failed-push trap wording must remain a candidate, not a claim about stops');
console.log('PASS key-level coverage boundary, neutral flow and推进侧 flow are not forced into a reversal call');

const pattern = scanAnnotationPatterns(buildContext(top))[0];
const weakening = annotationFlow(top);
for (const [i, candle] of top.entries()) {
  const bar = weakening.bars.get(candle.ts)!;
  const ratio = i >= pattern.firstLegStart && i <= pattern.first ? 0.7 : i >= pattern.secondLegStart && i <= pattern.second ? 0.3 : -0.7;
  bar.buy = candle.v * (1 + ratio) / 2;
  bar.sell = candle.v * (1 - ratio) / 2;
}
const weakKey = keyOf(analyzeSignals(top, MS, prefs, weakening, NOW));
assert.ok(weakKey?.detail.some(line => line.includes('第二腿弱于第一腿，相差 40.0 个百分点')), `leg comparison should quantify normalized推进减弱: ${weakKey?.detail.join(' / ')}`);
const localKey = keyOf(local);
assert.ok(localKey?.detail.some(line => line.includes('推进腿比较：覆盖不足')), 'partial coverage must block leg comparison instead of filling gaps');
const keyBefore = keyOf(analyzeSignals(untilEvent, MS, prefs, annotationFlow(untilEvent), eventNow));
const keyAfter = keyOf(analyzeSignals(future, MS, prefs, annotationFlow(future), NOW));
assert.deepEqual(keyAfter, keyBefore, 'later candles/trades may not rewrite a confirmed key-level observation');
console.log('PASS complete legs quantify推进减弱; partial legs and future data cannot rewrite the marker');

// A nearby OHLC proxy must never suppress a later, same-direction real trade event.
const adjacent = top.map((c, i) => i === 77
  ? { ...c, o: c.c + 0.8, h: c.c + 0.9, l: c.c - 0.1, v: 3_500_000 }
  : c);
const realAt78 = annotationFlow(adjacent);
realAt78.bars = new Map([[adjacent[78].ts, realAt78.bars.get(adjacent[78].ts)!]]);
const adjacentAnalysis = analyzeSignals(adjacent, MS, prefs, realAt78, NOW);
assert.ok(adjacentAnalysis.items.some(i => i.type === 'deltaImpulse' && i.ts === adjacent[77].ts && i.source === 'approx'));
assert.ok(adjacentAnalysis.items.some(i => i.type === 'deltaImpulse' && i.ts === adjacent[78].ts && i.source === 'real'));
assert.ok(projectSignals(adjacentAnalysis, prefs).visible.some(i => i.type === 'deltaImpulse' && i.ts === adjacent[78].ts));
assert.ok(!projectSignals(adjacentAnalysis, prefs).visible.some(i => i.type === 'deltaImpulse' && i.ts === adjacent[77].ts));
console.log('PASS OHLC proxy burst cannot suppress adjacent real taker imbalance');

const gap = top.filter((_, i) => i !== 55);
assert.ok(!topSignal(gap), 'must not connect first test and second test across an absent candle');
console.log('PASS missing historical candle cannot create a double top across a gap');

function breakoutFixture(): Candle[] {
  const candles = annotationCandles(true, 90, NOW);
  let ts = candles.at(-1)!.ts + MS;
  const last = candles.at(-1)!;
  candles.push({ ts, o: last.c, h: 122.1, l: Math.min(last.c, 121.2) - 0.2, c: 121.2, v: 2_000_000 });
  ts += MS;
  candles.push({ ts, o: 121.2, h: 123.1, l: 120.8, c: 122.9, v: 1_400_000 });
  ts += MS;
  candles.push({ ts, o: 122.9, h: 123, l: 120.1, c: 121.8, v: 600_000 }); // closes in upper half, above retest level
  ts += MS;
  candles.push({ ts, o: 121.8, h: 122, l: 118.5, c: 119, v: 900_000 }); // later failure must not backdate confirmation
  return candles;
}
const breakout = breakoutFixture();
const q = breakout[92].ts;
const retestAtClose = analyzeSignals(breakout.slice(0, 93), MS, prefs, null, q + MS);
const priceRetest = retestAtClose.items.find(i => i.type === 'retest');
assert.ok(priceRetest && priceRetest.ts === q && priceRetest.source === 'price', 'retest is a price-structure confirmation, not assumed OFI');
assert.ok(projectSignals(retestAtClose, prefs).visible.some(i => i.type === 'retest'));
const afterFailure = analyzeSignals(breakout, MS, prefs, null, breakout.at(-1)!.ts + MS).items.find(i => i.type === 'retest');
assert.equal(afterFailure?.ts, priceRetest.ts, 'later failure cannot backdate or erase a confirmed historical event');
const realBreakout = annotationFlow(breakout, 0.85);
realBreakout.bars = new Map([90, 92].map(i => [breakout[i].ts, realBreakout.bars.get(breakout[i].ts)!]));
const confirmedFlowRetest = analyzeSignals(breakout.slice(0, 93), MS, prefs, realBreakout, q + MS).items.find(i => i.type === 'retest');
assert.ok(confirmedFlowRetest?.source === 'real' && confirmedFlowRetest.detail.some(line => line.includes('仅这两根')));
console.log('PASS first close price retest is preserved, optionally corroborated by two real taker bars');

console.log('Signal logic regression suite passed.');
