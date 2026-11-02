"use client";
import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  ReferenceLine,
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { BacktestResult, HourDayStat, OverallStat, symbolBase } from "@/lib/types";
import { PATTERN_META } from "@/lib/engine";
import { fmtR, fmtDurBars, fmtDateTime, cn } from "@/lib/format";

interface Props {
  bt: BacktestResult | null;
  loading: boolean;
  symbol: string;
  isOpen: boolean;
  onToggle: () => void;
  onRerun: () => void;
  rerunning: boolean;
  flowFilter: boolean;
  onToggleFlow: () => void;
  scope: "single" | "all";
  onScope: (s: "single" | "all") => void;
}

const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TT = { background: "#141a27", border: "1px solid #273245", borderRadius: 6, fontSize: 11 };

function heatColor(r: number, n: number): string {
  if (n === 0) return "rgba(29,37,52,0.35)";
  const a = Math.min(0.85, 0.18 + Math.abs(r) * 0.55);
  return r >= 0 ? `rgba(46,189,133,${a})` : `rgba(246,70,93,${a})`;
}

const usd = (r: number, risk: number) => (r >= 0 ? "+" : "-") + Math.abs(Math.round(r * risk)).toLocaleString() + " U";

function Card({ title, right, children, className }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-[#1d2534] bg-[#0d1119] p-3", className)}>
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="font-semibold text-[#8c96ab]">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function SideRow({ label, s, risk }: { label: string; s: OverallStat; risk: number }) {
  return (
    <div className="flex items-center gap-2 rounded bg-[#141a27] px-2 py-1.5 text-[10px]">
      <span className="w-14 shrink-0 font-semibold text-[#e7ecf5]">{label}</span>
      <span className="mono w-10 text-[#5b6579]">{s.executed}笔</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded bg-[#1a2233]">
        <div className="absolute inset-y-0 left-0 bg-[#2ebd85]/80" style={{ width: s.winRate + "%" }} />
      </div>
      <span className={cn("mono w-10 text-right font-semibold", s.winRate >= 50 ? "text-[#2ebd85]" : "text-[#f0b90b]")}>
        {s.winRate.toFixed(0)}%
      </span>
      <span className={cn("mono w-16 text-right font-bold", s.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{fmtR(s.totalR)}</span>
      <span className="mono hidden w-16 text-right text-[#5b6579] xl:inline">{usd(s.totalR, risk)}</span>
    </div>
  );
}

export default function StatsDrawer({
  bt,
  loading,
  symbol,
  isOpen,
  onToggle,
  onRerun,
  rerunning,
  flowFilter,
  onToggleFlow,
  scope,
  onScope,
}: Props) {
  const [hoverCell, setHoverCell] = useState<HourDayStat | null>(null);

  const heat = useMemo(() => {
    const grid: (HourDayStat | null)[][] = Array.from({ length: 7 }, () => Array(24).fill(null));
    for (const h of bt?.byHourDay ?? []) grid[h.day][h.hour] = h;
    return grid;
  }, [bt]);

  const pats = useMemo(
    () => (bt?.byPattern ?? []).filter((p) => PATTERN_META[p.id]?.family === "double"),
    [bt],
  );

  const o = bt?.overall;
  const risk = bt?.params.riskUsd ?? 100;
  const exitTotal = o ? Math.max(1, o.tpCount + o.slCount + o.timeCount) : 1;

  return (
    <div className="z-30 shrink-0 border-t border-[#1d2534] bg-[#0d1119]">
      {/* 状态条 */}
      <div className="flex h-9 items-center justify-between gap-2 px-3 text-[11px]">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={onToggle} className="flex shrink-0 items-center gap-1.5 font-semibold text-[#37c8dd] hover:text-[#e7ecf5]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn("transition-transform", isOpen && "rotate-180")}>
              <path d="M18 15l-6-6-6 6" />
            </svg>
            {isOpen ? "收起统计" : "胜率 · 盈亏统计"}
          </button>
          {o && (
            <div className="hidden min-w-0 items-center gap-3 truncate md:flex">
              <span className="mono text-[#8c96ab]">
                {scope === "all" ? "全部币种" : symbol} · {o.executed} 笔
              </span>
              <span className="mono">
                胜率 <b className={o.winRate >= 50 ? "text-[#2ebd85]" : "text-[#f0b90b]"}>{o.winRate.toFixed(1)}%</b>
              </span>
              <span className="mono text-[#2ebd85]">盈 +{o.grossWinR.toFixed(1)}R</span>
              <span className="mono text-[#f6465d]">亏 -{o.grossLossR.toFixed(1)}R</span>
              <span className="mono">
                净 <b className={o.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]"}>{fmtR(o.totalR)}</b>
                <span className="text-[#5b6579]"> ({usd(o.totalR, risk)})</span>
              </span>
              <span className="mono">
                PF <b className={o.pf >= 1 ? "text-[#2ebd85]" : "text-[#f6465d]"}>{o.pf >= 99 ? "∞" : o.pf.toFixed(2)}</b>
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex rounded bg-[#141a27] p-0.5">
            {(
              [
                ["single", "当前币种"],
                ["all", "全部币种"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => onScope(k)}
                className={cn("rounded px-2 py-0.5 text-[10px] font-semibold", scope === k ? "bg-[#1a2334] text-[#37c8dd]" : "text-[#5b6579]")}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            onClick={onToggleFlow}
            className={cn("rounded px-2 py-0.5 text-[10px] font-semibold", flowFilter ? "bg-[#37c8dd]/20 text-[#37c8dd]" : "bg-[#1a2334] text-[#8c96ab]")}
            title="开启后只执行结构质量评分达标的双顶/双底信号"
          >
            质量过滤 {flowFilter ? "ON" : "OFF"}
          </button>
          <button onClick={onRerun} disabled={rerunning} className="flex items-center gap-1 rounded bg-[#1a2334] px-2 py-0.5 text-[10px] font-semibold text-[#8c96ab] hover:text-[#e7ecf5]">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={rerunning ? "animate-spin" : ""}>
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {rerunning ? "计算中" : "重新回测"}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="scroll-slim max-h-[56vh] overflow-y-auto border-t border-[#1d2534] bg-[#10151f] p-3">
          {loading || !bt || !o ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2">
              <div className="skeleton h-6 w-48" />
              <span className="text-[11px] text-[#5b6579]">正在回放历史 K 线（{scope === "all" ? "3 个币种" : symbol}，5m 约 30 天 / 15m 约 45 天）…</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* 盈亏统计 */}
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.25fr_1fr_1fr]">
                <Card
                  title="盈亏统计"
                  right={<span className="mono text-[9px] text-[#5b6579]">每笔固定风险 {risk} USDT · 1R = {risk} U</span>}
                >
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { k: "总盈利", v: "+" + o.grossWinR.toFixed(2) + "R", s: usd(o.grossWinR, risk) + ` · ${o.wins} 笔`, c: "text-[#2ebd85]" },
                      { k: "总亏损", v: "-" + o.grossLossR.toFixed(2) + "R", s: usd(-o.grossLossR, risk) + ` · ${o.losses} 笔`, c: "text-[#f6465d]" },
                      { k: "净盈亏", v: fmtR(o.totalR), s: usd(o.totalR, risk) + ` · ${o.netPct >= 0 ? "+" : ""}${o.netPct.toFixed(2)}%`, c: o.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]" },
                      { k: "平均盈利", v: "+" + o.avgWinR.toFixed(2) + "R", s: usd(o.avgWinR, risk), c: "text-[#2ebd85]" },
                      { k: "平均亏损", v: "-" + o.avgLossR.toFixed(2) + "R", s: usd(-o.avgLossR, risk), c: "text-[#f6465d]" },
                      { k: "盈亏比", v: o.payoff >= 99 ? "∞" : o.payoff.toFixed(2), s: "平均盈利 / 平均亏损", c: o.payoff >= 1 ? "text-[#2ebd85]" : "text-[#f0b90b]" },
                      { k: "最大单笔盈利", v: fmtR(o.bestR), s: usd(o.bestR, risk), c: "text-[#2ebd85]" },
                      { k: "最大单笔亏损", v: fmtR(o.worstR), s: usd(o.worstR, risk), c: "text-[#f6465d]" },
                      { k: "最大连胜 / 连亏", v: `${o.maxWinStreak} / ${o.maxLossStreak}`, s: `最大回撤 -${o.maxDD.toFixed(1)}R`, c: "text-[#e7ecf5]" },
                    ].map((x) => (
                      <div key={x.k} className="rounded bg-[#141a27] px-2 py-1.5">
                        <div className="text-[9px] text-[#5b6579]">{x.k}</div>
                        <div className={cn("mono text-[14px] font-bold", x.c)}>{x.v}</div>
                        <div className="mono truncate text-[9px] text-[#5b6579]">{x.s}</div>
                      </div>
                    ))}
                  </div>
                  {/* 出场分布 */}
                  <div className="mt-2.5">
                    <div className="mb-1 flex justify-between text-[9px] text-[#5b6579]">
                      <span>出场方式分布</span>
                      <span className="mono">成本合计 {o.costR.toFixed(1)}R（手续费 {bt.params.feeBps}bp + 滑点 {bt.params.slipBps}bp /边）</span>
                    </div>
                    <div className="flex h-2.5 overflow-hidden rounded">
                      <div className="bg-[#2ebd85]" style={{ width: (o.tpCount / exitTotal) * 100 + "%" }} />
                      <div className="bg-[#8c96ab]" style={{ width: (o.timeCount / exitTotal) * 100 + "%" }} />
                      <div className="bg-[#f6465d]" style={{ width: (o.slCount / exitTotal) * 100 + "%" }} />
                    </div>
                    <div className="mono mt-1 flex justify-between text-[9px]">
                      <span className="text-[#2ebd85]">止盈 {o.tpCount}</span>
                      <span className="text-[#8c96ab]">超时 {o.timeCount}</span>
                      <span className="text-[#f6465d]">止损 {o.slCount}</span>
                    </div>
                  </div>
                </Card>

                <Card
                  title="胜率总览"
                  right={<span className="mono text-[9px] text-[#5b6579]">平均持仓 {fmtDurBars(o.avgHold, bt.bar)}</span>}
                >
                  <div className="flex items-center gap-3">
                    <svg width="86" height="86" viewBox="0 0 86 86" className="-rotate-90 shrink-0">
                      <circle cx="43" cy="43" r="36" fill="none" stroke="#f6465d" strokeOpacity="0.35" strokeWidth="9" />
                      <circle
                        cx="43" cy="43" r="36" fill="none" stroke="#2ebd85" strokeWidth="9" strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 36}
                        strokeDashoffset={2 * Math.PI * 36 * (1 - o.winRate / 100)}
                      />
                      <text x="43" y="43" textAnchor="middle" dominantBaseline="central" transform="rotate(90 43 43)" style={{ fill: "#e7ecf5", fontSize: 16, fontWeight: 700, fontFamily: "IBM Plex Mono" }}>
                        {o.winRate.toFixed(0)}%
                      </text>
                    </svg>
                    <div className="flex flex-1 flex-col gap-1 text-[10px]">
                      <div className="flex justify-between"><span className="text-[#5b6579]">执行 / 过滤</span><span className="mono text-[#e7ecf5]">{o.executed} / {o.skipped}</span></div>
                      <div className="flex justify-between"><span className="text-[#5b6579]">胜 / 负</span><span className="mono"><span className="text-[#2ebd85]">{o.wins}</span> / <span className="text-[#f6465d]">{o.losses}</span></span></div>
                      <div className="flex justify-between"><span className="text-[#5b6579]">期望值</span><span className={cn("mono font-bold", o.avgR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{fmtR(o.avgR)}/笔</span></div>
                      <div className="flex justify-between"><span className="text-[#5b6579]">盈利因子 PF</span><span className={cn("mono font-bold", o.pf >= 1 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{o.pf >= 99 ? "∞" : o.pf.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-[#5b6579]">保本胜率</span><span className="mono text-[#8c96ab]">{o.payoff > 0 ? (100 / (1 + o.payoff)).toFixed(0) + "%" : "—"}</span></div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-col gap-1">
                    <SideRow label="做多" s={bt.bySide.long} risk={risk} />
                    <SideRow label="做空" s={bt.bySide.short} risk={risk} />
                    {bt.scope === "all" && bt.bySymbol.map((b) => <SideRow key={b.symbol} label={symbolBase(b.symbol)} s={b.stat} risk={risk} />)}
                  </div>
                </Card>

                <Card title="单笔盈亏分布 (R)" right={<span className="mono text-[9px] text-[#5b6579]">n={o.executed}</span>}>
                  <ResponsiveContainer width="100%" height={190}>
                    <BarChart data={bt.rDist} margin={{ left: -18, right: 4, top: 4, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 8, fill: "#5b6579" }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={34} />
                      <YAxis tick={{ fontSize: 9, fill: "#5b6579" }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={TT} cursor={{ fill: "rgba(55,200,221,0.06)" }} formatter={((v: number) => [v + " 笔", "数量"]) as never} />
                      <Bar dataKey="n" radius={[3, 3, 0, 0]}>
                        {bt.rDist.map((d, i) => (
                          <Cell key={i} fill={d.from >= 0 ? "#2ebd85" : "#f6465d"} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </div>

              {/* 各形态胜率 & 盈亏 */}
              <Card
                title="双顶 / 双底各入场方式胜率 · 盈亏（按净 R 排序）"
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[10px]">
                    <thead>
                      <tr className="text-left text-[9px] uppercase tracking-wider text-[#5b6579]">
                        <th className="py-1 font-medium">形态</th>
                        <th className="font-medium">笔数</th>
                        <th className="font-medium">胜 / 负</th>
                        <th className="w-[22%] font-medium">胜率</th>
                        <th className="text-right font-medium">总盈利</th>
                        <th className="text-right font-medium">总亏损</th>
                        <th className="text-right font-medium">净盈亏</th>
                        <th className="text-right font-medium">期望/笔</th>
                        <th className="text-right font-medium">PF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pats.length === 0 && (
                        <tr>
                          <td colSpan={9} className="py-4 text-center text-[#5b6579]">该范围内暂无已执行信号</td>
                        </tr>
                      )}
                      {pats.map((p) => (
                        <tr key={p.id} className="border-t border-[#1d2534]">
                          <td className="py-1.5">
                            <span className="mr-1.5 rounded bg-[#1a2334] px-1 font-mono text-[9px] text-[#8c96ab]">{p.short}</span>
                            <span className="text-[#e7ecf5]">{p.label}</span>
                          </td>
                          <td className="mono text-[#8c96ab]">{p.n}</td>
                          <td className="mono"><span className="text-[#2ebd85]">{p.wins}</span> / <span className="text-[#f6465d]">{p.losses}</span></td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <div className="relative h-1.5 flex-1 overflow-hidden rounded bg-[#f6465d]/30">
                                <div className="absolute inset-y-0 left-0 bg-[#2ebd85]" style={{ width: p.winRate + "%" }} />
                              </div>
                              <span className={cn("mono w-8 text-right font-semibold", p.winRate >= 50 ? "text-[#2ebd85]" : "text-[#f0b90b]")}>{p.winRate.toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="mono text-right text-[#2ebd85]">+{p.grossWinR.toFixed(1)}R</td>
                          <td className="mono text-right text-[#f6465d]">-{p.grossLossR.toFixed(1)}R</td>
                          <td className={cn("mono text-right font-bold", p.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>
                            {fmtR(p.totalR)} <span className="font-normal text-[#5b6579]">{usd(p.totalR, risk)}</span>
                          </td>
                          <td className={cn("mono text-right", p.avgR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{fmtR(p.avgR)}</td>
                          <td className={cn("mono text-right", p.pf >= 1 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{p.pf >= 99 ? "∞" : p.pf.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* 资金曲线 + 时段热力 */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Card
                  title="资金曲线（累计净 R，已扣成本）"
                  right={<span className={cn("mono font-bold", o.totalR >= 0 ? "text-[#2ebd85]" : "text-[#f6465d]")}>{fmtR(o.totalR)}</span>}
                >
                  {bt.equity.length === 0 ? (
                    <div className="flex h-36 items-center justify-center text-[10px] text-[#5b6579]">无数据</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={150}>
                      <AreaChart data={bt.equity} margin={{ left: -10, right: 6, top: 4, bottom: 0 }}>
                        <defs>
                          <linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#37c8dd" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#37c8dd" stopOpacity={0.01} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="ts" hide />
                        <YAxis tick={{ fontSize: 9, fill: "#5b6579" }} axisLine={false} tickLine={false} width={32} />
                        <ReferenceLine y={0} stroke="#5b6579" strokeDasharray="3 3" />
                        <Tooltip contentStyle={TT} labelFormatter={(ts) => fmtDateTime(Number(ts))} formatter={((v: number) => [fmtR(v), "累计"]) as never} />
                        <Area type="monotone" dataKey="cumR" stroke="#37c8dd" strokeWidth={1.5} fill="url(#eqG)" isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </Card>
                <Card
                  title="时段表现（星期 × 小时，平均 R）"
                  right={
                    <span className="mono text-[9px] text-[#8c96ab]">
                      {hoverCell ? `${DAY_NAMES[hoverCell.day]} ${hoverCell.hour}:00 · n=${hoverCell.n} · ${fmtR(hoverCell.avgR)}` : "悬停查看"}
                    </span>
                  }
                >
                  <div className="grid grid-cols-[22px_repeat(24,1fr)] gap-[1.5px]">
                    <div />
                    {Array.from({ length: 24 }).map((_, h) => (
                      <div key={h} className="mono text-center text-[7px] text-[#5b6579]">{h % 6 === 0 ? h : ""}</div>
                    ))}
                    {heat.map((row, d) => (
                      <div key={d} className="contents">
                        <div className="flex items-center text-[8px] text-[#5b6579]">{DAY_NAMES[d]}</div>
                        {row.map((cell, h) => (
                          <div
                            key={h}
                            className="heat-cell h-[14px]"
                            style={{ background: cell ? heatColor(cell.avgR, cell.n) : "rgba(29,37,52,0.35)" }}
                            onMouseEnter={() => setHoverCell(cell)}
                            onMouseLeave={() => setHoverCell(null)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[9px] text-[#5b6579]">
                    <span>{fmtDateTime(bt.from)} → {fmtDateTime(bt.to)}</span>
                    <span>{bt.bars.toLocaleString()} 根 · {bt.bar}</span>
                  </div>
                </Card>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
