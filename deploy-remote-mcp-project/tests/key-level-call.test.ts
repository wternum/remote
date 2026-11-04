import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { analyzeSignals, projectSignals } from '../src/vela/signals/analyze';
import { buildKeyLevelCalls } from '../src/vela/signals/keyLevelCall';
import type { AnnotationPattern } from '../src/vela/signals/patterns';
import { DEFAULT_PREFERENCES, SIGNAL_TYPES, normalizePreferences } from '../src/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';

const MS = 300_000;
const T0 = 1_700_000_000_000;
let n = 0;
const pass = (name: string) => { n++; console.log(`  ✓ ${name}`); };
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * MS, o, h, l, c, v });

/** 双顶：阻力 104，颈线 100；二次测试在 60 根。 */
const M: AnnotationPattern = {
  side: 'top', idx: 60, first: 40, second: 60, neckIdx: 50,
  firstLegStart: 35, secondLegStart: 50, level: 104, neck: 100, secondPrice: 104.5,
};
/** 双底：支撑 96，颈线 100。 */
const W: AnnotationPattern = {
  side: 'bottom', idx: 60, first: 40, second: 60, neckIdx: 50,
  firstLegStart: 35, secondLegStart: 50, level: 96, neck: 100, secondPrice: 95.5,
};
const flat = (len = 76, px = 100) => Array.from({ length: len }, (_, i) => bar(i, px, px + 0.5, px - 0.5, px));
const call = (cs: Candle[], p: AnnotationPattern, flow: FlowSnapshot | null = null) =>
  buildKeyLevelCalls({ patterns: [p], ctx: buildContext(cs, flow), flow, barMs: MS, maxCalls: 3 })[0];
const flowOf = (cs: Candle[], ratio: (i: number) => number): FlowSnapshot => {
  const bars = new Map(cs.map((c, i) => [c.ts, { ts: c.ts, buy: c.v * (1 + ratio(i)) / 2, sell: c.v * (1 - ratio(i)) / 2, src: 'rubik' as const }]));
  return { instId: 'TEST', period: '5m', barMs: MS, bars, from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: Infinity, updatedAt: 0, complete: true, tape: { connected: true, trades: 1, bootstrapped: true } };
};

// 1. 双顶二次测试被拒绝 + 缩量 + 主动卖 → 偏空、回调倾向强
{
  const cs = flat(72);
  cs[40] = bar(40, 103.4, 104.6, 103.2, 104.0);
  cs[55] = bar(55, 100.4, 100.8, 99.6, 100.0);
  cs[60] = bar(60, 104.0, 104.5, 103.6, 103.4);   // 上影拒绝，收盘回到阻力下
  for (let i = 51; i <= 60; i++) cs[i] = { ...cs[i], v: 700 };  // 第二腿缩量
  const r = call(cs, M, flowOf(cs, i => (i === 60 ? -0.3 : 0)));
  assert.equal(r.side, 'top');
  assert.equal(r.bias, 'sell');
  assert.equal(r.pullback, 'strong');
  assert.equal(r.item.event?.text, '看回调');
  assert.equal(r.item.levels?.[0]?.name, '双顶·等回调');
  assert.equal(r.item.levels?.[0]?.price, 104, 'annotation sits exactly on the double-top resistance');
  assert.equal(r.item.levels?.[0]?.label, true);
  assert.ok(r.item.detail[0].startsWith('结论：偏空'));
  assert.ok(r.item.detail.some(l => l.includes('主动卖') || l.includes('主动买')));
  pass('双顶关键位：缩量+拒绝影线+主动卖 → 偏空 / 回调强，标签在 104');
}

// 2. 诱多：上破阻力后收盘收回 → 多头被套，偏空
{
  const cs = flat(72);
  cs[40] = bar(40, 103.4, 104.6, 103.2, 104.0);
  cs[55] = bar(55, 100.4, 100.8, 99.6, 100.0);
  cs[60] = bar(60, 104.0, 104.5, 103.6, 103.4);
  cs[64] = bar(64, 104.0, 105.4, 103.9, 105.1, 2600);  // 上破
  cs[65] = bar(65, 105.1, 105.5, 104.8, 105.2, 2600);  // 第二根确认
  cs[66] = bar(66, 105.2, 105.3, 103.2, 103.3, 2400);  // 收盘跌回阻力下 = 诱多
  for (let i = 67; i < 76; i++) cs[i] = bar(i, 103.3, 103.7, 103.0, 103.2);
  const r = call(cs, M);
  assert.equal(r.trap, 'bull');
  assert.equal(r.bias, 'sell');
  assert.equal(r.item.event?.text, '诱多');
  assert.equal(r.item.levels?.[0]?.name, '诱多·等回调');
  assert.ok(r.item.title.includes('诱多'));
  pass('双顶诱多（上破后收回）→ 明确偏空 / 等回调');
}

// 3. 诱空：跌破支撑后收盘收回 → 空头被套，偏多
{
  const cs = flat(72);
  cs[40] = bar(40, 96.6, 96.8, 95.4, 96.0);
  cs[55] = bar(55, 99.6, 100.4, 99.2, 100.0);
  cs[60] = bar(60, 96.0, 96.4, 95.5, 96.6);   // 下影收回
  for (let i = 51; i <= 60; i++) cs[i] = { ...cs[i], v: 700 };
  cs[64] = bar(64, 96.0, 96.1, 94.6, 94.9, 2600); // 下破
  cs[65] = bar(65, 94.9, 95.2, 94.5, 94.8, 2600);
  cs[66] = bar(66, 94.8, 96.6, 94.7, 96.4, 2400); // 收盘收回支撑上 = 诱空
  for (let i = 67; i < 76; i++) cs[i] = bar(i, 96.4, 96.7, 96.1, 96.5);
  const r = call(cs, W);
  assert.equal(r.trap, 'bear');
  assert.equal(r.bias, 'buy');
  assert.equal(r.item.event?.text, '诱空');
  assert.equal(r.item.levels?.[0]?.name, '诱空·等反弹');
  assert.ok(r.item.title.includes('诱空'));
  pass('双底诱空（跌破后收回）→ 明确偏多 / 等反弹');
}

