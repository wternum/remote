// ─────────────────────────────────────────────────────────────
//  真实订单流数据层（OKX 公共接口，无需密钥）
//  浏览器内两条来源：
//  · 成交流（/market/history-trades 回补 + trades WebSocket 实时）：逐笔 side/px/sz
//    → 按 K 线聚合成主动买入 / 主动卖出成交额（USDT），与 K 线报价币成交量同一量纲；
//    聚合额 ≥ 85% K 线成交量才视为“完整覆盖”，否则该根仍用形态近似
//  · rubik 统计（taker-volume-contract / open-interest-history）：每根 K 线官方主动买卖额与持仓量，
//    但该接口不带 CORS，只在 Node / 配置了代理（localStorage pulsedesk.okx-proxy）时使用
// ─────────────────────────────────────────────────────────────
import { ctValOf } from '@/lib/types';

export interface FlowBar {
  ts: number;
  /** 主动买入成交额（USDT） */
  buy: number;
  /** 主动卖出成交额（USDT） */
  sell: number;
  /**
   * 持仓量（合约张数）。判断是否有新仓进出场必须使用张数，
   * 不能用随价格波动的 USD 名义值。
   */
  oiContracts?: number;
  /** 旧快照/展示用的 USD 名义持仓；不能单独证明有新仓。 */
  oiUsd?: number;
  /** 来源：tape = 逐笔成交聚合；rubik = 官方统计 */
  src: 'tape' | 'rubik';
  /** 聚合的逐笔笔数（tape） */
  trades?: number;
}

export interface FlowTrade {
  ts: number;
  side: 'buy' | 'sell';
  /** 名义成交额（USDT） */
  notional: number;
}

export interface FlowSnapshot {
  instId: string;
  period: string;
  barMs: number;
  bars: Map<number, FlowBar>;
  /** 最近逐笔（环形，上限 1200）：用于大单主动方向等实时因子（可选以兼容既有快照构造） */
  recent?: FlowTrade[];
  /** 上次修复性回补时间，避免断线后频繁全量翻页 */
  repairedAt?: number;
  /** 真实主动成交覆盖的最早 / 最晚 K 线时间 */
  from: number;
  to: number;
  oiFrom: number;
  updatedAt: number;
  complete: boolean;
  tape: { connected: boolean; trades: number; bootstrapped: boolean };
}

const REST = 'https://www.okx.com';
const WS_PUBLIC = 'wss://ws.okx.com/ws/v5/public';
const PAGE = 100;

const cache = new Map<string, FlowSnapshot>();
const listeners = new Set<(snap: FlowSnapshot) => void>();
const inflight = new Map<string, Promise<FlowSnapshot>>();

export const PERIOD_MS: Record<string, number> = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1H': 3_600_000, '2H': 7_200_000, '4H': 14_400_000 };

/** Vela 周期代号 → OKX period；不支持的周期返回 null（不做订单流） */
export function flowPeriodOf(timeframe: string): string | null {
  const map: Record<string, string> = { '5': '5m', '15': '15m', '30': '30m', '60': '1H', '120': '2H', '240': '4H' };
  return map[timeframe] ?? null;
}

export const flowKey = (instId: string, period: string) => `${instId}|${period}`;

export function getFlow(instId: string, period: string): FlowSnapshot | undefined {
  return cache.get(flowKey(instId, period));
}

