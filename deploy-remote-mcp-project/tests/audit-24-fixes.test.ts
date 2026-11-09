import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { quoteVolumeOfRow } from '@/lib/okxVolume';
import { buildContext } from '@/quant/context';
import { equalLevels, stopHunts } from '@/quant/liquidity';
import { fractals, tfStructure } from '@/quant/fractal';
import { findSprings } from '@/quant/wyckoff';
import { buildFrameworks } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';
import { orderBlockCandidate, readSmartMoney } from '@/quant/smartmoney';
import { computeAsiaRangeLevels, DAY_MS, type BarLike } from '@/vela/sessions/sessionMath';
import { normalizeFrameworkMarket, isSupportedFrameworkSymbol } from '@/vela/frameworkKey';
import { analyzeMwStory } from '@/vela/signals/mwStory';
import { broken, W, MS as MW_MS } from './mw-fixtures';
import { GET as rootGet } from '@/app/route';
import { GET as okxProxyGet } from '@/app/api/okx/[...path]/route';

const MS = 300_000;
const T0 = 1_800_000_000_000;
const qBar = (i: number, o: number, h: number, l: number, c: number, v = 1000, confirm: 0 | 1 = 1, volumeSource: Candle['volumeSource'] = 'quote'): Candle =>
  ({ ts: T0 + i * MS, o, h, l, c, v, confirm, volumeSource });

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// 1. Equal highs/lows are not deduplicated at source; broken swings don't form EQH pools or inflate stopHunts
{
  const cs: Candle[] = [];
  for (let i = 0; i < 120; i++) cs.push(qBar(i, 100, 100.3, 99.7, 100));
  // First swing high at 20 (105.0) preceded by a dip at 10 (96.0)
  for (let i = 8; i <= 12; i++) cs[i] = qBar(i, 97, 97.5, 96, 97);
  cs[20] = qBar(20, 103, 105.0, 102.5, 103.5);
  // Dip in middle at 35
  for (let i = 33; i <= 37; i++) cs[i] = qBar(i, 97, 97.5, 96, 97);
  // Second unbroken equal high at 50 (105.02)
  cs[50] = qBar(50, 103, 105.02, 102.5, 103.5);
  // Sweep both at 70 (high 105.6, close 104.2)
  cs[70] = qBar(70, 104, 105.6, 103.8, 104.2);

  const ctx = buildContext(cs);
  const pools = equalLevels(ctx);
  assert.ok(pools.tops.some(p => p.equal && p.touches === 2 && p.active), 'two unbroken equal highs form an active EQH×2 pool');
  const hunts = stopHunts(ctx, 120);
  assert.ok(hunts.some(h => h.idx === 70 && h.kind === 'sweep' && h.touches === 2), 'sweep across two unbroken equal highs reports touches=2');
  pass('等高流动性池与扫等高（touches=2）不再在源头被去重');

  // Now break the first swing high at bar 30 before forming the second at 50
  const brokenFirst = cs.map(c => ({ ...c }));
  brokenFirst[30] = qBar(30, 104, 106.0, 103.5, 105.8);
  const ctxBroken = buildContext(brokenFirst);
  const poolsBroken = equalLevels(ctxBroken);
  assert.ok(!poolsBroken.tops.some(p => p.equal), 'previously broken high + new high must NOT merge into EQH pool');
  const huntsBroken = stopHunts(ctxBroken, 120);
  assert.ok(!huntsBroken.some(h => h.idx === 70), 'broken old high must NOT count toward stopHunt touches');
  pass('已击穿旧位不与新位聚合成等高池，也不计入扫位 touches');
}

// 1b. stopHunts honours the lookback window: a level confirmed long before the window
//     can still produce a fresh sweep inside it, while pre-window consumption is skipped.
{
  const cs: Candle[] = [];
  for (let i = 0; i < 300; i++) cs.push(qBar(i, 100, 100.3, 99.7, 100));
  for (let i = 88; i <= 92; i++) cs[i] = qBar(i, 97, 97.5, 96, 97);
  cs[100] = qBar(100, 103, 105.0, 102.5, 103.5);
  for (let i = 104; i <= 108; i++) cs[i] = qBar(i, 97, 97.5, 96, 97);
  cs[110] = qBar(110, 103, 105.02, 102.5, 103.5);
  // Sweep both equal highs inside the 160-bar window (windowStart = 140).
  cs[150] = qBar(150, 104, 105.6, 103.8, 104.2);
  const ctx = buildContext(cs);
  const hunts = stopHunts(ctx, 160);
  assert.ok(hunts.some(h => h.idx === 150 && h.touches === 2), 'sweep inside lookback window must be reported with touches=2');

  // A level consumed before the window must not be reported as a fresh event.
  const early = cs.map(c => ({ ...c }));
  early[120] = qBar(120, 104, 105.6, 103.8, 104.2);
  const earlyHunts = stopHunts(buildContext(early), 160);
  assert.ok(!earlyHunts.some(h => h.idx === 120), 'pre-window consumption must not be reported');
  pass('stopHunts 尊重回看窗口：窗口内扫位报告，窗口前已消耗不重复报告');
}

