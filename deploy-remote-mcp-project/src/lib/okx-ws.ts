import { Candle, BookLevel, barMs } from "./types";
import { quoteVolumeFromRow } from "./okxVolume";

export type FeedStatus = "connecting" | "live" | "poll" | "sim";

export interface TradeMsg {
  ts: number;
  px: number;
  sz: number;
  side: "buy" | "sell";
  notional: number;
}

export interface FeedCallbacks {
  onStatus: (s: FeedStatus) => void;
  onCandle: (c: Candle, closed: boolean) => void;
  onTrades: (t: TradeMsg[]) => void;
  onBook: (bids: BookLevel[], asks: BookLevel[]) => void;
}

// OKX v5：K 线频道只在 /business 端点；成交 / 盘口在 /public（8443 端口即将停用，统一用 443）
const WS_BUSINESS = "wss://ws.okx.com/ws/v5/business";
const WS_PUBLIC = "wss://ws.okx.com/ws/v5/public";

const SIM_VOL: Record<string, number> = { "BTC-USDT-SWAP": 0.0011, "ETH-USDT-SWAP": 0.0016, "SOL-USDT-SWAP": 0.0022 };

class Socket {
  ws: WebSocket | null = null;
  gotData = false;
  private ping: ReturnType<typeof setInterval> | null = null;
  private guard: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private dead = false;

  constructor(
    private url: string,
    private args: { channel: string; instId: string }[],
    private onData: (msg: { arg: { channel: string }; data: unknown }) => void,
    private onState: () => void,
  ) {}

  open() {
    if (this.dead) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.guard = setTimeout(() => {
      if (!this.gotData) ws.close();
    }, 6000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: "subscribe", args: this.args }));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
    };
    ws.onmessage = (ev) => {
      if (this.dead || ev.data === "pong") return;
      let msg: { arg?: { channel: string }; data?: unknown; event?: string };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (!msg.arg || msg.data == null) return;
      if (!this.gotData) {
        this.gotData = true;
        this.attempts = 0;
        this.onState();
      }
      this.onData(msg as { arg: { channel: string }; data: unknown });
    };
    ws.onclose = () => {
      this.clear();
      if (this.dead) return;
      const had = this.gotData;
      this.gotData = false;
      if (had) this.onState();
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.dead) return;
    this.attempts++;
    // 指数退避，最多 30s；轮询兜底会在断线期间接管
    this.retry = setTimeout(() => this.open(), Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5)));
  }

  private clear() {
    if (this.ping) clearInterval(this.ping);
    if (this.guard) clearTimeout(this.guard);
    this.ping = null;
    this.guard = null;
  }

  close() {
    this.dead = true;
    this.clear();
    if (this.retry) clearTimeout(this.retry);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
  }
}

export class OKXFeed {
  private closed = false;
  private candleWs: Socket | null = null;
  private tapeWs: Socket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollBusy = false;
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus: FeedStatus | null = null;
  /** 服务端代理的轻量行情接口；WS 未就绪/断线时每 2s 轮询真实行情 */
  public pollUrl: string | null = null;
  /** USDT 永续合约面值（每张对应的币数），用于把张数换算成名义价值 */
  public ctVal = 1;

  // sim
  private simPrice = 0;
  private simMomentum = 0;
  private simCandle: Candle | null = null;

  constructor(
    private symbol: string,
    private bar: string,
    private cb: FeedCallbacks,
  ) {}

  /** 永续合约每张合约对应的币数量（BTC 0.01 / ETH 0.1 / SOL 1） */

  private setStatus(s: FeedStatus) {
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    this.cb.onStatus(s);
  }

  private refreshStatus = () => {
    if (this.closed) return;
    const candleLive = !!this.candleWs?.gotData;
    if (candleLive) {
      this.stopPoll();
      this.setStatus("live");
    } else if (this.pollUrl) {
      this.startPoll();
      this.setStatus("poll");
    } else if (!this.simTimer) {
      this.setStatus("connecting");
    }
  };

