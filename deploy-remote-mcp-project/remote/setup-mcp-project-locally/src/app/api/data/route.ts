import {
  getCandles,
  fetchCandlesLive,
  fetchTickerLive,
  fetchBookLive,
  fetchFundingLive,
  fetchInstrumentMeta,
  synthTicker,
  synthBook,
} from "@/server/okx";
import { ctValOf, type Candle } from "@/lib/types";

export const dynamic = "force-dynamic";

// 用最新的尾部 K 线覆盖缓存（缓存最长 120s，必须补齐，避免与 WebSocket 实时 K 线之间出现缺口）
function mergeTail(base: Candle[], tail: Candle[]): Candle[] {
  if (!tail.length) return base;
  const m = new Map<number, Candle>();
  for (const c of base) m.set(c.ts, c);
  for (const c of tail) m.set(c.ts, c);
  const out = [...m.values()].sort((a, b) => a.ts - b.ts);
  return out.slice(-Math.max(base.length, 1));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  // 默认标的为 USDT 永续合约
  const symbol = url.searchParams.get("symbol") ?? "BTC-USDT-SWAP";
  const bar = url.searchParams.get("bar") ?? "5m";
  const tailOnly = url.searchParams.get("tail") === "1";

  // ── 轻量轮询模式：只返回最新几根 K 线 + 盘口（浏览器 WS 不可达时的实时兜底）
  if (tailOnly) {
    try {
      const [candles, book] = await Promise.all([
        fetchCandlesLive(symbol, bar, 3),
        fetchBookLive(symbol, 5).catch(() => null),
      ]);
      return Response.json({ live: true, candles, book, serverTime: Date.now() });
    } catch {
      return Response.json({ live: false, candles: [], book: null, serverTime: Date.now() });
    }
  }

  const { live, candles: cached } = await getCandles(symbol, bar, 600);
  let candles = cached;
  let ticker;
  let book;
  let fundingRate: number | undefined;
  let nextFundingTime: number | undefined;
  let ctVal = ctValOf(symbol);
  let markPx: number | undefined;

  if (live) {
    const [tail, tk, bk, fr, meta] = await Promise.all([
      fetchCandlesLive(symbol, bar, 20).catch(() => [] as Candle[]),
      fetchTickerLive(symbol).catch(() => null),
      fetchBookLive(symbol, 10).catch(() => null),
      fetchFundingLive(symbol).catch(() => ({ fundingRate: undefined, nextFundingTime: undefined })),
      fetchInstrumentMeta(symbol).catch(() => ({ ctVal: undefined, tickSz: undefined })),
    ]);
    candles = mergeTail(cached, tail);
    ticker = tk ?? synthTicker(candles);
    book = bk && bk.bids.length && bk.asks.length ? bk : synthBook(ticker.last);
    fundingRate = fr.fundingRate;
    nextFundingTime = fr.nextFundingTime;
    if (meta.ctVal && Number.isFinite(meta.ctVal)) ctVal = meta.ctVal;
    // 标记价格：盘口中间价（永续结算参考）
    if (book.bids.length && book.asks.length) {
      markPx = (book.bids[0].p + book.asks[0].p) / 2;
    }
  } else {
    ticker = synthTicker(candles);
    book = synthBook(ticker.last);
  }

  return Response.json({
    live,
    symbol,
    bar,
    candles,
    ticker: { ...ticker, fundingRate, nextFundingTime, markPx, ctVal },
    book,
    serverTime: Date.now(),
  });
}
