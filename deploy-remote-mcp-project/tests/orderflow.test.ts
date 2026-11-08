// 订单流判读单元测试（合成 K 线 + 合成真实主动成交）
// 运行：node scripts/run-ts-test.mjs tests/orderflow.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import { buildContext } from '../src/quant/context';
import type { FlowSnapshot } from '../src/quant/flow';
import { findSwingLevels, readBreakout, readSecondTest, readTouch, scanBreakouts, scanTouches } from '../src/quant/orderflow';
import { runScan } from '../src/quant/scan';
import { scanDoubles, DEFAULT_PARAMS } from '../remote/setup-mcp-project-locally/src/lib/engine';

const BAR = 300_000;
const T0 = 1_700_000_000_000;

interface Seg {
  to: number;
  bars: number;
  vol: number;
  /** 主动买卖差 / 成交额 */
  flow: number;
}

/** 分段线性合成 K 线；每根带 ±0.25 的影线，ATR ≈ 0.6 */
function build(start: number, segs: Seg[], tweak?: (i: number, c: Candle) => Candle) {
  const cs: Candle[] = [];
  const ratios: number[] = [];
  let px = start;
  for (const s of segs) {
    const step = (s.to - px) / s.bars;
    for (let k = 0; k < s.bars; k++) {
      const o = px;
      const c = px + step + (k % 2 ? 0.04 : -0.04);
      px = px + step;
      const i = cs.length;
      let bar: Candle = { ts: T0 + i * BAR, o, h: Math.max(o, c) + 0.25, l: Math.min(o, c) - 0.25, c, v: s.vol };
      if (tweak) bar = tweak(i, bar);
      cs.push(bar);
      ratios.push(s.flow);
    }
  }
  return { cs, ratios };
}

function flowOf(cs: Candle[], ratios: number[], override: Record<number, number> = {}, oi?: (i: number) => number): FlowSnapshot {
  const bars = new Map();
  cs.forEach((c, i) => {
    const r = override[i] ?? ratios[i];
    bars.set(c.ts, { ts: c.ts, buy: (c.v * (1 + r)) / 2, sell: (c.v * (1 - r)) / 2, oiUsd: oi ? oi(i) : undefined, src: 'rubik' as const });
  });
  return { instId: 'TEST', period: '5m', barMs: BAR, bars, from: cs[0].ts, to: cs[cs.length - 1].ts, oiFrom: cs[0].ts, updatedAt: 0, complete: true, tape: { connected: false, trades: 0, bootstrapped: true } };
}

const V = 1_000_000;

// ── 场景 1：M 双顶 · 二顶扫过前高后收回，扫高期间主动卖出占优 → 诱多 ──
function doubleTopTrap() {
  const segs: Seg[] = [
    { to: 95, bars: 60, vol: V, flow: 0 }, // 盘整
    { to: 100, bars: 40, vol: 1.4 * V, flow: 0.3 }, // 第一腿：放量主动买入
    { to: 97, bars: 40, vol: V, flow: -0.25 }, // 回落到颈线
    { to: 99.45, bars: 40, vol: 0.8 * V, flow: 0.05 }, // 第二腿：缩量、主动买入弱
    { to: 98.2, bars: 30, vol: 1.1 * V, flow: -0.2 }, // 确认后下跌
  ];
  const SWEEP = 180;
  const { cs, ratios } = build(95, segs, (i, c) => {
    if (i === SWEEP) return { ...c, o: 99.45, h: 100.49, l: 99.3, c: 99.5, v: 2 * V }; // 一顶高点 ≈ 100.29，扫高 0.2
    return c;
  });
  const flow = flowOf(cs, ratios, { [SWEEP]: -0.2 }, i => 300e6 * (1 + (i > 140 && i <= SWEEP ? 0.01 : 0)));
  return { cs, flow, SWEEP };
}

