// ─────────────────────────────────────────────────────────────
//  真实订单流数据层（OKX 公共接口，无需密钥）
//  浏览器内两条来源：
//  · 成交流（/market/history-trades 回补 + trades WebSocket 实时）：逐笔 side/px/sz
//    → 按 K 线聚合成主动买入 / 主动卖出成交额（USDT），与 K 线报价币成交量同一量纲；
//    聚合额 ≥ 85% K 线成交量才视为“完整覆盖”，否则该根仍用形态近似
//  · rubik 统计（taker-volume-contract / open-interest-history）：每根 K 线官方主动买卖额与持仓量，
//    但该接口不带 CORS：Node 直连，浏览器固定走同源白名单代理 /api/okx
// ─────────────────────────────────────────────────────────────
import { setCtVal, tryCtValOf } from '@/lib/types';

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
  /** 最近两根的独立逐笔聚合：避免新收盘 rubik 统计尚不完整时封锁 WS 更新。 */
  tapeBars?: Map<number, FlowBar>;
  /** 最近逐笔（环形，上限 5000）：用于大单主动方向等实时因子（可选以兼容既有快照构造） */
  recent?: FlowTrade[];
  /** 上次修复性回补时间，避免断线后频繁全量翻页 */
  repairedAt?: number;
  /** 真实主动成交覆盖的最早 / 最晚 K 线时间 */
  from: number;
  to: number;
  oiFrom: number;
  oiTo?: number;
  /** rubik 官方统计写入的最后一根（不受实时 tape 影响），增量刷新的起点 */
  rubikTo?: number;
  syncedPages?: number;
  syncedOiPages?: number;
  updatedAt: number;
  complete: boolean;
  /** rubik 官方统计是否已完整回填（与 tape bootstrap 独立；失败可重试） */
  rubikComplete?: boolean;
  /** 上次 rubik 同步失败时间（0 = 未失败）；用于失败冷却，避免无代理环境每 30s 空转 */
  rubikFailedAt?: number;
  tape: { connected: boolean; trades: number; bootstrapped: boolean };
}

const REST = 'https://www.okx.com';
const WS_PUBLIC = 'wss://ws.okx.com/ws/v5/public';
const PAGE = 100;

const cache = new Map<string, FlowSnapshot>();
const listeners = new Set<(snap: FlowSnapshot) => void>();
const inflight = new Map<string, { promise: Promise<FlowSnapshot>; signal?: AbortSignal }>();

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
    rubikComplete: false,
    rubikFailedAt: 0,
    tape: { connected: false, trades: 0, bootstrapped: false },
  };
}

/** rubik 代理地址（无 CORS 的统计接口固定走同源白名单代理）；Node 环境直连 */
export function rubikBase(): string | null {
  if (typeof window === 'undefined') return REST;
  return `${window.location.origin}/api/okx`;
}

