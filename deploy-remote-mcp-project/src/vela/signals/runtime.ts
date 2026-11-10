import type { Vela, WidgetContext } from '@luxalgo/vela';
import { isClosedCandle } from '@/lib/okxCandles';
import { flowPeriodOf, getFlow, releaseTape, subscribeFlow, syncFlow } from '@/quant/flow';
import { ANNOT_OVER, ANNOT_UNDER } from '../annotLayer';
import type { AnnPayload, AnnObstacle } from '../annotTypes';
import { toCandle } from '../frameworkKey';
import { barsHub, tfMs } from '../okxProvider';
import { analyzeSignals, projectSignals, type SignalAnalysis } from './analyze';
import { signalRecomputeKey, flowRecomputeKey } from './recompute';
import { EMPTY_RUNTIME, flowRequested, emptyCounts, emptySignalPayload, type SignalStore } from './store';

type ChartPort = { rendererPort?: { setNativeData?: (id: string, payload: AnnPayload) => void } };
const blankAnalysis = (requested = 600): SignalAnalysis => ({ items: [], covered: 0, bars: 0, requested, gapTruncated: false, historyShort: false, lastPrice: 0 });

/**
 * 双顶 / 双底（M/W）图表标记开关。2026-11-06 曾整体下线，2026-11-10 按用户要求重新打开：
 * 默认只画双顶、双底及其情景区（关键位 / 回踩 / 主动成交等其余类型默认关闭，避免和四框架标注重复）。
 * 关掉时 analyzeSignals + projectSignals 整段跳过，订单流同步由 frameworkRuntime 独立维护。
 */
export const MARKERS_ENABLED = true;

/**
 * 双顶 / 双底是否单独画在图上。2026-11-10 用户确认的精简方案：不再单独画一套线、折线、情景区和右侧标签 ——
 * 双顶的两个高点就是压力带 / 箱顶，颈线就是支撑带 / 箱底，由四框架标注统一说一次。
 * 识别与侧栏「双顶双底」记录照常（MARKERS_ENABLED 仍为 true）。
 */
export const MW_ON_CHART = false;

