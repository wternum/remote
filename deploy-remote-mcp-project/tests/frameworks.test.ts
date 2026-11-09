// Deterministic accuracy/causality regressions for the four structural views.
// Run: node scripts/run-ts-test.mjs tests/frameworks.test.ts
import assert from 'node:assert/strict';
import type { Candle } from '../src/lib/types';
import type { OHLCV } from '@luxalgo/vela';
import { buildContext } from '../src/quant/context';
import { computeVaap, valueAreaOf, binWidthOf, readAuction, findLowVolumeNodes, MAX_PROFILE_BINS } from '../src/quant/auction';
import { resample, fractals, mtfAlignment, tfStructure } from '../src/quant/fractal';
import { effortResult, readWyckoff } from '../src/quant/wyckoff';
import { equalLevels, stopHunts, readLiquidity } from '../src/quant/liquidity';
import { buildFrameworks, FRAMEWORK_MAX_BARS } from '../src/quant/frameworks';
import { frameworkInputKey, normalizeFrameworkMarket } from '../src/components/frameworks/useFrameworks';
import {
  DEFAULT_FRAMEWORK_MARK_PREFS,
  MAX_FVG_ZONES,
  projectFrameworkMarks,
} from '../src/quant/frameworkMarks';
import {
  createFrameworkMarkStore,
  FRAMEWORK_MARK_STORAGE_KEY,
} from '../src/vela/frameworkMarkStore';
import { annotationCandles } from './signal-fixtures';

const MS = 300_000;
const T = 900_000_000; // Positive and aligned to 5m/15m/30m/1h UTC boundaries.
const NOW = 1_800_000_000_000;
let passed = 0;
const pass = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bar = (ts: number, o: number, h: number, l: number, c: number, v: number, confirm: 0 | 1 = 1): Candle =>
  ({ ts, o, h, l, c, v, confirm, volumeSource: 'quote' });
const quoted = (cs: Candle[]) => cs.map(c => ({ ...c, confirm: 1 as const, volumeSource: 'quote' as const }));

// 1. AMT: conservation, paired-row area, fixed grid, bounded allocation.
{
  const cs: Candle[] = [];
  for (let i = 0; i < 28; i++) cs.push(bar(T + i * MS, 100, 100.3, 99.7, 100, 1000));
  cs.push(bar(T + 28 * MS, 100.2, 100.5, 99.8, 100.1, 200));
  cs.push(bar(T + 29 * MS, 104, 105, 102.5, 104.8, 300));
  const profile = computeVaap(cs, 0, cs.length - 1, binWidthOf(104.8, 0.6));
  assert.ok(profile.poc != null && profile.vah != null && profile.val != null);
  assert.ok(profile.poc >= 99 && profile.poc <= 101);
  assert.ok(profile.val <= profile.poc && profile.poc < profile.vah);
  assert.equal(profile.position, 'above');
  assert.ok(profile.valuePct >= 0.7 && profile.valuePct <= 1);
  const allocated = profile.bins.reduce((s, b) => s + b.vol, 0);
  assert.ok(Math.abs(allocated - profile.totalVol) <= profile.totalVol * 1e-10, 'turnover must be conserved');
  assert.equal(profile.method, 'ohlc-turnover-paired-70');
  const shifted = computeVaap(cs, 0, cs.length - 1, profile.bin, { origin: 0 });
  assert.equal(shifted.bins[0].price, profile.bins[0].price, 'same origin/width must keep the same grid');
  const wide = computeVaap([bar(T, 1, 1000, 1, 500, 10), bar(T + MS, 500, 1000, 1, 900, 10)], 0, 1, 1e-8);
  assert.ok(wide.bins.length <= MAX_PROFILE_BINS, 'pathological range must not allocate unbounded bins');
  const noVolume = readAuction([bar(T, 100, 101, 99, 100, 0)], 120, 1);
  assert.equal(noVolume.profile.poc, null);
  assert.equal(noVolume.profile.position, 'unknown');
  assert.equal(noVolume.bias, 0);
  assert.equal(noVolume.strength, 0);
  const withZeroChild = computeVaap([bar(T, 100, 101, 99, 100, 1000), bar(T + MS, 100, 101, 99, 100, 0)], 0, 1, 0.25);
  assert.ok(withZeroChild.poc != null, 'one valid zero-turnover quote candle does not erase a positive-turnover window');
  assert.equal(withZeroChild.totalVol, 1000);
  pass('AMT: turnover conservation, paired 70% area, shared grid, bounded bins, explicit no-volume state');
}

