// 底层数据拉取与计算缺陷回归测试
// 运行：node scripts/run-ts-test.mjs tests/deep-fixes.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { buildContext } from '@/quant/context';
import { readSecondTest, readTouch } from '@/quant/orderflow';
import { simulateOutcome, simulateWithPlan } from '@/quant/scan';
import { FEE_RATE, SLIP_RATE, type ScanSignal } from '../remote/setup-mcp-project-locally/src/lib/engine';
import { syncFlow, getFlow, type FlowSnapshot } from '@/quant/flow';
import { getCandles } from '@/server/okx';

const B = 300_000;
const T0 = 1_793_000_000_000;
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 1;
  }
}

// 1) partial 出场方案必须扣除 1R 半仓平仓的滑点与双边手续费
await test('partial 出场方案扣除半仓 1R 平仓滑点与手续费，不再虚高', () => {
  const cs: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    ts: T0 + i * B, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000,
  }));
  // i=30 信号K；i=31 开盘 100 进场，止损 99（risk ≈ 1.01），最高冲到 101.1 触发 1R，但未到 1.5R
  cs[31] = { ts: T0 + 31 * B, o: 100, h: 101.2, l: 99.9, c: 100.8, v: 1200 };
  // i=32 跌回保本位止损离场
  cs[32] = { ts: T0 + 32 * B, o: 100.8, h: 100.8, l: 100.0, c: 100.05, v: 1000 };
  const sig = {
    idx: 30, ts: cs[30].ts, side: 'long', pattern: 'db_reject',
    entry: 100, stop: 99, tp: 103, conf: 70, confl: 70, strength: 70,
    note: 'partial-cost', fill: 'close',
  } as ScanSignal;
  const out = simulateWithPlan(buildContext(cs), sig, 'confirm', 96, 'partial')!;
  assert.equal(out.filled, true);
  assert.equal(out.why, 'be');
  // 半仓在 1R 兑现必须扣除滑点与手续费，因此最终 R 必然明显低于未扣成本时的 0.500
  const entry = 100 * (1 + SLIP_RATE);
  const risk = entry - 99;
  const trigger = entry + risk;
  const trigAdj = trigger * (1 - SLIP_RATE);
  const expectedLocked = 0.5 * ((trigAdj - entry - (entry + trigAdj) * FEE_RATE) / risk);
  assert.ok(expectedLocked < 0.45 && out.r <= expectedLocked + 0.01, `实际 r=${out.r}，期望约 ${expectedLocked.toFixed(3)}`);
});

// 2) 同根内先触发 1R 保本又打到止盈目标时，不得被 continue 跳过止盈
await test('同根突破 1R 并触及止盈目标时，当根立即按目标止盈而非延后保本扫出', () => {
  const cs: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    ts: T0 + i * B, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000,
  }));
  // i=31 开盘 100 进场，最低 99.5 未破止损 99，最高 102.0 同时越过 1R(101.01) 与 1.5R(101.515)
  cs[31] = { ts: T0 + 31 * B, o: 100, h: 102.0, l: 99.5, c: 101.2, v: 1500 };
  // i=32 跌回 100.05（若前一根错误 continue，这里会被保本扫出）
  cs[32] = { ts: T0 + 32 * B, o: 101.2, h: 101.2, l: 100.05, c: 100.05, v: 1200 };
  const sig = {
    idx: 30, ts: cs[30].ts, side: 'long', pattern: 'db_reject',
    entry: 100, stop: 99, tp: 101.5, conf: 70, confl: 70, strength: 70,
    note: 'same-bar-tp', fill: 'close',
  } as ScanSignal;
  const ctx = buildContext(cs);
  const beOut = simulateWithPlan(ctx, sig, 'confirm', 96, 'be')!;
  assert.equal(beOut.why, 'tp');
  assert.equal(beOut.holdingBars, 1);
  assert.ok(beOut.r > 1.3, `be 应在当根触及目标止盈，实际 r=${beOut.r}`);

  const partialOut = simulateWithPlan(ctx, sig, 'confirm', 96, 'partial')!;
  assert.equal(partialOut.why, 'tp');
  assert.equal(partialOut.holdingBars, 1);
  assert.ok(partialOut.r > 1.1, `partial 应在当根兑现半仓 1R + 半仓 1.5R，实际 r=${partialOut.r}`);
});

