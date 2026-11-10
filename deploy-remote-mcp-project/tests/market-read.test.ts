// 回归：图上标注精简（2026-11-10 用户确认的示例）。
// 1. 引擎：突破 / 跌破 / 假突破 / 假跌破（含收盘卡在缓冲带里、先假后真、跌破后又收回）
// 2. 合带有宽度上限；只取上下最近的一条带；两边都被试过 → 箱顶 / 箱底
// 3. 按 BTC 11-10 20:15 实盘复刻：右上角盘面、右侧标签、K 线标记、缺口的文案
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { buildContext } from '@/quant/context';
import { buildFrameworks, type FrameworkReport } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';
import { levelTests, type LevelTest } from '@/quant/liquidity';
import { groupBands, pickTests, trendOf, type BandItem } from '@/quant/marketRead';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const MS = 300_000;

// ─── 1. 引擎 ────────────────────────────────────────────────
{
  const T0 = Date.UTC(2026, 10, 10, 0, 0);
  const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ ts: T0 + i * MS, o, h, l, c, v: 1000, confirm: 1, volumeSource: 'quote' });
  /** 收盘价沿 path 走，影线各 0.2 */
  const walk = (from: number, closes: number[], start: number): Candle[] => closes.map((c, k) => {
    const o = k ? closes[k - 1] : start;
    return bar(from + k, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
  });
  const line = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => a + (b - a) * (k + 1) / n);
  // 110 → 100.4 一路跌，第 30 根做出低点 100.0，再涨到 104，再回落到 100.6
  const base = (): Candle[] => {
    const cs = walk(0, line(110, 100.4, 30), 110.2);
    cs.push(bar(30, 100.4, 100.6, 100.0, 100.3));
    cs.push(...walk(31, line(100.3, 104, 15), 100.3));
    cs.push(...walk(46, line(104, 100.6, 14), 104));
    return cs;
  };

  // A. 第 60 根刺到 99.6，收盘 100.4 收回 → 假跌破
  const a = [...base(), bar(60, 100.6, 100.7, 99.6, 100.4), ...walk(61, line(100.4, 102, 10), 100.4)];
  const ta = levelTests(buildContext(a)).filter(t => t.level === 100);
  assert.equal(ta.length, 1, JSON.stringify(ta));
  assert.deepEqual([ta[0].kind, ta[0].side, ta[0].ts, ta[0].extreme, ta[0].close, ta[0].confirmTs], ['false', 'below', a[60].ts, 99.6, 100.4, null]);

  // B. 第 60 根收盘 99.98 卡在缓冲带里 → 第 61 根收回才算假跌破（小尾巴指到 61）；第 62 根收盘 99.6 跌穿 → 先假后真
  const b = [...base(), bar(60, 100.6, 100.7, 99.7, 99.98), bar(61, 99.98, 100.4, 99.9, 100.3), bar(62, 100.3, 100.4, 99.5, 99.6), ...walk(63, line(99.6, 98.5, 8), 99.6)];
  const tb = levelTests(buildContext(b)).filter(t => t.level === 100);
  assert.equal(tb.length, 1);
  assert.deepEqual([tb[0].kind, tb[0].ts, tb[0].falseFirstTs, tb[0].reclaim], ['break', b[62].ts, b[60].ts, null]);
  const delayed = levelTests(buildContext(b.slice(0, 62))).find(t => t.level === 100)!;
  assert.deepEqual([delayed.kind, delayed.ts, delayed.confirmTs, delayed.confirmClose], ['false', b[60].ts, b[61].ts, 100.3]);

  // C. 跌穿之后 1 根就收回 100 上面（6 根以内）→ 跌破失败，整段算一次假跌破（标在冲进去的第一根，小尾巴指到收回那根）
  const c = [...b.slice(0, 63), bar(63, 99.6, 100.3, 99.5, 100.2), bar(64, 100.2, 100.4, 100.1, 100.25), bar(65, 100.25, 100.5, 100.1, 100.3)];
  const tc = levelTests(buildContext(c)).find(t => t.level === 100)!;
  assert.deepEqual([tc.kind, tc.ts, tc.confirmTs, tc.brokeTs, tc.extreme, tc.inLo, tc.inHi], ['false', c[60].ts, c[63].ts, c[62].ts, 99.5, 99.6, 100.3]);

  // D. 跌穿之后一路跌了 8 根，第 73 根才收回上面并留在上面 → 还是「跌破」，只是后来又收回（失败）
  const d = [...b.slice(0, 71), ...walk(71, [99.0, 99.5, 100.1, 100.3, 100.4], 98.5)];
  const td = levelTests(buildContext(d)).find(t => t.level === 100)!;
  assert.deepEqual([td.kind, td.ts, td.reclaim], ['break', d[62].ts, { count: 3, firstTs: d[73].ts, lastTs: d[75].ts, now: true }]);
  pass('1 · 引擎：假跌破、收盘卡在区里等后面收回、先假后真、跌破后 6 根内收回 = 假跌破、更晚收回 = 跌破失败');

  // 图上：先假后真写进跌破的悬停；6 根内收回画成「假跌破」；更晚收回改叫「跌破又收回」，不再说谁占上风
  const rb = buildFrameworks(b, MS, 'SOL-USDT-SWAP', '5m', null, b.at(-1)!.ts + MS + 1)!;
  const mb = projectFrameworkMarks(rb, DEFAULT_FRAMEWORK_MARK_PREFS, MS).payload;
  const eb = mb.events.find(e => e.ts === b[62].ts)!;
  assert.equal(eb.text, '跌破');
  assert.equal(eb.detail![0], '13:00 先刺下去又收回，13:10 收盘跌穿 —— 先假后真，空头占上风。');
  assert.match(eb.detail![1], /^之后最高反弹到 \d+\.\d+，没回到 100\.00 上面 → 跌破还有效。$/);
  assert.ok(!mb.events.some(e => e.ts === b[60].ts), '被后来的跌破吃掉的那次假跌破不再单独画');
  const mc = projectFrameworkMarks(buildFrameworks(c, MS, 'SOL-USDT-SWAP', '5m', null, c.at(-1)!.ts + MS + 1)!, DEFAULT_FRAMEWORK_MARK_PREFS, MS).payload;
  const ec = mc.events.find(e => e.ts === c[60].ts)!;
  assert.equal(ec.text, '假跌破');
  assert.equal(ec.confirmTs, c[63].ts);
  assert.equal(ec.detail![0], '13:00–13:10 收在 99.60–100.30，最低跌到 99.50，没站住；13:15 收回 100.20。');
  assert.equal(ec.detail![1], '之后收盘跌破 99.50 才算真跌破。');
  assert.ok(!mc.events.some(e => e.text.includes('又收回')), '6 根内收回不再画成「跌破又收回」');
  const md = projectFrameworkMarks(buildFrameworks(d, MS, 'SOL-USDT-SWAP', '5m', null, d.at(-1)!.ts + MS + 1)!, DEFAULT_FRAMEWORK_MARK_PREFS, MS).payload;
  const ed = md.events.find(e => e.ts === d[62].ts)!;
  assert.equal(ed.text, '跌破又收回');
  assert.equal(ed.tone, 'neck');
  assert.equal(ed.detail![0], '13:00 先刺下去又收回，13:10 收盘跌穿。');
  assert.equal(ed.detail![1], '14:05 起收回 100.00 上面 → 这次跌破失败了。');
  pass('2 · 图上：先假后真、6 根内收回画成「假跌破」、更晚收回叫「跌破又收回」且不再说「空头占上风」');
}

