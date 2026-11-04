import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { analyzeMwPhase, selectScenarios } from '../src/vela/signals/scenario';
import type { AnnotationPattern } from '../src/vela/signals/patterns';

const MS = 300_000;
const T0 = 1_700_000_000_000;
let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * MS, o, h, l, c, v });
const flat = (len = 80, price = 100) =>
  Array.from({ length: len }, (_, i) => bar(i, price, price + 0.4, price - 0.4, price));

/** 平盘 100 上的 W 双底：二次测试 60（低 99.45、收回 100.2），颈线 104。 */
const W: AnnotationPattern = {
  side: 'bottom', idx: 60, first: 40, second: 60, neckIdx: 50,
  firstLegStart: 35, secondLegStart: 50, level: 100, neck: 104, secondPrice: 99.45,
};
const M: AnnotationPattern = {
  side: 'top', idx: 60, first: 40, second: 60, neckIdx: 50,
  firstLegStart: 35, secondLegStart: 50, level: 100, neck: 96, secondPrice: 100.55,
};
const run = (cs: Candle[], p: AnnotationPattern = W, flow: FlowSnapshot | null = null) =>
  analyzeMwPhase({ pattern: p, ctx: buildContext(cs, flow), flow, barMs: MS });

// 1. 没突破：二次测试成立但颈线未破 → 买向候选
{
  const r = run(flat(72));
  assert.equal(r.phase, 'no-break');
  assert.equal(r.bias, 'long');
  assert.equal(r.item.event?.text, '双底·买向候选');
  assert.equal(r.item.zone?.text, '双底·买向候选');
  assert.equal(r.item.event?.ts, flat(72)[60].ts, 'mark belongs to the second-test confirmation bar');
  assert.ok(r.item.detail.some(l => l.includes('颈线') && l.includes('尚未收盘上破')));
  assert.ok(r.item.detail.some(l => l.includes('不是胜率')), 'never claims a calibrated probability');
  assert.equal(r.rank, 1);
  pass('未突破 → 双底二次测试·买向候选（等颈线放量上破）');
}

// 2. 第二腿放量：更像延续，方向撤回
{
  const cs = flat(72);
  for (let i = 51; i <= 60; i++) cs[i] = bar(i, 100, 100.4, 99.6, 100, 2200);
  const r = run(cs);
  assert.equal(r.phase, 'no-break');
  assert.equal(r.bias, null, 'expanding second leg is not a reversal signal');
  assert.equal(r.item.event?.text, '双底候选·放量存疑');
  assert.ok(r.evidence.secondRatio! > 1.4);
  pass('第二腿放量 → 不给买向，标“放量存疑”');
}

// 3. 关键位失守：形态失效，方向随突破（未回抽）
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 100.1, 98.9, 99.2);
  cs[71] = bar(71, 99.2, 99.4, 98.5, 98.8);
  for (let i = 72; i < 80; i++) cs[i] = bar(i, 98.8, 99.0, 98.3, 98.6);
  const r = run(cs);
  assert.equal(r.phase, 'level-broken');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.zone?.text, '等反抽区');
  assert.equal(r.item.event?.text, '支撑失守');
  assert.ok(r.item.detail.some(l => l.includes('结构被否定')));
  pass('没突破形成、支撑先失守 → 形态失效·卖向（等反抽）');
}

// 4. 失守后反抽受阻 → 卖向延续
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 100.1, 98.9, 99.2);
  cs[71] = bar(71, 99.2, 99.4, 98.5, 98.8);
  cs[72] = bar(72, 98.8, 100.1, 98.4, 98.7);
  for (let i = 73; i < 80; i++) cs[i] = bar(i, 98.7, 99.0, 98.2, 98.5);
  const r = run(cs);
  assert.equal(r.phase, 'level-broken');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.event?.text, '反抽受阻');
  assert.equal(r.item.zone?.text, '反抽受阻');
  assert.equal(r.rank, 3);
  pass('关键位失守后反抽受阻 → 明确卖向延续（真突破后的回抽）');
}

