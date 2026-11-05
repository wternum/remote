"use client";
import { useState, useMemo } from "react";
import { BigOrder, BacktestResult, FeedItem } from "@/lib/types";
import { PATTERN_META } from "@/lib/engine";
import { fmtPrice, fmtTime, fmtR, fmtNotional, fmtDateTime, cn } from "@/lib/format";

interface Props {
  symbol: string;
  liveSignals: FeedItem[];
  historySignals: FeedItem[];
  focusedId: string | null;
  onFocus: (item: FeedItem) => void;
  // Order flow props
  cvd: { ts: number; v: number }[];
  bucket: { buy: number; sell: number };
  bookImb: number | null;
  bigOrders: BigOrder[];
  hasTape: boolean;
  // Quick stats props
  bt: BacktestResult | null;
  onOpenDrawer: () => void;
}

function ConfRing({ v, size = 32 }: { v: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = v >= 75 ? "#2ebd85" : v >= 58 ? "#37c8dd" : "#8c96ab";
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1d2534" strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(100, v) / 100)}
        className="transition-all duration-500"
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="rotate-90"
        transform={`rotate(90 ${size / 2} ${size / 2})`}
        style={{ fill: color, fontSize: 10, fontWeight: 700, fontFamily: "IBM Plex Mono, monospace" }}
      >
        {v}
      </text>
    </svg>
  );
}

function Sparkline({ points, w = 140, h = 34 }: { points: number[]; w?: number; h?: number }) {
  if (points.length < 2) {
    return <div className="h-[34px] w-full rounded bg-[#141a27] text-center text-[10px] leading-[34px] text-[#5b6579]">等待数据…</div>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - 3 - ((p - min) / span) * (h - 6);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  const color = up ? "#2ebd85" : "#f6465d";
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={path + ` L${w},${h} L0,${h} Z`} fill={up ? "rgba(46,189,133,0.12)" : "rgba(246,70,93,0.12)"} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: "待触发", cls: "bg-[#f0b90b]/15 text-[#f0b90b] border border-[#f0b90b]/30" },
  active: { text: "跟踪中", cls: "bg-[#37c8dd]/15 text-[#37c8dd] border border-[#37c8dd]/30" },
  won: { text: "止盈", cls: "bg-[#2ebd85]/15 text-[#2ebd85] border border-[#2ebd85]/30" },
  lost: { text: "止损", cls: "bg-[#f6465d]/15 text-[#f6465d] border border-[#f6465d]/30" },
  time: { text: "超时", cls: "bg-[#8c96ab]/15 text-[#8c96ab] border border-[#8c96ab]/30" },
  done: { text: "结算", cls: "bg-[#8c96ab]/15 text-[#8c96ab]" },
};

