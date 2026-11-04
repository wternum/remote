// SMC/ICT 关键位结构观察的确定性测试。
// 运行：node scripts/run-ts-test.mjs tests/smartmoney.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { findFvgs, liquidityPool, orderBlockCandidate, readSmartMoney, dealingRange } from '../src/quant/smartmoney';
import { analyzeSignals, projectSignals } from '../src/vela/signals/analyze';
import { DEFAULT_PREFERENCES, SIGNAL_TYPES, type SignalPreferences } from '../src/vela/signals/store';
import { annotationCandles, annotationFlow } from './signal-fixtures';

const MS = 300_000;
const NOW = 1_800_000_000_000;
let passed = 0;
const pass = (n: string) => { passed++; console.log(`  ✓ ${n}`); };

const prefs: SignalPreferences = {
  ...DEFAULT_PREFERENCES,
  selected: Object.fromEntries(Object.keys(DEFAULT_PREFERENCES.selected).map(k => [k, true])) as SignalPreferences['selected'],
};

// ── 1. 三根不重叠缺口：识别、方向对齐与回补状态 ────────────────
{
  const base: Candle[] = Array.from({ length: 12 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * MS, o: 100, h: 100.4, l: 99.6, c: 100, v: 1000,
  }));
  // 在第 5 根制造多头缺口：第 3 根最高 100.4，第 5 根最低 102
  base[4] = { ...base[4], o: 100, h: 100.4, l: 99.8, c: 100.2 };
  base[5] = { ...base[5], o: 101, h: 102.6, l: 102, c: 102.4, v: 3000 };
  base[6] = { ...base[6], o: 102.4, h: 103, l: 102.2, c: 102.8 };
  for (let i = 7; i < 12; i++) base[i] = { ...base[i], o: 102.8, h: 103.2, l: 102.6, c: 103 };
  const open = buildContext(base);
  const gaps = findFvgs(open, 0, 11, 11);
  const bull = gaps.find(g => g.kind === 'bullish');
  assert.ok(bull, '应识别多头缺口');
  assert.ok(Math.abs(bull!.lo - 100.4) < 1e-9 && Math.abs(bull!.hi - 102) < 1e-9, `缺口边界应为 [100.4,102]，实际 ${bull!.lo},${bull!.hi}`);
  assert.equal(bull!.filled, false);

  const filled = base.map((c, i) => (i === 9 ? { ...c, l: 100.2, c: 100.3 } : c));
  const gapFilled = findFvgs(buildContext(filled), 0, 11, 11).find(g => g.kind === 'bullish')!;
  assert.equal(gapFilled.filled, true, '跌破缺口下沿应视为完全回补');
  assert.equal(gapFilled.fillIdx, 9);
  pass('FVG 识别边界、方向与完全回补时点');
}

// ── 2. 交易区间 / 溢价折价与订单块候选 ─────────────────────────
{
  const cs = annotationCandles(true, 90, NOW);
  const ctx = buildContext(cs);
  const range = dealingRange(ctx, 0, 88);
  assert.ok(range.hi > range.lo && range.position >= 0 && range.position <= 1);
  const ob = orderBlockCandidate(ctx, { side: 'top', idx: 70, first: 40, second: 70, level: 120.1, neck: 106 });
  if (ob) {
    assert.ok(ob.hi >= ob.lo, '订单块区间必须有序');
    assert.ok(ob.displacementAtr >= 0, '位移必须是非负 ATR 倍数');
  }
  const lp = liquidityPool(ctx, { side: 'top', idx: 70, first: 40, second: 70, level: 120.1, neck: 106 });
  assert.ok(lp === null || lp.touches >= 1, '流动性池命中时至少一次触及');
  pass('交易区间、订单块候选与流动性池不抛错且保持单调');
}

// ── 3. 因果性：确认后的未来 K 线不得改变已有 SMC 结论 ─────────
{
  const untilEvent = annotationCandles(true, 90, NOW).slice(0, 71);
  const now = untilEvent.at(-1)!.ts + MS;
  const before = analyzeSignals(untilEvent, MS, prefs, null, now).items.find(i => i.type === 'smartMoney');
  const future = annotationCandles(true, 90, NOW).map((c, i) => (i > 70 ? { ...c, h: c.h + 3, l: c.l - 3, v: c.v * 50 } : c));
  const after = analyzeSignals(future, MS, prefs, null, NOW).items.find(i => i.type === 'smartMoney');
  if (before) assert.deepEqual(after, before, '未来 K 线不得改写已确认的 SMC 标记');
  pass('SMC 标注使用因果数据，未来 K 线不回溯修改');
}

// ── 4. 无真实覆盖 → source=price；完整覆盖 → 附加成交佐证 ─────
{
  const cs = annotationCandles(true, 90, NOW);
  const ctx = buildContext(cs);
  const p = { side: 'top' as const, idx: 70, first: 40, second: 70, level: 120.1, neck: 106 };
  const noFlow = readSmartMoney(ctx, p, null, false);
  assert.equal(noFlow.source, 'price');
  assert.equal(noFlow.taker, null);
  assert.ok(noFlow.evidence.some(e => e.key === 'takerConfirm' && e.state === 'na'));

  const bars = new Map(cs.map(c => [c.ts, { ts: c.ts, buy: c.v * 0.85, sell: c.v * 0.15, src: 'tape' as const, trades: 10 }]));
  const flow: FlowSnapshot = {
    instId: 'BTC-USDT-SWAP', period: '5m', barMs: MS, bars,
    from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: Infinity,
    updatedAt: 0, complete: true, recent: [], tape: { connected: true, trades: 0, bootstrapped: true },
  };
  const realCtx = buildContext(cs, flow);
  const smc = readSmartMoney(realCtx, p, undefined, false);
  assert.equal(smc.source, 'price', '没有显式窗口时不得冒充真实成交');

  // 覆盖达到 95% 才允许附加成交佐证。
  const coveredAnalysis = analyzeSignals(cs, MS, prefs, flow, NOW);
  const item = coveredAnalysis.items.find(i => i.type === 'smartMoney');
  if (item) {
    assert.equal(item.source, 'real', '完整真实覆盖时 SMC 来源应为真实逐笔');
    assert.ok(item.detail.every(l => l.startsWith('✓ ')) && item.detail.length <= 6, 'SMC 悬停只列命中项');
  }
  pass('无真实成交时只输出价格结构，且不会伪造成交佐证');
}

// ── 5. 侧栏注册与开关独立 ─────────────────────────────────────
{
  assert.ok(SIGNAL_TYPES.some(t => t.id === 'smartMoney' && t.group === 'structure'));
  const analysis = analyzeSignals(annotationCandles(true, 90, NOW), MS, prefs, annotationFlow(annotationCandles(true, 90, NOW), 0.85), NOW);
  const on = projectSignals(analysis, prefs);
  const off = projectSignals(analysis, { ...prefs, selected: { ...prefs.selected, smartMoney: false } });
  if (analysis.items.some(i => i.type === 'smartMoney')) {
    assert.ok(on.visible.some(i => i.type === 'smartMoney'));
    assert.ok(!off.visible.some(i => i.type === 'smartMoney'));
    assert.ok(off.visible.some(i => i.type === 'doubleTop'), '关闭 SMC 不应影响 M/W 结构');
  }
  pass('聪明钱结构已注册为独立开关，不影响价格结构标注');
}

console.log(`\nsmartmoney: ${passed} 组断言全部通过`);
