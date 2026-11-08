import type { Candle } from '@/lib/types';
import { atrSeries, approxDeltaAt } from '../../remote/setup-mcp-project-locally/src/lib/engine';
import { hasRealFlow, type FlowSnapshot } from './flow';

/** 扫描上下文：指标序列 + 订单流序列（真实优先，近似兜底） */
export interface Ctx {
  cs: Candle[];
  n: number;
  atr: number[];
  /** 主动买卖差（USDT）：真实主动成交覆盖处为 buy − sell，否则为 K 线形态近似 */
  delta: number[];
  /** 每根 delta 是否来自真实主动成交 */
  real: Uint8Array;
  /** 持仓量（优先合约张数；旧快照才回退 USD），无数据为 NaN */
  oi: number[];
  vols: number[];
  ema20: number[];
  ema50: number[];
  volMa: number[];
  index: Map<number, number>;
  /** 真实订单流覆盖根数 / 总根数 */
  flowCoverage: number;
}

function emaSeries(cs: Candle[], period: number) {
  const k = 2 / (period + 1);
  const out = new Array<number>(cs.length);
  let e = cs[0]?.c ?? 0;
  for (let i = 0; i < cs.length; i++) {
    e = i === 0 ? cs[i].c : cs[i].c * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function buildContext(cs: Candle[], flow?: FlowSnapshot | null): Ctx {
  const n = cs.length;
  const atr = atrSeries(cs);
  const delta = new Array<number>(n);
  const real = new Uint8Array(n);
  const oi = new Array<number>(n).fill(NaN);
  const vols = new Array<number>(n);
  const volMa = new Array<number>(n).fill(0);
  const index = new Map<number, number>();
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const fb = flow?.bars.get(cs[i].ts);
    if (hasRealFlow(fb, cs[i].v, cs[i].volumeSource)) {
      delta[i] = fb.buy - fb.sell;
      real[i] = 1;
      covered++;
    } else {
      delta[i] = approxDeltaAt(cs, i);
    }
    // Contract count measures position creation/closure without mixing in
    // price movement.  Keep the USD fallback only for legacy in-memory/test
    // snapshots created before oiContracts was introduced.
    const position = fb?.oiContracts && fb.oiContracts > 0 ? fb.oiContracts : fb?.oiUsd;
    if (position && position > 0) oi[i] = position;
    vols[i] = cs[i].v;
    index.set(cs[i].ts, i);
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    // 近 20 根均量（不含当前根）
    if (i >= 1) s += cs[i - 1].v;
    if (i >= 21) s -= cs[i - 21].v;
    const m = Math.min(i, 20);
    volMa[i] = m ? s / m : cs[i].v;
  }
  return {
    cs,
    n,
    atr,
    delta,
    real,
    oi,
    vols,
    ema20: emaSeries(cs, 20),
    ema50: emaSeries(cs, 50),
    volMa,
    index,
    flowCoverage: n ? covered / n : 0,
  };
}
