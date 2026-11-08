import { createHash } from 'node:crypto';
import { desc, eq, and } from 'drizzle-orm';
import { db, initializeDatabase } from '@/db';
import { priceActionAudits } from '@/db/schema';
import { fetchCandlesWithMeta, fetchInstrumentMeta } from '@/server/okx';
import { SCAN_BARS_ALLOWED, badRequest, parseBar, parseSymbol } from '@/lib/market';
import { barMs } from '@/lib/types';
import { auditPriceAction, PRICE_ACTION_RULES } from '@/quant/priceAction';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

async function buildReport(req: Request) {
  const url = new URL(req.url);
  const symbol = parseSymbol(url.searchParams.get('symbol'));
  const bar = parseBar(url.searchParams.get('bar'), SCAN_BARS_ALLOWED);
  if (!symbol) return { error: badRequest('unknown symbol') };
  if (!bar) return { error: badRequest('unsupported bar; use 5m or 15m') };
  const count = Math.max(60, Math.min(600, Number(url.searchParams.get('bars') ?? 300) || 300));
  // Strict research path: never calls getCandles(), so an upstream failure cannot
  // silently become synthetic data. Instrument tick size must come from OKX.
  const [history, meta] = await Promise.all([fetchCandlesWithMeta(symbol, bar, count), fetchInstrumentMeta(symbol)]);
  if (!meta.tickSz || !meta.ctVal) return { error: json({ error: 'OKX instrument metadata unavailable; refusing reference tick fallback' }, 503) };
  const report = auditPriceAction(history.candles, symbol, { barMs: barMs(bar), tickSz: meta.tickSz, now: Date.now(), requireConfirmed: true });
  const unconfirmed = history.candles.filter(c => c.confirm !== 1).length;
  if (unconfirmed) report.quality.issues.push(`${unconfirmed} 根缺少交易所 confirm=1；已排除`);
  const payload = { symbol, bar, source: 'okx', instrument: { tickSz: meta.tickSz, ctVal: meta.ctVal, source: 'okx-public-instruments' },
    generatedAt: Date.now(), upstreamMissingBars: history.missingBars, upstreamShort: history.short,
    sha256: createHash('sha256').update(JSON.stringify({ report, symbol, bar })).digest('hex'), report };
  return { symbol, bar, payload };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('history') === '1') {
      const symbol = parseSymbol(url.searchParams.get('symbol'));
      const bar = parseBar(url.searchParams.get('bar'), SCAN_BARS_ALLOWED);
      if (!symbol || !bar) return badRequest('invalid market');
      await initializeDatabase();
      const rows = await db.select({ id: priceActionAudits.id, symbol: priceActionAudits.symbol, bar: priceActionAudits.bar,
        fromTs: priceActionAudits.fromTs, toTs: priceActionAudits.toTs, barCount: priceActionAudits.barCount,
        rules: priceActionAudits.rules, createdAt: priceActionAudits.createdAt })
        .from(priceActionAudits).where(and(eq(priceActionAudits.symbol, symbol), eq(priceActionAudits.bar, bar)))
        .orderBy(desc(priceActionAudits.createdAt)).limit(10);
      return json({ records: rows });
    }
    const r = await buildReport(req);
    return r.error ?? json(r.payload);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'price-action audit failed' }, 502);
  }
}

/** Persist a freshly recomputed server audit, not arbitrary client-supplied results. */
export async function POST(req: Request) {
  try {
    const r = await buildReport(req);
    if (r.error) return r.error;
    const { payload, symbol, bar } = r;
    const expected = new URL(req.url).searchParams.get('expected');
    if (expected && expected !== payload?.sha256) return json({ error: '市场快照已变化，请刷新后再保存当前审计', expected, actual: payload?.sha256 }, 409);
    if (!payload || !payload.report.quality.usable || !payload.report.causalPrefixCheck || payload.upstreamMissingBars > 0) {
      return json({ error: 'audit not persistable: insufficient/ discontinuous data or causality failure' }, 422);
    }
    await initializeDatabase();
    const id = payload.sha256;
    await db.insert(priceActionAudits).values({ id, symbol: symbol!, bar: bar!, fromTs: payload.report.fromTs!, toTs: payload.report.toTs!,
      barCount: payload.report.quality.accepted, rules: PRICE_ACTION_RULES, report: payload })
      .onConflictDoNothing();
    return json({ saved: true, id, rules: PRICE_ACTION_RULES });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'audit persistence failed' }, 503);
  }
}
