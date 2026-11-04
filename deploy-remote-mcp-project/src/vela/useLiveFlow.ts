import { useEffect, useState } from 'react';
import { bigBiasOf, flowPeriodOf, getFlow } from '@/quant/flow';

export interface LiveFlowState {
  /** 五档静态盘口挂单量失衡 (bid−ask)/(bid+ask)，不是订单簿事件 OFI */
  bookImb: number | null;
  /** 最近 120s 大单主动方向，无数据为 null */
  bigBias: number | null;
  bigCount: number;
  bookStale: boolean;
}

const REST = 'https://www.okx.com';
const BOOK_CHANNEL = 'books5'; // OKX public full snapshots; "books50" is NOT a documented channel.

type Level = (string | number)[];
type BookData = { bids?: Level[]; asks?: Level[] };

/** Snapshot depth imbalance is not event-level order-flow imbalance (OFI). */
export function bookImbalanceOf(book: BookData): number | null {
  const sum = (levels: Level[] | undefined) => (levels ?? []).slice(0, 5).reduce((acc, lv) => {
    const size = Number(lv[1]);
    return acc + (Number(lv[0]) > 0 && Number.isFinite(size) && size >= 0 ? size : 0);
  }, 0);
  if (!book.bids?.length || !book.asks?.length) return null;
  const bids = sum(book.bids);
  const asks = sum(book.asks);
  return bids + asks > 0 ? (bids - asks) / (bids + asks) : null;
}

/** OKX books5 WS is a public five-level FULL SNAPSHOT; REST is a same-depth fallback. */
export function useLiveFlow(symbol: string, timeframe: string): LiveFlowState {
  const [state, setState] = useState<LiveFlowState>({ bookImb: null, bigBias: null, bigCount: 0, bookStale: true });

  useEffect(() => {
    if (!symbol) {
      setState(s => ({ ...s, bookImb: null, bookStale: true }));
      return;
    }
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: number | null = null;
    let pollTimer: number | null = null;
    let connectGuard: number | null = null;
    let publishTimer: number | null = null;
    let busy = false;
    let lastBookAt = 0;
    const controller = new AbortController();
    let latest: { imbalance: number | null; stale: boolean } = { imbalance: null, stale: true };
    setState(s => ({ ...s, bookImb: null, bookStale: true })); // symbol switch must drop old book immediately

    const publish = (imbalance: number | null, stale: boolean) => {
      latest = { imbalance, stale };
      if (publishTimer !== null) return;
      // books5 can update every 100ms; coalesce React renders without delaying the stream.
      publishTimer = window.setTimeout(() => {
        publishTimer = null;
        if (alive) setState(s => s.bookImb === latest.imbalance && s.bookStale === latest.stale
          ? s : { ...s, bookImb: latest.imbalance, bookStale: latest.stale });
      }, 200);
    };
    const apply = (data: BookData) => {
      const imbalance = bookImbalanceOf(data);
      if (imbalance === null) return false;
      lastBookAt = Date.now();
      publish(imbalance, false);
      return true;
    };
    const restLoad = async () => {
      if (busy || !alive || (ws?.readyState === WebSocket.OPEN && Date.now() - lastBookAt < 4000)) return;
      busy = true;
      const started = Date.now();
      try {
        const res = await fetch(`${REST}/api/v5/market/books?instId=${encodeURIComponent(symbol)}&sz=5`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
        const json = await res.json() as { code?: string; data?: BookData[] };
        if (json.code !== '0' || !json.data?.[0]) throw new Error('invalid OKX book');
        // An in-flight REST response cannot overwrite a newer WS snapshot.
        if (alive && lastBookAt <= started) apply(json.data[0]);
      } catch {
        if (alive && Date.now() - lastBookAt > 10_000) publish(null, true);
      } finally {
        busy = false;
      }
    };
    const startPoll = () => {
      if (pollTimer !== null) return;
      void restLoad();
      pollTimer = window.setInterval(restLoad, 5000);
    };
    const stopPoll = () => {
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
    };
    const openWs = () => {
      if (!alive) return;
      try {
        ws = new WebSocket('wss://ws.okx.com/ws/v5/public');
      } catch {
        startPoll();
        retry = window.setTimeout(openWs, 3000);
        return;
      }
      const socket = ws;
      ws.onopen = () => {
        socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: BOOK_CHANNEL, instId: symbol }] }));
        // A subscribe ACK is not book data. Keep REST alive until a valid snapshot arrives.
        connectGuard = window.setTimeout(() => { if (lastBookAt === 0 || pollTimer !== null) socket.close(); }, 7000);
      };
      ws.onmessage = event => {
        if (event.data === 'pong') return;
        try {
          const msg = JSON.parse(event.data as string) as { event?: string; arg?: { channel?: string }; data?: BookData[] };
          if (msg.event === 'error') { socket.close(); return; }
          if (msg.arg?.channel !== BOOK_CHANNEL || !msg.data?.[0]) return;
          if (apply(msg.data[0])) {
            if (connectGuard !== null) { window.clearTimeout(connectGuard); connectGuard = null; }
            stopPoll();
          }
        } catch { /* ignore malformed push */ }
      };
      ws.onclose = () => {
        if (connectGuard !== null) { window.clearTimeout(connectGuard); connectGuard = null; }
        if (!alive) return;
        publish(null, true); // stale snapshots cannot enter live scoring
        startPoll();
        retry = window.setTimeout(openWs, 3000);
      };
      ws.onerror = () => socket.close();
    };

    startPoll(); // immediate REST while WS connects; no 7s blank first paint
    openWs();
    const ping = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastBookAt > 12_000) { publish(null, true); startPoll(); ws.close(); }
        else ws.send('ping');
      }
    }, 5000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(ping);
      stopPoll();
      if (retry !== null) window.clearTimeout(retry);
      if (connectGuard !== null) window.clearTimeout(connectGuard);
      if (publishTimer !== null) window.clearTimeout(publishTimer);
      ws?.close();
    };
  }, [symbol]);

  // Actual large-trade direction from recent taker trades. Never infer it from the book.
  useEffect(() => {
    const period = flowPeriodOf(timeframe);
    if (!symbol || !period) {
      setState(s => ({ ...s, bigBias: null, bigCount: 0 }));
      return;
    }
    const compute = () => {
      const snap = getFlow(symbol, period);
      const r = bigBiasOf(snap?.recent ?? []);
      setState(s => s.bigBias === r.bias && s.bigCount === r.count ? s : { ...s, bigBias: r.bias, bigCount: r.count });
    };
    compute();
    const timer = window.setInterval(compute, 2000);
    return () => window.clearInterval(timer);
  }, [symbol, timeframe]);

  return state;
}
