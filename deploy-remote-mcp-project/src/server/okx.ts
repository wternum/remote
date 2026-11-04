import { Candle, BookLevel } from "@/lib/types";
import { barMs } from "@/lib/types";
import { quoteVolumeFromRow } from "@/lib/okxVolume";

const BASE = "https://www.okx.com";

// ─── 基础请求 ─────────────────────────────────────────────
async function okxGet(path: string, params: Record<string, string>, timeoutMs = 3000) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = (await res.json()) as { code?: string; data?: unknown };
    if (json.code && json.code !== "0") throw new Error("OKX code " + json.code);
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 带重试的公共行情请求（应对限频）
async function okxGetRetry(
  path: string,
  params: Record<string, string>,
  tries = 4,
): Promise<(string | number)[][]> {
  let lastErr: unknown = null;
  for (let t = 0; t < tries; t++) {
    try {
      const d = await okxGet(path, params);
      return (d as (string | number)[][]) ?? [];
    } catch (e) {
      lastErr = e;
      if (t < tries - 1) await sleep(300 * (t + 1));
    }
  }
  throw lastErr;
}

// 防御性解析：官方格式 [ts,o,h,l,c,vol,volCcy,volCcyQuote,(confirm)]
function parseCandleRow(row: (string | number)[], symbol: string): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const ts = Number(row[0]);
  const o = Number(row[1]);
  const h = Number(row[2]);
  const l = Number(row[3]);
  const c = Number(row[4]);
  if (![ts, o, h, l, c].every(Number.isFinite)) return null;
  if (!(h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9)) return null;
  return { ts, o, h, l, c, v: quoteVolumeFromRow(row, symbol) };
}

// ─── 实时拉取 ─────────────────────────────────────────────
export async function fetchCandlesLive(
  symbol: string,
  bar: string,
  count: number,
): Promise<Candle[]> {
  const first = (await okxGet("/api/v5/market/candles", {
    instId: symbol,
    bar,
    limit: String(Math.min(300, count)),
  })) as (string | number)[][];
  const rows: Candle[] = [];
  for (const r of first ?? []) {
    const c = parseCandleRow(r, symbol);
    if (c) rows.push(c);
  }
  if (rows.length === 0) throw new Error("empty candles");
  rows.sort((a, b) => a.ts - b.ts);

  if (count > rows.length) {
    const need = count - rows.length;
    const pages = Math.ceil(need / 100);
    const oldest = rows[0].ts;
    const bm = barMs(bar);
    // 分批并发（每批 8 个），避免触发 OKX 公共接口限频导致 K 线缺口
    const results: (string | number)[][][] = [];
    for (let start = 0; start < pages; start += 8) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(8, pages - start) }, (_, q) =>
          okxGetRetry("/api/v5/market/history-candles", {
            instId: symbol,
            bar,
            after: String(oldest - (start + q) * 100 * bm),
            limit: "100",
          }).catch(() => [] as (string | number)[][]),
        ),
      );
      results.push(...batch);
      if (start + 8 < pages) await sleep(250);
    }
    for (const page of results) {
      for (const r of page ?? []) {
        const c = parseCandleRow(r, symbol);
        if (c && c.ts < oldest) rows.push(c);
      }
    }
  }

  const map = new Map<number, Candle>();
  for (const c of rows) map.set(c.ts, c);
  const sorted = [...map.values()].sort((a, b) => a.ts - b.ts);
  return sorted.slice(-count);
}

export async function fetchTickerLive(symbol: string) {
  const data = (await okxGet("/api/v5/market/ticker", { instId: symbol })) as Record<
    string,
    string
  >[];
  const t = data?.[0];
  if (!t) throw new Error("empty ticker");
  const last = Number(t.last);
  const open24 = Number(t.open24h);
  return {
    last,
    open24,
    high24: Number(t.high24h),
    low24: Number(t.low24h),
    chg24: open24 > 0 ? ((last - open24) / open24) * 100 : 0,
    // 永续：volCcy24h 为 24h 成交的币数量（张数×面值），× 最新价 ≈ USDT 成交额
    vol24Quote: t.volCcy24h ? Number(t.volCcy24h) * last : undefined,
  };
}

export async function fetchFundingLive(symbol: string) {
  const data = (await okxGet("/api/v5/public/funding-rate", { instId: symbol })) as Record<string, string>[];
  const d = data?.[0];
  if (!d) return { fundingRate: undefined, nextFundingTime: undefined };
  return { fundingRate: Number(d.fundingRate), nextFundingTime: Number(d.nextFundingTime) };
}

export async function fetchInstrumentMeta(symbol: string) {
  const data = (await okxGet("/api/v5/public/instruments", { instType: "SWAP", instId: symbol })) as Record<string, string>[];
  const d = data?.[0];
  if (!d) return { ctVal: undefined, tickSz: undefined };
  return { ctVal: Number(d.ctVal), tickSz: Number(d.tickSz) };
}

