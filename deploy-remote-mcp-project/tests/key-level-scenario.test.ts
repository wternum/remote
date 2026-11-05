// Migrated from the competing phase/item generator to the unified storyline.
import assert from 'node:assert/strict';
import { buildContext } from '@/quant/context';
import { analyzeMwStory, selectMwStories } from '@/vela/signals/mwStory';
import { evaluateLine } from '@/vela/signals/scenario';
import { MS, W, M, bar, flat, broken, retested, mirror, flowOf } from './mw-fixtures';
import type { Candle } from '@/lib/types';
const run = (cs: Candle[], p = W) => analyzeMwStory({ pattern: p, ctx: buildContext(cs), barMs: MS });
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`); };
check('二测尚未破颈线，图上与侧栏共用一个阶段', () => {
  const r = run(flat()); assert.equal(r.story!.phase, 'no-break'); assert.match(r.zone!.text, new RegExp(r.story!.phaseLabel));
  assert.equal(r.event!.ts, flat()[60].ts);
});
check('第二腿放量为反证，不给强反转方向', () => {
  const cs = flat(); for (let i = 51; i <= 60; i++) cs[i].v = 4000;
  const r = run(cs); assert.equal(r.story!.phase, 'no-break'); assert.equal(r.story!.bias, null);
  assert.ok(r.story!.evidence.strength.negative.some(x => x.includes('放量')));
});
check('单根颈线越位必须等待第二根', () => {
  const cs = broken(71); const r = run(cs); assert.equal(r.story!.phase, 'break-pending'); assert.equal(r.story!.bias, null);
  assert.equal(r.story!.path!.acceptedAt, -1);
});
check('放量颈线上破等待实际回踩', () => {
  const r = run(broken()); assert.equal(r.story!.phase, 'break-wait'); assert.equal(r.story!.path!.reachedIdx, -1);
  assert.equal(r.story!.targets.extensionTouchAt, null); assert.match(r.zone!.text, /等回踩/);
});
check('0.6×量的价格突破不夸成放量真突破', () => {
  const r = run(broken(78, 70, 600)); assert.equal(r.story!.phase, 'break-weak'); assert.equal(r.story!.bias, null);
  assert.match(r.title, /缩量/);
});
check('1.3×量与完整同向成交，可标一般破位而非放量', () => {
  const cs = broken(78, 70, 1400);
  for (let i = 51; i < 70; i++) cs[i].v = 1000; // Use a genuine 20-bar baseline; do not accidentally create >=1.5x volume.
  const flow = flowOf(cs);
  const r = analyzeMwStory({ pattern: W, ctx: buildContext(cs, flow), flow, barMs: MS });
  assert.ok(r.story!.breakVolume! >= 1.2 && r.story!.breakVolume! < 1.5);
  assert.equal(r.story!.phase, 'break-wait'); assert.ok(!r.title.includes('放量'));
  assert.ok(r.story!.path!.flowAligned);
});
check('回踩收缩守住，双底买向与双顶卖向镜像', () => {
  const a = run(retested()), b = run(mirror(retested()), M);
  assert.equal(a.story!.phase, 'break-held'); assert.equal(b.story!.phase, a.story!.phase);
  assert.equal(a.story!.bias, 'long'); assert.equal(b.story!.bias, 'short');
  assert.equal(a.story!.retestVolume, b.story!.retestVolume); assert.match(b.title, /反抽受阻/);
});
check('放量回踩不确认，即使收盘在突破侧', () => {
  const r = run(retested(78, 4000)); assert.equal(r.story!.phase, 'break-retest'); assert.equal(r.story!.bias, null);
  assert.ok(r.story!.retestVolume! > .9);
});
check('过深回撤不确认', () => {
  const cs = broken(73); cs[71] = bar(71, 109, 113, 108.7, 112, 2500);
  cs[72] = bar(72, 112, 112.1, 108, 108.6, 1000);
  const r = run(cs); assert.ok(r.story!.retestDepth! > .618); assert.equal(r.story!.phase, 'break-retest');
});
check('上破后收回颈线使旧回踩结论失效', () => {
  const cs = retested(75); cs[74] = bar(74, 109, 109.1, 106.5, 106.7);
  const r = run(cs); assert.equal(r.story!.phase, 'break-failed'); assert.equal(r.story!.path!.failedAt, 74);
  assert.equal(r.event!.ts, cs[74].ts); assert.equal(r.zone!.toTs, cs[74].ts + MS);
});
check('支撑失守后反抽只触带，不能冒称反抽受阻', () => {
  const cs = flat(73); cs[70] = bar(70, 101.2, 101.3, 98.4, 98.7, 2500); cs[71] = bar(71, 98.7, 99, 98.1, 98.5, 2500);
  cs[72] = bar(72, 98.5, 100.2, 98.4, 100.05, 900);
  const r = run(cs); assert.equal(r.story!.invalidated, true); assert.equal(r.story!.path!.state, 'touch');
  assert.notEqual(r.story!.phase, 'break-held'); assert.ok(!r.title.includes('反抽受阻'));
});
check('假跌破与假突破方向说明正确，无数据只说价格事实', () => {
  const cs = flat(76); cs[70] = bar(70, 101, 101.1, 98.2, 98.7, 2500); cs[71] = bar(71, 98.7, 99, 98, 98.4, 2500);
  cs[72] = bar(72, 98.4, 101.3, 98.3, 101.1);
  for (let i=73; i<76; i++) cs[i]=bar(i,101.1,101.3,100.9,101.1);
  const r=run(cs), m=run(mirror(cs),M);
  assert.equal(r.story!.phase,'sweep-level'); assert.equal(r.story!.trap!.source,'price'); assert.match(r.title,/假跌破/);
  assert.match(m.title,/假突破/); assert.equal(r.story!.bias,'long'); assert.equal(m.story!.bias,'short');
  assert.ok(r.detail.some(x=>x.includes('不等于观察到追单被套')));
});
check('48根没回踩过期，持续在位外不会伪造新的破位时间',()=>{
  const cs=broken(140); const r=evaluateLine(buildContext(cs),MS,108,1,60,'neck')!;
  assert.equal(r.state,'expired'); assert.equal(r.acceptedAt,71); assert.equal(r.expiredAt,119);
  assert.equal(r.events.filter(e=>e.kind==='accepted').length,1);
  assert.equal(selectMwStories([run(cs)]).length,0);
});
check('价位重合/同方向不堆积，历史仍可查询',()=>{
  const a=run(flat()), b={...a,id:'alternative',story:{...a.story!,level:a.price+0.1}};
  assert.ok(selectMwStories([a,b]).length<=1);
  const old=run(flat(200));assert.equal(old.story!.phase,'expired');assert.equal(old.zone,undefined);
  assert.equal(old.story!.sections.length,6);
});
console.log(`key-level-scenario: ${passed} groups passed`);
