import { useEffect, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import type { Candle } from '@/lib/types';
import { barsHub } from './okxProvider';

/** 跟随 Vela 图表当前市场的 K 线：来源是 OKXProvider 的镜像（即图表所见） */
export function useChartBars(getChart: () => Vela | null) {
  const [state, setState] = useState<{ candles: Candle[]; symbol: string; timeframe: string; closedTs: number; lastPx: number | null }>({
    candles: [],
    symbol: '',
    timeframe: '',
    closedTs: 0,
    lastPx: null,
  });
  const keyRef = useRef('');

  useEffect(() => {
    let alive = true;
    const unsub: (() => void)[] = [];
    let attached: Vela | null = null;

    const snapshot = (force = false) => {
      const chart = getChart();
      if (!chart || !alive) return;
      const m = chart.market;
      const ticker = (m.symbol ?? '').replace(/^okx:/i, '');
      const tf = m.timeframe ?? '';
      const bars = barsHub.get(ticker, tf);
      const last = bars[bars.length - 1];
      const closed = bars.length > 1 ? bars[bars.length - 2].time : 0;
      const key = `${ticker}|${tf}|${bars.length}|${closed}|${last?.close ?? ''}`;
      if (!force && key === keyRef.current) return;
      keyRef.current = key;
      setState({
        candles: bars.map(b => ({ ts: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 })),
        symbol: ticker,
        timeframe: tf,
        closedTs: closed,
        lastPx: last?.close ?? null,
      });
    };

    const attach = () => {
      const chart = getChart();
      if (!chart || chart === attached) return;
      attached = chart;
      unsub.push(chart.on('market:changed', () => snapshot(true)));
      unsub.push(chart.on('load:end', () => snapshot(true)));
      snapshot(true);
    };

    attach();
    unsub.push(barsHub.subscribe(() => snapshot()));
    const t = window.setInterval(() => {
      attach();
      snapshot();
    }, 1500);
    return () => {
      alive = false;
      window.clearInterval(t);
      unsub.forEach(f => f());
    };
  }, [getChart]);

  return state;
}