// ─── SOL 11-10 实盘：20:45–21:10 在 84.84 / 84.87 两次没过去的高点上面磨了 5 根又跌回来 ─────
{
  const bjTs = (h: number, m: number) => Date.UTC(2026, 10, 10, h - 8, m);
  const SOL: [string, number, number, number, number][] = [
    ['18:05', 85.33, 85.39, 85.23, 85.34], ['18:10', 85.34, 85.39, 85.19, 85.28], ['18:15', 85.28, 85.32, 85.05, 85.15], ['18:20', 85.16, 85.18, 85.05, 85.11],
    ['18:25', 85.11, 85.25, 84.93, 85.24], ['18:30', 85.23, 85.25, 84.42, 84.64], ['18:35', 84.64, 84.69, 84.47, 84.61], ['18:40', 84.61, 84.62, 84.26, 84.5],
    ['18:45', 84.5, 84.62, 84.3, 84.61], ['18:50', 84.61, 84.68, 84.54, 84.54], ['18:55', 84.54, 84.61, 84.37, 84.4], ['19:00', 84.4, 84.5, 84.18, 84.48],
    ['19:05', 84.48, 84.58, 84.38, 84.58], ['19:10', 84.58, 84.77, 84.57, 84.77], ['19:15', 84.76, 84.87, 84.46, 84.47], ['19:20', 84.46, 84.47, 84.34, 84.43],
    ['19:25', 84.42, 84.53, 84.38, 84.51], ['19:30', 84.5, 84.54, 84.12, 84.48], ['19:35', 84.48, 84.59, 84.48, 84.57], ['19:40', 84.57, 84.59, 84.45, 84.59],
    ['19:45', 84.6, 84.77, 84.57, 84.69], ['19:50', 84.7, 84.74, 84.65, 84.66], ['19:55', 84.66, 84.69, 84.61, 84.65], ['20:00', 84.65, 84.7, 84.54, 84.59],
    ['20:05', 84.59, 84.68, 84.56, 84.62], ['20:10', 84.63, 84.74, 84.6, 84.74], ['20:15', 84.73, 84.84, 84.68, 84.69], ['20:20', 84.69, 84.83, 84.68, 84.69],
    ['20:25', 84.7, 84.76, 84.61, 84.7], ['20:30', 84.7, 84.7, 84.52, 84.65], ['20:35', 84.64, 84.69, 84.6, 84.64], ['20:40', 84.64, 84.75, 84.64, 84.71],
    ['20:45', 84.71, 84.89, 84.69, 84.86], ['20:50', 84.87, 84.96, 84.79, 84.85], ['20:55', 84.85, 84.94, 84.84, 84.92], ['21:00', 84.91, 84.95, 84.77, 84.85],
    ['21:05', 84.84, 84.86, 84.75, 84.86], ['21:10', 84.87, 84.97, 84.8, 84.8], ['21:15', 84.81, 84.84, 84.55, 84.63], ['21:20', 84.64, 84.75, 84.64, 84.71],
  ];
  const at = (t: string) => { const [h, m] = t.split(':').map(Number); return bjTs(h, m); };
  const k = (ts: number, o: number, h: number, l: number, c: number): Candle => ({ ts, o, h, l, c, v: 1000, confirm: 1, volumeSource: 'quote' });
  // 18:05 之前：从 86.6 平稳跌下来（只用来算平均波动，不制造高低点）
  const warm: Candle[] = Array.from({ length: 60 }, (_, i) => {
    const p = 86.6 - (86.6 - 85.36) * (i + 1) / 60;
    return k(at('18:05') - (60 - i) * MS, p + 0.02, p + 0.1, p - 0.1, p);
  });
  const cs = [...warm, ...SOL.map(([t, o, h, l, c]) => k(at(t), o, h, l, c))];
  const tests = levelTests(buildContext(cs));
  const highs = tests.filter(t => t.side === 'above');
  assert.equal(highs.length, 1, `84.84 / 84.87 是同一组高点，只出一个事件：${JSON.stringify(highs.map(t => [t.kind, t.level]))}`);
  const f = highs[0];
  assert.deepEqual([f.kind, f.zoneLo, f.zoneHi, f.touches, f.ts, f.confirmTs, f.brokeTs, f.extreme, f.inLo, f.inHi, f.confirmClose],
    ['false', 84.84, 84.87, 2, at('20:45'), at('21:10'), at('20:55'), 84.97, 84.85, 84.92, 84.8]);
  pass('3 · SOL 实盘：84.84 / 84.87 算一个区，20:45–21:10 冲上去又跌回来只出一次「假突破」（20:55 收盘站上过，21:10 收回）');

  const report = buildFrameworks(cs, MS, 'SOL-USDT-SWAP', '5m', null, at('21:20') + MS + 1)!;
  const m = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  const ev = m.payload.events.find(e => e.side === 'above')!;
  assert.equal(ev.text, '假突破');
  assert.equal(ev.title, '假突破 · 84.84–84.87（两次没过去的高点）');
  assert.deepEqual(ev.detail, ['20:45–21:05 收在 84.85–84.92，最高冲到 84.97，没站稳；21:10 收回 84.80。', '之后收盘站上 84.97 才算真突破。']);
  assert.equal(ev.confirmTs, at('21:10'));
  assert.ok(!m.payload.events.some(e => e.text.includes('又跌回')), '不再出现「突破又跌回」');
  const P = m.payload.levels.find(l => l.id === 'fw:band:pressure')!;
  assert.deepEqual(P.range, [84.75, 84.97], '冲上去又跌回来的 84.84–84.97 和下面 21:10 的小缺口合成一条压力带');
  assert.equal(P.detail![0], '20:45–21:10 冲上去又跌回来的 84.84–84.97；还叠着 21:10 留下的缺口 84.75–84.80。');
  assert.ok(P.detail![1].includes('收盘站上 84.97 → 这条压力带作废'), P.detail![1]);
  const S = m.payload.levels.find(l => l.id === 'fw:band:support')!;
  assert.deepEqual(S.range, [84.52, 84.55]);
  assert.equal(S.detail![0], '20:30 跌到 84.52、21:15 跌到 84.55，两次都弹了回来。');
  assert.ok(m.hud!.detail.includes('20:45 往上冲过 84.84–84.87 没站稳，21:10 收回下面 —— 突破失败。'), JSON.stringify(m.hud!.detail));
  assert.ok(m.hud!.detail.some(l => l.startsWith('现在 84.71 贴着压力带 84.75–84.97 的下沿，21:20 冲到 84.75 没收上去')), JSON.stringify(m.hud!.detail));
  pass('4 · SOL 实盘：图上是「假突破」，压力带 84.75–84.97、支撑带 84.52–84.55（21:15 那次也算），盘面说突破失败');
}