// 4. 已经反弹走远：不再喊“等反弹”
{
  const cs = flat(90);
  cs[40] = bar(40, 96.6, 96.8, 95.4, 96.0);
  cs[55] = bar(55, 99.6, 100.4, 99.2, 100.0);
  cs[60] = bar(60, 96.0, 96.4, 95.5, 96.6);
  for (let i = 61; i < 90; i++) {
    const px = 96.6 + (i - 61) * 0.04;
    cs[i] = bar(i, px, px + 0.4, px - 0.4, px);
  }
  const calls = buildKeyLevelCalls({ patterns: [W], ctx: buildContext(cs), barMs: MS });
  assert.equal(calls.length, 1, 'the finished move stays visible as a record');
  assert.equal(calls[0].bias, 'wait');
  assert.equal(calls[0].item.event?.text, '已兑现');
  assert.equal(calls[0].item.levels?.[0]?.name, '已反弹·不追');
  assert.ok(calls[0].item.detail[0].includes('不追'));
  pass('反弹已走完 → 标“已兑现·不追”，既不追高也不假装还在等');
}

// 5. 有效突破并站稳：不做原方向
{
  const cs = flat(72);
  cs[40] = bar(40, 103.4, 104.6, 103.2, 104.0);
  cs[55] = bar(55, 100.4, 100.8, 99.6, 100.0);
  cs[60] = bar(60, 104.0, 104.5, 103.6, 103.4);
  cs[64] = bar(64, 104.0, 105.4, 103.9, 105.1, 2600);
  cs[65] = bar(65, 105.1, 105.5, 104.8, 105.2, 2600);
  for (let i = 66; i < 72; i++) cs[i] = bar(i, 105.2, 105.6, 105.0, 105.4);
  const r = call(cs, M);
  assert.equal(r.trap, null);
  assert.equal(r.bias, 'wait');
  assert.equal(r.item.levels?.[0]?.name, '上破·不做空');
  assert.ok(r.item.detail[0].includes('不在这里做空'));
  pass('阻力被有效上破 → 明确“不在这里做空”，不硬给空单');
}

// 6. 同价位重复识别合并：不同价位也限制条数
{
  const cs = flat(80);
  cs[40] = bar(40, 103.4, 104.6, 103.2, 104.0);
  cs[55] = bar(55, 100.4, 100.8, 99.6, 100.0);
  cs[60] = bar(60, 104.0, 104.5, 103.6, 103.4);
  const dup: AnnotationPattern = { ...M, first: 30, idx: 58, second: 58, level: 104.1 };
  const other: AnnotationPattern = { ...M, level: 106, neck: 101 };
  const calls = buildKeyLevelCalls({ patterns: [M, dup, other], ctx: buildContext(cs), barMs: MS, maxCalls: 3 });
  assert.ok(calls.length <= 3);
  const levels = calls.map(c => c.level);
  assert.ok(new Set(levels).size === levels.length);
  pass('同价位形态合并、条数受限，画面不再堆满双顶');
}

// 7. 端到端：关键位标签上图，双顶/双底结构标记只进侧栏
{
  const cs = flat(72);
  cs[40] = bar(40, 103.4, 104.6, 103.2, 104.0);
  cs[55] = bar(55, 100.4, 100.8, 99.6, 100.0);
  cs[60] = bar(60, 104.0, 104.5, 103.6, 103.4);
  for (let i = 51; i <= 60; i++) cs[i] = { ...cs[i], v: 700 };
  const ctx = buildContext(cs);
  const calls = buildKeyLevelCalls({ patterns: [M], ctx, barMs: MS });
  assert.equal(calls.length, 1);
  const prefs = normalizePreferences({ ...DEFAULT_PREFERENCES, selected: Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, true])) });
  // 侧栏里额外的“双顶/双底”结构标记不应重复画到图上
  const structure = {
    id: 'doubleTop:x', type: 'doubleTop' as const, ts: cs[60].ts, fromTs: cs[40].ts, price: 104,
    title: '双顶', detail: ['结构'], source: 'price' as const, confirmed: true, tone: 'short' as const,
    paint: false,
    event: { id: 'dt', ts: cs[60].ts, side: 'above' as const, tone: 'short' as const, text: '双顶', marker: 'tri' as const, priority: 80 },
  };
  const projected = projectSignals({ items: [...calls.map(c => c.item), structure], covered: 60, bars: 60, lastPrice: 100 }, prefs);
  const texts = projected.payload.events.map(e => e.text);
  assert.ok(!texts.includes('双顶'), 'structure marker stays in the sidebar');
  assert.ok(texts.includes('看回调'), 'the verdict is painted at the key level');
  const labels = projected.payload.levels.filter(l => l.label).map(l => `${l.name}@${l.price}`);
  assert.ok(labels.includes('双顶·等回调@104'), `label sits on the key level: ${labels.join(' | ')}`);
  pass('端到端：关键位标签=双顶·等回调@104，双顶结构标记不上图');
}

console.log(`\nkey-level-call: ${n} 组断言全部通过`);
