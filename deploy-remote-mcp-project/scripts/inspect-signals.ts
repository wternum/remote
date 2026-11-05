// Read-only real-market audit; test data/synthetic fallbacks are never used here.
// node scripts/run-ts-test.mjs scripts/inspect-signals.ts [BTC-USDT-SWAP|ALL] [5|15|ALL] [300|600|1200] [flow]
// Writes reproducible input and complete annotation output to ignored .verification/ files.
import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_PREFERENCES, normalizePreferences, SIGNAL_TYPES } from '@/vela/signals/store';
import { analyzeSignals, projectSignals } from '@/vela/signals/analyze';
import { buildContext } from '@/quant/context';
import { scanAnnotationPatterns } from '@/vela/signals/patterns';
import { syncFlow, getFlow } from '@/quant/flow';
import { quoteVolumeFromRow } from '@/lib/okxVolume';
import type { Candle } from '@/lib/types';
import type { FlowSnapshot } from '@/quant/flow';
const argv = process.argv.slice(3);
const symbols = argv[0] === 'ALL' ? ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] : [argv[0] || 'BTC-USDT-SWAP'];
const periods = argv[1] === 'ALL' ? ['5', '15'] : [argv[1] || '5'];
const requested = Number(argv[2] || 600);
if (!symbols.every(s => /^(BTC|ETH|SOL)-USDT-SWAP$/.test(s)) || !periods.every(p => ['5', '15'].includes(p)) || ![300, 600, 1200].includes(requested)) throw new Error('Use BTC/ETH/SOL, 5/15 and 300/600/1200');
const prefs = normalizePreferences({ ...DEFAULT_PREFERENCES, lookback: requested });
const all = normalizePreferences({ ...prefs, selected: Object.fromEntries(SIGNAL_TYPES.map(t => [t.id, true])) });
const withFlow = argv.includes('flow');
async function get(path: string, params: Record<string, string>): Promise<(string | number)[][]> {
  const u = new URL(path, 'https://www.okx.com');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let n = 0; n < 4; n++) {
    const r = await fetch(u, { signal: AbortSignal.timeout(12_000) });
    if (r.status === 429 && n < 3) { await new Promise(resolve => setTimeout(resolve, 700 * (n + 1))); continue; }
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j = await r.json() as { code: string; data: (string | number)[][] };
    if (j.code !== '0' || !Array.isArray(j.data)) throw new Error(`OKX code ${j.code}`);
    return j.data;
  }
  throw new Error('OKX rate limited');
}
async function load(symbol: string, tf: string, count: number): Promise<Candle[]> {
  const parse = (r: (string | number)[]): Candle => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: quoteVolumeFromRow(r, symbol) });
  const rows = (await get('/api/v5/market/candles', { instId: symbol, bar: `${tf}m`, limit: '300' })).map(parse);
  if (!rows.length) throw new Error('No real market candles returned');
  let cursor = Math.min(...rows.map(c => c.ts));
  for (let n = 0; rows.length < count && n < 30; n++) {
    const page = (await get('/api/v5/market/history-candles', { instId: symbol, bar: `${tf}m`, limit: '100', after: String(cursor) })).map(parse);
    if (!page.length) break;
    const next = Math.min(...page.map(c => c.ts));
    if (next >= cursor) break;
    rows.push(...page); cursor = next;
    await new Promise(resolve => setTimeout(resolve, 220));
  }
  return [...new Map(rows.map(c => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts).slice(-count);
}
const reports: unknown[] = [];
await mkdir('.verification', { recursive: true });
for (const symbol of symbols) for (const tf of periods) {
  const candles = await load(symbol, tf, requested + 900), barMs = Number(tf) * 60_000;
  let flow: FlowSnapshot | null = null;
  if (withFlow) {
    await syncFlow(symbol, `${tf}m`, { minTs: candles[0].ts, maxPages: Math.min(14, Math.ceil(requested / 100) + 3), oiPages: 0 });
    flow = getFlow(symbol, `${tf}m`) ?? null;
  }
  const now = Date.now(), analysis = analyzeSignals(candles, barMs, prefs, flow, now);
  const view = projectSignals(analysis, prefs), allView = projectSignals(analysis, all);
  const closed = candles.filter(c => c.ts + barMs <= now);
  let start = closed.length - 1;
  while (start > 0 && closed[start].ts - closed[start - 1].ts === barMs) start--;
  const ctx = buildContext(closed.slice(Math.max(0, start)), flow);
  const rawPatterns = scanAnnotationPatterns(ctx).filter(p => ctx.cs[p.idx].ts >= (closed.at(-requested)?.ts ?? 0));
  const stories = analysis.items.filter(i => i.story);
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); analyzeSignals(candles, barMs, prefs, flow, now); timings.push(performance.now() - t); }
  timings.sort((a, b) => a - b);
  const latest = candles.at(-1)!;
  const formingTs = closed.at(-1)!.ts + barMs;
  const changeForming = (offset: number) => {
    const c = Math.max(.01, latest.c + offset);
    return [...closed, { ts: formingTs, o: c, h: c * 1.001, l: c * .999, c, v: latest.v }];
  };
  const signature = (cs: Candle[]) => JSON.stringify(analyzeSignals(cs, barMs, prefs, flow, now).items.filter(i => i.story).map(i => ({ id: i.id, title: i.title, origin: i.story!.origin, evidence: i.story!.evidence, phase: i.story!.phase, targets: i.story!.targets, timeline: i.story!.timeline })));
  const delta = Math.max(ctx.atr.at(-1) ?? 0, latest.c * .001);
  const stable = signature(changeForming(-delta)) === signature(changeForming(delta));
  const phases = Object.fromEntries([...new Set(stories.map(i => i.story!.phase))].map(phase => [phase, stories.filter(i => i.story!.phase === phase).length]));
  const summary = { symbol, timeframe: `${tf}m`, capturedAt: new Date(now).toISOString(), requestedBars: requested,
    loaded: candles.length, closed: closed.length, from: new Date(candles[0].ts).toISOString(), to: new Date(latest.ts).toISOString(),
    analyzedBars: analysis.bars, gapTruncated: analysis.gapTruncated, realCovered: analysis.covered,
    rawPatterns: rawPatterns.length, consolidatedStories: stories.length, phases,
    defaultRecords: view.visible.length, allRecords: allView.visible.length,
    canvas: { events: view.payload.events.length, lines: view.payload.levels.length, zones: view.payload.zones.length, paths: view.payload.paths?.length ?? 0, bytes: Buffer.byteLength(JSON.stringify(view.payload)) },
    medianAnalysisMs: Number(timings[2].toFixed(2)), formingPriceDoesNotRewriteConfirmed: stable,
    duplicateRecordIds: analysis.items.length - new Set(analysis.items.map(i => i.id)).size,
    stories: stories.map(i => ({ id: i.id, title: i.title, lastActivity: new Date(i.story!.lastActivityAt).toISOString(),
      phase: i.story!.phase, line: i.story!.lineKind, active: i.story!.active,
      level: i.story!.level, neck: i.story!.neck, grouped: i.story!.patternCount,
      testCoverage: i.story!.evidence.test?.coverage ?? null, confirmationCoverage: i.story!.evidence.confirmation?.coverage ?? null })) };
  reports.push(summary);
  const stem = `.verification/mw-live-${symbol}-${tf}`;
  await writeFile(`${stem}-input.json`, JSON.stringify({ now, symbol, tf, candles, preferences: prefs,
    flow: flow ? { ...flow, bars: [...flow.bars], tapeBars: flow.tapeBars ? [...flow.tapeBars] : undefined } : null }));
  await writeFile(`${stem}-analysis.json`, JSON.stringify({ summary, analysis, payload: view.payload }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!stable || summary.duplicateRecordIds) throw new Error('M/W invariant failed; examine saved real-market input');
}
await writeFile('.verification/mw-live-summary.json', JSON.stringify(reports, null, 2));
console.log('Real-market reports saved; coverage/results describe this snapshot, not performance or future probability.');
