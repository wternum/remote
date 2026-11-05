export interface Candle {
  ts: number;
  o: number;
  h: number;
  c: number;
  l: number;
  v: number;
}

export type Side = "long" | "short";
export type PatternId =
  | "db_reject" // W 双底 · 历史底部第二次测试拒绝
  | "dt_reject" // M 双顶 · 历史顶部第二次测试拒绝
  | "db_break" // W 双底 · 二次测试后颈线突破
  | "dt_break"; // M 双顶 · 二次测试后颈线跌破

// 历史顶部/底部关键位（图表横向区带）
export interface KeyLevel {
  from: number;
  to: number;
  price: number;
  side: "top" | "bottom";
  tested: boolean; // 已被第二次测试 = 已形成双顶/双底
  broken: boolean;
}

// 形态几何（点击信号时在图上绘制）
export interface GeoPoint {
  ts: number;
  price: number;
  label: string;
  pos: "above" | "below";
}
export interface SignalGeo {
  pts: GeoPoint[];
  path?: { ts: number; price: number }[];
  neck?: { from: number; to: number; price: number; label?: string };
}

export interface RawSignal {
  ts: number;
  side: Side;
  pattern: PatternId;
  entry: number;
  stop: number;
  tp: number;
  conf: number; // 0-100 综合置信度
  confl: number; // 0-100 订单流 confluence
  strength: number; // 0-100 形态强度
  note: string;
  tags?: string[]; // 结构确认要素
  geo?: SignalGeo;
  fill?: "close" | "limit"; // limit = 关键位挂单，信号K内成交
}

export type LiveStatus = "pending" | "active" | "won" | "lost" | "time";

export interface LiveSignal extends RawSignal {
  id: string;
  status: LiveStatus;
  entryPrice?: number;
  exitPrice?: number;
  r?: number;
  pnlPct?: number;
  hold?: number;
  exitReason?: string;
  filledTs?: number;
  exitTs?: number;
}

export interface FeedItem {
  id: string;
  ts: number;
  side: "long" | "short";
  pattern: string;
  entry: number;
  stop: number;
  tp: number;
  conf: number;
  confl: number;
  note: string;
  status: string;
  r?: number;
  pnlPct?: number;
  hold?: number;
  exitReason?: string;
  live?: boolean;
  tags?: string[];
  geo?: SignalGeo;
  entryTs?: number;
  exitTs?: number;
  exitPrice?: number;
}

export interface BookLevel {
  p: number;
  s: number;
}

export interface MarketData {
  live: boolean;
  /** 服务端历史 K 线存在缺根/未取满时为 true；UI 不应把这份数据当连续样本 */
  gapped?: boolean;
  symbol: string;
  bar: string;
  candles: Candle[];
  ticker: {
    last: number;
    open24: number;
    high24: number;
    low24: number;
    chg24: number;
    // 永续专属
    fundingRate?: number;
    nextFundingTime?: number;
    markPx?: number;
    ctVal?: number;
    vol24Quote?: number;
  };
  book: { bids: BookLevel[]; asks: BookLevel[] };
}

export interface TradedSignal {
  id: string;
  sym?: string;
  ts: number;
  side: Side;
  pattern: PatternId;
  entry: number;
  stop: number;
  tp: number;
  conf: number;
  confl: number;
  note?: string;
  tags?: string[];
  geo?: SignalGeo;
  status: "skipped" | "done";
  entryTs?: number;
  entryPrice?: number;
  exitPrice?: number;
  exitTs?: number;
  r?: number;
  pnlPct?: number;
  costR?: number;
  holdingBars?: number;
  // 保持与 remote 原始 summarize 的类型契约一致（tp/sl/time）。
  // 保本离场等更细的退出原因由 quant 层 Outcome.why 表达，并在记录上附加 exitWhy。
  exitReason?: "tp" | "sl" | "time";
}

export interface PatternStat {
  id: PatternId;
  label: string;
  short: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  totalR: number;
  grossWinR: number;
  grossLossR: number;
  pf: number;
  avgHold: number;
}

export interface HourDayStat {
  day: number;
  hour: number;
  n: number;
  avgR: number;
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
  bestR: number;
  worstR: number;
  // 盈亏统计
  grossWinR: number;
  grossLossR: number;
  avgWinR: number;
  avgLossR: number;
  payoff: number; // 平均盈利 / 平均亏损
  maxWinStreak: number;
  maxLossStreak: number;
  tpCount: number;
  slCount: number;
  timeCount: number;
  costR: number; // 手续费+滑点合计（R）
  netPct: number; // 单利累计 %
}

export interface BacktestResult {
  live: boolean;
  /** 只有真实且连续的行情才会生成统计；false 表示已 fail-closed 跳过计算 */
  dataReady?: boolean;
  gapped?: boolean;
  dataIssue?: string;
  scope: "single" | "all";
  symbol: string;
  bar: string;
  from: number;
  to: number;
  bars: number;
  generatedAt: number;
  params: {
    feeBps: number;
    slipBps: number;
    maxHold: number;
    flowFilter: boolean;
    confMin: number;
    riskUsd: number;
  };
  overall: OverallStat;
  bySide: { long: OverallStat; short: OverallStat };
  byPattern: PatternStat[];
  bySymbol: { symbol: string; stat: OverallStat }[];
  byHourDay: HourDayStat[];
  rDist: { label: string; from: number; n: number }[];
  equity: { ts: number; cumR: number }[];
  signals: TradedSignal[];
  strategy?: Record<string, number | boolean | string>; // 当前双顶/双底策略参数
}

export interface BigOrder {
  ts: number;
  px: number;
  sz: number;
  side: "buy" | "sell";
  notional: number;
}

// OKX USDT 本位永续合约（-SWAP）。ctVal = 每张合约对应的币数量，用于名义价值换算
export const SYMBOLS = [
  { id: "BTC-USDT-SWAP", base: "BTC", label: "BTC 永续", ctVal: 0.01, minTick: 0.1 },
  { id: "ETH-USDT-SWAP", base: "ETH", label: "ETH 永续", ctVal: 0.1, minTick: 0.01 },
  { id: "SOL-USDT-SWAP", base: "SOL", label: "SOL 永续", ctVal: 1, minTick: 0.01 },
] as const;

export function ctValOf(symbol: string): number {
  return SYMBOLS.find((s) => s.id === symbol)?.ctVal ?? 1;
}
export function symbolBase(symbol: string): string {
  return symbol.split("-")[0] ?? symbol;
}

export const BARS = ["5m", "15m"] as const;
export type BarId = (typeof BARS)[number];

export const barMs = (bar: string) =>
  bar === "15m" ? 900_000 : bar === "1m" ? 60_000 : 300_000;
