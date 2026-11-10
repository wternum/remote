// 回归：2026-11-10 按 SOL 5m 实盘截图（11-09 23:58 UTC）逐条核对标注后的修正。
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { binWidthOf, readAuction } from '@/quant/auction';
import { buildContext } from '@/quant/context';
import { confluenceOf, WEAK_VIEW_FLOOR } from '@/quant/frameworks';
import { mergeAdjacentFvgs, readWyckoff } from '@/quant/wyckoff';
import { readLiquidity } from '@/quant/liquidity';
import { buildFrameworks } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';
import type { FvgZone } from '@/quant/smartmoney';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const MS = 300_000, T0 = 1_800_000_000_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * MS, o, h, l, c, v, confirm: 1, volumeSource: 'quote' });
/** 折线行情：在 way 的拐点之间线性插值，影线 ±0.3 */
const zigzag = (way: [number, number][]): Candle[] => {
  const out: Candle[] = [];
  for (let k = 0; k + 1 < way.length; k++) {
    const [i0, p0] = way[k], [i1, p1] = way[k + 1];
    for (let i = i0; i < i1; i++) { const p = p0 + (p1 - p0) * (i - i0) / (i1 - i0); out.push(bar(i, p, p + 0.3, p - 0.3, p)); }
  }
  return out;
};

// 1. 价值区网格不随每根 ATR 变化：POC/VAH/VAL 不再逐根跳动
{
  assert.equal(binWidthOf(86.5, 0.1), 0.01);
  assert.equal(binWidthOf(86.5, 0.4), 0.01, 'bin width must not depend on the per-bar ATR');
  assert.equal(binWidthOf(3500, 9), 0.5);
  assert.equal(binWidthOf(100_000, 120), 10);
  const cs = zigzag([[0, 100], [40, 98], [80, 101], [120, 99.5]]);
  const a = readAuction(cs, 120, 0.4).profile, b = readAuction(cs, 120, 0.7).profile;
  assert.equal(a.bin, b.bin);
  assert.deepEqual([a.poc, a.vah, a.val], [b.poc, b.vah, b.val], 'a different ATR must not move POC/VAH/VAL');
  pass('1 · 价值区分箱按价格取 1-2-5 步长（SOL 0.01），ATR 变化不再让 POC/VAH 跳动');
}

// 2. 同一段推进留下的连续缺口合并；已填满的部分不并入
{
  const z = (kind: FvgZone['kind'], from: number, lo: number, hi: number, filled = false): FvgZone =>
    ({ kind, from, to: from + 2, lo, hi, touched: false, filled, fillIdx: filled ? from + 5 : null, aligned: false });
  const merged = mergeAdjacentFvgs([z('bearish', 10, 87.52, 87.69), z('bearish', 11, 87.41, 87.46), z('bullish', 12, 86, 86.2), z('bearish', 30, 88, 88.1)]);
  assert.deepEqual(merged.map(m => [m.kind, m.lo, m.hi]), [['bearish', 87.41, 87.69], ['bullish', 86, 86.2], ['bearish', 88, 88.1]]);

  // 三根连续上涨留下两个缺口，后来回调填满了上面那个：只剩下面那个
  const cs: Candle[] = [];
  for (let i = 0; i < 60; i++) cs.push(bar(i, 100, 100.1, 99.9, 100));
  cs.push(bar(60, 100, 100.2, 99.9, 100.15));
  cs.push(bar(61, 100.2, 101, 100.05, 100.95)); // 低点盖住第 59 根，不额外制造缺口
  cs.push(bar(62, 100.95, 101.4, 100.5, 101.3));
  cs.push(bar(63, 101.3, 101.6, 101.2, 101.5));
  cs.push(bar(64, 101.5, 101.55, 100.9, 101.0));
  for (let i = 65; i < 75; i++) cs.push(bar(i, 101.0, 101.1, 100.95, 101.05));
  const fvgs = readWyckoff(buildContext(cs)).imbalances.filter(f => f.kind === 'bullish');
  assert.equal(fvgs.length, 1, JSON.stringify(fvgs));
  assert.deepEqual([fvgs[0].lo, fvgs[0].hi], [100.2, 100.5], 'the filled upper gap must not widen the open one');
  pass('2 · 连续同向 FVG 合并成一个区；已回补的部分不再被并进未回补区');
}