/** The runtime belongs to the workspace, never the panel. Closing the sidebar leaves it alive. */
export function mountSignalRuntime(ctx: WidgetContext, store: SignalStore): () => void {
  let alive = true;
  let chart: Vela | null = null;
  let chartOff: (() => void)[] = [];
  let symbol = '', timeframe = '', marketKey = '';
  let analysis = blankAnalysis();
  let fingerprint = '', candleKey = '', flowInputKey = '';
  let revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let needsScan = true, lastScanAt = 0, lastRunAt = 0;
  let flowController: AbortController | null = null;
  let flowMarket = '', flowBusy = false, flowEpoch = 0;
  let lastFlowRequest = 0;
  let preferences = store.getSnapshot().preferences;
  let focusId = store.getSnapshot().focusId;
  let loading = true;
  let loadError = '';
  let lastInputAt = 0;

  const getChart = () => { try { return ctx.chart; } catch { return null; } };
  // 包括悬停详情、区带端点和用户画线；只签短标签会让当前状态/价格已更新，
  // 但画布上的说明仍是上一根 K 线的旧值。更新受 300ms 节流，无需牺牲正确性。
  const write = (payload: AnnPayload, force = false) => {
    if (!chart) return;
    const next = JSON.stringify(payload);
    if (!force && next === fingerprint) return;
    fingerprint = next;
    const port = (chart as unknown as ChartPort).rendererPort;
    const data = { ...payload, rev: ++revision };
    port?.setNativeData?.(ANNOT_UNDER, data);
    port?.setNativeData?.(ANNOT_OVER, data);
    // DOM metadata is for diagnostics/tests only; the canvas still owns all painting.
    ctx.host.dataset.signalMarkers = String(payload.events.length);
    ctx.host.dataset.signalLevels = String(payload.levels.length);
    ctx.host.dataset.signalZones = String(payload.zones.length);
    ctx.host.dataset.signalMarket = marketKey;
    ctx.host.dataset.signalRevision = String(revision);
  };
  const obstacles = (): AnnObstacle[] => {
    if (!chart) return [];
    try {
      return chart.drawings.all().filter(d => d.visible !== false && d.anchors?.length).map(d => ({
        kind: /^(hline|hray|horizontal)/.test(d.type) ? 'hline' as const : 'points' as const,
        points: d.anchors.map(a => ({ time: a.time, price: a.price })),
      }));
    } catch { return []; }
  };
  // 形成中那根每跳一次都会走到这里：分析结果、设置、选中项都没变时直接复用上次的投影
  let projMemo: { analysis: SignalAnalysis; preferences: typeof preferences; focusId: typeof focusId; projected: ReturnType<typeof projectSignals> } | null = null;
  let lastRuntime: Record<string, unknown> | null = null;
  const offChartPayload = emptySignalPayload();
  const paint = () => {
    let projected: ReturnType<typeof projectSignals>;
    if (projMemo && projMemo.analysis === analysis && projMemo.preferences === preferences && projMemo.focusId === focusId) {
      projected = projMemo.projected;
    } else {
      projected = MARKERS_ENABLED
        ? projectSignals(analysis, preferences, focusId)
        : { payload: emptySignalPayload(), visible: [], counts: emptyCounts() };
      projMemo = { analysis, preferences, focusId, projected };
    }
    if (MW_ON_CHART) {
      if (MARKERS_ENABLED && preferences.enabled) projected.payload.obstacles = obstacles();
      write(projected.payload);
    } else {
      // 不画在图上：恒下发同一份空 payload；write() 按指纹去重，只有第一次真正触达图层
      write(offChartPayload);
    }
    const period = flowPeriodOf(timeframe);
    const snap = period ? getFlow(symbol, period) : undefined;
    const runtime = {
      symbol, timeframe,
      status: (!preferences.enabled ? 'paused' : loadError ? 'error' : loading ? 'loading' : 'ready') as 'paused' | 'error' | 'loading' | 'ready',
      message: loadError,
      bars: analysis.bars, requested: analysis.requested, gapTruncated: analysis.gapTruncated, historyShort: analysis.historyShort, covered: analysis.covered,
      flowSupported: !!period, flowConnected: !!snap?.tape.connected,
      flowSyncing: flowBusy, updatedAt: lastScanAt,
      counts: projected.counts, visible: projected.visible, total: projected.visible.length,
    };
    // 状态没变就不通知侧栏重新渲染（以前每 300ms 都发一次新对象）
    const prev = lastRuntime;
    if (prev && (Object.keys(runtime) as (keyof typeof runtime)[]).every(k => prev[k] === runtime[k])) return;
    lastRuntime = runtime;
    store.updateRuntime(runtime);
  };
  const stopFlow = () => {
    flowEpoch++;
    flowController?.abort();
    flowController = null;
    const old = flowMarket.split('|')[0];
    flowMarket = '';
    flowBusy = false;
    if (old) releaseTape(old, 'signals');
  };
  const wantsFlow = () => MARKERS_ENABLED && flowRequested(preferences) && !!flowPeriodOf(timeframe);
  const requestFlow = () => {
    if (!wantsFlow()) { if (flowMarket) stopFlow(); return; }
    const period = flowPeriodOf(timeframe)!;
    const key = `${symbol}|${period}`;
    if (flowMarket !== key) {
      stopFlow(); flowMarket = key; flowController = new AbortController(); lastFlowRequest = 0;
    }
    if (flowBusy || Date.now() - lastFlowRequest < 30_000) return;
    flowBusy = true;
    const epoch = flowEpoch;
    const controller = flowController!;
    lastFlowRequest = Date.now();
    const backfilled = !!getFlow(symbol, period)?.rubikComplete;
    const pages = backfilled ? 1 : Math.min(14, Math.ceil(preferences.lookback / 100) + 1);
    void syncFlow(symbol, period, {
      minTs: 0, maxPages: pages, oiPages: backfilled ? 1 : 2,
      bootstrapBars: period === '5m' ? 12 : 6, bootstrapPages: 300,
      signal: controller.signal, owner: 'signals',
    }).finally(() => {
      if (!alive || controller.signal.aborted || epoch !== flowEpoch) return;
      flowBusy = false;
      needsScan = true;
      schedule();
    });
  };
  const setMarket = (nextSymbol: string, nextTf: string) => {
    const ticker = nextSymbol.replace(/^okx:/i, '');
    const key = barsHub.key(ticker, nextTf);
    if (key === marketKey) return;
    stopFlow();
    symbol = ticker; timeframe = nextTf; marketKey = key;
    loading = true; loadError = ''; candleKey = ''; flowInputKey = ''; fingerprint = ''; lastScanAt = 0;
    analysis = blankAnalysis(preferences.lookback); needsScan = true;
    focusId = null; store.focus(null);
    write(emptySignalPayload(), true);
    paint(); schedule();
  };
  const attach = () => {
    const next = getChart();
    if (!next || next === chart) return;
    chartOff.forEach(off => off()); chartOff = [];
    chart = next;
    fingerprint = '';
    chartOff.push(chart.on('load:start', m => {
      setMarket(m.symbol, m.timeframe);
      loading = true; analysis = blankAnalysis(preferences.lookback); candleKey = ''; needsScan = true;
      write(emptySignalPayload(), true); paint();
    }));
    chartOff.push(chart.on('load:end', m => {
      setMarket(m.symbol, m.timeframe);
      loading = false; loadError = m.bars ? '' : '行情暂未加载成功，请检查网络或切换市场重试。';
      needsScan = true; schedule();
    }));
    chartOff.push(chart.on('market:changed', m => { setMarket(m.symbol, m.timeframe); needsScan = true; schedule(); }));
    setMarket(chart.market.symbol ?? '', chart.market.timeframe ?? '5');
  };
  function run() {
    timer = undefined;
    lastRunAt = Date.now();
    if (!alive) return;
    attach();
    if (!chart || !symbol) return;
    if (MARKERS_ENABLED && !preferences.enabled) { if (flowMarket) stopFlow(); paint(); return; }
    const raw = barsHub.get(symbol, timeframe);
    if (!raw.length) {
      if (Date.now() - lastInputAt > 20_000) loadError = '等待行情数据，请检查 OKX 网络连接。';
      paint(); return;
    }
    loading = false; loadError = '';
    const now = Date.now();
    const last = raw.at(-1)!;
    const barMs = tfMs(timeframe);
    const lastCandle = toCandle(last);
    const previous = last.time < now && isClosedCandle(lastCandle, barMs, now) ? last : raw.at(-2);
    // 键只由「已收盘状态」驱动：未勾选预览时，形成中那根的价格跳动不触发重算
    // 只用最近 max(1200, 回看 + 900) 根：更早的历史分页到达不触发重新分析
    const span = Math.min(raw.length, Math.max(1200, preferences.lookback + 900) + 8);
    const key = signalRecomputeKey({
      marketKey, length: span, firstTs: raw[raw.length - span].time, lastTs: last.time,
      prevClose: previous?.close, prevVolume: previous?.volume,
      closedOpen: previous?.open, closedHigh: previous?.high, closedLow: previous?.low,
      barMs, now, preview: preferences.preview,
      forming: { high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 },
    });
    if (key !== candleKey || needsScan) {
      candleKey = key; needsScan = false;
      if (MARKERS_ENABLED) {
        const candles = raw.map(toCandle);
        const period = flowPeriodOf(timeframe);
        try {
          analysis = analyzeSignals(candles, barMs, preferences, period ? getFlow(symbol, period) : null, now);
          lastScanAt = now;
        } catch (e) {
          analysis = blankAnalysis();
          loadError = '标注计算暂不可用；图表与手动画线不受影响。';
          console.warn('[信号标注]', e);
        }
      } else {
        analysis = blankAnalysis(preferences.lookback);
      }
    }
    requestFlow();
    paint();
  }
  // 前缘触发节流：空闲后首次输入立即重算，突发输入至多每 300ms 一次（尾缘补跑）。
  // 旧实现是固定 1200ms 防抖，端到端延时 1.2–2.7s；连续跟踪场景应使用节流而非防抖。
  const THROTTLE_MS = 300;
  function schedule(immediate = false) {
    if (!alive) return;
    const now = Date.now();
    if (immediate || now - lastRunAt >= THROTTLE_MS) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      timer = setTimeout(run, 0);
    } else if (!timer) {
      timer = setTimeout(run, THROTTLE_MS - (now - lastRunAt));
    }
  }

  const offPreferences = store.subscribe(() => {
    const snapshot = store.getSnapshot();
    const next = snapshot.preferences;
    if (snapshot.focusId !== focusId) { focusId = snapshot.focusId; paint(); }
    if (next === preferences) return;
    const reanalyze = next.lookback !== preferences.lookback || next.preview !== preferences.preview;
    preferences = next;
    if (!preferences.enabled) stopFlow();
    if (reanalyze) { needsScan = true; flowInputKey = ''; analysis = blankAnalysis(preferences.lookback); }
    paint(); // All display toggles affect existing marks synchronously, without waiting for a tick.
    schedule(true);
  });
  const offBars = barsHub.subscribe(key => { if (key === marketKey) { lastInputAt = Date.now(); schedule(); } });
  const offFlow = subscribeFlow(snap => {
    if (!alive || !preferences.enabled || snap.instId !== symbol || snap.period !== flowPeriodOf(timeframe)) return;
    const nextFlowKey = flowRecomputeKey(snap, Date.now(), preferences.preview, preferences.lookback);
    if (nextFlowKey !== flowInputKey) { flowInputKey = nextFlowKey; needsScan = true; }
    schedule(); // Connection/coverage status can still refresh without re-running the detector.
  });
  // Also notices delayed chart construction and updated user-drawing obstacles.
  const heartbeat = setInterval(() => schedule(), 1500);
  lastInputAt = Date.now();
  attach(); schedule(true);
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
    clearInterval(heartbeat);
    offPreferences(); offBars(); offFlow(); chartOff.forEach(off => off());
    stopFlow();
    try { write(emptySignalPayload(), true); } catch { /* chart may already be destroyed */ }
    store.updateRuntime({ ...EMPTY_RUNTIME, counts: emptyCounts() });
  };
}
