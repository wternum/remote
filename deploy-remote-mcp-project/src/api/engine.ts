import { getCandles } from '@/server/okx';
import { SYMBOLS } from '@/lib/types';
import { runScan, SCAN_BARS, liveFlowOf, EXIT_PLANS, type Candidate, type ExitPlan } from '@/quant/scan';
import { FACTORS, MODEL } from '@/quant/model';
import { configFromCookie, getConfig } from '@/quant/config';
import { closedCandles } from '@/lib/candles';
import { syncFlow, type FlowSnapshot } from '@/quant/flow';
import { SCAN_BARS_ALLOWED, badRequest, parseBar, parseSymbol } from '@/lib/market';
import { setBounded } from '@/lib/lru';

export const dynamic = 'force-dynamic';

const TTL = 45_000;
const CAP = 320;
// 上限防止任意 symbol / bar 组合把结果缓存无限撑大（每个 ALL×ALL 结果约 600KB）
const CACHE_MAX = 12;
const CACHE = new Map<string, { at: number; res: unknown }>();

const bookImbalance = (bids: { s: number }[], asks: { s: number }[]) => {
  const sb = bids.reduce((s, l) => s + l.s, 0);
  const sa = asks.reduce((s, l) => s + l.s, 0);
  return sb + sa > 0 ? (sb - sa) / (sb + sa) : 0;
};

