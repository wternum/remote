"use client";
/**
 * Vela™ (LuxAlgo) 插件：
 *  - pa-overlay：自定义画布图层（信号标注 / FVG / 聚焦信号结构 + 多空仓位工具）
 *  - pa-cvd    ：原生指标（独立副图，K 线估算 Delta 累计 CVD，实时随 K 线更新）
 * 均通过 Vela 公开插件 SDK 注册（@luxalgo/vela/plugin），不 fork 库代码。
 */
import type { SignalGeo, KeyLevel } from "@/lib/types";

export const OVERLAY_ID = "pa-overlay";
export const CVD_ID = "pa-cvd";

export interface OverlayMarker {
  ts: number;
  side: "long" | "short";
  label: string;
  r?: number;
  live?: boolean;
}
export interface OverlayFocus {
  ts: number;
  side: "long" | "short";
  entry: number;
  stop: number;
  tp: number;
  entryTs?: number;
  exitTs?: number;
  exitPrice?: number;
  r?: number;
  geo?: SignalGeo;
  title: string;
}
export interface OverlayPayload {
  markers: OverlayMarker[];
  levels: KeyLevel[];
  focus: OverlayFocus | null;
  show: { signals: boolean; zones: boolean; lines: boolean };
  decimals: number;
  barMs: number;
}

const UP = "#2ebd85";
const DOWN = "#f6465d";
const CYAN = "#37c8dd";
const AMBER = "#f0b90b";
const GEO = "#c084fc";
const FONT = "600 10px 'IBM Plex Mono', ui-monospace, monospace";

type Ctx2D = CanvasRenderingContext2D;

function pill(ctx: Ctx2D, x: number, y: number, text: string, bg: string, fg: string, align: "left" | "center" | "right" = "center") {
  ctx.font = FONT;
  const w = ctx.measureText(text).width + 8;
  const h = 15;
  const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y - h / 2, w, h, 3);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + 4, y + 0.5);
  return w;
}

function tri(ctx: Ctx2D, x: number, y: number, up: boolean, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y + s * 1.5);
    ctx.lineTo(x + s, y + s * 1.5);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y - s * 1.5);
    ctx.lineTo(x + s, y - s * 1.5);
  }
  ctx.closePath();
  ctx.fill();
}

let registered = false;

// Safari 16.3 及更早没有 ctx.roundRect
function ensureRoundRect() {
  const proto = (window.CanvasRenderingContext2D?.prototype ?? {}) as CanvasRenderingContext2D;
  if (typeof proto.roundRect !== "function") {
    (proto as unknown as Record<string, unknown>).roundRect = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number | number[] | DOMPointInit | (number | DOMPointInit)[],
    ) {
      const rad = Math.min(typeof r === "number" ? r : 4, Math.abs(w) / 2, Math.abs(h) / 2);
      this.moveTo(x + rad, y);
      this.arcTo(x + w, y, x + w, y + h, rad);
      this.arcTo(x + w, y + h, x, y + h, rad);
      this.arcTo(x, y + h, x, y, rad);
      this.arcTo(x, y, x + w, y, rad);
      this.closePath();
      return this;
    };
  }
}

