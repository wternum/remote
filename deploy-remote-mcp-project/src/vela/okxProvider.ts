import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import { quoteVolumeFromRow } from '@/lib/okxVolume';

// ─────────────────────────────────────────────────────────────
//  OKX 永续 DataProvider：历史分页 REST + 公共 WebSocket 实时 K 线
//  · 与远程项目同一数据源（OKX），但走 Vela 的 provider 契约
//  · 浏览器直连；OKX 公共接口允许跨域
// ─────────────────────────────────────────────────────────────

const REST = 'https://www.okx.com';
// OKX's business endpoint on the default HTTPS port.  The legacy 8443
// endpoint is unreliable/deprecated in some regions and left the chart on
// historical REST data while the rest of the app used the 443 feed.
const WS = 'wss://ws.okx.com/ws/v5/business';

/** Vela 规范周期（分钟数 / 'D' / 'W' / 'M'）→ OKX bar 代号 */
export function toOkxBar(tf: string): string {
  if (tf === 'D' || tf === '1D') return '1Dutc';
  if (tf === 'W' || tf === '1W') return '1Wutc';
  if (tf === 'M' || tf === '1M') return '1Mutc';
  const m = Number(tf);
  if (!Number.isFinite(m)) return '5m';
  if (m >= 60 && m % 60 === 0) return `${m / 60}H`;
  return `${m}m`;
}

export function tfMs(tf: string): number {
  if (tf === 'D' || tf === '1D') return 86_400_000;
  if (tf === 'W' || tf === '1W') return 7 * 86_400_000;
  if (tf === 'M' || tf === '1M') return 30 * 86_400_000;
  const m = Number(tf);
  return (Number.isFinite(m) ? m : 5) * 60_000;
}

export const OKX_TIMEFRAMES = ['1', '3', '5', '15', '30', '60', '240', 'D', 'W'] as const;

/** Only three OKX perpetuals are exposed in the symbol search. */
const SWAPS: SymbolDescriptor[] = [
  { ticker: 'BTC-USDT-SWAP', description: 'Bitcoin / USDT 永续', type: 'swap' },
  { ticker: 'ETH-USDT-SWAP', description: 'Ethereum / USDT 永续', type: 'swap' },
  { ticker: 'SOL-USDT-SWAP', description: 'Solana / USDT 永续', type: 'swap' },
];

