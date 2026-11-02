import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const signals = pgTable(
  "signals",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    bar: text("bar").notNull().default("5m"),
    barTs: bigint("bar_ts", { mode: "number" }).notNull(),
    side: text("side", { enum: ["long", "short"] }).notNull(),
    pattern: text("pattern").notNull(),
    entry: doublePrecision("entry").notNull(),
    stop: doublePrecision("stop").notNull(),
    tp: doublePrecision("tp").notNull(),
    confidence: integer("confidence").notNull().default(0),
    confluence: integer("confluence").notNull().default(0),
    origin: text("origin", { enum: ["backtest", "live"] }).notNull().default("backtest"),
    status: text("status", {
      enum: ["skipped", "pending", "active", "won", "lost", "time"],
    }).notNull().default("active"),
    entryPrice: doublePrecision("entry_price"),
    exitPrice: doublePrecision("exit_price"),
    exitTs: bigint("exit_ts", { mode: "number" }),
    rMultiple: doublePrecision("r_multiple"),
    pnlPct: doublePrecision("pnl_pct"),
    holdingBars: integer("holding_bars"),
    exitReason: text("exit_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("signals_unique").on(t.symbol, t.bar, t.barTs, t.pattern, t.side),
    index("signals_lookup").on(t.symbol, t.barTs),
  ],
);

export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    bar: text("bar").notNull(),
    barCount: integer("bar_count").notNull().default(0),
    fromTs: bigint("from_ts", { mode: "number" }).notNull(),
    toTs: bigint("to_ts", { mode: "number" }).notNull(),
    liveSource: boolean("live_source").notNull().default(false),
    flowFilter: boolean("flow_filter").notNull().default(true),
    signals: integer("signals").notNull().default(0),
    executed: integer("executed").notNull().default(0),
    winRate: doublePrecision("win_rate"),
    totalR: doublePrecision("total_r"),
    at: timestamp("at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("runs_symbol").on(t.symbol, t.at)],
);
