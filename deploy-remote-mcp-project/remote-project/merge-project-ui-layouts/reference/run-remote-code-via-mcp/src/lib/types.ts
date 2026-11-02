export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = "long" | "short";
export type PatternId =
  | "db_reject" // W 双底 · 历史底部第二次测试拒绝
  | "dt_reject" // M 双顶 · 历史顶部第二次测试拒绝
  | "db_break" // W 双底 · 二次测试后颈线突破
  | "dt_break"; // M 双顶 · 二次测试后颈线跌破

export interface KeyLevel {
  from: number;
  to: number;
  price: number;
  side: "top" | "bottom";
  tested: boolean;
  broken: boolean;
}

export interface HistoricalReference {
  samples: number;
  wins: number;
  winRate: number | null;
}

export type FlowSource = "ohlcv" | "tape";

export interface RawSignal {
  ts: number;
  barIndex: number;
  side: Side;
  pattern: PatternId;
  entry: number;
  stop: number;
  tp: number;
  conf: number; // 规则评分（筛选用，不是预测胜率）
  baseConf: number;
  confl: number;
  flowSource: FlowSource;
  flowDelta?: number;
  flowTrades?: number;
  history?: HistoricalReference;
  strength: number;
  note: string;
  tags: string[];
  level?: { fromTs: number; toTs: number; price: number; label: string };
}

export type LiveStatus = "pending" | "active" | "won" | "lost" | "time" | "skipped";

export interface LiveSignal extends RawSignal {
  id: string;
  status: LiveStatus;
  entryPrice?: number;
  exitPrice?: number;
  r?: number;
  hold?: number;
  exitReason?: string;
  exitTs?: number;
}

export interface TradedSignal {
  id: string;
  ts: number;
  side: Side;
  pattern: PatternId;
  entry: number;
  stop: number;
  tp: number;
  conf: number;
  baseConf: number;
  confl: number;
  flowSource: FlowSource;
  history?: HistoricalReference;
  note: string;
  tags: string[];
  status: "skipped" | "done";
  entryTs?: number;
  entryPrice?: number;
  exitPrice?: number;
  exitTs?: number;
  r?: number;
  pnlPct?: number;
  holdingBars?: number;
  exitReason?: "tp" | "sl" | "time";
}

export interface OverallStat {
  signals: number;
  executed: number;
  skipped: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  totalR: number;
  pf: number;
  avgHold: number;
  maxDD: number;
  tpCount: number;
  slCount: number;
  timeCount: number;
  costR: number;
}

export interface PatternStat {
  id: PatternId;
  label: string;
  short: string;
  n: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
  pf: number;
}

export interface BacktestResult {
  symbol: string;
  bar: string;
  from: number;
  to: number;
  bars: number;
  generatedAt: number;
  flowFilter: boolean;
  overall: OverallStat;
  bySide: { long: OverallStat; short: OverallStat };
  byPattern: PatternStat[];
  signals: TradedSignal[];
}

export const SYMBOLS = [
  { id: "BTC-USDT-SWAP", ticker: "BTCUSDT", base: "BTC", label: "BTC 永续", ctVal: 0.01 },
  { id: "ETH-USDT-SWAP", ticker: "ETHUSDT", base: "ETH", label: "ETH 永续", ctVal: 0.1 },
  { id: "SOL-USDT-SWAP", ticker: "SOLUSDT", base: "SOL", label: "SOL 永续", ctVal: 1 },
] as const;

export const symbolOf = (ticker: string) =>
  SYMBOLS.find((s) => s.ticker === ticker.replace(/[-_].*$/, "")) ?? SYMBOLS[0];

export const barMs = (tf: string) => {
  const m = parseInt(tf, 10);
  if (Number.isFinite(m) && m > 0) return m * 60_000;
  if (tf.endsWith("D")) return 86_400_000;
  if (tf.endsWith("W")) return 604_800_000;
  return 300_000;
};