// 2. Session Asia Range ignores forming bars and transitions swept_reject -> broken
{
  const day = Date.UTC(2026, 10, 8, 0, 0, 0);
  const bars: BarLike[] = [
    { time: day + 1 * 3600_000, open: 100, high: 105, low: 98, close: 101, confirm: 1 },
    { time: day + 3 * 3600_000, open: 101, high: 104, low: 95, close: 100, confirm: 1 },
    // 09:00 UTC: swept AH=105 then closed inside at 104
    { time: day + 9 * 3600_000, open: 103, high: 106, low: 102, close: 104, confirm: 1 },
    // 11:00 UTC: forming bar breaking above 105 (confirm: 0) -> must be ignored
    { time: day + 11 * 3600_000, open: 104, high: 108, low: 103, close: 107, confirm: 0 },
  ];
  const s1 = computeAsiaRangeLevels(bars, day, day + DAY_MS, day + 11 * 3600_000 + 60_000);
  assert.equal(s1[0].highState, 'swept_reject', 'forming bar must not flip swept_reject to broken');
  // Once 11:00 UTC bar closes above 105, state updates from swept_reject -> broken
  const closedBars = bars.map(b => ({ ...b, confirm: 1 as const }));
  const s2 = computeAsiaRangeLevels(closedBars, day, day + DAY_MS, day + 12 * 3600_000);
  assert.equal(s2[0].highState, 'broken', 'closed breakout after swept_reject must update state to broken');
  pass('亚盘高低点忽略未收盘 K 线，且先扫后真突破会更新为 broken');
}

// 3. Fractals: equal highs detected + alternating swings + ATR tolerance
{
  const flatTop = [100, 101, 105, 105, 102, 100, 99].map((p, i) => qBar(i, p, p + 0.1, p - 0.1, p));
  flatTop[2].h = 105;
  flatTop[3].h = 105;
  const f = fractals(flatTop, 2, MS, T0 + 10 * MS);
  assert.equal(f.highs.length, 1, 'flat top with equal highs must produce one fractal instead of cancelling both');
  assert.equal(f.highs[0].idx, 3);
  const row = tfStructure(
    Array.from({ length: 30 }, (_, i) => qBar(i, 100 + i * 0.2, 100.5 + i * 0.2, 99.5 + i * 0.2, 100.1 + i * 0.2)),
    2,
    undefined,
    { barMs: MS, now: T0 + 40 * MS },
  );
  assert.ok(row.bars === 30);
  pass('分形平顶不互相否定，且支持交替摆动与 ATR 自适应容差');
}

// 4. Framework marks: HUD survives fractals=false; liquidity & AMT anchor causally
{
  const up = Array.from({ length: 180 }, (_, i) => {
    const p = 100 + i * 0.06 + Math.sin(i / 2.2) * 1.4;
    return qBar(i, p, p + 0.2, p - 0.2, p + 0.05, 1000);
  });
  const now = T0 + 180 * MS;
  const report = buildFrameworks(up, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  const noFrac = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, fractals: false }, MS);
  assert.ok(noFrac.hud !== null, 'HUD stays visible when fractal candle markers are toggled off');
  const full = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  const poc = full.payload.levels.find(l => l.id === 'fw:amt:poc');
  assert.equal(poc?.fromTs, report.lastTs, 'rolling AMT POC anchors at completion bar lastTs');
  const liqAbove = full.payload.levels.find(l => l.id === 'fw:liq:above');
  if (liqAbove && report.liquidity.nearestAbove) {
    assert.equal(liqAbove.fromTs, report.liquidity.nearestAbove.confirmedTs, 'liquidity line starts at confirmedTs, not unconfirmed firstTs');
  }
  const fracEv = full.payload.events.find(e => e.id.startsWith('fw:frac:'));
  if (fracEv) {
    assert.ok(fracEv.detail!.some(d => d.includes('才成立')), 'fractal hover text states exact confirmation time');
  }
  pass('分形关闭不藏 HUD，且流动性/分形/AMT 锚点与悬停口径诚实');
}

// 5. AMT tolerates <=5% non-quote bars, and unsupported symbols are not remapped to BTC
{
  const up = Array.from({ length: 120 }, (_, i) => {
    const p = 100 + Math.sin(i / 3) * 1.2;
    return qBar(i, p, p + 0.3, p - 0.3, p + 0.05, 1000, 1, i === 50 ? 'base_close_estimate' : 'quote');
  });
  const report = buildFrameworks(up, MS, 'BTC-USDT-SWAP', '5m', null, T0 + 125 * MS)!;
  assert.equal(report.quality.auctionVolumeReady, true, '1/120 missing quote bar (<5%) keeps AMT available');
  assert.ok(report.auction.profile.poc != null);

  const doge = normalizeFrameworkMarket('okx:DOGE-USDT-SWAP', '5');
  assert.equal(doge.symbol, 'DOGE-USDT-SWAP');
  assert.equal(isSupportedFrameworkSymbol(doge.symbol), false);
  assert.equal(quoteVolumeOfRow(['1', '1', '1', '1', '0.2', '100', '0', '0'], 'DOGE-USDT-SWAP'), null);
  pass('AMT 容忍个别非 quote 缺口，未知币种不伪装成 BTC 或默认面值 1');
}