const ctValInflight = new Map<string, Promise<number | null>>();
async function resolveCtVal(instId: string, signal?: AbortSignal): Promise<number | null> {
  const known = tryCtValOf(instId);
  if (known != null) return known;
  const inflightReq = ctValInflight.get(instId);
  if (inflightReq) return inflightReq;
  const job = (async () => {
    try {
      const rows = (await okxGet(REST, '/api/v5/public/instruments', { instType: 'SWAP', instId }, signal)) as { ctVal?: string }[];
      const val = Number(rows[0]?.ctVal);
      if (Number.isFinite(val) && val > 0) {
        setCtVal(instId, val);
        return val;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    if (ctValInflight.get(instId) === job) ctValInflight.delete(instId);
  });
  ctValInflight.set(instId, job);
  return job;
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
const seenMaxBySnapshot = new WeakMap<FlowSnapshot, number>();
// tradeId 近似时间有序：保留水位窗口，避免 seen 集合随会话时长无界增长（BTC 约 10–30 笔/秒）
const SEEN_KEEP = 150_000;
const SEEN_TRIM_AT = 250_000;
export function aggregateFlowTrades(snap: FlowSnapshot, trades: Trade[], ctVal: number) {
  let seen = seenBySnapshot.get(snap);
  if (!seen) { seen = new Set<number>(); seenBySnapshot.set(snap, seen); }
  let maxId = seenMaxBySnapshot.get(snap) ?? 0;
  const recentStart = Math.floor(Date.now() / snap.barMs) * snap.barMs - 2 * snap.barMs;
  for (const t of trades) {
    if (!(t.px > 0 && t.sz > 0 && ctVal > 0) || !Number.isSafeInteger(t.tradeId) ||
        !(t.ts > 0) || !Number.isFinite(t.ts) || (t.side !== 'buy' && t.side !== 'sell')) continue;
    if (seen.has(t.tradeId)) continue;
    seen.add(t.tradeId);
    if (t.tradeId > maxId) maxId = t.tradeId;
    const ts = Math.floor(t.ts / snap.barMs) * snap.barMs;
    const notional = t.px * t.sz * ctVal;
    if (!Number.isFinite(notional)) continue;
    const current = snap.bars.get(ts);
    if (current?.src === 'rubik' && ts < recentStart) continue; // 历史根仍以官方统计为准

    let tapeBar: FlowBar;
    if (ts >= recentStart) {
      const tapeBars = (snap.tapeBars ??= new Map());
      tapeBar = tapeBars.get(ts) ?? (current?.src === 'tape'
        ? { ...current }
        : { ts, buy: 0, sell: 0, src: 'tape', trades: 0 });
      tapeBars.set(ts, tapeBar);
      // 官方值在后一次同步时可能带回了 OI；不要在切回逐笔时丢失。
      if (current?.oiContracts) tapeBar.oiContracts = current.oiContracts;
      if (current?.oiUsd) tapeBar.oiUsd = current.oiUsd;
    } else {
      tapeBar = current?.src === 'tape' ? current : { ts, buy: 0, sell: 0, src: 'tape', trades: 0 };
    }
    if (t.side === 'buy') tapeBar.buy += notional;
    else tapeBar.sell += notional;
    tapeBar.trades = (tapeBar.trades ?? 0) + 1;
    if (!current || current.src === 'tape' || tapeBar.buy + tapeBar.sell > current.buy + current.sell) {
      snap.bars.set(ts, tapeBar);
    }
    const recent = (snap.recent ??= []);
    recent.push({ ts: t.ts, side: t.side, notional });
    if (recent.length > 5000) {
      const cutoff = Date.now() - 180_000;
      let drop = 0;
      while (drop < recent.length && recent[drop].ts < cutoff) drop++;
      if (drop > 0) recent.splice(0, drop);
      if (recent.length > 5000) recent.splice(0, recent.length - 5000);
    }
    snap.tape.trades++;
    snap.from = Math.min(snap.from, ts);
    snap.to = Math.max(snap.to, ts);
  }
  if (snap.tapeBars) for (const ts of snap.tapeBars.keys()) if (ts < recentStart) snap.tapeBars.delete(ts);
  seenMaxBySnapshot.set(snap, maxId);
  if (seen.size > SEEN_TRIM_AT) {
    const cutoff = maxId - SEEN_KEEP;
    for (const id of seen) if (id < cutoff) seen.delete(id);
  }
}

const parseTrades = (rows: unknown[]): Trade[] =>
  (rows as { ts: string; px: string; sz: string; side: string; tradeId: string }[])
    .filter(r => r && (r.side === 'buy' || r.side === 'sell'))
    .map(r => ({ ts: Number(r.ts), px: Number(r.px), sz: Number(r.sz), side: r.side as 'buy' | 'sell', tradeId: Number(r.tradeId) }))
    .filter(t => t.ts > 0 && t.px > 0 && t.sz > 0 && Number.isSafeInteger(t.tradeId) && Number.isFinite(t.ts));

interface Tape {
  instId: string;
  ws: WebSocket | null;
  closed: boolean;
  snaps: Set<FlowSnapshot>;
  owners: Set<string>;
  retry: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  rollover: ReturnType<typeof setTimeout> | null;
  attempt: number;
  /** WS 断开过：需要一次修复性回补，否则断线窗口的 K 线永久退回 K 线近似 */
  needsRepair: boolean;
}
const tapes = new Map<string, Tape>();

/** 每个合约一条实时成交流；同一合约的多个周期快照共享 */
function ensureTape(instId: string, snap: FlowSnapshot, owner?: string) {
  let tape = tapes.get(instId);
  if (!tape) {
    tape = {
      instId, ws: null, closed: false, snaps: new Set(), owners: new Set(),
      retry: null, ping: null, pongTimer: null, rollover: null, attempt: 0, needsRepair: false,
    };
    tapes.set(instId, tape);
    openTape(tape);
  }
  if (owner) tape.owners.add(owner);
  tape.snaps.add(snap);
  if (snap.tape.bootstrapped && !snap.tape.connected) tape.needsRepair = true;
  return tape;
}

function clearTapeTimers(tape: Tape) {
  if (tape.ping) { clearInterval(tape.ping); tape.ping = null; }
  if (tape.pongTimer) { clearTimeout(tape.pongTimer); tape.pongTimer = null; }
}

function openTape(tape: Tape) {
  if (tape.closed || typeof WebSocket === 'undefined') return;
  if (tape.retry) { clearTimeout(tape.retry); tape.retry = null; }
  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_PUBLIC);
  } catch {
    const delay = Math.min(30_000, 2000 * Math.pow(2, Math.min(4, tape.attempt++)));
    tape.retry = setTimeout(() => openTape(tape), delay);
    return;
  }
  tape.ws = ws;
  if (tryCtValOf(tape.instId) == null) {
    void resolveCtVal(tape.instId);
  }
  ws.onopen = () => {
    if (tape.closed) { ws.close(); return; }
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: tape.instId }] }));
    tape.ping = setInterval(() => {
      if (tape.closed || tape.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send('ping');
      if (!tape.pongTimer) {
        tape.pongTimer = setTimeout(() => {
          tape.pongTimer = null;
          if (!tape.closed && tape.ws === ws) ws.close();
        }, 10_000);
      }
    }, 25_000);
    tape.snaps.forEach(s => {
      s.tape.connected = true;
      notify(s);
    });
  };
  ws.onmessage = ev => {
    if (tape.closed) return;
    if (tape.pongTimer) { clearTimeout(tape.pongTimer); tape.pongTimer = null; }
    tape.attempt = 0;
    if (ev.data === 'pong') return;
    try {
      const msg = JSON.parse(ev.data as string) as { arg?: { channel?: string }; data?: unknown[] };
      if (msg.arg?.channel !== 'trades' || !Array.isArray(msg.data)) return;
      const ctVal = tryCtValOf(tape.instId);
      if (ctVal == null) return;
      const trades = parseTrades(msg.data);
      for (const s of tape.snaps) {
        aggregateFlowTrades(s, trades, ctVal);
        // Coalesce live ticks: refresh evidence/optional preview without a React render per trade.
        // 250ms 与标注运行时的节流对齐：端到端延时从 ~1.5s 降到 ~0.25s。
        if (trades.length && !tape.rollover) {
          tape.rollover = setTimeout(() => {
            tape.rollover = null;
            tape.snaps.forEach(notify);
          }, 250);
        }
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    clearTapeTimers(tape);
    tape.snaps.forEach(s => {
      s.tape.connected = false;
      notify(s);
    });
    if (!tape.closed && tape.ws === ws) {
      tape.ws = null;
      tape.needsRepair = true;
      const delay = Math.min(30_000, 2000 * Math.pow(2, Math.min(4, tape.attempt++)));
      tape.retry = setTimeout(() => openTape(tape), delay);
    }
  };
  ws.onerror = () => ws.close();
}

/** 关闭不再使用的合约成交流（按 owner 引用计数；不传 owner 则强制释放） */
export function releaseTape(instId: string, owner?: string) {
  const tape = tapes.get(instId);
  if (!tape) return;
  if (owner) {
    tape.owners.delete(owner);
    if (tape.owners.size > 0) return;
  }
  tape.closed = true;
  tape.snaps.forEach(s => { s.tape.connected = false; notify(s); });
  if (tape.retry) { clearTimeout(tape.retry); tape.retry = null; }
  clearTapeTimers(tape);
  if (tape.rollover) { clearTimeout(tape.rollover); tape.rollover = null; }
  try {
    tape.ws?.close();
  } catch {
    /* ignore */
  }
  tapes.delete(instId);
}

/** REST 回补：从最新成交向前翻页，直到覆盖 minTs 或页数上限（10 次 / 2 秒）；返回是否完整覆盖目标时间 */
async function bootstrapTape(snap: FlowSnapshot, tape: Tape, minTs: number, maxPages: number, signal?: AbortSignal): Promise<boolean> {
  const ctVal = await resolveCtVal(snap.instId, signal);
  if (ctVal == null) return false;
  let after: number | undefined;
  let completed = maxPages <= 0;
  for (let p = 0; p < maxPages; p++) {
    if (signal?.aborted || tape.closed) return false;
    const params: Record<string, string> = { instId: snap.instId, limit: String(PAGE), type: '1' };
    if (after) params.after = String(after);
    const rows = await okxGet(REST, '/api/v5/market/history-trades', params, signal);
    const trades = parseTrades(rows);
    if (!trades.length) {
      completed = true;
      break;
    }
    if (signal?.aborted || tape.closed) return false;
    aggregateFlowTrades(snap, trades, ctVal);
    const oldest = trades.reduce((m, t) => (t.tradeId < m.tradeId ? t : m), trades[0]);
    after = oldest.tradeId;
    if (oldest.ts <= minTs) {
      completed = true;
      break;
    }
    if (p % 15 === 14) notify(snap);
    await sleep(220);
  }
  if (signal?.aborted || tape.closed) return false;
  snap.tape.bootstrapped = true;
  return completed;
}

const MAX_FLOW_BARS = 12_000;

function trimFlowBars(snap: FlowSnapshot) {
  if (snap.bars.size <= MAX_FLOW_BARS) return;
  const keys = [...snap.bars.keys()].sort((a, b) => a - b);
  const drop = keys.length - MAX_FLOW_BARS;
  for (let i = 0; i < drop; i++) snap.bars.delete(keys[i]);
  if (keys.length > drop) snap.from = Math.max(snap.from, keys[drop]);
}

// ─── rubik 官方统计（需直连或代理） ───────────────────────────
/** 离线追补上限：与首次回填同量级（约 1400 根），避免一次刷新变成无界翻页 */
export const MAX_CATCHUP_PAGES = 14;

/** 从上次写入的最后一根补到现在所需页数（含 1 页重叠），不少于调用方给的页数 */
export function catchUpPages(lastTs: number, barMs: number, minPages: number, now = Date.now()): number {
  const missing = Math.max(0, Math.ceil((now - lastTs) / barMs));
  return Math.max(minPages, Math.min(MAX_CATCHUP_PAGES, Math.ceil(missing / PAGE) + 1));
}

async function syncRubik(snap: FlowSnapshot, base: string, minTs: number, maxPages: number, oiPages: number, signal?: AbortSignal) {
  const { instId, period } = snap;
  // 增量刷新必须以 rubik 自己写到的最后一根为界：snap.to 也会被实时 tape 推到当前时间，
  // 用它当停止点会让长时间离线（睡眠/断网）期间的 K 线永远不再回填。
  // 调用方要求比上次更深的历史时仍做完整回填。
  const takerIncremental = !!snap.rubikComplete && (snap.rubikTo ?? 0) > 0 && (snap.syncedPages ?? 0) >= maxPages;
  const oiIncremental = !!snap.rubikComplete && (snap.oiTo ?? 0) > 0 && (snap.syncedOiPages ?? 0) >= oiPages;
  const takerStopTs = takerIncremental ? Math.max(minTs, snap.rubikTo! - snap.barMs) : minTs;
  const oiStopTs = oiIncremental ? Math.max(minTs, snap.oiTo! - snap.barMs) : Math.max(minTs, snap.from);
  const takerPages = takerIncremental ? catchUpPages(snap.rubikTo!, snap.barMs, maxPages) : maxPages;
  const oiPageBudget = oiIncremental ? catchUpPages(snap.oiTo!, snap.barMs, oiPages) : oiPages;

  const syncTaker = async () => {
    let end: number | undefined;
    for (let pages = 0; pages < takerPages; pages++) {
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
        // 刚收盘根的 rubik 统计有管线延迟，可能仍是部分成交额；此时实时 tape
        // 已聚合得更完整（总额更高）。用总额比较而非无条件覆盖，避免把完整
        // 的实时 delta 锁死为不完整值。OI 合并在后续循环中仍会命中 prev。
        const tapeTotal = prev && prev.src === 'tape' ? prev.buy + prev.sell : 0;
        if (tapeTotal > buy + sell) continue;
        snap.bars.set(ts, { ts, buy, sell, oiContracts: prev?.oiContracts, oiUsd: prev?.oiUsd, src: 'rubik' });
        snap.from = Math.min(snap.from, ts);
        snap.to = Math.max(snap.to, ts);
        snap.rubikTo = Math.max(snap.rubikTo ?? 0, ts);
      }
      if (!nonZero || !Number.isFinite(oldest) || oldest <= takerStopTs) break;
      end = oldest;
      if (pages + 1 < takerPages) await sleep(410);
    }
    snap.syncedPages = Math.max(snap.syncedPages ?? 0, maxPages);
  };

  const syncOi = async () => {
    let oiEnd: number | undefined;
    for (let p = 0; p < oiPageBudget; p++) {
      const params: Record<string, string> = { instId, period, limit: String(PAGE) };
      if (oiEnd) params.end = String(oiEnd);
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
        snap.oiTo = Math.max(snap.oiTo ?? 0, ts);
      }
      const stop = oiStopTs > 0 ? oiStopTs : Math.max(minTs, snap.from);
      if (!Number.isFinite(oldest) || oldest <= stop) break;
      oiEnd = oldest;
      if (p + 1 < oiPageBudget) await sleep(410);
    }
    snap.syncedOiPages = Math.max(snap.syncedOiPages ?? 0, oiPages);
  };

  // taker 与 open-interest 为两个独立配额端点，并发拉取并消除尾部空等
  await Promise.all([syncTaker(), syncOi()]);
  trimFlowBars(snap);
}

