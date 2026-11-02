import { useSyncExternalStore } from "react";
import {
  BacktestResult,
  Candle,
  KeyLevel,
  LiveSignal,
  RawSignal,
  symbolOf,
  barMs,
} from "./types";
import {
  applyTapeFlow,
  scanDoubles,
  simulate,
  summarize,
  validEntry,
  DEFAULT_PARAMS,
  type DoubleParams,
  type ScanSignal,
} from "./engine";
import { TapeFeed, type TapeMetrics } from "./okx";

/** 目标预设：颈线目标 / 固定 1.5R / 固定 1.0R */
export type TargetMode = "neck" | "r15" | "r10";

export function paramsFor(mode: TargetMode): DoubleParams {
  const p: DoubleParams = { ...DEFAULT_PARAMS };
  if (mode === "r15") {
    p.maxRR = 1.5;
    p.targetFrac = 12;
  } else if (mode === "r10") {
    p.maxRR = 1.0;
    p.targetFrac = 12;
  }
  return p;
}

export interface PulseState {
  version: number;
  symbol: string;
  tf: string;
  lastPrice: number | null;
  closedBars: number;
  signals: ScanSignal[];
  liveSignals: LiveSignal[];
  levels: KeyLevel[];
  backtest: BacktestResult | null;
  backtestRunning: boolean;
  threshold: number;
  targetMode: TargetMode;
  showSignals: boolean;
  tape: TapeMetrics | null;
}

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const MAX_HOLD = (tf: string) => (tf === "15" || tf === "30" ? 48 : 96);

class PulseStore {
  private state: PulseState = {
    version: 0,
    symbol: "BTCUSDT",
    tf: "5",
    lastPrice: null,
    closedBars: 0,
    signals: [],
    liveSignals: [],
    levels: [],
    backtest: null,
    backtestRunning: false,
    threshold: 60,
    targetMode: "neck",
    showSignals: true,
    tape: null,
  };

  private listeners = new Set<() => void>();
  private candles: Candle[] = [];
  private scanKey = "";
  private backtestTimer: ReturnType<typeof setTimeout> | null = null;
  private feed: TapeFeed | null = null;
  private noticed = new Set<string>();

  get = (): PulseState => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private bump() {
    this.state = { ...this.state, version: this.state.version + 1 };
    this.listeners.forEach((l) => l());
  }

  private patch(p: Partial<PulseState>) {
    this.state = { ...this.state, ...p };
    this.bump();
  }

  /** TapeFeed 指标并入状态，让面板只订阅一处 */
  attachTape(feed: TapeFeed) {
    this.feed = feed;
    feed.subscribe(() => this.patch({ tape: feed.metrics }));
    this.patch({ tape: feed.metrics });
  }

  setMarket(symbol: string, tf: string) {
    const base = symbolOf(symbol);
    this.scanKey = "";
    this.noticed.clear();
    this.candles = [];
    this.feed?.setSymbol(base.id, tf, base.ctVal);
    this.patch({
      symbol: base.ticker,
      tf,
      signals: [],
      liveSignals: [],
      levels: [],
      backtest: null,
      lastPrice: null,
      closedBars: 0,
      tape: this.feed?.metrics ?? null,
    });
  }

  setThreshold(v: number) {
    const threshold = Math.max(30, Math.min(92, Math.round(v)));
    this.patch({ threshold });
    this.queueBacktest();
  }

  setTargetMode(mode: TargetMode) {
    this.scanKey = "";
    this.patch({ targetMode: mode });
    this.rescan();
    this.queueBacktest();
  }

  setShowSignals(on: boolean) {
    this.patch({ showSignals: on });
  }

  previewBars(): readonly Candle[] {
    return this.candles.slice(-90);
  }

  /**
   * K 线数据入口：只在「已收盘 K 线数量 / 标的 / 周期 / 目标模式」变化时重算。
   * 实时 tick 不触发全量扫描，保证交互流畅。
   */
  updateBars(bars: readonly Bar[]) {
    const { symbol, tf, targetMode } = this.state;
    const cs: Candle[] = bars.map((b) => ({
      ts: b.time,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume ?? 0,
    }));
    if (!cs.length) return;
    this.candles = cs;
    const dur = barMs(tf);
    const closedCount = cs.reduce((n, c) => (c.ts + dur <= Date.now() ? n + 1 : n), 0);
    const lastClosedTs = closedCount ? cs[closedCount - 1].ts : 0;
    const key = `${symbol}|${tf}|${targetMode}|${closedCount}|${lastClosedTs}`;
    if (key === this.scanKey) {
      if (this.state.lastPrice !== cs[cs.length - 1].c) this.patch({ lastPrice: cs[cs.length - 1].c });
      return;
    }
    this.scanKey = key;
    this.rescan();
    this.queueBacktest();
  }

