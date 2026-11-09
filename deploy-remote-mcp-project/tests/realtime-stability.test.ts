// 实时链路的稳定性回归：
//  1) 未勾选「未收盘 Δ 预览」时，已确认标注不得随实时价改写或消失（口径：默认只用已收盘 K 线）
//  2) 重算键在预览关闭时不得包含未收盘价（否则每个 tick 都触发全量重算）
//  3) 支撑/阻力最近一次触碰若有真实逐笔覆盖，应给出成交观察；无覆盖不得伪造
//  4) 历史缺口截断分析范围时必须可观测（requested / gapTruncated）
// 运行：node scripts/run-ts-test.mjs tests/realtime-stability.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { analyzeSignals } from '@/vela/signals/analyze';
import { signalRecomputeKey, flowRecomputeKey } from '@/vela/signals/recompute';
import { DEFAULT_PREFERENCES, SIGNAL_TYPES, normalizePreferences, type SignalPreferences } from '@/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';

const ms = 300_000;
let n = 0;
const pass = (name: string) => { n++; console.log(`  ✓ ${name}`); };
const allOn: SignalPreferences = normalizePreferences({
  ...DEFAULT_PREFERENCES,
  selected: Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, true])) as Record<string, boolean>,
});

/** 在已收盘序列后追加一根形成中 K 线；now 落在该根内部。 */
function withForming(base: Candle[], close: number, now: number) {
  const last = base.at(-1)!;
  return {
    now,
    candles: [...base, { ts: last.ts + ms, o: close, h: close + 0.4, l: close - 0.4, c: close, v: 1_000_000 }],
  };
}

// ── 1. 预览关闭：实时价不得改写已确认判读 ──────────────────────
{
  const base = annotationCandles(true, 90, 1_800_000_000_000);
  const level = base.at(-1)!.c;
  const now = base.at(-1)!.ts + ms + 60_000; // 形成中 K 线进行中
  const prefs = { ...allOn, preview: false };
  const near = withForming(base, level, now);
  const far = withForming(base, level + 40, now); // 远离关键位数十倍 ATR

  const a = analyzeSignals(near.candles, ms, prefs, annotationFlow(near.candles), now);
  const b = analyzeSignals(far.candles, ms, prefs, annotationFlow(far.candles), now);
  const calls = (r: typeof a) => r.items.filter(i => !!i.story && i.confirmed);
  assert.ok(calls(a).length > 0, 'fixture must produce a confirmed key-level call');
  assert.deepEqual(
    calls(b).map(i => `${i.id}|${i.title}`),
    calls(a).map(i => `${i.id}|${i.title}`),
    '预览关闭时，实时价变化不得改写或丢弃已确认的关键位判读',
  );
  // 全部已确认 item（不止关键位判读）都应与实时价无关
  const confirmed = (r: typeof a) => r.items.filter(i => i.confirmed).map(i => `${i.id}|${i.title}|${i.detail.join('/')}`);
  assert.deepEqual(confirmed(b), confirmed(a), '预览关闭时，任何已确认标注都不得随实时价变化');
  pass('预览关闭：实时价不改写已确认标注（口径与文档一致）');

  // 预览开启时允许跟随实时价（保持原有能力）
  const live = { ...allOn, preview: true };
  const c = analyzeSignals(far.candles, ms, live, annotationFlow(far.candles), now);
  assert.deepEqual(c.items.filter(i=>i.story).map(i=>`${i.id}|${i.title}`), calls(a).map(i=>`${i.id}|${i.title}`), 'preview never changes a confirmed phase');
  assert.ok(c.items.find(i=>i.story)!.story!.preview?.includes('盘中'));
  pass('预览开启：独立盘中提示，仍不改收盘结论');
}

// ── 2. 重算键：预览关闭时忽略未收盘价 ──────────────────────────
{
  const key = (close: number, preview: boolean, extra: Partial<Parameters<typeof signalRecomputeKey>[0]> = {}) =>
    signalRecomputeKey({
      marketKey: 'BTC-USDT-SWAP|5', length: 600, firstTs: 1_000, lastTs: 2_000,
      prevClose: 100, prevVolume: 10, barMs: ms, now: 2_000 + ms, preview,
      forming: { high: close + 1, low: close - 1, close, volume: 5 }, ...extra,
    });
  assert.equal(key(100, false), key(150, false), '预览关闭：未收盘价跳动不得触发重算');
  assert.notEqual(key(100, true), key(150, true), '预览开启：未收盘价跳动必须触发重算');
  assert.notEqual(key(100, false), key(100, false, { length: 601 }), '新 K 线必须触发重算');
  assert.notEqual(key(100, false), key(100, false, { prevClose: 101 }), '最新已收盘 K 线变化必须触发重算');
  assert.notEqual(key(100, false), key(100, false, { now: 2_000 + 2 * ms }), '跨周期边界必须触发重算');
  pass('重算键只由已收盘状态驱动（预览开启时例外）');
}

