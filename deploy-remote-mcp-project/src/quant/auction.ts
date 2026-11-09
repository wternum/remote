// Auction Market Theory — a rolling, OHLC-derived turnover-profile approximation.
//
// IMPORTANT LIMITS:
// • Candle.v is quote turnover in this application, not exchange base volume.
// • Uniform allocation across a candle's [low, high] is an assumption. It is
//   neither a tick volume profile nor a TPO/Market Profile reconstruction.
// • The 70% area uses paired-row expansion around the POC. This is not the
//   separate DeMark projected-value-area method.
// • Thin bins are low-volume nodes, NOT TPO single prints. OHLCV cannot prove
//   that a price traded in only one 30-minute TPO period.
// • Price outside value is an extension, not automatic trend acceptance.
//
// All windows end at a supplied closed bar. Early/late profiles share one grid.
import type { Candle } from '@/lib/types';

const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
export const MAX_PROFILE_BINS = 2048;

export interface VaapBin {
  /** Lower edge of a half-open price bucket. */
  price: number;
  mid: number;
  /** Allocated quote turnover, not exact traded base volume. */
  vol: number;
}

export interface AuctionProfile {
  window: { from: number; to: number; bars: number; fromTs: number | null; toTs: number | null };
  method: 'ohlc-turnover-paired-70';
  bin: number;
  /** Fixed grid bounds (may extend beyond observed prices). */
  lo: number;
  hi: number;
  dataLo: number;
  dataHi: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  valuePct: number;
  totalVol: number;
  bins: VaapBin[];
  position: 'above' | 'inside' | 'below' | 'unknown';
  pocDistanceAtr: number;
  valueMid: number | null;
  valueWidthAtr: number;
  atr: number;
}

export interface ValueMigration {
  shiftAtr: number;
  dir: 1 | -1 | 0;
  earlyPoc: number | null;
  latePoc: number | null;
  earlyVa: { vah: number | null; val: number | null };
  lateVa: { vah: number | null; val: number | null };
  earlyWidthAtr: number;
  lateWidthAtr: number;
  widthRatio: number | null;
}

export interface LowVolumeNode {
  from: number;
  to: number;
  /** Mean bin turnover / peak bin turnover. */
  thinness: number;
  side: 'above' | 'below';
  bins: number;
}

export interface AuctionRead {
  profile: AuctionProfile;
  migration: ValueMigration | null;
  lowVolumeNodes: LowVolumeNode[];
  regime: 'balance' | 'upward' | 'downward' | 'expansion' | 'extension' | 'unknown';
  regimeReason: string;
  bias: 1 | -1 | 0;
  /** Un-calibrated structural emphasis, not a probability. */
  strength: number;
}

interface ProfileOptions {
  origin?: number;
  atr?: number;
  maxBins?: number;
}

const validBar = (c: Candle | undefined): c is Candle => !!c &&
  [c.ts, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) &&
  c.l > 0 && c.h >= c.l && c.h >= Math.max(c.o, c.c) &&
  c.l <= Math.min(c.o, c.c) && c.v >= 0;

export function binWidthOf(price: number, atr: number): number {
  const basis = Number.isFinite(atr) && atr > 0 ? 0.25 * atr
    : Number.isFinite(price) && price > 0 ? price * 0.001 : 1;
  return Math.max(Number.EPSILON, basis);
}

/** Existing project convention: simple mean of the last 14 true ranges (not Wilder EMA). */
export function meanTrueRange(cs: readonly Candle[], at: number, period = 14): number {
  const end = Math.min(cs.length - 1, Math.max(0, Math.floor(at)));
  if (end < 0) return 0;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, end - period + 1); i <= end; i++) {
    if (!validBar(cs[i]) || !validBar(cs[i - 1])) continue;
    const c = cs[i], p = cs[i - 1];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    count++;
  }
  if (!count && validBar(cs[end])) return cs[end].h - cs[end].l;
  return count ? sum / count : 0;
}

function emptyProfile(
  from: number, to: number, bars: number, bin: number, price: number, atr: number,
  fromTs: number | null = null, toTs: number | null = null,
): AuctionProfile {
  return {
    window: { from, to, bars, fromTs, toTs }, method: 'ohlc-turnover-paired-70', bin,
    lo: price, hi: price, dataLo: price, dataHi: price,
    poc: null, vah: null, val: null, valuePct: 0, totalVol: 0, bins: [],
    position: 'unknown', pocDistanceAtr: 0, valueMid: null, valueWidthAtr: 0, atr,
  };
}

