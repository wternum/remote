import { Candle, BookLevel } from "@/lib/types";
import { barMs, ctValOf } from "@/lib/types";
import { quoteVolumeFromRow } from "@/lib/okxVolume";

const BASE = "https://www.okx.com";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── 全局限速闸门 ─────────────────────────────────────────
// OKX 公共行情按 IP 限频（history-candles 约 20 次 / 2 秒）。原实现对每页历史
// 并发 8 个请求、且各调用方互不知情：3 币种冷启动实测 703 次请求里 516 次被
// 429，失败页被 `catch(() => [])` 吞掉后留下 1200–2800 根缺口。这里用进程级
// 串行闸门统一节流（≈9 req/s），让并发调用方排队而不是互相打限频。
function makeGate(gapMs: number) {
  let chain: Promise<void> = Promise.resolve();
  return (): Promise<void> => {
    const next = chain.then(() => sleep(gapMs));
    // 闸门自身不能因为某次请求失败而中断后续排队
    chain = next.catch(() => undefined);
    return next;
  };
}
// OKX /market/candles 配额 40 次/2s，/market/history-candles 配额 20 次/2s；
// 分离闸门避免 tail 补拉或 /api/data 被 8640 根历史回填阻塞。
const candlesGate = makeGate(55);
const historyGate = makeGate(105);

class OkxError extends Error {
  constructor(
    message: string,
    /** 4xx（除 429）是确定性失败，重试无意义 */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "OkxError";
  }
}

// ─── 基础请求 ─────────────────────────────────────────────
async function okxGet(path: string, params: Record<string, string>, timeoutMs = 5000) {
  if (path.includes("history-candles")) await historyGate();
  else if (path.includes("candles")) await candlesGate();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: ctl.signal });
    if (!res.ok) throw new OkxError("HTTP " + res.status, res.status === 429 || res.status >= 500);
    const json = (await res.json()) as { code?: string; data?: unknown };
    if (json.code && json.code !== "0") throw new OkxError("OKX code " + json.code);
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