{
  const { cs, flow, SWEEP } = doubleTopTrap();
  const sigs = scanDoubles(cs, { ...DEFAULT_PARAMS, entryMode: 'confirm', trendBlock: 50 }).signals;
  const sig = sigs.find(s => s.idx === SWEEP && s.pattern === 'dt_reject');
  assert.ok(sig, `应在第 ${SWEEP} 根识别出双顶二次测试拒绝，实际: ${JSON.stringify(sigs.map(s => [s.idx, s.pattern]))}`);
  const ctx = buildContext(cs, flow);
  const read = readSecondTest(ctx, sig!);
  assert.equal(read.scene, 'doubleTop');
  assert.ok(read.sweep.occurred && read.sweep.depthAtr > 0.2, '应识别出扫高');
  assert.ok(read.confirm.closedInside && !read.sweep.accepted, '扫高后应收回');
  assert.ok(read.sweep.flow && read.sweep.flow.ratio < -0.1, '扫高期间主动卖出占优');
  assert.ok(read.cvdDiv > 0.25, `CVD 背离应为正，实际 ${read.cvdDiv}`);
  assert.equal(read.trap.kind, 'bullTrap', `应判定诱多，评分 ${read.trap.score}，理由 ${read.trap.reasons.join(' / ')}`);
  assert.ok(read.oi.pct != null && read.oi.pct > 0.003, '冲高段持仓应增加');
  assert.equal(read.flowSource, 'taker');

  const scan = runScan(cs, '5m', undefined, 'TEST', 'r15', flow);
  const cand = scan.confirm.find(c => c.idx === SWEEP);
  assert.ok(cand, '候选应存在');
  assert.equal(cand!.trap, 'bullTrap');
  assert.equal(cand!.flowSource, 'taker');
  assert.ok(cand!.proba > 0.5, `真实订单流下下跌概率应 > 50%，实际 ${cand!.proba}`);
  // Public flow identifies a sweep/reclaim candidate, not actual stop orders.
  assert.ok(cand!.tags.includes('诱多·扫位收回候选'));
  const approx = runScan(cs, '5m', undefined, 'TEST', 'r15', null).confirm.find(c => c.idx === SWEEP)!;
  assert.equal(approx.flowSource, 'approx');
  assert.ok(cand!.proba >= approx.proba, `真实订单流确认应不低于近似：${cand!.proba} vs ${approx.proba}`);
  console.log('PASS 双顶扫高收回 + 主动卖出占优 → 诱多，下跌概率', cand!.proba, '（近似', approx.proba, '）');
}

// ── 场景 2：W 双底镜像 → 诱空 ──
{
  const { cs, flow, SWEEP } = doubleTopTrap();
  const mirrored: Candle[] = cs.map(c => ({ ts: c.ts, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c, v: c.v }));
  const mflow: FlowSnapshot = { ...flow, bars: new Map([...flow.bars].map(([ts, b]) => [ts, { ...b, buy: b.sell, sell: b.buy }])) };
  const sig = scanDoubles(mirrored, { ...DEFAULT_PARAMS, entryMode: 'confirm', trendBlock: 50 }).signals.find(s => s.idx === SWEEP && s.pattern === 'db_reject');
  assert.ok(sig, '镜像后应识别出双底二次测试');
  const read = readSecondTest(buildContext(mirrored, mflow), sig!);
  assert.equal(read.scene, 'doubleBottom');
  assert.equal(read.trap.kind, 'bearTrap', `应判定诱空，评分 ${read.trap.score}`);
  console.log('PASS 双底扫低收回 + 主动买入占优 → 诱空');
}

