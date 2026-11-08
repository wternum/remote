import { barMs, type Candle } from './types';
import { isClosedCandle } from './okxCandles';

/** Exclude forming bars, including exchange confirm=0 near a boundary. */
export function closedCandles(candles: Candle[], bar: string, now = Date.now()): Candle[] {
  const interval = barMs(bar);
  return candles.filter(c => isClosedCandle(c, interval, now));
}
