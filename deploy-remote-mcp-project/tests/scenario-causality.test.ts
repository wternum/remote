import assert from 'node:assert/strict';
import { buildContext } from '@/quant/context';
import { hasRealFlow } from '@/quant/flow';
import { evaluateLine } from '@/vela/signals/scenario';
import { analyzeMwStory, selectMwStories } from '@/vela/signals/mwStory';
import { quoteVolumeFromRow } from '@/lib/okxVolume';
import { MS, T0, W, bar, broken, retested, flowOf } from './mw-fixtures';

{
 const cs = broken(72), r=analyzeMwStory({pattern:W,ctx:buildContext(cs),barMs:MS});
 assert.equal(r.story!.phase,'break-wait'); assert.equal(r.event!.ts,cs[71].ts);
 assert.ok(r.zone!.toTs<=cs.at(-1)!.ts+MS);
 console.log('PASS two-bar confirmation anchored at second close, no projected future zone');
}
{
 const cs=retested(76);cs[75]=bar(75,109,109.1,106.8,107);
 const read=evaluateLine(buildContext(cs),MS,108,1,60,'neck')!;
 assert.equal(read.state,'failed');assert.equal(read.failedAt,75);
 const r=analyzeMwStory({pattern:W,ctx:buildContext(cs),barMs:MS});
 assert.equal(r.story!.phase,'break-failed'); assert.ok(!r.title.includes('回踩守住'));
 console.log('PASS later reclaim invalidates earlier held retest');
}
{
 const cs=retested(78), flow=flowOf(cs);
 const original=evaluateLine(buildContext(cs.slice(0,74),flow),MS,108,1,60,'neck',flow)!;
 const later=cs.map((c,i)=>i<74?c:{...c,h:c.h+50,v:c.v*20});
 const read=evaluateLine(buildContext(later,flow),MS,108,1,60,'neck',flow)!;
 assert.deepEqual(read.events.filter(e=>e.idx<74),original.events);
 assert.deepEqual([read.lo,read.hi],[original.lo,original.hi]);
 assert.equal(read.flowRatio,original.flowRatio);
 console.log('PASS future volatility never changes historical lifecycle events or fixed band');
}
{
 const cs=broken(80), a=analyzeMwStory({pattern:W,ctx:buildContext(cs),barMs:MS});
 const b=analyzeMwStory({pattern:W,ctx:buildContext(cs),barMs:MS,livePrice:95});
 assert.equal(a.title,b.title);assert.deepEqual(a.story!.targets,b.story!.targets);assert.ok(b.story!.preview?.includes('盘中'));
 const duplicate={...a,id:'dupe'};assert.ok(selectMwStories([a,duplicate]).length<=1);
 console.log('PASS separate live preview and no duplicate direction on canvas');
}
{
 const cs=broken(72), gap=cs.filter((_,i)=>i!==70);
 assert.notEqual(evaluateLine(buildContext(gap),MS,108,1,60,'neck')?.state,'broken');
 console.log('PASS cannot confirm across a missing candle');
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
