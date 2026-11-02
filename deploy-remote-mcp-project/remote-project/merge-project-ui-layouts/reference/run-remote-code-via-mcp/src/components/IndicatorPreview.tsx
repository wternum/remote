import { useId } from "react";
import type { Candle } from "../lib/types";
import type { PreviewKind } from "../lib/indicator-catalog";

function average(values: number[], length: number, exponential = false) {
  let previous = values[0];
  return values.map((v, i) => {
    if (exponential) {
      previous =
        i === 0
          ? v
          : v * (2 / (length + 1)) + previous * (1 - 2 / (length + 1));
      return previous;
    }
    const window = values.slice(Math.max(0, i - length + 1), i + 1);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
}

/** Price/volume previews use actual loaded candles; simplified overlays are labelled as previews. */
export default function IndicatorPreview({
  bars,
  kind,
  large = false,
}: {
  bars: readonly Candle[];
  kind: PreviewKind;
  large?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const data = bars.slice(-62);
  if (data.length < 8)
    return (
      <div className="ib-preview-empty">
        <span />
        <span />
        <span />
        <small>等待行情预览</small>
      </div>
    );
  const w = 360;
  const h = large ? 224 : 170;
  const volume = kind === "volume";
  const oscillator = kind === "momentum";
  const profile = kind === "profile";
  const plotTop = 17;
  const plotBottom = oscillator ? h * 0.59 : h - 25;
  const min = Math.min(...data.map((c) => c.l));
  const max = Math.max(...data.map((c) => c.h));
  const span = max - min || 1;
  const x = (i: number) => 14 + i * ((w - 30) / data.length);
  const y = (v: number) =>
    plotBottom - ((v - min) / span) * (plotBottom - plotTop);
  const close = data.map((b) => b.c);
  const slow = average(close, 20);
  const fast = average(close, 9, true);
  const path = (points: number[]) =>
    points
      .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`)
      .join(" ");
  const bands = slow.map((v, i) => {
    const window = close.slice(Math.max(0, i - 19), i + 1);
    return (
      Math.sqrt(window.reduce((s, n) => s + (n - v) ** 2, 0) / window.length) *
      1.65
    );
  });
  const maxVolume = Math.max(1, ...data.map((b) => b.v));
  const upper = slow.map((v, i) => v + bands[i]);
  const lower = slow.map((v, i) => v - bands[i]);
  const bandPath = `${path(upper)} ${lower.map((_, i) => `L${x(lower.length - 1 - i).toFixed(1)},${y(lower[lower.length - 1 - i]).toFixed(1)}`).join(" ")} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`ib-preview${large ? " ib-preview-large" : ""}`}
      role="img"
      aria-label="当前行情指标示意预览"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`shade-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#4d8bd6" stopOpacity=".14" />
          <stop offset="1" stopColor="#4d8bd6" stopOpacity=".02" />
        </linearGradient>
        <clipPath id={`clip-${id}`}>
          <rect width={w} height={h} />
        </clipPath>
      </defs>
      <rect width={w} height={h} fill="#15171a" />
      <g stroke="#292c32" strokeWidth=".7" opacity=".68">
        {[1, 2, 3, 4].map((n) => (
          <path key={n} d={`M0 ${(h * n) / 5}H${w}M${(w * n) / 5} 0V${h}`} />
        ))}
      </g>
      <g clipPath={`url(#clip-${id})`}>
        {kind === "bands" && (
          <>
            <path d={bandPath} fill={`url(#shade-${id})`} />
            <path
              d={path(upper)}
              fill="none"
              stroke="#6888c5"
              strokeWidth="1.1"
              opacity=".9"
            />
            <path
              d={path(lower)}
              fill="none"
              stroke="#6888c5"
              strokeWidth="1.1"
              opacity=".9"
            />
            <path d={path(slow)} fill="none" stroke="#bb9b4a" strokeWidth="1" />
          </>
        )}
        {profile &&
          Array.from({ length: 17 }, (_, i) => {
            const bandBottom = min + (span / 17) * i;
            const total = data
              .filter((c) => c.c >= bandBottom && c.c < bandBottom + span / 17)
              .reduce((s, c) => s + c.v, 0);
            return (
              <rect
                key={i}
                x={0}
                y={y(bandBottom) - (plotBottom - plotTop) / 17}
                width={Math.min(94, (total / maxVolume) * 19 + 5)}
                height={(plotBottom - plotTop) / 17 - 1}
                fill={i % 3 ? "#c18a32" : "#4283b9"}
                opacity=".62"
              />
            );
          })}
        {data.map((b, i) => {
          const color = b.c >= b.o ? "#0fa985" : "#ef4057";
          const bodyTop = Math.min(y(b.o), y(b.c));
          return (
            <g key={b.ts}>
              <path
                d={`M${x(i)} ${y(b.h)}V${y(b.l)}`}
                stroke={color}
                strokeWidth="1"
              />
              <rect
                x={x(i) - 1.65}
                y={bodyTop}
                width={3.3}
                height={Math.max(1.3, Math.abs(y(b.o) - y(b.c)))}
                fill={color}
              />
              {(volume || !oscillator) && (
                <rect
                  x={x(i) - 1.7}
                  y={h - 7 - (b.v / maxVolume) * (volume ? 54 : 19)}
                  width={3.4}
                  height={(b.v / maxVolume) * (volume ? 54 : 19)}
                  fill={color}
                  opacity={volume ? ".68" : ".22"}
                />
              )}
            </g>
          );
        })}
        {kind === "average" && (
          <>
            <path
              d={path(slow)}
              fill="none"
              stroke="#c5a264"
              strokeWidth="1.5"
            />
            <path
              d={path(fast)}
              fill="none"
              stroke="#6a9cce"
              strokeWidth="1.1"
            />
          </>
        )}
        {kind === "structure" && (
          <>
            {[15, 36].map((i) => (
              <g key={i}>
                <path
                  d={`M${x(i - 6)} ${y(data[i].h)}H${x(Math.min(data.length - 1, i + 18))}`}
                  stroke={i === 15 ? "#dc8b4e" : "#3f97bc"}
                  strokeWidth="1"
                  strokeDasharray="3 2"
                />
                <circle cx={x(i)} cy={y(data[i].h)} r="2.8" fill="#ed6575" />
              </g>
            ))}
            <path
              d={`M${x(9)} ${y(data[9].l)} ${[20, 31, 43, 54].map((i) => `L${x(i)} ${y(i % 2 ? data[i].l : data[i].h)}`).join(" ")}`}
              fill="none"
              stroke="#92bda7"
              strokeWidth="1.2"
              opacity=".8"
            />
          </>
        )}
        {oscillator && (
          <>
            <path
              d={`M0 ${h * 0.71}H360M0 ${h * 0.92}H360`}
              stroke="#454150"
              strokeDasharray="3 4"
              strokeWidth=".6"
            />
            <path
              d={fast
                .map(
                  (v, i) =>
                    `${i ? "L" : "M"}${x(i)},${h * 0.82 - ((v - slow[i]) / span) * h * 1.25}`,
                )
                .join(" ")}
              stroke="#a092d8"
              fill="none"
              strokeWidth="1.7"
            />
          </>
        )}
      </g>
      <text
        x="13"
        y={h - 4}
        fill="#6c717d"
        fontSize="7.2"
        fontFamily="sans-serif"
        opacity=".7"
      >
        PULSEDESK / PREVIEW
      </text>
    </svg>
  );
}