  /** 全量重算：形态扫描 + 关键位 + 实时信号结算（仅在新收盘 K 线时调用） */
  private rescan() {
    const { tf, targetMode, threshold } = this.state;
    const dur = barMs(tf);
    const closed = this.candles.filter((c) => c.ts + dur <= Date.now());
    if (closed.length < 60) return;
    const window = closed.slice(-1400);
    const params = paramsFor(targetMode);
    const { signals, levels } = scanDoubles(window, params);

    // 实时信号：只保留最近 40 根以内的形态，叠加真实逐笔方向
    const recent = signals.slice(-60);
    const live: LiveSignal[] = [];
    for (const s of recent.slice(-14)) {
      const id = `${this.state.symbol}|${this.state.tf}|${s.ts}|${s.pattern}`;
      const tape = this.feed?.sampleFor(s.ts) ?? undefined;
      const sig = applyTapeFlow(s, tape);
      const rec = this.settleOne(sig, window, params);
      live.push(rec);
      if (rec.status === "active" || rec.status === "pending") this.noticed.add(id);
    }

    const liveLevels = levels
      .filter((l) => !l.broken || l.tested)
      .slice(-16);

    void threshold;
    this.patch({
      signals: recent,
      liveSignals: live.reverse(),
      levels: liveLevels,
      closedBars: closed.length,
      lastPrice: this.candles[this.candles.length - 1]?.c ?? null,
    });
  }

  /** 单笔实时信号结算（只用已收盘 K 线，未走完的保持跟踪中） */
  private settleOne(
    sig: ScanSignal | RawSignal,
    cs: Candle[],
    params: DoubleParams,
  ): LiveSignal {
    const base: LiveSignal = { ...sig, id: `${sig.ts}_${sig.pattern}_${sig.side}`, status: "pending" };
    const i = cs.findIndex((c) => c.ts === sig.ts);
    if (i < 0) return base;
    const next = cs[i + 1];
    if (!next) return base;
    const entry = sig.side === "long" ? next.o * 1.0001 : next.o * 0.9999;
    if (!validEntry(sig, entry, params)) return { ...base, status: "skipped" };
    const maxHold = MAX_HOLD(this.state.tf);
    const endJ = Math.min(i + maxHold, cs.length - 1);
    let exitPrice: number | null = null;
    let exitReason: "tp" | "sl" | "time" = "time";
    let exitIdx = -1;
    for (let j = i + 1; j <= endJ; j++) {
      const k = cs[j];
      const hitSL = sig.side === "long" ? k.l <= sig.stop : k.h >= sig.stop;
      const hitTP = sig.side === "long" ? k.h >= sig.tp : k.l <= sig.tp;
      if (hitSL) {
        exitPrice = sig.stop;
        exitReason = "sl";
      } else if (hitTP) {
        exitPrice = sig.tp;
        exitReason = "tp";
      }
      if (exitPrice != null) {
        exitIdx = j;
        break;
      }
    }
    if (exitPrice == null) {
      if (endJ < i + maxHold) return { ...base, status: "active", entryPrice: entry, hold: endJ - i };
      exitPrice = cs[endJ].c;
      exitIdx = endJ;
    }
    const exitAdj = sig.side === "long" ? exitPrice * 0.9999 : exitPrice * 1.0001;
    const gross = sig.side === "long" ? exitAdj - entry : entry - exitAdj;
    const pnl = gross - (entry + exitAdj) * 0.0005;
    const risk = sig.side === "long" ? entry - sig.stop : sig.stop - entry;
    const r = risk > 0 ? pnl / risk : 0;
    return {
      ...base,
      status: exitReason === "time" ? "time" : r > 0 ? "won" : "lost",
      entryPrice: entry,
      exitPrice: exitAdj,
      r,
      hold: Math.max(1, exitIdx - i),
      exitReason,
      exitTs: cs[exitIdx].ts,
    };
  }

  /** 回测（异步排队，避免阻塞点击与下拉交互） */
  queueBacktest() {
    if (this.backtestTimer) clearTimeout(this.backtestTimer);
    this.backtestTimer = setTimeout(() => this.runBacktest(), 250);
  }

  runBacktest() {
    const { tf, symbol, targetMode, threshold, backtestRunning } = this.state;
    if (backtestRunning) return;
    const dur = barMs(tf);
    const cs = this.candles.filter((c) => c.ts + dur <= Date.now());
    if (cs.length < 220) return;
    this.patch({ backtestRunning: true });
    const params = paramsFor(targetMode);
    setTimeout(() => {
      const recs = simulate(cs, symbol, tf, { flowFilter: false, maxHold: MAX_HOLD(tf) }, params, threshold);
      const bt = summarize(recs, {
        symbol,
        bar: tf,
        from: cs[0].ts,
        to: cs[cs.length - 1].ts,
        bars: cs.length,
        flowFilter: false,
      });
      this.patch({ backtest: bt, backtestRunning: false });
    }, 16);
  }
}

export const store = new PulseStore();

export function useStore(): PulseState {
  return useSyncExternalStore(store.subscribe, store.get);
}
