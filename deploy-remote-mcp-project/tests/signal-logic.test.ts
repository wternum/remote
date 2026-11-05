import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, scanDoubles } from '../remote/setup-mcp-project-locally/src/lib/engine';
import type { Candle } from '@/lib/types';
import { analyzeSignals, projectSignals } from '@/vela/signals/analyze';
import { scanAnnotationPatterns } from '@/vela/signals/patterns';
import { buildContext } from '@/quant/context';
import { DEFAULT_PREFERENCES, SIGNAL_TYPES, normalizePreferences } from '@/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';
const NOW=1_800_000_000_000, MS=300_000;
const prefs=normalizePreferences({...DEFAULT_PREFERENCES,selected:Object.fromEntries(SIGNAL_TYPES.map(t=>[t.id,true]))});
const top=annotationCandles(true,90,NOW),bottom=annotationCandles(false,90,NOW);
const topSignal=(cs:Candle[],now=NOW)=>analyzeSignals(cs,MS,prefs,null,now).items.find(x=>x.type==='doubleTop');
assert.ok(topSignal(top));assert.ok(analyzeSignals(bottom,MS,prefs,null,NOW).items.some(x=>x.type==='doubleBottom'));
assert.deepEqual(scanAnnotationPatterns(buildContext(top)).map(p=>p.idx),[70]);
const expensive=top.map(c=>{const at=(p:number)=>100000+(p-100)*20;return {...c,o:at(c.o),h:at(c.h),l:at(c.l),c:at(c.c)};});
assert.equal(scanDoubles(expensive,{...DEFAULT_PARAMS,entryMode:'confirm',trendBlock:50}).signals.filter(s=>s.pattern==='dt_reject').length,0);
assert.ok(topSignal(expensive));
console.log('PASS same causal M/W geometry, unaffected by trade costs');
const untilEvent=top.slice(0,71),eventNow=top[70].ts+MS;
const before=topSignal(untilEvent,eventNow)!;
const future=top.map((c,i)=>i>70?{...c,v:c.v*1000,h:c.h+0.005*(i-70)}:c);
const after=topSignal(future,NOW)!;
assert.deepEqual(after.story!.origin,before.story!.origin);
assert.deepEqual(after.story!.evidence,before.story!.evidence);
assert.deepEqual(after.path,before.path);
assert.ok(!topSignal(untilEvent,eventNow-1));
console.log('PASS origin/evidence/geometry immutable; evolving stage is not confused with a frozen historical event');
const noFlow=analyzeSignals(top,MS,prefs,null,NOW);
const storyOf=(r:ReturnType<typeof analyzeSignals>)=>r.items.find(x=>x.type==='doubleTop')!.story!;
assert.equal(storyOf(noFlow).trap!.source,'price');assert.ok(!storyOf(noFlow).trap!.label.includes('诱多'));
assert.equal(storyOf(noFlow).evidence.cvdRatio,null);
const approximated=projectSignals(noFlow,{...prefs,allowApprox:true});
assert.ok(approximated.visible.filter(i=>i.type==='deltaImpulse').every(i=>i.title.includes('K 线量价')));
assert.equal(storyOf(noFlow).evidence.test,null);
const full=annotationFlow(top), localFlow={...full,bars:new Map([[top[70].ts,full.bars.get(top[70].ts)!]])};
const local=storyOf(analyzeSignals(top,MS,prefs,localFlow,NOW));
assert.equal(local.trap!.source,'real');assert.ok(local.trap!.label.includes('候选'));assert.equal(local.evidence.cvdRatio,null);
const split={...full,bars:new Map([top[40],top[70]].map(c=>[c.ts,full.bars.get(c.ts)!]))};
assert.equal(storyOf(analyzeSignals(top,MS,prefs,split,NOW)).evidence.cvdRatio,null);
const continuous=analyzeSignals(top,MS,prefs,full,NOW);
assert.equal(storyOf(continuous).evidence.cvdDivergence,true);
assert.equal(storyOf(analyzeSignals(top,MS,prefs,annotationFlow(top,.85),NOW)).evidence.cvdDivergence,false);
const mirror=analyzeSignals(bottom,MS,prefs,annotationFlow(bottom,.85),NOW).items.find(x=>x.story)!.story!;
assert.equal(mirror.trap!.kind,'bear');assert.equal(mirror.trap!.source,'real');
console.log('PASS trap observations local; CVD requires continuous real coverage; mirror side is symmetric');
const keyFull=storyOf(continuous);
assert.equal(keyFull.evidence.stance,'反转侧主动成交占优');
assert.ok(keyFull.sections[2].lines.some(x=>x.includes('测试/确认K（同一根）')&&x.includes('覆盖 100.0%')));
assert.ok(keyFull.sections[2].lines.some(x=>x.includes('不是订单簿 OFI')));
for(const [scale,expected] of [[.849,false],[.851,true]] as const){const f=annotationFlow(top);const b=f.bars.get(top[70].ts)!;b.buy*=scale;b.sell*=scale;assert.equal(!!storyOf(analyzeSignals(top,MS,prefs,f,NOW)).evidence.test,expected);}
const neutral=annotationFlow(top);neutral.bars.set(top[70].ts,{ts:top[70].ts,buy:900000,sell:900000,src:'tape',trades:100});
assert.equal(storyOf(analyzeSignals(top,MS,prefs,neutral,NOW)).evidence.stance,'主动成交接近中性');
assert.equal(storyOf(analyzeSignals(top,MS,prefs,annotationFlow(top,.85),NOW)).evidence.stance,'推进侧成交未能站稳');
const pattern=scanAnnotationPatterns(buildContext(top))[0],weakening=annotationFlow(top);
for(const [i,c] of top.entries()){const r=i>=pattern.firstLegStart&&i<=pattern.first? .7 : i>=pattern.secondLegStart&&i<=pattern.second? .3 : -.7;const b=weakening.bars.get(c.ts)!;b.buy=c.v*(1+r)/2;b.sell=c.v*(1-r)/2;}
const weak=storyOf(analyzeSignals(top,MS,prefs,weakening,NOW));
assert.ok(weak.sections[2].lines.some(x=>x.includes('第二腿弱于第一腿，相差 40.0 个百分点')));
assert.ok(local.sections[2].lines.some(x=>x.includes('推进腿比较：覆盖不足')));
const keyBefore=analyzeSignals(untilEvent,MS,prefs,annotationFlow(untilEvent),eventNow).items.find(x=>x.story)!.story!;
const keyAfter=analyzeSignals(future,MS,prefs,annotationFlow(future),NOW).items.find(x=>x.story)!.story!;
assert.deepEqual(keyBefore.evidence,keyAfter.evidence);
console.log('PASS coverage boundary, neutral/contrary flow, precise leg weakening and evidence causality');
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
