// Four structural views on ONE bounded, closed-candle series.
// These views are correlated (and MTF resamples the same bars), not independent
// statistical evidence. The confluence score is an un-calibrated heuristic.
import type { Candle } from '@/lib/types';
import { isClosedCandle, preferCandle, settledCandles } from '@/lib/okxCandles';
import type { FlowSnapshot } from './flow';
import { buildContext } from './context';
import { readLiquidity, type LiquidityRead } from './liquidity';
import { mtfAlignment, type MtfRead } from './fractal';
import { readWyckoff, type WyckoffRead } from './wyckoff';
import { readAuction, type AuctionRead } from './auction';

export const FRAMEWORK_MAX_BARS = 1200;
const MIN_BARS = 40;
const DAY = 86_400_000;
const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);

export interface FrameworkDataQuality {
  input: number;
  accepted: number;
  invalid: number;
  duplicates: number;
  forming: number;
  future: number;
  missingBars: number;
  gapTruncated: boolean;
  quoteVolumeBars: number;
  estimatedVolumeBars: number;
  /** Every bar in the active AMT window has exchange quote turnover. */
  auctionVolumeReady: boolean;
  issues: string[];
}

export interface Confluence {
  long: number;
  short: number;
  neutral: number;
  unavailable: number;
  net: number;
  verdict: 'long' | 'short' | 'lean_long' | 'lean_short' | 'neutral';
  headline: string;
}

export interface FrameworkReport {
  symbol: string;
  bar: string;
  lastPrice: number;
  lastTs: number;
  bars: number;
  atr: number;
  coverage: number;
  source: 'price' | 'real';
  quality: FrameworkDataQuality;
  liquidity: LiquidityRead;
  mtf: MtfRead;
  wyckoff: WyckoffRead;
  auction: AuctionRead;
  confluence: Confluence;
}

const validBar = (c: Candle | undefined): c is Candle => !!c &&
  [c.ts, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) &&
  Number.isSafeInteger(c.ts) && c.ts > 0 && Math.min(c.o, c.h, c.l, c.c) > 0 &&
  c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.v >= 0;

function nextTimestamp(ts: number, interval: number): number {
  if (interval === 30 * DAY) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return ts + interval;
}

/** Exchange close flag wins; legacy clock fallback gets the project's grace period. */
function closedSeries(input: readonly Candle[], barMs: number, now: number) {
  const quality: FrameworkDataQuality = {
    input: input.length, accepted: 0, invalid: 0, duplicates: 0, forming: 0, future: 0,
    missingBars: 0, gapTruncated: false, quoteVolumeBars: 0, estimatedVolumeBars: 0,
    auctionVolumeReady: false, issues: [],
  };
  const map = new Map<number, Candle>();
  const conflicts = new Set<number>();
  for (const c of input) {
    if (!validBar(c)) { quality.invalid++; continue; }
    if (c.ts >= now) { quality.future++; continue; }
    const old = map.get(c.ts);
    if (old) {
      quality.duplicates++;
      if (old.o !== c.o || old.h !== c.h || old.l !== c.l || old.c !== c.c) conflicts.add(c.ts);
      else map.set(c.ts, preferCandle(old, c, old.v, c.v, isClosedCandle(c, barMs, now)));
    } else map.set(c.ts, c);
  }
  for (const ts of conflicts) { map.delete(ts); quality.invalid++; }
  const deduped = [...map.values()].sort((a, b) => a.ts - b.ts);
  // 中间 K 线遗漏 confirm=1 推送但后续 K 线已收盘：保留以免整段历史被腰斩，并在质量提示中明示
  const { candles: sorted, staleMiddleConfirm, forming } = settledCandles(deduped, barMs, now);
  quality.forming += forming;
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    const expected = nextTimestamp(sorted[i - 1].ts, barMs);
    if (sorted[i].ts !== expected) {
      quality.missingBars += barMs < 28 * DAY ? Math.max(1, Math.round((sorted[i].ts - sorted[i - 1].ts) / barMs) - 1) : 1;
      start = i;
    }
  }
  const candles = sorted.slice(start).slice(-FRAMEWORK_MAX_BARS);
  quality.accepted = candles.length;
  quality.gapTruncated = start > 0;
  const profileBars = candles.slice(-120);
  quality.quoteVolumeBars = profileBars.filter(c => c.volumeSource === 'quote').length;
  quality.estimatedVolumeBars = profileBars.filter(c => c.volumeSource && c.volumeSource !== 'quote').length;
  quality.auctionVolumeReady =
    profileBars.length > 0 && quality.quoteVolumeBars / profileBars.length >= 0.95;
  if (quality.invalid) quality.issues.push(`${quality.invalid} 根非法或冲突 K 线已排除`);
  if (quality.forming) quality.issues.push(`${quality.forming} 根未收盘，不参与结构判定`);
  if (staleMiddleConfirm) quality.issues.push(`${staleMiddleConfirm} 根中间 K 线缺失 confirm=1（后续 K 线已收盘），已保留序列连续性`);
  if (quality.future) quality.issues.push(`${quality.future} 根时间戳不早于分析时钟，已排除`);
  if (quality.gapTruncated) quality.issues.push(`历史存在缺口，仅使用最新连续段；缺失约 ${quality.missingBars} 根`);
  if (!quality.auctionVolumeReady) quality.issues.push('AMT 窗口缺少足够 exact quote 成交额（<95%）；价值区保持未知，不用估算量替代');
  else if (quality.quoteVolumeBars < profileBars.length) {
    quality.issues.push(`AMT 窗口内 ${profileBars.length - quality.quoteVolumeBars} 根缺少 quote 成交额（已排除，仅用其余 ${quality.quoteVolumeBars}/${profileBars.length} 根）`);
  }
  if (candles.length < 120) quality.issues.push(`连续历史仅 ${candles.length} 根，高级别分形可能不足`);
  return { candles, quality };
}

