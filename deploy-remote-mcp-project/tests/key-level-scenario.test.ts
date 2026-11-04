import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { analyzeKeyLevelScenario, selectScenarios } from '../src/vela/signals/scenario';
import type { AnnotationPattern } from '../src/vela/signals/patterns';

const MS = 300_000;
const T0 = 1_700_000_000_000;
let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ ts: T0 + i * MS, o, h, l, c, v });

/** Flat 100 market, W double bottom confirmed at idx 60 (level 100, neck 104). */
function base(len = 72) {
  const cs = Array.from({ length: len }, (_, i) => bar(i, 100, 100.4, 99.6, 100));
  cs[60] = bar(60, 99.8, 100.5, 99.45, 100.2);
  return cs;
}
const W: AnnotationPattern = { side: 'bottom', idx: 60, first: 40, second: 60, neckIdx: 50, firstLegStart: 35, secondLegStart: 50, level: 100, neck: 104, secondPrice: 99.45 };

function flowOf(cs: Candle[], ratio: (i: number) => number): FlowSnapshot {
  const bars = new Map(cs.map((c, i) => [c.ts, { ts: c.ts, buy: c.v * (1 + ratio(i)) / 2, sell: c.v * (1 - ratio(i)) / 2, src: 'rubik' as const }]));
  return { instId: 'SOL-USDT-SWAP', period: '5m', barMs: MS, bars, from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: Infinity, updatedAt: 0, complete: true, tape: { connected: true, trades: 1, bootstrapped: true } };
}
const run = (cs: Candle[], p: AnnotationPattern, flow: FlowSnapshot | null) =>
  analyzeKeyLevelScenario({ pattern: p, ctx: buildContext(cs, flow), flow, barMs: MS });

// 1. 双底扫低收回 + 真实反转 taker → 诱空候选
{
  const cs = base();
  const r = run(cs, W, flowOf(cs, i => (i === 60 ? 0.2 : 0)));
  assert.equal(r.item.zone!.text, '像假跌破');
  assert.equal(r.item.source, 'real');
  assert.equal(r.item.event?.ts, cs[60].ts);
  assert.equal(r.item.event!.text, '有人接', 'double bottom marks who absorbed the test');
  assert.equal(r.rank, 2);
  assert.ok(r.item.detail.length <= 2, 'hover must stay short');
  pass('双底扫低收回 + 真实主动买入 → 诱空候选');
}

// 2. 无逐笔覆盖 → 只说扫低收回，不说诱空
{
  const r = run(base(), W, null);
  assert.equal(r.item.zone!.text, '跌破又收回');
  assert.equal(r.item.source, 'price');
  assert.equal(r.item.event!.text, '没逐笔数据', 'without taker data no side is claimed');
  assert.ok(r.item.detail.some(l => l.includes('不判断是不是假动作')));
  pass('无真实成交 → 仅“扫低收回”，不冒称诱空');
}

// 3. 单根收盘越位 → 待确认
{
  const cs = base();
  cs[71] = bar(71, 100, 100.1, 98.9, 99.0, 1200);
  const r = run(cs, W, null);
  assert.equal(r.item.zone!.text, '刚跌破? 再看一根');
  assert.equal(r.item.source, 'price');
  pass('单根收盘越位不当作真突破');
}

// 4. 两根收盘下破 + 真实卖方主导 → 下破 · 等反抽
function broken(len = 72) {
  const cs = base(len);
  cs[61] = bar(61, 100, 100.1, 98.9, 99.0, 1200);
  cs[62] = bar(62, 99.0, 99.2, 98.7, 98.9, 1200);
  for (let i = 63; i < len; i++) cs[i] = bar(i, 98.9, 99.2, 98.5, 98.8);
  return cs;
}
{
  const cs = broken();
  const r = run(cs, W, flowOf(cs, i => (i === 61 || i === 62 ? -0.2 : 0)));
  assert.equal(r.item.zone!.text, '跌破后等回抽');
  assert.match(r.item.title, /双底 100.00 跌破了 · 卖方更多（20%）/);
  assert.equal(r.item.source, 'real');
  assert.equal(r.item.tone, 'short');
  assert.ok(r.item.detail.some(l => l.includes('已等') && l.includes('最多看')), 'progress reports elapsed bars and the observation window, never an ETA');
  assert.equal(r.item.event?.ts, cs[61].ts, 'the break candle itself carries the effort marker');
  assert.equal(r.item.event?.text, '跌破了');
  assert.equal(r.item.zone!.fromTs, cs[61].ts, 'zone starts at the break, not at the first swing');
  pass('两根收盘下破 + 主动卖出 → “下破 · 等反抽”，区带从破位处开始');
}

// 5. 首次反抽触带并守住 / 收回失效
{
  const cs = broken();
  cs[70] = bar(70, 99.5, 100.2, 99.4, 99.7);
  cs[71] = bar(71, 99.7, 99.9, 99.4, 99.6);
  const held = run(cs, W, null);
  assert.equal(held.item.zone!.text, '回抽到了·站住了');
  const rc = broken();
  rc[70] = bar(70, 99.5, 100.6, 99.4, 100.5);
  rc[71] = bar(71, 100.5, 100.7, 100.1, 100.5);
  const failed = run(rc, W, null);
  assert.equal(failed.item.zone!.text, '回抽又收回');
  assert.equal(failed.item.zone!.failed, true);
  pass('反抽触带守住 / 收回失效 两种结局都能区分');
}

// 6. 双顶颈线跌破（形态完成）也要被标出来 —— 截图里漏掉的情况
{
  const cs = Array.from({ length: 80 }, (_, i) => bar(i, 100, 100.4, 99.6, 100));
  cs[60] = bar(60, 100.2, 100.55, 99.6, 99.8);
  cs[70] = bar(70, 97, 97.1, 95.6, 95.7, 2000);
  cs[71] = bar(71, 95.7, 95.8, 94.6, 94.8, 1800);
  for (let i = 72; i < 80; i++) cs[i] = bar(i, 94.6, 94.8, 94.2, 94.5);
  for (let i = 61; i < 70; i++) cs[i] = bar(i, 99, 99.3, 96.8, 97);
  const M: AnnotationPattern = { side: 'top', idx: 60, first: 40, second: 60, neckIdx: 50, firstLegStart: 35, secondLegStart: 50, level: 100.4, neck: 96, secondPrice: 100.55 };
  const r = run(cs, M, null);
  assert.equal(r.rank, 3);
  assert.equal(r.item.zone!.text, '跌破颈线后等回抽');
  assert.ok(Math.abs(r.price - 96) < 1e-9, 'retest band sits on the neck line');
  pass('双顶跌破颈线 → “颈线跌破 · 等反抽”，反抽区在颈线');
}

// 7. 选择器：旧的、已被下破的 W 不能被新的静态 W 挤掉
{
  const cs = broken(100);
  const oldW = run(cs, W, null);
  const newerCs = cs.slice();
  newerCs[95] = bar(95, 98.6, 98.9, 98.2, 98.7);
  const newW: AnnotationPattern = { ...W, idx: 95, first: 80, second: 95, level: 98.3, neck: 99.5, secondPrice: 98.2 };
  const fresh = run(newerCs, newW, null);
  const picked = selectScenarios([fresh, oldW], 100);
  assert.ok(picked.some(i => i.zone?.text.startsWith('跌破')), 'the broken old W stays visible');
  assert.ok(picked.length <= 3);
  pass('近期已破位的旧形态优先展示，不被新形态覆盖');
}

console.log(`\nkey-level-scenario: ${passed} 组断言全部通过`);