/**
 * 同步某个合约 / 周期的真实订单流（幂等；同一 key 共享进行中的请求）。
 * 浏览器：成交流回补 + 实时 WebSocket；Node / 代理：rubik 官方统计。
 */
export function syncFlow(
  instId: string,
  period: string,
  opts: { minTs: number; maxPages?: number; oiPages?: number; bootstrapPages?: number; bootstrapBars?: number; signal?: AbortSignal; owner?: string },
): Promise<FlowSnapshot> {
  const key = flowKey(instId, period);
  const running = inflight.get(key);
  // 已被中止的任务不能再当作「正在同步」复用：releaseTape 会关掉并删除实时成交流，
  // 若继续等待旧任务（最多 300 页回补）自行结束，重新开启标注后成交流会长时间不重连，
  // 侧栏一直停在「等待成交流」，所有订单流类标注拿不到真实覆盖。
  if (running && !running.signal?.aborted) {
    if (typeof window !== 'undefined' && opts.owner) {
      const snap = cache.get(key);
      if (snap) ensureTape(instId, snap, opts.owner);
    }
    return running.promise;
  }
  const job = (async () => {
    const snap = cache.get(key) ?? emptySnapshot(instId, period);
    cache.set(key, snap);
    if (opts.signal?.aborted) return snap;
    // Establish the live connection before waiting for paginated historical statistics.
    const liveTape = typeof window !== 'undefined' ? ensureTape(instId, snap, opts.owner) : null;
    const base = rubikBase();
    try {
      // 失败冷却：无代理的静态环境里 rubik 恒失败，避免每 30s 重复全量翻页空转。
      const rubikCooling = !!snap.rubikFailedAt && Date.now() - snap.rubikFailedAt < 5 * 60_000;
      if (base && !rubikCooling) {
        // Official per-bar taker statistics. A failure here (rate limit, no
        // proxy in a static/Vite build) must not block the live trade tape.
        try {
          await syncRubik(snap, base, opts.minTs, opts.maxPages ?? 16, opts.oiPages ?? 12, opts.signal);
          snap.rubikComplete = true;
          snap.rubikFailedAt = 0;
          snap.complete = true;
        } catch (e) {
          if (!opts.signal?.aborted) {
            snap.rubikFailedAt = Date.now();
            console.warn('[订单流] rubik 统计不可用，改用逐笔成交：', e);
          }
        }
      }
      if (opts.signal?.aborted) return snap;
      if (liveTape) {
        const tape = liveTape;
        if (snap.tape.bootstrapped && shouldRepairFlow(snap, tape.needsRepair)) {
          // 断线 / 快照滞后：尽量覆盖到上次最新根（上限 12 根、48 页），未真正覆盖目标时间前不清除 needsRepair
          const now = Date.now();
          const curBar = Math.floor(now / snap.barMs) * snap.barMs;
          const repairMin = Math.min(
            curBar - 2 * snap.barMs,
            Math.max(snap.to > 0 ? snap.to - snap.barMs : curBar - 2 * snap.barMs, curBar - 12 * snap.barMs),
          );
          const repaired = await bootstrapTape(snap, tape, repairMin, 48, opts.signal);
          if (!opts.signal?.aborted && !tape.closed) {
            snap.repairedAt = Date.now();
            if (repaired) tape.needsRepair = false;
          }
        }
        if (!snap.tape.bootstrapped) {
          // 若 rubik 已回填历史已收盘 K 线，逐笔回补只需覆盖形成中及刚收盘的 2 根；
          // 仅无 rubik 代理时才回补完整 targetBars 根。
          const rawBars = opts.bootstrapBars ?? 8;
          const targetBars = snap.rubikComplete ? Math.min(rawBars, 2) : rawBars;
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
  inflight.set(key, { promise: job, signal: opts.signal });
  job.finally(() => {
    if (inflight.get(key)?.promise === job) inflight.delete(key);
  });
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
 * 只有与同根 K 线报价币成交额一致时才称为完整主动成交：
 * 官方 rubik 也可能在刚收盘后返回部分统计（实测 SOL 5m 为 92.17%）；
 * 逐笔回补允许少量网络缺口，但不接受超过整根 K 线总额的错单位/重复数据。
 * 无有效 K 线成交额时无法证明覆盖，不能把缺失当作完整。
 */
export function hasRealFlow(bar: FlowBar | undefined, candleVol?: number, volumeSource?: import('@/lib/types').VolumeSource): bar is FlowBar {
  // Close×quantity estimates cannot validate tape coverage or CVD continuity.
  if (volumeSource && volumeSource !== 'quote') return false;
  if (!bar || !Number.isFinite(bar.buy) || !Number.isFinite(bar.sell) ||
      bar.buy < 0 || bar.sell < 0 || !(bar.buy + bar.sell > 0) ||
      candleVol == null || !Number.isFinite(candleVol) || !(candleVol > 0)) return false;
  const coverage = (bar.buy + bar.sell) / candleVol;
  return coverage >= (bar.src === 'rubik' ? 0.95 : 0.85) && coverage <= 1.1;
}