// 2. Value-area tie/mirror behavior and nonzero width at price zero.
{
  const bins = [{ price: 0, mid: 0.5, vol: 10 }, { price: 1, mid: 1.5, vol: 50 }, { price: 2, mid: 2.5, vol: 30 }, { price: 3, mid: 3.5, vol: 10 }];
  const a = valueAreaOf(bins, 100, 1);
  const mirrored = valueAreaOf([...bins].reverse().map((b, i) => ({ ...b, price: i, mid: i + 0.5 })), 100, 1);
  assert.equal(a.poc, 1.5);
  assert.equal(mirrored.poc, 2.5);
  assert.ok(a.val != null && a.vah != null && mirrored.val != null && mirrored.vah != null);
  assert.ok(Math.abs((4 - a.vah) - mirrored.val!) < 1e-9, 'mirror should reflect the lower boundary');
  assert.ok(Math.abs((4 - a.val!) - mirrored.vah!) < 1e-9, 'mirror should reflect the upper boundary');
  const single = valueAreaOf([{ price: 0, mid: 0.5, vol: 10 }], 10, 1);
  assert.equal(single.val, 0);
  assert.equal(single.vah, 1, 'single bin at price zero still has width');
  pass('value area: mirrored profiles stay mirrored; zero-price bin keeps its width');
}

// 3. Low-volume nodes are only BETWEEN price and value, never beyond price.
{
  const cs = [bar(T, 100, 101, 99, 100, 1000), bar(T + MS, 100, 101, 99, 100, 1000), bar(T + 2 * MS, 100, 120, 99, 119, 1)];
  const profile = computeVaap(cs, 0, 2, 1, { atr: 2 });
  const nodes = findLowVolumeNodes(profile, 119);
  for (const node of nodes) {
    assert.ok(node.to <= 119 + profile.bin, 'node must not extend beyond current price');
    assert.ok(node.bins >= 2);
  }
  pass('AMT: low-volume nodes are bounded between price and value, not mislabeled TPO single prints');
}

// 4. Resampling excludes incomplete/gapped buckets; weekly buckets start Monday.
{
  const full = [bar(T, 100, 101, 99, 100.5, 10), bar(T + MS, 100.5, 102, 100, 101, 12), bar(T + 2 * MS, 101, 101.5, 99.5, 99.8, 8)];
  const now = T + 3 * MS;
  const r = resample(full, MS, 3 * MS, { now });
  assert.equal(r.length, 1);
  assert.equal(r[0].o, 100); assert.equal(r[0].h, 102); assert.equal(r[0].l, 99); assert.equal(r[0].c, 99.8); assert.equal(r[0].v, 30);
  assert.equal(r[0].confirm, 1);
  assert.equal(resample(full.slice(0, 2), MS, 3 * MS, { now }).length, 0, 'open tail is not a closed HTF candle');
  assert.equal(resample([full[0], full[2]], MS, 3 * MS, { now }).length, 0, 'missing child is not a complete bucket');
  assert.equal(resample(full.slice(0, 2), MS, 3 * MS, { now, includePartial: true })[0].confirm, 0);
  const monday = Date.UTC(2024, 0, 1);
  const week = Array.from({ length: 7 }, (_, i) => bar(monday + i * 86_400_000, 100, 101, 99, 100, 1));
  const wr = resample(week, 86_400_000, 7 * 86_400_000, { now: monday + 7 * 86_400_000 });
  assert.equal(wr.length, 1); assert.equal(wr[0].ts, monday, 'UTC week starts Monday, not Thursday epoch');
  pass('resample: exact OHLCV, complete-only buckets, gap rejection, Monday weekly origin');
}

// 5. Williams fractals wait for the right-hand close.
{
  const cs = [100, 101, 105, 102, 100, 99, 98].map((p, i) => bar(T + i * MS, p, p + 0.2, p - 0.2, p, 100));
  cs[4] = { ...cs[4], confirm: 0 };
  const before = fractals(cs, 2, MS, T + 5 * MS);
  assert.equal(before.highs.length, 0, 'forming right bar cannot confirm a pivot');
  cs[4] = { ...cs[4], confirm: 1 };
  const after = fractals(cs, 2, MS, T + 5 * MS);
  assert.ok(after.highs.some(h => h.idx === 2));
  assert.equal(after.highs.find(h => h.idx === 2)!.confirmedAt, T + 5 * MS);
  pass('fractals: pivot timestamp and actual right-side confirmation time are distinct');
}