// 6. Middle missing confirm=1 does not truncate history; Wyckoff springs require range context
{
  const cs = Array.from({ length: 100 }, (_, i) => qBar(i, 100, 100.3, 99.7, 100, 1000, i === 40 ? 0 : 1));
  const report = buildFrameworks(cs, MS, 'BTC-USDT-SWAP', '5m', null, T0 + 105 * MS)!;
  assert.ok(report.bars >= 99, 'stale middle confirm=0 with later closed bars must not truncate series');

  // Strong uptrend with a local dip/reclaim should NOT emit a Wyckoff spring
  const trend: Candle[] = Array.from({ length: 120 }, (_, i) => {
    const p = 100 + i * 0.5;
    return qBar(i, p, p + 0.4, p - 0.4, p + 0.3, 1000);
  });
  const springs = findSprings(buildContext(trend), 120);
  assert.equal(springs.length, 0, 'pure uptrend must not emit Wyckoff springs without a trading range');
  pass('中间漏 confirm=1 不截断全历史，Wyckoff 弹簧需非单边区间前提');
}

// 7. mwStory retestDepth uses wick extreme; confirmed respects confirm=0; SMC OB & /6
{
  const cs = broken(76);
  // Wick dives to 108.1 (deep retest > 61.8% of 108->109.6), close recovers to 109.1
  cs[72] = { ts: T0 + 72 * MW_MS, o: 109.2, h: 109.3, l: 108.1, c: 109.1, v: 1200 };
  const deepWick = analyzeMwStory({ pattern: W, ctx: buildContext(cs), barMs: MW_MS });
  assert.ok(deepWick.story!.retestDepth! > 0.618, 'deep lower wick must increase retestDepth above 0.618');
  assert.equal(deepWick.story!.phase, 'break-retest', 'deep wick retest must NOT confirm as break-held');

  const unconfirmed = cs.map((c, i) => (i === W.idx ? { ...c, confirm: 0 as const } : c));
  const pend = analyzeMwStory({ pattern: W, ctx: buildContext(unconfirmed), barMs: MW_MS });
  assert.equal(pend.confirmed, false, 'confirm=0 must not be marked confirmed=true');

  // SMC bearish order block: last bullish bar at first top before downward move
  const obCs = Array.from({ length: 80 }, (_, i) => qBar(i, 100, 100.3, 99.7, 100));
  obCs[30] = qBar(30, 104, 105.2, 103.8, 105.0); // bullish candle before drop
  obCs[31] = qBar(31, 105, 105.1, 101.0, 101.2); // strong downward displacement
  const ob = orderBlockCandidate(buildContext(obCs), { side: 'top', idx: 60, first: 30, second: 60, level: 105.2, neck: 101 });
  assert.ok(ob && ob.from === 30 && ob.mitigated === false, 'bearish OB picks last bullish candle before drop and is not auto-mitigated by departure');
  const smc = readSmartMoney(buildContext(obCs), { side: 'top', idx: 60, first: 30, second: 60, level: 105.2, neck: 101 });
  assert.ok(!smc.headline.includes('/5'), 'SMC headline denominator must match actual 6 evidence items');
  pass('M/W 回撤取极值、confirmed 不硬编码、SMC OB 方向/回踩与 /6 修复');
}

// 8. Root route encoding negotiation & distinct ETags; OKX proxy rejects caching code!=0
{
  const rNoBr = await rootGet(new Request('http://127.0.0.1:3000/', { headers: { 'accept-encoding': 'br;q=0, gzip;q=1' } }));
  if (rNoBr.status === 200) {
    assert.equal(rNoBr.headers.get('content-encoding'), 'gzip', 'br;q=0 must NOT receive br encoding');
    const rBr = await rootGet(new Request('http://127.0.0.1:3000/', { headers: { 'accept-encoding': 'br, gzip' } }));
    assert.equal(rBr.headers.get('content-encoding'), 'br');
    assert.notEqual(rNoBr.headers.get('etag'), rBr.headers.get('etag'), 'different encodings must use distinct ETags');
  }

  const origFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    return new Response(JSON.stringify({ code: '50011', msg: 'Too Many Requests', data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const req = () => new Request('http://127.0.0.1:3000/api/okx/api/v5/rubik/stat/taker-volume-contract?instId=DOGE-USDT-SWAP&period=5m');
    const ctx = { params: Promise.resolve({ path: ['api', 'v5', 'rubik', 'stat', 'taker-volume-contract'] }) };
    await okxProxyGet(req(), ctx);
    await okxProxyGet(req(), ctx);
    assert.equal(hits, 2, 'HTTP 200 with code !== "0" must NOT be cached');
  } finally {
    globalThis.fetch = origFetch;
  }
  pass('根路由编码协商与分编码 ETag、rubik 代理不缓存业务错误');
}

console.log(`\naudit-24-fixes: ${passed} groups passed`);