export default function CommandDeck({
  symbol,
  liveSignals,
  historySignals,
  focusedId,
  onFocus,
  cvd,
  bucket,
  bookImb,
  bigOrders,
  hasTape,
  bt,
  onOpenDrawer,
}: Props) {
  const [tab, setTab] = useState<"signals" | "flow" | "summary">("signals");
  const [sideFilter, setSideFilter] = useState<"all" | "double" | "long" | "short">("all");
  const [sourceFilter, setSourceFilter] = useState<"live" | "history">("live");

  const displaySignals = useMemo(() => {
    const list = sourceFilter === "live" ? liveSignals : historySignals;
    if (sideFilter === "all") return list;
    if (sideFilter === "double") return list.filter((s) => PATTERN_META[s.pattern as keyof typeof PATTERN_META]?.family === "double");
    return list.filter((s) => s.side === sideFilter);
  }, [sourceFilter, liveSignals, historySignals, sideFilter]);

  const riskUsd = bt?.params.riskUsd ?? 100;
  const listStats = useMemo(() => {
    const settled = displaySignals.filter((s) => s.r != null);
    const wins = settled.filter((s) => (s.r ?? 0) > 0);
    const grossWin = wins.reduce((a, s) => a + (s.r ?? 0), 0);
    const grossLoss = Math.abs(settled.filter((s) => (s.r ?? 0) <= 0).reduce((a, s) => a + (s.r ?? 0), 0));
    return {
      n: settled.length,
      wins: wins.length,
      losses: settled.length - wins.length,
      winRate: settled.length ? (wins.length / settled.length) * 100 : 0,
      grossWin,
      grossLoss,
      net: grossWin - grossLoss,
      open: displaySignals.length - settled.length,
    };
  }, [displaySignals]);

  // Order flow metrics
  const cvdNow = cvd.length ? cvd[cvd.length - 1].v : 0;
  const cvdSpark = useMemo(() => cvd.slice(-60).map((p) => p.v), [cvd]);
  const total = bucket.buy + bucket.sell;
  const buyPct = total > 0 ? (bucket.buy / total) * 100 : 50;
  const imb = bookImb ?? 0;
  const bidPct = bookImb == null ? 50 : ((1 + imb) / 2) * 100;
  const fillLeft = imb >= 0 ? 50 - imb * 50 : 50 - Math.abs(imb) * 50;

  return (
    <div className="panel flex h-full flex-col overflow-hidden border border-[#1d2534] bg-[#10151f]/95 shadow-xl">
      {/* 顶部 Tab 导航 */}
      <div className="flex items-center border-b border-[#1d2534] bg-[#0d1119] p-1.5">
        <button
          onClick={() => setTab("signals")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-semibold transition-all",
            tab === "signals"
              ? "bg-[#18202f] text-[#37c8dd] shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
              : "text-[#8c96ab] hover:text-[#e7ecf5]",
          )}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          信号流
          {liveSignals.length > 0 && (
            <span className="mono rounded bg-[#37c8dd]/20 px-1 text-[9px] font-bold text-[#37c8dd]">
              {liveSignals.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setTab("flow")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-semibold transition-all",
            tab === "flow"
              ? "bg-[#18202f] text-[#37c8dd] shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
              : "text-[#8c96ab] hover:text-[#e7ecf5]",
          )}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          订单流
        </button>

        <button
          onClick={() => setTab("summary")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-semibold transition-all",
            tab === "summary"
              ? "bg-[#18202f] text-[#37c8dd] shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
              : "text-[#8c96ab] hover:text-[#e7ecf5]",
          )}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
          简报
        </button>
      </div>

      <div className="border-b border-[#1d2534] bg-[#37c8dd]/[0.04] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#37c8dd]">
          <span className="rounded bg-[#37c8dd]/15 px-1 py-0.5">核心策略</span>
          <span>W 双底做多 · M 双顶做空</span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[#8c96ab]">
          历史顶部/底部自动成为关键位；价格第二次回到等高/等低区挂单入场，止损放在形态外，目标看颈线；强逆势不做。其它策略已全部移除。
        </p>
      </div>

      {/* ── TAB 1: 信号流 ── */}
      {tab === "signals" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 子过滤条 */}
          <div className="flex flex-wrap items-center justify-between gap-1 border-b border-[#1d2534] bg-[#0d1119]/50 px-3 py-1.5">
            <div className="flex items-center gap-1">
              {(
                [
                  ["live", "实时 LIVE"],
                  ["history", "回测历史"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSourceFilter(k)}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-semibold",
                    sourceFilter === k ? "bg-[#37c8dd]/20 text-[#37c8dd]" : "text-[#5b6579] hover:text-[#8c96ab]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              {(
                [
                  ["all", "全部"],
                  ["long", "双底·多"],
                  ["short", "双顶·空"],
                ] as const
              ).map(([s, label]) => (
                <button
                  key={s}
                  onClick={() => setSideFilter(s)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[9px] font-semibold",
                    sideFilter === s ? "bg-[#1a2334] text-[#e7ecf5]" : "text-[#5b6579] hover:text-[#8c96ab]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 胜率 & 盈亏统计条（跟随当前筛选） */}
          <div className="grid grid-cols-4 gap-px border-b border-[#1d2534] bg-[#1d2534] text-center">
            {[
              {
                k: "胜率",
                v: listStats.n ? listStats.winRate.toFixed(0) + "%" : "—",
                sub: `${listStats.wins}胜 ${listStats.losses}负`,
                c: listStats.winRate >= 50 ? "text-[#2ebd85]" : "text-[#f0b90b]",
              },
              {
                k: "总盈利",
                v: "+" + listStats.grossWin.toFixed(1) + "R",
                sub: "+" + Math.round(listStats.grossWin * riskUsd) + " U",
                c: "text-[#2ebd85]",
              },
              {
                k: "总亏损",
                v: "-" + listStats.grossLoss.toFixed(1) + "R",
                sub: "-" + Math.round(listStats.grossLoss * riskUsd) + " U",
                c: "text-[#f6465d]",
              },
              {
                k: "净盈亏",
                v: fmtR(listStats.net),
                sub: (listStats.net >= 0 ? "+" : "") + Math.round(listStats.net * riskUsd) + " U",
                c: listStats.net >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]",
              },
            ].map((x) => (
              <div key={x.k} className="bg-[#10151f] px-1 py-1.5">
                <div className="text-[9px] text-[#5b6579]">{x.k}</div>
                <div className={cn("mono text-[12px] font-bold", x.c)}>{x.v}</div>
                <div className="mono text-[9px] text-[#5b6579]">{x.sub}</div>
              </div>
            ))}
          </div>
          {listStats.open > 0 && (
            <div className="border-b border-[#1d2534] bg-[#37c8dd]/5 px-3 py-1 text-[10px] text-[#37c8dd]">
              {listStats.open} 笔信号跟踪中（未计入统计）
            </div>
          )}

          {/* 信号列表 */}
          <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
            {displaySignals.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5b6579" strokeWidth="1.5">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-[11px] text-[#8c96ab]">
                  {sourceFilter === "live" ? "等待价格第二次回到历史顶部/底部关键位…" : "当前筛选下无历史信号"}
                </div>
                <div className="max-w-[230px] text-[10px] leading-relaxed text-[#5b6579]">
                  {sourceFilter === "live" ? "图上绿色/红色横带为当前有效的底部/顶部，第二次测试时自动生成双底/双顶信号" : "试试切换筛选条件"}
                </div>
              </div>
            ) : (
              displaySignals.map((item) => {
                const meta = PATTERN_META[item.pattern as keyof typeof PATTERN_META];
                const stKey =
                  item.status === "done"
                    ? item.exitReason === "time"
                      ? "time"
                      : (item.r ?? 0) > 0
                        ? "won"
                        : "lost"
                    : item.status;
                const st = STATUS_LABEL[stKey] ?? STATUS_LABEL.done;
                const long = item.side === "long";
                const isFocused = focusedId === item.id;
                const rr = Math.abs((item.tp - item.entry) / (item.entry - item.stop || 1));
                return (
                  <div
                    key={item.id}
                    onClick={() => onFocus(item)}
                    className={cn(
                      "relative cursor-pointer rounded-lg border p-2.5 transition-all duration-150",
                      isFocused
                        ? "border-[#37c8dd] bg-[#151d2c] shadow-[0_0_12px_rgba(55,200,221,0.2)]"
                        : "border-[#1d2534] bg-[#141a27] hover:border-[#273245] hover:bg-[#18202f]",
                    )}
                    style={{ borderLeftWidth: 3, borderLeftColor: long ? "#2ebd85" : "#f6465d" }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-bold",
                          long ? "bg-[#2ebd85]/20 text-[#2ebd85]" : "bg-[#f6465d]/20 text-[#f6465d]",
                        )}
                      >
                        {long ? "多" : "空"}
                      </span>
                      <span className="truncate text-[12px] font-semibold text-[#e7ecf5]">{meta?.label ?? item.pattern}</span>
                      {item.live && (
                        <span className="rounded bg-[#37c8dd]/20 px-1 py-px text-[9px] font-semibold text-[#37c8dd]">LIVE</span>
                      )}
                      <span className={cn("ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold", st.cls)}>{st.text}</span>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                      <span className={cn("mono rounded px-1 py-px", isFocused ? "bg-[#37c8dd]/20 text-[#37c8dd]" : "bg-[#0d1119] text-[#8c96ab]")}>
                        ◆ 信号K {fmtDateTime(item.ts)}
                      </span>
                      {item.r != null && (
                        <span className={cn("mono ml-auto text-[12px] font-bold", item.r >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>
                          {fmtR(item.r)}
                          <span className="ml-1 text-[9px] font-normal text-[#5b6579]">
                            {(item.r >= 0 ? "+" : "") + Math.round(item.r * riskUsd)}U
                          </span>
                        </span>
                      )}
                    </div>

                    <div className="mono mt-1.5 grid grid-cols-4 gap-1 rounded bg-[#0d1119]/80 px-2 py-1 text-[10px]">
                      <div>
                        <div className="text-[9px] text-[#5b6579]">入场</div>
                        <div className="text-[#f0b90b]">{fmtPrice(item.entry, symbol)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-[#5b6579]">止损</div>
                        <div className="text-[#f6465d]">{fmtPrice(item.stop, symbol)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-[#5b6579]">目标</div>
                        <div className="text-[#2ebd85]">{fmtPrice(item.tp, symbol)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] text-[#5b6579]">R:R</div>
                        <div className="font-semibold text-[#37c8dd]">1:{rr.toFixed(1)}</div>
                      </div>
                    </div>

                    <div className="mt-1.5 flex items-start gap-2">
                      <ConfRing v={item.conf} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] leading-snug text-[#8c96ab]" title={item.note}>
                          {item.note}
                        </div>
                        {item.tags && item.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.tags.slice(0, 5).map((t) => (
                              <span
                                key={t}
                                className={cn(
                                  "rounded px-1 py-px text-[9px]",
                                  /缩量|衰竭|承接|抛压|主动|放量|翻正|翻负|卖压弱|买盘弱/.test(t)
                                    ? "bg-[#37c8dd]/10 text-[#37c8dd]"
                                    : /顺势/.test(t)
                                      ? "bg-[#2ebd85]/10 text-[#2ebd85]"
                                      : /逆势|被套|失败/.test(t)
                                        ? "bg-[#f0b90b]/10 text-[#f0b90b]"
                                        : "bg-[#1a2334] text-[#8c96ab]",
                                )}
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="mono mt-0.5 text-[9px] text-[#5b6579]">订单流共振 {item.confl}/100</div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── TAB 2: 订单流雷达 ── */}
      {tab === "flow" && (
        <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {/* CVD 会话动量 */}
          <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-3">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8c96ab]">
                CVD 会话累计主动量
              </span>
              <span
                className={cn(
                  "mono text-[13px] font-bold",
                  cvdNow >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]",
                )}
              >
                {cvdNow >= 0 ? "+" : ""}
                {Math.abs(cvdNow) >= 1000 ? (cvdNow / 1000).toFixed(1) + "K" : cvdNow.toFixed(1)}
              </span>
            </div>
            <Sparkline points={cvdSpark} />
            <div className="mt-1 flex justify-between text-[9px] text-[#5b6579]">
              <span>近 60 根窗口</span>
              <span>{cvdNow >= 0 ? "主动买入占优" : "主动卖出占优"}</span>
            </div>
          </div>

          {/* 实时盘口失衡 (5档深度) */}
          <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8c96ab]">
                盘口深度失衡 (5档)
              </span>
              <span
                className={cn(
                  "mono text-[11px] font-bold",
                  imb > 0.05 ? "text-[#2ebd85]" : imb < -0.05 ? "text-[#f6465d]" : "text-[#8c96ab]",
                )}
              >
                {bookImb == null ? "—" : (imb > 0 ? "+" : "") + (imb * 100).toFixed(0)}
              </span>
            </div>
            <div className="gauge-track">
              <div
                className="gauge-fill"
                style={{
                  left: fillLeft + "%",
                  width: Math.max(5, Math.abs(50 - fillLeft)) + "%",
                  background: imb >= 0 ? "rgba(46,189,133,0.85)" : "rgba(246,70,93,0.85)",
                }}
              />
              <div className="absolute inset-y-[-2px] left-1/2 w-px bg-white/30" />
            </div>
            <div className="mono mt-1.5 flex justify-between text-[10px]">
              <span className="text-[#2ebd85]">买盘 {bidPct.toFixed(0)}%</span>
              <span className="text-[#f6465d]">卖盘 {(100 - bidPct).toFixed(0)}%</span>
            </div>
          </div>

          {/* 本根主动量比例 */}
          <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-3">
            <div className="mb-1 flex items-baseline justify-between text-[10px]">
              <span className="font-semibold uppercase tracking-wider text-[#8c96ab]">
                当前 K 线主动成交
              </span>
              <span className="mono text-[#e7ecf5]">{fmtNotional(total)}</span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded bg-[#1a2233]">
              <div
                className="absolute inset-y-0 left-0 bg-[#2ebd85]/80 transition-all duration-300"
                style={{ width: buyPct + "%" }}
              />
              <div
                className="absolute inset-y-0 bg-[#f6465d]/80 transition-all duration-300"
                style={{ left: buyPct + "%", right: 0 }}
              />
            </div>
            <div className="mono mt-1 flex justify-between text-[10px]">
              <span className="text-[#2ebd85]">主动买 {buyPct.toFixed(0)}%</span>
              <span className="text-[#f6465d]">主动卖 {(100 - buyPct).toFixed(0)}%</span>
            </div>
          </div>

          {/* 大单监控 */}
          <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8c96ab]">
                大单成交监控 (&gt;8× 中位数)
              </span>
              <span className="text-[9px] text-[#5b6579]">
                {hasTape ? "实时成交带" : "等待推送"}
              </span>
            </div>
            {bigOrders.length === 0 ? (
              <div className="rounded bg-[#0d1119] p-2 text-center text-[10px] text-[#5b6579]">
                暂无大单触发
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {bigOrders.slice(0, 4).map((o, i) => (
                  <div
                    key={o.ts + "-" + i}
                    className="flex items-center justify-between rounded bg-[#0d1119] px-2 py-1 text-[10px]"
                  >
                    <span
                      className={cn(
                        "rounded px-1.5 py-px text-[9px] font-bold",
                        o.side === "buy" ? "bg-[#2ebd85]/20 text-[#2ebd85]" : "bg-[#f6465d]/20 text-[#f6465d]",
                      )}
                    >
                      {o.side === "buy" ? "买入" : "卖出"}
                    </span>
                    <span className="mono font-semibold text-[#e7ecf5]">
                      {fmtNotional(o.notional)}
                    </span>
                    <span className="mono text-[#8c96ab]">{fmtPrice(o.px, symbol)}</span>
                    <span className="mono text-[9px] text-[#5b6579]">{fmtTime(o.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── TAB 3: 策略简报 ── */}
      {tab === "summary" && (
        <div className="flex min-h-0 flex-1 flex-col justify-between p-3">
          <div className="flex flex-col gap-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8c96ab]">
              回测核心指标 (1500根K线)
            </div>

            {bt?.dataReady === false && (
              <div className="col-span-2 rounded border border-[#f0b90b]/30 bg-[#f0b90b]/[0.06] px-2.5 py-2 text-[10px] leading-relaxed text-[#f0b90b]">
                {bt.dataIssue ?? '行情数据不完整，本次未生成回测统计；请稍后刷新。'}
              </div>
            )}
            {bt ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-2.5">
                  <div className="text-[9px] text-[#5b6579]">执行胜率</div>
                  <div
                    className={cn(
                      "mono text-[16px] font-bold",
                      bt.overall.winRate >= 50 ? "text-[#2ebd85]" : "text-[#e7ecf5]",
                    )}
                  >
                    {bt.overall.winRate.toFixed(1)}%
                  </div>
                  <div className="mono text-[9px] text-[#5b6579]">
                    {bt.overall.wins}胜 / {bt.overall.losses}负
                  </div>
                </div>

                <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-2.5">
                  <div className="text-[9px] text-[#5b6579]">盈亏比 (PF)</div>
                  <div
                    className={cn(
                      "mono text-[16px] font-bold",
                      bt.overall.pf >= 1 ? "text-[#2ebd85]" : "text-[#f6465d]",
                    )}
                  >
                    {bt.overall.pf >= 99 ? "∞" : bt.overall.pf.toFixed(2)}
                  </div>
                  <div className="mono text-[9px] text-[#5b6579]">毛利/毛亏比</div>
                </div>

                <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-2.5">
                  <div className="text-[9px] text-[#5b6579]">平均期望 R</div>
                  <div
                    className={cn(
                      "mono text-[16px] font-bold",
                      bt.overall.avgR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]",
                    )}
                  >
                    {fmtR(bt.overall.avgR)}
                  </div>
                  <div className="mono text-[9px] text-[#5b6579]">每笔平均风险回报</div>
                </div>

                <div className="rounded-lg border border-[#1d2534] bg-[#141a27] p-2.5">
                  <div className="text-[9px] text-[#5b6579]">累计净收益</div>
                  <div
                    className={cn(
                      "mono text-[16px] font-bold",
                      bt.overall.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]",
                    )}
                  >
                    {fmtR(bt.overall.totalR)}
                  </div>
                  <div className="mono text-[9px] text-[#5b6579]">
                    共 {bt.overall.executed} 笔执行
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-[11px] text-[#5b6579]">加载回测统计中…</div>
            )}

            {/* 顶尖模式 */}
            {bt && bt.byPattern.length > 0 && (
              <div className="mt-1 rounded-lg border border-[#1d2534] bg-[#141a27] p-2.5">
                <div className="mb-1.5 text-[10px] font-semibold text-[#8c96ab]">各形态胜率快览</div>
                <div className="flex flex-col gap-1">
                  {bt.byPattern.slice(0, 4).map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-[10px]">
                      <span className="text-[#e7ecf5]">{p.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="mono text-[#5b6579]">n={p.n}</span>
                        <span
                          className={cn(
                            "mono font-bold",
                            p.winRate >= 50 ? "text-[#2ebd85]" : "text-[#f0b90b]",
                          )}
                        >
                          {p.winRate.toFixed(0)}%
                        </span>
                        <span className="mono text-[9px] text-[#8c96ab]">{fmtR(p.avgR)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onOpenDrawer}
            className="btn-ghost flex w-full items-center justify-center gap-1.5 !bg-[#1a2334] !py-2 !text-[#37c8dd] hover:!bg-[#222e44]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 15l-6-6-6 6" />
            </svg>
            展开深度回测分析面板 (资金曲线 / 热力图)
          </button>
        </div>
      )}
    </div>
  );
}