// ─── 2. 合带 ────────────────────────────────────────────────
{
  const it = (key: string, lo: number, hi = lo): BandItem => ({ key, lo, hi, desc: key, short: key });
  // 间隔不超过 0.8、合起来不超过 1.5 个波动单位才并成一带
  const bands = groupBands([it('a', 99.2), it('b', 99.27), it('c', 99.7), it('d', 99.78, 99.84), it('e', 99.86, 100.1), it('f', 101)], 0.1, 99.5);
  assert.deepEqual(bands.map(b => [b.lo, b.hi, b.items.length, b.kind]), [[99.2, 99.27, 2, 'support'], [99.7, 99.84, 2, 'pressure'], [99.86, 100.1, 1, 'pressure'], [101, 101, 1, 'pressure']]);
  const split = groupBands([it('x', 99.4), it('y', 99.45, 99.55), it('z', 99.58)], 0.1, 99.5);
  assert.deepEqual(split.map(b => [b.lo, b.hi, b.kind, b.inside]), [[99.4, 99.4, 'support', false], [99.45, 99.58, 'pressure', true]]);
  pass('5 · 合带：挨得近才并、一条带最多 1.5 个波动单位宽；现价上下两边分开');
}

// ─── 3. BTC 11-10 20:15 复刻 ────────────────────────────────
const bj = (h: number, m: number, dayOffset = 0) => Date.UTC(2026, 10, 10 + dayOffset, h - 8, m);
const ROWS: [string, number, number, number, number][] = [
  ['17:55', 74430.9, 74518.2, 74428.4, 74480.1], ['18:00', 74480, 74525, 74400, 74400.1], ['18:05', 74400, 74440, 74363.3, 74395.7],
  ['18:10', 74395.7, 74395.7, 74325, 74369.7], ['18:15', 74369.7, 74382.9, 74258.8, 74292.8], ['18:20', 74292.9, 74301.8, 74215.4, 74282.3],
  ['18:25', 74282.7, 74314.2, 74167.8, 74298], ['18:30', 74298, 74306.6, 74180.7, 74271.7], ['18:35', 74271.7, 74271.7, 74207.8, 74233.7],
  ['18:40', 74233.7, 74233.7, 74073.9, 74151.8], ['18:45', 74151.8, 74212.3, 74077, 74207.3], ['18:50', 74207.3, 74231, 74168.7, 74175.7],
  ['18:55', 74175.7, 74219.7, 74154.7, 74191.8], ['19:00', 74191.8, 74216.7, 74105, 74214.6], ['19:05', 74214.6, 74214.6, 74147.4, 74210],
  ['19:10', 74210, 74333, 74209.9, 74319.9], ['19:15', 74320, 74391.5, 74207.4, 74207.4], ['19:20', 74207.5, 74241.7, 74169.2, 74235.9],
  ['19:25', 74235.9, 74288, 74203.8, 74281.7], ['19:30', 74281.6, 74281.6, 74088.8, 74212.7], ['19:35', 74212.6, 74280, 74204.8, 74272.6],
  ['19:40', 74272.5, 74333, 74213.1, 74332.2], ['19:45', 74332.1, 74428.7, 74332.1, 74392.4], ['19:50', 74392.4, 74414.9, 74352.3, 74358.6],
  ['19:55', 74358.5, 74380, 74336.1, 74380], ['20:00', 74380, 74384, 74315.2, 74324.2], ['20:05', 74324.2, 74336.4, 74278, 74291.7],
  ['20:10', 74291.8, 74324.5, 74260.2, 74324.5], ['20:15', 74324.5, 74368.9, 74270, 74288.3],
];
const at = (s: string) => { const [h, m] = s.split(':').map(Number); return bj(h, m); };
const recent = ROWS.map(([t, o, h, l, c]) => ({ ts: at(t), o, h, l, c }));
const pool = (side: 'above' | 'below', price: number, ts: number, touches = 1, firstTs = ts) => ({
  side, price, touches, equal: touches >= 2, active: true, firstTs, lastTs: ts, firstConfirmedTs: firstTs + 5 * MS, confirmedTs: ts + 5 * MS, distanceAtr: 1,
});
const test = (t: Partial<LevelTest> & Pick<LevelTest, 'kind' | 'side' | 'level' | 'ts' | 'extreme' | 'close'>): LevelTest => ({
  levelTs: t.ts - 30 * MS, touches: 1, idx: 0, ageBars: 0, confirmTs: null, confirmClose: null, effortRatio: null,
  falseFirstTs: null, retests: [], reclaim: null, ...t,
});
const fakeBreak = test({ kind: 'break', side: 'below', level: 74302.1, levelTs: bj(22, 35, -1), ts: at('17:05'), extreme: 74217.6, close: 74230 });
const tests: LevelTest[] = [
  test({ kind: 'false', side: 'above', level: 74391.5, levelTs: at('19:15'), ts: at('19:45'), extreme: 74428.7, close: 74392.4, confirmTs: at('19:50'), confirmClose: 74358.6 }),
  test({ kind: 'false', side: 'below', level: 74137.3, levelTs: at('17:10'), ts: at('18:40'), extreme: 74073.9, close: 74151.8, retests: [{ ts: at('19:30'), extreme: 74088.8 }] }),
  test({ kind: 'break', side: 'below', level: 74347, levelTs: bj(11, 30), ts: at('17:05'), extreme: 74217.6, close: 74230, falseFirstTs: at('17:00'), reclaim: { count: 3, firstTs: at('19:45'), lastTs: at('19:55'), now: false } }),
  fakeBreak,
];
const swing = (side: 'above' | 'below', price: number, ts: number) => ({ side, price, ts, confirmedTs: ts + 5 * MS, broken: false });
const report = {
  symbol: 'BTC-USDT-SWAP', bar: '5m', lastPrice: 74288.3, lastTs: at('20:15'), bars: 1200, atr: 96.1, coverage: 0, source: 'price',
  quality: { auctionVolumeReady: true, issues: [], forming: 0 },
  auction: {
    profile: { poc: 74675, vah: 74880, val: 74310, window: { bars: 120, fromTs: 0, toTs: 0 }, bins: [], bin: 10, position: 'below', pocDistanceAtr: 4, valueWidthAtr: 6 },
    migration: null, lowVolumeNodes: [], bias: 0, strength: 0, regimeReason: '',
  },
  liquidity: {
    pools: [pool('above', 74391.5, at('19:15')), pool('above', 74525, at('18:00')), pool('below', 74137.3, at('17:10')), pool('below', 74075.1, at('19:30'), 3, bj(17, 25, -1))],
    nearestAbove: null, nearestBelow: null, poolAbove: null, poolBelow: null, pendingAbove: null, pendingBelow: null,
    stopHunts: [], structure: null, structureTs: null, structureAgeBars: null,
    tests,
    swings: [swing('below', 74137.3, at('17:10')), swing('above', 74525, at('18:00')), swing('below', 74073.9, at('18:40')), swing('above', 74391.5, at('19:15')), swing('below', 74088.8, at('19:30'))],
    bias: 0, strength: 0, headline: '',
  },
  wyckoff: {
    effort: {}, phase: 'balance', phaseReason: '', bias: 0, strength: 0, springs: [],
    imbalances: [{ kind: 'bearish', from: 0, to: 2, lo: 74406.4, hi: 74585.8, touched: true, filled: false, fillIdx: null, aligned: false, fromTs: at('16:55'), toTs: at('17:05') }],
  },
  mtf: {
    rows: [
      { tf: '5m', bias: 'range', insufficient: false, recentPivots: [] },
      { tf: '15m', bias: 'bear', insufficient: false, recentPivots: [] },
      { tf: '30m', bias: 'range', insufficient: false, recentPivots: [] },
      { tf: '1H', bias: 'range', insufficient: false, recentPivots: [] },
    ],
  },
  confluence: { verdict: 'neutral', long: 0, short: 1, neutral: 3, unavailable: 0, net: -0.6, headline: '' },
  recent,
} as unknown as FrameworkReport;
const refs = [{ name: '今天亚盘最低价', price: 74347 }, { name: '今天亚盘最高价', price: 75396 }];
const m = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS, { refs });

