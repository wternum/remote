import assert from 'node:assert/strict';
import { parseOkxCandle, preferCandle, isClosedCandle } from '@/lib/okxCandles';
import { assessBars, auditPriceAction, replayPlan, makePlan, normalizeOptions, emaSeries, type ResearchPlan } from '@/quant/priceAction';
import type { Candle } from '@/lib/types';
const B = 300_000, T0 = 1_700_000_000_000;
const opts = { barMs: B, tickSz: 0.1, feeRate: 0.0005, slipRate: 0.0001, maxHold: 4, minBars: 30, requireConfirmed: true, now: T0 + 1000 * B };
const c = (i: number, o: number, h: number, l: number, cl: number, extra: Partial<Candle> = {}): Candle => ({ ts: T0 + i * B, o, h, l, c: cl, v: 1000, confirm: 1, volumeSource: 'quote', ...extra });
const rising = (n = 35) => Array.from({ length: n }, (_, i) => c(i, 100 + i * 0.5, 100.4 + i * 0.5, 99.8 + i * 0.5, 100.3 + i * 0.5));

// OKX provenance and close confirmation.
{
  const row = [String(T0), '100', '102', '99', '101', '10', '1', '1015', '1'];
  const parsed = parseOkxCandle(row, 'BTC-USDT-SWAP')!;
  assert.equal(parsed.v, 1015); assert.equal(parsed.volumeSource, 'quote'); assert.equal(parsed.confirm, 1);
  const estimate = parseOkxCandle([String(T0), '100', '102', '99', '101', '10', '1', '0', '1'], 'BTC-USDT-SWAP')!;
  assert.equal(estimate.volumeSource, 'base_close_estimate');
  assert.equal(preferCandle(parsed, { ...parsed, confirm: 0, v: 99999 }, parsed.v, 99999).confirm, 1);
  assert.equal(isClosedCandle({ ...parsed, confirm: 0 }, B, T0 + B + 99999), false);
  assert.equal(parseOkxCandle([String(T0), '0', '1', '0', '1', '1'], 'BTC-USDT-SWAP'), null);
}
// EMA seed is causal and null during warmup.
{
  const cs = rising(25), e = emaSeries(cs);
  assert.equal(e[18], null); assert.ok(e[19] !== null);
  assert.deepEqual(e.slice(0, 22), emaSeries(cs.slice(0, 22)));
}
// H1/H2 are resume attempts, with an intervening lower high.
{
  const cs = rising(); const n = cs.length;
  const highs = [118, 116, 117, 114, 113, 115];
  highs.forEach((h, j) => cs.push(c(n + j, h - 0.5, h, h - 1.2, h - 0.2)));
  const a = assessBars(cs, opts);
  const attempts = a.flatMap(x => x.attempt?.side === 'long' ? [x.attempt.count] : []);
  assert.deepEqual(attempts.slice(-2), [1, 2]);
  assert.equal(a[n + 2].attempt?.count, 1); assert.equal(a[n + 5].attempt?.count, 2);
  // The bar that already traded above its prior high cannot be retroactively filled.
  const setup = a[n + 4]; const p = makePlan(cs[n + 4], setup, 'BTC-USDT-SWAP', opts)!;
  assert.ok(p); assert.equal(p.signalCloseTime, cs[n + 4].ts + B); assert.ok(p.entry > cs[n + 4].h);
}
// Mirror L counts in a bear correction.
{
  const cs = Array.from({ length: 35 }, (_, i) => c(i, 120 - i * 0.5, 120.4 - i * 0.5, 119.8 - i * 0.5, 119.9 - i * 0.5));
  const n = cs.length; [102,104,103,106,107,105].forEach((l,j)=>cs.push(c(n+j,l+0.5,l+1.2,l,l+0.2)));
  const attempts = assessBars(cs, opts).flatMap(x => x.attempt?.side === 'short' ? [x.attempt.count] : []);
  assert.deepEqual(attempts.slice(-2), [1,2]);
}
// EMA gap bar and first touch after 20 untouched bars are distinct facts.
{
  const cs = rising(24).map(x => ({ ...x, l: x.o + 2, h: x.h + 3 }));
  cs.push(c(24, 80, 81, 79, 80));
  const a = assessBars(cs, opts);
  assert.equal(a[24].emaGap, 'below'); assert.equal(a[24].firstEmaTouchAfter20, false);
  const above = Array.from({ length: 40 }, (_, i) => c(i, 100 + i, 101 + i, 99.8 + i, 100.5 + i));
  above.push(c(40, 140, 141, 130, 140.5));
  const b = assessBars(above, opts);
  assert.ok(b[39].untouchedEmaBars >= 20);
  assert.ok(b[40].firstEmaTouchAfter20); assert.equal(b[40].emaGap, null);
}
// Stop entry: unfilled, gap invalidation, ambiguous path, and cost reconciliation.
{
  const cs = rising(32);
  const p: ResearchPlan = { id: 'x', side: 'long', attempt: 2, signalTs: cs[31].ts, signalCloseTime: cs[31].ts+B, entry: 117, stop: 115, target: 121, expiresAfterTs: cs[31].ts+2*B, risk: 2, breakEvenWinRate: null, warnings: [] };
  const no = replayPlan([...cs, c(32,116,116.8,115.5,116)],31,p,opts); assert.equal(no.status,'expired'); assert.equal(no.fill,null);
  const gap = replayPlan([...cs, c(32,114,118,113,117)],31,p,opts); assert.equal(gap.status,'skipped_gap');
  const amb = replayPlan([...cs, c(32,116.5,122,114,118)],31,p,opts); assert.equal(amb.status,'ambiguous'); assert.equal(amb.netR,null);
  const win = replayPlan([...cs, c(32,116.5,118,116,117), c(33,117,121.5,116.8,120)],31,p,opts);
  assert.equal(win.status,'tp'); assert.ok(win.netR! > 1.8 && win.netR! < 2); assert.ok(win.costR! > 0);
  const gross = (win.exit!-win.fill!)/((win.fill!-p.stop));
  const fees = (win.fill!+win.exit!)*opts.feeRate/(win.fill!-p.stop);
  assert.ok(Math.abs(gross-fees-win.netR!)<1e-10);
}
// Data quality: forming excluded, gaps truncate, estimates disclosed, duplicates conflict.
{
  const cs = rising(90); cs[40] = c(42,100,101,99,100); cs.push(c(90,100,101,99,100,{confirm:0}));
  const r = auditPriceAction(cs,'BTC-USDT-SWAP',opts);
  assert.equal(r.quality.forming,1); assert.ok(r.quality.missingBars>0); assert.ok(r.quality.excludedBeforeGap>0); assert.ok(r.quality.usable);
  assert.ok(r.causalPrefixCheck); assert.equal(r.bars.length,r.quality.accepted);
  const bad = auditPriceAction([c(0,100,101,99,100),c(0,100,102,99,101)],'BTC-USDT-SWAP',opts);
  assert.equal(bad.quality.duplicates,1); assert.equal(bad.quality.usable,false);
  const est = auditPriceAction(rising(65).map(x=>({...x,volumeSource:'base_close_estimate' as const})),'BTC-USDT-SWAP',opts);
  assert.equal(est.quality.estimatedVolume,65); assert.ok(est.quality.issues.some(x=>x.includes('估算')));
}
// Prefix invariance: future bars never change an earlier assessment or setup.
{
  const cs = rising(90); const full = auditPriceAction(cs,'BTC-USDT-SWAP',opts);
  for (const p of full.plans) {
    const i = full.bars.findIndex(x=>x.ts===p.signalTs);
    const prefix = auditPriceAction(cs.slice(0,i+1),'BTC-USDT-SWAP',opts);
    assert.deepEqual(prefix.latestPlan, p);
  }
  assert.throws(()=>normalizeOptions({tickSz:0}));
}
console.log('price-action: data provenance, H/L counts, EMA gaps, stop replay, costs, ambiguity and causality passed');
