// 回归：显示时区改为北京时间（日线 / 日界 / 周线按北京日 00:00），以及结构标注延时优化：
// 收盘即时重算、收盘看门狗、待确认前高/前低、分形确认尾巴。
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { displayDayFloor, fmtClock, fmtDateTime, fmtMonthDay } from '@/lib/displayTime';
import { fmtDateTime as legacyFmtDateTime, fmtTime as legacyFmtTime } from '@/lib/format';
import { resample } from '@/quant/fractal';
import { buildContext } from '@/quant/context';
import { pendingSwings, readLiquidity } from '@/quant/liquidity';
import { buildFrameworks } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';
import { computeDailyDividers, computeSessionSpans } from '@/vela/sessions/sessionMath';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const H = 3_600_000, DAY = 86_400_000, MS = 300_000, T0 = 1_800_000_000_000;

// 1. 北京时间格式化与北京日界
{
  const ts = Date.UTC(2026, 10, 9, 22, 50);
  assert.equal(fmtDateTime(ts), '11-10 06:50');
  assert.equal(fmtClock(ts), '06:50');
  assert.equal(fmtMonthDay(ts), '11-10');
  assert.equal(fmtDateTime(null), '—');
  assert.equal(displayDayFloor(ts), Date.UTC(2026, 10, 9, 16), '北京 11-10 00:00 = 11-09 16:00 UTC');
  assert.equal(displayDayFloor(Date.UTC(2026, 10, 9, 15, 59)), Date.UTC(2026, 10, 8, 16));
  // 旧 format.ts 依赖浏览器本地时区；现在固定北京时间
  assert.equal(legacyFmtTime(ts), '06:50');
  assert.equal(legacyFmtDateTime(ts), '11-10 06:50');
  pass('1 · 时间显示固定北京时间，不随浏览器时区变化；日界为北京 00:00');
}

// 2. 高级别聚合与 OKX 1D/1W 一致：按北京日 00:00 切桶
{
  const bjMidnight = Date.UTC(2026, 10, 9, 16);
  const child = (ts: number): Candle => ({ ts, o: 100, h: 101, l: 99, c: 100, v: 1, confirm: 1, volumeSource: 'quote' });
  const bjDay = Array.from({ length: 24 }, (_, i) => child(bjMidnight + i * H));
  const d = resample(bjDay, H, DAY, { now: bjMidnight + DAY });
  assert.equal(d.length, 1);
  assert.equal(d[0].ts, bjMidnight, '日线开盘时间 = 北京 00:00');
  const utcDay = Array.from({ length: 24 }, (_, i) => child(Date.UTC(2026, 10, 10) + i * H));
  assert.equal(resample(utcDay, H, DAY, { now: Date.UTC(2026, 10, 11) }).length, 0, 'UTC 自然日跨两个北京日，不能拼成一根完整日线');
  pass('2 · 1D 聚合按北京日切桶（与 OKX 1D K 线开盘 16:00 UTC 一致）');
}

// 3. 时段徽标与日界线显示北京时间；时段定义仍是 UTC
{
  const day = Date.UTC(2026, 10, 9);
  const spans = computeSessionSpans(day, day + DAY - 1, { mode: 'macro', enabledSessions: { asia: true, london: true, ny: true }, showOverlap: true });
  const asia = spans.find(s => s.id === 'asia')!;
  assert.equal(asia.startMs, day, '亚太时段仍是 00:00 UTC 开始');
  assert.equal(asia.badgeLabel, '亚太交易时段 08:00–16:00');
  assert.equal(asia.utcWindow, '00:00–08:00 UTC');
  const bars = [{ time: day - 8 * H, open: 1, high: 1, low: 1, close: 1 }];
  const divs = computeDailyDividers(bars, day - 9 * H, day + H);
  assert.deepEqual(divs.map(d => [d.dayStartMs, d.dateLabel]), [[day - 8 * H, '11-09 00:00']]);
  pass('3 · 时段徽标写北京时间（亚太 08:00–16:00），日界线落在北京 00:00');
}

