import type { Candle } from '@/lib/types';
import type { FlowSnapshot } from '@/quant/flow';

/** Deterministic TEST-ONLY double-top/bottom. Never imported by the shipped application. */
export function annotationCandles(top = true, count = 90, endTs = 1_800_000_000_000): Candle[] {
  const ms = 300_000;
  const end = Math.floor(endTs / ms) * ms;
  const cs: Candle[] = [];
  for (let i = 0; i < count; i++) {
    let c = i < 40 ? 108 + i * 0.24 : i <= 55 ? 118 - (i - 40) * 0.8 : i < 70 ? 106 + (i - 55) * 0.85 : 116 - (i - 70) * 0.16;
    c += Math.sin(i * 0.8) * 0.09;
    const o = i ? cs[i - 1].c : c - 0.2;
    cs.push({ ts: end - (count - i) * ms, o, c, h: Math.max(o, c) + 0.35, l: Math.min(o, c) - 0.35, v: 1_000_000 });
  }
  cs[40] = { ...cs[40], o: 117.3, c: 118, h: 120, l: 117 };
  cs[55] = { ...cs[55], o: 106.7, c: 106, h: 107.1, l: 105 };
  cs[70] = { ...cs[70], o: 119, c: 117, h: 120.1, l: 116, v: 1_800_000 };
  cs[78] = { ...cs[78], v: 3_500_000 };
  if (!top) return cs.map(c => ({ ...c, o: 220 - c.o, h: 220 - c.l, l: 220 - c.h, c: 220 - c.c }));
  return cs;
}
export function annotationFlow(cs: Candle[], buyRatio = 0.15): FlowSnapshot {
  return { instId: 'BTC-USDT-SWAP', period: '5m', barMs: 300_000,
    bars: new Map(cs.map(c => [c.ts, { ts: c.ts, buy: c.v * buyRatio, sell: c.v * (1 - buyRatio), src: 'tape' as const, trades: 100 }])),
    from: cs[0]?.ts ?? 0, to: cs.at(-1)?.ts ?? 0, oiFrom: Infinity,
    updatedAt: 0, complete: true, recent: [], tape: { connected: true, bootstrapped: true, trades: cs.length * 100 },
  };
}