// 5. 假跌破：先破位、再收盘收回 → 买向候选
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 100.1, 98.9, 99.2);
  cs[71] = bar(71, 99.2, 99.4, 98.5, 98.8);
  cs[72] = bar(72, 98.8, 101.2, 98.6, 101.0);
  for (let i = 73; i < 80; i++) cs[i] = bar(i, 101, 101.3, 100.7, 101.1);
  const r = run(cs);
  assert.equal(r.phase, 'sweep-level');
  assert.equal(r.bias, 'long');
  assert.equal(r.item.zone?.text, '假跌破·买向候选');
  assert.equal(r.item.event?.text, '假跌破');
  assert.equal(r.item.event?.ts, cs[72].ts);
  pass('假突破（扫低收回）→ 反向买向候选，而不是继续看跌');
}

// 6. 单根越位：不产生方向
{
  const cs = flat(72);
  cs[71] = bar(71, 100, 105.4, 99.9, 105.0);
  const r = run(cs);
  assert.equal(r.phase, 'break-pending');
  assert.equal(r.bias, null);
  assert.equal(r.item.zone?.text, '待第二根收盘');
  pass('只有一根收在颈线外 → 不下买/卖结论');
}

// 7. 放量破颈线但未回踩 → 等回踩，不追
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 2500);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 2500);
  for (let i = 72; i < 80; i++) cs[i] = bar(i, 105.2, 105.5, 104.9, 105.3);
  const r = run(cs);
  assert.equal(r.phase, 'break-wait');
  assert.equal(r.bias, 'long');
  assert.equal(r.item.event?.text, '颈线破');
  assert.equal(r.item.zone?.text, '等回踩区');
  assert.ok(r.evidence.breakRatio! >= 2, `break volume ratio ${r.evidence.breakRatio}`);
  pass('放量真突破、未回踩 → 等回踩区，不追高');
}

// 8. 缩量破位 → 疑假，观望
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 600);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 600);
  for (let i = 72; i < 80; i++) cs[i] = bar(i, 105.2, 105.5, 104.9, 105.3, 600);
  const r = run(cs);
  assert.equal(r.phase, 'break-weak');
  assert.equal(r.bias, null);
  assert.equal(r.item.zone?.text, '缩量上破·观望');
  pass('缩量破颈线 → 疑假突破，明确观望');
}

// 9. 真突破回踩缩量守住 → 买向延续
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 2500);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 2500);
  cs[72] = bar(72, 105.2, 105.3, 104.1, 105.1, 1200);
  for (let i = 73; i < 80; i++) cs[i] = bar(i, 105.1, 105.4, 104.9, 105.2);
  const r = run(cs);
  assert.equal(r.phase, 'break-held');
  assert.equal(r.bias, 'long');
  assert.equal(r.item.event?.text, '回踩守住');
  assert.equal(r.item.zone?.text, '回踩守住');
  assert.equal(r.rank, 4);
  assert.ok(r.evidence.retestVsBreak! < 0.9, 'retest volume contracts');
  assert.ok(r.evidence.retestDepth! < 0.618, 'shallow retracement');
  assert.ok(r.item.detail.some(l => l.includes('收缩，支持守住')));
  pass('真突破 + 回踩缩量守住 → 买向延续（四类中最强）');
}

// 10. 回踩过深 → 不确认
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 2500);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 2500);
  cs[72] = bar(72, 105.2, 105.3, 104.0, 104.2, 1200);
  for (let i = 73; i < 80; i++) cs[i] = bar(i, 104.3, 104.8, 104.0, 104.4, 900);
  const r = run(cs);
  assert.equal(r.phase, 'break-retest');
  assert.equal(r.item.zone?.text, '回踩待确认');
  assert.ok(r.evidence.retestDepth! > 0.618);
  pass('回踩超过 61.8% → 待确认，不升级为买向');
}

