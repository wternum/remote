// Multi-timeframe Williams-fractal structure from already-loaded candles.
// No extra provider requests. Higher timeframes are exact UTC aggregations,
// but ONLY complete buckets with every child bar present and closed are used.
// A pivot is tradable information only after its rightmost confirming bar closes.
import type { Candle, VolumeSource } from '@/lib/types';
import { isClosedCandle } from '@/lib/okxCandles';

const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const WEEK_EPOCH_OFFSET = 4 * DAY; // 1970-01-01 was Thursday; UTC weeks start Monday.

const validBar = (c: Candle | undefined): c is Candle => !!c &&
  [c.ts, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) &&
  Number.isSafeInteger(c.ts) && c.ts > 0 && c.l > 0 &&
  c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.v >= 0;

function bucketBounds(ts: number, interval: number): { start: number; end: number } {
  if (interval >= 28 * DAY) {
    const d = new Date(ts);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return { start, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  }
  if (interval === WEEK) {
    const start = Math.floor((ts - WEEK_EPOCH_OFFSET) / WEEK) * WEEK + WEEK_EPOCH_OFFSET;
    return { start, end: start + WEEK };
  }
  const start = Math.floor(ts / interval) * interval;
  return { start, end: start + interval };
}

function mergedVolumeSource(sources: readonly (VolumeSource | undefined)[]): VolumeSource | undefined {
  const known = sources.filter((s): s is VolumeSource => !!s);
  if (!known.length) return undefined;
  const first = known[0];
  if (known.every(s => s === first)) return first;
  // Mixed/estimated children must never be promoted to exact quote turnover.
  return known.every(s => s === 'quote') ? 'quote' : 'synthetic';
}

export interface ResampleOptions {
  now?: number;
  /** Diagnostic opt-in; default excludes partial/open/gapped buckets. */
  includePartial?: boolean;
}

/** Exact OHLC aggregation; incomplete higher-timeframe buckets are excluded by default. */
export function resample(cs: readonly Candle[], fromMs: number, toMs: number, options: ResampleOptions = {}): Candle[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs <= 0 || toMs < fromMs) return [];
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) return [];
  if (toMs === fromMs) return cs.filter(c => validBar(c) && c.ts < now && isClosedCandle(c, fromMs, now)).map(c => ({ ...c }));
  if (toMs % fromMs !== 0 && toMs < 28 * DAY) return [];
  const out: Candle[] = [];
  let start = -1, end = -1, expected = 0;
  let group: Candle[] = [];
  let previousTs = -1;
  const flush = () => {
    if (!group.length) return;
    const first = group[0], last = group[group.length - 1];
    const allClosed = group.every(c => c.ts < now && isClosedCandle(c, fromMs, now));
    const complete = group.length === expected && first.ts === start && last.ts === end - fromMs &&
      group.every((c, i) => c.ts === start + i * fromMs) && allClosed && end <= now;
    if (complete || options.includePartial) {
      out.push({
        ts: start, o: first.o,
        h: Math.max(...group.map(c => c.h)), l: Math.min(...group.map(c => c.l)),
        c: last.c, v: group.reduce((s, c) => s + c.v, 0),
        confirm: complete ? 1 : 0,
        volumeSource: mergedVolumeSource(group.map(c => c.volumeSource)),
      });
    }
    group = [];
  };
  for (const c of cs) {
    if (!validBar(c) || c.ts <= previousTs) continue; // Caller supplies chronological, deduped data.
    previousTs = c.ts;
    const bucket = bucketBounds(c.ts, toMs);
    if (bucket.start !== start) {
      flush();
      start = bucket.start;
      end = bucket.end;
      expected = Math.round((end - start) / fromMs);
    }
    group.push(c);
  }
  flush();
  return out;
}

export interface FractalPoint {
  idx: number;
  /** Pivot candle OPEN time, not the time the pivot became known. */
  ts: number;
  price: number;
  /** Close time of the rightmost confirming candle. */
  confirmedAt: number;
}

