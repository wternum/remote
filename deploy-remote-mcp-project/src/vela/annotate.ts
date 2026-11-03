import type { Vela } from '@luxalgo/vela';
import type { Candidate } from '@/quant/scan';
import { gradeMeta } from '@/quant/model';
import { ANNOT_OVER, ANNOT_UNDER } from './annotLayer';
import { decimalsFor, type AnnEvent, type AnnLevel, type AnnObstacle, type AnnPayload, type AnnPosition, type AnnTone, type AnnZone } from './annotTypes';

// ─────────────────────────────────────────────────────────────
//  系统标注清单（不再使用画图工具）
//  三个来源 → 一份清单 → 推给 pd-annot-under / pd-annot-over 两个图层统一排版：
//   · 实时关键位   paintLevels / clearLevels
//   · 选中的信号   annotateCandidate / clearAnnotations
//   · 订单流判读   paintRead / clearRead
//  用户自己画的线 / 图形作为障碍一并推送，标签会避开。
// ─────────────────────────────────────────────────────────────

interface Source {
  levels: AnnLevel[];
  events: AnnEvent[];
  zones: AnnZone[];
  position: AnnPosition | null;
}

let levelSrc: AnnLevel[] = [];
let focusSrc: Source | null = null;
let readSrc: Source | null = null;
let hoverSrc: AnnEvent | null = null;
let rev = 0;
let current: Vela | null = null;
let watch = 0;
let drawingsKey = '';
let lastFp = '';
const cleaned = new WeakSet<object>();

