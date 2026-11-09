import { tryCtValOf } from './types';
import type { VolumeSource } from './types';

export interface QuoteVolume { value: number; source: VolumeSource; }

/** Exact quote turnover is preferred. Close×quantity is an estimate, NOT exchange VWAP turnover. */
export function quoteVolumeOfRow(row: readonly (string | number)[], symbol: string): QuoteVolume | null {
  const finite = (v: unknown) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0;
  const quote = Number(row[7]), base = Number(row[6]), contracts = Number(row[5]), close = Number(row[4]);
  if (finite(row[7]) && (quote > 0 || (contracts === 0 && (!finite(row[6]) || base === 0)))) return { value: quote, source: 'quote' };
  if (!(close > 0) || !Number.isFinite(close)) return null;
  if (finite(row[6]) && base > 0) return { value: base * close, source: 'base_close_estimate' };
  if (finite(row[5]) && contracts > 0) {
    const ctVal = tryCtValOf(symbol);
    if (ctVal == null) return null;
    const value = contracts * ctVal * close;
    return Number.isFinite(value) ? { value, source: 'contracts_close_estimate' } : null;
  }
  return null;
}

/** Legacy display-only adapter. Research/flow coverage must inspect volumeSource. */
export function quoteVolumeFromRow(row: readonly (string | number)[], symbol: string): number {
  return quoteVolumeOfRow(row, symbol)?.value ?? 0;
}
