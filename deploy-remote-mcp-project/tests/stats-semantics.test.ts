// 统计口径回归测试。
// 运行：node scripts/run-ts-test.mjs tests/stats-semantics.test.ts
import assert from 'node:assert/strict';
import { summarize, calibration, thresholdSweep, attribution, topKillers, gradeDistribution, equitySeries } from '@/quant/stats';
import { optimize } from '@/quant/optimize';
import { walkForward } from '@/quant/fit';
import type { Candidate } from '@/quant/scan';

const T0 = 1_793_000_000_000;
const why = (r: number) => (r > 0 ? 'tp' : r < 0 ? 'sl' : 'be');
const mk = (r: number, proba = 0.7, w?: string): Candidate =>
  ({
    proba,
    ts: T0,
    grade: 'B',
    outcome: { filled: true, r, why: w ?? why(r), exitTs: T0, entryTs: T0, holdingBars: 1, costR: 0, pnlPct: 0 },
    evidence: new Array(19).fill(0.5),
    exits: {},
  }) as unknown as Candidate;
const finite = (o: object) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

test('r===0 记为 flat，不计入亏损；胜+负+平 === 成交', () => {
  const s = summarize([mk(1), mk(-1), mk(0), mk(2)], 0.5);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.flat, 1);
  assert.equal(s.wins + s.losses + s.flat, s.traded);
  assert.equal(s.flatRate, 25);
});

test('出场机制 tp/sl/time/be 互斥且合计 100%（与 flat 是正交维度）', () => {
  const s = summarize([mk(1, 0.7, 'tp'), mk(-1, 0.7, 'sl'), mk(0, 0.7, 'be'), mk(2, 0.7, 'tp'), mk(0.5, 0.7, 'time')], 0.5);
  assert.ok(Math.abs(s.tpRate + s.slRate + s.timeRate + s.beRate - 100) < 1e-9);
});

test('PF / 赔付比：有亏损为真实比值，无亏损为哨兵 99（UI 渲染 ∞）', () => {
  const real = summarize([mk(2), mk(-1)], 0.5);
  assert.equal(real.pf, 2);
  assert.equal(real.payoff, 2);
  const none = summarize([mk(1), mk(2)], 0.5);
  assert.equal(none.pf, 99);
  assert.equal(none.payoff, 99);
});

test('独立复算：胜率 / 累计 R / 最大回撤', () => {
  const rs = [1, -1, 2, -3, 1, 1, -1];
  const s = summarize(rs.map((r) => mk(r)), 0.5);
  let cum = 0, peak = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  assert.equal(s.traded, 7);
  assert.ok(Math.abs(s.totalR - cum) < 1e-12);
  assert.ok(Math.abs(s.maxDD - dd) < 1e-12);
  assert.ok(Math.abs(s.winRate - (4 / 7) * 100) < 1e-9);
});

test('门槛单调：更高门槛不会增加成交笔数', () => {
  const pool = Array.from({ length: 50 }, (_, i) => mk(i % 3 === 0 ? -1 : 1, 0.42 + (i / 50) * 0.4));
  let prev = Infinity;
  for (let t = 0.42; t <= 0.82; t += 0.04) {
    const n = summarize(pool, t).traded;
    assert.ok(n <= prev);
    prev = n;
  }
});

test('退化样本（空 / 单笔 / 全赢 / 全亏 / r=0）所有诊断函数无 NaN 且不抛错', () => {
  const cases: Candidate[][] = [[], [mk(1)], [mk(1), mk(2)], [mk(-1), mk(-2)], [mk(0)]];
  for (const list of cases) {
    const all = [
      summarize(list, 0.5),
      ...calibration(list),
      ...thresholdSweep(list),
      ...attribution(list, 0.5),
      ...topKillers(list, 0.5),
      ...gradeDistribution(list),
      ...equitySeries(list, 0.5),
    ];
    assert.ok(all.every((o) => finite(o as object)), `样本 ${list.length} 笔出现 NaN`);
  }
});

test('gradeDistribution 遇到未知等级不产生 NaN 项', () => {
  const g = gradeDistribution([{ ...mk(1), grade: undefined } as unknown as Candidate, mk(1)]);
  assert.equal(g.length, 4);
  assert.ok(g.every((o) => finite(o)));
  assert.equal(g.find((o) => o.grade === 'B')?.n, 1);
});

test('attribution 不把 r=0 计入亏损侧', () => {
  const mkE = (r: number, e: number) => ({ ...mk(r), evidence: new Array(19).fill(e) }) as unknown as Candidate;
  const a = attribution([mkE(1, 0.9), mkE(-1, 0.1), mkE(0, 0.5)], 0.5);
  assert.ok(Math.abs(a[0].avgWin - 0.9) < 1e-12);
  assert.ok(Math.abs(a[0].avgLoss - 0.1) < 1e-12, `avgLoss=${a[0].avgLoss}，r=0 若被计入亏损会变成 0.3`);
});

test('样本不足时 optimize 返回空、walkForward 返回 null', () => {
  const o = optimize([mk(1), mk(-1)], []);
  assert.equal(o.combos.length, 0);
  assert.equal(o.best, null);
  assert.equal(walkForward([mk(1)], 0.5), null);
});

console.log(`\nstats-semantics: ${passed} 组断言通过`);