export async function registerVelaPlugins() {
  if (registered) return;
  ensureRoundRect();
  registered = true;
  const plugin = await import("@luxalgo/vela/plugin");

  // ─── 图层：信号 / FVG / 聚焦结构 ─────────────────────────
  plugin.registerRendererLayer({
    id: OVERLAY_ID,
    placement: "above-data",
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      // 时间 → bar 索引缓存（只在 bars 结构变化时重建）
      let idxKey = "";
      let idx = new Map<number, number>();
      return {
        mount(c: HTMLCanvasElement) {
          canvas = c;
        },
        render(args) {
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const { coords, scale, bounds, bars } = args;
          const dpr = coords.dpr || 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const p = args.data as OverlayPayload | undefined;
          if (!p || bars.length === 0) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, bounds.top, coords.width, bounds.height);
          ctx.clip();

          const key = `${bars.length}|${bars[0].time}|${bars[bars.length - 1].time}`;
          if (key !== idxKey) {
            idxKey = key;
            idx = new Map();
            for (let i = 0; i < bars.length; i++) idx.set(bars[i].time, i);
          }
          const W = coords.width;
          const X = (ms: number) => coords.timeToX(ms);
          const Y = (price: number) => coords.priceToY(price, scale, bounds);
          const visible = (x: number) => x > -40 && x < W + 40;
          const bw = Math.max(2, coords.pxPerBar());
          const fmt = (v: number) => v.toFixed(p.decimals);

          // 1) 历史顶部/底部关键位：已二次测试 = 双顶/双底（实心区带），未测试 = 顶部/底部（细带）
          if (p.show.zones) {
            for (const z of p.levels) {
              const x0 = Math.max(-40, X(z.from));
              const x1 = z.broken ? X(z.to) + bw / 2 : W;
              if (x0 > W || x1 < 0) continue;
              const y = Y(z.price);
              const top = z.side === "top";
              const rgb = top ? "246,70,93" : "46,189,133";
              const hh = z.tested ? 6 : 2.5;
              ctx.fillStyle = `rgba(${rgb},${z.tested ? (z.broken ? 0.16 : 0.34) : 0.22})`;
              ctx.fillRect(x0, y - hh / 2, Math.max(0, x1 - x0), hh);
              const label = `${z.tested ? (top ? "双顶" : "双底") : top ? "顶部" : "底部"} ${fmt(z.price)}${z.broken ? " · 已破" : ""}`;
              const lx = Math.min(Math.max(x0 + 4, 4), W - 150);
              pill(ctx, lx, top ? y - 11 : y + 11, label, `rgba(${rgb},${z.tested ? 0.3 : 0.15})`, top ? "#ffc2ca" : "#b6f5d8", "left");
            }
          }

          const f = p.focus;

          // 2) 聚焦：信号 K 线高亮 + 仓位工具 + 结构
          if (f) {
            const xs = X(f.ts);
            // 信号K竖向高亮带
            ctx.fillStyle = "rgba(55,200,221,0.13)";
            ctx.fillRect(xs - bw / 2, bounds.top, bw, bounds.height);
            ctx.strokeStyle = "rgba(55,200,221,0.55)";
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(xs + 0.5, bounds.top);
            ctx.lineTo(xs + 0.5, bounds.top + bounds.height);
            ctx.stroke();
            ctx.setLineDash([]);

            if (p.show.lines) {
              const xa = f.entryTs ? X(f.entryTs) : xs + bw;
              const xb = f.exitTs ? X(f.exitTs) + bw / 2 : Math.max(xa + bw * 20, X(bars[bars.length - 1].time) + bw * 4);
              const ye = Y(f.entry);
              const ys = Y(f.stop);
              const yt = Y(f.tp);
              // 盈利区 / 亏损区（多空仓位工具）
              ctx.fillStyle = "rgba(46,189,133,0.14)";
              ctx.fillRect(xa, Math.min(ye, yt), xb - xa, Math.abs(yt - ye));
              ctx.fillStyle = "rgba(246,70,93,0.14)";
              ctx.fillRect(xa, Math.min(ye, ys), xb - xa, Math.abs(ys - ye));
              const hline = (y: number, color: string, dash: number[]) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash(dash);
                ctx.beginPath();
                ctx.moveTo(xa, y + 0.5);
                ctx.lineTo(W, y + 0.5);
                ctx.stroke();
                ctx.setLineDash([]);
              };
              hline(ye, AMBER, []);
              hline(yt, UP, [4, 3]);
              hline(ys, DOWN, [4, 3]);
              const rr = Math.abs((f.tp - f.entry) / (f.entry - f.stop || 1));
              pill(ctx, W - 4, yt, `目标 ${fmt(f.tp)}`, UP, "#05231a", "right");
              pill(ctx, W - 4, ye, `入场 ${fmt(f.entry)}`, AMBER, "#2a1f00", "right");
              pill(ctx, W - 4, ys, `止损 ${fmt(f.stop)}`, DOWN, "#2b060c", "right");
              if (xb - xa > 60) pill(ctx, xa + 4, (ye + yt) / 2, `R:R 1:${rr.toFixed(1)}`, "rgba(13,17,25,0.85)", "#e7ecf5", "left");
              // 出场点
              if (f.exitTs && f.exitPrice != null) {
                const xe = X(f.exitTs);
                const yx = Y(f.exitPrice);
                const win = (f.r ?? 0) > 0;
                ctx.strokeStyle = "rgba(231,236,245,0.5)";
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(xa, ye);
                ctx.lineTo(xe, yx);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = win ? UP : DOWN;
                ctx.beginPath();
                ctx.arc(xe, yx, 4, 0, Math.PI * 2);
                ctx.fill();
                pill(ctx, xe, yx + (f.side === "long" ? (win ? -14 : 14) : win ? 14 : -14), `出场 ${f.r != null ? (f.r >= 0 ? "+" : "") + f.r.toFixed(2) + "R" : ""}`, win ? UP : DOWN, "#0a0d13");
              }
            }

            // 形态结构：折线 + 关键点 + 颈线
            const g = f.geo;
            if (g?.neck) {
              const x0 = X(g.neck.from);
              const x1 = Math.max(X(g.neck.to), f.exitTs ? X(f.exitTs) : X(g.neck.to)) + bw;
              const y = Y(g.neck.price);
              ctx.strokeStyle = AMBER;
              ctx.lineWidth = 1.2;
              ctx.setLineDash([6, 4]);
              ctx.beginPath();
              ctx.moveTo(x0, y + 0.5);
              ctx.lineTo(x1, y + 0.5);
              ctx.stroke();
              ctx.setLineDash([]);
              pill(ctx, x0 + 2, y - 10, g.neck.label ?? "颈线", "rgba(240,185,11,0.18)", AMBER, "left");
            }
            if (g?.path && g.path.length >= 2) {
              ctx.strokeStyle = GEO;
              ctx.lineWidth = 2;
              ctx.lineJoin = "round";
              ctx.beginPath();
              g.path.forEach((pt, i2) => (i2 === 0 ? ctx.moveTo(X(pt.ts), Y(pt.price)) : ctx.lineTo(X(pt.ts), Y(pt.price))));
              ctx.stroke();
              // 结构区域淡填充
              ctx.fillStyle = "rgba(192,132,252,0.06)";
              ctx.fill();
            }
            for (const pt of g?.pts ?? []) {
              const x = X(pt.ts);
              if (!visible(x)) continue;
              const y = Y(pt.price);
              ctx.fillStyle = "#0d1119";
              ctx.strokeStyle = GEO;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(x, y, 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
              pill(ctx, x, y + (pt.pos === "below" ? 14 : -14), pt.label, "rgba(192,132,252,0.22)", "#e9d5ff");
            }
            // 信号K标签
            const i = idx.get(f.ts);
            if (i != null) {
              const b = bars[i];
              const long = f.side === "long";
              const yb = long ? Y(b.low) + 8 : Y(b.high) - 8;
              tri(ctx, xs, yb, long, 6, CYAN);
              pill(ctx, xs, long ? yb + 22 : yb - 22, `◆ 信号K · ${f.title}`, CYAN, "#03262c");
            }
          }

          // 3) 信号标注（其余信号；聚焦时淡化）
          if (p.show.signals) {
            ctx.globalAlpha = f ? 0.35 : 1;
            for (const m of p.markers) {
              if (f && m.ts === f.ts && m.side === f.side) continue;
              const i = idx.get(m.ts);
              if (i == null) continue;
              const x = X(m.ts);
              if (!visible(x)) continue;
              const b = bars[i];
              const long = m.side === "long";
              const color = long ? UP : DOWN;
              const y = long ? Y(b.low) + 5 : Y(b.high) - 5;
              tri(ctx, x, y, long, 4.5, color);
              if (m.live) {
                ctx.strokeStyle = CYAN;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, long ? y + 4 : y - 4, 7, 0, Math.PI * 2);
                ctx.stroke();
              }
              if (bw >= 4) {
                const txt = m.label + (m.r != null ? (m.r >= 0 ? " +" : " ") + m.r.toFixed(1) : "");
                ctx.font = FONT;
                ctx.fillStyle = m.r == null ? color : m.r >= 0 ? UP : DOWN;
                ctx.textAlign = "center";
                ctx.textBaseline = long ? "top" : "bottom";
                ctx.fillText(txt, x, long ? y + 9 : y - 9);
              }
            }
            ctx.globalAlpha = 1;
          }
          ctx.restore();
        },
      };
    },
  });

  // ─── 原生指标：CVD（独立副图）────────────────────────────
  plugin.registerNativeIndicator({
    type: CVD_ID,
    title: "CVD 累计主动量 · USDT",
    shortTitle: "CVD",
    paneHint: "new",
    overlay: false,
    inputsSchema: () => [],
    defaultInputs: () => ({}),
    create: () => {
      let ctxRef: Parameters<import("@luxalgo/vela").NativeIndicator["start"]>[0] | null = null;
      let instanceId = "";
      let lastKey = "";
      const compute = () => {
        const ctx = ctxRef;
        if (!ctx) return;
        const bars = ctx.bars();
        if (!bars.length) return;
        const last = bars[bars.length - 1];
        const key = `${bars.length}|${last.time}|${last.close}|${last.volume ?? 0}`;
        if (key === lastKey) return;
        lastKey = key;
        let acc = 0;
        const cvd = new Array(bars.length);
        const delta = new Array(bars.length);
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i];
          const v = b.volume ?? 0; // 已在数据层统一为 USDT 成交额
          const range = b.high - b.low;
          const d = range > 0 ? v * (2 * ((b.close - b.low) / range) - 1) : b.close > b.open ? v / 2 : b.close < b.open ? -v / 2 : 0;
          acc += d;
          cvd[i] = { time: b.time, value: acc };
          delta[i] = d;
        }
        // CVD 线按斜率着色（主动买入抬升=绿，主动卖出=红）
        const pts = cvd.map((pt, i) => ({ ...pt, color: delta[i] >= 0 ? UP : DOWN }));
        ctx.emit({
          series: [
            {
              id: plugin.stableSeriesId({ instanceId, kind: "line", title: "CVD", ordinal: 0 }),
              title: "CVD",
              paneId: "",
              kind: "line",
              points: pts,
              style: { color: CYAN, width: 1.5, lineStyle: "solid" },
            },
          ],
          priceLines: [
            {
              id: plugin.stableSeriesId({ instanceId, kind: "hline", title: "zero", ordinal: 0 }),
              paneId: "",
              price: 0,
              color: "rgba(140,150,171,0.35)",
              lineStyle: "dashed",
              width: 1,
            },
          ],
        });
      };
      return {
        start(ctx) {
          ctxRef = ctx;
          instanceId = ctx.id;
          lastKey = "";
          compute();
          ctx.setStatus(ctx.live ? "live" : "idle");
        },
        onBars() {
          compute();
        },
        onViewport() {},
        setInputs() {
          lastKey = "";
          compute();
        },
        suspend() {},
        resume() {
          lastKey = "";
          compute();
        },
        stop() {
          ctxRef = null;
        },
      };
    },
  });
}
