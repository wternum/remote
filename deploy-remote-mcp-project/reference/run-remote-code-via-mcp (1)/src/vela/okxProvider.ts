import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';

// ─────────────────────────────────────────────────────────────
//  OKX 永续 DataProvider：历史分页 REST + 公共 WebSocket 实时 K 线
//  · 与远程项目同一数据源（OKX），但走 Vela 的 provider 契约
//  · 浏览器直连；OKX 公共接口允许跨域
// ─────────────────────────────────────────────────────────────

const REST = 'https://www.okx.com';
const WS = 'wss://ws.okx.com:8443/ws/v5/business';

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

const SWAPS: SymbolDescriptor[] = [
  { ticker: 'BTC-USDT-SWAP', description: 'Bitcoin / USDT 永续', type: 'swap' },
  { ticker: 'ETH-USDT-SWAP', description: 'Ethereum / USDT 永续', type: 'swap' },
  { ticker: 'SOL-USDT-SWAP', description: 'Solana / USDT 永续', type: 'swap' },
  { ticker: 'XRP-USDT-SWAP', description: 'XRP / USDT 永续', type: 'swap' },
  { ticker: 'DOGE-USDT-SWAP', description: 'Dogecoin / USDT 永续', type: 'swap' },
  { ticker: 'BNB-USDT-SWAP', description: 'BNB / USDT 永续', type: 'swap' },
  { ticker: 'ADA-USDT-SWAP', description: 'Cardano / USDT 永续', type: 'swap' },
  { ticker: 'AVAX-USDT-SWAP', description: 'Avalanche / USDT 永续', type: 'swap' },
  { ticker: 'LINK-USDT-SWAP', description: 'Chainlink / USDT 永续', type: 'swap' },
  { ticker: 'SUI-USDT-SWAP', description: 'Sui / USDT 永续', type: 'swap' },
  { ticker: 'LTC-USDT-SWAP', description: 'Litecoin / USDT 永续', type: 'swap' },
  { ticker: 'TON-USDT-SWAP', description: 'Toncoin / USDT 永续', type: 'swap' },
];

const TICK: Record<string, number> = { BTC: 0.1, ETH: 0.01, SOL: 0.01, XRP: 0.0001, DOGE: 0.00001, BNB: 0.01, ADA: 0.0001, AVAX: 0.001, LINK: 0.001, SUI: 0.0001, LTC: 0.01, TON: 0.001 };

function parseRow(r: (string | number)[]): OHLCV | null {
  if (!Array.isArray(r) || r.length < 6) return null;
  const [t, o, h, l, c, vol, volCcy, volQuote] = r.map(Number);
  if (![t, o, h, l, c].every(Number.isFinite)) return null;
  const v = Number.isFinite(volQuote) && volQuote > 0 ? volQuote : Number.isFinite(volCcy) && volCcy > 0 ? volCcy * c : (vol || 0) * c;
  return { time: t, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 };
}

async function okxGet(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<(string | number)[][]> {
  const url = new URL(REST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url.toString(), { signal, cache: 'no-store' });
    if (res.status === 429) {
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

function merge(key: string, incoming: OHLCV[]) {
  const cur = store.get(key) ?? [];
  if (!incoming.length) return;
  const map = new Map<number, OHLCV>();
  for (const b of cur) map.set(b.time, b);
  for (const b of incoming) map.set(b.time, b);
  const next = [...map.values()].sort((a, b) => a.time - b.time).slice(-12_000);
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
    return {
      ticker,
      description: SWAPS.find(s => s.ticker === ticker)?.description ?? ticker,
      type: 'swap',
      currency: 'USDT',
      pricescale: Math.round(1 / (TICK[base] ?? 0.01)),
      minmove: 1,
      timezone: 'Etc/UTC',
    } as unknown as SymbolInfo;
  }

  resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
    const base = symbol.ticker.split('-')[0]?.toLowerCase();
    return base ? `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${base}.png` : undefined;
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
    const emit = () => {
      const out = snapshot();
      merge(keyOf(ticker, timeframe), out);
      onBatch(out);
      return out;
    };
    const first = await okxGet(
      '/api/v5/market/candles',
      { instId: ticker, bar, limit: '300', ...(range.to ? { after: String(range.to + tfMs(timeframe)) } : {}) },
      opts?.signal,
    );
    for (const r of first) {
      const b = parseRow(r);
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
        const b = parseRow(r);
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
    let ws: WebSocket | null = null;
    let stopped = false;
    let timer: number | null = null;
    let ping: number | null = null;

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
      };
      ws.onmessage = ev => {
        if (ev.data === 'pong') return;
        try {
          const msg = JSON.parse(ev.data as string) as { arg?: { channel?: string }; data?: (string | number)[][] };
          if (msg.arg?.channel !== channel || !msg.data) return;
          const fresh: OHLCV[] = [];
          for (const r of msg.data) {
            const b = parseRow(r);
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
