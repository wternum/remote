import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import { hasRealFlow, type FlowSnapshot } from '../src/quant/flow';
import { analyzeMwPhase, evaluateLine, selectScenarios } from '../src/vela/signals/scenario';
import type { AnnotationPattern } from '../src/vela/signals/patterns';
import { quoteVolumeFromRow } from '../src/lib/okxVolume';

const MS = 300_000;
const T0 = 1_700_000_000_000;
const candle = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * MS, o, h, l, c, v });
const W: AnnotationPattern = {
  side: 'bottom', idx: 60, first: 40, second: 60, neckIdx: 50,
  firstLegStart: 35, secondLegStart: 50, level: 100, neck: 104, secondPrice: 99.45,
};
function broken(length = 78): Candle[] {
  const cs = Array.from({ length }, (_, i) => candle(i, 100, 100.4, 99.6, 100));
  cs[60] = candle(60, 99.8, 100.5, 99.45, 100.2);
  cs[61] = candle(61, 100, 100.1, 98.9, 99.0, 1200);
  cs[62] = candle(62, 99.0, 99.2, 98.7, 98.9, 1200);
  for (let i = 63; i < length; i++) cs[i] = candle(i, 98.9, 99.2, 98.5, 98.8);
  return cs;
}
const run = (cs: Candle[], livePrice?: number) => analyzeMwPhase({
  pattern: W, ctx: buildContext(cs), barMs: MS, livePrice,
});

{
  const cs = broken(72);
  const r = run(cs);
  assert.match(r.item.title, /支撑失守|失守/);
  assert.equal(r.phase, 'level-broken');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.event?.ts, cs[62].ts, 'two-closed-bar confirmation belongs on the SECOND bar, not the first');
  assert.ok(r.item.zone && r.item.zone.toTs <= cs.at(-1)!.ts + 2 * MS, 'forward zone cannot extend 12 bars into an unknown future');
  console.log('PASS 确认时点与区带前瞻长度');
}

{
  const cs = broken(78);
  cs[70] = candle(70, 99.4, 100.1, 99.3, 99.6);
  cs[71] = candle(71, 99.6, 99.8, 99.2, 99.5);
  cs[72] = candle(72, 99.5, 100.8, 99.4, 100.6);
  for (let i = 73; i < cs.length; i++) cs[i] = candle(i, 100.6, 100.9, 100.3, 100.7);
  const read = evaluateLine(buildContext(cs), MS, 100, -1, 60, 'level');
  assert.equal(read?.state, 'failed', 'a later closed reclaim invalidates an earlier held bearish retest');
  const r = run(cs);
  assert.equal(r.phase, 'sweep-level', 'the failed breakdown becomes a fake-breakout candidate');
  assert.equal(r.bias, 'long');
  assert.equal(r.item.zone?.text, '假跌破·买向候选');
  assert.ok(!r.item.zone?.text.includes('站住了'), 'never keep showing bearish hold after the market has reclaimed');
  assert.ok(!r.item.detail.some(l => l.includes('回抽到了')));
  console.log('PASS 反抽后上涨收回关键位，旧空头标注改为“假跌破·买向候选”');
}

{
  const cs = broken(74);
  cs[70] = candle(70, 99.4, 100.1, 99.3, 99.6);
  cs[71] = candle(71, 99.6, 99.9, 99.3, 99.5);
  cs[72] = candle(72, 99.4, 99.5, 98.0, 98.2);
  cs[73] = candle(73, 98.2, 98.6, 97.9, 98.1);
  const r = run(cs);
  assert.equal(r.phase, 'level-broken');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.zone?.text, '反抽受阻', 'after the retest the state is a rejected pullback, not an ongoing pullback');
  assert.ok(r.item.zone && r.item.zone.toTs <= cs[71].ts + MS, 'completed test zone ends at the test, not far into the future');
  console.log('PASS 反抽受阻后继续下跌，状态更新为卖向延续');
}

{
  const cs = broken(76);
  cs[70] = candle(70, 98.8, 101.1, 98.8, 100.8);
  cs[71] = candle(71, 100.8, 101.3, 100.5, 101.1);
  cs[72] = candle(72, 101.1, 101.5, 100.7, 101.2);
  cs[73] = candle(73, 101.2, 101.5, 100.9, 101.3);
  cs[74] = candle(74, 101.3, 101.6, 101.0, 101.4);
  cs[75] = candle(75, 101.4, 101.7, 101.1, 101.5);
  const r = run(cs);
  assert.equal(r.phase, 'sweep-level');
  assert.ok(!selectScenarios([r], cs.length).some(i => i.zone?.text.includes('回抽到了')), 'a reclaimed bearish setup must not be an active zone');
  console.log('PASS 截图场景：明显反弹后不保留陈旧的反抽区，改标假跌破');
}

{
  const cs = broken(80);
  const r = run(cs, 101.2);
  assert.match(r.item.title + (r.item.zone?.text ?? '') + r.item.detail.join(''), /盘中/, 'forming candle may warn, not confirm a reversal');
  assert.equal(r.phase, 'level-broken', 'intrabar price never rewrites the closed-bar state');
  assert.equal(r.item.confirmed, true);
  console.log('PASS 未收盘价格上冲时给盘中提示，不抢先修改已确认状态');
}

{
  const cs = broken(90);
  const a = run(cs);
  const b = { ...a, price: 98, tol: 0.1, recency: a.recency + 1, item: { ...a.item, id: 'other', price: 98, zone: { ...a.item.zone!, id: 'other-zone', lo: 97.9, hi: 98.1 } } };
  const picked = selectScenarios([a, b], cs.length);
  assert.ok(picked.length <= 1, 'same bearish direction must not fill the screen with three zones');
  console.log('PASS 同方向不同价位只显示一个当前剧本');
}

{
  // 2026-11-04 05:05 UTC, OKX SOL 5m: volume 2,746,202.4192 USDT;
  // official sell 1,291,105.3073 + buy 1,240,168.1636 = 92.17% (not final).
  const partial = { ts: T0, buy: 1_240_168.1636, sell: 1_291_105.3073, src: 'rubik' as const };
  assert.equal(hasRealFlow(partial, 2_746_202.4192), false, 'recent partial rubik is not a full covered taker candle');
  assert.equal(hasRealFlow({ ...partial, buy: 1_455_097.1119 }, 2_746_202.4192), true);
  assert.equal(hasRealFlow({ ...partial, buy: 2_500_000 }, 2_746_202.4192), false, 'gross > candle volume is a unit/duplicate mismatch');
  assert.equal(hasRealFlow({ ...partial, src: 'tape', buy: 2_500_000 }, 2_746_202.4192), false);
  console.log('PASS 实测 rubik 残缺与过量数据不可冒充完整成交');
}

{
  const row = ['1700000000000', '100000', '100001', '99999', '100000', '100', '', ''];
  assert.equal(quoteVolumeFromRow(row, 'BTC-USDT-SWAP'), 100_000, '100 contracts × 0.01 BTC × 100k USDT');
  assert.equal(quoteVolumeFromRow([...row.slice(0, 6), '1', ''], 'BTC-USDT-SWAP'), 100_000);
  assert.equal(quoteVolumeFromRow([...row.slice(0, 7), '120000'], 'BTC-USDT-SWAP'), 120_000);
  console.log('PASS K线报价币成交额回退按合约面值换算');
}

console.log('scenario-causality: all assertions passed');