  start(seed: { lastPrice: number; book: { bids: BookLevel[]; asks: BookLevel[] } }) {
    this.closed = false;
    this.simPrice = seed.lastPrice;
    const bm = barMs(this.bar);
    this.simCandle = { ts: Math.floor(Date.now() / bm) * bm, o: seed.lastPrice, h: seed.lastPrice, l: seed.lastPrice, c: seed.lastPrice, v: 0 };
    this.setStatus("connecting");

    // 1) 先用 REST 轮询兜底（真实数据，第一秒就开始实时刷新），WS 收到 K 线后自动停止
    if (this.pollUrl) {
      this.startPoll();
      this.setStatus("poll");
    }

    // 2) K 线：/business
    this.candleWs = new Socket(
      WS_BUSINESS,
      [{ channel: "candle" + this.bar, instId: this.symbol }],
      (msg) => {
        const data = msg.data as (string | number)[][];
        if (!Array.isArray(data)) return;
        for (const r of data) {
          const close = Number(r[4]);
          const c: Candle = { ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: close, v: quoteVolumeFromRow(r, this.symbol) };
          if (![c.ts, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
          this.cb.onCandle(c, String(r[8]) === "1");
        }
      },
      this.refreshStatus,
    );
    this.candleWs.open();

    // 3) 成交带 + 盘口：/public
    this.tapeWs = new Socket(
      WS_PUBLIC,
      [
        { channel: "trades", instId: this.symbol },
        { channel: "books5", instId: this.symbol },
      ],
      (msg) => {
        const ch = msg.arg.channel;
        if (ch === "trades" && Array.isArray(msg.data)) {
          const trades: TradeMsg[] = (msg.data as { ts: string; px: string; sz: string; side: string }[])
            .map((t) => ({
              ts: Number(t.ts),
              px: Number(t.px),
              sz: Number(t.sz),
              side: (t.side === "buy" ? "buy" : "sell") as "buy" | "sell",
              notional: Number(t.px) * Number(t.sz) * this.ctVal,
            }))
            .filter((t) => Number.isFinite(t.px) && Number.isFinite(t.sz));
          if (trades.length) this.cb.onTrades(trades);
        } else if (ch === "books5" && Array.isArray(msg.data) && msg.data[0]) {
          const d = msg.data[0] as { bids: (string | number)[][]; asks: (string | number)[][] };
          const lv = (a: (string | number)[]) => ({ p: Number(a[0]), s: Number(a[1]) });
          this.cb.onBook((d.bids ?? []).map(lv), (d.asks ?? []).map(lv));
        }
      },
      () => undefined,
    );
    this.tapeWs.open();

    // 4) 服务端也不可达（无 pollUrl）且 WS 迟迟没有数据 → 仿真降级
    if (!this.pollUrl) {
      this.failTimer = setTimeout(() => {
        if (!this.candleWs?.gotData && !this.closed) this.startSim();
      }, 9000);
    }
  }

  private startPoll() {
    if (this.pollTimer || this.closed || !this.pollUrl) return;
    const url = this.pollUrl;
    const tick = async () => {
      if (this.pollBusy || this.closed) return;
      this.pollBusy = true;
      try {
        const r = await fetch(url, { cache: "no-store" });
        const d = (await r.json()) as { candles: Candle[]; book: { bids: BookLevel[]; asks: BookLevel[] } | null };
        if (this.closed || !this.pollTimer) return;
        const cs = (d.candles ?? []).slice().sort((a, b) => a.ts - b.ts);
        cs.forEach((c, i) => this.cb.onCandle(c, i < cs.length - 1));
        if (d.book && d.book.bids?.length && !this.tapeWs?.gotData) this.cb.onBook(d.book.bids, d.book.asks);
      } catch {
        // 下一轮重试
      } finally {
        this.pollBusy = false;
      }
    };
    this.pollTimer = setInterval(tick, 2000);
    void tick();
  }

  private stopPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startSim() {
    if (this.simTimer || this.closed) return;
    this.setStatus("sim");
    const vol = SIM_VOL[this.symbol] ?? 0.0015;
    const bm = barMs(this.bar);
    this.simTimer = setInterval(() => {
      if (this.closed || !this.simCandle) return;
      if (this.candleWs?.gotData) {
        // 真实行情恢复：停止仿真
        if (this.simTimer) clearInterval(this.simTimer);
        this.simTimer = null;
        this.refreshStatus();
        return;
      }
      const now = Date.now();
      const tickVol = vol * Math.sqrt(0.7 / 300);
      this.simMomentum = this.simMomentum * 0.94 + (Math.random() - 0.5) * tickVol * 0.7;
      const move = this.simMomentum * 0.55 + (Math.random() - 0.5) * tickVol;
      this.simPrice *= 1 + move;
      const cur = Math.floor(now / bm) * bm;
      if (cur > this.simCandle.ts) {
        this.cb.onCandle({ ...this.simCandle }, true);
        this.simCandle = { ts: cur, o: this.simPrice, h: this.simPrice, l: this.simPrice, c: this.simPrice, v: 0 };
      }
      const c = this.simCandle;
      c.c = this.simPrice;
      c.h = Math.max(c.h, this.simPrice);
      c.l = Math.min(c.l, this.simPrice);
      const unit = this.symbol.startsWith("BTC") ? 0.02 : this.symbol.startsWith("ETH") ? 0.6 : 6;
      const trades: TradeMsg[] = Array.from({ length: 1 + Math.floor(Math.random() * 2.4) }, () => {
        let sz = (Math.exp(Math.random() * 2.1) * unit) / Math.max(1e-9, this.ctVal);
        if (Math.random() < 0.035) sz *= 14 + Math.random() * 20;
        return { ts: now, px: this.simPrice, sz, side: Math.random() < 0.5 + Math.tanh(move / tickVol) * 0.3 ? "buy" : "sell", notional: this.simPrice * sz * this.ctVal };
      });
      c.v += trades.reduce((s, t) => s + t.notional, 0);
      this.cb.onCandle({ ...c }, false);
      this.cb.onTrades(trades);
      const step = this.simPrice * 0.00018;
      const drift = Math.tanh(this.simMomentum / tickVol) * 0.5;
      const bids: BookLevel[] = [];
      const asks: BookLevel[] = [];
      for (let i = 1; i <= 5; i++) {
        bids.push({ p: this.simPrice - step * i, s: (0.7 + Math.random() * 1.6) * (1 + Math.max(0, drift)) });
        asks.push({ p: this.simPrice + step * i, s: (0.7 + Math.random() * 1.6) * (1 + Math.max(0, -drift)) });
      }
      this.cb.onBook(bids, asks);
    }, 650);
  }

  stop() {
    this.closed = true;
    this.candleWs?.close();
    this.tapeWs?.close();
    this.candleWs = null;
    this.tapeWs = null;
    this.stopPoll();
    if (this.simTimer) clearInterval(this.simTimer);
    if (this.failTimer) clearTimeout(this.failTimer);
    this.simTimer = null;
  }
}
