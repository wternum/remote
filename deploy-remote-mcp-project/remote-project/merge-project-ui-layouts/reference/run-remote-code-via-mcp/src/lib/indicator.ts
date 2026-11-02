import { registerNativeIndicator } from "@luxalgo/vela";
import type {
  NativeIndicatorContext,
  NativeIndicator,
  DrawingLine,
  PriceLine,
} from "@luxalgo/vela";
import { store } from "./store";
import { Candle, barMs } from "./types";

const PANE = "price";
const GREEN = "#0ecb81";
const RED = "#f6465d";

type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export function registerDoubleIndicator() {
  registerNativeIndicator({
    type: "pulse.double",
    title: "双顶/双底 W/M 信号",
    shortTitle: "W/M",
    paneHint: "price",
    overlay: true,
    legend: true,
    waitsForHistory: true,
    inputsSchema: () => [],
    defaultInputs: () => ({}),
    create: () => {
      let current: NativeIndicatorContext | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let alive = false;

      function run(ctx: NativeIndicatorContext) {
        const bars = ctx.bars();
        if (bars.length < 60) {
          ctx.emit({});
          return;
        }
        // 数据统一进 store（只有新收盘 K 线才触发全量重算，实时 tick 不阻塞交互）
        store.updateBars(bars as readonly Bar[]);

        const s = store.get();
        if (!s.showSignals) {
          ctx.emit({});
          return;
        }

        const markers = s.signals.slice(-160).map((sig) => ({
          time: sig.ts,
          position: (sig.side === "long" ? "belowBar" : "aboveBar") as
            | "belowBar"
            | "aboveBar",
          shape: sig.side === "long" ? "triangleup" : "triangledown",
          color: sig.side === "long" ? GREEN : RED,
          text: sig.pattern.startsWith("db") ? "W" : "M",
          size: "small" as const,
        }));

        // 形态支撑/阻力线
        const lines: DrawingLine[] = [];
        for (const [i, sig] of s.signals.slice(-24).entries()) {
          const lv = sig.level;
          if (!lv) continue;
          const broken = sig.pattern === "db_break" || sig.pattern === "dt_break";
          lines.push({
            id: `wl-${sig.ts}-${i}`,
            paneId: PANE,
            xloc: "bar_time",
            x1: lv.fromTs,
            y1: lv.price,
            x2: lv.toTs,
            y2: lv.price,
            extend: "none",
            invisible: false,
            width: 1,
            style: broken ? "dotted" : "solid",
            arrowLeft: false,
            arrowRight: false,
            color:
              sig.side === "long"
                ? "rgba(14,203,129,0.75)"
                : "rgba(246,70,93,0.75)",
          });
        }

        // 未测试的候选关键位（虚线）
        const priceLines: PriceLine[] = s.levels
          .filter((l) => !l.tested && !l.broken)
          .slice(-4)
          .map((l, i) => ({
            id: `pl-${i}-${l.side}`,
            paneId: PANE,
            price: l.price,
            color:
              l.side === "bottom"
                ? "rgba(14,203,129,0.38)"
                : "rgba(246,70,93,0.38)",
            lineStyle: "dashed" as const,
            width: 1,
            title: l.side === "bottom" ? "候选支撑" : "候选阻力",
          }));

        ctx.emit({
          series: [
            {
              id: "wm-marks",
              title: "W/M",
              paneId: PANE,
              kind: "markers" as const,
              markers,
              display: {
                pane: true,
                priceScale: false,
                legend: false,
                dataWindow: false,
              },
            },
          ],
          lines,
          priceLines,
        });
      }

      const instance: NativeIndicator = {
        start(ctx) {
          alive = true;
          current = ctx;
          run(ctx);
          ctx.setStatus("live");
        },
        onBars() {
          if (!alive || !current || timer) return;
          const ctx = current;
          timer = setTimeout(() => {
            timer = null;
            if (alive) run(ctx);
          }, 250);
        },
        onViewport() {},
        setInputs() {},
        suspend() {},
        resume() {},
        stop() {
          alive = false;
          if (timer) clearTimeout(timer);
          timer = null;
        },
      };
      return instance;
    },
  });
}

/** 仅供类型引用，避免未使用告警 */
export type { Candle };
export { barMs };