const hhmm = (ts: number) => {
  const t = new Date(ts);
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

type Port = { setNativeData?: (id: string, data: unknown) => void };
const portOf = (chart: Vela) => (chart as unknown as { rendererPort?: Port }).rendererPort;

type DrawingLike = { id: string; type: string; anchors?: { time: number; price: number }[]; locked?: boolean; visible?: boolean; text?: { value?: string }; style?: { lineColor?: string } };
const listDrawings = (chart: Vela): DrawingLike[] => {
  try {
    return (chart.drawings.all() as unknown as DrawingLike[]) ?? [];
  } catch {
    return [];
  }
};

/** 旧版本用画图工具画的系统标注可能被工作区持久化下来：首次接管时清掉（只清锁定的系统样式） */
const LEGACY_TEXT = /双顶阻力|双底支撑|^颈线|诱多|诱空|回踩区|反抽区|假突破|假跌破|触顶|触底|%\s·\s[ABCD]$/;
const LEGACY_COLORS = new Set(['#2ebd85', '#f6465d', '#37c8dd', '#f0b90b']);
function cleanLegacy(chart: Vela) {
  if (cleaned.has(chart)) return;
  cleaned.add(chart);
  const ids = listDrawings(chart)
    .filter(d => d.locked)
    .filter(d => LEGACY_TEXT.test(d.text?.value ?? '') || (d.type === 'hray' && !d.text?.value && LEGACY_COLORS.has((d.style?.lineColor ?? '').toLowerCase())) || d.type === 'position')
    .map(d => d.id);
  if (!ids.length) return;
  try {
    chart.drawings.removeMany(ids);
  } catch {
    /* ignore */
  }
}

function obstacles(chart: Vela): AnnObstacle[] {
  return listDrawings(chart)
    .filter(d => d.visible !== false && d.anchors?.length)
    .map(d => ({ kind: /^(hline|hray|horizontal)/.test(d.type) ? 'hline' : 'points', points: d.anchors!.map(a => ({ time: a.time, price: a.price })) }));
}

function keyOfDrawings(chart: Vela) {
  return listDrawings(chart)
    .map(d => `${d.id}:${(d.anchors ?? []).map(a => `${a.time},${a.price}`).join(';')}`)
    .join('|');
}

function build(chart: Vela): AnnPayload {
  const srcs = [focusSrc, readSrc].filter((s): s is Source => !!s);
  const levels = [...levelSrc, ...srcs.flatMap(s => s.levels)];
  const position = focusSrc?.position ?? null;
  const ref = position?.entry ?? levels[0]?.price ?? 0;
  return {
    levels,
    events: [...srcs.flatMap(s => s.events), ...(hoverSrc ? [hoverSrc] : [])],
    zones: srcs.flatMap(s => s.zones),
    position,
    obstacles: obstacles(chart),
    decimals: decimalsFor(ref),
    rev,
  };
}

/** 内容没变就不推送，避免价格跳动触发整层重绘 */
function fingerprint(p: AnnPayload) {
  return JSON.stringify({ levels: p.levels, events: p.events, zones: p.zones, position: p.position, obstacles: p.obstacles, decimals: p.decimals });
}

function push(chart: Vela) {
  if (current !== chart) {
    current = chart;
    drawingsKey = '';
    lastFp = '';
  }
  cleanLegacy(chart);
  const payload = build(chart);
  drawingsKey = keyOfDrawings(chart);
  const fp = fingerprint(payload);
  if (fp === lastFp) return;
  lastFp = fp;
  payload.rev = ++rev;
  const port = portOf(chart);
  port?.setNativeData?.(ANNOT_UNDER, payload);
  port?.setNativeData?.(ANNOT_OVER, payload);
  if (!watch && typeof window !== 'undefined') {
    // 用户增删 / 拖动自己的画线后，重新推送障碍物
    watch = window.setInterval(() => {
      const c = current;
      if (!c) return;
      const k = keyOfDrawings(c);
      if (k !== drawingsKey) push(c);
    }, 1200);
  }
}

// ─── 选中的信号 ───────────────────────────────────────────────
export function clearAnnotations(chart: Vela) {
  if (!focusSrc && !hoverSrc) return;
  focusSrc = null;
  hoverSrc = null;
  push(chart);
}

/** 悬停高亮：只加一个标记，不移动视图、不替换已选中的信号 */
export function hoverSignal(chart: Vela, c: Candidate | null) {
  if (!c || focusSrc?.events.some(e => e.ts === c.ts)) {
    if (!hoverSrc) return;
    hoverSrc = null;
    push(chart);
    return;
  }
  const long = c.side === 'long';
  hoverSrc = {
    id: 'hover',
    ts: c.ts,
    side: long ? 'below' : 'above',
    tone: long ? 'long' : 'short',
    text: '',
    marker: 'diamond',
    priority: 40,
    title: `${long ? 'W 双底' : 'M 双顶'} ${hhmm(c.ts)}`,
    detail: [`概率 ${Math.round(c.proba * 100)}% · ${c.side === 'long' ? '做多' : '做空'}`],
  };
  push(chart);
}

export function annotateCandidate(chart: Vela, c: Candidate, opts: { barMs: number; maxHold: number; frame?: boolean } = { barMs: 300_000, maxHold: 96 }) {
  const long = c.side === 'long';
  const entryTs = c.outcome?.filled ? c.outcome.entryTs || c.ts : c.ts;
  const endTs = c.outcome?.filled && c.outcome.exitTs ? c.outcome.exitTs : entryTs + opts.barMs * opts.maxHold;
  const pct = Math.round(c.proba * 100);
  const grade = gradeMeta(c.grade);
  const shape = long ? 'W 双底' : 'M 双顶';
  const ext = long ? '底' : '顶';
  const base = { toTs: null, rank: 'focus' as const, label: true };
  focusSrc = {
    levels: [
      {
        ...base,
        id: 'focus:level',
        name: long ? '双底' : '双顶',
        price: c.level,
        fromTs: c.firstTs,
        tone: long ? 'bottom' : 'top',
        style: 'solid',
        priority: 90,
        detail: [`${shape}关键位`, `第一${ext} ${hhmm(c.firstTs)} · 第二${ext} ${hhmm(c.secondTs)}`],
      },
      {
        ...base,
        id: 'focus:neck',
        name: '颈线',
        price: c.neck,
        fromTs: c.firstTs,
        tone: 'neck',
        style: 'dotted',
        priority: 85,
        detail: [`两次测试之间的${long ? '最高点' : '最低点'}`],
      },
      { ...base, id: 'focus:entry', name: '入场', price: c.entry, fromTs: entryTs, tone: 'entry', style: 'solid', priority: 100, solid: true, detail: [`${long ? '做多' : '做空'} · R:R ${c.rr}`] },
      { ...base, id: 'focus:stop', name: '止损', price: c.stop, fromTs: entryTs, tone: 'stop', style: 'dashed', priority: 99, solid: true, detail: [`放在${long ? '双底下方' : '双顶上方'}的形态外`] },
      { ...base, id: 'focus:target', name: '目标', price: c.tp, fromTs: entryTs, tone: 'target', style: 'dashed', priority: 98, solid: true },
    ],
    events: [
      {
        id: 'focus:signal',
        ts: c.ts,
        side: long ? 'below' : 'above',
        tone: long ? 'long' : 'short',
        text: `${pct}%`,
        marker: 'diamond',
        priority: 90,
        title: `${shape} · ${long ? '做多' : '做空'}信号 ${hhmm(c.ts)}`,
        detail: [`订单流确认概率 ${pct}% · ${grade.grade} 级（${grade.label}）`, `入场 ${c.entry} · 止损 ${c.stop} · 目标 ${c.tp}`, `R:R ${c.rr}`, c.headline].filter(Boolean),
      },
    ],
    zones: [],
    position: { side: c.side, entryTs, endTs, entry: c.entry, stop: c.stop, tp: c.tp },
  };
  push(chart);

  if (opts.frame !== false) {
    const pad = opts.barMs * 40;
    chart.setVisibleRange({ from: Math.min(c.firstTs, entryTs) - pad, to: endTs + pad * 0.6 });
  }
}

// ─── 实时关键位 ───────────────────────────────────────────────
export function paintLevels(chart: Vela, levels: { from: number; to?: number; price: number; side: 'top' | 'bottom'; tested: boolean; broken: boolean }[]) {
  levelSrc = levels.map(lv => {
    const top = lv.side === 'top';
    const name = lv.tested ? (top ? '双顶' : '双底') : top ? '顶部' : '底部';
    return {
      id: `lv:${lv.side}:${lv.from}:${lv.price}`,
      name,
      price: lv.price,
      fromTs: lv.from,
      toTs: lv.broken ? (lv.to ?? lv.from) : null,
      tone: (top ? 'top' : 'bottom') as AnnTone,
      style: lv.tested ? 'solid' : 'dashed',
      rank: lv.broken ? 'faint' : 'normal',
      priority: lv.broken ? 10 : lv.tested ? 55 : 50,
      label: !lv.broken,
      detail: [
        lv.tested ? `历史${top ? '顶部' : '底部'}已被二次测试` : `历史${top ? '顶部' : '底部'} · 尚未二次测试`,
        `形成于 ${hhmm(lv.from)}`,
      ],
    } satisfies AnnLevel;
  });
  push(chart);
}

export function clearLevels(chart: Vela) {
  if (!levelSrc.length) return;
  levelSrc = [];
  push(chart);
}

// ─── 订单流判读 ───────────────────────────────────────────────
/** 图上只放短字（text），理由 / 概率 / 计划放进悬停卡片（detail） */
export type ReadAnnotation =
  | { kind: 'event'; ts: number; side: 'above' | 'below'; tone: AnnTone; text: string; title: string; detail: string[] }
  | { kind: 'zone'; fromTs: number; toTs: number; lo: number; hi: number; tone: AnnTone; text: string; title: string; detail: string[]; levelPrice: number; failed: boolean };

export function clearRead(chart: Vela) {
  if (!readSrc) return;
  readSrc = null;
  push(chart);
}

export function paintRead(chart: Vela, ann: ReadAnnotation | null) {
  if (!ann) {
    clearRead(chart);
    return;
  }
  if (ann.kind === 'event') {
    readSrc = {
      levels: [],
      events: [{ id: 'read:event', ts: ann.ts, side: ann.side, tone: ann.tone, text: ann.text, marker: 'tri', priority: 80, title: ann.title, detail: ann.detail }],
      zones: [],
      position: null,
    };
  } else {
    readSrc = {
      levels: [
        { id: 'read:level', name: '突破位', price: ann.levelPrice, fromTs: ann.fromTs, toTs: null, tone: ann.tone, style: 'dotted', rank: 'read', priority: 75, label: false },
      ],
      events: [],
      zones: [{ id: 'read:zone', fromTs: ann.fromTs, toTs: ann.toTs, lo: ann.lo, hi: ann.hi, tone: ann.tone, text: ann.text, priority: 80, failed: ann.failed, title: ann.title, detail: ann.detail }],
      position: null,
    };
  }
  push(chart);
}
