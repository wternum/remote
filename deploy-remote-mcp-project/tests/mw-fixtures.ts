import type { Candle } from '@/lib/types';
import type { AnnotationPattern } from '@/vela/signals/patterns';
import type { FlowSnapshot } from '@/quant/flow';
export const MS = 300_000, T0 = 1_800_000_000_000;
export const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ ts: T0 + i * MS, o, h, l, c, v });
export const W: AnnotationPattern = { side: 'bottom', idx: 60, first: 40, second: 60, neckIdx: 50, firstLegStart: 35, secondLegStart: 50, level: 100, neck: 108, secondPrice: 99.9 };
export const M: AnnotationPattern = { ...W, side: 'top', level: 120, neck: 112, secondPrice: 120.1 };
export function flat(len = 78): Candle[] {
  const cs = Array.from({ length: len }, (_, i) => bar(i, 102, 102.4, 101.6, 102));
  if (len > 40) cs[40] = bar(40, 101, 102, 100, 101);
  if (len > 50) cs[50] = bar(50, 103, 108, 102.6, 103);
  for (let i = 51; i <= Math.min(60, len - 1); i++) cs[i].v = 700;
  if (len > 60) cs[60] = bar(60, 100.8, 101.4, 99.9, 101.2, 700);
  return cs;
}
export const mirror = (cs: Candle[]) => cs.map(c => ({ ...c, o: 220 - c.o, h: 220 - c.l, l: 220 - c.h, c: 220 - c.c }));
export function broken(len = 80, start = 70, volume = 2500): Candle[] {
  const cs = flat(len);
  if (len > start) cs[start] = bar(start, 102, 109.4, 101.9, 109, volume);
  if (len > start + 1) cs[start + 1] = bar(start + 1, 109, 109.6, 108.7, 109.2, volume);
  for (let i = start + 2; i < len; i++) cs[i] = bar(i, 109.2, 109.5, 108.9, 109.3);
  return cs;
}
export function retested(len = 78, retestVolume = 1200): Candle[] {
  const cs = broken(len);
  cs[72] = bar(72, 109.2, 109.3, 108.4, 109.1, retestVolume);
  return cs;
}
export function flowOf(cs: Candle[], buyFraction = 0.75): FlowSnapshot {
  return { instId: 'TEST', period: '5m', barMs: MS,
    bars: new Map(cs.map(c => [c.ts, { ts: c.ts, buy: c.v * buyFraction, sell: c.v * (1 - buyFraction), src: 'tape' as const, trades: 100 }])),
    from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: Infinity, updatedAt: 0, complete: true,
    recent: [], tape: { connected: true, bootstrapped: true, trades: cs.length * 100 } };
}