/** Official brand marks, inlined so the picker never waits on a CDN. */
const BRAND_MARKS: Record<string, string> = {
  btc: `<circle cx="16" cy="16" r="16" fill="#F7931A"/>
    <path fill="#fff" d="M22.4 13.9c.3-2.1-1.3-3.2-3.4-4l.7-2.7-1.7-.4-.7 2.6c-.4-.1-.9-.2-1.4-.3l.7-2.7-1.6-.4-.7 2.7c-.3-.1-.7-.2-1-.2l-2.4-.6-.5 1.8 1.3.3c.7.2.9.6.8 1l-.8 3.2-.2.7-1.1 4.4c-.1.2-.3.6-.8.5l-1.2-.3-.9 1.9 2.2.6c.4.1.8.2 1.2.3l-.7 2.8 1.7.4.7-2.8c.5.1.9.3 1.4.4l-.7 2.8 1.7.4.7-2.8c2.9.6 5 .4 5.9-2.2.7-2.1 0-3.3-1.5-4.1 1.1-.3 1.9-1 2.1-2.5Zm-3.8 5.4c-.5 2.1-4 1-5.2.7l.9-3.7c1.1.3 4.8.8 4.3 3Zm.5-5.4c-.5 1.9-3.4.9-4.3.7l.8-3.4c1 .2 4 .6 3.5 2.7Z"/>`,
  eth: `<circle cx="16" cy="16" r="16" fill="#627EEA"/>
    <g fill="#fff">
      <path d="M16.1 3.9v9.3l7.8 3.5-7.8-12.8Z" fill-opacity=".6"/>
      <path d="M16.1 3.9 8.2 16.7l7.9-3.5V3.9Z"/>
      <path d="M16.1 22.1v6l7.9-10.9-7.9 4.9Z" fill-opacity=".6"/>
      <path d="M16.1 28.1v-6l-7.9-4.9 7.9 10.9Z"/>
      <path d="m16.1 20.7 7.8-4.4-7.8-3.5v7.9Z" fill-opacity=".25"/>
      <path d="m8.2 16.3 7.9 4.4v-7.9l-7.9 3.5Z" fill-opacity=".6"/>
    </g>`,
  sol: `<circle cx="16" cy="16" r="16" fill="#9945FF"/>
    <path fill="#14F195" d="M12.9 9.4h11.2c.5 0 .8.6.4.9l-2.8 2.8c-.2.2-.5.3-.8.3H9.7c-.5 0-.8-.6-.4-.9l2.8-2.8c.2-.2.5-.3.8-.3Z"/>
    <path fill="#FFFFFF" d="M19.1 13.9H7.9c-.5 0-.8.6-.4.9l2.8 2.8c.2.2.5.3.8.3h11.2c.5 0 .8-.6.4-.9l-2.8-2.8c-.2-.2-.5-.3-.8-.3Z"/>
    <path fill="#00D8FF" d="M12.9 18.4h11.2c.5 0 .8.6.4.9l-2.8 2.8c-.2.2-.5.3-.8.3H9.7c-.5 0-.8-.6-.4-.9l2.8-2.8c.2-.2.5-.3.8-.3Z"/>
  `,
};
const brandIcon = (base: string) => {
  const mark = BRAND_MARKS[base];
  if (!mark) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img">${mark}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const TICK: Record<string, number> = { BTC: 0.1, ETH: 0.01, SOL: 0.01 };

function parseRow(r: (string | number)[], symbol: string): OHLCV | null {
  if (!Array.isArray(r) || r.length < 6) return null;
  const [t, o, h, l, c] = r.map(Number);
  if (![t, o, h, l, c].every(Number.isFinite) || !(h >= Math.max(o, c) && l <= Math.min(o, c))) return null;
  return { time: t, open: o, high: h, low: l, close: c, volume: quoteVolumeFromRow(r, symbol) };
}

async function okxGet(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<(string | number)[][]> {
  const url = new URL(REST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url.toString(), { signal, cache: 'no-store' });
    if (res.status === 429) {
      // Do not turn rate limiting into a successful empty candle page.
      if (attempt === 3) throw new Error('OKX rate limited (429)');
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
    const json = (await res.json()) as { code?: string; data?: (string | number)[][] };
    if (json.code && json.code !== '0') throw new Error(`OKX code ${json.code}`);
    return json.data ?? [];
  }
  return [];
}

// ── K 线镜像：provider 是图表唯一的数据源，镜像即图表所见 ──
type Listener = (key: string) => void;
const store = new Map<string, OHLCV[]>();
const listeners = new Set<Listener>();
const keyOf = (ticker: string, tf: string) => `${ticker}|${tf}`;

const MAX_STORE_BARS = 12_000;

/**
 * 同一时间戳的两份 K 线取较新的一份。
 *
 * 数据来自两条异步通道：REST 分批历史（快照拍在加载开始那一刻）和 WebSocket
 * 实时推送。旧实现无条件让后到者覆盖先到者，于是历史加载的每一批都会把
 * WebSocket 已推送的最新一根改回加载开始时的旧快照——图表上成交量柱
 * 忽高忽低；如果该根在加载期间收盘，它会永久保留残缺的成交量。
 *
 * 一根 K 线内的累计成交额只增不减（实测 OKX 推送 35 次 0 次回退），因此成交额
 * 更大者必然更新；相等时取后到者，以接收价格修正。
 */
function newer(existing: OHLCV | undefined, incoming: OHLCV): OHLCV {
  if (!existing) return incoming;
  return (incoming.volume ?? 0) >= (existing.volume ?? 0) ? incoming : existing;
}

function mergeFull(key: string, cur: OHLCV[], incoming: OHLCV[]) {
  const map = new Map<number, OHLCV>();
  for (const b of cur) map.set(b.time, b);
  for (const b of incoming) map.set(b.time, newer(map.get(b.time), b));
  const next = [...map.values()].sort((a, b) => a.time - b.time).slice(-MAX_STORE_BARS);
  store.set(key, next);
  listeners.forEach(fn => fn(key));
}

/**
 * 合并推送 / 回补的 K 线。
 *
 * 持久订阅时每秒都会收到形成中那根 K 线的更新，而旧实现每次都把 6000–12000 根
 * 全量重建 Map 再排序（实测 528µs/次）。绝大多数更新只改最后一根，这里走
 * 「尾部原地替换」的快路径；只有历史回补造成乱序时才退回全量合并。
 */
function merge(key: string, incoming: OHLCV[]) {
  if (!incoming.length) return;
  const cur = store.get(key) ?? [];
  const tail = cur[cur.length - 1];
  const head = incoming[0];
  const ordered = !tail || !head || head.time >= tail.time;
  if (!ordered) {
    mergeFull(key, cur, incoming);
    return;
  }
  const next = cur.length ? cur.slice() : [];
  for (const b of incoming) {
    const last = next[next.length - 1];
    if (last && b.time === last.time) next[next.length - 1] = newer(last, b);
    else if (!last || b.time > last.time) next.push(b);
    else {
      // 中间插入了更早的一根：退回全量合并
      mergeFull(key, cur, incoming);
      return;
    }
  }
  if (next.length > MAX_STORE_BARS) next.splice(0, next.length - MAX_STORE_BARS);
  store.set(key, next);
  listeners.forEach(fn => fn(key));
}

export const barsHub = {
  key: keyOf,
  get(ticker: string, tf: string): readonly OHLCV[] {
    return store.get(keyOf(ticker, tf)) ?? [];
  },
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export class OKXProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: 'okx',
      displayName: 'OKX',
      supportedTimeframes: OKX_TIMEFRAMES,
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return SWAPS;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const base = ticker.split('-')[0];
    const tick = TICK[base] ?? 0.01;
    return {
      ticker,
      description: SWAPS.find(s => s.ticker === ticker)?.description ?? ticker,
      type: 'swap',
      currency: 'USDT',
      // Vela's price axis reads `mintick`. Without it the axis falls back to a
      // zoom-range formula, so a freshly loaded SOL chart can show only one
      // decimal (e.g. 93.1 instead of 93.10) until the user zooms.
      mintick: tick,
      pricescale: Math.round(1 / tick),
      minmove: 1,
      timezone: 'Etc/UTC',
    } as SymbolInfo;
  }

  resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
    const base = symbol.ticker.split('-')[0]?.toLowerCase();
    return base ? brandIcon(base) : undefined;
  }

  /** 默认回看深度：短周期更深（双顶/双底需要足够多的历史关键位） */
  private depthFor(timeframe: string, range: BarRange) {
    const m = Number(timeframe);
    const base = !Number.isFinite(m) ? 800 : m <= 5 ? 6000 : m <= 15 ? 4000 : m <= 60 ? 2500 : 1500;
    return Math.min(Math.max(range.limit ?? 0, base, 100), 12_000);
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    return this.getBarsProgressive(ticker, timeframe, range, () => undefined);
  }

  /**
   * 渐进历史：第一页（最新 300 根）立刻交给图表绘制，随后分页向前补齐并逐批推送——
   * 与参考站一致：先出图，再变深。
   */
  async getBarsProgressive(
    ticker: string,
    timeframe: string,
    range: BarRange,
    onBatch: (bars: OHLCV[]) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<OHLCV[]> {
    const bar = toOkxBar(timeframe);
    const want = this.depthFor(timeframe, range);
    const map = new Map<number, OHLCV>();
    const snapshot = () => [...map.values()].sort((a, b) => a.time - b.time).slice(-want);
    const marketKey = keyOf(ticker, timeframe);
    const emit = () => {
      const snap = snapshot();
      merge(marketKey, snap);
      // 交给图表的必须是"本次请求的时间范围 × 镜像里的最新值"：
      // 直接给快照，旧值会绕过 merge 的新旧判断覆盖图表上的实时 K 线；
      // 直接给镜像尾部，则在向左滚动加载更早区间（range.to）时返回错误时间段。
      const latest = new Map((store.get(marketKey) ?? []).map(b => [b.time, b]));
      const out = snap.map(b => latest.get(b.time) ?? b);
      onBatch(out);
      return out;
    };
    const first = await okxGet(
      '/api/v5/market/candles',
      { instId: ticker, bar, limit: '300', ...(range.to ? { after: String(range.to + tfMs(timeframe)) } : {}) },
      opts?.signal,
    );
    for (const r of first) {
      const b = parseRow(r, ticker);
      if (b) map.set(b.time, b);
    }
    emit();
    let oldest = Math.min(...map.keys());
    let guard = 0;
    while (map.size < want && Number.isFinite(oldest) && guard++ < 160) {
      if (opts?.signal?.aborted) break;
      if (range.from && oldest <= range.from) break;
      let page: (string | number)[][] = [];
      try {
        page = await okxGet('/api/v5/market/history-candles', { instId: ticker, bar, after: String(oldest), limit: '100' }, opts?.signal);
      } catch {
        break;
      }
      if (!page.length) break;
      let added = 0;
      for (const r of page) {
        const b = parseRow(r, ticker);
        if (b && !map.has(b.time)) {
          map.set(b.time, b);
          added++;
        }
      }
      if (!added) break;
      oldest = Math.min(oldest, ...page.map(r => Number(r[0])));
      if (guard % 5 === 0) {
        emit();
        await new Promise(r => setTimeout(r, 120));
      }
    }
    return emit();
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const channel = `candle${toOkxBar(timeframe)}`;
    const bar = toOkxBar(timeframe);
    const marketKey = keyOf(ticker, timeframe);
    let ws: WebSocket | null = null;
    let stopped = false;
    let timer: number | null = null;
    let ping: number | null = null;
    let opened = false;

    /**
     * 重连补洞：OKX 的 candle 频道只推送订阅之后的变化，断线期间收盘的 K 线不会
     * 补发。旧实现重连后直接续订阅，barsHub 里就留下一个永久缺口；而信号标注
     * 只分析「最新缺口之后」的连续段（analyze.ts），缺口后不足 30 根时整块标注
     * 消失。这里在重连时用 REST 把最近 300 根合并回镜像，缺口即被填平。
     */
    const backfill = async () => {
      try {
        const page = await okxGet('/api/v5/market/candles', { instId: ticker, bar, limit: '300' });
        const fresh: OHLCV[] = [];
        for (const r of page) {
          const parsed = parseRow(r, ticker);
          if (parsed) fresh.push(parsed);
        }
        if (!fresh.length || stopped) return;
        merge(marketKey, fresh);
        const last = fresh[fresh.length - 1];
        if (last) onBar(last);
      } catch {
        // 补洞失败不阻塞重连；下一次重连会再试
      }
    };

    const open = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(WS);
      } catch {
        timer = window.setTimeout(open, 3000);
        return;
      }
      ws.onopen = () => {
        ws?.send(JSON.stringify({ op: 'subscribe', args: [{ channel, instId: ticker }] }));
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send('ping'), 20_000);
        if (opened) void backfill();
        opened = true;
      };
      ws.onmessage = ev => {
        if (ev.data === 'pong') return;
        try {
          const msg = JSON.parse(ev.data as string) as { arg?: { channel?: string }; data?: (string | number)[][] };
          if (msg.arg?.channel !== channel || !msg.data) return;
          const fresh: OHLCV[] = [];
          for (const r of msg.data) {
            const b = parseRow(r, ticker);
            if (b) {
              onBar(b);
              fresh.push(b);
            }
          }
          if (fresh.length) merge(keyOf(ticker, timeframe), fresh);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (ping) window.clearInterval(ping);
        if (!stopped) timer = window.setTimeout(open, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (ping) window.clearInterval(ping);
      ws?.close();
    };
  }
}
