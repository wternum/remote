import { getCandles, fetchBookLive } from '@/server/okx';
import { SYMBOLS } from '@/lib/types';
import { runScan, SCAN_BARS, liveFlowOf, EXIT_PLANS, type Candidate, type ExitPlan } from '@/quant/scan';
import { FACTORS, MODEL } from '@/quant/model';
import { getConfig } from '@/quant/config';
import { closedCandles } from '@/lib/candles';
import { getFlow, syncFlow, type FlowSnapshot } from '@/quant/flow';

export const dynamic = 'force-dynamic';

const TTL = 45_000;
const CAP = 320;
const CACHE = new Map<string, { at: number; res: unknown }>();

const bookImbalance = (bids: { s: number }[], asks: { s: number }[]) => {
  const sb = bids.reduce((s, l) => s + l.s, 0);
  const sa = asks.reduce((s, l) => s + l.s, 0);
  return sb + sa > 0 ? (sb - sa) / (sb + sa) : 0;
};

/** parts 可由 evidence × weight × gain 还原，出网时省略以控制体积 */
function wire(c: Candidate) {
  return {
    id: c.id,
    idx: c.idx,
    ts: c.ts,
    side: c.side,
    pattern: c.pattern,
    mode: c.mode,
    level: c.level,
    neck: c.neck,
    firstTs: c.firstTs,
    secondTs: c.secondTs,
    entry: c.entry,
    stop: c.stop,
    tp: c.tp,
    structure: c.structure,
    proba: c.proba,
    grade: c.grade,
    evidence: c.evidence,
    tags: c.tags,
    note: c.note,
    rr: c.rr,
    heightAtr: c.heightAtr,
    spanBars: c.spanBars,
    live: c.live,
    sym: c.sym,
    bar: c.bar,
    // Small, useful provenance fields must survive the wire format; otherwise
    // the API silently turns a real/taker candidate into an anonymous score.
    trap: c.trap,
    trapScore: c.trapScore,
    flowSource: c.flowSource,
    headline: c.headline,
    outcome: c.outcome,
    exits: c.exits,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol') ?? 'BTC-USDT-SWAP';
  const bar = url.searchParams.get('bar') ?? '5m';
  const fresh = url.searchParams.get('fresh') === '1';
  const exitParam = (url.searchParams.get('exit') ?? 'neck') as ExitPlan;
  const plan: ExitPlan = ['neck', 'r15', 'r10', 'be', 'partial'].includes(exitParam) ? exitParam : 'neck';
  const key = `${symbol}|${bar}|${plan}`;
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return Response.json(hit.res);

  const list = symbol === 'ALL' ? SYMBOLS.map(s => s.id as string) : [symbol];
  const timeframes = bar === 'ALL' ? ['5m', '15m'] : [bar];
  const confirmRows: ReturnType<typeof runScan>['confirm'] = [];
  const touchRows: ReturnType<typeof runScan>['touch'] = [];
  let allLive = true;
  let bars = 0;
  let from = Infinity;
  let to = 0;
  let lastTs = 0;
  let flow: ReturnType<typeof liveFlowOf> | undefined;
  // 逐币种 / 逐周期拉取，避免触发 OKX 历史 K 线限频造成缺口
  for (const tf of timeframes) {
    for (const s of list) {
      const { live, candles: rawCandles } = await getCandles(s, tf, SCAN_BARS(tf));
      // getCandles also serves the chart and therefore includes OKX's forming
      // candle.  The confirmation engine is strictly closed-bar only.
      const candles = closedCandles(rawCandles, tf);
      allLive = allLive && live;
      bars += candles.length;
      if (candles.length) {
        from = Math.min(from, candles[0].ts);
        to = Math.max(to, candles[candles.length - 1].ts);
        lastTs = Math.max(lastTs, candles[candles.length - 1].ts);
      }
      // Never carry the previous symbol/timeframe's book or volume ratio into
      // a degraded/synthetic market.
      flow = undefined;
      let bookImb: number | null = null;
      if (live) {
        try {
          const book = await fetchBookLive(s, 10);
          bookImb = bookImbalance(book.bids, book.asks);
        } catch {
          bookImb = null;
        }
        flow = liveFlowOf(candles, bookImb, null);
      }

      // Node can use OKX rubik's official taker/OI history.  Bound the
      // pagination so a panel request does not turn into an unbounded history
      // download; uncovered older bars remain explicitly approximate.  In the
      // browser, reuse the snapshot maintained by useFlow instead of starting
      // a second tape/bootstrap loop.
      let flowSnapshot: FlowSnapshot | null = null;
      if (live && candles.length) {
        if (typeof window === 'undefined') {
          try {
            flowSnapshot = await syncFlow(s, tf, {
              minTs: candles[0]?.ts ?? 0,
              maxPages: 4,
              oiPages: 2,
            });
          } catch {
            flowSnapshot = null;
          }
        } else {
          flowSnapshot = getFlow(s, tf) ?? null;
        }
      }
      const scan = runScan(candles, tf, flow, s, plan, flowSnapshot);
      confirmRows.push(...scan.confirm);
      touchRows.push(...scan.touch);
    }
  }
  const byTs = (a: { ts: number }, b: { ts: number }) => a.ts - b.ts;
  confirmRows.sort(byTs);
  touchRows.sort(byTs);
  const cfg = getConfig();
  const primary = timeframes[timeframes.length - 1];
  const res = {
    symbol,
    bar,
    symbols: list,
    timeframes,
    live: allLive,
    from: Number.isFinite(from) ? from : 0,
    to,
    lastTs,
    bars,
    barMs: primary === '15m' ? 900_000 : 300_000,
    maxHold: primary === '15m' ? 48 : 96,
    generatedAt: Date.now(),
    factors: FACTORS.map(f => ({
      key: f.key,
      label: f.label,
      short: f.short,
      hint: f.hint,
      group: f.group,
      weight: f.weight,
      liveOnly: !!f.liveOnly,
    })),
    model: MODEL,
    config: cfg,
    exitPlan: plan,
    exitPlans: EXIT_PLANS,
    flow,
    confirm: confirmRows.slice(-CAP).map(wire),
    touch: touchRows.slice(-CAP).map(wire),
  };
  CACHE.set(key, { at: Date.now(), res });
  return Response.json(res);
}