// 4. 同一根上的两次跌破：说今天亚盘最低价那个
{
  const picked = pickTests(tests, refs, report.atr);
  assert.equal(picked.filter(t => t.ts === at('17:05')).length, 1);
  assert.equal(picked.find(t => t.ts === at('17:05'))!.level, 74347);
  pass('6 · 同一根跌穿两个低点时，说分量重的那个（今天亚盘最低价 74347）');
}

// 5. 右上角盘面：箱体
{
  assert.equal(m.hud!.verdict, '观望');
  assert.equal(m.hud!.title, '盘面：先观望 · 在箱子里');
  assert.deepEqual(m.hud!.detail, [
    '18:40 以后一直在 74074–74429 之间来回，已经 1 小时 40 分钟。',
    '两头都试过：19:15、19:45 冲上沿都没站稳，18:40、19:30 跌下沿都收了回来。',
    '现在 74288 在箱子中间，两头都不划算，等它走到边上。',
    '收盘站上 74429 → 偏多，先看 74525–74586 一带；收盘跌破 74074 → 偏空。',
  ]);
  pass('7 · 右上角「盘面：先观望 · 在箱子里」：多久、两头各试过几次、现在在哪、往哪边破算什么');
}

// 6. 右侧只剩箱顶、箱底、成交最多；前高前低、密集区上下沿不再单独出线和标签
{
  const labeled = m.payload.levels.filter(l => l.label);
  assert.deepEqual(labeled.map(l => l.name), ['箱顶', '箱底', '成交最多']);
  const top = m.payload.levels.find(l => l.name === '箱顶')!;
  assert.deepEqual(top.range, [74391.5, 74428.7]);
  assert.equal(top.fromTs, at('19:15'));
  assert.deepEqual(top.detail, [
    '19:15 冲到 74391.5、19:45 冲到 74428.7，两次都收了回来。',
    '再到这里压不上去，我才考虑空；收盘站上 74429 → 箱子向上破，上面先看 74525–74586 一带。',
  ]);
  const bottom = m.payload.levels.find(l => l.name === '箱底')!;
  assert.deepEqual(bottom.range, [74073.9, 74137.3]);
  assert.deepEqual(bottom.detail, [
    '18:40 跌到 74073.9、19:30 跌到 74088.8，两次都弹了回来。',
    '回到这里守得住，我才考虑多；收盘跌破 74074 → 箱子向下破。',
  ]);
  const poc = m.payload.levels.find(l => l.id === 'fw:amt:poc')!;
  assert.deepEqual(poc.detail, ['最近 10 小时成交最多的价格，现在价格在它下面。', '（按 K 线成交额估算）']);
  assert.equal(m.payload.levels.length, 3, '没有别的线');
  pass('8 · 右侧只剩「箱顶 74392–74429」「箱底 74074–74137」「成交最多」，悬停写清哪几次碰到、往哪破算什么');
}