export function inferBarMs(cs: readonly Candle[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i].ts - cs[i - 1].ts;
    if (Number.isFinite(d) && d > 0) gaps.push(d);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Strict Williams fractals, emitted only once the entire right window has closed. */
export function fractals(cs: readonly Candle[], k = 2, barMs?: number, now = Date.now()): { highs: FractalPoint[]; lows: FractalPoint[] } {
  const highs: FractalPoint[] = [], lows: FractalPoint[] = [];
  const width = Number.isInteger(k) && k > 0 ? k : 2;
  const interval = barMs != null && barMs > 0 ? barMs : inferBarMs(cs);
  if (!(interval > 0) || !Number.isFinite(now) || cs.length < 2 * width + 1) return { highs, lows };
  for (let i = width; i < cs.length - width; i++) {
    const center = cs[i];
    if (!validBar(center)) continue;
    let isH = true, isL = true, closed = true;
    for (let j = i - width; j <= i + width; j++) {
      const c = cs[j];
      if (!validBar(c) || c.ts >= now || !isClosedCandle(c, interval, now)) { closed = false; break; }
      if (j === i) continue;
      if (c.h >= center.h) isH = false;
      if (c.l <= center.l) isL = false;
      if (!isH && !isL) break;
    }
    if (!closed) continue;
    const confirmedAt = cs[i + width].ts + interval;
    if (confirmedAt > now) continue;
    if (isH) highs.push({ idx: i, ts: center.ts, price: center.h, confirmedAt });
    if (isL) lows.push({ idx: i, ts: center.ts, price: center.l, confirmedAt });
  }
  return { highs, lows };
}

export type HighRel = 'HH' | 'LH' | 'EQH';
export type LowRel = 'HL' | 'LL' | 'EQL';
export type Tfbias = 'bull' | 'bear' | 'range' | 'unknown';

export interface FractalPivot {
  kind: 'high' | 'low';
  idx: number;
  ts: number;
  price: number;
  rel: HighRel | LowRel;
  confirmedAt: number;
}

export interface TfRow {
  tf: string;
  minutes: number;
  bars: number;
  requiredBars: number;
  bias: Tfbias;
  highRel: HighRel | null;
  lowRel: LowRel | null;
  lastHigh: number | null;
  lastHighTs: number | null;
  highConfirmedAt: number | null;
  lastLow: number | null;
  lastLowTs: number | null;
  lowConfirmedAt: number | null;
  recentPivots: FractalPivot[];
  insufficient: boolean;
  invalidated: boolean;
  reason: string;
}

export interface MtfRead {
  base: string;
  rows: TfRow[];
  considered: number;
  score: number;
  verdict: 'long' | 'short' | 'mixed';
  bias: 1 | -1 | 0;
  strength: number;
  headline: string;
}

export function labelOf(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${minutes / 60}h`;
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  return `${minutes / 1440}d`;
}

/** Base + at most three standard, exactly divisible higher intervals. */
export function tfLadder(baseMinutes: number): number[] {
  if (!Number.isFinite(baseMinutes) || baseMinutes <= 0) return [];
  const STD = [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 10080];
  const res = [baseMinutes];
  for (const s of STD) {
    if (s > baseMinutes && s % baseMinutes === 0) {
      res.push(s);
      if (res.length >= 4) break;
    }
  }
  return res;
}

const cmpRel = (a: number, b: number, tolPct: number): 1 | 0 | -1 => {
  const d = (a - b) / Math.max(1e-9, Math.abs(b));
  return d > tolPct ? 1 : d < -tolPct ? -1 : 0;
};

interface StructureOptions {
  barMs?: number;
  now?: number;
  minBars?: number;
}

/** HH+HL = bull; LH+LL = bear. HH+LL / LH+HL are expansion/contraction, NOT trends. */
export function tfStructure(cs: readonly Candle[], k = 2, tolPct = 0.0008, options: StructureOptions = {}): TfRow {
  const now = options.now ?? Date.now();
  const interval = options.barMs ?? inferBarMs(cs);
  const requiredBars = Math.max(12, 2 * k + 2);
  const { highs, lows } = fractals(cs, k, interval, now);
  const insufficient = cs.length < requiredBars || highs.length < 2 || lows.length < 2;
  let highRel: HighRel | null = null, lowRel: LowRel | null = null;
  let bias: Tfbias = 'unknown', invalidated = false;
  let reason = `需要至少 ${requiredBars} 根完整收盘 K 线及两组高低分形；当前 ${cs.length} 根。`;
  const lastHigh = highs.at(-1) ?? null, lastLow = lows.at(-1) ?? null;
  const recentPivots: FractalPivot[] = [];
  if (!insufficient) {
    for (let i = Math.max(1, highs.length - 2); i < highs.length; i++) {
      const r = cmpRel(highs[i].price, highs[i - 1].price, tolPct);
      recentPivots.push({
        kind: 'high', idx: highs[i].idx, ts: highs[i].ts, price: highs[i].price,
        rel: r === 1 ? 'HH' : r === -1 ? 'LH' : 'EQH', confirmedAt: highs[i].confirmedAt,
      });
    }
    for (let i = Math.max(1, lows.length - 2); i < lows.length; i++) {
      const r = cmpRel(lows[i].price, lows[i - 1].price, tolPct);
      recentPivots.push({
        kind: 'low', idx: lows[i].idx, ts: lows[i].ts, price: lows[i].price,
        rel: r === 1 ? 'HL' : r === -1 ? 'LL' : 'EQL', confirmedAt: lows[i].confirmedAt,
      });
    }
    recentPivots.sort((a, b) => a.idx - b.idx);
    const prevHigh = highs[highs.length - 2], prevLow = lows[lows.length - 2];
    const hr = cmpRel(lastHigh!.price, prevHigh.price, tolPct);
    const lr = cmpRel(lastLow!.price, prevLow.price, tolPct);
    highRel = hr === 1 ? 'HH' : hr === -1 ? 'LH' : 'EQH';
    lowRel = lr === 1 ? 'HL' : lr === -1 ? 'LL' : 'EQL';
    if (hr === 1 && lr === 1) bias = 'bull';
    else if (hr === -1 && lr === -1) bias = 'bear';
    else bias = 'range';
    // A confirmed structural low/high violated AFTER it became known invalidates
    // the directional label until a new confirmed pivot sequence forms.
    if (bias === 'bull') {
      invalidated = cs.some((c, i) => i > lastLow!.idx + k && c.ts >= lastLow!.confirmedAt &&
        c.ts < now && isClosedCandle(c, interval, now) && c.c < lastLow!.price * (1 - tolPct));
    } else if (bias === 'bear') {
      invalidated = cs.some((c, i) => i > lastHigh!.idx + k && c.ts >= lastHigh!.confirmedAt &&
        c.ts < now && isClosedCandle(c, interval, now) && c.c > lastHigh!.price * (1 + tolPct));
    }
    if (invalidated) {
      bias = 'range';
      reason = '最近确认的防守分形已被后续收盘破坏；等待新的确认结构，不沿用旧趋势标签。';
    } else {
      reason = bias === 'bull' ? '更高高点 + 更高低点（HH/HL）。'
        : bias === 'bear' ? '更低高点 + 更低低点（LH/LL）。'
        : '高低点关系不构成同向趋势（扩张、收缩或等高/等低）。';
    }
  }
  return {
    tf: '', minutes: 0, bars: cs.length, requiredBars, bias, highRel, lowRel,
    lastHigh: lastHigh?.price ?? null, lastHighTs: lastHigh?.ts ?? null, highConfirmedAt: lastHigh?.confirmedAt ?? null,
    lastLow: lastLow?.price ?? null, lastLowTs: lastLow?.ts ?? null, lowConfirmedAt: lastLow?.confirmedAt ?? null,
    recentPivots, insufficient, invalidated, reason,
  };
}

/** Alignment needs at least two usable intervals AND two agreeing directional structures. */
export function mtfAlignment(cs: readonly Candle[], baseMinutes: number, k = 2, now = Date.now()): MtfRead {
  const base = labelOf(baseMinutes);
  const rows: TfRow[] = [];
  let bull = 0, bear = 0, considered = 0;
  for (const minutes of tfLadder(baseMinutes)) {
    const ms = minutes * 60_000;
    const bars = resample(cs, baseMinutes * 60_000, ms, { now });
    const row = tfStructure(bars, k, 0.0008, { barMs: ms, now });
    row.tf = labelOf(minutes);
    row.minutes = minutes;
    rows.push(row);
    if (row.insufficient) continue;
    considered++;
    if (row.bias === 'bull') bull++;
    else if (row.bias === 'bear') bear++;
  }
  const score = considered ? (bull - bear) / considered : 0;
  const directional = bull + bear;
  const aligned = considered >= 2 && directional >= 2 && Math.abs(score) >= 0.5;
  const verdict: MtfRead['verdict'] = aligned ? (score > 0 ? 'long' : 'short') : 'mixed';
  const bias: 1 | -1 | 0 = aligned ? (score > 0 ? 1 : -1) : 0;
  const strength = aligned ? r3(Math.abs(score) * Math.min(1, considered / 3)) : 0;
  const detail = rows.filter(r => !r.insufficient).map(r => `${r.tf} ${r.highRel ?? '—'}/${r.lowRel ?? '—'}`).join(' · ');
  const headline = aligned
    ? `${considered} 个可用周期中 ${Math.max(bull, bear)} 个结构同向偏${score > 0 ? '多' : '空'}（${detail}）。同源聚合并非独立样本。`
    : `多周期尚未形成足够对齐（${detail || '完整高级别 K 线不足'}）：不据此给出方向。`;
  return { base, rows, considered, score: r3(score), verdict, bias, strength, headline };
}
