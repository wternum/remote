import type { Vela } from '@luxalgo/vela';
import type { Candidate } from '@/quant/scan';

// ─────────────────────────────────────────────────────────────
//  把双顶/双底候选画到 Vela 图上：
//  · position 工具 = 入场 / 止损 / 目标（原生 R:R 头部与盈亏区着色）
//  · hray   = 关键位（从第一顶/底起向右延伸）
//  · 颈线   = trendline（第一顶/底 → 第二顶/底的颈线价位）
//  一次只保留一组聚焦标注；标注不进 undo 栈（锁定 + 自管 id）
// ─────────────────────────────────────────────────────────────

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const CYAN = '#37c8dd';
const AMBER = '#f0b90b';

let owned: string[] = [];

export function clearAnnotations(chart: Vela) {
  if (!owned.length) return;
  try {
    chart.drawings.removeMany(owned);
  } catch {
    /* 图已切换时忽略 */
  }
  owned = [];
}

function add(chart: Vela, type: Parameters<Vela['drawings']['add']>[0], init: Parameters<Vela['drawings']['add']>[1]) {
  const d = chart.drawings.add(type, init);
  if (d) {
    owned.push(d.id);
    try {
      chart.drawings.lock(d.id, true);
    } catch {
      /* ignore */
    }
  }
  return d;
}

export function annotateCandidate(chart: Vela, c: Candidate, opts: { barMs: number; maxHold: number; frame?: boolean } = { barMs: 300_000, maxHold: 96 }) {
  clearAnnotations(chart);
  const long = c.side === 'long';
  const entryTs = c.outcome?.filled ? c.outcome.entryTs || c.ts : c.ts;
  const endTs = c.outcome?.filled && c.outcome.exitTs ? c.outcome.exitTs : entryTs + opts.barMs * opts.maxHold;

  // 关键位：从第一顶/底向右的水平射线
  add(chart, 'hray', {
    anchors: [{ time: c.firstTs, price: c.level }],
    style: { lineColor: long ? LONG : SHORT, lineWidth: 1, lineStyle: 'dashed' as never },
    text: { value: long ? `双底支撑 ${c.level}` : `双顶阻力 ${c.level}`, size: 'small', hAlign: 'left', vAlign: long ? 'bottom' : 'top', color: long ? LONG : SHORT } as never,
  });

  // 颈线：两次测试之间的最高/最低
  add(chart, 'trendline', {
    anchors: [
      { time: c.firstTs, price: c.neck },
      { time: Math.max(c.secondTs, c.firstTs + opts.barMs), price: c.neck },
    ],
    style: { lineColor: CYAN, lineWidth: 1, lineStyle: 'dotted' as never, extendRight: true },
    text: { value: `颈线 ${c.neck}`, size: 'small', hAlign: 'right', vAlign: long ? 'top' : 'bottom', color: CYAN, place: 'end' } as never,
  });

  // 头寸框：入场 / 止损 / 目标
  add(chart, 'position', {
    anchors: [
      { time: entryTs, price: c.entry },
      { time: endTs, price: c.stop },
      { time: endTs, price: c.tp },
    ],
    style: { lineColor: long ? LONG : SHORT, lineWidth: 1 },
    props: { showPrices: true, showLossSize: false, profitColor: LONG, lossColor: SHORT },
  });

  // 信号 K 标记
  add(chart, long ? 'arrowmarkup' : 'arrowmarkdown', {
    anchors: [{ time: c.ts, price: long ? c.stop : c.stop }],
    style: { lineColor: AMBER, lineWidth: 2 },
    text: { value: `${Math.round(c.proba * 100)}% · ${c.grade}`, size: 'small', hAlign: 'center', vAlign: long ? 'bottom' : 'top', color: AMBER, bold: true } as never,
  });

  if (opts.frame !== false) {
    const pad = opts.barMs * 40;
    chart.setVisibleRange({ from: Math.min(c.firstTs, entryTs) - pad, to: endTs + pad * 0.6 });
  }
}

/** 实时关键位：为当前仍有效的历史顶/底画淡色水平射线（不聚焦） */
let levelIds: string[] = [];
export function paintLevels(chart: Vela, levels: { from: number; price: number; side: 'top' | 'bottom'; tested: boolean; broken: boolean }[]) {
  if (levelIds.length) {
    try {
      chart.drawings.removeMany(levelIds);
    } catch {
      /* ignore */
    }
    levelIds = [];
  }
  for (const lv of levels) {
    if (lv.broken) continue;
    const d = chart.drawings.add('hray', {
      anchors: [{ time: lv.from, price: lv.price }],
      style: { lineColor: lv.side === 'bottom' ? LONG : SHORT, lineWidth: lv.tested ? 1 : 1, lineStyle: (lv.tested ? 'solid' : 'dashed') as never },
    });
    if (d) {
      levelIds.push(d.id);
      try {
        chart.drawings.lock(d.id, true);
      } catch {
        /* ignore */
      }
    }
  }
}

export function clearLevels(chart: Vela) {
  if (!levelIds.length) return;
  try {
    chart.drawings.removeMany(levelIds);
  } catch {
    /* ignore */
  }
  levelIds = [];
}