// 7. K 线上只剩 3 个标记：跌破、假跌破、假突破
{
  const ev = [...m.payload.events].sort((a, b) => a.ts - b.ts);
  assert.deepEqual(ev.map(e => e.text), ['跌破', '假跌破', '假突破']);
  assert.equal(ev[0].title, '跌破 · 74347（今天亚盘最低价）');
  assert.deepEqual(ev[0].detail, [
    '17:00 先刺下去又收回，17:05 一根跌穿 74347、74302 两层。',
    '19:45–19:55 又收回上面 3 根，然后又掉了下来；这条线现在夹在箱子中间，分量变轻。',
  ]);
  assert.equal(ev[1].title, '假跌破 · 74137（17:10 的低点）');
  assert.deepEqual(ev[1].detail, ['18:40 跌到 74073.9，收盘 74151.8 又回到上面。', '19:30 再跌到 74088.8 也收了回来 → 这一带是箱底。']);
  assert.equal(ev[2].title, '假突破 · 74392（19:15 的高点）');
  assert.deepEqual(ev[2].detail, ['19:45 冲到 74428.7，收盘只高 0.9，没站稳；19:50 收回到 74358.6。', '之后收盘站上 74429 才算真突破。']);
  assert.equal(ev[2].confirmTs, at('19:50'), '小尾巴指到收回的那根');
  assert.deepEqual(ev.map(e => [e.side, e.tone, e.marker]), [['below', 'short', 'diamond'], ['below', 'long', 'tri'], ['above', 'short', 'tri']]);
  pass('9 · K 线上只剩「跌破」「假跌破」「假突破」，悬停 2 行：发生了什么 → 接下来怎么看');
}