// ── 场景 3：真突破后缩量回踩并守住 → 可跟随；放量跌回 → 假突破 ──
function breakoutScenario(kind: 'follow' | 'failed' | 'chase') {
  const segs: Seg[] = [
    { to: 95, bars: 60, vol: V, flow: 0 },
    { to: 100, bars: 40, vol: 1.4 * V, flow: 0.3 },
    { to: 97, bars: 40, vol: V, flow: -0.25 },
    { to: 99.4, bars: 39, vol: 0.9 * V, flow: 0.1 },
  ];
  const BREAK = 179;
  const after: Seg[] =
    kind === 'chase'
      ? [{ to: 101.3, bars: 2, vol: 1.3 * V, flow: 0.2 }]
      : [
          { to: 101.4, bars: 8, vol: 1.3 * V, flow: 0.2 }, // 冲击段
          kind === 'follow'
            ? { to: 100.3, bars: 8, vol: 0.5 * V, flow: -0.05 } // 缩量回踩（最低价触及回踩区但收盘不跌回）
            : { to: 99.7, bars: 8, vol: 1.6 * V, flow: -0.3 }, // 放量跌回
          kind === 'follow' ? { to: 100.9, bars: 4, vol: 0.9 * V, flow: 0.15 } : { to: 99.2, bars: 4, vol: 1.2 * V, flow: -0.2 },
        ];
  const { cs, ratios } = build(95, [...segs, { to: kind === 'chase' ? 101.1 : 100.5, bars: 1, vol: 2 * V, flow: 0.25 }, ...after], (i, c) => {
    if (i === BREAK) return { ...c, o: 99.4, h: kind === 'chase' ? 101.2 : 100.6, l: 99.3, c: kind === 'chase' ? 101.1 : 100.5, v: (kind === 'chase' ? 3 : 1.8) * V };
    return c;
  });
  return { cs, flow: flowOf(cs, ratios, { [BREAK]: 0.25 }), BREAK };
}

{
  const { cs, flow, BREAK } = breakoutScenario('follow');
  const ctx = buildContext(cs, flow);
  const levels = findSwingLevels(ctx);
  const top = levels.find(l => l.side === 'top' && Math.abs(l.price - 100.25) < 0.3);
  assert.ok(top, `应找到 100 附近的摆动高点，实际 ${JSON.stringify(levels.map(l => [l.side, l.price, l.breakIdx]))}`);
  assert.equal(top!.breakIdx, BREAK, '应在突破K处标记收盘突破');
  const read = readBreakout(ctx, top!, BREAK, ctx.n - 1);
  assert.ok(read.pullback.touched && read.pullback.held && !read.pullback.failed, `回踩应触及并守住：${JSON.stringify(read.pullback)}`);
  assert.equal(read.verdict, 'follow');
  assert.ok(read.followProb > 0.6, `可跟随概率应 > 60%，实际 ${read.followProb}`);
  assert.ok(read.pullback.volRatio < 0.8, '回踩应缩量');
  console.log('PASS 真突破 · 缩量回踩守住 →', read.headline);

  const early = readBreakout(ctx, top!, BREAK, BREAK + 10);
  assert.ok(['wait_pullback', 'chase_risk', 'strong_hold'].includes(early.verdict), `回踩未到位前不应给出跟随：${early.verdict}`);
}

{
  const { cs, flow, BREAK } = breakoutScenario('failed');
  const ctx = buildContext(cs, flow);
  const top = findSwingLevels(ctx).find(l => l.side === 'top' && l.breakIdx === BREAK)!;
  const read = readBreakout(ctx, top, BREAK, ctx.n - 1);
  assert.equal(read.verdict, 'failed');
  assert.ok(read.followProb < 0.25, `假突破后跟随概率应很低，实际 ${read.followProb}`);
  assert.ok(read.reasons.some(r => r.includes('突破失败')));
  console.log('PASS 放量跌回关键位 → 假突破/诱多，不跟随');
}

{
  const { cs, flow, BREAK } = breakoutScenario('chase');
  const ctx = buildContext(cs, flow);
  const top = findSwingLevels(ctx).find(l => l.side === 'top' && l.breakIdx === BREAK)!;
  const read = readBreakout(ctx, top, BREAK, ctx.n - 1);
  assert.equal(read.verdict, 'chase_risk');
  assert.ok(read.impulse.climax, '3x 放量且离位 >1.2 ATR 应判为冲高过急');
  console.log('PASS 刚突破放量离位 → 不追，等回踩');
}

