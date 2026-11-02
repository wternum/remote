import type { CSSProperties } from "react";

const paths: Record<string, string> = {
  search: "m21 21-4.4-4.4 M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6",
  close: "m6 6 12 12M6 18 18 6",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 4 4L19 6",
  trend: "m3 17 6-6 4 4 8-10M15 5h6v6",
  momentum: "m3 13 4-5 5 10 5-13 4 6",
  volume: "M5 20V9M12 20V4M19 20V12",
  volatility: "M3 12c3-12 5 12 9 0s6 12 9 0",
  grid: "M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z",
  layers: "m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5",
  compass: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0Zm-6-3-2 4-4 2 2-4Z",
  structure: "M4 17V7h6v10Zm10 0V4h6v13ZM2 21h20",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  info: "M12 11v6m0-10v1M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  keyboard: "M3 5h18v14H3ZM6 9h1m3 0h1m3 0h1m3 0h.1M7 15h10",
  chart: "M3 3v18h18M6 13l4-5 4 6 6-10",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3",
};

export default function Icon({
  name,
  size = 18,
  filled = false,
  className,
  style,
}: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={paths[name] ?? paths.chart} />
    </svg>
  );
}