/**
 * Allocate each candle's turnover by overlap with fixed, half-open price bins.
 * A shared zero-origin grid prevents a changed window low from inventing POC
 * migration. Wide/low-volatility inputs coarsen the grid instead of allocating
 * an unbounded array. The returned `bin` is the actual width used.
 */
export function computeVaap(
  cs: readonly Candle[], from: number, to: number, bin: number,
  options: ProfileOptions = {},
): AuctionProfile {
  if (!cs.length || !Number.isFinite(from) || !Number.isFinite(to)) {
    return emptyProfile(0, -1, 0, binWidthOf(1, 0), 0, 0);
  }
  const a = Math.max(0, Math.min(Math.floor(from), cs.length - 1));
  const b = Math.max(a, Math.min(Math.floor(to), cs.length - 1));
  let dataLo = Infinity, dataHi = -Infinity, totalVol = 0, bars = 0;
  let fromTs: number | null = null, toTs: number | null = null;
  for (let i = a; i <= b; i++) {
    const c = cs[i];
    if (!validBar(c)) continue;
    if (fromTs == null) fromTs = c.ts;
    toTs = c.ts;
    dataLo = Math.min(dataLo, c.l);
    dataHi = Math.max(dataHi, c.h);
    totalVol += c.v;
    bars++;
  }
  const fallbackAtr = options.atr != null && Number.isFinite(options.atr) && options.atr > 0
    ? options.atr : meanTrueRange(cs, b);
  if (!bars || !Number.isFinite(totalVol) || !(totalVol > 0)) {
    return emptyProfile(a, b, bars, binWidthOf(cs[b]?.c ?? 1, fallbackAtr), cs[b]?.c ?? 0, fallbackAtr, fromTs, toTs);
  }
  const maxBins = Math.max(16, Math.min(MAX_PROFILE_BINS, Math.floor(options.maxBins ?? MAX_PROFILE_BINS)));
  let bw = Number.isFinite(bin) && bin > 0 ? bin : binWidthOf(cs[b].c, fallbackAtr);
  bw = Math.max(bw, (dataHi - dataLo) / maxBins);
  const origin = Number.isFinite(options.origin) ? options.origin! : 0;
  let lo = Math.floor((dataLo - origin) / bw) * bw + origin;
  let count = Math.max(1, Math.ceil((dataHi - lo) / bw));
  // Floating-point boundary expansion must not exceed the memory budget.
  while (count > maxBins) {
    bw *= 1.01;
    lo = Math.floor((dataLo - origin) / bw) * bw + origin;
    count = Math.max(1, Math.ceil((dataHi - lo) / bw));
  }
  const hi = lo + count * bw;
  const vols = new Array<number>(count).fill(0);
  const idxOf = (p: number) => Math.min(count - 1, Math.max(0, Math.floor((p - lo) / bw)));
  for (let i = a; i <= b; i++) {
    const c = cs[i];
    if (!validBar(c) || !(c.v > 0)) continue;
    const i0 = idxOf(c.l), i1 = idxOf(c.h);
    if (c.h === c.l) {
      vols[i0] += c.v;
      continue;
    }
    for (let k = i0; k <= i1; k++) {
      const edge = lo + k * bw;
      const overlap = Math.max(0, Math.min(c.h, edge + bw) - Math.max(c.l, edge));
      if (overlap > 0) vols[k] += c.v * overlap / (c.h - c.l);
    }
  }
  const allocated = vols.reduce((s, v) => s + v, 0);
  // Only correct relative floating-point drift; never normalize away real data.
  if (allocated > 0 && Math.abs(allocated - totalVol) > totalVol * 1e-12) {
    const scale = totalVol / allocated;
    for (let k = 0; k < count; k++) vols[k] *= scale;
  }
  const bins = vols.map((vol, k) => {
    const price = lo + k * bw;
    return { price, mid: price + bw / 2, vol };
  });
  const area = valueAreaOf(bins, totalVol, bw);
  const current = cs[b].c;
  const position: AuctionProfile['position'] = area.vah == null || area.val == null ? 'unknown'
    : current >= area.vah ? 'above' : current < area.val ? 'below' : 'inside';
  const valueMid = area.vah != null && area.val != null ? (area.vah + area.val) / 2 : null;
  return {
    window: { from: a, to: b, bars, fromTs, toTs }, method: 'ohlc-turnover-paired-70', bin: bw,
    lo, hi, dataLo, dataHi, ...area, totalVol, bins, position,
    pocDistanceAtr: area.poc == null || !(fallbackAtr > 0) ? 0 : r3(Math.abs(current - area.poc) / fallbackAtr),
    valueMid,
    valueWidthAtr: area.vah == null || area.val == null || !(fallbackAtr > 0) ? 0 : r3((area.vah - area.val) / fallbackAtr),
    atr: fallbackAtr,
  };
}

