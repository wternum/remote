"use client";
import { RawSignal } from "@/lib/types";
import { PATTERN_META, CONF_MIN } from "@/lib/engine";
import { fmtPrice } from "@/lib/format";

export interface ToastItem {
  id: string;
  signal: RawSignal;
  symbol: string;
}

export default function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-3 top-10 z-40 flex w-[300px] flex-col gap-2">
      {items.map((t) => {
        const s = t.signal;
        const long = s.side === "long";
        const meta = PATTERN_META[s.pattern];
        const exec = s.conf >= CONF_MIN;
        return (
          <div
            key={t.id}
            className="toast-in pointer-events-auto rounded-lg border bg-[rgba(16,21,31,0.94)] p-3 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-md"
            style={{ borderLeft: `3px solid ${long ? "#2ebd85" : "#f6465d"}`, borderColor: "var(--line)", borderLeftColor: long ? "#2ebd85" : "#f6465d" }}
            onClick={() => onDismiss(t.id)}
          >
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill={long ? "#2ebd85" : "#f6465d"}>
                {long ? <path d="M12 4l8 14H4z" /> : <path d="M12 20L4 6h16z" />}
              </svg>
              <span className="text-[13px] font-bold text-[#e7ecf5]">
                {meta.label} · {long ? "做多" : "做空"}
              </span>
              <span className="ml-auto rounded bg-[#37c8dd]/15 px-1.5 py-px text-[9px] font-bold text-[#37c8dd]">
                置信 {s.conf}
              </span>
            </div>
            <div className="mono mt-1.5 flex gap-3 text-[10px]">
              <span className="text-[#f0b90b]">E {fmtPrice(s.entry, t.symbol)}</span>
              <span className="text-[#f6465d]">SL {fmtPrice(s.stop, t.symbol)}</span>
              <span className="text-[#2ebd85]">TP {fmtPrice(s.tp, t.symbol)}</span>
            </div>
            <div className="mt-1 text-[10px] text-[#8c96ab]">
              {s.fill === "limit" ? "关键位挂单已成交 · 止损在形态外" : exec ? "结构质量达标" : "结构质量偏低，仅观察"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
