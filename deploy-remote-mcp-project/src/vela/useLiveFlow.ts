import { useEffect, useRef, useState } from 'react';
import { bigBiasOf, flowPeriodOf, getFlow } from '@/quant/flow';

export interface LiveFlowState {
  /** 十档盘口失衡度 (bid−ask)/(bid+ask)，无数据为 null */
  bookImb: number | null;
  /** 最近 120s 大单主动方向，无数据为 null */
  bigBias: number | null;
  /** 大单样本数（0 表示证据不足） */
  bigCount: number;
  /** 盘口是否获取失败（失败不沿用旧值，避免把过时盘口当实时证据） */
  bookStale: boolean;
}

const REST = 'https://www.okx.com';

/**
 * 实时订单流因子数据源（bookImbalance / tapeBias）。
 * 此前 TradePanel 调 runScan 时 live 恒为 undefined，导致三个 liveOnly 因子永远是 null；
 * 这里补齐数据：盘口走 OKX 公共 REST（允许跨域）20s 轮询，大单方向来自 flow.ts 的逐笔缓存。
 */
export function useLiveFlow(symbol: string, timeframe: string): LiveFlowState {
  const [state, setState] = useState<LiveFlowState>({ bookImb: null, bigBias: null, bigCount: 0, bookStale: false });
  const bookRef = useRef<{ imb: number | null; stale: boolean }>({ imb: null, stale: false });

  // 盘口：切换合约立即重取，之后 20s 一次
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`${REST}/api/v5/market/books?instId=${symbol}&sz=10`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { bids?: string[][]; asks?: string[][] }[] };
        const d = json.data?.[0];
        const sum = (rows?: string[][]) => (rows ?? []).reduce((s, r) => s + Number(r[1] ?? 0), 0);
        const sb = sum(d?.bids);
        const sa = sum(d?.asks);
        const imb = sb + sa > 0 ? (sb - sa) / (sb + sa) : null;
        bookRef.current = { imb, stale: imb == null };
      } catch {
        bookRef.current = { imb: null, stale: true };
      } finally {
        busy = false;
        if (alive) {
          const { imb, stale } = bookRef.current;
          setState(s => (s.bookImb === imb && s.bookStale === stale ? s : { ...s, bookImb: imb, bookStale: stale }));
        }
      }
    };
    void load();
    const t = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [symbol]);

  // 大单方向：flow.ts 的逐笔缓存每 5s 重算一次（120s 滚动窗口）
  useEffect(() => {
    const period = flowPeriodOf(timeframe);
    if (!symbol || !period) {
      setState(s => ({ ...s, bigBias: null, bigCount: 0 }));
      return;
    }
    const compute = () => {
      const snap = getFlow(symbol, period);
      const r = bigBiasOf(snap?.recent ?? []);
      setState(s => (s.bigBias === r.bias && s.bigCount === r.count ? s : { ...s, bigBias: r.bias, bigCount: r.count }));
    };
    compute();
    const t = window.setInterval(compute, 5000);
    return () => window.clearInterval(t);
  }, [symbol, timeframe]);

  return state;
}