// 3. 汇总：减弱到地板以下的视角按中性计；单一视角不算共振
{
  const p = (label: string, bias: 1 | -1 | 0, strength: number) => ({ label, bias, strength, available: true });
  const stale = confluenceOf([p('流动性', 1, 0.025), p('多周期', 0, 0), p('Wyckoff', 0, 0), p('AMT', -1, 0.7)]);
  assert.equal(stale.long, 0, `strength < ${WEAK_VIEW_FLOOR} must not count as a long vote`);
  assert.equal(stale.short, 1);
  assert.equal(stale.verdict, 'neutral', 'a single directional view is not confluence');
  assert.ok(stale.headline.includes('平（信号已减弱）'));
  const two = confluenceOf([p('流动性', -1, 0.4), p('多周期', 0, 0), p('Wyckoff', 0, 0), p('AMT', -1, 0.7)]);
  assert.equal(two.verdict, 'lean_short');
  pass('3 · 44 根前的弱 BOS 不再计一票多；只有 1 个视角有方向时汇总为中性');
}

// 4. 等低池比更近的单个前低更重要：两条都画
{
  const cs = zigzag([[0, 100], [30, 96], [45, 100], [60, 96.02], [80, 100], [100, 97], [120, 99.5], [140, 99]]);
  const ctx = buildContext(cs);
  const liq = readLiquidity(ctx);
  assert.ok(liq.nearestBelow && Math.abs(liq.nearestBelow.price - 96.7) < 0.05, `nearest single low ${liq.nearestBelow?.price}`);
  assert.ok(liq.poolBelow && liq.poolBelow.equal && liq.poolBelow.touches === 2 && Math.abs(liq.poolBelow.price - 95.71) < 0.05, `pool ${JSON.stringify(liq.poolBelow)}`);
  const report = buildFrameworks(cs, MS, 'SOL-USDT-SWAP', '5m', null, cs.at(-1)!.ts + MS + 2000)!;
  const levels = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS).payload.levels;
  const pool = levels.find(l => l.id === 'fw:liq:pool-below');
  assert.ok(pool && pool.name === 'EQL 等低×2', `pool level ${JSON.stringify(levels.map(l => l.name))}`);
  assert.ok(levels.some(l => l.id === 'fw:liq:below' && l.name === '前低'));
  pass('4 · 下方等低×2 不再被更近的单个前低挡住，两条线都画出');
}

// 5. 文案：分形说清楚和哪个价比较；名称带中文；不再夹杂 "UTC" 噪音
{
  const cs = Array.from({ length: 180 }, (_, i) => { const p = 100 + i * 0.06 + Math.sin(i / 2.2) * 1.4; return bar(i, p, p + 0.2, p - 0.2, p + 0.05); });
  const report = buildFrameworks(cs, MS, 'BTC-USDT-SWAP', '5m', null, T0 + 180 * MS)!;
  const m = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  const frac = m.payload.events.filter(e => e.id.startsWith('fw:frac:'));
  assert.ok(frac.length > 0);
  for (const e of frac) assert.ok(/(比前一个|和前一个)(高点|低点) \d/.test(e.detail![0]), e.detail![0]);
  const names = m.payload.levels.map(l => l.name);
  assert.ok(names.includes('POC 成交最密') && names.includes('VAH 价值上沿') && names.includes('VAL 价值下沿'), names.join(','));
  const text = JSON.stringify(m);
  assert.ok(!text.includes(' UTC'), 'hover text should not repeat the UTC suffix');
  assert.ok(m.hud!.detail[0].startsWith('多周期结构：'));
  pass('5 · 分形悬停写明比较对象与差值；POC/VAH/VAL 带中文名；HUD 用白话');
}

console.log(`\nmarks-review: ${passed} groups passed`);