// 4. 待确认前高：右侧 3 根没越过 → 提前给出；凑满 5 根后转为正式前高，待确认消失
{
  const bar = (i: number, p: number): Candle => ({ ts: T0 + i * MS, o: p, h: p + 0.3, l: p - 0.3, c: p, v: 1000, confirm: 1, volumeSource: 'quote' });
  const zig = (way: [number, number][]) => {
    const out: Candle[] = [];
    for (let k = 0; k + 1 < way.length; k++) {
      const [i0, p0] = way[k], [i1, p1] = way[k + 1];
      for (let i = i0; i < i1; i++) out.push(bar(i, p0 + (p1 - p0) * (i - i0) / (i1 - i0)));
    }
    return out;
  };
  const cs = zig([[0, 100], [30, 98], [60, 101], [90, 105.5], [94, 104.5]]);
  const ctx = buildContext(cs);
  const pend = pendingSwings(ctx);
  assert.ok(pend.above, '峰值右侧已收盘 3 根，应给出待确认前高');
  assert.equal(pend.above!.idx, 90);
  assert.equal(pend.above!.rightBars, 3);
  assert.equal(pend.above!.price, cs[90].h);
  assert.equal(pend.above!.confirmTs, T0 + 95 * MS);
  assert.equal(pend.below, null);
  assert.ok(!readLiquidity(ctx).pools.some(p => p.price === cs[90].h), '待确认的点不能混进正式流动性池');

  const report = buildFrameworks(cs, MS, 'SOL-USDT-SWAP', '5m', null, T0 + 94 * MS + 1);
  assert.ok(report, 'report');
  const marks = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS).payload;
  // 待确认前高不再单独画虚线：它并进上方的压力带，悬停写明「还没确认」
  const band = marks.levels.find(l => l.id === 'fw:band:pressure');
  assert.ok(band, `pending high joins the pressure band: ${marks.levels.map(l => l.id).join(',')}`);
  assert.ok(band!.detail![0].includes(`${fmtClock(cs[90].ts)} 的高点`) && band!.detail![0].includes('还没确认'), band!.detail![0]);

  // 再收两根仍不越过：正式确认，待确认线让位
  const more = [...cs, bar(94, 104.25), bar(95, 104)];
  const ctx2 = buildContext(more);
  assert.equal(pendingSwings(ctx2).above, null);
  assert.ok(readLiquidity(ctx2).nearestAbove?.price === cs[90].h, '确认后成为正式前高');
  // 被越过：待确认直接消失
  const broken = [...cs, bar(94, 105.8)];
  assert.equal(pendingSwings(buildContext(broken)).above?.idx === 90, false);
  pass('4 · 前高右侧 2–4 根就提前算进压力带（写明还没确认），确认后换成正式前高，被越过即消失');

  // 5. 分形不再画在 K 线上（各周期方向只在右上角显示）
  const waves = zig([[0, 100], [12, 103], [24, 101], [36, 104], [48, 102], [60, 105], [72, 103], [84, 106], [96, 104], [108, 107], [118, 106]]);
  const wr = buildFrameworks(waves, MS, 'SOL-USDT-SWAP', '5m', null, waves.at(-1)!.ts + MS + 1);
  const wm = projectFrameworkMarks(wr, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  assert.equal(wm.payload.events.filter(e => e.id.startsWith('fw:frac:')).length, 0);
  assert.ok(wm.hud!.rows.length >= 2);
  pass('5 · 分形不再画在 K 线上，各周期方向只在右上角显示');
}