// 6. MTF trends align; expanding HH+LL is NOT a bull trend.
{
  const up = Array.from({ length: 240 }, (_, i) => { const p = 100 + i * 0.05 + Math.sin(i / 2) * 1.5; return bar(T + i * MS, p, p + 0.15, p - 0.15, p + 0.05, 1000); });
  const down = Array.from({ length: 240 }, (_, i) => { const p = 200 - i * 0.05 + Math.sin(i / 2) * 1.5; return bar(T + i * MS, p, p + 0.15, p - 0.15, p - 0.05, 1000); });
  const now = T + 240 * MS;
  assert.equal(mtfAlignment(up, 5, 2, now).verdict, 'long');
  assert.equal(mtfAlignment(down, 5, 2, now).verdict, 'short');
  const expanding = Array.from({ length: 16 }, (_, i) => bar(T + i * MS, 100, 100.2, 99.8, 100, 100));
  for (const [i, h] of [[2, 110], [6, 112], [10, 114]] as const) expanding[i] = { ...expanding[i], h, c: h - 0.1, o: h - 0.2 };
  for (const [i, l] of [[4, 90], [8, 88], [12, 86]] as const) expanding[i] = { ...expanding[i], l, c: l + 0.1, o: l + 0.2 };
  const structure = tfStructure(expanding, 2, 0.0008, { barMs: MS, now: T + 16 * MS });
  assert.equal(structure.highRel, 'HH');
  assert.equal(structure.lowRel, 'LL');
  assert.equal(structure.bias, 'range', 'HH+LL is expansion, not HH+HL trend');
  const before = tfStructure(up, 2, 0.0008, { barMs: MS, now });
  assert.equal(before.bias, 'bull');
  assert.ok(before.lastLow != null);
  const broken = [...up, bar(T + 240 * MS, before.lastLow! - 0.5, before.lastLow! - 0.4, before.lastLow! - 2, before.lastLow! - 1.5, 1000)];
  const after = tfStructure(broken, 2, 0.0008, { barMs: MS, now: T + 241 * MS });
  assert.equal(after.invalidated, true);
  assert.equal(after.bias, 'range', 'a close through the confirmed defensive low invalidates the old bull label');
  pass('MTF: directional trends align; HH+LL expansion stays neutral; defensive break invalidates stale trend');
}

// 7. Wyckoff effort uses prior baseline and does not call a wide round trip absorption.
{
  const quiet = Array.from({ length: 40 }, (_, i) => bar(T + i * MS, 100, 100.1, 99.9, 100, 1000));
  const narrow = Array.from({ length: 20 }, (_, i) => bar(T + (40 + i) * MS, 100, 100.05, 99.95, i % 2 ? 100.02 : 99.98, 5000));
  const absorption = effortResult(buildContext([...quiet, ...narrow]), 20);
  assert.equal(absorption.status, 'absorption');
  assert.ok(absorption.effort != null && absorption.effort > 1.5, '5× spot volume is diluted by the rolling prior-20 baseline as the window advances');
  assert.ok(absorption.result != null && absorption.result < 1.1);
  const wide = Array.from({ length: 20 }, (_, i) => bar(T + (40 + i) * MS, 100, 102, 98, i % 2 ? 101.9 : 98.1, 5000));
  const churn = effortResult(buildContext([...quiet, ...wide]), 20);
  assert.notEqual(churn.status, 'absorption', 'large spread with zero net progress is not narrow-spread absorption');
  const zero = effortResult(buildContext(quiet.map(c => ({ ...c, v: 0 }))), 20);
  assert.equal(zero.status, 'unknown'); assert.equal(zero.effort, null);
  const wy = readWyckoff(buildContext([...quiet, ...narrow]));
  assert.ok(wy.strength >= 0 && wy.strength <= 1);
  pass('Wyckoff: prior-baseline effort, narrow-spread absorption, wide-round-trip rejection, missing-volume unknown');
}

// 8. Liquidity references are confirmed and event output remains structurally valid.
{
  const cs = quoted(annotationCandles(true, 120, NOW));
  const ctx = buildContext(cs);
  const pools = equalLevels(ctx);
  for (const p of [...pools.tops, ...pools.bottoms]) {
    assert.ok(p.touches >= 1); assert.equal(p.equal, p.touches >= 2); assert.ok(p.price > 0);
  }
  const hunts = stopHunts(ctx, 160);
  for (const h of hunts) {
    assert.ok(h.touches >= 2); assert.ok(h.ageBars >= 0); assert.ok(h.depthAtr >= 0);
    assert.ok(['sweep', 'break'].includes(h.kind));
  }
  const liq = readLiquidity(ctx);
  assert.ok(liq.strength >= 0 && liq.strength <= 1);
  pass('liquidity: distinct confirmed swings, consumed pools, fresh-event strength bounds');
}

