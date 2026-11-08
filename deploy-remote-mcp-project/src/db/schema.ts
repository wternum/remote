// Re-export the original schema; no remote source files are changed.
export * from '../../remote/setup-mcp-project-locally/src/db/schema';
import { pgTable, text, integer, bigint, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/** Immutable research audit snapshots; never an order/position table. */
export const priceActionAudits = pgTable('price_action_audits', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  bar: text('bar').notNull(),
  fromTs: bigint('from_ts', { mode: 'number' }).notNull(),
  toTs: bigint('to_ts', { mode: 'number' }).notNull(),
  barCount: integer('bar_count').notNull(),
  rules: text('rules').notNull(),
  report: jsonb('report').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('pa_audits_market_time').on(t.symbol, t.bar, t.createdAt)]);
