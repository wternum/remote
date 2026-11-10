import type { OHLCV } from '@luxalgo/vela';
import { barsHub, tfMs } from './okxProvider';
import { flowPeriodOf, getFlow } from '@/quant/flow';
import { FRAMEWORK_MAX_BARS } from '@/quant/frameworks';
import { isClosedCandle } from '@/lib/okxCandles';
import { flowRecomputeKey, signalRecomputeKey } from './signals/recompute';
import type { Candle, VolumeSource } from '@/lib/types';

export interface FrameworkMarket {
  symbol: string;
  tf: string;
  barMs: number;
}

export const DEFAULT_FRAMEWORK_MARKET: FrameworkMarket = {
  symbol: 'BTC-USDT-SWAP',
  tf: '5',
  barMs: 300_000,
};

export const isSupportedFrameworkSymbol = (symbol: string) =>
  /^(BTC|ETH|SOL)-USDT-SWAP$/.test(symbol);

export function normalizeFrameworkMarket(symbol?: string, timeframe?: string): FrameworkMarket {
  const ticker = (symbol ?? '').replace(/^okx:/i, '');
  const tf = timeframe === '1D' ? 'D' : timeframe === '1W' ? 'W' : timeframe === '1M' ? 'M' : timeframe || DEFAULT_FRAMEWORK_MARKET.tf;
  return {
    symbol: ticker || DEFAULT_FRAMEWORK_MARKET.symbol,
    tf,
    barMs: tfMs(tf),
  };
}

export const toCandle = (b: OHLCV): Candle => {
  const x = b as OHLCV & { confirm?: 0 | 1; volumeSource?: VolumeSource };
  return {
    ts: b.time,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume ?? 0,
    confirm: x.confirm,
    volumeSource: x.volumeSource,
  };
};

/** Closed-bar fingerprint: forming-price ticks do not trigger structural recomputation. */
export function frameworkInputKey(raw: readonly OHLCV[], market: FrameworkMarket, now: number): string {
  const last = raw.at(-1);
  let closed: OHLCV | undefined;
  for (let i = raw.length - 1; i >= 0; i--) {
    const c = toCandle(raw[i]);
    if (c.ts < now && isClosedCandle(c, market.barMs, now)) {
      closed = raw[i];
      break;
    }
  }
  // 结构分析只用最近 FRAMEWORK_MAX_BARS 根：更早的历史分页陆续到达时不该触发重算（以前每来一页都全量重算一次，
  // 切换品种 / 周期后的十几秒里图表一卡一卡）
  const span = Math.min(raw.length, FRAMEWORK_MAX_BARS + 8);
  const base = signalRecomputeKey({
    marketKey: barsHub.key(market.symbol, market.tf),
    length: span,
    firstTs: raw[raw.length - span]?.time ?? 0,
    lastTs: last?.time ?? 0,
    prevClose: closed?.close,
    prevVolume: closed?.volume,
    closedOpen: closed?.open,
    closedHigh: closed?.high,
    closedLow: closed?.low,
    barMs: market.barMs,
    now,
    preview: false,
  });
  const confirm = closed ? (closed as OHLCV & { confirm?: 0 | 1 }).confirm ?? '' : '';
  const period = flowPeriodOf(market.tf);
  const flow = period ? getFlow(market.symbol, period) : undefined;
  const flowKey = flow ? flowRecomputeKey(flow, now, false, FRAMEWORK_MAX_BARS - 900) : '';
  return `${base}|${confirm}|${flowKey}`;
}
