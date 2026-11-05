import { db, initializeDatabase } from "@/db";
import { sql } from "drizzle-orm";
import { backtestRuns } from "@/db/schema";
import { getCandles } from "@/server/okx";
import { simulate, summarize, MAX_HOLD_5M, MAX_HOLD_15M } from "@/lib/engine";
import { SYMBOLS, type BacktestResult, type TradedSignal } from "@/lib/types";
import { clampThreshold, configFromCookie } from "@/quant/config";
import { closedCandles } from "@/lib/candles";
import { SCAN_BARS_ALLOWED, badRequest, parseBar, parseSymbol } from "@/lib/market";
import { setBounded } from "@/lib/lru";

export const dynamic = "force-dynamic";

const BT_CACHE_MAX = 24;
const BT_CACHE = new Map<string, { at: number; res: BacktestResult }>();
const btBars = (bar: string) => (bar === "15m" ? 4320 : 8640); // 15m ≈ 45 天，5m ≈ 30 天

async function persist(recs: TradedSignal[], bar: string) {
  const rows = recs.filter((s) => s.exitTs != null || s.status === "skipped");
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${r.id}, ${r.sym ?? ""}, ${bar}, ${r.ts}, ${r.side}, ${r.pattern},
           ${r.entry}, ${r.stop}, ${r.tp}, ${r.conf}, ${r.confl}, 'backtest',
           ${r.status === "skipped" ? "skipped" : (r.r ?? 0) > 0 ? "won" : "lost"},
           ${r.entryPrice ?? null}, ${r.exitPrice ?? null}, ${r.exitTs ?? null},
           ${r.r ?? null}, ${r.pnlPct ?? null}, ${r.holdingBars ?? null}, ${r.exitReason ?? null})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      insert into signals (
        id, symbol, bar, bar_ts, side, pattern, entry, stop, tp,
        confidence, confluence, origin, status,
        entry_price, exit_price, exit_ts, r_multiple, pnl_pct, holding_bars, exit_reason
      ) values ${values}
      on conflict (symbol, bar, bar_ts, pattern, side) do update set
        entry = excluded.entry, stop = excluded.stop, tp = excluded.tp,
        confidence = excluded.confidence, confluence = excluded.confluence,
        status = excluded.status, entry_price = excluded.entry_price,
        exit_price = excluded.exit_price, exit_ts = excluded.exit_ts,
        r_multiple = excluded.r_multiple, pnl_pct = excluded.pnl_pct,
        holding_bars = excluded.holding_bars, exit_reason = excluded.exit_reason
    `);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  // 白名单校验：旧实现把任意字符串透传给 OKX，失败后静默用合成行情继续回测并落库
  // （实测 FAKE-USDT-SWAP 会向 signals 写入 3 条假交易）。参数非法时直接 400。
  const symbol = parseSymbol(url.searchParams.get("symbol"), { allowAll: true, fallback: "BTC-USDT-SWAP" });
  const bar = parseBar(url.searchParams.get("bar"), SCAN_BARS_ALLOWED, { fallback: "5m" });
  if (!symbol) return badRequest(`unknown symbol: ${url.searchParams.get("symbol") ?? ""}`);
  if (!bar) return badRequest(`unsupported bar: ${url.searchParams.get("bar") ?? ""}`);
  const flow = url.searchParams.get("flow") === "on";
  const fresh = url.searchParams.get("fresh") === "1";

  // UI 的概率门槛 / 入场方式 / 是否替换结构过滤：query 优先，其次 cookie（由 setConfig 写入）。
  // 此前服务端只能拿到 DEFAULT_CONFIG，导致用户调参对回测完全无效。
  const fromCookie = configFromCookie(req.headers.get("cookie"));
  const qThreshold = url.searchParams.get("threshold");
  const qMode = url.searchParams.get("mode");
  const qReplace = url.searchParams.get("replaceConf");
  const engine = {
    threshold:
      qThreshold != null && qThreshold !== "" && Number.isFinite(Number(qThreshold))
        ? clampThreshold(Number(qThreshold))
        : fromCookie.threshold,
    entryMode: qMode === "touch" || qMode === "confirm" ? qMode : fromCookie.entryMode,
    replaceConfFilter: qReplace != null ? qReplace !== "0" : fromCookie.replaceConfFilter,
  };

  // 配置必须进入缓存键，否则不同门槛会共用同一份回测结果
  const key = `${symbol}|${bar}|${flow}|${engine.threshold ?? "def"}|${engine.entryMode ?? "def"}|${String(engine.replaceConfFilter)}`;
  if (!fresh) {
    const hit = BT_CACHE.get(key);
    if (hit && Date.now() - hit.at < 180_000) return Response.json(hit.res);
  }

  const opts = {
    flowFilter: flow,
    maxHold: bar === "15m" ? MAX_HOLD_15M : MAX_HOLD_5M,
    ...engine,
  };
  const symbols = symbol === "ALL" ? SYMBOLS.map((s) => s.id as string) : [symbol];

  // 逐个币种拉取，避免触发 OKX 历史 K 线限频导致数据缺口
  const loaded: Awaited<ReturnType<typeof getCandles>>[] = [];
  // 顺序拉取：getCandles 内部已有进程级限速与请求合并，这里并发只会放大 429 风险
  for (const s of symbols) {
    const loadedOne = await getCandles(s, bar, btBars(bar), fresh);
    // Keep chart/forming-candle data out of the closed-bar simulation and its
    // metadata (bars/from/to), so the response describes the same sample that
    // was actually traded.
    loaded.push({ ...loadedOne, candles: closedCandles(loadedOne.candles, bar) });
  }
  const recs: TradedSignal[] = [];
  let from = Infinity;
  let to = 0;
  let bars = 0;
  let live = true;
  let gapped = false;
  loaded.forEach(({ live: lv, gapped: gp, candles }, idx) => {
    live = live && lv;
    gapped = gapped || gp;
    bars += candles.length;
    if (candles.length) {
      from = Math.min(from, candles[0].ts);
      to = Math.max(to, candles[candles.length - 1].ts);
    }
    // 关键正确性门：合成行情或有缺口的数据不能生成交易统计。
    // 否则“gapped=true”虽回显给调用方，结果仍按一条连续时间轴回测，错误 R/胜率会被用户当真。
    if (lv && !gp) recs.push(...simulate(candles, symbols[idx], bar, opts));
  });
  const dataReady = live && !gapped;
  // ALL 多标的只要有一份样本不完整，整组统计都不可比；不能静默保留其它币种的部分结果。
  if (!dataReady) recs.length = 0;

  const res = summarize(recs, {
    symbol,
    bar,
    from: Number.isFinite(from) ? from : 0,
    to,
    bars,
    scope: symbol === "ALL" ? "all" : "single",
    opts,
    symbols,
  });
  res.live = live;
  // 回显本次实际生效的引擎配置，便于核对 UI 与回测是否同口径
  (res as BacktestResult & { engine?: unknown }).engine = {
    threshold: engine.threshold ?? null,
    entryMode: engine.entryMode ?? null,
    replaceConfFilter: engine.replaceConfFilter ?? null,
  };
  (res as BacktestResult & { gapped?: boolean; dataReady?: boolean; dataIssue?: string }).gapped = gapped;
  (res as BacktestResult & { dataReady?: boolean; dataIssue?: string }).dataReady = dataReady;
  (res as BacktestResult & { dataIssue?: string }).dataIssue = dataReady
    ? undefined
    : gapped
      ? "行情数据不完整（缺根或未取满），已跳过回测统计；请稍后刷新。"
      : "当前为仿真/非实时行情，已跳过回测统计。";

  // 只有真实、且连续（无缺口）的行情才允许落库：
  // 旧实现不检查 live，OKX 不可达时把合成行情的交易永久写进 signals（且无法区分来源）。
  // 持久化失败仍不影响返回。
  if (live && !gapped) {
    try {
      await initializeDatabase();
      await persist(recs, bar);
      await db
        .insert(backtestRuns)
        .values({
          id: `${symbol}_${bar}_${Date.now()}`,
          symbol,
          bar,
          barCount: bars,
          fromTs: res.from,
          toTs: res.to,
          liveSource: live,
          flowFilter: flow,
          signals: res.overall.signals,
          executed: res.overall.executed,
          winRate: res.overall.winRate,
          totalR: res.overall.totalR,
        })
        .onConflictDoNothing();
    } catch (e) {
      console.warn("persist failed:", e);
    }
  }

  // 不缓存失败/不完整数据：上游恢复后下一次请求必须立即重试，而不是被 180s 旧结果挡住。
  if (dataReady) setBounded(BT_CACHE, key, { at: Date.now(), res }, BT_CACHE_MAX);
  return Response.json(res);
}
