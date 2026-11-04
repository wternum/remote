import assert from 'node:assert/strict';
import { aggregateFlowTrades, hasRealFlow } from '@/quant/flow';
import { analyzeSignals, projectSignals } from '@/vela/signals/analyze';
import { createSignalStore, DEFAULT_PREFERENCES, normalizePreferences, SIGNAL_STORAGE_KEY, SIGNAL_TYPES } from '@/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';

const now = 1_800_000_000_000;
const ms = 300_000;
const prefs = normalizePreferences({ ...DEFAULT_PREFERENCES, selected: Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, true])) });
const top = annotationCandles(true, 90, now);
const bottom = annotationCandles(false, 90, now);
const analysis = analyzeSignals(top, ms, prefs, annotationFlow(top), now);
const inverted = analyzeSignals(bottom, ms, prefs, annotationFlow(bottom, 0.85), now);
assert.ok(analysis.items.some(i => i.type === 'doubleTop'), 'double-top fixture must produce a confirmed price structure');
assert.ok(inverted.items.some(i => i.type === 'doubleBottom'), 'mirrored fixture must produce a confirmed price structure');
assert.ok(analysis.items.some(i => i.type === 'deltaImpulse' && i.source === 'real'));
const call = analysis.items.find(i => i.type === 'keyLevelScenario');
assert.ok(call, 'recent M/W must produce a key-level call');
assert.ok(call.levels?.length === 1 && call.levels[0].label === true, 'the call is a labelled line on the key level');
assert.equal(call.levels[0].price, call.price, 'label sits exactly on the level');
assert.ok(call.levels[0].name.length > 0);
assert.ok(call.detail[0].startsWith('结论：'), 'hover opens with the verdict (trap / pullback / bias)');
console.log('PASS price-only M/W detector, real taker imbalance and labelled key-level verdict');

const projected = projectSignals(analysis, prefs);
assert.ok(projected.payload.events.length > 0);
assert.ok(projected.payload.paths!.length > 0);
const disabledTop = projectSignals(analysis, { ...prefs, selected: { ...prefs.selected, doubleTop: false } });
assert.ok(!disabledTop.visible.some(i => i.type === 'doubleTop'));
assert.ok(disabledTop.visible.some(i => i.type === 'deltaImpulse'));
const off = projectSignals(analysis, { ...prefs, enabled: false });
assert.equal(off.visible.length, 0);
assert.equal(off.payload.events.length + off.payload.levels.length + off.payload.zones.length + off.payload.paths!.length, 0);
const bare = projectSignals(analysis, { ...prefs, labels: false, geometry: false });
assert.equal(bare.payload.paths!.length, 0);
assert.ok(bare.payload.events.every(e => !e.text));
assert.ok(bare.payload.levels.every(l => !l.label));

const painted = projectSignals(analysis, prefs).payload.events.filter(e => e.text);
const paintedKeys = painted.map(e => `${e.ts}|${e.text}`);
assert.equal(new Set(paintedKeys).size, paintedKeys.length, 'same bar + same wording paints only once');
console.log('PASS 同一根 K 线的重复文案只绘制一次');
console.log('PASS individual/master/label/geometry switches truly change layer payloads');

const absent = analyzeSignals(top, ms, prefs, null, now);
assert.ok(projectSignals(absent, prefs).visible.every(i => i.source === 'price'), 'missing flow is never labelled real');
const approx = projectSignals(absent, { ...prefs, allowApprox: true });
assert.ok(approx.visible.some(i => i.source !== 'price'));
assert.ok(approx.payload.events.some(e => e.text.startsWith('≈ ')));
const incomplete = annotationFlow(top); incomplete.bars.forEach(b => { b.buy *= 0.2; b.sell *= 0.2; });
assert.ok(projectSignals(analyzeSignals(top, ms, prefs, incomplete, now), prefs).visible.every(i => i.source === 'price'));
console.log('PASS missing/partial flow cannot masquerade as covered taker data');