// ── 3. 支撑/阻力的真实成交观察 ────────────────────────────────
{
  // 平盘 + 一次明确下探形成支撑；随后再次触碰但不构成二次测试拒绝（无 M/W 形态）
  const count = 140;
  const T0 = 1_800_000_000_000;
  const cs: Candle[] = Array.from({ length: count }, (_, i) => ({ ts: T0 + i * ms, o: 100, h: 100.4, l: 99.6, c: 100, v: 1_000_000 }));
  cs[40] = { ...cs[40], o: 99.8, h: 99.9, l: 98.2, c: 98.5 };       // 摆动低点（支撑 98.5）
  cs[120] = { ...cs[120], o: 99.4, h: 99.6, l: 98.45, c: 99.5 };    // 最近一次触碰，收盘守住
  const now = cs.at(-1)!.ts + ms;
  const flow = annotationFlow(cs, 0.62); // 主动买占优：ratio = (0.62-0.38) = +0.24
  const withFlow = analyzeSignals(cs, ms, allOn, flow, now);
  const levelItem = withFlow.items.find(i => i.type === 'keyLevels');
  assert.ok(levelItem, 'fixture must draw a support level');
  const touch = withFlow.items.find(i => i.type === 'keyLevels' && i.event?.ts === cs[120].ts);
  assert.ok(touch, '支撑位最近一次触碰有完整真实逐笔覆盖时，必须给出成交观察');
  assert.equal(touch!.source, 'price', 'level remains a price structure; real observation is attached in detail');
  // 关键位取摆动低点（bar 40 的 low=98.2），不是那根的收盘价
  assert.ok(Math.abs(touch!.price - 98.2) < 1e-9, `观察挂在该支撑位上（实际 ${touch!.price}）`);
  assert.ok(levelItem, 'sanity: a key level is drawn');
  assert.ok(touch!.event?.text === '买方占优', `主动买占优且收盘守住 → 买方占优（实际：${touch!.event?.text}）`);
  assert.ok(touch!.detail.some(l => l.includes('覆盖')), '详情必须给出覆盖率');
  assert.ok(touch!.detail.some(l => l.includes('OFI')), '详情必须声明不是订单簿 OFI');

  const noFlow = analyzeSignals(cs, ms, allOn, null, now);
  assert.ok(!noFlow.items.some(i => i.type === 'keyLevels' && i.event), '无真实成交覆盖时不得伪造关键位成交观察');
  assert.ok(noFlow.items.some(i => i.type === 'keyLevels'), '价格结构关键位与成交数据无关，仍应画出');
  pass('支撑/阻力：真实覆盖才给成交观察，无覆盖不伪造');
}

// ── 4. 缺口截断可观测 ─────────────────────────────────────────
{
  const count = 80;
  const T0 = 1_800_000_000_000;
  const cs: Candle[] = Array.from({ length: count }, (_, i) => ({ ts: T0 + i * ms, o: 100, h: 100.4, l: 99.6, c: 100, v: 1_000_000 }));
  // 在第 20 根之后挖掉 5 根，制造历史缺口
  const gapped = cs.filter((_, i) => i < 20 || i >= 25);
  const now = cs.at(-1)!.ts + ms;
  const prefs = { ...allOn, lookback: 300 as const };
  const r = analyzeSignals(gapped, ms, prefs, null, now);
  assert.equal(r.requested, 300, '必须回显请求的回看根数');
  assert.equal(r.gapTruncated, true, '缺口截断分析范围时必须可观测');
  assert.ok(r.bars < gapped.length, '截断后分析根数小于可用根数');
  const whole = analyzeSignals(cs, ms, prefs, null, now);
  assert.equal(whole.gapTruncated, false, '连续历史不得误报内部缺口');
  assert.equal(whole.historyShort, true, '连续但只加载80/请求300根时必须提示历史不足');

  const enough: Candle[] = Array.from({ length: 300 }, (_, i) => ({ ts: T0 + i * ms, o: 100, h: 100.4, l: 99.6, c: 100, v: 1_000_000, confirm: 1 }));
  const fullPrefs = { ...allOn, lookback: 300 as const };
  const complete = analyzeSignals(enough, ms, fullPrefs, null, enough.at(-1)!.ts + ms);
  assert.equal(complete.gapTruncated, false);
  assert.equal(complete.historyShort, false, '实际可用根数达到请求后不提示不足');
  pass('内部缺口与连续但历史不足分别可观测');
}

console.log(`PASS realtime-stability：${n} 组`);

{
 const cs=annotationCandles(),flow=annotationFlow(cs), now=cs.at(-1)!.ts+ms+1000;
 flow.bars.set(now-1000,{ts:now-1000,buy:100,sell:90,src:'tape'});
 const before=flowRecomputeKey(flow,now,false,600),liveBefore=flowRecomputeKey(flow,now,true,600);
 flow.bars.get(now-1000)!.buy=300;
 assert.equal(flowRecomputeKey(flow,now,false,600),before);
 assert.notEqual(flowRecomputeKey(flow,now,true,600),liveBefore);
 flow.bars.get(cs.at(-1)!.ts)!.buy+=1;
 assert.notEqual(flowRecomputeKey(flow,now,false,600),before);
 console.log('PASS forming-tape updates skip history work; corrections on closed flow still trigger');
}
