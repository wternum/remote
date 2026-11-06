import type { Vela, WidgetContext } from '@luxalgo/vela';
import type { Candle } from '@/lib/types';
import { flowPeriodOf, getFlow, releaseTape, subscribeFlow, syncFlow } from '@/quant/flow';
import { ANNOT_OVER, ANNOT_UNDER } from '../annotLayer';
import type { AnnPayload, AnnObstacle } from '../annotTypes';
import { barsHub, tfMs } from '../okxProvider';
import { analyzeSignals, projectSignals, type SignalAnalysis } from './analyze';
import { signalRecomputeKey, flowRecomputeKey } from './recompute';
import { EMPTY_RUNTIME, flowRequested, emptyCounts, emptySignalPayload, type SignalStore } from './store';

type ChartPort = { rendererPort?: { setNativeData?: (id: string, payload: AnnPayload) => void } };
const blankAnalysis = (requested = 600): SignalAnalysis => ({ items: [], covered: 0, bars: 0, requested, gapTruncated: false, historyShort: false, lastPrice: 0 });

/**
 * 图表标记已整体下线：画布不再接收 payload，侧栏也只显示行情行与开关。
 * 此时 analyzeSignals + projectSignals 的产物没有任何消费者，实测 1500 根约
 * 11.85ms/次（心跳口径 ~0.8%、节流上限 ~4% 单核持续空转），因此跳过整段计算。
 * 恢复标记时把此开关改回 true 即可，检测/排版模块与单测均原样保留。
 *
 * 注意：订单流同步（requestFlow）不受此开关影响——浏览器端入场确认引擎
 * 通过 src/api/engine.ts 的 getFlow() 读取这份缓存，停掉会连带削弱该面板。
 */
const MARKERS_ENABLED = false;

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
  const paint = () => {
    const projected = MARKERS_ENABLED
      ? projectSignals(analysis, preferences, focusId)
      : { payload: emptySignalPayload(), visible: [], counts: emptyCounts() };
    // 标记下线期间恒下发空 payload；write() 内部按指纹去重，只有首次真正触达图层。
    if (MARKERS_ENABLED && preferences.enabled) projected.payload.obstacles = obstacles();
    write(projected.payload);
    const period = flowPeriodOf(timeframe);
    const snap = period ? getFlow(symbol, period) : undefined;
    store.updateRuntime({
      symbol, timeframe,
      status: !preferences.enabled ? 'paused' : loadError ? 'error' : loading ? 'loading' : 'ready',
      message: loadError,
      bars: analysis.bars, requested: analysis.requested, gapTruncated: analysis.gapTruncated, historyShort: analysis.historyShort, covered: analysis.covered,
      flowSupported: !!period, flowConnected: !!snap?.tape.connected,
      flowSyncing: flowBusy, updatedAt: lastScanAt,
      counts: projected.counts, visible: projected.visible, total: projected.visible.length,
    });
  };
  const stopFlow = () => {
    flowEpoch++;
    flowController?.abort();
    flowController = null;
    const old = flowMarket.split('|')[0];
    flowMarket = '';
    flowBusy = false;
    if (old) releaseTape(old);
  };
  const wantsFlow = () => flowRequested(preferences) && !!flowPeriodOf(timeframe);
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
    // An aborted prior request may still be draining from the module's inflight cache.
    // On completion a new current-market tick retries if bootstrap was not completed.
    // First sync backfills enough official per-bar taker data to cover the
    // annotation lookback (100 bars/page); afterwards only the newest page.
    // 用 rubikComplete 而非 complete：tape bootstrap 完成不代表官方统计已回填，
    // 否则首次 rubik 失败后历史真实数据永远不再重试。
    const backfilled = !!getFlow(symbol, period)?.rubikComplete;
    const pages = backfilled ? 1 : Math.min(14, Math.ceil(preferences.lookback / 100) + 1);
    void syncFlow(symbol, period, { minTs: 0, maxPages: pages, oiPages: backfilled ? 1 : 2, bootstrapBars: period === '5m' ? 12 : 6, bootstrapPages: 300, signal: controller.signal }).finally(() => {
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
    if (!preferences.enabled) { if (flowMarket) stopFlow(); paint(); return; }
    const raw = barsHub.get(symbol, timeframe);
    if (!raw.length) {
      if (Date.now() - lastInputAt > 20_000) loadError = '等待行情数据，请检查 OKX 网络连接。';
      paint(); return;
    }
    loading = false; loadError = '';
    const last = raw.at(-1)!;
    const barMs = tfMs(timeframe);
    const previous = last.time + barMs <= Date.now() ? last : raw.at(-2);
    // 键只由「已收盘状态」驱动：未勾选预览时，形成中那根的价格跳动不触发重算
    // （实测单次全量分析约 18ms/1000 根，按 tick 触发等于白烧 CPU，输出还完全一样）。
    const key = signalRecomputeKey({
      marketKey, length: raw.length, firstTs: raw[0].time, lastTs: last.time,
      prevClose: previous?.close, prevVolume: previous?.volume,
      closedOpen: previous?.open, closedHigh: previous?.high, closedLow: previous?.low,
      barMs, now: Date.now(), preview: preferences.preview,
      forming: { high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 },
    });
    if (key !== candleKey || needsScan) {
      candleKey = key; needsScan = false;
      if (MARKERS_ENABLED) {
        const candles: Candle[] = raw.map(b => ({ ts: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 }));
        const period = flowPeriodOf(timeframe);
        try {
          analysis = analyzeSignals(candles, barMs, preferences, period ? getFlow(symbol, period) : null);
          lastScanAt = Date.now();
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