export function subscribeFlow(fn: (snap: FlowSnapshot) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const notify = (snap: FlowSnapshot) => {
  snap.updatedAt = Date.now();
  listeners.forEach(fn => fn(snap));
};

function emptySnapshot(instId: string, period: string): FlowSnapshot {
  return {
    instId,
    period,
    barMs: PERIOD_MS[period] ?? 300_000,
    bars: new Map(),
    recent: [],
    from: Infinity,
    to: 0,
    oiFrom: Infinity,
    updatedAt: 0,
    complete: false,
    tape: { connected: false, trades: 0, bootstrapped: false },
  };
}

/** rubik 代理地址（无 CORS 的统计接口需要同源代理）；Node 环境直连 */
export function rubikBase(): string | null {
  if (typeof window === 'undefined') return REST;
  try {
    const v = localStorage.getItem('pulsedesk.okx-proxy');
    if (v && /^https?:\/\//.test(v)) return v.replace(/\/$/, '');
  } catch {
    /* storage unavailable */
  }
  // Default: the app's own whitelisted proxy (src/app/api/okx/[...path]).
  // Without it the browser only had ~8 bars of tape coverage, so historical
  // heavy-selling/buying candles never showed real taker data.
  return `${window.location.origin}/api/okx`;
}

async function okxGet(base: string, path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown[]> {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString(), { signal, cache: 'no-store' });
    if (res.status === 429) {
      // An exhausted rate-limit retry is not an empty market response.  Throw
      // so syncFlow does not mark a partial snapshot as complete.
      if (attempt === 2) throw new Error('OKX rate limited (429)');
      await sleep(900 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
    const json = (await res.json()) as { code?: string; data?: unknown[] };
    if (json.code && json.code !== '0') throw new Error(`OKX code ${json.code}`);
    return json.data ?? [];
  }
  return [];
}

// ─── 逐笔成交聚合 ─────────────────────────────────────────────
export interface Trade {
  ts: number;
  px: number;
  sz: number;
  side: 'buy' | 'sell';
  tradeId: number;
}

// Deduplication belongs to a snapshot, not the shared socket: every timeframe must
// receive each trade once, including after releasing/reconnecting the socket.
const seenBySnapshot = new WeakMap<FlowSnapshot, Set<number>>();
export function aggregateFlowTrades(snap: FlowSnapshot, trades: Trade[], ctVal: number) {
  let seen = seenBySnapshot.get(snap);
  if (!seen) { seen = new Set<number>(); seenBySnapshot.set(snap, seen); }
  for (const t of trades) {
    if (!(t.px > 0 && t.sz > 0) || !Number.isFinite(t.tradeId) || !Number.isFinite(t.ts)) continue;
    if (seen.has(t.tradeId)) continue;
    seen.add(t.tradeId);
    const ts = Math.floor(t.ts / snap.barMs) * snap.barMs;
    const notional = t.px * t.sz * ctVal;
    let bar = snap.bars.get(ts);
    if (!bar || bar.src === 'rubik') {
      if (bar?.src === 'rubik') continue; // 官方统计优先
      bar = { ts, buy: 0, sell: 0, src: 'tape', trades: 0 };
      snap.bars.set(ts, bar);
    }
    if (t.side === 'buy') bar.buy += notional;
    else bar.sell += notional;
    const recent = (snap.recent ??= []);
    recent.push({ ts: t.ts, side: t.side, notional });
    if (recent.length > 1200) recent.splice(0, recent.length - 1200);
    bar.trades = (bar.trades ?? 0) + 1;
    snap.tape.trades++;
    snap.from = Math.min(snap.from, ts);
    snap.to = Math.max(snap.to, ts);
  }
}

const parseTrades = (rows: unknown[]): Trade[] =>
  (rows as { ts: string; px: string; sz: string; side: string; tradeId: string }[])
    .map(r => ({ ts: Number(r.ts), px: Number(r.px), sz: Number(r.sz), side: (r.side === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell', tradeId: Number(r.tradeId) }))
    .filter(t => Number.isFinite(t.ts) && Number.isFinite(t.px) && Number.isFinite(t.sz) && Number.isFinite(t.tradeId));

interface Tape {
  instId: string;
  ws: WebSocket | null;
  closed: boolean;
  snaps: Set<FlowSnapshot>;
  retry: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  rollover: ReturnType<typeof setTimeout> | null;
  /** WS 断开过：需要一次修复性回补，否则断线窗口的 K 线永久退回 K 线近似 */
  needsRepair: boolean;
}
const tapes = new Map<string, Tape>();

/** 每个合约一条实时成交流；同一合约的多个周期快照共享 */
function ensureTape(instId: string, snap: FlowSnapshot) {
  let tape = tapes.get(instId);
  if (!tape) {
    tape = { instId, ws: null, closed: false, snaps: new Set(), retry: null, ping: null, rollover: null, needsRepair: false };
    tapes.set(instId, tape);
    openTape(tape);
  }
  tape.snaps.add(snap);
  if (snap.tape.bootstrapped && !snap.tape.connected) tape.needsRepair = true;
  return tape;
}

function openTape(tape: Tape) {
  if (tape.closed || typeof WebSocket === 'undefined') return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_PUBLIC);
  } catch {
    tape.retry = setTimeout(() => openTape(tape), 3000);
    return;
  }
  tape.ws = ws;
  const ctVal = ctValOf(tape.instId);
  ws.onopen = () => {
    if (tape.closed) { ws.close(); return; }
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: tape.instId }] }));
    tape.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    tape.snaps.forEach(s => {
      s.tape.connected = true;
      notify(s);
    });
  };
  ws.onmessage = ev => {
    if (tape.closed || ev.data === 'pong') return;
    try {
      const msg = JSON.parse(ev.data as string) as { arg?: { channel?: string }; data?: unknown[] };
      if (msg.arg?.channel !== 'trades' || !Array.isArray(msg.data)) return;
      const trades = parseTrades(msg.data);
      for (const s of tape.snaps) {
        aggregateFlowTrades(s, trades, ctVal);
        // Coalesce live ticks: refresh evidence/optional preview without a React render per trade.
        if (trades.length && !tape.rollover) {
          tape.rollover = setTimeout(() => {
            tape.rollover = null;
            tape.snaps.forEach(notify);
          }, 1500);
        }
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    if (tape.ping) clearInterval(tape.ping);
    tape.ping = null;
    tape.snaps.forEach(s => {
      s.tape.connected = false;
      notify(s);
    });
    if (!tape.closed) {
      tape.needsRepair = true;
      tape.retry = setTimeout(() => openTape(tape), 2000);
    }
  };
  ws.onerror = () => ws.close();
}

/** 关闭不再使用的合约成交流（切换币种时调用） */
export function releaseTape(instId: string) {
  const tape = tapes.get(instId);
  if (!tape) return;
  tape.closed = true;
  tape.snaps.forEach(s => { s.tape.connected = false; notify(s); });
  if (tape.retry) clearTimeout(tape.retry);
  if (tape.ping) clearInterval(tape.ping);
  if (tape.rollover) clearTimeout(tape.rollover);
  try {
    tape.ws?.close();
  } catch {
    /* ignore */
  }
  tapes.delete(instId);
}

/** REST 回补：从最新成交向前翻页，直到覆盖 minTs 或页数上限（10 次 / 2 秒）；每 15 页通知一次以便界面渐进刷新 */
async function bootstrapTape(snap: FlowSnapshot, tape: Tape, minTs: number, maxPages: number, signal?: AbortSignal) {
  const ctVal = ctValOf(snap.instId);
  let after: number | undefined;
  for (let p = 0; p < maxPages; p++) {
    if (signal?.aborted || tape.closed) return;
    const params: Record<string, string> = { instId: snap.instId, limit: String(PAGE), type: '1' };
    if (after) params.after = String(after);
    const rows = await okxGet(REST, '/api/v5/market/history-trades', params, signal);
    const trades = parseTrades(rows);
    if (!trades.length) break;
    if (signal?.aborted || tape.closed) return;
    aggregateFlowTrades(snap, trades, ctVal);
    const oldest = trades.reduce((m, t) => (t.tradeId < m.tradeId ? t : m), trades[0]);
    after = oldest.tradeId;
    if (oldest.ts <= minTs) break;
    if (p % 15 === 14) notify(snap);
    await sleep(220);
  }
  snap.tape.bootstrapped = true;
}

// ─── rubik 官方统计（需直连或代理） ───────────────────────────
async function syncRubik(snap: FlowSnapshot, base: string, minTs: number, maxPages: number, oiPages: number, signal?: AbortSignal) {
  const { instId, period } = snap;
  let end: number | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const params: Record<string, string> = { instId, period, unit: '2', limit: String(PAGE) };
    if (end) params.end = String(end);
    const rows = (await okxGet(base, '/api/v5/rubik/stat/taker-volume-contract', params, signal)) as string[][];
    if (!rows.length) break;
    let nonZero = 0;
    let oldest = Infinity;
    for (const r of rows) {
      const ts = Number(r[0]);
      const sell = Number(r[1]);
      const buy = Number(r[2]);
      if (!Number.isFinite(ts)) continue;
      oldest = Math.min(oldest, ts);
      if (!(buy > 0 || sell > 0)) continue; // 保留边界之外返回全 0，视为缺失
      // The newest row is the still-forming bar (partial totals). Leave it to
      // the live tape; storing it as authoritative 'rubik' would block tape
      // aggregation and freeze an incomplete delta.
      if (ts + snap.barMs > Date.now()) continue;
      nonZero++;
      const prev = snap.bars.get(ts);
      snap.bars.set(ts, { ts, buy, sell, oiContracts: prev?.oiContracts, oiUsd: prev?.oiUsd, src: 'rubik' });
      snap.from = Math.min(snap.from, ts);
      snap.to = Math.max(snap.to, ts);
    }
    if (!nonZero || !Number.isFinite(oldest) || oldest <= minTs) break;
    end = oldest;
    await sleep(430);
  }
  let oiEnd: number | undefined;
  for (let p = 0; p < oiPages; p++) {
    const params: Record<string, string> = { instId, period, limit: String(PAGE) };
    if (oiEnd) params.end = String(oiEnd);
    await sleep(430);
    const rows = (await okxGet(base, '/api/v5/rubik/stat/contracts/open-interest-history', params, signal)) as string[][];
    if (!rows.length) break;
    let oldest = Infinity;
    for (const r of rows) {
      const ts = Number(r[0]);
      // OKX returns [ts, oi(contracts), oiCcy, oiUsd].  Use the contract
      // count for position-change evidence; oiUsd also moves with price.
      const oiContracts = Number(r[1]);
      const oiUsd = Number(r[3]);
      if (!Number.isFinite(ts) || (!(oiContracts > 0) && !(oiUsd > 0))) continue;
      oldest = Math.min(oldest, ts);
      const prev = snap.bars.get(ts);
      if (prev) {
        prev.oiContracts = oiContracts > 0 ? oiContracts : undefined;
        prev.oiUsd = oiUsd > 0 ? oiUsd : undefined;
      } else {
        snap.bars.set(ts, {
          ts, buy: 0, sell: 0,
          oiContracts: oiContracts > 0 ? oiContracts : undefined,
          oiUsd: oiUsd > 0 ? oiUsd : undefined,
          src: 'rubik',
        });
      }
      snap.oiFrom = Math.min(snap.oiFrom, ts);
    }
    if (!Number.isFinite(oldest) || oldest <= Math.max(minTs, snap.from)) break;
    oiEnd = oldest;
  }
}

/**
 * 同步某个合约 / 周期的真实订单流（幂等；同一 key 共享进行中的请求）。
 * 浏览器：成交流回补 + 实时 WebSocket；Node / 代理：rubik 官方统计。
 */
export function syncFlow(
  instId: string,
  period: string,
  opts: { minTs: number; maxPages?: number; oiPages?: number; bootstrapPages?: number; bootstrapBars?: number; signal?: AbortSignal },
): Promise<FlowSnapshot> {
  const key = flowKey(instId, period);
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const snap = cache.get(key) ?? emptySnapshot(instId, period);
    cache.set(key, snap);
    const base = rubikBase();
    try {
      if (base) {
        // Official per-bar taker statistics. A failure here (rate limit, no
        // proxy in a static/Vite build) must not block the live trade tape.
        try {
          await syncRubik(snap, base, opts.minTs, opts.maxPages ?? 16, opts.oiPages ?? 12, opts.signal);
          snap.complete = true;
        } catch (e) {
          if (!opts.signal?.aborted) console.warn('[订单流] rubik 统计不可用，改用逐笔成交：', e);
        }
      }
      if (opts.signal?.aborted) return snap;
      if (typeof window !== 'undefined') {
        const tape = ensureTape(instId, snap);
        if (snap.tape.bootstrapped && shouldRepairFlow(snap, tape.needsRepair)) {
          // 断线 / 快照滞后：只回补最近 2 根（页数封顶），补齐缺口而不是重做全量回填
          const repairMin = Math.floor(Date.now() / snap.barMs) * snap.barMs - 2 * snap.barMs;
          await bootstrapTape(snap, tape, repairMin, 24, opts.signal);
          tape.needsRepair = false;
          snap.repairedAt = Date.now();
        }
        if (!snap.tape.bootstrapped) {
          // 回补最近 targetBars 根完整 K 线（5m 默认 8 根 ≈ 40 分钟；BTC 约 12 页 / 根）
          const targetBars = opts.bootstrapBars ?? 8;
          const recent = Math.floor(Date.now() / snap.barMs) * snap.barMs - targetBars * snap.barMs;
          await bootstrapTape(snap, tape, Math.max(opts.minTs, recent), opts.bootstrapPages ?? 220, opts.signal);
        }
        snap.complete = true;
      }
    } catch (e) {
      if (!opts.signal?.aborted) console.warn('[订单流] OKX 同步失败：', e);
    }
    notify(snap);
    return snap;
  })();
  inflight.set(key, job);
  job.finally(() => inflight.delete(key));
  return job;
}

