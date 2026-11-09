import type { Vela, WidgetContext } from '@luxalgo/vela';
import { registerWidgetAttachment } from '@luxalgo/vela';
import { barsHub } from './okxProvider';
import { flowPeriodOf, getFlow, subscribeFlow } from '@/quant/flow';
import { buildFrameworks, type FrameworkReport } from '@/quant/frameworks';
import { labelOf } from '@/quant/fractal';
import { projectFrameworkMarks } from '@/quant/frameworkMarks';
import type { AnnObstacle } from './annotTypes';
import { FW_OVER, FW_UNDER, registerFrameworkLayers, type FrameworkLayerData } from './frameworkLayer';
import { getFrameworkMarkStore } from './frameworkMarkStore';
import {
  DEFAULT_FRAMEWORK_MARKET,
  frameworkInputKey,
  normalizeFrameworkMarket,
  toCandle,
  type FrameworkMarket,
} from './frameworkKey';

export { frameworkInputKey, normalizeFrameworkMarket, type FrameworkMarket };

export type FrameworkStatus = 'loading' | 'ready' | 'error';

export interface FrameworkLiveSnapshot {
  market: FrameworkMarket;
  report: FrameworkReport | null;
  status: FrameworkStatus;
  message: string;
  updatedAt: number;
}

const DEFAULT_MARKET: FrameworkMarket = DEFAULT_FRAMEWORK_MARKET;
const THROTTLE_MS = 1000;

// Shared reactive snapshot so FrameworksPanel and FrameworkBar read the same cached report.
let liveState: FrameworkLiveSnapshot = {
  market: DEFAULT_MARKET,
  report: null,
  status: 'loading',
  message: '等待图表已收盘行情…',
  updatedAt: 0,
};
const liveListeners = new Set<() => void>();
const publishLive = (next: FrameworkLiveSnapshot) => {
  liveState = next;
  liveListeners.forEach(fn => fn());
};

let forceRefreshHook: (() => void) | null = null;

export const frameworkLiveStore = {
  getSnapshot: () => liveState,
  subscribe(fn: () => void) {
    liveListeners.add(fn);
    return () => {
      liveListeners.delete(fn);
    };
  },
  refresh() {
    forceRefreshHook?.();
  },
};

type ChartPort = { rendererPort?: { setNativeData?: (id: string, payload: FrameworkLayerData) => void } };