/** parts 可由 evidence × weight × gain 还原，出网时省略以控制体积 */
function wire(c: Candidate) {
  return {
    id: c.id,
    idx: c.idx,
    ts: c.ts,
    side: c.side,
    pattern: c.pattern,
    mode: c.mode,
    level: c.level,
    neck: c.neck,
    firstTs: c.firstTs,
    secondTs: c.secondTs,
    entry: c.entry,
    stop: c.stop,
    tp: c.tp,
    structure: c.structure,
    proba: c.proba,
    grade: c.grade,
    evidence: c.evidence,
    tags: c.tags,
    note: c.note,
    rr: c.rr,
    heightAtr: c.heightAtr,
    spanBars: c.spanBars,
    live: c.live,
    sym: c.sym,
    bar: c.bar,
    // Small, useful provenance fields must survive the wire format; otherwise
    // the API silently turns a real/taker candidate into an anonymous score.
    trap: c.trap,
    trapScore: c.trapScore,
    flowSource: c.flowSource,
    headline: c.headline,
    outcome: c.outcome,
    exits: c.exits,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = parseSymbol(url.searchParams.get('symbol'), { allowAll: true, fallback: 'BTC-USDT-SWAP' });
  const bar = parseBar(url.searchParams.get('bar'), SCAN_BARS_ALLOWED, { allowAll: true, fallback: '5m' });
  if (!symbol) return badRequest(`unknown symbol: ${url.searchParams.get('symbol') ?? ''}`);
  if (!bar) return badRequest(`unsupported bar: ${url.searchParams.get('bar') ?? ''}`);
  const fresh = url.searchParams.get('fresh') === '1';
  const exitParam = (url.searchParams.get('exit') ?? 'neck') as ExitPlan;
  const plan: ExitPlan = ['neck', 'r15', 'r10', 'be', 'partial'].includes(exitParam) ? exitParam : 'neck';
  const key = `${symbol}|${bar}|${plan}`;
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return Response.json(hit.res);

  const list = symbol === 'ALL' ? SYMBOLS.map(s => s.id as string) : [symbol];
  const timeframes = bar === 'ALL' ? ['5m', '15m'] : [bar];
  const confirmRows: ReturnType<typeof runScan>['confirm'] = [];
  const touchRows: ReturnType<typeof runScan>['touch'] = [];
  let allLive = true;
  let gapped = false;
  let dataReady = true;
  let bars = 0;
  let from = Infinity;
  let to = 0;
  let lastTs = 0;
  let flow: ReturnType<typeof liveFlowOf> | undefined;
  const prepared: Array<{
    s: string;
    tf: string;
    candles: ReturnType<typeof closedCandles>;
    flowPromise: Promise<FlowSnapshot | null>;
  }> = [];

  // 逐币种 / 逐周期拉取 K 线（共享 candles 限速闸门），同时把独立配额的盘口与 rubik 订单流重叠在后台并发拉取
  for (const tf of timeframes) {
    for (const s of list) {
      const { live, gapped: tfGapped, candles: rawCandles } = await getCandles(s, tf, SCAN_BARS(tf));
      gapped = gapped || tfGapped;
      // getCandles also serves the chart and therefore includes OKX's forming
      // candle.  The confirmation engine is strictly closed-bar only.
      const candles = closedCandles(rawCandles, tf);
      allLive = allLive && live;
      if (!live || tfGapped) dataReady = false;
      bars += candles.length;
      if (candles.length) {
        from = Math.min(from, candles[0].ts);
        to = Math.max(to, candles[candles.length - 1].ts);
        lastTs = Math.max(lastTs, candles[candles.length - 1].ts);
      }
      flow = undefined;
      if (!live || tfGapped || !candles.length) continue;

      // 每个币种 / 周期都按同样深度同步自己的 rubik 统计（浏览器经 /api/okx 代理）。
      // 旧实现在浏览器里只读 getFlow()：只有「当前图表那个市场」有真实成交，
      // ALL 扫描时同一形态的概率会因用户正在看哪张图而不同。
      const flowPromise: Promise<FlowSnapshot | null> = syncFlow(s, tf, {
        minTs: candles[0]?.ts ?? 0,
        maxPages: 4,
        oiPages: 2,
        tape: false,
      }).catch(() => null);
      prepared.push({ s, tf, candles, flowPromise });
    }
  }

  // ALL×ALL 必须整组同口径：任何一个币种/周期数据不可用，就不返回其它子集的偏置统计。
  if (dataReady) {
    const results = await Promise.all(
      prepared.map(async ({ s, tf, candles, flowPromise }) => {
        const flowSnapshot = await flowPromise;
        // A request-time book snapshot is NOT bar-time evidence for a closed signal.
        const pairFlow = liveFlowOf(candles, null, null);
        const scan = runScan(candles, tf, pairFlow, s, plan, flowSnapshot);
        return { pairFlow, scan };
      }),
    );
    for (const { pairFlow, scan } of results) {
      flow = pairFlow;
      confirmRows.push(...scan.confirm);
      touchRows.push(...scan.touch);
    }
  } else {
    confirmRows.length = 0;
    touchRows.length = 0;
    flow = undefined;
  }
  const byTs = (a: { ts: number }, b: { ts: number }) => a.ts - b.ts;
  confirmRows.sort(byTs);
  touchRows.sort(byTs);
  // 服务端读不到 localStorage：此前这里永远返回 DEFAULT_CONFIG，面板显示的
  // 「当前配置」与用户实际设置不一致。改为优先读与 UI 同步的 cookie。
  const cfg = { ...getConfig(), ...configFromCookie(req.headers.get('cookie')) };
  const primary = timeframes[timeframes.length - 1];
  const res = {
    symbol,
    bar,
    symbols: list,
    timeframes,
    live: allLive,
    // 只有全部样本都是真实且连续时，才允许解读候选统计。
    dataReady: dataReady && allLive && !gapped,
    dataIssue: !dataReady ? (gapped ? '行情数据不完整（缺根或未取满），已跳过扫描；请稍后刷新。' : '当前为仿真/非实时行情，已跳过扫描。') : undefined,
    // 上游 K 线不连续时显式标记，避免把缺口行情当成真实样本做统计
    gapped,
    from: Number.isFinite(from) ? from : 0,
    to,
    lastTs,
    bars,
    barMs: primary === '15m' ? 900_000 : 300_000,
    maxHold: primary === '15m' ? 48 : 96,
    generatedAt: Date.now(),
    factors: FACTORS.map(f => ({
      key: f.key,
      label: f.label,
      short: f.short,
      hint: f.hint,
      group: f.group,
      weight: f.weight,
      liveOnly: !!f.liveOnly,
    })),
    model: MODEL,
    executionProtocol: { confirm: 'next-bar-open-market', touch: 'limit-at-key-within-signal-bar', score: 'uncalibrated-logistic-map' },
    config: cfg,
    exitPlan: plan,
    exitPlans: EXIT_PLANS,
    flow,
    confirm: confirmRows.slice(-CAP).map(wire),
    touch: touchRows.slice(-CAP).map(wire),
  };
  // 不缓存退化结果：上游恢复后下一次扫描必须重新取数。
  if ((res as { dataReady?: boolean }).dataReady) setBounded(CACHE, key, { at: Date.now(), res }, CACHE_MAX);
  return Response.json(res);
}
