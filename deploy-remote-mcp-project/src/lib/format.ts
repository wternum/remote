import { fmtClock, fmtDateTime as fmtBjDateTime } from "./displayTime";

export function priceDecimals(symbol: string): number {
  if (symbol.startsWith("BTC")) return 1;
  if (symbol.startsWith("ETH")) return 2;
  if (symbol.startsWith("SOL")) return 3;
  return 2;
}

export function fmtPrice(v: number | undefined | null, symbol = "BTC-USDT-SWAP"): string {
  if (v == null || Number.isNaN(v)) return "—";
  const d = priceDecimals(symbol);
  return v.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fmtVol(v: number): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return v.toFixed(0);
}

export function fmtNotional(v: number): string {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function fmtR(r: number | undefined | null): string {
  if (r == null || Number.isNaN(r)) return "—";
  return (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
}

export function fmtPct(p: number | undefined | null, digits = 1): string {
  if (p == null || Number.isNaN(p)) return "—";
  return (p >= 0 ? "+" : "") + p.toFixed(digits) + "%";
}

/** 北京时间 HH:MM（与图表时间轴一致，不随浏览器所在时区变化） */
export function fmtTime(ts: number): string {
  return fmtClock(ts);
}

/** 北京时间 MM-DD HH:MM */
export function fmtDateTime(ts: number): string {
  return fmtBjDateTime(ts);
}

export function fmtDurBars(bars: number, bar: string): string {
  const mins = bars * (bar === "15m" ? 15 : 5);
  if (mins < 60) return mins + " 分钟";
  return (mins / 60).toFixed(1) + " 小时";
}

export function agoText(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s 前";
  if (s < 3600) return Math.floor(s / 60) + "m 前";
  return Math.floor(s / 3600) + "h 前";
}

export const cn = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");