/**
 * Contiguous ~70% value area using two-row comparisons. Whole pairs are added,
 * so the result can overshoot 70%. POC ties choose the row nearest the range
 * midpoint; expansion ties use remaining side volume, then the lower side.
 * These tie rules are explicit deterministic conventions, not universal rules.
 */
export function valueAreaOf(
  bins: readonly VaapBin[], totalVol?: number, binWidth?: number,
): { poc: number | null; vah: number | null; val: number | null; valuePct: number } {
  const empty = { poc: null, vah: null, val: null, valuePct: 0 };
  if (!bins.length || bins.some(b => !Number.isFinite(b.vol) || b.vol < 0 || !Number.isFinite(b.price))) return empty;
  const sum = bins.reduce((s, b) => s + b.vol, 0);
  const total = totalVol != null && Number.isFinite(totalVol) && totalVol > 0 ? totalVol : sum;
  if (!(sum > 0) || !(total > 0)) return empty;
  const bw = binWidth != null && Number.isFinite(binWidth) && binWidth > 0 ? binWidth
    : bins.length > 1 ? bins[1].price - bins[0].price : 1;
  if (!(bw > 0)) return empty;
  const center = (bins[0].price + bins[bins.length - 1].price + bw) / 2;
  let poc = 0;
  for (let k = 1; k < bins.length; k++) {
    const best = bins[poc], candidate = bins[k];
    if (candidate.vol > best.vol ||
        (candidate.vol === best.vol && Math.abs(candidate.mid - center) < Math.abs(best.mid - center))) poc = k;
  }
  let low = poc, high = poc, acc = bins[poc].vol;
  const target = 0.7 * total;
  const pair = (start: number, step: number) => {
    let value = 0;
    for (let j = 1; j <= 2; j++) {
      const k = start + step * j;
      if (k >= 0 && k < bins.length) value += bins[k].vol;
    }
    return value;
  };
  const remaining = (start: number, end: number) => {
    let value = 0;
    for (let k = Math.max(0, start); k <= Math.min(bins.length - 1, end); k++) value += bins[k].vol;
    return value;
  };
  while (acc < target * (1 - 1e-12) && (low > 0 || high < bins.length - 1)) {
    const up = pair(high, 1), down = pair(low, -1);
    let addUp = up > down;
    if (up === down) {
      const above = remaining(high + 1, bins.length - 1);
      const below = remaining(0, low - 1);
      addUp = above > below; // Exact tie: lower side, never an implicit buy bias.
    }
    if (addUp && high < bins.length - 1) {
      const end = Math.min(bins.length - 1, high + 2);
      while (high < end) acc += bins[++high].vol;
    } else if (low > 0) {
      const end = Math.max(0, low - 2);
      while (low > end) acc += bins[--low].vol;
    } else break;
  }
  return { poc: bins[poc].mid, vah: bins[high].price + bw, val: bins[low].price, valuePct: Math.min(1, acc / total) };
}

/** Disjoint early/late windows on the SAME grid and ATR denominator. */
export function valueMigration(
  cs: readonly Candle[], from: number, to: number, bin: number, atr?: number,
): ValueMigration | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 11) return null;
  const split = Math.floor((from + to) / 2);
  const referenceAtr = atr != null && atr > 0 ? atr : meanTrueRange(cs, to);
  const early = computeVaap(cs, from, split, bin, { origin: 0, atr: referenceAtr });
  const late = computeVaap(cs, split + 1, to, bin, { origin: 0, atr: referenceAtr });
  if (early.poc == null || late.poc == null || early.window.bars < 6 || late.window.bars < 6 || !(referenceAtr > 0)) return null;
  const shift = (late.poc - early.poc) / referenceAtr;
  const dir: 1 | -1 | 0 = shift > 0.15 ? 1 : shift < -0.15 ? -1 : 0;
  return {
    shiftAtr: r3(shift), dir, earlyPoc: early.poc, latePoc: late.poc,
    earlyVa: { vah: early.vah, val: early.val }, lateVa: { vah: late.vah, val: late.val },
    earlyWidthAtr: early.valueWidthAtr, lateWidthAtr: late.valueWidthAtr,
    widthRatio: early.valueWidthAtr > 0 ? r3(late.valueWidthAtr / early.valueWidthAtr) : null,
  };
}

