import { db } from "@/db";
import { sql } from "drizzle-orm";
import { backtestRuns } from "@/db/schema";
import { getCandles } from "@/server/okx";
import { simulate, summarize, MAX_HOLD_5M, MAX_HOLD_15M } from "@/lib/engine";
import { SYMBOLS, type BacktestResult, type TradedSignal } from "@/lib/types";

export const dynamic = "force-dynamic";

const BT_CACHE = new Map<string, { at: number; res: BacktestResult }>();
const btBars = (bar: string) => (bar === "15m" ? 4320 : 8640); // 15m ≈ 45 天，5m ≈ 30 天

async function persist(recs: TradedSignal[], bar: string) {
  const rows = recs.filter((s) => s.exitTs != null || s.status === "skipped");
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${r.id}, ${r.sym ?? ""}, ${bar}, ${r.ts}, ${r.side}, ${r.pattern},
           ${r.entry}, ${r.stop}, ${r.tp}, ${r.conf}, ${r.confl}, 'backtest',
           ${r.status === "skipped" ? "skipped" : (r.r ?? 0) > 0 ? "won" : "lost"},
           ${r.entryPrice ?? null}, ${r.exitPrice ?? null}, ${r.exitTs ?? null},
           ${r.r ?? null}, ${r.pnlPct ?? null}, ${r.holdingBars ?? null}, ${r.exitReason ?? null})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      insert into signals (
        id, symbol, bar, bar_ts, side, pattern, entry, stop, tp,
        confidence, confluence, origin, status,
        entry_price, exit_price, exit_ts, r_multiple, pnl_pct, holding_bars, exit_reason
      ) values ${values}
      on conflict (symbol, bar, bar_ts, pattern, side) do update set
        entry = excluded.entry, stop = excluded.stop, tp = excluded.tp,
        confidence = excluded.confidence, confluence = excluded.confluence,
        status = excluded.status, entry_price = excluded.entry_price,
        exit_price = excluded.exit_price, exit_ts = excluded.exit_ts,
        r_multiple = excluded.r_multiple, pnl_pct = excluded.pnl_pct,
        holding_bars = excluded.holding_bars, exit_reason = excluded.exit_reason
    `);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "BTC-USDT-SWAP";
  const bar = url.searchParams.get("bar") ?? "5m";
  const flow = url.searchParams.get("flow") === "on";
  const fresh = url.searchParams.get("fresh") === "1";

  const key = `${symbol}|${bar}|${flow}`;
  if (!fresh) {
    const hit = BT_CACHE.get(key);
    if (hit && Date.now() - hit.at < 180_000) return Response.json(hit.res);
  }

  const opts = { flowFilter: flow, maxHold: bar === "15m" ? MAX_HOLD_15M : MAX_HOLD_5M };
  const symbols = symbol === "ALL" ? SYMBOLS.map((s) => s.id as string) : [symbol];

  // 逐个币种拉取，避免触发 OKX 历史 K 线限频导致数据缺口
  const loaded: Awaited<ReturnType<typeof getCandles>>[] = [];
  for (const s of symbols) loaded.push(await getCandles(s, bar, btBars(bar), fresh));
  const recs: TradedSignal[] = [];
  let from = Infinity;
  let to = 0;
  let bars = 0;
  let live = true;
  loaded.forEach(({ live: lv, candles }, idx) => {
    live = live && lv;
    bars += candles.length;
    if (candles.length) {
      from = Math.min(from, candles[0].ts);
      to = Math.max(to, candles[candles.length - 1].ts);
    }
    recs.push(...simulate(candles, symbols[idx], bar, opts));
  });

  const res = summarize(recs, {
    symbol,
    bar,
    from: Number.isFinite(from) ? from : 0,
    to,
    bars,
    scope: symbol === "ALL" ? "all" : "single",
    opts,
    symbols,
  });
  res.live = live;

  // 持久化（容错：DB 不可用不影响返回）
  try {
    await persist(recs, bar);
    await db
      .insert(backtestRuns)
      .values({
        id: `${symbol}_${bar}_${Date.now()}`,
        symbol,
        bar,
        barCount: bars,
        fromTs: res.from,
        toTs: res.to,
        liveSource: live,
        flowFilter: flow,
        signals: res.overall.signals,
        executed: res.overall.executed,
        winRate: res.overall.winRate,
        totalR: res.overall.totalR,
      })
      .onConflictDoNothing();
  } catch (e) {
    console.warn("persist failed:", e);
  }

  BT_CACHE.set(key, { at: Date.now(), res });
  return Response.json(res);
}
