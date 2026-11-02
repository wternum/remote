"use client";
import { SYMBOLS, BARS, BarId } from "@/lib/types";
import { fmtPrice, fmtPct, cn } from "@/lib/format";

interface Props {
  symbol: string;
  bar: BarId;
  onSymbol: (s: string) => void;
  onBar: (b: BarId) => void;
  last: number | null;
  chg24: number | null;
  funding?: number | null;
  vol24?: number | null;
  live: boolean | null;
  status: string;
  switching: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onRefresh: () => void;
}

export default function Header({
  symbol,
  bar,
  onSymbol,
  onBar,
  last,
  chg24,
  funding,
  vol24,
  live,
  status,
  switching,
  drawerOpen,
  onToggleDrawer,
  onRefresh,
}: Props) {
  const up = (chg24 ?? 0) >= 0;

  return (
    <header className="sticky top-0 z-30 flex h-12 w-full shrink-0 items-center border-b border-[#1d2534] bg-[#0d1119]/95 px-3 backdrop-blur-md">
      {/* 品牌 Logo */}
      <div className="flex items-center gap-2 pr-3 border-r border-[#1d2534]">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#37c8dd]/20 to-[#2ebd85]/10 border border-[#37c8dd]/40">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#37c8dd" strokeWidth="2.2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <div>
          <div className="flex items-center gap-1 leading-none">
            <span className="font-bold tracking-wider text-[#e7ecf5] text-[13px]">PULSE</span>
            <span className="font-bold tracking-wider text-[#37c8dd] text-[13px]">DESK</span>
          </div>
          <div className="text-[8px] font-medium tracking-widest text-[#5b6579]">W/M STRUCTURE · ONLY</div>
        </div>
      </div>

      {/* 币种选择器 */}
      <div className="flex items-center gap-1 pl-3">
        {SYMBOLS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSymbol(s.id)}
            className={cn(
              "mono rounded-md px-2.5 py-1 text-[11px] font-bold transition-all",
              symbol === s.id
                ? "bg-[#182335] text-[#37c8dd] shadow-[inset_0_0_0_1px_rgba(55,200,221,0.4)]"
                : "text-[#8c96ab] hover:bg-[#141a27] hover:text-[#e7ecf5]",
            )}
          >
            {s.base}
          </button>
        ))}
      </div>

      {/* 周期选择器 */}
      <div className="flex items-center gap-0.5 pl-2">
        {BARS.map((b) => (
          <button
            key={b}
            onClick={() => onBar(b)}
            className={cn(
              "mono rounded-md px-2 py-0.5 text-[10px] font-semibold transition-all",
              bar === b
                ? "bg-[#1a2334] text-[#e7ecf5]"
                : "text-[#5b6579] hover:text-[#8c96ab]",
            )}
          >
            {b}
          </button>
        ))}
      </div>

      {/* 永续标识 + 资金费率 */}
      <div className="hidden items-center gap-1.5 pl-3 lg:flex">
        <span className="rounded border border-[#37c8dd]/35 bg-[#37c8dd]/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-[#37c8dd]">
          USDT 永续
        </span>
        {funding != null && (
          <span
            className={cn(
              "mono rounded px-1.5 py-0.5 text-[10px]",
              funding >= 0 ? "bg-[#2ebd85]/10 text-[#2ebd85]" : "bg-[#f6465d]/10 text-[#f6465d]",
            )}
            title="当期资金费率"
          >
            资金 {(funding * 100).toFixed(4)}%
          </span>
        )}
        {vol24 != null && (
          <span className="mono text-[10px] text-[#5b6579]" title="24h 成交额">
            24h {vol24 >= 1e9 ? (vol24 / 1e9).toFixed(2) + "B" : (vol24 / 1e6).toFixed(1) + "M"}
          </span>
        )}
      </div>

      {/* 行情实时价格 Pill */}
      <div className="hidden items-center gap-2 pl-4 md:flex">
        <span
          className={cn(
            "mono text-[16px] font-bold tracking-tight",
            up ? "text-[#2ebd85]" : "text-[#f6465d]",
          )}
        >
          {last ? fmtPrice(last, symbol) : "—"}
        </span>
        <span
          className={cn(
            "mono rounded px-1.5 py-0.5 text-[10px] font-semibold",
            up ? "bg-[#2ebd85]/15 text-[#2ebd85]" : "bg-[#f6465d]/15 text-[#f6465d]",
          )}
        >
          {chg24 != null ? fmtPct(chg24) : ""}
        </span>
      </div>

      {/* 右侧工具区 */}
      <div className="ml-auto flex items-center gap-2">
        {/* 连接状态 */}
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium border",
            status === "live" || status === "poll"
              ? "border-[#2ebd85]/30 bg-[#2ebd85]/10 text-[#2ebd85]"
              : status === "sim"
              ? "border-[#f0b90b]/30 bg-[#f0b90b]/10 text-[#f0b90b]"
              : "border-[#5b6579]/30 bg-[#141a27] text-[#8c96ab]",
          )}
          title={
            live === false
              ? "OKX 接口降级为仿真行情流（形态和回测算法完全一致）"
              : status === "poll" ? "浏览器无法直连 OKX WebSocket，已改为服务端代理每 2 秒轮询真实行情" : "OKX 实时行情直连"
          }
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              status === "live" || status === "poll"
                ? "pulse-dot bg-[#2ebd85]"
                : status === "sim"
                ? "bg-[#f0b90b]"
                : "bg-[#5b6579]",
            )}
          />
          <span className="hidden sm:inline">
            {live === false ? "SIM 仿真" : status === "live" ? "OKX 实时 WS" : status === "poll" ? "OKX 实时 REST" : status === "sim" ? "SIM" : "连接中"}
          </span>
        </div>

        {/* 策略回测抽屉开关 */}
        <button
          onClick={onToggleDrawer}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-all",
            drawerOpen
              ? "border-[#37c8dd]/50 bg-[#37c8dd]/15 text-[#37c8dd]"
              : "border-[#1d2534] bg-[#141a27] text-[#8c96ab] hover:text-[#e7ecf5]",
          )}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <span className="hidden sm:inline">回测面板</span>
        </button>

        {/* 刷新数据 */}
        <button
          onClick={onRefresh}
          className="rounded-md border border-[#1d2534] bg-[#141a27] p-1.5 text-[#8c96ab] hover:text-[#e7ecf5]"
          title="重新扫描最新行情与信号"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {switching && (
        <div className="absolute bottom-0 left-0 h-0.5 w-full overflow-hidden bg-[#1d2534]">
          <div className="loading-bar h-full w-2/5 bg-gradient-to-r from-transparent via-[#37c8dd] to-transparent" />
        </div>
      )}
    </header>
  );
}