// 3) touch 挂单模式成交当根不得因未知 K 线内部先后顺序触发 1R 保本/减半
await test('touch 挂单成交当根不提前触发 1R 保本或半仓止盈', () => {
  const cs: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    ts: T0 + i * B, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000,
  }));
  // i=30 挂单 100 成交，同根冲到 101.5（>=1R），下一根 i=31 跌破止损 99
  cs[30] = { ts: T0 + 30 * B, o: 101.0, h: 101.5, l: 100.0, c: 100.2, v: 1200 };
  cs[31] = { ts: T0 + 31 * B, o: 100.2, h: 100.3, l: 98.8, c: 98.9, v: 1200 };
  const sig = {
    idx: 30, ts: cs[30].ts, side: 'long', pattern: 'db_reject',
    entry: 100, stop: 99, tp: 103, conf: 70, confl: 70, strength: 70,
    note: 'touch-intrabar', fill: 'limit',
  } as ScanSignal;
  const out = simulateWithPlan(buildContext(cs), sig, 'touch', 96, 'partial')!;
  assert.equal(out.why, 'sl', '成交当根不得提前锁半仓或移保本');
  assert.ok(out.r < -0.9, `应正常触发止损，实际 r=${out.r}`);
});

// 4) confirm 模式下一根开盘直接跳空越过止盈目标时，记为跳空未成交
await test('confirm 模式下一根开盘跳空越过止盈目标，记为 gap 未成交', () => {
  const cs: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    ts: T0 + i * B, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000,
  }));
  cs[31] = { ts: T0 + 31 * B, o: 102.5, h: 102.8, l: 101.8, c: 102.0, v: 1500 };
  const sig = {
    idx: 30, ts: cs[30].ts, side: 'long', pattern: 'db_reject',
    entry: 100, stop: 99, tp: 102.0, conf: 70, confl: 70, strength: 70,
    note: 'gap-tp', fill: 'close',
  } as ScanSignal;
  const ctx = buildContext(cs);
  assert.equal(simulateOutcome(ctx, sig, 'confirm', 96)!.filled, false);
  assert.equal(simulateWithPlan(ctx, sig, 'confirm', 96, 'partial')!.filled, false);
});

// 5) readTouch 无 taker 数据时保留客观量价/影线证据；readSecondTest CVD 仅按测试区间覆盖率缩放
await test('readTouch 无真实成交时保留客观量价影线证据，readSecondTest CVD 按区间覆盖缩放', () => {
  const cs: Candle[] = Array.from({ length: 60 }, (_, i) => ({
    ts: T0 + i * B, o: 100, h: 100.3, l: 99.7, c: 100, v: 1000,
  }));
  // 缩量长上影触顶收回（无 taker 数据）
  cs[59] = { ts: T0 + 59 * B, o: 100.1, h: 100.9, l: 100.0, c: 100.05, v: 500 };
  const rd = readTouch(buildContext(cs, null), { price: 100.8, side: 'top', idx: 20 }, 59, 59);
  assert.ok(rd.evidence > 0.1, `缩量长上影触顶无 taker 数据时仍应给出正拒绝证据，实际 ${rd.evidence}`);

  // CVD 覆盖：第一腿 [10..20] 无覆盖，但 (20..50] 有完整真实覆盖且主动卖出占优
  const bars = new Map();
  for (let i = 21; i <= 50; i++) {
    bars.set(cs[i].ts, { ts: cs[i].ts, buy: 300, sell: 700, src: 'rubik' as const });
  }
  const flow: FlowSnapshot = {
    instId: 'TEST', period: '5m', barMs: B, bars,
    from: cs[21].ts, to: cs[50].ts, oiFrom: Infinity, updatedAt: 0, complete: true,
    tape: { connected: false, trades: 0, bootstrapped: true },
  };
  const sig = {
    idx: 50, ts: cs[50].ts, side: 'short', pattern: 'dt_reject',
    entry: 100, stop: 101.5, tp: 97, conf: 70, confl: 70, strength: 70,
    note: 'cvd-cov', fill: 'close',
    geo: {
      pts: [
        { ts: cs[10].ts, price: 97, label: '起涨点', pos: 'below' },
        { ts: cs[20].ts, price: 101, label: '一顶', pos: 'above' },
        { ts: cs[35].ts, price: 98, label: '颈线', pos: 'below' },
        { ts: cs[50].ts, price: 101, label: '二顶', pos: 'above' },
      ],
    },
  } as ScanSignal;
  const st = readSecondTest(buildContext(cs, flow), sig);
  assert.ok(st.cvdDiv > 0.2, `(first, second] 区间完整覆盖时应计算 CVD 背离，实际 ${st.cvdDiv}`);
});

