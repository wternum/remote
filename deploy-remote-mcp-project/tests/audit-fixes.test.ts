// 缺陷修复回归测试（对应 src/audit/tasks.ts 任务卡）
// 运行：node scripts/run-ts-test.mjs tests/audit-fixes.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { DEFAULT_PARAMS, scanDoubles } from '@/lib/engine';
import { simulate } from '@/lib/engine';
import { runScan, type Candidate } from '@/quant/scan';
import { summarize } from '@/quant/stats';
import { legacyTrendCandles as synthCandles } from './legacy-synth';
import { bigBiasOf, shouldRepairFlow, type FlowTrade } from '@/quant/flow';

// ── 确定性合成行情 ───────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 带强趋势段的合成 K 线：用于触发原引擎 trendBlock=1 的硬屏蔽 */
function synthSeries(seed: number, n = 900): Candle[] {
  const rnd = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    // 每 150 根切换一次强趋势方向，趋势内部漂移远大于噪声 → EMA20-EMA50/ATR 经常超出 ±1
    const leg = Math.floor(i / 150) % 2 === 0 ? -1 : 1;
    const drift = leg * 0.0022;
    const o = price;
    const c = o * (1 + drift + (rnd() - 0.5) * 0.0016);
    const h = Math.max(o, c) * (1 + rnd() * 0.0006);
    const l = Math.min(o, c) * (1 - rnd() * 0.0006);
    out.push({ ts: t0 + i * 300_000, o, h, l, c, v: 1_000_000 * (0.6 + rnd()) });
    price = c;
  }
  return out;
}

const keyOf = (s: { ts: number; pattern: string; side: string }) => `${s.ts}|${s.pattern}|${s.side}`;
let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ── T3：runScan 与引擎覆盖层使用同一趋势屏蔽口径 ─────────────
{
  let discriminating = 0;
  let checked = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const cs = synthCandles('BTC-USDT-SWAP', '5m', 2400, 1_760_000_000_000 + seed * 86_400_000);
    const hardBlock = scanDoubles(cs, { ...DEFAULT_PARAMS, entryMode: 'confirm' }); // trendBlock = 1
    const softBlock = scanDoubles(cs, { ...DEFAULT_PARAMS, entryMode: 'confirm', trendBlock: 50 });
    console.log(`    seed=${seed} trendBlock=1 → ${hardBlock.signals.length} 信号 / trendBlock=50 → ${softBlock.signals.length} 信号`);
    if (hardBlock.signals.length === softBlock.signals.length) continue; // 该数据集无区分度
    discriminating++;
    const scan = runScan(cs, '5m');
    const expect = softBlock.signals.map(keyOf).sort();
    const actual = scan.confirm.map(c => keyOf({ ts: c.ts, pattern: c.pattern, side: c.side })).sort();
    assert.deepEqual(actual, expect, 'runScan 必须与 trendBlock=50 的扫描结果完全一致');
    assert.ok(actual.length > hardBlock.signals.length, '关闭硬屏蔽后应恢复被误杀的信号');
    checked++;
    if (checked >= 2) break;
  }
  assert.ok(discriminating > 0, '合成数据未能触发 trendBlock 差异，测试失去区分度');
  ok(`T3 两条策略路径信号集合一致（${checked} 组有区分度的数据）`);
}

// ── T4：显式门槛 / 入场模式 / replaceConfFilter 真正生效 ─────
{
  const cs = synthCandles('BTC-USDT-SWAP', '5m', 8640, 1_760_000_000_000 + 3 * 86_400_000);
  const base = { flowFilter: false, maxHold: 96 };
  const loose = simulate(cs, 'BTC-USDT-SWAP', '5m', { ...base, threshold: 0.42, entryMode: 'confirm' });
  const strict = simulate(cs, 'BTC-USDT-SWAP', '5m', { ...base, threshold: 0.82, entryMode: 'confirm' });
  const done = (r: typeof loose) => r.filter(x => x.status === 'done').length;
  assert.ok(done(loose) > 0, '合成数据应产生可成交样本');
  assert.ok(done(strict) < done(loose), `提高门槛必须减少成交笔数（${done(strict)} !< ${done(loose)}）`);
  assert.ok(
    strict.filter(x => x.status === 'done').every(x => Number((x as { proba?: number }).proba) >= 0.82),
    '高门槛下不允许低概率单成交',
  );
  ok(`T4a 显式 threshold 生效：42% → ${done(loose)} 笔，82% → ${done(strict)} 笔`);

  const confirmMode = simulate(cs, 'BTC-USDT-SWAP', '5m', { ...base, threshold: 0.42, entryMode: 'confirm' });
  const touchMode = simulate(cs, 'BTC-USDT-SWAP', '5m', { ...base, threshold: 0.42, entryMode: 'touch' });
  assert.notEqual(done(confirmMode), done(touchMode), '入场模式必须改变成交集合');
  ok(`T4b entryMode 生效：confirm ${done(confirmMode)} 笔 / touch ${done(touchMode)} 笔`);

  const replaced = simulate(cs, 'BTC-USDT-SWAP', '5m', {
    flowFilter: true, maxHold: 96, threshold: 0.42, entryMode: 'confirm', replaceConfFilter: true,
  });
  const kept = simulate(cs, 'BTC-USDT-SWAP', '5m', {
    flowFilter: true, maxHold: 96, threshold: 0.42, entryMode: 'confirm', replaceConfFilter: false,
  });
  assert.ok(
    kept.filter(x => x.status === 'done').every(x => x.conf >= 60),
    'replaceConfFilter=false 时必须恢复 CONF_MIN=60 结构质量过滤',
  );
  assert.ok(done(replaced) >= done(kept), '关闭结构过滤后成交笔数不应更少');
  ok(`T4c replaceConfFilter 生效：true ${done(replaced)} 笔 / false ${done(kept)} 笔（conf≥60）`);
}