export async function fetchBookLive(symbol: string, levels = 10): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  const data = (await okxGet("/api/v5/market/books", { instId: symbol, sz: String(levels) })) as {
    asks: (string | number)[][];
    bids: (string | number)[][];
  };
  const mapLv = (a: (string | number)[]) => ({ p: Number(a[0]), s: Number(a[1]) });
  return {
    bids: (data.bids ?? []).map(mapLv),
    asks: (data.asks ?? []).map(mapLv),
  };
}

// ─── 仿真数据（OKX 不可达时的降级源）──────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 键为永续合约 ID；volUnit 为"张数"
const SYNTH_BASE: Record<string, { price: number; vol: number; volUnit: number }> = {
  "BTC-USDT-SWAP": { price: 97400, vol: 0.0011, volUnit: 9200 },
  "ETH-USDT-SWAP": { price: 3625, vol: 0.0016, volUnit: 26000 },
  "SOL-USDT-SWAP": { price: 214, vol: 0.0022, volUnit: 42000 },
};

export function synthCandles(symbol: string, bar: string, count: number, endTs?: number): Candle[] {
  const cfg = SYNTH_BASE[symbol] ?? { price: 100, vol: 0.002, volUnit: 1000 };
  const bm = barMs(bar);
  const dayKey = Math.floor((endTs ?? Date.now()) / 86400000);
  const rng = mulberry32(hashStr(`${symbol}|${bar}|${dayKey}`));
  const lastStart = Math.floor((endTs ?? Date.now()) / bm) * bm - bm;
  const start = lastStart - (count - 1) * bm;

  const out: Candle[] = [];
  let price = cfg.price * (0.97 + rng() * 0.06);
  let regime = 0;
  for (let i = 0; i < count; i++) {
    regime = regime * 0.982 + (rng() - 0.5) * 0.09;
    if (rng() < 0.012) regime += (rng() - 0.5) * 0.9; // 偶发行情
    const vScale = 1 + 1.6 * Math.abs(regime) + (rng() < 0.06 ? rng() * 2.4 : 0);
    const ret = regime * 0.16 + (rng() + rng() - 1) * cfg.vol * vScale;
    const o = price * (rng() < 0.02 ? 1 + (rng() - 0.5) * cfg.vol * 6 : 1);
    // 4 步子路径
    let p = o;
    let hi = o;
    let lo = o;
    let pc = o;
    for (let s = 0; s < 4; s++) {
      pc = p * (1 + ret / 4 + (rng() - 0.5) * cfg.vol * 0.55 * vScale);
      p = pc;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    const c = p;
    hi = Math.max(hi, o, c) * (1 + rng() * cfg.vol * 0.5 * vScale);
    lo = Math.min(lo, o, c) * (1 - rng() * cfg.vol * 0.5 * vScale);
    const bodyPct = Math.abs(c - o) / o;
    // 仿真成交量按"张"生成，再折算为 USDT 成交额，保持与真实数据同口径
    const v = cfg.volUnit * (0.45 + rng() * 0.8) * (1 + bodyPct / cfg.vol / 2.2) * c;
    out.push({ ts: start + i * bm, o, h: hi, l: lo, c, v });
    price = c;
  }
  return out;
}

export function synthTicker(candles: Candle[]) {
  const last = candles[candles.length - 1];
  const open24 = candles[Math.max(0, candles.length - 1 - 288)]?.c ?? last.o;
  const highs = candles.slice(-288).map((c) => c.h);
  const lows = candles.slice(-288).map((c) => c.l);
  return {
    last: last.c,
    open24,
    high24: Math.max(...highs),
    low24: Math.min(...lows),
    chg24: ((last.c - open24) / open24) * 100,
  };
}

export function synthBook(last: number, seedExtra = 0): { bids: BookLevel[]; asks: BookLevel[] } {
  const rng = mulberry32(hashStr("book" + seedExtra));
  const step = last * 0.00018;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 1; i <= 10; i++) {
    bids.push({ p: last - step * i, s: 0.4 + rng() * 2.2 });
    asks.push({ p: last + step * i, s: 0.4 + rng() * 2.2 });
  }
  return { bids, asks };
}

// ─── 带缓存的统一入口 ─────────────────────────────────────
const cache = new Map<string, { at: number; live: boolean; data: Candle[] }>();

export async function getCandles(
  symbol: string,
  bar: string,
  count: number,
  fresh = false,
): Promise<{ live: boolean; candles: Candle[] }> {
  const key = `${symbol}|${bar}|${count}`;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return { live: hit.live, candles: hit.data };
  }
  try {
    const candles = await fetchCandlesLive(symbol, bar, count);
    if (candles.length < Math.min(count, 200)) throw new Error("insufficient live data");
    cache.set(key, { at: Date.now(), live: true, data: candles });
    return { live: true, candles };
  } catch {
    const candles = synthCandles(symbol, bar, count);
    cache.set(key, { at: Date.now(), live: false, data: candles });
    return { live: false, candles };
  }
}