// 8. 缺口只画还没补的那一截，不写「容易」
{
  assert.equal(m.payload.zones.length, 1);
  const z = m.payload.zones[0];
  assert.deepEqual([z.lo, z.hi, z.text], [74525, 74585.8, '缺口']);
  assert.equal(z.title, '缺口 74525–74586（还没补的部分）');
  assert.deepEqual(z.detail, ['16:55 一口气跌下来留下的，18:00 补到了 74525.0。', '涨到 74586 就补满了。']);
  const all = JSON.stringify(m);
  assert.ok(!/容易|常回到|最容易|止损单|FVG|BOS|CHoCH|HH|LL|EQL|EQH/.test(all), '不写回测不支持的「容易 / 常」，不用术语');
  pass('10 · 缺口只画还没补的 74525–74586，悬停不写「容易被压下来」；全图不再出现 FVG / BOS / HH 等术语');
}

// 9. 趋势：没有假突破就不是箱子；跟着大方向，等反抽到压力带
{
  const rows = report.mtf.rows.map((r, i) => (i ? { ...r, bias: 'bear' } : r));
  const trendReport = { ...report, mtf: { rows }, liquidity: { ...report.liquidity, tests: tests.slice(1) } } as unknown as FrameworkReport;
  assert.equal(trendOf(trendReport).text, '大方向向下：15 分钟、30 分钟、1 小时都在跌');
  const t = projectFrameworkMarks(trendReport, DEFAULT_FRAMEWORK_MARK_PREFS, MS, { refs });
  assert.equal(t.hud!.title, '盘面：偏空 · 等反抽');
  assert.deepEqual(t.hud!.detail, [
    '大方向向下：15 分钟、30 分钟、1 小时都在跌。17:05 一根跌穿今天亚盘最低价 74347。',
    '现在 74288：上面压力带 74392 还差 0.1%，下面支撑带 74074–74137 还差 0.2%。',
    '反抽到 74392 压不上去再空；收盘站上 74392 → 我看错了，先看 74525–74586 一带。',
    '下面 74074–74137 是 17:10、18:40、19:30 三次跌下去又弹回来的地方，跌破收不回就继续往下。',
  ]);
  assert.deepEqual(t.payload.levels.filter(l => l.label).map(l => l.name), ['压力带', '支撑带', '成交最多']);
  pass('11 · 趋势里「盘面：偏空 · 等反抽」：只有一个看错价（收盘站上压力带上沿）');
}

// 10. 底栏与右上角同一个结论；标注关掉时没有盘面
{
  const off = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, enabled: false }, MS, { refs });
  assert.equal(off.hud, null);
  const noLabels = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, labels: false }, MS, { refs });
  assert.ok(noLabels.payload.levels.every(l => !l.label) && noLabels.payload.events.every(e => e.text === '') && noLabels.payload.zones.every(z => z.text === ''));
  pass('12 · 关掉标注没有盘面；关掉文字标签只留色带、线和小标记');
}

console.log(`market-read: ${passed} 项通过`);
