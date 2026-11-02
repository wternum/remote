import { useEffect, useRef, useState } from 'react';
import { flowPeriodOf, getFlow, releaseTape, subscribeFlow, syncFlow, type FlowSnapshot } from '@/quant/flow';

export interface FlowState {
  snapshot: FlowSnapshot | null;
  /** 每次数据更新递增，用作重算依赖 */
  version: number;
  syncing: boolean;
  /** 当前周期不支持真实订单流 */
  unsupported: boolean;
}

/**
 * 跟随当前市场同步 OKX 真实主动买卖成交额 / 持仓量：
 * 首次加载回填到保留边界（约 4–5 天 5m），之后每根 K 线收盘只取最新一页。
 */
export function useFlow(symbol: string, timeframe: string, closedTs: number, oldestTs: number): FlowState {
  const [state, setState] = useState<FlowState>({ snapshot: null, version: 0, syncing: false, unsupported: false });
  const versionRef = useRef(0);

  useEffect(() => {
    const period = flowPeriodOf(timeframe);
    if (!symbol || !period) {
      setState(s => (s.unsupported && !s.snapshot ? s : { snapshot: null, version: ++versionRef.current, syncing: false, unsupported: true }));
      return;
    }
    const cached = getFlow(symbol, period) ?? null;
    setState({ snapshot: cached, version: ++versionRef.current, syncing: true, unsupported: false });
    let alive = true;
    const ac = new AbortController();
    const off = subscribeFlow(snap => {
      if (!alive || snap.instId !== symbol || snap.period !== period) return;
      setState({ snapshot: snap, version: ++versionRef.current, syncing: false, unsupported: false });
    });
    const t = window.setTimeout(() => {
      // 已完整回填过：只刷新最新 1 页；否则回填到图表最早 K 线或保留边界
      const pages = cached?.complete ? 1 : 16;
      void syncFlow(symbol, period, { minTs: oldestTs || 0, maxPages: pages, oiPages: cached?.complete ? 1 : 12, bootstrapPages: 220, bootstrapBars: period === '5m' ? 8 : 4, signal: ac.signal }).finally(() => {
        if (alive) setState(s => ({ ...s, syncing: false }));
      });
    }, 400);
    return () => {
      alive = false;
      ac.abort();
      window.clearTimeout(t);
      off();
    };
    // oldestTs 只在首次回填时有意义；closedTs 变化（新 K 线收盘）触发增量刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, closedTs]);

  // 切换合约时关闭旧合约的实时成交流
  useEffect(() => {
    return () => {
      if (symbol) releaseTape(symbol);
    };
  }, [symbol]);

  return state;
}