// 9. Aggregator: future/forming bars, conflicts, gaps, volume quality, bounded history.
{
  const base = quoted(annotationCandles(true, 120, NOW));
  const now = base.at(-1)!.ts + MS;
  const a = buildFrameworks(base, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.ok(a);
  assert.equal(a.confluence.long + a.confluence.short + a.confluence.neutral + a.confluence.unavailable, 4);
  assert.ok(a.quality.auctionVolumeReady);
  const last = base.at(-1)!;
  const futureConfirmed = [...base, { ...bar(last.ts + MS, last.c, last.c + 10, last.c - 10, last.c + 5, 1), confirm: 1 as const }];
  const b = buildFrameworks(futureConfirmed, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.equal(b.quality.future, 1);
  assert.equal(b.lastTs, a.lastTs, 'even confirm=1 cannot admit a future timestamp');
  assert.deepEqual(b.confluence, a.confluence);
  const formingAtBoundary = [...base.slice(0, -1), { ...last, confirm: 0 as const }];
  const c = buildFrameworks(formingAtBoundary, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.equal(c.quality.forming, 1);
  assert.equal(c.lastTs, base.at(-2)!.ts, 'exchange confirm=0 wins over clock expiry');
  const gapped = base.filter((_, i) => i !== 60);
  const d = buildFrameworks(gapped, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.ok(d.quality.gapTruncated); assert.ok(d.bars < base.length - 1);
  const conflict = [...base, { ...base[80], c: base[80].c + 1 }];
  const e = buildFrameworks(conflict, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.ok(e.quality.invalid >= 1);
  const estimated = base.map(c => ({ ...c, volumeSource: 'base_close_estimate' as const }));
  const f = buildFrameworks(estimated, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.equal(f.auction.profile.poc, null); assert.ok(f.confluence.unavailable >= 1);
  const long = Array.from({ length: 3000 }, (_, i) => bar(T + i * MS, 100, 101, 99, 100, 1000));
  const g = buildFrameworks(long, MS, 'BTC-USDT-SWAP', '5m', null, T + 3000 * MS)!;
  assert.equal(g.bars, FRAMEWORK_MAX_BARS);
  pass('aggregator: future/forming exclusion, conflict/gap handling, quote-only AMT, bounded history');
}

// 10. Runtime key ignores forming ticks but changes on a new closed bar / market.
{
  const market = normalizeFrameworkMarket('okx:BTC-USDT-SWAP', '5');
  const closed = bar(T, 100, 101, 99, 100, 1000);
  const forming = { ...bar(T + MS, 100, 102, 99, 101, 500), confirm: 0 as const };
  const toOhlc = (c: Candle): OHLCV & { confirm?: 0 | 1 } => ({ time: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, confirm: c.confirm });
  const now = T + 2 * MS;
  const raw = [toOhlc(closed), toOhlc(forming)];
  const key1 = frameworkInputKey(raw, market, now);
  const tick = [raw[0], { ...raw[1], close: 101.5, high: 103, volume: 900 }];
  assert.equal(frameworkInputKey(tick, market, now), key1, 'forming tick must not schedule structural recomputation');
  const nextClosed = [raw[0], { ...raw[1], confirm: 1 as const }];
  assert.notEqual(frameworkInputKey(nextClosed, market, now + MS), key1);
  assert.notEqual(frameworkInputKey(raw, { ...market, symbol: 'ETH-USDT-SWAP' }, now), key1);
  pass('runtime: closed-bar key ignores forming ticks and separates market identity');
}

// 11. Chart marking projection: toggles, volume gating, deduplication, concise labels.
{
  const up = Array.from({ length: 180 }, (_, i) => {
    const p = 100 + i * 0.06 + Math.sin(i / 2.2) * 1.4;
    return bar(T + i * MS, p, p + 0.2, p - 0.2, p + 0.05, 1000);
  });
  const now = T + 180 * MS;
  const report = buildFrameworks(up, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  assert.ok(report);

  const full = projectFrameworkMarks(report, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  assert.ok(full.payload.levels.some(l => l.id === 'fw:amt:poc'), 'AMT POC should be marked when quote volume is ready');
  assert.ok(full.payload.levels.some(l => l.id === 'fw:amt:vah'));
  assert.ok(full.payload.levels.some(l => l.id === 'fw:amt:val'));
  assert.ok(full.payload.zones.length <= MAX_FVG_ZONES, 'FVG zones are bounded to prevent clutter');
  assert.ok(full.hud !== null && full.hud.rows.length >= 2, 'MTF HUD shows ladder summary');

  // Unique (ts, side) guarantee: never stack two event badges on the same candle side.
  const eventKeys = full.payload.events.map(e => `${e.ts}:${e.side}`);
  assert.equal(new Set(eventKeys).size, eventKeys.length, 'at most one event marker per (bar, side)');

  // Individual toggles turn off only their own markings.
  const offAll = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, enabled: false }, MS);
  assert.equal(offAll.payload.levels.length + offAll.payload.events.length + offAll.payload.zones.length, 0);
  assert.equal(offAll.hud, null);

  const noAmt = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, amt: false }, MS);
  assert.ok(!noAmt.payload.levels.some(l => l.id.startsWith('fw:amt:')));

  const noFrac = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, fractals: false }, MS);
  assert.equal(noFrac.hud, null);
  assert.ok(!noFrac.payload.events.some(e => e.id.startsWith('fw:frac:')));

  const minimal = projectFrameworkMarks(report, { ...DEFAULT_FRAMEWORK_MARK_PREFS, labels: false }, MS);
  assert.ok(minimal.payload.levels.every(l => l.label === false));
  assert.ok(minimal.payload.events.every(e => e.text === ''));
  assert.ok(minimal.payload.zones.every(z => z.text === ''));

  // Missing/estimated volume must NEVER emit AMT lines.
  const estReport = buildFrameworks(
    up.map(c => ({ ...c, volumeSource: 'base_close_estimate' as const })),
    MS, 'BTC-USDT-SWAP', '5m', null, now,
  )!;
  const estMarks = projectFrameworkMarks(estReport, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  assert.ok(!estMarks.payload.levels.some(l => l.id.startsWith('fw:amt:')), 'estimated volume must not draw POC/VAH/VAL');
  pass('mark projection: toggles, AMT quote-volume gate, bounded zones, unique per-bar events');
}

// 12. Same-candle StopHunt + Wyckoff Spring/Upthrust merges cleanly into one marker.
{
  const base = quoted(annotationCandles(true, 120, NOW));
  const now = base.at(-1)!.ts + MS;
  const report = buildFrameworks(base, MS, 'BTC-USDT-SWAP', '5m', null, now)!;
  const synthetic = {
    ...report,
    liquidity: {
      ...report.liquidity,
      stopHunts: [{
        side: 'below' as const, level: 100, idx: 110, ts: base[110].ts, ageBars: 9,
        depthAtr: 0.4, touches: 2, reclaimed: true, kind: 'sweep' as const, taker: null, reason: 'sweep test',
      }],
    },
    wyckoff: {
      ...report.wyckoff,
      springs: [{
        kind: 'spring' as const, idx: 110, ts: base[110].ts, ageBars: 9, level: 100,
        depthAtr: 0.4, reclaimed: true, effortRatio: 1.5, taker: null, quality: 'strong' as const, reason: 'spring test',
      }],
    },
  };
  const out = projectFrameworkMarks(synthetic, DEFAULT_FRAMEWORK_MARK_PREFS, MS);
  const atBar = out.payload.events.filter(e => e.ts === base[110].ts && e.side === 'below');
  assert.equal(atBar.length, 1, 'same-bar sweep + spring must merge into one marker');
  assert.equal(atBar[0].text, '扫低·弹簧');
  pass('mark projection: same-bar sweep + spring merges into single label');
}

// 13. Mark preferences store: persistence, sanitization, reset.
{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const store = createFrameworkMarkStore(storage);
  assert.equal(store.getSnapshot().enabled, true);
  store.toggle('amt');
  assert.equal(store.getSnapshot().amt, false);
  const reloaded = createFrameworkMarkStore(storage);
  assert.equal(reloaded.getSnapshot().amt, false);
  assert.equal(reloaded.getSnapshot().liquidity, true);
  reloaded.reset();
  assert.equal(reloaded.getSnapshot().amt, true);
  mem.set(FRAMEWORK_MARK_STORAGE_KEY, '{corrupt');
  assert.doesNotThrow(() => createFrameworkMarkStore(storage));
  pass('mark store: persists toggles, sanitizes corrupt storage, resets cleanly');
}

console.log(`frameworks: ${passed} groups passed`);