/**
 * 是否需要修复性回补：WS 断开过，或最新聚合 K 线落后当前时间超过 2 个周期；
 * 两次回补之间至少间隔一个周期，避免低流动品种反复翻页。
 */
export function shouldRepairFlow(
  snap: Pick<FlowSnapshot, 'to' | 'barMs' | 'repairedAt'>,
  needsRepair: boolean,
  now = Date.now(),
): boolean {
  const stale = snap.to > 0 && now - snap.to > snap.barMs * 2;
  if (!needsRepair && !stale) return false;
  return now - (snap.repairedAt ?? 0) > snap.barMs;
}

/**
 * 大单主动方向（tapeBias 因子数据源）：
 * 取最近 windowMs 内逐笔，按成交额 90 分位定义“大单”，返回 (买−卖)/(买+卖) ∈ [-1,1]。
 * 样本不足或窗口内没有成交时返回 null —— 缺数据不臆测，与证据模型原则一致。
 */
export function bigBiasOf(
  trades: FlowTrade[],
  now = Date.now(),
  windowMs = 120_000,
): { bias: number | null; count: number; threshold: number } {
  const win = trades.filter(t => t.ts >= now - windowMs && t.notional > 0);
  if (win.length < 30) return { bias: null, count: 0, threshold: 0 };
  const sorted = win.map(t => t.notional).sort((a, b) => a - b);
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)))];
  // 注意必须严格大于分位值：大量相同小额成交时，>= 会把全部样本都算成“大单”，
  // 使 tapeBias 退化为全量 delta。分位过滤为空时退回成交额最高的 10% 笔。
  let big = win.filter(t => t.notional > threshold);
  if (big.length < 3) {
    big = [...win].sort((a, b) => b.notional - a.notional).slice(0, Math.max(3, Math.floor(win.length * 0.1)));
  }
  let buy = 0;
  let sell = 0;
  for (const t of big) {
    if (t.side === 'buy') buy += t.notional;
    else sell += t.notional;
  }
  if (!big.length || buy + sell <= 0) return { bias: null, count: 0, threshold };
  return { bias: (buy - sell) / (buy + sell), count: big.length, threshold };
}

/**
 * 该 K 线是否被真实主动成交完整覆盖：
 * rubik 统计直接可信；逐笔聚合要求聚合额 ≥ 85% 的 K 线成交量（排除中途接入的不完整 K 线）。
 */
export function hasRealFlow(bar: FlowBar | undefined, candleVol?: number): bar is FlowBar {
  if (!bar || !(bar.buy > 0 || bar.sell > 0)) return false;
  if (bar.src === 'rubik') return true;
  if (candleVol == null || !(candleVol > 0)) return true;
  return bar.buy + bar.sell >= 0.85 * candleVol;
}