// 10b. 回踩量放大 → 不确认（即使价格站住）
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 2500);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 2500);
  cs[72] = bar(72, 105.2, 105.3, 104.1, 105.1, 4000);
  for (let i = 73; i < 80; i++) cs[i] = bar(i, 105.1, 105.4, 104.9, 105.2);
  const r = run(cs);
  assert.equal(r.phase, 'break-retest');
  assert.ok(r.evidence.retestVsBreak! >= 1.2);
  assert.ok(r.item.detail.some(l => l.includes('偏大')));
  pass('回踩放量 → 不升级为买向，只算待确认');
}

// 11. 破位后又收回 → 突破失败，方向反转
{
  const cs = flat(76);
  cs[70] = bar(70, 100, 105.4, 99.9, 105.0, 2500);
  cs[71] = bar(71, 105, 105.6, 104.7, 105.2, 2500);
  cs[72] = bar(72, 105.2, 105.4, 103.4, 103.5, 1200);
  for (let i = 73; i < 76; i++) cs[i] = bar(i, 103.5, 103.8, 103.0, 103.4);
  const r = run(cs);
  assert.equal(r.phase, 'break-failed');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.event?.text, '突破失败');
  assert.equal(r.item.zone?.text, '上破失败·卖向候选');
  pass('上破后收回颈线 → 突破失败·卖向');
}

// 12. 双顶镜像：下破颈线放量 → 卖向，等反抽
{
  const cs = flat(80);
  cs[70] = bar(70, 100, 100.1, 94.6, 95.0, 2500);
  cs[71] = bar(71, 95, 95.3, 94.4, 94.8, 2500);
  for (let i = 72; i < 80; i++) cs[i] = bar(i, 94.8, 95.1, 94.5, 94.7);
  const r = run(cs, M);
  assert.equal(r.phase, 'break-wait');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.zone?.text, '等反抽区');
  pass('双顶下破颈线 → 卖向，等反抽区');
}

// 13. 双顶未破：卖向候选
{
  const r = run(flat(72), M);
  assert.equal(r.phase, 'no-break');
  assert.equal(r.bias, 'short');
  assert.equal(r.item.event?.text, '双顶·卖向候选');
  pass('双顶二次测试未破 → 卖向候选');
}

// 14. 过旧结构不再进入当前画布
{
  const old: AnnotationPattern = { ...W, idx: 8, first: 2, second: 8, neckIdx: 5 };
  const r = run(flat(80), old);
  assert.equal(r.phase, 'expired');
  assert.equal(r.rank, -1);
  assert.equal(r.item.zone, undefined);
  assert.equal(selectScenarios([r], 80).length, 0);
  pass('过旧二次测试退场，不再延伸区带到现价');
}

// 15. 同方向只留一个，方向不同最多两块（不同价位）
{
  const longRead = run(flat(72));
  const topAbove: AnnotationPattern = { ...M, level: 104, neck: 100, secondPrice: 104.5 };
  const shortRead = run(flat(72), topAbove);
  const picked = selectScenarios([longRead, shortRead], 72);
  assert.equal(picked.length, 2);
  assert.deepEqual([...new Set(picked.map(p => p.tone))].sort(), ['long', 'short']);
  const dup = { ...longRead, price: 99.4, tol: 0.1, recency: 71 };
  assert.equal(selectScenarios([longRead, dup], 72).length, 1, 'one zone per direction');
  pass('同方向不堆叠区带，多空各最多一块');
}

// 16. 方向不是收益承诺：详情明确写出“不是胜率”
{
  for (const r of [run(flat(72)), run(flat(72), M)]) {
    assert.ok(r.item.detail.some(l => l.includes('不是胜率') || l.includes('不是校准')));
    assert.equal(r.item.source, 'price');
  }
  pass('方向候选始终附带“不是胜率/建议”的边界说明');
}

console.log(`\nkey-level-scenario: ${passed} 组断言全部通过`);