// ── 场景 4：历史突破统计可运行且分桶合理 ──
{
  const { cs, flow } = breakoutScenario('follow');
  const { events, stats } = scanBreakouts(buildContext(cs, flow));
  assert.ok(events.length >= 1);
  const total = Object.values(stats.buckets).reduce((s, b) => s + b.n, 0) + stats.chase.n;
  assert.ok(total >= 1, '应有统计样本');
  console.log('PASS 历史突破统计', JSON.stringify(stats));
}

// ── 场景 5：触顶但没有超过前高 —— 订单流决定是“假突破”还是“真突破” ──
function touchScene(kind: 'weak' | 'strong' | 'accepted') {
  const segs: Seg[] = [
    { to: 95, bars: 60, vol: V, flow: 0 },
    { to: 100, bars: 40, vol: 1.4 * V, flow: 0.3 }, // 第一顶
    { to: 96, bars: 40, vol: V, flow: -0.25 }, // 回落
    ...(kind === 'strong'
      ? [{ to: 99.9, bars: 30, vol: 2.2 * V, flow: 0.45 }] // 放量、主动买入强劲地冲向前高
      : [
          { to: 98.3, bars: 18, vol: 1.2 * V, flow: 0.1 }, // 先有一段正常推进
          { to: 99.9, bars: 12, vol: 0.55 * V, flow: -0.1 }, // 靠近前高时缩量、主动买入转弱
        ]),
  ];
  const total = 60 + 40 + 40 + 30;
  const { cs, ratios } = build(95, segs, (i, c) =>
    kind === 'accepted' && i >= total - 2 ? { ...c, o: c.c, h: c.c + 1.3, l: c.c - 0.1, c: c.c + 1.1, v: 2 * V } : c,
  );
  const flow = flowOf(cs, ratios);
  const ctx = buildContext(cs, flow);
  const lv = findSwingLevels(ctx).find(l => l.side === 'top')!;
  return { ctx, lv };
}

{
  const w = touchScene('weak');
  const weak = readTouch(w.ctx, w.lv, w.ctx.n - 1);
  assert.equal(weak.verdict, 'reject', `缩量弱买入触顶应判拒绝：${weak.headline}`);
  assert.ok(weak.fakeProb >= 0.6, `假突破概率应 ≥60%，实际 ${weak.fakeProb}`);
  assert.ok(weak.plan && weak.plan.stop > weak.plan.entry && weak.plan.entry > weak.plan.tp, '做空计划：止损 > 入场 > 目标');

  const s = touchScene('strong');
  const strong = readTouch(s.ctx, s.lv, s.ctx.n - 1);
  assert.equal(strong.verdict, 'breakout', `放量强买冲击前高应判真突破：${strong.headline}`);
  assert.ok(strong.fakeProb <= 0.4, `假突破概率应 ≤40%，实际 ${strong.fakeProb}`);
  assert.ok(weak.fakeProb - strong.fakeProb > 0.3, '同一几何下，订单流不同，概率必须明显不同');

  const k = touchScene('accepted');
  const acc = readTouch(k.ctx, k.lv, k.ctx.n - 1);
  assert.equal(acc.kind, 'accepted');
  assert.equal(acc.verdict, 'breakout');
  assert.equal(acc.plan, null, '突破被接受后不再给反手计划');
  console.log('PASS 触顶订单流 · 弱买入', weak.fakeProb, '→ 假突破；强买入', strong.fakeProb, '→ 真突破；站上前高 → 不做空');
}

// ── 场景 6：触顶历史统计可运行 ──
{
  const { ctx } = touchScene('weak');
  const { stats } = scanTouches(ctx);
  assert.ok(stats.n >= 0 && stats.reject <= stats.n);
  console.log('PASS 触顶历史统计', JSON.stringify(stats));
}

console.log('\n订单流判读测试全部通过');
