"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import VelaChart, { type VelaChartHandle } from "@/components/VelaChart";
import type { OverlayPayload, OverlayFocus } from "@/components/vela/plugins";
import CommandDeck from "@/components/CommandDeck";
import StatsDrawer from "@/components/StatsDrawer";
import Toasts, { ToastItem } from "@/components/Toasts";
import { OKXFeed, TradeMsg, FeedStatus } from "@/lib/okx-ws";
import {
  detectAt,
  approxDeltaSeries,
  computeLevels,
  PATTERN_META,
  FEE_RATE,
  SLIP_RATE,
  MAX_HOLD_5M,
  MAX_HOLD_15M,
} from "@/lib/engine";
import {
  ctValOf,
  MarketData,
  BacktestResult,
  LiveSignal,
  Candle,
  BarId,
  barMs,
  BigOrder,
  FeedItem,
} from "@/lib/types";
import { fmtPrice, fmtR, fmtTime, fmtDateTime, priceDecimals, cn } from "@/lib/format";

const CHART_CAP = 600;

function bookImbalance(bids: { p: number; s: number }[], asks: { p: number; s: number }[]) {
  const sb = bids.reduce((s, l) => s + l.s, 0);
  const sa = asks.reduce((s, l) => s + l.s, 0);
  if (sb + sa <= 0) return 0;
  return (sb - sa) / (sb + sa);
}

interface FocusSpec {
  ts: number;
  side: "long" | "short";
  entry: number;
  stop: number;
  tp: number;
  label: string;
  pattern?: string;
  geo?: FeedItem["geo"];
  entryTs?: number;
  exitTs?: number;
  exitPrice?: number;
  r?: number;
  exitReason?: string;
}

