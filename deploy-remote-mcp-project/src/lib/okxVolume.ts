import { ctValOf } from './types';

/** OKX swap candle volume in quote currency (USDT for the three supported USDT swaps).
 * vol is CONTRACTS, volCcy is base coin, volCcyQuote is quote turnover.
 * Only the last-resort contracts fallback needs ctVal; multiplying vol by price
 * without ctVal overstates BTC by 100× and ETH by 10×.
 */
export function quoteVolumeFromRow(row: readonly (string | number)[], symbol: string): number {
  const quote = Number(row[7]);
  if (Number.isFinite(quote) && quote > 0) return quote;
  const base = Number(row[6]);
  const price = Number(row[4]);
  if (!(price > 0) || !Number.isFinite(price)) return 0;
  if (Number.isFinite(base) && base > 0) return base * price;
  const contracts = Number(row[5]);
  const fallback = contracts * ctValOf(symbol) * price;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}