/** Thin contiguous areas BETWEEN price and value, never beyond the current price. */
export function findLowVolumeNodes(profile: AuctionProfile, price: number): LowVolumeNode[] {
  if (profile.poc == null || profile.vah == null || profile.val == null || !Number.isFinite(price) || !(profile.bin > 0)) return [];
  let peak = 0;
  for (const b of profile.bins) peak = Math.max(peak, b.vol);
  if (!(peak > 0)) return [];
  const threshold = 0.12 * peak;
  const out: LowVolumeNode[] = [];
  const scan = (start: number, end: number, side: 'above' | 'below') => {
    const a = Math.max(0, start), b = Math.min(profile.bins.length - 1, end);
    let first = -1, volume = 0;
    const flush = (last: number) => {
      if (first < 0) return;
      const length = last - first + 1;
      if (length >= 2 && volume / length < threshold) out.push({
        from: profile.bins[first].price, to: profile.bins[last].price + profile.bin,
        thinness: r3(volume / length / peak), side, bins: length,
      });
      first = -1;
      volume = 0;
    };
    for (let k = a; k <= b; k++) {
      if (profile.bins[k].vol < threshold) {
        if (first < 0) first = k;
        volume += profile.bins[k].vol;
      } else flush(k - 1);
    }
    flush(b);
  };
  if (price > profile.vah) {
    scan(Math.ceil((profile.vah - profile.lo) / profile.bin), Math.floor((price - profile.lo) / profile.bin), 'above');
  } else if (price < profile.val) {
    scan(Math.floor((price - profile.lo) / profile.bin), Math.floor((profile.val - profile.lo) / profile.bin) - 1, 'below');
  }
  return out;
}

/** Rolling auction context. Extension alone is deliberately NOT a directional signal. */
export function readAuction(cs: readonly Candle[], windowBars = 120, atr?: number): AuctionRead {
  const n = cs.length;
  if (!n) return {
    profile: emptyProfile(0, -1, 0, 1, 0, 0), migration: null, lowVolumeNodes: [],
    regime: 'unknown', regimeReason: '没有已收盘行情，无法计算价值区。', bias: 0, strength: 0,
  };
  const to = n - 1;
  const window = Number.isFinite(windowBars) ? Math.max(2, Math.floor(windowBars)) : 120;
  const from = Math.max(0, n - window);
  const referenceAtr = atr != null && Number.isFinite(atr) && atr > 0 ? atr : meanTrueRange(cs, to);
  const bin = binWidthOf(cs[to].c, referenceAtr);
  const profile = computeVaap(cs, from, to, bin, { origin: 0, atr: referenceAtr });
  const migration = valueMigration(cs, from, to, profile.bin, referenceAtr);
  const lowVolumeNodes = findLowVolumeNodes(profile, cs[to].c);
  if (profile.poc == null) return {
    profile, migration, lowVolumeNodes, regime: 'unknown',
    regimeReason: '窗口没有可用的正成交额，POC / 价值区保持未知。', bias: 0, strength: 0,
  }
  const extended = profile.position === 'above' || profile.position === 'below';
  const priceDir = profile.position === 'above' ? 1 : profile.position === 'below' ? -1 : 0;
  const shift = migration?.shiftAtr ?? 0;
  const alignedMigration = !!migration?.dir && (!extended || migration.dir === priceDir);
  let regime: AuctionRead['regime'] = 'balance';
  let reason = '现价在滚动价值区内，价值重心未出现足够迁移：均衡描述，不代表必然回归 POC。';
  let bias: 1 | -1 | 0 = 0;
  let strength = 0;
  if (alignedMigration && (extended || Math.abs(shift) >= 0.35)) {
    bias = migration!.dir;
    regime = bias > 0 ? 'upward' : 'downward';
    strength = r3(Math.min(1, Math.abs(shift) / 1.5) * (extended ? 1 : 0.7));
    reason = `POC ${bias > 0 ? '上移' : '下移'} ${Math.abs(shift).toFixed(2)} ATR${extended ? '，且现价位于价值区同侧' : '，但现价仍在价值区内'}：价值迁移启发式，尚非成交接受证明。`;
  } else if (extended) {
    regime = 'extension';
    reason = `现价伸到价值区${priceDir > 0 ? '上方' : '下方'}，但价值迁移未同向确认：可能是接受，也可能是拒绝；方向保持中性。`;
  } else if (migration?.widthRatio != null && migration.widthRatio >= 1.25) {
    regime = 'expansion';
    reason = `近期价值区宽度为早期的 ${migration.widthRatio.toFixed(2)} 倍：分布扩张，方向不据此推断。`;
  }
  return { profile, migration, lowVolumeNodes, regime, regimeReason: reason, bias, strength };
}