export default function Page() {
  const [symbol, setSymbol] = useState("BTC-USDT-SWAP");
  const [bar, setBar] = useState<BarId>("5m");
  const [data, setData] = useState<MarketData | null>(null);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btLoading, setBtLoading] = useState(true);
  const [liveSignals, setLiveSignals] = useState<LiveSignal[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [wsStatus, setWsStatus] = useState<FeedStatus>("connecting");
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [cvd, setCvd] = useState<{ ts: number; v: number }[]>([]);
  const [bucket, setBucket] = useState({ buy: 0, sell: 0 });
  const [bookImb, setBookImb] = useState<number | null>(null);
  const [bigOrders, setBigOrders] = useState<BigOrder[]>([]);
  const [switching, setSwitching] = useState(false);
  const [flowFilter, setFlowFilter] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [show, setShow] = useState({ signals: true, zones: true, lines: true });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusSpec, setFocusSpec] = useState<FocusSpec | null>(null);
  const [focusTags, setFocusTags] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scope, setScope] = useState<"single" | "all">("single");
  const [btAll, setBtAll] = useState<BacktestResult | null>(null);
  const [btAllLoading, setBtAllLoading] = useState(false);

  // ── refs ──
  const bucketRef = useRef({ buy: 0, sell: 0 });
  const chartRef = useRef<VelaChartHandle>(null);
  // 高频行情先写 ref，500ms 合并刷新一次界面（避免每笔成交整页重渲染）
  const uiRef = useRef({ price: null as number | null, bookImb: null as number | null, big: [] as BigOrder[], bigDirty: false, bucketDirty: false });
  const dataRef = useRef<MarketData | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const feedRef = useRef<OKXFeed | null>(null);
  const tradeBufRef = useRef<TradeMsg[]>([]);
  const cvdAbsRef = useRef(0);
  const lastClosedRef = useRef(0);
  const dedupeRef = useRef<Set<string>>(new Set());
  const btAtRef = useRef(0);
  const cacheRef = useRef<Map<string, { data: MarketData | null; bt: BacktestResult | null; live: LiveSignal[] }>>(new Map());
  const liveSignalsRef = useRef<LiveSignal[]>([]);
  const symbolBarRef = useRef(`${symbol}|${bar}`);
  symbolBarRef.current = `${symbol}|${bar}`;

  const persistSignal = useCallback((sig: LiveSignal) => {
    const [sym, br] = symbolBarRef.current.split("|");
    fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sig.id,
        symbol: sym,
        bar: br,
        barTs: sig.ts,
        side: sig.side,
        pattern: sig.pattern,
        entry: sig.entry,
        stop: sig.stop,
        tp: sig.tp,
        confidence: sig.conf,
        confluence: sig.confl,
        status: sig.status,
        entryPrice: sig.entryPrice ?? null,
        exitPrice: sig.exitPrice ?? null,
        exitTs: sig.filledTs ?? null,
        rMultiple: sig.r ?? null,
        pnlPct: sig.pnlPct ?? null,
        holdingBars: sig.hold ?? null,
        exitReason: sig.exitReason ?? null,
      }),
    }).catch(() => undefined);
  }, []);

  // ── 回测加载 ──
  const loadBt = useCallback((silent: boolean, fresh: boolean) => {
    const [sym, br] = symbolBarRef.current.split("|");
    if (!silent) setBtLoading(true);
    setRerunning(fresh);
    const flow = new URLSearchParams({ symbol: sym, bar: br });
    const flowFilterNow = (window as any).__flowFilter ?? false;
    flow.set("flow", flowFilterNow ? "on" : "off");
    if (fresh) flow.set("fresh", "1");
    fetch(`/api/backtest?${flow}`)
      .then((r) => r.json())
      .then((res: BacktestResult) => {
        setBt(res);
        btAtRef.current = Date.now();
        const key = symbolBarRef.current;
        const e = cacheRef.current.get(key);
        if (e) {
          e.bt = res;
          cacheRef.current.set(key, e);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setBtLoading(false);
        setRerunning(false);
      });
  }, []);

  useEffect(() => {
    (window as any).__flowFilter = flowFilter;
  }, [flowFilter]);

  const loadBtAll = useCallback((fresh: boolean) => {
    const [, br] = symbolBarRef.current.split("|");
    setBtAllLoading(true);
    const q = new URLSearchParams({ symbol: "ALL", bar: br, flow: (window as any).__flowFilter === true ? "on" : "off" });
    if (fresh) q.set("fresh", "1");
    fetch(`/api/backtest?${q}`)
      .then((r) => r.json())
      .then((res: BacktestResult) => setBtAll(res))
      .catch(() => undefined)
      .finally(() => setBtAllLoading(false));
  }, []);

  useEffect(() => {
    if (scope === "all") loadBtAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, bar, flowFilter]);

  // ── 数据加载 ──
  useEffect(() => {
    const key = `${symbol}|${bar}`;
    feedRef.current?.stop();
    feedStartedRef.current = "";
    setSwitching(true);
    setFocusId(null);
    setFocusSpec(null);
    setCvd([]);
    setBigOrders([]);
    setBucket({ buy: 0, sell: 0 });
    bucketRef.current = { buy: 0, sell: 0 };
    setBookImb(null);
    cvdAbsRef.current = 0;
    tradeBufRef.current = [];
    dedupeRef.current = new Set();
    lastClosedRef.current = 0;

    const cached = cacheRef.current.get(key);
    if (cached?.data) {
      setData(cached.data);
      setLiveSignals(cached.live ?? []);
      liveSignalsRef.current = cached.live ?? [];
      candlesRef.current = cached.data.candles;
      setBt(cached.bt ?? null);
      setBtLoading(!cached.bt);
    } else {
      setData(null);
      setLiveSignals([]);
      liveSignalsRef.current = [];
      candlesRef.current = [];
      setBt(null);
      setBtLoading(true);
    }

    loadBt(true, false);
    let cancelled = false;
    fetch(`/api/data?symbol=${symbol}&bar=${bar}`)
      .then((r) => r.json())
      .then((d: MarketData) => {
        if (cancelled || symbolBarRef.current !== key) return;
        setData(d);
        dataRef.current = d;
        candlesRef.current = d.candles;
        setLastPrice(d.ticker.last);
        setBookImb(bookImbalance(d.book.bids, d.book.asks));
        uiRef.current.price = d.ticker.last;
        uiRef.current.bookImb = bookImbalance(d.book.bids, d.book.asks);
        uiRef.current.big = [];
        lastClosedRef.current = d.candles[d.candles.length - 1]?.ts ?? 0;

        // CVD 历史预热
        {
          const dSeries = approxDeltaSeries(d.candles);
          let acc = 0;
          const pts: { ts: number; v: number }[] = [];
          const from = Math.max(0, d.candles.length - 200);
          for (let j = from; j < d.candles.length; j++) {
            acc += dSeries[j];
            pts.push({ ts: d.candles[j].ts, v: acc });
          }
          cvdAbsRef.current = acc;
          setCvd(pts);
        }

        const e = cacheRef.current.get(key) ?? { data: null, bt: null, live: [] };
        e.data = d;
        e.live = liveSignalsRef.current;
        cacheRef.current.set(key, e);
        startFeedIfNeeded(d);
      })
      .catch(() => undefined)
      .finally(() => setSwitching(false));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, bar]);

  useEffect(() => {
    if (dataRef.current || cacheRef.current.has(`${symbol}|${bar}`)) loadBt(false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowFilter]);

  // ── 结算逻辑 ──
  const resolveSignals = useCallback((cs: Candle[], checkForming: Candle | null) => {
    const maxHold = bar === "15m" ? MAX_HOLD_15M : MAX_HOLD_5M;
    let changed = false;
    const next = liveSignalsRef.current.map((sig) => {
      if (sig.status === "won" || sig.status === "lost" || sig.status === "time") return sig;
      const idx = cs.findIndex((c) => c.ts === sig.ts);
      if (idx < 0) return sig;
      if (sig.status === "pending" && idx + 1 < cs.length) {
        const entry = sig.side === "long" ? cs[idx + 1].o * (1 + SLIP_RATE) : cs[idx + 1].o * (1 - SLIP_RATE);
        changed = true;
        return { ...sig, status: "active" as const, entryPrice: entry, filledTs: cs[idx + 1].ts, hold: 0 };
      }
      if (sig.status === "active" && sig.entryPrice != null) {
        const entry = sig.entryPrice;
        const probe = checkForming ?? cs[cs.length - 1];
        const probeIdx = checkForming ? cs.findIndex((c) => c.ts === checkForming.ts) : cs.length - 1;
        let exitPrice: number | null = null;
        let exitReason: "tp" | "sl" | "time" = "time";
        if (sig.side === "long" && probe.l <= sig.stop) {
          exitPrice = sig.stop;
          exitReason = "sl";
        } else if (sig.side === "short" && probe.h >= sig.stop) {
          exitPrice = sig.stop;
          exitReason = "sl";
        } else if (sig.side === "long" && probe.h >= sig.tp) {
          exitPrice = sig.tp;
          exitReason = "tp";
        } else if (sig.side === "short" && probe.l <= sig.tp) {
          exitPrice = sig.tp;
          exitReason = "tp";
        } else if (probeIdx - (idx + 1) >= maxHold) {
          exitPrice = probe.c;
          exitReason = "time";
        }
        if (exitPrice != null) {
          const exitAdj = sig.side === "long" ? exitPrice * (1 - SLIP_RATE) : exitPrice * (1 + SLIP_RATE);
          const gross = sig.side === "long" ? exitAdj - entry : entry - exitAdj;
          const pnl = gross - (entry + exitAdj) * FEE_RATE;
          const risk = sig.side === "long" ? entry - sig.stop : sig.stop - entry;
          const r = risk > 0 ? pnl / risk : 0;
          changed = true;
          const updated: LiveSignal = {
            ...sig,
            status: exitReason === "time" ? "time" : r > 0 ? "won" : "lost",
            exitPrice: exitAdj,
            r,
            pnlPct: (pnl / entry) * 100,
            hold: Math.max(1, probeIdx - (idx + 1)),
            exitReason,
            exitTs: probe.ts,
          };
          persistSignal(updated);
          return updated;
        }
      }
      return sig;
    });
    if (changed) {
      liveSignalsRef.current = next;
      setLiveSignals(next);
    }
  }, [bar, persistSignal]);

  // ── 新 K 线收盘：检测 + CVD ──
  const onClosedCandle = useCallback((c: Candle) => {
    const key = symbolBarRef.current;
    if (c.ts <= lastClosedRef.current) return;
    lastClosedRef.current = c.ts;

    const b = bucketRef.current;
    cvdAbsRef.current += b.buy - b.sell;
    const v = cvdAbsRef.current;
    setCvd((prev) => [...prev.slice(-300), { ts: c.ts + barMs(bar), v }]);
    bucketRef.current = { buy: 0, sell: 0 };
    uiRef.current.bucketDirty = true;

    const full = candlesRef.current;
    const ci = full.findIndex((x) => x.ts === c.ts);
    if (ci < 0) return;
    const cs = ci === full.length - 1 ? full : full.slice(0, ci + 1);
    const i = cs.length - 1;
    if (i < 55) return;
    const [sym, br] = key.split("|");

    const av = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    const tb = tradeBufRef.current.slice(-60);
    const totN = tb.reduce((s, t) => s + t.notional, 0);
    const of = {
      delta: approxDeltaSeries(cs),
      volRatio: av > 0 ? c.v / av : 1,
      bookImb: uiRef.current.bookImb ?? undefined,
      bigBias: totN > 0 ? ((tb.filter((t) => t.side === "buy").reduce((s, t) => s + t.notional, 0)) / totN - 0.5) * 2 : undefined,
    };

    const sigs = detectAt(cs, i, of);
    if (sigs.length > 0) {
      const fresh: LiveSignal[] = [];
      for (const s of sigs) {
        const id = `${sym}_${br}_${s.ts}_${s.pattern}_${s.side}`;
        if (dedupeRef.current.has(id)) continue;
        dedupeRef.current.add(id);
        const ls: LiveSignal =
          s.fill === "limit"
            ? { ...s, id, status: "active", entryPrice: s.entry, filledTs: s.ts, hold: 0 }
            : { ...s, id, status: "pending" };
        fresh.push(ls);
        setToasts((prev) => [...prev.slice(-2), { id, signal: s, symbol: sym }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 9000);
      }
      if (fresh.length > 0) {
        liveSignalsRef.current = [...fresh, ...liveSignalsRef.current].slice(0, 60);
        setLiveSignals(liveSignalsRef.current);
        fresh.forEach(persistSignal);
      }
    }

    resolveSignals(cs, null);
    if (Date.now() - btAtRef.current > 60_000) loadBt(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar, resolveSignals, loadBt]);

  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const onCandle = useCallback(
    (c: Candle, closed: boolean) => {
      let cs = candlesRef.current;
      if (cs.length === 0) return;
      const last = cs[cs.length - 1];
      let rolled = false;
      if (c.ts === last.ts) {
        cs[cs.length - 1] = c;
      } else if (c.ts > last.ts) {
        cs = [...cs, c];
        if (cs.length > CHART_CAP) cs = cs.slice(-CHART_CAP);
        candlesRef.current = cs;
        rolled = true;
      } else {
        const k = cs.findIndex((x) => x.ts === c.ts);
        if (k < 0) return;
        cs[k] = c;
      }
      if (c.ts >= last.ts) chartRef.current?.pushBar(c);
      uiRef.current.price = c.c;

      if (rolled) {
        // 新 K 线已开：上一根若未收到收盘确认，视为已收盘（避免漏检信号）
        if (last.ts > lastClosedRef.current) onClosedCandle(last);
        setData((prev) => (prev ? { ...prev, candles: candlesRef.current } : prev));
      }
      if (closed) {
        onClosedCandle(c);
        setData((prev) => (prev ? { ...prev, candles: candlesRef.current } : prev));
      } else {
        resolveSignals(candlesRef.current, c);
      }
    },
    [onClosedCandle, resolveSignals],
  );

  const onTrades = useCallback((ts: TradeMsg[]) => {
    const buf = tradeBufRef.current;
    buf.push(...ts);
    if (buf.length > 400) buf.splice(0, buf.length - 400);
    // 按报价币种（USDT）累计主动成交额，与合约张数无关
    let buy = 0;
    let sell = 0;
    for (const t of ts) t.side === "buy" ? (buy += t.notional) : (sell += t.notional);
    bucketRef.current = { buy: bucketRef.current.buy + buy, sell: bucketRef.current.sell + sell };
    uiRef.current.bucketDirty = true;
    uiRef.current.price = ts[ts.length - 1]?.px ?? uiRef.current.price;
    const med = median(buf.slice(-150).map((t) => t.notional)) || 1;
    const fresh = ts.filter((t) => t.notional > med * 8);
    if (fresh.length > 0) {
      uiRef.current.big = [...fresh, ...uiRef.current.big].slice(0, 5);
      uiRef.current.bigDirty = true;
    }
  }, []);

  const onBook = useCallback((bids: { p: number; s: number }[], asks: { p: number; s: number }[]) => {
    uiRef.current.bookImb = bookImbalance(bids, asks);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const u = uiRef.current;
      if (u.price != null) setLastPrice((p) => (p === u.price ? p : u.price));
      setBookImb((p) => (p === u.bookImb ? p : u.bookImb));
      if (u.bucketDirty) {
        u.bucketDirty = false;
        setBucket({ ...bucketRef.current });
      }
      if (u.bigDirty) {
        u.bigDirty = false;
        setBigOrders(u.big);
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  const feedStartedRef = useRef<string>("");
  const startFeedIfNeeded = useCallback(
    (d: MarketData) => {
      const key = `${d.symbol}|${d.bar}`;
      if (feedStartedRef.current === key) return;
      feedStartedRef.current = key;
      feedRef.current?.stop();
      const feed = new OKXFeed(d.symbol, d.bar, {
        onStatus: setWsStatus,
        onCandle,
        onTrades,
        onBook,
      });
      feed.pollUrl = d.live ? `/api/data?tail=1&symbol=${encodeURIComponent(d.symbol)}&bar=${d.bar}` : null;
      feed.ctVal = d.ticker.ctVal ?? ctValOf(d.symbol);
      feedRef.current = feed;
      feed.start({ lastPrice: d.ticker.last, book: d.book });
    },
    [onCandle, onTrades, onBook],
  );

  useEffect(() => () => feedRef.current?.stop(), []);

  // ── 派生数据 ──
  const candles = data?.candles ?? [];
  const lastBarTs = candles[candles.length - 1]?.ts ?? 0;
  const chartStartTs = candles[0]?.ts ?? 0;

  const fvgSrcRef = useRef<Candle[]>([]);
  const fvgKeyRef = useRef("");
  const fvgKey = `${symbolBarRef.current}|${lastBarTs}`;
  if (fvgKeyRef.current !== fvgKey) {
    fvgKeyRef.current = fvgKey;
    fvgSrcRef.current = candles;
  }
  const levels = useMemo(
    () => (fvgSrcRef.current.length > 30 ? computeLevels(fvgSrcRef.current) : []),
    [lastBarTs, symbol, bar],
  );

  // 图表常驻：切换期间继续显示上一个市场，新数据到达后由 Vela setMarket 原地切换
  const shownRef = useRef<MarketData | null>(null);
  if (data) shownRef.current = data;
  const shown = shownRef.current;
  const shownKey = shown ? `${shown.symbol}|${shown.bar}` : "";
  const shownSame = shown ? shown.symbol === symbol && shown.bar === bar : false;

  const payload = useMemo<OverlayPayload>(() => {
    const map = new Map<string, OverlayPayload["markers"][number]>();
    const from = candles[0]?.ts ?? 0;
    const label = (pid: string) => PATTERN_META[pid as keyof typeof PATTERN_META]?.short ?? pid;
    if (shownSame) {
      for (const s of bt?.signals ?? []) {
        if (s.ts < from || s.status !== "done") continue;
        map.set(`${s.ts}_${s.side}`, { ts: s.ts, side: s.side, label: label(s.pattern), r: s.r });
      }
      for (const s of liveSignals) map.set(`${s.ts}_${s.side}`, { ts: s.ts, side: s.side, label: label(s.pattern), r: s.r, live: true });
    }
    const focus: OverlayFocus | null =
      focusSpec && shownSame
        ? {
            ts: focusSpec.ts,
            side: focusSpec.side,
            entry: focusSpec.entry,
            stop: focusSpec.stop,
            tp: focusSpec.tp,
            entryTs: focusSpec.entryTs,
            exitTs: focusSpec.exitTs,
            exitPrice: focusSpec.exitPrice,
            r: focusSpec.r,
            geo: focusSpec.geo,
            title: focusSpec.label,
          }
        : null;
    return {
      markers: [...map.values()].slice(-260),
      levels: shownSame ? levels : [],
      focus,
      show,
      decimals: priceDecimals(shown?.symbol ?? symbol),
      barMs: barMs(bar),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bt, liveSignals, lastBarTs, levels, focusSpec, show, shownSame, symbol, bar]);

  // 点击图上 K 线：若该 K 线有信号，聚焦它
  const onBarClick = useCallback(
    (ts: number) => {
      const hit = [...feedLiveRef.current, ...feedHistoryRef.current].find((s) => s.ts === ts);
      if (hit) handleFocusRef.current?.(hit);
    },
    [],
  );
  const feedLiveRef = useRef<FeedItem[]>([]);
  const feedHistoryRef = useRef<FeedItem[]>([]);
  const handleFocusRef = useRef<((i: FeedItem) => void) | null>(null);

  const feedLive: FeedItem[] = useMemo(
    () =>
      liveSignals.map((s) => ({
        id: s.id,
        ts: s.ts,
        side: s.side,
        pattern: s.pattern,
        entry: s.entry,
        stop: s.stop,
        tp: s.tp,
        conf: s.conf,
        confl: s.confl,
        note: s.note,
        status: s.status,
        r: s.r,
        pnlPct: s.pnlPct,
        hold: s.hold,
        exitReason: s.exitReason,
        live: true,
        tags: s.tags,
        geo: s.geo,
        entryTs: s.filledTs,
        exitTs: s.exitTs,
        exitPrice: s.exitPrice,
      })),
    [liveSignals],
  );

  const feedHistory: FeedItem[] = useMemo(
    () =>
      (bt?.signals ?? [])
        .filter((s) => s.status === "done" && s.ts >= chartStartTs)
        .map((s) => ({
          id: s.id,
          ts: s.ts,
          side: s.side,
          pattern: s.pattern,
          entry: s.entry,
          stop: s.stop,
          tp: s.tp,
          conf: s.conf,
          confl: s.confl,
          note: s.note ?? PATTERN_META[s.pattern]?.label ?? s.pattern,
          status: "done",
          r: s.r,
          pnlPct: s.pnlPct,
          hold: s.holdingBars,
          exitReason: s.exitReason,
          tags: s.tags,
          geo: s.geo,
          entryTs: s.entryTs,
          exitTs: s.exitTs,
          exitPrice: s.exitPrice,
        }))
        .slice(-80)
        .reverse(),
    [bt, chartStartTs],
  );

  const handleFocus = useCallback((item: FeedItem) => {
    if (focusId === item.id) {
      setFocusId(null);
      setFocusSpec(null);
      return;
    }
    setFocusId(item.id);
    setFocusSpec({
      ts: item.ts,
      side: item.side,
      entry: item.entry,
      stop: item.stop,
      tp: item.tp,
      label: PATTERN_META[item.pattern as keyof typeof PATTERN_META]?.label ?? item.pattern,
      pattern: item.pattern,
      geo: item.geo,
      entryTs: item.entryTs,
      exitTs: item.exitTs,
      exitPrice: item.exitPrice,
      r: item.r,
      exitReason: item.exitReason,
    });
    setFocusTags(item.tags ?? []);
  }, [focusId]);

  feedLiveRef.current = feedLive;
  feedHistoryRef.current = feedHistory;
  handleFocusRef.current = handleFocus;

  const focusPat = focusSpec ? bt?.byPattern.find((p) => p.id === focusSpec.pattern) : null;
  const rr = focusSpec ? Math.abs((focusSpec.tp - focusSpec.entry) / (focusSpec.entry - focusSpec.stop || 1)) : 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0a0d13] text-[#e7ecf5]">
      {/* 顶部极简交易导航 */}
      <Header
        symbol={symbol}
        bar={bar}
        onSymbol={setSymbol}
        onBar={setBar}
        last={lastPrice}
        chg24={data?.ticker.chg24 ?? null}
        funding={data?.ticker.fundingRate ?? null}
        vol24={data?.ticker.vol24Quote ?? null}
        live={data?.live ?? null}
        status={wsStatus}
        switching={switching}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
        onRefresh={() => loadBt(false, true)}
      />

      {/* 主工作区：左侧超大图表 + 右侧多功能指令台 */}
      <div className="flex min-h-0 flex-1 overflow-hidden p-2 gap-2">
        {/* 左侧主图表 (占用 ~75% 宽度，给 K 线最充足的视觉空间) */}
        <div className="relative flex flex-1 flex-col overflow-hidden rounded-lg border border-[#1d2534] bg-[#0d1119]">
          {/* 图表内部悬浮工具条 */}
          <div className="absolute right-3 top-2.5 z-20 flex items-center gap-1 rounded-md bg-[#10151f]/85 p-1 backdrop-blur-md border border-[#1d2534]">
            {(
              [
                ["signals", "W/M入场"],
                ["zones", "顶底关键位"],
                ["lines", "价位线"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={cn(
                  "rounded px-2 py-0.5 text-[10px] font-semibold transition-all",
                  show[k] ? "bg-[#37c8dd]/20 text-[#37c8dd]" : "text-[#5b6579] hover:text-[#8c96ab]",
                )}
                onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))}
              >
                {label}
              </button>
            ))}
          </div>

          {/* K 线图画布 */}
          <div className="relative h-full w-full">
            {shown && shown.candles.length > 0 ? (
              <>
                <VelaChart
                  ref={chartRef}
                  dataKey={shownKey}
                  symbol={shown.symbol}
                  bar={shown.bar}
                  candles={shown.candles}
                  payload={payload}
                  onBarClick={onBarClick}
                />
                {!shownSame && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0d1119]/55 backdrop-blur-[1px]">
                    <span className="rounded-md border border-[#1d2534] bg-[#10151f] px-3 py-1.5 text-[11px] text-[#8c96ab]">
                      正在切换到 {symbol} · {bar}…
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <div className="skeleton h-[70%] w-[92%]" />
                <span className="text-[12px] text-[#5b6579]">
                  正在从 OKX 获取 {symbol} · {bar} K 线与订单流…
                </span>
              </div>
            )}

            {/* 实时新信号 Toast */}
            <Toasts items={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

            {/* 聚焦信号浮动卡片 (可一键清除价位线) */}
            {focusSpec && (
              <div className="fade-up absolute right-[86px] top-[46px] z-40 w-[292px] rounded-lg border border-[#37c8dd]/40 bg-[rgba(13,17,25,0.95)] p-3 shadow-2xl backdrop-blur-md">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-px text-[10px] font-bold",
                      focusSpec.side === "long" ? "bg-[#2ebd85]/20 text-[#2ebd85]" : "bg-[#f6465d]/20 text-[#f6465d]",
                    )}
                  >
                    {focusSpec.side === "long" ? "做多 BUY" : "做空 SELL"}
                  </span>
                  <span className="text-[12px] font-bold text-[#e7ecf5]">{focusSpec.label}</span>
                  <span className="mono ml-auto text-[10px] text-[#37c8dd]">1:{rr.toFixed(1)}</span>
                </div>
                <div className="mono mt-2 grid grid-cols-3 gap-1 rounded bg-[#0a0d13] p-1.5 text-[10px]">
                  <div>
                    <span className="text-[#5b6579]">E: </span>
                    <span className="text-[#f0b90b]">{fmtPrice(focusSpec.entry, symbol)}</span>
                  </div>
                  <div>
                    <span className="text-[#5b6579]">SL: </span>
                    <span className="text-[#f6465d]">{fmtPrice(focusSpec.stop, symbol)}</span>
                  </div>
                  <div>
                    <span className="text-[#5b6579]">TP: </span>
                    <span className="text-[#2ebd85]">{fmtPrice(focusSpec.tp, symbol)}</span>
                  </div>
                </div>
                <div className="mono mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                  <span className="rounded bg-[#37c8dd]/20 px-1 text-[#37c8dd]">◆ 信号K {fmtDateTime(focusSpec.ts)}</span>
                  {focusSpec.entryTs && <span className="text-[#f0b90b]">入场 {fmtTime(focusSpec.entryTs)}</span>}
                  {focusSpec.exitTs && (
                    <span className={(focusSpec.r ?? 0) > 0 ? "text-[#2ebd85]" : "text-[#f6465d]"}>
                      出场 {fmtTime(focusSpec.exitTs)} · {focusSpec.exitReason === "tp" ? "止盈" : focusSpec.exitReason === "sl" ? "止损" : "超时"} {fmtR(focusSpec.r)}
                    </span>
                  )}
                </div>
                {focusTags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {focusTags.map((t) => (
                      <span key={t} className="rounded bg-[#1a2334] px-1 py-px text-[9px] text-[#8c96ab]">{t}</span>
                    ))}
                  </div>
                )}
                {focusPat && (
                  <div className="mt-2 text-[10px] text-[#8c96ab]">
                    历史表现: {focusPat.n}笔 · 胜率 {focusPat.winRate.toFixed(0)}% · 期望 {fmtR(focusPat.avgR)}
                  </div>
                )}
                <button
                  className="btn-ghost mt-2 w-full !py-1 !text-[10px] text-[#37c8dd]"
                  onClick={() => {
                    setFocusId(null);
                    setFocusSpec(null);
                  }}
                >
                  清除价位线 · 返回实时
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 右侧多功能指令台 (信号流 / 订单流雷达 / 简报) */}
        <div className="w-[350px] shrink-0 xl:w-[380px]">
          <CommandDeck
            symbol={symbol}
            liveSignals={feedLive}
            historySignals={feedHistory}
            focusedId={focusId}
            onFocus={handleFocus}
            cvd={cvd}
            bucket={bucket}
            bookImb={bookImb}
            bigOrders={bigOrders}
            hasTape={wsStatus !== "connecting"}
            bt={bt}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        </div>
      </div>

      {/* 底部可折叠回测抽屉 (默认折叠为 36px 状态条，完全不抢占图表空间) */}
      <StatsDrawer
        bt={scope === "all" ? btAll : bt}
        loading={scope === "all" ? btAllLoading && !btAll : btLoading}
        scope={scope}
        onScope={setScope}
        symbol={symbol}
        isOpen={drawerOpen}
        onToggle={() => setDrawerOpen((o) => !o)}
        onRerun={() => (scope === "all" ? loadBtAll(true) : loadBt(false, true))}
        rerunning={rerunning || (scope === "all" && btAllLoading)}
        flowFilter={flowFilter}
        onToggleFlow={() => setFlowFilter((f) => !f)}
      />
    </div>
  );
}
