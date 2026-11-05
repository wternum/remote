import type { FlowSnapshot } from '@/quant/flow';

// 标注重算键：决定「什么时候需要重新跑一遍 analyzeSignals」。
//
// 口径：默认（未勾选「未收盘 Δ 预览」）分析只用已收盘 K 线，因此键里不得含
// 未收盘价的任何字段——否则每一个实时 tick 都会触发一次全量重算
// （实测 1000 根单次约 18ms，按 300ms 节流上限即持续约 6% 单核占用），
// 而输出在收盘前根本不会变化。勾选预览后，形成中那根才进入键。
export interface RecomputeInput {
  /** `ticker|timeframe`，切换市场必须重算 */
  marketKey: string;
  /** 镜像里的 K 线根数（新 K 线到达会变） */
  length: number;
  /** 镜像首根时间（历史回填/裁剪会变） */
  firstTs: number;
  /** 镜像末根时间（含形成中那根） */
  lastTs: number;
  /** 最新**已收盘** K 线的收盘价与成交量 */
  prevClose?: number;
  prevVolume?: number;
  closedHigh?: number;
  closedLow?: number;
  closedOpen?: number;
  barMs: number;
  now: number;
  /** 是否勾选「未收盘 Δ 预览」 */
  preview: boolean;
  /** 形成中 K 线；仅在 preview 为真时参与键 */
  forming?: { high: number; low: number; close: number; volume: number } | null;
}

export function signalRecomputeKey(i: RecomputeInput): string {
  const forming = i.preview && i.forming
    ? `${i.forming.high}|${i.forming.low}|${i.forming.close}|${i.forming.volume}`
    : '';
  return [
    i.marketKey,
    i.length,
    i.firstTs,
    i.lastTs,
    i.prevClose ?? '',
    i.prevVolume ?? '',
    i.closedOpen ?? '', i.closedHigh ?? '', i.closedLow ?? '',
    // 跨周期边界：上一根转为已收盘，必须重算
    Math.floor(i.now / i.barMs),
    forming,
  ].join('|');
}

/** Tape updates on the forming bar must not re-run historical M/W analysis while preview is off. */
export function flowRecomputeKey(snapshot: FlowSnapshot, now: number, preview: boolean, lookback: number): string {
  const cutoff = now - (lookback + 900) * snapshot.barMs;
  const rows: string[] = [];
  for (const [ts, b] of snapshot.bars) {
    if (ts < cutoff || (!preview && ts + snapshot.barMs > now)) continue;
    rows.push(`${ts}:${b.buy}:${b.sell}:${b.src}`);
  }
  rows.sort();
  return rows.join('|');
}
