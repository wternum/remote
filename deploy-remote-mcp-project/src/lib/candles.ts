import { barMs, type Candle } from './types';

/**
 * Return only candles whose close time is known at `now`.
 *
 * OKX's /market/candles response includes the currently forming candle
 * (confirm=0).  The chart needs that candle, but a closed-bar strategy must
 * not use it: its high/low/close/volume can still change and would make both
 * live signals and backtests repaint.
 */
export function closedCandles(candles: Candle[], bar: string, now = Date.now()): Candle[] {
  const interval = barMs(bar);
  return candles.filter(c => Number.isFinite(c.ts) && c.ts + interval <= now);
}