// 6. 收盘即时重算 / 收盘看门狗（浏览器全局用最小桩）
{
  type Timer = { fn: () => void; delay: number };
  const timers = new Map<number, Timer>();
  let id = 1;
  class MockWS {
    static all: MockWS[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) { MockWS.all.push(this); }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; }
  }
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, WebSocket: g.WebSocket, fetch: g.fetch };
  const restCalls: string[] = [];
  const barTs = Math.floor(Date.now() / MS) * MS;
  const row = (ts: number, c: number, confirm: string) => [String(ts), String(c), String(c + 1), String(c - 1), String(c), '1', '1', String(c * 10), confirm];
  Object.assign(globalThis, {
    window: {
      setTimeout: (fn: () => void, delay: number) => { const k = id++; timers.set(k, { fn, delay }); return k; },
      clearTimeout: (k: number) => timers.delete(k),
      setInterval: () => 1,
      clearInterval: () => undefined,
      addEventListener: () => undefined,
    },
    WebSocket: MockWS,
    fetch: async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      restCalls.push(url.pathname + url.search);
      return new Response(JSON.stringify({ code: '0', data: [row(barTs, 101, '1'), row(barTs - MS, 100, '1')] }), { status: 200 });
    },
  });
  try {
    const { OKXProvider, barsHub, CLOSE_WATCHDOG_MS, toOkxBar } = await import('@/vela/okxProvider');
    const { latestClosedTs } = await import('@/vela/frameworkRuntime');
    assert.deepEqual(['D', 'W', 'M', '60', '5'].map(toOkxBar), ['1D', '1W', '1M', '1H', '5m'], '日/周/月线用 OKX 北京时间 K 线');

    const provider = new OKXProvider();
    const stop = provider.subscribe('ETH-USDT-SWAP', '5', () => undefined);
    const ws = MockWS.all.at(-1)!;
    ws.onopen?.();
    timers.clear();
    ws.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle5m' }, data: [row(barTs, 100.5, '0')] }) });
    const dog = [...timers.values()];
    assert.equal(dog.length, 1, '形成中 K 线挂一个收盘看门狗');
    const expected = barTs + MS + CLOSE_WATCHDOG_MS - Date.now();
    assert.ok(Math.abs(dog[0].delay - Math.max(0, expected)) < 1500, `delay ${dog[0].delay} ≈ ${expected}`);
    // 同一根的后续 tick 不重复挂
    ws.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle5m' }, data: [row(barTs, 100.7, '0')] }) });
    assert.equal(timers.size, 1);

    const before = barsHub.get('ETH-USDT-SWAP', '5');
    assert.equal(latestClosedTs(before, MS, barTs + MS + 10), -1, '漏推 confirm 时只靠本机时钟不会把它当已收盘');
    restCalls.length = 0;
    dog[0].fn();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(restCalls.filter(r => r.includes('/market/candles')).length, 1, '到点仍未确认 → 主动 REST 拉取');
    const after = barsHub.get('ETH-USDT-SWAP', '5');
    assert.equal((after.find(b => b.time === barTs) as { confirm?: number }).confirm, 1);
    assert.equal(latestClosedTs(after, MS, barTs + MS + 10), barTs, '补到 confirm=1 后最近收盘时间前进，运行时据此跳过节流立即重算');

    // 已确认的推送不挂看门狗；日线不挂（定时器跨度过长）
    timers.clear();
    ws.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle5m' }, data: [row(barTs, 101, '1')] }) });
    assert.equal(timers.size, 0);
    stop();
    const stopD = provider.subscribe('ETH-USDT-SWAP', 'D', () => undefined);
    const wsD = MockWS.all.at(-1)!;
    wsD.onopen?.();
    timers.clear();
    wsD.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle1D' }, data: [row(Math.floor(Date.now() / DAY) * DAY - 8 * H, 100, '0')] }) });
    assert.equal(timers.size, 0, '日线不挂看门狗');
    stopD();
    pass('6 · 收盘 2 秒仍无 confirm 主动补拉；最近收盘时间前进即触发立即重算；日线 / 已确认推送不挂看门狗');
  } finally {
    Object.assign(globalThis, saved);
  }
}

console.log(`tz-latency: ${passed} 项通过`);
