import type { Candle, VolumeSource } from './types';
import { quoteVolumeOfRow } from './okxVolume';

/** OKX candle array: [ts,o,h,l,c,contracts,base,quote,confirm]. ts is the OPEN time. */
export function parseOkxCandle(row: readonly (string | number)[], symbol: string): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [ts, o, h, l, c] = row.slice(0, 5).map(Number);
  if (![ts, o, h, l, c].every(Number.isFinite) || !Number.isSafeInteger(ts) || ts <= 0 ||
      Math.min(o, h, l, c) <= 0 || h < l || h < Math.max(o, c) || l > Math.min(o, c)) return null;
  const volume = quoteVolumeOfRow(row, symbol);
  if (!volume) return null;
  const rawConfirm = row[8];
  const confirm = rawConfirm === 1 || rawConfirm === '1' ? 1 : rawConfirm === 0 || rawConfirm === '0' ? 0 : undefined;
  return { ts, o, h, l, c, v: volume.value, volumeSource: volume.source, ...(confirm === undefined ? {} : { confirm }) };
}

/** Closed is an exchange fact when supplied; clock expiry is only a labelled legacy fallback. */
export function isClosedCandle(c: Candle, intervalMs: number, now = Date.now(), legacyGraceMs = 1500): boolean {
  if (c.confirm === 1) return true;
  if (c.confirm === 0) return false;
  return Number.isFinite(c.ts) && c.ts + intervalMs + legacyGraceMs <= now;
}

export function preferCandle<T extends { confirm?: 0 | 1; volumeSource?: VolumeSource }>(
  existing: T | undefined,
  incoming: T,
  existingVolume: number,
  incomingVolume: number,
  expired = false,
): T {
  if (!existing) return incoming;
  // Never let a delayed forming snapshot replace an exchange-confirmed close.
  const rank = (c: T) => c.confirm === 1 ? 2 : c.confirm === 0 || expired ? 1 : 0;
  const quality = (c: T) => c.volumeSource === 'quote' ? 1 : 0;
  const a = rank(existing), b = rank(incoming);
  if (a !== b) return b > a ? incoming : existing;
  const qa = quality(existing), qb = quality(incoming);
  if (qa !== qb) return qb > qa ? incoming : existing;
  return incomingVolume >= existingVolume ? incoming : existing;
}

export function mergeCandles(base: readonly Candle[], incoming: readonly Candle[], intervalMs: number, now = Date.now()): Candle[] {
  const out = new Map<number, Candle>();
  for (const c of base) out.set(c.ts, c);
  for (const c of incoming) {
    const old = out.get(c.ts);
    out.set(c.ts, preferCandle(old, c, old?.v ?? 0, c.v, isClosedCandle(c, intervalMs, now)));
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}
