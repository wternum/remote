import type { DataProvider, SymbolDescriptor, ProviderInfo, SymbolInfo, BarRange } from "@luxalgo/vela";
import { Candle, SYMBOLS, symbolOf, barMs } from "./types";

const BASE = "https://www.okx.com";
const TF: Record<string, string> = { "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1H" };

function okxBar(tf: string): string {
  return TF[tf] ?? (parseInt(tf, 10) > 0 ? tf + "m" : "5m");
}

async function okxGet(path: string, params: Record<string, string>, timeoutMs = 8000): Promise<unknown> {
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

async function okxGetRetry(path: string, params: Record<string, string>, tries = 4): Promise<(string | number)[][]> {
  let lastErr: unknown = null;
  for (let t = 0; t < tries; t++) {
    try {
      const d = await okxGet(path, params);
      return (d as (string | number)[][]) ?? [];
    } catch (e) {
      lastErr = e;
      if (t < tries - 1) await new Promise((r) => setTimeout(r, 300 * (t + 1)));
    }
  }
  throw lastErr;
}

function parseCandleRow(row: (string | number)[]): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const ts = Number(row[0]);
  const o = Number(row[1]);
  const h = Number(row[2]);
  const l = Number(row[3]);
  const c = Number(row[4]);
  const vRaw = Number(row[5]);
  if (![ts, o, h, l, c, vRaw].every(Number.isFinite)) return null;
  if (!(h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9)) return null;
  // 永续 vol 单位是张：优先用 volCcyQuote（OKX 算好的成交额 USDT）
  const quote = Number(row[7]);
  const ccy = Number(row[6]);
  const v =
    Number.isFinite(quote) && quote > 0 ? quote : Number.isFinite(ccy) && ccy > 0 ? ccy * c : vRaw * c;
  return { ts, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

interface OHLCVBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** 分页拉取 OKX 历史 K 线（最新 → 更早），带限频退避 */
async function fetchHistory(instId: string, bar: string, limit: number): Promise<Candle[]> {
  const bm = barMs(bar);
  const first = await okxGet("/api/v5/market/candles", { instId, bar, limit: String(Math.min(300, limit)) });
  const rows: Candle[] = [];
  for (const r of (first ?? []) as (string | number)[][]) {
    const c = parseCandleRow(r);
    if (c) rows.push(c);
  }
  if (!rows.length) return [];
  rows.sort((a, b) => a.ts - b.ts);
  let oldest = rows[0].ts;
  while (rows.length < limit) {
    const need = limit - rows.length;
    const pages = Math.min(8, Math.ceil(need / 100));
    const batch = await Promise.all(
      Array.from({ length: pages }, (_, q) =>
        okxGetRetry("/api/v5/market/history-candles", {
          instId,
          bar,
          after: String(oldest - (q + 1) * 100 * bm),
          limit: "100",
        }).catch(() => [] as (string | number)[][]),
      ),
    );
    const newestSeen = rows[0].ts;
    let got = 0;
    for (const page of batch) {
      for (const r of page ?? []) {
        const c = parseCandleRow(r);
        if (c && c.ts < newestSeen) {
          rows.push(c);
          got++;
          if (c.ts < oldest) oldest = c.ts;
        }
      }
    }
    rows.sort((a, b) => a.ts - b.ts);
    if (!got) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return rows.slice(-limit);
}

const INFO: ProviderInfo = {
  name: "okx",
  displayName: "OKX",
  supportedTimeframes: ["1", "3", "5", "15", "30", "60"],
  capabilities: { enumerate: true, stream: true, symbolInfo: true },
};

export const OKX_PROVIDER: DataProvider = {
  info: () => INFO,
  listSymbols: () =>
    Promise.resolve(
      SYMBOLS.map((s) => ({
        ticker: s.ticker,
        description: `${s.base} / TetherUS · OKX 永续`,
        type: "futures",
        provider: "okx",
        default: s.ticker === "BTCUSDT",
      })) as SymbolDescriptor[],
    ),
  getSymbolInfo: (ticker) =>
    Promise.resolve({ ticker, ctVal: symbolOf(ticker).ctVal, venue: "OKX" } as unknown as SymbolInfo),
  getBars: async (ticker, timeframe, range: BarRange) => {
    const instId = symbolOf(ticker).id;
    const limit = Math.max(120, Math.min(range.limit ?? 1500, 3000));
    const candles = await fetchHistory(instId, okxBar(timeframe), limit);
    const from = range.from ?? 0;
    const to = range.to ?? Infinity;
    return candles.filter((c) => c.ts >= from - barMs(timeframe) && c.ts <= to).map(
      (c) =>
        ({ time: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }) as OHLCVBar,
    );
  },
  subscribe: (ticker, timeframe, onBar) => {
    const instId = symbolOf(ticker).id;
    const bar = okxBar(timeframe);
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket("wss://ws.okx.com/ws/v5/business");
      } catch {
        retry = setTimeout(open, 3000);
        return;
      }
      ws.onopen = () => {
        attempts = 0;
        try {
          ws!.send(JSON.stringify({ op: "subscribe", args: [{ channel: "candle" + bar, instId }] }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { arg?: { channel: string }; data?: (string | number)[][] };
          if (!msg.arg || !Array.isArray(msg.data)) return;
          for (const r of msg.data) {
            const c = parseCandleRow(r);
            if (!c) continue;
            onBar({ time: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v });
          }
        } catch {}
      };
      ws.onclose = () => {
        if (closed) return;
        attempts++;
        retry = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(attempts, 4)));
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {}
    };
  },
};

// ─── 逐笔成交 + 盘口（信号验证用，按 K 线分桶）──────────────
export interface TapeBucket {
  buy: number;
  sell: number;
  count: number;
  firstTs: number;
  lastTs: number;
  windows: Set<number>;
}

export interface TapeMetrics {
  connected: boolean;
  symbol: string;
  cvd: { ts: number; v: number }[];
  bucket: { buy: number; sell: number };
  bookImb: number | null;
  big: { ts: number; px: number; notional: number; side: "buy" | "sell" }[];
  lastTradeTs: number;
}

export class TapeFeed {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private dead = false;
  private buckets = new Map<number, TapeBucket>();
  private bookImb: number | null = null;
  private cvdAbs = 0;
  private cvdSeries: { ts: number; v: number }[] = [];
  private big: TapeMetrics["big"] = [];
  private medBuf: number[] = [];
  private lastTradeTs = 0;
  private ctVal = 1;
  private barMsMs: number;
  private listeners = new Set<() => void>();
  metrics: TapeMetrics;

  constructor(symbol: string, tf: string) {
    this.barMsMs = barMs(tf);
    this.metrics = {
      connected: false,
      symbol,
      cvd: [],
      bucket: { buy: 0, sell: 0 },
      bookImb: null,
      big: [],
      lastTradeTs: 0,
    };
  }

  setSymbol(symbol: string, tf: string, ctVal: number) {
    this.ctVal = ctVal;
    this.metrics.symbol = symbol;
    this.metrics.connected = false;
    this.buckets.clear();
    this.big = [];
    this.metrics.big = [];
    this.cvdSeries = [];
    this.metrics.cvd = [];
    this.cvdAbs = 0;
    if (tf !== "" ) this.barMsMs = barMs(tf);
    this.restart();
    this.emit();
  }

  seedCvd(pts: { ts: number; v: number }[]) {
    if (!pts.length) return;
    this.cvdAbs = pts[pts.length - 1].v;
    this.cvdSeries = pts.slice(-160);
    this.metrics.cvd = this.cvdSeries;
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    this.metrics = { ...this.metrics };
    this.listeners.forEach((l) => l());
  }

  /** 某根 K 线的逐笔覆盖（用于信号验证：不足 80% 时回退 K 线估算） */
  sampleFor(barTs: number): { buy: number; sell: number; count: number; coverage: number; bookImb?: number } | null {
    const b = this.buckets.get(barTs);
    if (!b) return null;
    const dur = this.barMsMs;
    const span = (b.lastTs - b.firstTs) / dur;
    const coverage = Math.min(span, b.windows.size / 10);
    return { buy: b.buy, sell: b.sell, count: b.count, coverage, bookImb: this.bookImb ?? undefined };
  }

  private restart() {
    this.dead = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.dead = false;
    this.attempts = 0;
    this.open();
  }

  private open() {
    if (this.dead) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket("wss://ws.okx.com/ws/v5/public");
    } catch {
      this.retry = setTimeout(() => this.open(), 3000);
      return;
    }
    this.ws = ws;
    const inst = symbolOf(this.metrics.symbol).id;
    ws.onopen = () => {
      this.attempts = 0;
      try {
        ws.send(
          JSON.stringify({
            op: "subscribe",
            args: [
              { channel: "trades", instId: inst },
              { channel: "books5", instId: inst },
            ],
          }),
        );
      } catch {}
      this.ping = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        } catch {}
      }, 25000);
      if (!this.metrics.connected) {
        this.metrics.connected = true;
        this.emit();
      }
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let msg: { arg?: { channel: string }; data?: unknown };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (!msg.arg || !Array.isArray(msg.data)) return;
      if (msg.arg.channel === "trades") {
        this.onTrades(msg.data as { ts: string; px: string; sz: string; side: string }[]);
      } else if (msg.arg.channel === "books5") {
        const d = (msg.data as { bids: (string | number)[][]; asks: (string | number)[][] }[])[0];
        if (d) this.onBook(d.bids, d.asks);
      }
    };
    ws.onclose = () => {
      if (this.dead) return;
      if (this.ping) clearInterval(this.ping);
      this.metrics.connected = false;
      this.emit();
      this.attempts++;
      this.retry = setTimeout(() => this.open(), Math.min(15000, 1000 * 2 ** Math.min(this.attempts, 4)));
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private onTrades(rows: { ts: string; px: string; sz: string; side: string }[]) {
    const dur = this.barMsMs;
    let now = 0;
    for (const t of rows) {
      const px = Number(t.px);
      const notional = px * Number(t.sz) * this.ctVal;
      if (!Number.isFinite(px) || !Number.isFinite(notional) || notional <= 0) continue;
      now = Math.max(now, Number(t.ts));
      const start = Math.floor((now || Date.now()) / dur) * dur;
      const b =
        this.buckets.get(start) ?? { buy: 0, sell: 0, count: 0, firstTs: now, lastTs: now, windows: new Set<number>() };
      if (t.side === "buy") b.buy += notional;
      else b.sell += notional;
      b.count++;
      b.firstTs = Math.min(b.firstTs, now);
      b.lastTs = Math.max(b.lastTs, now);
      b.windows.add(Math.min(9, Math.floor(((now || 0) - start) / dur * 10)));
      this.buckets.set(start, b);
      this.lastTradeTs = now;
      this.medBuf.push(notional);
      if (this.medBuf.length > 150) this.medBuf.shift();
      const sorted = [...this.medBuf].sort((a, b2) => a - b2);
      const med = sorted[Math.floor(sorted.length / 2)] || 1;
      if (notional > med * 8) {
        this.big.unshift({ ts: now, px, notional, side: t.side === "buy" ? "buy" : "sell" });
        this.big = this.big.slice(0, 12);
      }
    }
    const starts = [...this.buckets.keys()].sort((a, b) => a - b);
    while (starts.length > 8) this.buckets.delete(starts.shift()!);
    const cur = this.buckets.get(starts[starts.length - 1] ?? -1);
    this.metrics.bucket = cur ? { buy: cur.buy, sell: cur.sell } : { buy: 0, sell: 0 };
    this.metrics.big = this.big;
    this.metrics.lastTradeTs = this.lastTradeTs;
    this.emit();
  }

  private onBook(bids: (string | number)[][], asks: (string | number)[][]) {
    let sb = 0;
    let sa = 0;
    for (const b of bids ?? []) sb += Number(b[1]);
    for (const a of asks ?? []) sa += Number(a[1]);
    if (sb + sa <= 0) return;
    this.bookImb = (sb - sa) / (sb + sa);
    this.metrics.bookImb = this.bookImb;
    this.emit();
  }

  /** K 线收盘时推进 CVD（有逐笔用逐笔，否则用 K 线估算） */
  onBarClose(barTs: number, candleDelta: number) {
    const b = this.buckets.get(barTs);
    const delta = b ? b.buy - b.sell : candleDelta;
    this.cvdAbs += delta;
    this.cvdSeries.push({ ts: barTs + this.barMsMs, v: this.cvdAbs });
    if (this.cvdSeries.length > 160) this.cvdSeries.shift();
    this.metrics.cvd = this.cvdSeries;
    this.emit();
  }

  stop() {
    this.dead = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.metrics.connected = false;
    this.emit();
  }
}