// 带重试的公共行情请求（应对限频；确定性失败立即放弃）
async function okxGetRetry(
  path: string,
  params: Record<string, string>,
  tries = 3,
): Promise<(string | number)[][]> {
  let lastErr: unknown = null;
  for (let t = 0; t < tries; t++) {
    try {
      const d = await okxGet(path, params, 8000);
      return (d as (string | number)[][]) ?? [];
    } catch (e) {
      lastErr = e;
      if (e instanceof OkxError && !e.retryable) break;
      if (t < tries - 1) await sleep(300 * (t + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OKX request failed");
}

// 防御性解析：官方格式 [ts,o,h,l,c,vol,volCcy,volCcyQuote,(confirm)]
function parseCandleRow(row: (string | number)[], symbol: string): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const ts = Number(row[0]);
  const o = Number(row[1]);
  const h = Number(row[2]);
  const l = Number(row[3]);
  const c = Number(row[4]);
  if (![ts, o, h, l, c].every(Number.isFinite)) return null;
  if (!(h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9)) return null;
  return { ts, o, h, l, c, v: quoteVolumeFromRow(row, symbol) };
}

// ─── 实时拉取 ─────────────────────────────────────────────
export interface HistoryResult {
  candles: Candle[];
  /** 相邻 K 线之间的缺失根数（>0 表示数据不连续，不可当作真实行情缓存/落库） */
  missingBars: number;
  /** OKX 该合约上市较晚、历史本来就不到请求根数（与缺口区分） */
  short: boolean;
}

/**
 * 拉取 `count` 根历史 K 线，并显式报告缺口。
 *
 * 旧实现把失败页 `catch(() => [])` 后照常返回，调用方无法区分“真实连续行情”
 * 与“缺了几千根的行情”。现在：失败页会重试一轮，最终仍失败时通过 missingBars
 * 上报，由上层决定是否缓存 / 落库。
 */
export async function fetchCandlesWithMeta(
  symbol: string,
  bar: string,
  count: number,
): Promise<HistoryResult> {
  const want = Math.max(1, Math.min(count, 12_000));
  const bm = barMs(bar);
  const map = new Map<number, Candle>();
  const add = (rows: (string | number)[][] | undefined) => {
    for (const r of rows ?? []) {
      const c = parseCandleRow(r, symbol);
      if (c) map.set(c.ts, c);
    }
  };

  const first = await okxGetRetry("/api/v5/market/candles", {
    instId: symbol,
    bar,
    limit: String(Math.min(300, want)),
  });
  add(first);
  if (map.size === 0) throw new OkxError("empty candles", false);

  if (map.size < want) {
    const oldest = Math.min(...map.keys());
    let step = 100;
    let startK = 0;
    const failed: number[] = [];
    if (want > 1200) {
      try {
        const probe = await okxGetRetry("/api/v5/market/history-candles", {
          instId: symbol,
          bar,
          after: String(oldest),
          limit: "300",
        });
        add(probe);
        if (probe.length >= 200) step = 300;
        startK = 1;
      } catch {
        // 探测失败时退回 100 根步长，由下方重试逻辑兜底
      }
    }
    if (map.size < want) {
      const remPages = Math.ceil((want - map.size) / step);
      const limitStr = String(step);
      const loadPage = async (k: number) => {
        // 第 k 页取「紧邻上一页最老一根之前」的 step 根：after 必须从 0 偏移开始，
        // 多跳一页会在首页与历史页之间留下缺口（旧实现用的是 (k + 1) 偏移）。
        const rows = await okxGetRetry("/api/v5/market/history-candles", {
          instId: symbol,
          bar,
          after: String(oldest - k * step * bm),
          limit: limitStr,
        });
        add(rows);
      };
      // 闸门已经保证全局限频，并行只是为了让排队更紧凑；
      // 失败页收集起来做一轮针对性重试（旧实现直接吞掉 → 直接产生缺口）。
      await Promise.all(
        Array.from({ length: remPages }, (_, idx) => {
          const k = startK + idx;
          return loadPage(k).catch(() => {
            failed.push(k);
          });
        }),
      );
      if (failed.length) {
        await Promise.all(
          [...new Set(failed)].map((k) =>
            loadPage(k).catch(() => {
              /* 仍失败则由 missingBars 如实上报 */
            }),
          ),
        );
      }
    }
    // 深拉场景下若因少量历史缺根差几根未满 want，补拉最多 2 页避免误判 short
    if (want > 1200 && map.size < want && map.size >= want - 600 && failed.length === 0) {
      for (let extra = 0; extra < 2 && map.size < want; extra++) {
        const curOldest = Math.min(...map.keys());
        const rows = await okxGetRetry("/api/v5/market/history-candles", {
          instId: symbol,
          bar,
          after: String(curOldest),
          limit: String(step),
        }).catch(() => [] as (string | number)[][]);
        const before = map.size;
        add(rows);
        if (map.size === before) break;
      }
    }
  }

  const sorted = [...map.values()].sort((a, b) => a.ts - b.ts);
  const candles = sorted.slice(-want);
  let missingBars = 0;
  for (let i = 1; i < candles.length; i++) {
    const step = Math.round((candles[i].ts - candles[i - 1].ts) / bm);
    if (step > 1) missingBars += step - 1;
  }
  return { candles, missingBars, short: candles.length < want };
}

/** 兼容旧签名：只要 K 线本身（缺口信息由 getCandles 负责） */
export async function fetchCandlesLive(
  symbol: string,
  bar: string,
  count: number,
): Promise<Candle[]> {
  const { candles } = await fetchCandlesWithMeta(symbol, bar, count);
  return candles;
}

// 轻量轮询专用微缓存：多标签页同时 tail 轮询时只打一次上游
const TAIL_TTL = 1500;
const tailCache = new Map<string, { at: number; candles: Candle[] }>();
const tailInflight = new Map<string, Promise<Candle[]>>();

export async function fetchCandlesTail(symbol: string, bar: string, count = 3): Promise<Candle[]> {
  const key = `${symbol}|${bar}|${count}`;
  const hit = tailCache.get(key);
  if (hit && Date.now() - hit.at < TAIL_TTL) return hit.candles;
  const running = tailInflight.get(key);
  if (running) return running;
  const job = fetchCandlesLive(symbol, bar, count)
    .then((candles) => {
      tailCache.delete(key);
      tailCache.set(key, { at: Date.now(), candles });
      while (tailCache.size > 12) {
        const oldest = tailCache.keys().next().value;
        if (oldest === undefined) break;
        tailCache.delete(oldest);
      }
      return candles;
    })
    .finally(() => {
      if (tailInflight.get(key) === job) tailInflight.delete(key);
    });
  tailInflight.set(key, job);
  return job;
}

export async function fetchTickerLive(symbol: string) {
  const data = (await okxGet("/api/v5/market/ticker", { instId: symbol })) as Record<
    string,
    string
  >[];
  const t = data?.[0];
  if (!t) throw new Error("empty ticker");
  const last = Number(t.last);
  const open24 = Number(t.open24h);
  return {
    last,
    open24,
    high24: Number(t.high24h),
    low24: Number(t.low24h),
    chg24: open24 > 0 ? ((last - open24) / open24) * 100 : 0,
    // 永续：volCcy24h 为 24h 成交的币数量（张数×面值），× 最新价 ≈ USDT 成交额
    vol24Quote: t.volCcy24h ? Number(t.volCcy24h) * last : undefined,
  };
}

export async function fetchFundingLive(symbol: string) {
  const data = (await okxGet("/api/v5/public/funding-rate", { instId: symbol })) as Record<string, string>[];
  const d = data?.[0];
  if (!d) return { fundingRate: undefined, nextFundingTime: undefined };
  return { fundingRate: Number(d.fundingRate), nextFundingTime: Number(d.nextFundingTime) };
}

const META_TTL = 3_600_000;
const metaCache = new Map<string, { at: number; val: { ctVal?: number; tickSz?: number } }>();
const metaInflight = new Map<string, Promise<{ ctVal?: number; tickSz?: number }>>();

export async function fetchInstrumentMeta(symbol: string) {
  const hit = metaCache.get(symbol);
  if (hit && Date.now() - hit.at < META_TTL) return hit.val;
  const running = metaInflight.get(symbol);
  if (running) return running;
  const job = (async () => {
    const data = (await okxGet("/api/v5/public/instruments", { instType: "SWAP", instId: symbol })) as Record<string, string>[];
    const d = data?.[0];
    const val = d ? { ctVal: Number(d.ctVal), tickSz: Number(d.tickSz) } : { ctVal: undefined, tickSz: undefined };
    metaCache.set(symbol, { at: Date.now(), val });
    return val;
  })().finally(() => {
    if (metaInflight.get(symbol) === job) metaInflight.delete(symbol);
  });
  metaInflight.set(symbol, job);
  return job;
}

export async function fetchBookLive(symbol: string, levels = 10): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  const data = (await okxGet("/api/v5/market/books", { instId: symbol, sz: String(levels) })) as {
    asks: (string | number)[][];
    bids: (string | number)[][];
  };
  const mapLv = (a: (string | number)[]) => ({ p: Number(a[0]), s: Number(a[1]) });
  return {
    bids: (data.bids ?? []).map(mapLv),
    asks: (data.asks ?? []).map(mapLv),
  };
}

// ─── 仿真数据（OKX 不可达时的降级源）──────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 键为永续合约 ID；volUnit 为"张数"
const SYNTH_BASE: Record<string, { price: number; vol: number; volUnit: number }> = {
  "BTC-USDT-SWAP": { price: 97400, vol: 0.0011, volUnit: 9200 },
  "ETH-USDT-SWAP": { price: 3625, vol: 0.0016, volUnit: 26000 },
  "SOL-USDT-SWAP": { price: 214, vol: 0.0022, volUnit: 9000 },
};

export function synthCandles(symbol: string, bar: string, count: number, endTs?: number): Candle[] {
  const cfg = SYNTH_BASE[symbol] ?? { price: 100, vol: 0.002, volUnit: 1000 };
  const bm = barMs(bar);
  const dayKey = Math.floor((endTs ?? Date.now()) / 86400000);
  const rng = mulberry32(hashStr(`${symbol}|${bar}|${dayKey}`));
  const lastStart = Math.floor((endTs ?? Date.now()) / bm) * bm - bm;
  const start = lastStart - (count - 1) * bm;

  const out: Candle[] = [];
  let price = cfg.price * (0.97 + rng() * 0.06);
  let regime = 0;
  for (let i = 0; i < count; i++) {
    regime = regime * 0.982 + (rng() - 0.5) * 0.09;
    if (rng() < 0.012) regime += (rng() - 0.5) * 0.9; // 偶发行情
    const vScale = 1 + 1.6 * Math.abs(regime) + (rng() < 0.06 ? rng() * 2.4 : 0);
    // 趋势项必须按波动率缩放：旧实现 regime * 0.16 每根带约 2% 的持续漂移，
    // 600 根后价格比可达 1e8、8640 根达 1e28（实测），降级行情完全不可用。
    // 这里保留可识别的趋势段，同时用很弱的对数回归把价格限制在基准附近。
    const pull = -0.0015 * Math.log(price / cfg.price);
    const ret = regime * cfg.vol * 1.6 + pull + (rng() + rng() - 1) * cfg.vol * vScale;
    const o = price * (rng() < 0.02 ? 1 + (rng() - 0.5) * cfg.vol * 6 : 1);
    // 4 步子路径
    let p = o;
    let hi = o;
    let lo = o;
    let pc = o;
    for (let s = 0; s < 4; s++) {
      pc = p * (1 + ret / 4 + (rng() - 0.5) * cfg.vol * 0.55 * vScale);
      p = pc;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    const c = p;
    hi = Math.max(hi, o, c) * (1 + rng() * cfg.vol * 0.5 * vScale);
    lo = Math.min(lo, o, c) * (1 - rng() * cfg.vol * 0.5 * vScale);
    const bodyPct = Math.abs(c - o) / o;
    // 仿真成交量按"张"生成，再折算为 USDT 成交额，保持与真实数据同口径
    // 张数 × 面值 = 币数，× 价格 = USDT 成交额（旧实现漏乘面值：BTC 偏大 100 倍、ETH 10 倍）
    const v = cfg.volUnit * ctValOf(symbol) * (0.45 + rng() * 0.8) * (1 + bodyPct / cfg.vol / 2.2) * c;
    out.push({ ts: start + i * bm, o, h: hi, l: lo, c, v });
    price = c;
  }
  return out;
}

export function synthTicker(candles: Candle[], bar = "5m") {
  const last = candles[candles.length - 1];
  // 24h 窗口必须按周期换算：288 根只对 5m 成立，15m 会算成 3 天、1m 会算成 4.8 小时。
  const bars24h = Math.max(1, Math.round(86_400_000 / barMs(bar)));
  const open24 = candles[Math.max(0, candles.length - 1 - bars24h)]?.c ?? last.o;
  const highs = candles.slice(-bars24h).map((c) => c.h);
  const lows = candles.slice(-bars24h).map((c) => c.l);
  return {
    last: last.c,
    open24,
    high24: Math.max(...highs),
    low24: Math.min(...lows),
    chg24: ((last.c - open24) / open24) * 100,
  };
}

export function synthBook(last: number, seedExtra = 0): { bids: BookLevel[]; asks: BookLevel[] } {
  const rng = mulberry32(hashStr("book" + seedExtra));
  const step = last * 0.00018;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 1; i <= 10; i++) {
    bids.push({ p: last - step * i, s: 0.4 + rng() * 2.2 });
    asks.push({ p: last + step * i, s: 0.4 + rng() * 2.2 });
  }
  return { bids, asks };
}

// ─── 带缓存的统一入口 ─────────────────────────────────────
export interface CandleSet {
  live: boolean;
  /** 上游返回的 K 线不连续（缺口）；不得当作真实行情落库或长期缓存 */
  gapped: boolean;
  candles: Candle[];
}

interface CacheEntry {
  at: number;
  live: boolean;
  gapped: boolean;
  data: Candle[];
  /** 这次拉取"请求"的根数。数据没取满（限频/上游拒绝）时 data.length < want，
   *  命中判断必须看 want，否则失败结果永远不命中缓存 → 每次请求都整段重拉。 */
  want: number;
  /** 最近一次拿到"最新一根"的时间。拉取时最新一根还在形成，只有部分成交量。 */
  tailAt: number;
  /** 最近一次尝试补拉尾部的时间（防止刚换根上游尚未生成时连续重复请求） */
  tailAttemptAt: number;
}

// 缓存键去掉 count：一次深拉（回测 8640 根）即可服务图表 600 根、引擎面板更深的请求，
// 避免同一 symbol|bar 被不同 count 反复整段拉取。
// 容量上限防止任意 symbol 参数把进程内存撑爆（实测无上限时 60 次请求 +171MB）。
const CACHE_MAX = 12;
const TTL_LIVE = 120_000;
const TTL_DEGRADED = 15_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, { promise: Promise<CandleSet>; count: number }>();

const tailRefresh = new Map<string, Promise<boolean>>();

/** 两份 K 线按时间戳合并，同一根取成交额更大者（一根 K 线内成交额只增不减）。 */
function mergeByTs(base: Candle[], incoming: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of base) map.set(c.ts, c);
  for (const c of incoming) {
    const prev = map.get(c.ts);
    map.set(c.ts, !prev || c.v >= prev.v ? c : prev);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function holesOf(cs: Candle[], bm: number): number {
  let n = 0;
  for (let i = 1; i < cs.length; i++) {
    const step = Math.round((cs[i].ts - cs[i - 1].ts) / bm);
    if (step > 1) n += step - 1;
  }
  return n;
}

/**
 * 缓存拉取时，最新一根还在形成、只有部分成交量。这根收盘后，缓存（TTL 120s）
 * 仍会把残缺数据当成"已收盘 K 线"交给回测和引擎（实测只有完整量的 67%）。
 * 这里只补拉最新 300 根（1 次请求，同 key 并发合并），替换掉残缺的那根。
 * 返回 false 表示补拉失败，调用方必须整段重拉，不能继续用残缺缓存。
 */
function refreshTail(key: string, entry: CacheEntry, symbol: string, bar: string): Promise<boolean> {
  const running = tailRefresh.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const rows = await okxGetRetry("/api/v5/market/candles", { instId: symbol, bar, limit: "300" });
      const fresh: Candle[] = [];
      for (const r of rows) {
        const c = parseCandleRow(r, symbol);
        if (c) fresh.push(c);
      }
      if (!fresh.length) return false;
      const bm = barMs(bar);
      const merged = mergeByTs(entry.data, fresh).slice(-Math.max(entry.data.length, 1));
      // 补拉窗口必须和缓存首尾相接；接不上（离线太久）就放弃，交给整段重拉
      if (holesOf(merged, bm) > holesOf(entry.data, bm)) return false;
      entry.data = merged;
      const now = Date.now();
      entry.tailAt = now;
      entry.tailAttemptAt = now;
      return true;
    } catch {
      entry.tailAttemptAt = Date.now();
      return false;
    }
  })().finally(() => {
    if (tailRefresh.get(key) === job) tailRefresh.delete(key);
  });
  tailRefresh.set(key, job);
  return job;
}

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function getCandles(
  symbol: string,
  bar: string,
  count: number,
  fresh = false,
): Promise<CandleSet> {
  const key = `${symbol}|${bar}`;

  if (!fresh) {
    const hit = cache.get(key);
    // 命中条件：这份结果当初就是为 >= count 的请求拉的（即使没取满），
    // 短结果交给较短的 TTL_DEGRADED 冷却，期间不再打上游（实测限频时一次请求 37 次上游调用，
    // 修复前连续 3 次请求各重拉一遍）。
    if (hit && (hit.data.length >= count || hit.want >= count)) {
      const ttl = hit.live && !hit.gapped ? TTL_LIVE : TTL_DEGRADED;
      if (Date.now() - hit.at < ttl) {
        const last = hit.data[hit.data.length - 1];
        const bm = barMs(bar);
        const now = Date.now();
        const needsTail = hit.live && !!last && last.ts + bm <= now && now - hit.tailAttemptAt >= 2_000;
        // 合成数据没有"残缺最新一根"的问题，只处理真实行情
        const usable = !needsTail || (await refreshTail(key, hit, symbol, bar));
        if (usable) return { live: hit.live, gapped: hit.gapped, candles: hit.data.slice(-count) };
      }
    }
    // 冷启动时回测 / 引擎面板 / 图表常常同时请求同一份数据：
    // 旧实现各拉一遍（实测 437 次上游请求，267 次 429），这里同 key 共用一次拉取。
    const pending = inflight.get(key);
    if (pending && pending.count >= count) {
      const r = await pending.promise;
      return { live: r.live, gapped: r.gapped, candles: r.candles.slice(-count) };
    }
  }

  const job = (async (): Promise<CandleSet> => {
    try {
      const { candles, missingBars, short } = await fetchCandlesWithMeta(symbol, bar, count);
      if (candles.length < Math.min(count, 200)) throw new Error("insufficient live data");
      // 三种不完整必须区分对待，且都不能当成"完整真实行情"：
      //  missingBars > 0 —— 返回窗口内部有洞（历史页被限频/失败）
      //  short           —— 根本没取满请求根数（上游拒绝或该合约历史确实短）
      // 只判断 missingBars 会把"请求 900 根只拿到 300 根"误判为完整（缺口检测只看窗口内部）。
      const gapped = missingBars > 0 || short;
      const now = Date.now();
      remember(key, { at: now, live: true, gapped, data: candles, want: count, tailAt: now, tailAttemptAt: now });
      return { live: true, gapped, candles };
    } catch {
      const candles = synthCandles(symbol, bar, count);
      const now = Date.now();
      remember(key, { at: now, live: false, gapped: false, data: candles, want: count, tailAt: now, tailAttemptAt: now });
      return { live: false, gapped: false, candles };
    }
  })();

  inflight.set(key, { promise: job, count });
  try {
    return await job;
  } finally {
    if (inflight.get(key)?.promise === job) inflight.delete(key);
  }
}
