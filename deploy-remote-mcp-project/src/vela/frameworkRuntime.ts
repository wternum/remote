import type { Vela, WidgetContext } from '@luxalgo/vela';
import { registerWidgetAttachment } from '@luxalgo/vela';
import { barsHub } from './okxProvider';
import { flowPeriodOf, getFlow, releaseTape, subscribeFlow, syncFlow } from '@/quant/flow';
import { buildFrameworks, type FrameworkReport } from '@/quant/frameworks';
import { labelOf } from '@/quant/fractal';
import { projectFrameworkMarks, type FrameworkHud } from '@/quant/frameworkMarks';
import type { AnnObstacle } from './annotTypes';
import { FW_OVER, FW_UNDER, registerFrameworkLayers, type FrameworkLayerData } from './frameworkLayer';
import { getFrameworkMarkStore } from './frameworkMarkStore';
import { isClosedCandle } from '@/lib/okxCandles';
import { decimalsFor } from './annotTypes';
import { getSessionStore } from './sessions/sessionStore';
import { asiaRailLevels, asiaRefs } from './sessions/asiaRail';
import type { BarLike } from './sessions/sessionMath';
import {
  DEFAULT_FRAMEWORK_MARKET,
  frameworkInputKey,
  isSupportedFrameworkSymbol,
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
  /** 图上右上角的盘面（底栏「标注」按钮显示同一个结论）；标注关闭时为 null */
  hud?: FrameworkHud | null;
}

const DEFAULT_MARKET: FrameworkMarket = DEFAULT_FRAMEWORK_MARKET;
const THROTTLE_MS = 1000;

/** 最近一根已收盘 K 线的时间（只看尾部几根）；变化 = 刚收盘，结构需立即重算 */
export function latestClosedTs(raw: readonly { time: number }[], barMs: number, now: number): number {
  for (let i = raw.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
    const c = toCandle(raw[i] as Parameters<typeof toCandle>[0]);
    if (c.ts < now && isClosedCandle(c, barMs, now)) return c.ts;
  }
  return -1;
}

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

/** 亚盘高低点只在日内周期、时段图层与「亚盘高低点」开关都打开时出标签（与时段图层同一口径） */
const INTRADAY_MAX_BAR_MS = 12 * 3_600_000;

function mountFrameworkRuntime(ctx: WidgetContext): () => void {
  const markStore = getFrameworkMarkStore();
  const sessionStore = getSessionStore();
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
  let lastClosedSeen = -1;
  let forcePending = false;
  let flowController: AbortController | null = null;
  let flowMarket = '';
  let flowBusy = false;
  let flowEpoch = 0;
  let lastFlowRequest = 0;

  const stopFlow = () => {
    flowEpoch++;
    flowController?.abort();
    flowController = null;
    const old = flowMarket.split('|')[0];
    flowMarket = '';
    flowBusy = false;
    if (old) releaseTape(old, 'framework');
  };

  const requestFlow = () => {
    if (!isSupportedFrameworkSymbol(market.symbol)) {
      if (flowMarket) stopFlow();
      return;
    }
    const period = flowPeriodOf(market.tf);
    if (!period) {
      if (flowMarket) stopFlow();
      return;
    }
    const key = `${market.symbol}|${period}`;
    if (flowMarket !== key) {
      stopFlow();
      flowMarket = key;
      flowController = new AbortController();
      lastFlowRequest = 0;
    }
    if (flowBusy || Date.now() - lastFlowRequest < 30_000) return;
    flowBusy = true;
    const epoch = flowEpoch;
    const controller = flowController!;
    lastFlowRequest = Date.now();
    const backfilled = !!getFlow(market.symbol, period)?.rubikComplete;
    const pages = backfilled ? 1 : Math.min(14, Math.ceil(600 / 100) + 1);
    void syncFlow(market.symbol, period, {
      minTs: 0,
      maxPages: pages,
      oiPages: backfilled ? 1 : 2,
      bootstrapBars: period === '5m' ? 12 : 6,
      bootstrapPages: 300,
      signal: controller.signal,
      owner: 'framework',
    }).finally(() => {
      if (!alive || controller.signal.aborted || epoch !== flowEpoch) return;
      flowBusy = false;
      schedule();
    });
  };

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

  const asiaLevels = () => {
    const sp = sessionStore.getSnapshot().preferences;
    if (!sp.enabled || !sp.showAsiaRange || !(market.barMs < INTRADAY_MAX_BAR_MS) || !isSupportedFrameworkSymbol(market.symbol)) return { levels: [], refs: [], lastClose: NaN };
    const raw = barsHub.get(market.symbol, market.tf) as readonly BarLike[];
    return { levels: asiaRailLevels(raw), refs: asiaRefs(raw), lastClose: raw.at(-1)?.close ?? NaN };
  };

  const paint = (force = false) => {
    if (!chart) return;
    const prefs = markStore.getSnapshot();
    // 亚盘标签属于时段图层的开关，不受「图表标注 开/关」影响；它们和四框架的线一起合带、一起配合着说
    const asia = asiaLevels();
    const projected = projectFrameworkMarks(cachedReport, prefs, market.barMs, { extraLevels: asia.levels, refs: asia.refs });
    projected.payload.obstacles = prefs.enabled ? obstacles() : [];
    if (!cachedReport && asia.levels.length && Number.isFinite(asia.lastClose)) projected.payload.decimals = decimalsFor(asia.lastClose);
    const hud = projected.hud;
    const prevHud = liveState.hud ?? null;
    const hudKey = (h: FrameworkHud | null) => (h ? `${h.title}|${h.detail.join('|')}` : '');
    if (hudKey(hud) !== hudKey(prevHud)) {
      publishLive({ ...liveState, hud });
    }
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
    stopFlow();
    hasMarket = true;
    market = next;
    marketKey = nextKey;
    inputKey = '';
    lastClosedSeen = -1;
    cachedReport = null;
    paintFingerprint = '';
    publishLive({
      market,
      report: null,
      status: isSupportedFrameworkSymbol(next.symbol) ? 'loading' : 'error',
      message: isSupportedFrameworkSymbol(next.symbol)
        ? '切换市场，等待已收盘行情…'
        : `暂不支持 ${next.symbol} 的四框架结构分析（仅支持 BTC / ETH / SOL 永续）。`,
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

    if (!isSupportedFrameworkSymbol(market.symbol)) {
      stopFlow();
      cachedReport = null;
      paint();
      return;
    }

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
      requestFlow();
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
    requestFlow();
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
    if (key !== marketKey) return;
    // 收盘那一刻跳过 1 秒节流：FVG / 扫位 / BOS 等收盘事件随 confirm 推送立即出现；
    // 形成中的价格跳动仍按节流合并（它们不会改变结构结果）。
    const closedTs = latestClosedTs(barsHub.get(market.symbol, market.tf), market.barMs, Date.now());
    const justClosed = closedTs !== lastClosedSeen;
    lastClosedSeen = closedTs;
    schedule(justClosed);
  });
  const offFlow = subscribeFlow(snap => {
    if (snap.instId === market.symbol && snap.period === flowPeriodOf(market.tf)) schedule();
  });
  const offMarks = markStore.subscribe(() => paint());
  const offSession = sessionStore.subscribe(() => paint());

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
    stopFlow();
    offBars();
    offFlow();
    offMarks();
    offSession();
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
