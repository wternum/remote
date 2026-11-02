import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  registerIcon,
  registerLocale,
  registerSidePanel,
  registerWidgetAction,
} from "@luxalgo/vela";
import zhHans from "@luxalgo/vela/locales/zh-Hans";
import type { Vela, WidgetContext, IndicatorHandle } from "@luxalgo/vela";
import { VelaWorkspace } from "@luxalgo/vela/workspace";
import { OKX_PROVIDER, TapeFeed } from "./lib/okx";
import { registerDoubleIndicator } from "./lib/indicator";
import { store } from "./lib/store";
import { barMs } from "./lib/types";
import SignalsPanel from "./components/SignalsPanel";
import IndicatorBrowser from "./components/IndicatorBrowser";
import { enhanceDrawingMenus } from "./lib/drawing-menu";

let booted = false;

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [indicatorContext, setIndicatorContext] =
    useState<WidgetContext | null>(null);
  const closeIndicatorBrowser = useCallback(
    () => setIndicatorContext(null),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || booted) return;
    booted = true;

    registerLocale(zhHans);

    registerIcon(
      "pulse-signals",
      `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 11.5l3-4 3 5 3-8 3 6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="2" cy="11.5" r="1" fill="currentColor" stroke="none"/>
        <circle cx="14" cy="10.5" r="1" fill="currentColor" stroke="none"/>
      </svg>`,
    );
    registerIcon(
      "pulse-replay",
      `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 8a5 5 0 1 0 1.5-3.6L3 5.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 3v2.8h2.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`,
    );

    registerDoubleIndicator();

    registerWidgetAction({
      id: "indicators",
      target: "topbar",
      label: "指标",
      icon: "indicators",
      align: "left",
      run: (ctx) => setIndicatorContext(ctx),
    });

    let panelCtx: WidgetContext | null = null;
    let chart: Vela | null = null;
    let replaying = false;
    let ws: VelaWorkspace | null = null;

    const toggleReplay = () => {
      const w = ws;
      if (!w) return;
      if (replaying) {
        w.replay.stop();
        replaying = false;
        return;
      }
      const s = store.get();
      const from = Date.now() - 120 * barMs(s.tf);
      void w.replay
        .start({ from })
        .then(() => w.replay.play(900))
        .catch(() => undefined);
      replaying = true;
    };

    registerWidgetAction({
      id: "pulse-replay",
      target: "topbar",
      label: "K线回放（最近120根）",
      icon: "pulse-replay",
      order: 20,
      align: "left",
      iconOnly: true,
      run: () => toggleReplay(),
    });

    registerSidePanel({
      id: "pulse-signals",
      title: "信号台",
      icon: "pulse-signals",
      order: 90,
      width: 360,
      resizable: true,
      minWidth: 300,
      maxWidth: 560,
      mount(ctx, body) {
        panelCtx = ctx;
        const root = createRoot(body);
        root.render(<SignalsPanel />);
        return {
          onChart(c: Vela) {
            chart = c;
            syncIndicatorVisibility();
          },
          destroy() {
            root.unmount();
          },
        };
      },
    });

    store.attachTape(new TapeFeed("BTC-USDT-SWAP", "5"));

    ws = new VelaWorkspace(host, {
      layout: false,
      symbol: "BTCUSDT",
      timeframe: "5",
      timeframes: ["1", "3", "5", "15", "30", "60"],
      bars: 1500,
      live: true,
      volume: true,
      watermark: true,
      statusline: true,
      bottombar: true,
      drawingToolbar: true,
      theme: "dark",
      locale: "zh-Hans",
      upColor: "#0ecb81",
      downColor: "#f6465d",
      currentPriceLine: true,
      timezone: "Etc/UTC",
      layoutMode: "desktop",
      autofocus: true,
      persist: "vela-pulsedeck-v2",
      providers: { okx: () => OKX_PROVIDER },
    });

    const c = ws.chart;
    c.on(
      "market:changed",
      ({ symbol, timeframe }: { symbol: string; timeframe: string }) => {
        store.setMarket(symbol, timeframe);
      },
    );
    c.addNativeIndicator("pulse.double");
    const stopEnhancingDrawings = enhanceDrawingMenus(host);

    function syncIndicatorVisibility() {
      if (!chart) return;
      const h: IndicatorHandle | undefined = chart
        .indicators()
        .find((i) => i.nativeType === "pulse.double");
      h?.setVisible(store.get().showSignals);
    }

    const unsub = store.subscribe(() => syncIndicatorVisibility());

    const openTimer = setTimeout(() => {
      panelCtx?.togglePanel("pulse-signals", true);
    }, 700);

    return () => {
      clearTimeout(openTimer);
      stopEnhancingDrawings();
      unsub();
      ws?.destroy();
      ws = null;
      booted = false;
    };
  }, []);

  return (
    <div className="app-root">
      <div ref={hostRef} className="ws-host" />
      {indicatorContext && (
        <IndicatorBrowser
          ctx={indicatorContext}
          onClose={closeIndicatorBrowser}
        />
      )}
    </div>
  );
}