function mountFrameworkRuntime(ctx: WidgetContext): () => void {
  const markStore = getFrameworkMarkStore();
  let alive = true;
  let chart: Vela | null = null;
  let chartOff: (() => void)[] = [];
  let market = DEFAULT_MARKET;
  let marketKey = barsHub.key(market.symbol, market.tf);
  let hasMarket = false;
  let inputKey = '';
  let paintFingerprint = '';
  let revision = 0;
  let cachedReport: FrameworkReport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attachTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRunAt = 0;
  let forcePending = false;

  const getChart = () => {
    try {
      return ctx.chart;
    } catch {
      return null;
    }
  };

  const obstacles = (): AnnObstacle[] => {
    if (!chart) return [];
    try {
      return chart.drawings
        .all()
        .filter(d => d.visible !== false && d.anchors?.length)
        .map(d => ({
          kind: /^(hline|hray|horizontal)/.test(d.type) ? ('hline' as const) : ('points' as const),
          points: d.anchors.map(a => ({ time: a.time, price: a.price })),
        }));
    } catch {
      return [];
    }
  };

  const paint = (force = false) => {
    if (!chart) return;
    const prefs = markStore.getSnapshot();
    const projected = projectFrameworkMarks(cachedReport, prefs, market.barMs);
    projected.payload.obstacles = prefs.enabled ? obstacles() : [];
    const nextSig = JSON.stringify(projected);
    if (!force && nextSig === paintFingerprint) return;
    paintFingerprint = nextSig;
    const port = (chart as unknown as ChartPort).rendererPort;
    const data: FrameworkLayerData = {
      payload: { ...projected.payload, rev: ++revision },
      hud: projected.hud,
    };
    port?.setNativeData?.(FW_UNDER, data);
    port?.setNativeData?.(FW_OVER, data);
  };

  const setMarket = (symbol?: string, timeframe?: string) => {
    const next = normalizeFrameworkMarket(symbol, timeframe);
    const nextKey = barsHub.key(next.symbol, next.tf);
    if (hasMarket && nextKey === marketKey) return;
    hasMarket = true;
    market = next;
    marketKey = nextKey;
    inputKey = '';
    cachedReport = null;
    paintFingerprint = '';
    publishLive({
      market,
      report: null,
      status: 'loading',
      message: '切换市场，等待已收盘行情…',
      updatedAt: Date.now(),
    });
    paint(true);
    schedule(true);
  };

  const run = () => {
    timer = undefined;
    if (!alive) return;
    const forceRecompute = forcePending;
    forcePending = false;
    lastRunAt = Date.now();
    attach();
    if (!chart) return;

    const raw = barsHub.get(market.symbol, market.tf);
    if (!raw.length) {
      if (cachedReport !== null || liveState.market.symbol !== market.symbol || liveState.market.tf !== market.tf) {
        cachedReport = null;
        publishLive({
          market,
          report: null,
          status: 'loading',
          message: '图表尚未加载该市场；结构分析不额外请求行情接口。',
          updatedAt: lastRunAt,
        });
      }
      paint();
      return;
    }

    const key = frameworkInputKey(raw, market, lastRunAt);
    if (forceRecompute || key !== inputKey) {
      inputKey = key;
      try {
        const period = flowPeriodOf(market.tf);
        const flow = period ? getFlow(market.symbol, period) ?? null : null;
        cachedReport = buildFrameworks(
          raw.map(toCandle),
          market.barMs,
          market.symbol,
          labelOf(Math.round(market.barMs / 60_000)),
          flow,
          lastRunAt,
        );
        publishLive({
          market,
          report: cachedReport,
          status: cachedReport ? 'ready' : 'loading',
          message: cachedReport ? '' : '连续已收盘 K 线不足 40 根，或历史缺口后可用样本不足。',
          updatedAt: lastRunAt,
        });
      } catch (error) {
        inputKey = '';
        cachedReport = null;
        publishLive({
          market,
          report: null,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          updatedAt: lastRunAt,
        });
      }
    }
    paint();
  };

  function schedule(immediate = false, forceRecompute = false) {
    if (!alive) return;
    // 强制刷新不能被随后到达的普通 bar/flow 通知降级成“仅按 key 判断”。
    forcePending = forcePending || forceRecompute;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const delay = immediate ? 0 : Math.max(0, THROTTLE_MS - (Date.now() - lastRunAt));
    timer = setTimeout(run, delay);
  }

  function attach() {
    if (!alive) return;
    const next = getChart();
    if (next && next !== chart) {
      chartOff.splice(0).forEach(off => off());
      chart = next;
      paintFingerprint = '';
      chartOff.push(chart.on('load:start', m => setMarket(m.symbol, m.timeframe)));
      chartOff.push(chart.on('load:end', () => schedule(true)));
      chartOff.push(chart.on('market:changed', m => setMarket(m.symbol, m.timeframe)));
      chartOff.push(chart.on('drawing:created', () => paint()));
      chartOff.push(chart.on('drawing:edited', () => paint()));
      chartOff.push(chart.on('drawing:removed', () => paint()));
      setMarket(chart.market.symbol, chart.market.timeframe);
    } else if (!chart && !attachTimer) {
      attachTimer = setTimeout(() => {
        attachTimer = undefined;
        attach();
        schedule(true);
      }, 300);
    }
  }

  const offBars = barsHub.subscribe(key => {
    if (key === marketKey) schedule();
  });
  const offFlow = subscribeFlow(snap => {
    if (snap.instId === market.symbol && snap.period === flowPeriodOf(market.tf)) schedule();
  });
  const offMarks = markStore.subscribe(() => paint());

  const ownHook = () => {
    const c = getChart();
    if (c) setMarket(c.market.symbol, c.market.timeframe);
    schedule(true, true);
  };
  forceRefreshHook = ownHook;

  attach();
  schedule(true);

  return () => {
    alive = false;
    if (forceRefreshHook === ownHook) forceRefreshHook = null;
    if (timer) clearTimeout(timer);
    if (attachTimer) clearTimeout(attachTimer);
    offBars();
    offFlow();
    offMarks();
    chartOff.splice(0).forEach(off => off());
    try {
      const port = (chart as unknown as ChartPort | null)?.rendererPort;
      const cleared: FrameworkLayerData = {
        payload: { levels: [], events: [], zones: [], paths: [], position: null, obstacles: [], decimals: 2, rev: ++revision },
        hud: null,
      };
      port?.setNativeData?.(FW_UNDER, cleared);
      port?.setNativeData?.(FW_OVER, cleared);
    } catch {
      /* chart may already be destroyed */
    }
  };
}

let markingRegistered = false;

export function registerFrameworkMarking() {
  if (markingRegistered) return;
  markingRegistered = true;
  registerFrameworkLayers();
  registerWidgetAttachment({
    id: 'pulsedesk-framework-marks',
    mount(ctx) {
      return mountFrameworkRuntime(ctx);
    },
  });
}
