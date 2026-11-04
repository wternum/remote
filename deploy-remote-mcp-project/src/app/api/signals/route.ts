import { db, initializeDatabase } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface LiveSignalBody {
  id: string;
  symbol: string;
  bar: string;
  barTs: number;
  side: "long" | "short";
  pattern: string;
  entry: number;
  stop: number;
  tp: number;
  confidence: number;
  confluence: number;
  status: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
  exitTs?: number | null;
  rMultiple?: number | null;
  pnlPct?: number | null;
  holdingBars?: number | null;
  exitReason?: string | null;
}

export async function POST(req: Request) {
  try {
    await initializeDatabase();
    const body = (await req.json()) as LiveSignalBody;
    if (!body?.id || !body?.symbol) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    await db.execute(
      sql`
        insert into signals (
          id, symbol, bar, bar_ts, side, pattern, entry, stop, tp,
          confidence, confluence, origin, status,
          entry_price, exit_price, exit_ts, r_multiple, pnl_pct, holding_bars, exit_reason
        )
        values (
          ${body.id}, ${body.symbol}, ${body.bar ?? "5m"}, ${body.barTs}, ${body.side},
          ${body.pattern}, ${body.entry}, ${body.stop}, ${body.tp},
          ${body.confidence ?? 0}, ${body.confluence ?? 0}, 'live', ${body.status ?? "pending"},
          ${body.entryPrice ?? null}, ${body.exitPrice ?? null}, ${body.exitTs ?? null},
          ${body.rMultiple ?? null}, ${body.pnlPct ?? null}, ${body.holdingBars ?? null},
          ${body.exitReason ?? null}
        )
        on conflict (id) do update set
          status = excluded.status,
          entry_price = coalesce(excluded.entry_price, signals.entry_price),
          exit_price = excluded.exit_price,
          exit_ts = excluded.exit_ts,
          r_multiple = excluded.r_multiple,
          pnl_pct = excluded.pnl_pct,
          holding_bars = excluded.holding_bars,
          exit_reason = excluded.exit_reason
      `,
    );
    return Response.json({ ok: true });
  } catch (e) {
    console.warn("signal persist failed:", e);
    return Response.json({ ok: false }, { status: 500 });
  }
}