const previewTime = top[78].ts + 1000;
const beforeClose = analyzeSignals(top.slice(0, 79), ms, prefs, annotationFlow(top), previewTime);
assert.ok(!beforeClose.items.some(i => i.type === 'deltaImpulse' && i.ts === top[78].ts));
const previewPrefs = { ...prefs, preview: true };
const live = analyzeSignals(top.slice(0, 79), ms, previewPrefs, annotationFlow(top), previewTime);
assert.ok(live.items.some(i => i.type === 'deltaImpulse' && i.ts === top[78].ts && !i.confirmed));
const neutral = annotationFlow(top);
neutral.bars.set(top[78].ts, { ts: top[78].ts, buy: 1_750_000, sell: 1_750_000, src: 'tape' });
assert.ok(!analyzeSignals(top.slice(0, 79), ms, previewPrefs, neutral, previewTime).items.some(i => i.type === 'deltaImpulse' && i.ts === top[78].ts));
console.log('PASS forming-bar previews are opt-in and disappear when the condition reverses');

const atConfirmation = analyzeSignals(top.slice(0, 71), ms, prefs, annotationFlow(top), top[70].ts + ms);
assert.ok(atConfirmation.items.some(i => i.type === 'doubleTop'));
const stableBefore = atConfirmation.items.filter(i => i.type === 'doubleTop').map(i => i.event);
const stableAfter = analysis.items.filter(i => i.type === 'doubleTop').map(i => i.event);
assert.deepEqual(stableAfter, stableBefore);
assert.ok(analysis.items.every(i => i.path?.points.every(p => p.ts <= i.ts) ?? true));
console.log('PASS confirmed structural markers do not borrow future candles');

const memory = new Map<string, string>();
const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
const store = createSignalStore(storage);
store.toggle('doubleTop'); store.allOff();
const reopened = createSignalStore(storage);
assert.equal(reopened.getSnapshot().preferences.enabled, false);
assert.equal(reopened.getSnapshot().preferences.selected.doubleTop, false);
reopened.patch({ enabled: true });
assert.equal(reopened.getSnapshot().preferences.selected.doubleTop, false, 'restoring master keeps individual choices');
reopened.allOn();
assert.ok(Object.values(reopened.getSnapshot().preferences.selected).every(Boolean));
assert.equal(reopened.getSnapshot().preferences.enabled, true);
memory.set(SIGNAL_STORAGE_KEY, '{invalid');
assert.doesNotThrow(() => createSignalStore(storage));
assert.equal(normalizePreferences({ lookback: Infinity, enabled: 'yes' }).lookback, 600);
console.log('PASS preferences persist, all-on works and invalid storage is sanitized');

const flow5 = annotationFlow([]), flow15 = { ...annotationFlow([]), period: '15m', barMs: 900_000 };
const ticks = [{ ts: now + 10, px: 100, sz: 10, side: 'buy' as const, tradeId: 1 }, { ts: now + 20, px: 100, sz: 5, side: 'sell' as const, tradeId: 2 }];
aggregateFlowTrades(flow5, ticks, 0.01);
aggregateFlowTrades(flow15, ticks, 0.01);
for (const flow of [flow5, flow15]) {
  assert.equal(flow.tape.trades, 2);
  const bar = [...flow.bars.values()][0];
  assert.equal(bar.buy, 10); assert.equal(bar.sell, 5);
  aggregateFlowTrades(flow, ticks, 0.01);
  assert.equal(flow.tape.trades, 2, 'REST/WS overlap or socket recreation cannot double count trades');
  assert.ok(hasRealFlow(bar, 15));
  assert.ok(!hasRealFlow(bar, 30));
}
console.log('PASS multiple timeframes each aggregate trades once; replays do not duplicate volume');
console.log('Signal annotation regression suite passed.');
