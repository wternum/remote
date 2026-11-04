import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { closedCandles } from '../src/lib/candles';
import { simulate } from '../src/lib/engine';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { FACTORS } from '../src/quant/model';
import { simulateWithPlan, type Candidate } from '../src/quant/scan';
import { auc, brier, predict, walkForward } from '../src/quant/fit';
import { synthCandles } from '../src/server/okx';
import type { ScanSignal } from '../remote/setup-mcp-project-locally/src/lib/engine';

const BAR = 300_000;
let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// 1) OKX's forming candle must not alter a closed-bar backtest.
{
  const now = Date.now();
  const cs = synthCandles('BTC-USDT-SWAP', '5m', 900, now);
  const formingTs = Math.floor(now / BAR) * BAR;
  const last = cs.at(-1)!;
  const forming: Candle = {
    ts: formingTs, o: last.c, h: last.c * 1.2, l: last.c * 0.8, c: last.c * 1.1, v: last.v * 100,
  };
  const withForming = [...cs, forming];
  assert.equal(closedCandles(withForming, '5m', now).length, cs.length);
  const opts = { flowFilter: false, maxHold: 96, threshold: 0.42, entryMode: 'confirm' as const };
  assert.deepEqual(
    simulate(withForming, 'BTC-USDT-SWAP', '5m', opts),
    simulate(cs, 'BTC-USDT-SWAP', '5m', opts),
    'adding a forming candle must not change any simulated record',
  );
  pass('未收盘 K 线被排除，追加极端形成中 K 线不会改变回测');
}

// 2) Contract OI, not USD-notional OI, drives position-change evidence.
{
  const cs: Candle[] = [0, 1, 2].map(i => ({
    ts: 1_700_000_000_000 + i * BAR, o: 100, h: 101, l: 99, c: 100, v: 1000,
  }));
  const bars = new Map(cs.map((c, i) => [c.ts, {
    ts: c.ts, buy: 600, sell: 400, src: 'rubik' as const,
    oiContracts: 1000 + i * 10,
    // Deliberately moves in the opposite direction/by a different amount.
    oiUsd: 1000 * (i + 1),
  }]));
  const flow: FlowSnapshot = {
    instId: 'TEST', period: '5m', barMs: BAR, bars,
    from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: cs[0].ts,
    updatedAt: 0, complete: true, tape: { connected: false, trades: 0, bootstrapped: true },
  };
  const ctx = buildContext(cs, flow);
  assert.deepEqual(ctx.oi, [1000, 1010, 1020]);
  pass('持仓证据使用合约张数，USD 名义值不会覆盖它');
}

// 3) A fee-negative break-even stop is still a break-even exit mechanism.
{
  const cs: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * BAR, o: 100, h: 100.5, l: 99.5, c: 100, v: 1000,
  }));
  cs[31] = { ...cs[31], o: 100, h: 101.2, l: 99.8, c: 100.8 }; // crosses +1R
  cs[32] = { ...cs[32], o: 100.8, h: 100.2, l: 100.0, c: 100.0 }; // hits moved BE stop
  const sig = {
    idx: 30, ts: cs[30].ts, side: 'long', pattern: 'db_reject',
    entry: 100, stop: 99, tp: 103, conf: 50, confl: 50, strength: 50,
    note: 'regression', fill: 'close',
  } as ScanSignal;
  const outcome = simulateWithPlan(buildContext(cs), sig, 'confirm', 96, 'be');
  assert.ok(outcome && outcome.r < 0, 'the fixture must produce a fee-negative BE exit');
  assert.equal(outcome.why, 'be', 'fees must not reclassify a moved BE stop as an ordinary SL');
  pass('保本止损的费用后负 R 仍保留 be 退出原因');
}

// 4) Walk-forward: purge overlapping training labels and use continuous scores.
{
  const pool = Array.from({ length: 60 }, (_, i) => {
    const ts = 1_000_000 + i * 1000;
    const evidence = FACTORS.map((_, k) => Math.sin((i + 1) * (k + 2)) * 0.7);
    return {
      id: `c${i}`, idx: i, ts, side: 'long', pattern: 'db_reject', mode: 'confirm',
      proba: 0.5, grade: 'C', evidence,
      outcome: {
        filled: true, why: 'tp', entryPrice: 100, entryTs: ts,
        exitPrice: 101, exitTs: ts + 100, r: i % 2 ? 1 : -1,
        pnlPct: 1, holdingBars: 1, costR: 0.01,
      },
    } as unknown as Candidate;
  });
  const splitTs = pool[42].ts;
  // This training signal is still open when the test window begins.
  pool[41].outcome!.exitTs = splitTs + 5000;
  const wf = walkForward(pool, 0.5);
  assert.ok(wf, '60 candidates should be enough for walk-forward');
  assert.equal(wf.trainN, 41, 'the crossing training trade must be purged');
  const test = pool.slice(42);
  const scores = test.map(c => predict(c.evidence, wf.fit));
  const y = test.map(c => (c.outcome!.r > 0 ? 1 : 0));
  assert.ok(Math.abs(wf.fitted.auc - auc(scores, y)) < 1e-12, 'fitted AUC must use continuous fitted scores');
  assert.ok(Math.abs(wf.fitted.brier - brier(scores, y)) < 1e-12, 'fitted Brier must use continuous fitted scores');
  pass('walk-forward 清除跨边界训练仓位，fitted AUC/Brier 使用连续模型分数');
}

console.log(`\nregression-fixes: ${passed} 组断言全部通过`);
