export function priceDecimals(base: string): number {
  if (base.startsWith("BTC")) return 1;
  if (base.startsWith("ETH")) return 2;
  return 3;
}

export function fmtPrice(v: number | undefined | null, base = "BTC"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = priceDecimals(base);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtNotional(v: number): string {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function fmtR(r: number | undefined | null): string {
  if (r == null || !Number.isFinite(r)) return "—";
  return (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0") +
    " " +
    fmtTime(ts)
  );
}
