"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Candle } from "@/lib/types";
import { barMs } from "@/lib/types";
import { fmtDateTime } from "@/lib/displayTime";
import { registerVelaPlugins, OVERLAY_ID, CVD_ID, type OverlayPayload } from "./vela/plugins";

/**
 * K 线主图：LuxAlgo Vela™（WebGL2 原生渲染器，Apache-2.0）。
 * 实时数据走 Vela 自身的 live 通路：自定义 MarketDataFeed.subscribe ← OKX WebSocket，
 * 形成中 K 线 / 成交量 / CVD 副图由 Vela 逐 tick 更新，完全不经过 React 重渲染。
 */

interface OHLCVBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const toBar = (c: Candle): OHLCVBar => ({ time: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v });

/**
 * 安全探测 WebGL2。部分浏览器 / 驱动黑名单下 getContext("webgl2") 会抛异常而不是返回 null，
 * 直接让 Vela 自己探测会导致图表构造失败 → 整块空白。这里先探测，再决定渲染后端。
 */
function probeWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return false;
    (gl as WebGL2RenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

class BridgeFeed {
  private subs = new Set<(b: OHLCVBar) => void>();
  async load(cfg: { data?: OHLCVBar[] }): Promise<OHLCVBar[]> {
    return cfg.data ?? [];
  }
  subscribe(_cfg: unknown, onBar: (b: OHLCVBar) => void) {
    this.subs.add(onBar);
    return () => {
      this.subs.delete(onBar);
    };
  }
  push(b: OHLCVBar) {
    this.subs.forEach((f) => f(b));
  }
}

export interface VelaChartHandle {
  pushBar: (c: Candle) => void;
}

interface Props {
  dataKey: string;
  symbol: string;
  bar: string;
  candles: Candle[];
  payload: OverlayPayload;
  onBarClick?: (ts: number) => void;
}

const THEME = {
  background: "#0d1119",
  textColor: "#8c96ab",
  gridColor: "rgba(29,37,52,0.55)",
  borderColor: "#1d2534",
  upColor: "#2ebd85",
  downColor: "#f6465d",
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
};

type VelaLike = {
  ready(): Promise<void>;
  destroy(): void;
  setMarket(m: { data?: OHLCVBar[]; timeframe?: string }): Promise<void>;
  setVisibleRange(r: { from: number; to: number }): unknown;
  resize(): void;
  addNativeIndicator(type: string): unknown;
  presentNativeIndicators(): string[];
  renderer: {
    onCrosshairMove(cb: (e: { time: number | null; ohlc: OHLCVBar | null }) => void): () => void;
    onClick(cb: (e: { time: number | null }) => void): () => void;
  };
  rendererPort?: { setNativeData?: (id: string, data: unknown) => void };
};

function fmtVol(v: number) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}
function fmt(v: number, d: number) {
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const hhmm = (ts: number) => fmtDateTime(ts); // 北京时间

const VelaChart = forwardRef<VelaChartHandle, Props>(function VelaChart(
  { dataKey, symbol, bar, candles, payload, onBarClick },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"ok" | "compat" | "error">("ok");
  const readoutRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<VelaLike | null>(null);
  const feedRef = useRef(new BridgeFeed());
  const readyRef = useRef(false);
  const switchingRef = useRef(false);
  const keyRef = useRef(dataKey);
  const payloadRef = useRef(payload);
  const candlesRef = useRef(candles);
  const lastBarRef = useRef<OHLCVBar | null>(candles.length ? toBar(candles[candles.length - 1]) : null);
  const prevCloseRef = useRef<number>(candles.length > 1 ? candles[candles.length - 2].c : 0);
  const hoverRef = useRef<OHLCVBar | null>(null);
  const rafRef = useRef(0);
  const clickRef = useRef(onBarClick);
  const decRef = useRef(payload.decimals);
  payloadRef.current = payload;
  candlesRef.current = candles;
  clickRef.current = onBarClick;
  decRef.current = payload.decimals;

  // 十字光标 / 最新价读数：直接写 DOM（rAF 合帧），不触发 React 渲染
  const scheduleReadout = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = readoutRef.current;
      const b = hoverRef.current ?? lastBarRef.current;
      if (!el || !b) return;
      const d = decRef.current;
      const ref = hoverRef.current ? b.open : prevCloseRef.current || b.open;
      const chg = ref ? ((b.close - ref) / ref) * 100 : 0;
      const up = b.close >= b.open;
      el.innerHTML =
        `<span style="color:#8c96ab">${hhmm(b.time)}</span>` +
        `<b style="color:#e7ecf5">${fmt(b.close, d)}</b>` +
        `<span style="color:${up ? "#2ebd85" : "#f6465d"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>` +
        `<span>O ${fmt(b.open, d)}</span><span>H ${fmt(b.high, d)}</span><span>L ${fmt(b.low, d)}</span><span>C ${fmt(b.close, d)}</span>` +
        `<span>V ${fmtVol(b.volume ?? 0)}</span>` +
        (payloadRef.current.focus && b.time === payloadRef.current.focus.ts
          ? `<span style="background:rgba(55,200,221,.2);color:#37c8dd;padding:0 4px;border-radius:3px">◆ 信号K</span>`
          : "");
    });
  };

  const pushOverlay = () => {
    const port = chartRef.current?.rendererPort;
    port?.setNativeData?.(OVERLAY_ID, payloadRef.current);
  };

  // 把请求的区间钳制到已加载 K 线范围内（否则会看到大片空白）
  const clampRange = (from: number, to: number) => {
    const cs = candlesRef.current;
    const bm = barMs(bar);
    if (cs.length === 0) return { from, to };
    const first = cs[0].ts;
    const lastTs = cs[cs.length - 1].ts;
    const minSpan = bm * 40;
    let f = Math.max(from, first - bm * 2);
    let t = Math.min(Math.max(to, f + minSpan), lastTs + bm * 12);
    if (f > lastTs - minSpan) f = Math.max(first - bm * 2, lastTs - minSpan);
    return { from: f, to: t };
  };

  const frameLatest = () => {
    const c = chartRef.current;
    const cs = candlesRef.current;
    if (!c || cs.length === 0) return;
    const bm = barMs(bar);
    const from = cs[Math.max(0, cs.length - 140)].ts;
    c.setVisibleRange(clampRange(from, cs[cs.length - 1].ts + bm * 10));
  };

  useImperativeHandle(ref, () => ({
    pushBar(c: Candle) {
      const b = toBar(c);
      const last = lastBarRef.current;
      if (last && b.time > last.time) prevCloseRef.current = last.close;
      lastBarRef.current = b;
      if (readyRef.current && !switchingRef.current) feedRef.current.push(b);
      if (!hoverRef.current) scheduleReadout();
    },
  }));

  // ── 创建图表（带看门狗 + 渲染后端降级重试）──
  useEffect(() => {
    let disposed = false;
    const unsubs: (() => void)[] = [];
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const alive = () => !disposed && !!hostRef.current;

    const canvasesOk = () => {
      const cs = hostRef.current?.querySelectorAll("canvas") ?? [];
      return cs.length > 0 && [...cs].every((c) => c.width > 0 && c.height > 0);
    };
    const create = async (backend: "auto" | "canvas2d", isRetry: boolean) => {
      if (!alive()) return;
      try {
        // 插件（信号图层 / CVD）注册失败不阻断图表本体
        await registerVelaPlugins().catch((e) => console.warn("[vela] 插件注册失败:", e));
        let mod: { Vela: new (c: HTMLElement, o?: unknown, d?: unknown) => VelaLike } | null = null;
        for (let attempt = 0; attempt < 2 && !mod; attempt++) {
          try {
            mod = (await import("@luxalgo/vela")) as unknown as { Vela: new (c: HTMLElement, o?: unknown, d?: unknown) => VelaLike };
          } catch (e) {
            if (attempt === 1) throw e;
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        if (!mod) return;
        const Vela = mod.Vela;
        if (!alive()) return;
        const chart = new Vela(
          hostRef.current!,
          {
            data: candlesRef.current.map(toBar),
            timeframe: bar,
            live: true,
            theme: THEME,
            volume: true,
            animations: { intro: false },
            nativeBackend: backend,
          },
          { dataFeed: feedRef.current },
        );
        chartRef.current = chart;
        await chart.ready();
        if (!alive()) return;
        readyRef.current = true;
        setMode(isRetry ? "compat" : "ok");
        if (!chart.presentNativeIndicators().includes(CVD_ID)) chart.addNativeIndicator(CVD_ID);
        pushOverlay();
        frameLatest();
        scheduleReadout();
        unsubs.push(
          chart.renderer.onCrosshairMove((e) => {
            hoverRef.current = e.ohlc ?? null;
            scheduleReadout();
          }),
        );
        unsubs.push(
          chart.renderer.onClick((e) => {
            if (e.time != null) clickRef.current?.(e.time);
          }),
        );
        // 容器尺寸变化时重排（首个布局未稳定时可能测到 0 尺寸）
        if (hostRef.current && typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => {
            if (!disposed) {
              try {
                chartRef.current?.resize();
              } catch {}
            }
          });
          ro.observe(hostRef.current);
          unsubs.push(() => ro.disconnect());
        }

        // 看门狗：画布没挂上 / 0 尺寸 → 认定初始化失败，换渲染后端重建
        if (backend === "auto") {
          watchdog = setTimeout(async () => {
            if (disposed || canvasesOk()) return;
            console.warn("[vela] 画布未挂载，降级为 canvas2d 重建");
            teardown();
            await create("canvas2d", true);
          }, 4000);
        }
      } catch (err) {
        console.warn("[vela] 初始化失败:", err);
        if (backend === "auto" && alive()) {
          teardown();
          await create("canvas2d", true);
        } else if (alive() && !isRetry) {
          teardown();
          await create("auto", true);
        } else if (alive()) {
          setMode("error");
        }
      }
    };

    const teardown = () => {
      unsubs.splice(0).forEach((u) => u());
      readyRef.current = false;
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      try {
        chartRef.current?.destroy();
      } catch {}
      if (hostRef.current) hostRef.current.innerHTML = "";
      chartRef.current = null;
    };

    void create(probeWebGL2() ? "auto" : "canvas2d", false);

    return () => {
      disposed = true;
      if (watchdog) clearTimeout(watchdog);
      unsubs.splice(0).forEach((u) => u());
      readyRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        chartRef.current?.destroy();
      } catch {}
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 切换币种 / 周期：原地 setMarket（指标、图层、订阅都保留）──
  useEffect(() => {
    if (keyRef.current === dataKey) return;
    keyRef.current = dataKey;
    const c = chartRef.current;
    if (!c || !readyRef.current) return;
    const cs = candlesRef.current;
    lastBarRef.current = cs.length ? toBar(cs[cs.length - 1]) : null;
    prevCloseRef.current = cs.length > 1 ? cs[cs.length - 2].c : 0;
    hoverRef.current = null;
    switchingRef.current = true;
    void c.setMarket({ data: cs.map(toBar), timeframe: bar }).then(() => {
      if (keyRef.current !== dataKey) return;
      switchingRef.current = false;
      pushOverlay();
      frameLatest();
      scheduleReadout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  // ── 叠加层数据 ──
  useEffect(() => {
    if (readyRef.current) pushOverlay();
    scheduleReadout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // ── 聚焦信号：定位到形态起点 → 出场 ──
  const focusKey = payload.focus ? `${payload.focus.ts}|${payload.focus.side}|${payload.focus.title}` : "";
  useEffect(() => {
    const c = chartRef.current;
    const f = payloadRef.current.focus;
    if (!c || !readyRef.current) return;
    if (!f) return;
    const bm = barMs(bar);
    const pts = f.geo?.pts?.map((p) => p.ts) ?? [];
    const start = Math.min(f.ts - bm * 40, ...(pts.length ? pts : [f.ts]));
    const end = Math.max(f.exitTs ?? f.ts, f.ts) + bm * 18;
    c.setVisibleRange(clampRange(start - bm * 8, end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />
      {mode !== "ok" && (
        <div className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-md border border-[#1d2534] bg-[#10151f]/95 px-3 py-1.5 text-[10px] text-[#f0b90b]">
          {mode === "compat" ? "图表运行在兼容渲染模式（当前浏览器不支持 WebGL 加速）" : "图表初始化失败，请刷新页面重试"}
        </div>
      )}
      <div
        ref={readoutRef}
        className="mono pointer-events-none absolute left-1/2 top-2 z-10 flex -translate-x-1/2 flex-nowrap items-center gap-x-3 whitespace-nowrap rounded-md border border-[#1d2534] bg-[rgba(10,13,19,0.82)] px-2.5 py-1 text-[10px] text-[#5b6579] backdrop-blur-sm"
        data-symbol={symbol}
      />
    </div>
  );
});

export default VelaChart;