// 6) fetchCandlesWithMeta：裁剪掉的最老前缀里的缺口不误伤返回的连续窗口 + 深拉走 300 步长
await test('fetchCandlesWithMeta 仅校验裁剪后窗口缺口，深拉自适应 300 步长', async () => {
  const realFetch = globalThis.fetch;
  const now = Math.floor(1_793_500_000_000 / B) * B;
  let maxLimitSeen = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const limit = Number(u.searchParams.get('limit') ?? '100');
    maxLimitSeen = Math.max(maxLimitSeen, limit);
    const makeRow = (ts: number) => [String(ts), '100', '101', '99', '100', '10', '10', '1000', '1'];
    if (u.pathname.endsWith('/market/candles')) {
      return new Response(JSON.stringify({ code: '0', data: Array.from({ length: 300 }, (_, i) => makeRow(now - i * B)) }));
    }
    const after = Number(u.searchParams.get('after'));
    const rows = [];
    for (let i = 0; i < limit; i++) {
      const ts = after - (i + 1) * B;
      // 故意在最老前缀（第 8660 根之前，会被 slice(-8640) 裁掉）制造 1 根缺口
      if (ts === now - 8665 * B) continue;
      rows.push(makeRow(ts));
    }
    return new Response(JSON.stringify({ code: '0', data: rows }));
  }) as typeof fetch;

  try {
    const r = await getCandles('DEEP-USDT-SWAP', '5m', 8640, true);
    assert.equal(maxLimitSeen, 300, '深拉应探测并使用 300 步长');
    assert.equal(r.candles.length, 8640);
    assert.equal(r.gapped, false, '被 slice(-want) 裁掉的最老前缀缺口不得污染返回的连续 8640 根');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 7) syncRubik 增量刷新与有界裁剪
await test('syncRubik 增量刷新不重复拉历史，且 snap.bars 有上限保护', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as unknown as Record<string, unknown>;
  const origWin = g.window;
  delete g.window; // 模拟 Node 服务端直连路径
  let takerCalls = 0;
  const now = Math.floor(Date.now() / B) * B - 2 * B;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (u.pathname.includes('taker-volume-contract')) {
      takerCalls++;
      const end = Number(u.searchParams.get('end') ?? String(now + B));
      const rows = Array.from({ length: 100 }, (_, i) => [String(end - (i + 1) * B), '5000', '6000']);
      return new Response(JSON.stringify({ code: '0', data: rows }));
    }
    if (u.pathname.includes('open-interest-history')) {
      const end = Number(u.searchParams.get('end') ?? String(now + B));
      const rows = Array.from({ length: 100 }, (_, i) => [String(end - (i + 1) * B), '1000', '10', '100000']);
      return new Response(JSON.stringify({ code: '0', data: rows }));
    }
    return new Response(JSON.stringify({ code: '0', data: [] }));
  }) as typeof fetch;

  try {
    await syncFlow('INC-USDT-SWAP', '5m', { minTs: 0, maxPages: 4, oiPages: 2 });
    assert.equal(takerCalls, 4, '首次同步应拉满 4 页');
    takerCalls = 0;
    await syncFlow('INC-USDT-SWAP', '5m', { minTs: 0, maxPages: 4, oiPages: 2 });
    assert.equal(takerCalls, 1, '热刷新应增量停止在 1 页而非重拉 4 页');
    const snap = getFlow('INC-USDT-SWAP', '5m')!;
    assert.ok(snap.bars.size <= 12_000);
  } finally {
    if (origWin !== undefined) g.window = origWin;
    globalThis.fetch = realFetch;
  }
});

console.log(`\ndeep-fixes: ${passed} 组断言全部通过`);
if (process.exitCode) process.exit(process.exitCode);