// ── T7：保本出场单独分桶，不再被计入“超时” ───────────────────
{
  const mk = (why: string, r: number): Candidate =>
    ({
      id: `${why}_${r}`,
      proba: 0.7,
      outcome: {
        filled: true, why, entryPrice: 100, entryTs: 1, exitPrice: 100, exitTs: 2,
        r, pnlPct: 0, holdingBars: 3, costR: 0.05,
      },
    }) as unknown as Candidate;
  const s = summarize([mk('be', 0.02), mk('tp', 1.4), mk('sl', -1), mk('time', 0.1)]);
  assert.equal(s.traded, 4);
  assert.equal(s.tpRate, 25);
  assert.equal(s.slRate, 25);
  assert.equal(s.timeRate, 25, '保本单不得计入超时');
  assert.equal(s.beRate, 25, '保本单必须单独统计');
  ok('T7 保本出场独立分桶（tp/sl/time/be 各 25%）');
}

// ── T5：大单主动方向（tapeBias 数据源） ──────────────────────
{
  const now = 1_800_000_000_000;
  const trades: FlowTrade[] = [];
  for (let i = 0; i < 90; i++) trades.push({ ts: now - i * 100, side: i % 2 ? 'buy' : 'sell', notional: 100 });
  for (let i = 0; i < 8; i++) trades.push({ ts: now - i * 100, side: 'buy', notional: 10_000 });
  for (let i = 0; i < 2; i++) trades.push({ ts: now - i * 100, side: 'sell', notional: 10_000 });
  const r = bigBiasOf(trades, now);
  assert.equal(r.count, 10, '只有超过分位值的 10 笔大额成交才算大单（不得退化为全量）');
  assert.ok(Math.abs((r.bias ?? 0) - 0.6) < 1e-9, `8 买 2 卖等额大单应得到 0.6，实际 ${r.bias}`);
  assert.equal(bigBiasOf(trades.slice(0, 10), now).bias, null, '样本不足必须返回 null 而不是臆测');
  assert.equal(bigBiasOf(trades.map(t => ({ ...t, ts: t.ts - 600_000 })), now).bias, null, '窗口外的旧成交不参与');
  ok(`T5 大单主动方向：bias=${r.bias?.toFixed(2)}，count=${r.count}，样本不足/超窗口均为 null`);
}

// ── T6：断线 / 滞后才回补，且有最小间隔 ──────────────────────
{
  const now = 1_800_000_000_000;
  const barMs = 300_000;
  assert.equal(shouldRepairFlow({ to: now - barMs, barMs }, false, now), false, '快照新鲜且未断线：不回补');
  assert.equal(shouldRepairFlow({ to: now - 3 * barMs, barMs }, false, now), true, '快照滞后超过 2 个周期：回补');
  assert.equal(shouldRepairFlow({ to: now - barMs, barMs }, true, now), true, 'WS 断开过：回补');
  assert.equal(
    shouldRepairFlow({ to: now - 3 * barMs, barMs, repairedAt: now - 1000 }, true, now),
    false,
    '刚回补过：一个周期内不重复回补',
  );
  ok('T6 修复性回补触发条件与最小间隔正确');
}

// ── T10：触价模式不再被“不存在的确认K”惩罚 ──────────────────
{
  const cs = synthCandles('BTC-USDT-SWAP', '5m', 8640, 1_760_000_000_000 + 3 * 86_400_000);
  const scan = runScan(cs, '5m');
  assert.ok(scan.touch.length > 0, '需要触价候选样本');
  const passable = scan.touch.filter(c => c.proba >= 0.42).length;
  assert.ok(passable > 0, `触价池仍全部低于 42% 门槛（${passable}/${scan.touch.length}），A/B 对照依旧无效`);
  assert.equal(scan.confirm.length, 2, 'confirm 路径候选数不得被触价修复影响');
  ok(`T10 触价池恢复可成交候选：${passable}/${scan.touch.length} 通过 42% 门槛，confirm 候选仍为 ${scan.confirm.length}`);
}

console.log(`\naudit-fixes: ${passed} 组断言全部通过`);