interface Part { label: string; bias: 1 | -1 | 0; strength: number; available: boolean }

function confluenceOf(parts: Part[]): Confluence {
  let long = 0, short = 0, neutral = 0, unavailable = 0, net = 0;
  for (const p of parts) {
    if (!p.available) { unavailable++; continue; }
    if (p.bias > 0) long++;
    else if (p.bias < 0) short++;
    else neutral++;
    net += p.bias * Math.max(0, Math.min(1, p.strength));
  }
  const verdict: Confluence['verdict'] =
    long >= 3 && short === 0 && unavailable === 0 ? 'long'
      : short >= 3 && long === 0 && unavailable === 0 ? 'short'
      : net > 0.15 && long > short ? 'lean_long'
      : net < -0.15 && short > long ? 'lean_short' : 'neutral';
  const name: Record<Confluence['verdict'], string> = {
    long: '多个结构视角同向偏多', short: '多个结构视角同向偏空',
    lean_long: '结构启发式偏多', lean_short: '结构启发式偏空', neutral: '中性 / 分歧 / 数据不足',
  };
  const detail = parts.map(p => `${p.label}:${!p.available ? '无数据' : p.bias > 0 ? '多' : p.bias < 0 ? '空' : '平'}`).join(' · ');
  return {
    long, short, neutral, unavailable, net: r3(net), verdict,
    headline: `${name[verdict]}（多 ${long} / 空 ${short} / 平 ${neutral} / 无数据 ${unavailable}，加权 ${net >= 0 ? '+' : ''}${net.toFixed(2)}）—— ${detail}。同一行情上的相关视角，不是独立投票、概率或胜率。`,
  };
}

/** Returns null when fewer than 40 valid, contiguous, closed bars are available. */
export function buildFrameworks(
  cs: readonly Candle[], barMs: number, symbol: string, bar: string,
  flow?: FlowSnapshot | null, now = Date.now(),
): FrameworkReport | null {
  if (!Number.isFinite(barMs) || barMs <= 0 || !Number.isFinite(now)) return null;
  const { candles: closed, quality } = closedSeries(cs, barMs, now);
  if (closed.length < MIN_BARS) return null;
  const usableFlow = flow && flow.instId === symbol && flow.barMs === barMs ? flow : null;
  const ctx = buildContext(closed, usableFlow);
  const baseMin = Math.max(1, Math.round(barMs / 60_000));
  const atr = ctx.atr.at(-1) ?? 0;
  const liquidity = readLiquidity(ctx);
  const mtf = mtfAlignment(closed, baseMin, 2, now);
  const wyckoff = readWyckoff(ctx);
  const quoteOnly = quality.quoteVolumeBars < Math.min(120, closed.length);
  const auction = quality.auctionVolumeReady ? readAuction(closed, 120, atr, quoteOnly) : {
    ...readAuction([], 120, atr),
    regimeReason: 'AMT 窗口缺少足够交易所 quote 成交额（<95%）；无法可靠构建成交额分布，POC / VAH / VAL 保持未知。',
  };
  const recent = Math.min(48, ctx.n);
  let covered = 0;
  for (let i = ctx.n - recent; i < ctx.n; i++) covered += ctx.real[i];
  const coverage = recent ? covered / recent : 0;
  const confluence = confluenceOf([
    { label: '流动性', bias: liquidity.bias, strength: liquidity.strength, available: liquidity.pools.length > 0 || !!liquidity.structure || liquidity.stopHunts.length > 0 },
    { label: '多周期', bias: mtf.bias, strength: mtf.strength, available: mtf.considered >= 2 },
    { label: 'Wyckoff', bias: wyckoff.bias, strength: wyckoff.strength, available: wyckoff.phase !== 'unknown' },
    { label: 'AMT', bias: auction.bias, strength: auction.strength, available: auction.profile.poc != null },
  ]);
  const last = closed.at(-1)!;
  return {
    symbol, bar, lastPrice: last.c, lastTs: last.ts, bars: closed.length, atr: r3(atr),
    coverage: r3(coverage), source: coverage >= 0.5 ? 'real' : 'price', quality,
    liquidity, mtf, wyckoff, auction, confluence,
  };
}
