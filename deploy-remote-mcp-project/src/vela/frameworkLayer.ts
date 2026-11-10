// Framework chart marking layers (Vela plugin SDK, never grabs pointer).
//  · pd-fw-under (below-data): FVG imbalance bands + AMT/Liquidity horizontal levels
//  · pd-fw-over  (above-data): MTF HUD, right-rail price tags, candle markers/pills, hover cards
import { registerRendererLayer, type RendererLayerArgs } from '@luxalgo/vela/plugin';
import { TONE_COLOR, type AnnEvent, type AnnLevel, type AnnPayload, type AnnTone } from './annotTypes';
import {
  attachedZoneCandidates,
  buildOccupancy,
  eventCandidates,
  layoutRail,
  mergeLevels,
  pickCandidate,
  placeCard,
  railLabelTexts,
  wrapText,
  type Column,
  type LevelGroup,
  type Occupancy,
  type Rect,
} from './annotLayout';
import type { FrameworkHud } from '@/quant/frameworkMarks';

export const FW_UNDER = 'pd-fw-under';
export const FW_OVER = 'pd-fw-over';

export interface FrameworkLayerData {
  payload: AnnPayload;
  hud: FrameworkHud | null;
}

const FONT = "500 10px 'IBM Plex Mono', ui-monospace, monospace";
const FONT_BOLD = "600 11px 'IBM Plex Mono', ui-monospace, monospace";
const FONT_CARD = "400 10.5px 'IBM Plex Mono', ui-monospace, monospace";
const LABEL_H = 14;
const BG = 'rgba(13,17,25,0.88)';
const MUTED_TEXT = '#c9d1e0';
/** 悬停卡片里以「（」开头的补充说明：灰色小字 */
const DIM_TEXT = '#7d889c';
const FONT_DIM = "400 9.5px 'IBM Plex Mono', ui-monospace, monospace";

type Ctx2D = CanvasRenderingContext2D;

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function roundBox(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const RANK_ALPHA = { focus: 0.9, read: 0.78, normal: 0.48, faint: 0.2 } as const;

interface LevelY extends AnnLevel {
  y: number;
  x0: number;
  x1: number;
}

interface Frame {
  ctx: Ctx2D;
  W: number;
  plot: Rect;
  bw: number;
  X: (ms: number) => number;
  Y: (price: number) => number;
  fmt: (v: number) => string;
  p: AnnPayload;
  hud: FrameworkHud | null;
  groups: LevelGroup<LevelY>[];
  occ: Occupancy;
  barAt: (ts: number) => { x: number; top: number; bottom: number } | null;
  last: { x: number; closeY: number; close: number } | null;
}

function makeIndexCache() {
  let key = '';
  let map = new Map<number, number>();
  return (bars: RendererLayerArgs['bars']) => {
    const k = bars.length ? `${bars.length}|${bars[0].time}|${bars[bars.length - 1].time}` : '';
    if (k !== key) {
      key = k;
      map = new Map();
      for (let i = 0; i < bars.length; i++) map.set(bars[i].time, i);
    }
    return map;
  };
}

function setup(
  canvas: HTMLCanvasElement | null,
  args: RendererLayerArgs,
  indexOf: ReturnType<typeof makeIndexCache>,
): Frame | null {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { coords, scale, bounds, bars } = args;
  const dpr = coords.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const raw = args.data as FrameworkLayerData | undefined;
  const p = raw?.payload;
  const hud = raw?.hud ?? null;
  if (!p || !bars.length) return null;
  if (!p.levels.length && !p.events.length && !p.zones.length && !hud) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = coords.width;
  const plot: Rect = { x: 0, y: bounds.top, w: W, h: bounds.height };
  const X = (ms: number) => coords.timeToX(ms);
  const Y = (price: number) => coords.priceToY(price, scale, bounds);
  const bw = Math.max(1, coords.pxPerBar());
  const fmt = (v: number) => v.toFixed(p.decimals);

  const cols: Column[] = [];
  for (let i = 0; i < bars.length; i++) {
    const x = X(bars[i].time);
    if (x < -bw * 2 || x > W + bw * 2) continue;
    cols.push({ x, top: Y(bars[i].high), bottom: Y(bars[i].low) });
  }
  const occ = buildOccupancy(cols, Math.max(1, bw * 0.45));
  const index = indexOf(bars);
  const barAt = (ts: number) => {
    const i = index.get(ts);
    if (i == null) return null;
    const b = bars[i];
    return { x: X(b.time), top: Y(b.high), bottom: Y(b.low) };
  };
  const lb = bars[bars.length - 1];
  const last = { x: X(lb.time), closeY: Y(lb.close), close: lb.close };

  const ys: LevelY[] = [];
  for (const l of p.levels) {
    const y = Y(l.price);
    if (!Number.isFinite(y) || y < plot.y - 24 || y > plot.y + plot.h + 24) continue;
    const x0 = Math.max(0, X(l.fromTs));
    const x1 = l.toTs == null ? W : Math.min(W, X(l.toTs) + bw / 2);
    if (x1 < 0 || x0 > W || x1 <= x0) continue;
    ys.push({ ...l, y, x0, x1 });
  }
  const groups = mergeLevels(ys, 6);
  return { ctx, W, plot, bw, X, Y, fmt, p, hud, groups, occ, barAt, last };
}

function dash(ctx: Ctx2D, style: AnnLevel['style']) {
  ctx.setLineDash(style === 'dashed' ? [5, 4] : style === 'dotted' ? [2, 3] : []);
}

function renderUnder(f: Frame) {
  const { ctx, plot, X, Y, p, groups } = f;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  for (const z of p.zones) {
    const x0 = X(z.fromTs);
    const x1 = X(z.toTs);
    const y0 = Y(z.hi);
    const y1 = Y(z.lo);
    if (x1 <= x0 || !Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    const c = TONE_COLOR[z.tone];
    ctx.fillStyle = rgba(c, 0.085);
    ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
    ctx.strokeStyle = rgba(c, 0.36);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, Math.min(y0, y1) + 0.5, x1 - x0, Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }

  // 压力带 / 支撑带（箱顶 / 箱底）：浅色色带 + 上下两条细虚边，从带里最早那样出现的 K 线画到最右
  for (const l of p.levels) {
    if (!l.range || l.railOnly) continue;
    const yTop = Y(l.range[1]);
    const yBot = Y(l.range[0]);
    if (!Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
    const x0 = Math.max(0, X(l.fromTs));
    if (x0 >= f.W) continue;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const c = TONE_COLOR[l.tone];
    ctx.fillStyle = rgba(c, 0.1);
    ctx.fillRect(x0, top, f.W - x0, h);
    ctx.strokeStyle = rgba(c, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(top) + 0.5);
    ctx.lineTo(f.W, Math.round(top) + 0.5);
    ctx.moveTo(x0, Math.round(top + h) - 0.5);
    ctx.lineTo(f.W, Math.round(top + h) - 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const g of groups) {
    // railOnly 的价位（亚盘高低点）由时段图层自己画线；色带上面已经画过；这里只画其余的线
    const drawn = g.items.filter(i => !i.railOnly && !i.range);
    if (!drawn.length) continue;
    const l = drawn.reduce((a, b) => (b.priority > a.priority ? b : a));
    const c = TONE_COLOR[l.tone];
    const a = RANK_ALPHA[l.rank];
    const x0 = Math.min(...drawn.map(i => i.x0));
    const x1 = Math.max(...drawn.map(i => i.x1));
    if (g.yBottom - g.yTop >= 1.5) {
      ctx.fillStyle = rgba(c, Math.min(0.14, a * 0.22));
      ctx.fillRect(x0, g.yTop - 1, x1 - x0, g.yBottom - g.yTop + 2);
    }
    ctx.strokeStyle = rgba(c, a);
    ctx.lineWidth = l.style === 'solid' ? 1.25 : 1;
    dash(ctx, l.style);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(g.y) + 0.5);
    ctx.lineTo(x1, Math.round(g.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

interface Hit {
  rect: Rect;
  title: string;
  lines: string[];
  tone: AnnTone;
}

function textW(ctx: Ctx2D, s: string, font = FONT) {
  ctx.font = font;
  return Math.ceil(ctx.measureText(s).width);
}

function pill(ctx: Ctx2D, r: Rect, text: string, tone: AnnTone) {
  const c = TONE_COLOR[tone];
  roundBox(ctx, r.x, r.y, r.w, r.h, 5);
  ctx.fillStyle = BG;
  ctx.fill();
  ctx.strokeStyle = rgba(c, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = FONT;
  ctx.fillStyle = c;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, r.x + 4, r.y + r.h / 2 + 0.5);
}

function marker(ctx: Ctx2D, x: number, apexY: number, side: 'above' | 'below', kind: AnnEvent['marker'], color: string, s: number) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (kind === 'diamond') {
    const cy = side === 'above' ? apexY - s : apexY + s;
    ctx.moveTo(x, cy - s);
    ctx.lineTo(x + s * 0.8, cy);
    ctx.lineTo(x, cy + s);
    ctx.lineTo(x - s * 0.8, cy);
  } else if (side === 'above') {
    ctx.moveTo(x, apexY);
    ctx.lineTo(x - s, apexY - s * 1.45);
    ctx.lineTo(x + s, apexY - s * 1.45);
  } else {
    ctx.moveTo(x, apexY);
    ctx.lineTo(x - s, apexY + s * 1.45);
    ctx.lineTo(x + s, apexY + s * 1.45);
  }
  ctx.closePath();
  ctx.fill();
}

function leader(ctx: Ctx2D, pts: [number, number][], color: string) {
  ctx.strokeStyle = rgba(color, 0.55);
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function obstaclesOf(f: Frame): Rect[] {
  const { plot, X, Y, W, p } = f;
  // Reserve top-left OHLC legend + bottom session ribbon when height permits.
  // 图例第一行带开高低收和涨跌，实际宽到 ~560px，按这个宽度避让
  const out: Rect[] = [{ x: 0, y: plot.y, w: legendWidth(W), h: 46 }];
  if (plot.h > 140) out.push({ x: 0, y: plot.y + plot.h - 42, w: W, h: 42 });
  for (const o of p.obstacles) {
    if (o.kind === 'hline') {
      const y = Y(o.points[0]?.price ?? NaN);
      if (Number.isFinite(y)) out.push({ x: 0, y: y - 3, w: W, h: 6 });
      continue;
    }
    const pts = o.points.map(pt => ({ x: X(pt.time), y: Y(pt.price) })).filter(pt => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (!pts.length) continue;
    const x0 = Math.min(...pts.map(q => q.x));
    const x1 = Math.max(...pts.map(q => q.x));
    const y0 = Math.min(...pts.map(q => q.y));
    const y1 = Math.max(...pts.map(q => q.y));
    if (x1 - x0 < 220 && y1 - y0 < 140) out.push({ x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 });
    else for (const q of pts) out.push({ x: q.x - 6, y: q.y - 6, w: 12, h: 12 });
  }
  return out;
}

/** 左上角图例（品种 · 开高低收 · 涨跌）第一行的大致宽度 */
const legendWidth = (W: number) => Math.min(580, W * 0.78);

/** Compact top-right MTF + Confluence HUD pill (desktop only, reserves its rect in `taken`). */
function renderHud(f: Frame, taken: Rect[], hits: Hit[]): Rect | null {
  const { ctx, plot, W, hud } = f;
  if (!hud || W < 620 || plot.h < 120) return null;

  const segments: { text: string; color: string }[] = [
    ...hud.rows.map(r => ({
      text: `${r.tf} ${r.word}`,
      color: r.insufficient ? '#4b5563' : r.bias === 'bull' ? TONE_COLOR.long : r.bias === 'bear' ? TONE_COLOR.short : '#8c96ab',
    })),
    { text: `· ${hud.verdict}`, color: TONE_COLOR[hud.tone] },
  ];

  ctx.font = FONT;
  const widths = segments.map(s => ctx.measureText(s.text).width);
  const gap = 7;
  const totalW = Math.ceil(widths.reduce((a, b) => a + b, 0) + gap * (segments.length - 1) + 14);
  const h = 20;
  const rect: Rect = { x: Math.round(W - totalW - 8), y: Math.round(plot.y + 8), w: totalW, h };
  // 和图例第一行挤在一起时挪到第二行（第二行左边只有「成交量」，右边是空的）
  if (rect.x < legendWidth(W) + 8) rect.y = Math.round(plot.y + 30);
  if (rect.x < 160) return null;

  roundBox(ctx, rect.x, rect.y, rect.w, rect.h, 6);
  ctx.fillStyle = 'rgba(13,17,25,0.88)';
  ctx.fill();
  ctx.strokeStyle = rgba(TONE_COLOR[hud.tone], 0.45);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = rect.x + 7;
  for (let i = 0; i < segments.length; i++) {
    ctx.fillStyle = segments[i].color;
    ctx.fillText(segments[i].text, x, rect.y + h / 2 + 0.5);
    x += widths[i] + gap;
  }
  taken.push(rect);
  hits.push({ rect, title: hud.title, lines: hud.detail, tone: hud.tone });
  return rect;
}

function renderRail(f: Frame, taken: Rect[], hits: Hit[], hudRect: Rect | null = null) {
  const { ctx, plot, W, bw, fmt, groups, last, occ } = f;
  type Entry = { g: LevelGroup<LevelY>; lead: LevelY; labeled: LevelY[] };
  const pool: Entry[] = [];
  for (const g of groups) {
    const labeled = g.items.filter(i => i.label).sort((a, b) => b.priority - a.priority);
    if (labeled.length) pool.push({ g, lead: labeled[0], labeled });
  }
  const yc = last?.closeY ?? plot.y + plot.h / 2;
  const normal = pool.filter(e => e.lead.rank === 'normal' || e.lead.rank === 'faint');
  const keepNormal = new Set<Entry>([
    ...normal.filter(e => e.g.y <= yc).sort((a, b) => (yc - a.g.y) - (yc - b.g.y)).slice(0, 3),
    ...normal.filter(e => e.g.y > yc).sort((a, b) => (a.g.y - yc) - (b.g.y - yc)).slice(0, 3),
  ]);
  const entries = pool.filter(e => (e.lead.rank !== 'normal' && e.lead.rank !== 'faint') || keepNormal.has(e));
  const byId = new Map(entries.map(e => [e.lead.id, e]));

  // 右侧标签从右上角汇总下面开始排（汇总可能被挪到第二行）
  const topBound = hudRect ? hudRect.y + hudRect.h + 4 : plot.y + 2;
  const bottomBound = plot.y + plot.h - (plot.h > 140 ? 44 : 2);
  const placed = layoutRail(
    entries.map(e => ({ id: e.lead.id, y: e.g.y, h: LABEL_H, priority: e.lead.priority })),
    topBound,
    bottomBound,
    { gap: 2, window: 60, maxPerWindow: 4, maxTotal: bw < 3 ? 4 : Infinity },
  );

  const railRight = W - 4;
  const fmtShort = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : fmt(v));
  for (const r of placed) {
    const e = byId.get(r.id);
    if (!e) continue;
    const { lead, labeled, g } = e;
    const sameName = labeled.filter(i => i.name === lead.name);
    const lo = Math.min(...sameName.map(i => i.price));
    const hi = Math.max(...sameName.map(i => i.price));
    const span = lead.range ?? (hi - lo > 0 ? [lo, hi] as [number, number] : null);
    const priceTxt = span ? `${fmt(span[0])}–${fmt(span[1])}` : fmt(lead.price);
    const priceShort = span ? `${fmtShort(span[0])}–${fmtShort(span[1])}` : fmtShort(lead.price);
    // 同一价位的两个不同含义直接并排写出（「前低 · 今日亚盘低 85.45」），再多才折成 +N
    const { pairName, tries } = railLabelTexts(labeled, r.folded.length, priceTxt, priceShort);
    const y0 = Math.round(r.y - LABEL_H / 2);
    let text = '';
    let rect: Rect | null = null;
    for (const t of tries) {
      const w = textW(ctx, t) + 8;
      const rr: Rect = { x: Math.round(railRight - w), y: y0, w, h: LABEL_H };
      if (!occ.hits(rr, 2)) {
        text = t;
        rect = rr;
        break;
      }
    }
    const tab = !rect;
    if (!rect) {
      rect = { x: W - 7, y: y0, w: 6, h: LABEL_H };
      if (occ.hits(rect, 0)) continue;
    }
    const c = TONE_COLOR[lead.tone];
    if (tab) {
      ctx.fillStyle = rgba(c, 0.85);
      roundBox(ctx, rect.x, rect.y + 2, rect.w, rect.h - 4, 2);
      ctx.fill();
    } else {
      if (Math.abs(r.y - r.desiredY) > 2) {
        leader(ctx, [[rect.x, r.y], [rect.x - 5, r.desiredY], [rect.x - 11, r.desiredY]], c);
      }
      pill(ctx, rect, text, lead.tone);
    }
    taken.push(rect);
    const folded = r.folded.map(id => groups.flatMap(gg => gg.items).find(i => i.id === id)).filter((i): i is LevelY => !!i);
    const lines: string[] = [];
    const members = [...g.items.filter(i => i.label), ...folded];
    const single = members.length === 1;
    for (const it of members) {
      if (!single) lines.push(`· ${it.name} ${fmt(it.price)}`);
      for (const d of it.detail ?? []) if (d) lines.push(single ? d : `  ${d}`);
    }
    // 标题：名字 价格（↑离现价多远），随形成中的价格实时变化
    const diff = last ? lead.price - last.close : NaN;
    const away = Number.isFinite(diff) ? `（${diff >= 0 ? '↑' : '↓'}${fmt(Math.abs(diff))}）` : '';
    hits.push({ rect: tab ? { ...rect, x: rect.x - 4, w: rect.w + 8 } : rect, title: `${pairName} ${priceTxt}${away}`, lines, tone: lead.tone });
  }
}

function renderEvents(f: Frame, taken: Rect[], hits: Hit[], memo: Map<string, string>) {
  const { ctx, bw, W, plot, occ } = f;
  const seen = new Set<string>();
  const events = [...f.p.events].sort((a, b) => b.priority - a.priority);
  const s = bw < 3 ? 3.5 : 5;
  // 5m 默认视野约 3px/根：门槛设 2px，放不下的文字仍由 pickCandidate 避让后省略，只留标记
  const showText = bw >= 2 && W >= 520;
  const geo = events
    .map(ev => {
      const b = f.barAt(ev.ts);
      if (!b || b.x < -10 || b.x > W + 10) return null;
      const apex = ev.side === 'above' ? b.top - 3 : b.bottom + 3;
      const edge = ev.side === 'above' ? apex - s * 2 : apex + s * 2;
      const mr: Rect = { x: b.x - s, y: Math.min(apex, edge), w: s * 2, h: Math.abs(edge - apex) };
      return { ev, b, apex, edge, mr };
    })
    .filter((g): g is NonNullable<typeof g> => !!g);

  for (const g of geo) {
    // 事后确认型标注：从标记引一条细虚线到确认那根，末端一个小点（K 线太密时省略）
    if (g.ev.confirmTs != null && bw >= 2) {
      const cb = f.barAt(g.ev.confirmTs);
      if (cb && cb.x - g.b.x > s + 2) {
        const c = TONE_COLOR[g.ev.tone];
        const y = Math.round(g.ev.side === 'above' ? g.apex - s : g.apex + s) + 0.5;
        ctx.save();
        ctx.strokeStyle = rgba(c, 0.45);
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 2]);
        ctx.beginPath();
        ctx.moveTo(g.b.x + s, y);
        ctx.lineTo(cb.x, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(c, 0.8);
        ctx.beginPath();
        ctx.arc(cb.x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    marker(ctx, g.b.x, g.apex, g.ev.side, g.ev.marker, TONE_COLOR[g.ev.tone], s);
    taken.push(g.mr);
  }
  for (const g of geo) {
    const { ev } = g;
    seen.add(ev.id);
    const c = TONE_COLOR[ev.tone];
    const hitLines = ev.detail ?? [];
    hits.push({ rect: { x: g.mr.x - 3, y: g.mr.y - 3, w: g.mr.w + 6, h: g.mr.h + 6 }, title: ev.title ?? ev.text, lines: hitLines, tone: ev.tone });
    if (!showText || !ev.text) continue;
    const w = textW(ctx, ev.text) + 8;
    const cands = eventCandidates({ x: g.b.x, markerEdge: g.edge, side: ev.side, w, h: LABEL_H }, occ);
    const pick = pickCandidate(cands, occ, taken, plot, memo.get(ev.id));
    if (!pick) continue;
    memo.set(ev.id, pick.key);
    const r = { ...pick.rect, x: Math.round(pick.rect.x), y: Math.round(pick.rect.y) };
    const nearY = ev.side === 'above' && r.y + r.h <= g.edge ? r.y + r.h : r.y >= g.edge ? r.y : r.y + r.h / 2;
    const nearX = Math.max(r.x, Math.min(g.b.x, r.x + r.w));
    if (Math.hypot(nearX - g.b.x, nearY - g.edge) > 7) leader(ctx, [[g.b.x, g.edge], [nearX, nearY]], c);
    pill(ctx, r, ev.text, ev.tone);
    taken.push(r);
    hits.push({ rect: r, title: ev.title ?? ev.text, lines: hitLines, tone: ev.tone });
  }
  for (const k of [...memo.keys()]) if (!seen.has(k)) memo.delete(k);
}

function renderZones(f: Frame, taken: Rect[], hits: Hit[], memo: Map<string, string>) {
  const { ctx, X, Y, plot, occ } = f;
  for (const z of [...f.p.zones].sort((a, b) => b.priority - a.priority)) {
    if (!z.text) continue;
    const x0 = Math.max(0, X(z.fromTs));
    const x1 = Math.min(f.W, X(z.toTs));
    const y0 = Y(z.hi);
    const y1 = Y(z.lo);
    if (x1 <= x0 || !Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    const box: Rect = { x: x0, y: Math.min(y0, y1), w: x1 - x0, h: Math.abs(y1 - y0) };
    const w = textW(ctx, z.text) + 8;
    // 只允许贴附在本区域边框上的候选；放不下就不画文字，绝不漂到别的价位。
    const pick = pickCandidate(attachedZoneCandidates(box, w, LABEL_H), occ, taken, plot, memo.get(z.id));
    if (!pick) {
      memo.delete(z.id);
      // 文字放不下时，区域本身仍可悬停查看详情（细区域上下各放宽 3px 便于命中）。
      hits.push({ rect: { x: box.x, y: box.y - 3, w: box.w, h: box.h + 6 }, title: z.title ?? z.text, lines: z.detail ?? [], tone: z.tone });
      continue;
    }
    memo.set(z.id, pick.key);
    const r = { ...pick.rect, x: Math.round(pick.rect.x), y: Math.round(pick.rect.y) };
    pill(ctx, r, z.text, z.tone);
    taken.push(r);
    hits.push({ rect: r, title: z.title ?? z.text, lines: z.detail ?? [], tone: z.tone });
  }
}

function renderCard(f: Frame, hit: Hit, cursor: { x: number; y: number }) {
  const { ctx, plot } = f;
  const maxW = Math.max(80, Math.min(310, plot.w - 16));
  const measure = (s: string) => textW(ctx, s, FONT_CARD);
  const measureDim = (s: string) => textW(ctx, s, FONT_DIM);
  // 「（」开头的是补充说明：灰色小字，换行后仍保持灰色
  let lines = hit.lines.flatMap(l => {
    const dim = l.trimStart().startsWith('（');
    return wrapText(l, maxW - 16, dim ? measureDim : measure).map(text => ({ text, dim }));
  });
  const titleLines = wrapText(hit.title, maxW - 16, s => textW(ctx, s, FONT_BOLD));
  const lineBudget = Math.max(1, Math.floor((plot.h - 30 - titleLines.length * 15) / 14));
  if (lines.length > lineBudget) lines = [...lines.slice(0, Math.max(0, lineBudget - 1)), { text: '点击右下角「四框架分析」查看完整详情。', dim: true }];
  // 行尾悬挂的标点可能多出一个字宽：卡片允许略宽于换行宽度
  const w = Math.min(maxW + 12, Math.max(...titleLines.map(s => textW(ctx, s, FONT_BOLD)), ...lines.map(l => (l.dim ? measureDim : measure)(l.text)), 60) + 16);
  const h = 8 + titleLines.length * 15 + (lines.length ? 4 + lines.length * 14 : 0) + 6;
  const r = placeCard(cursor, w, h, plot);
  roundBox(ctx, r.x, r.y, r.w, r.h, 8);
  ctx.fillStyle = 'rgba(13,17,25,0.96)';
  ctx.fill();
  ctx.strokeStyle = rgba(TONE_COLOR[hit.tone], 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let y = r.y + 8;
  ctx.font = FONT_BOLD;
  ctx.fillStyle = TONE_COLOR[hit.tone];
  for (const t of titleLines) {
    ctx.fillText(t, r.x + 8, y);
    y += 15;
  }
  if (lines.length) y += 4;
  for (const l of lines) {
    ctx.font = l.dim ? FONT_DIM : FONT_CARD;
    ctx.fillStyle = l.dim ? DIM_TEXT : MUTED_TEXT;
    ctx.fillText(l.text, r.x + 8, y + (l.dim ? 1 : 0));
    y += 14;
  }
}

let registered = false;

export function registerFrameworkLayers() {
  if (registered) return;
  registered = true;

  registerRendererLayer({
    id: FW_UNDER,
    placement: 'below-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      const indexOf = makeIndexCache();
      return {
        mount(c) {
          canvas = c;
          c.dataset.frameworkLayer = FW_UNDER;
        },
        render(args) {
          const f = setup(canvas, args, indexOf);
          if (f) renderUnder(f);
        },
        destroy() {
          canvas = null;
        },
      };
    },
  });

  registerRendererLayer({
    id: FW_OVER,
    placement: 'above-data',
    repaintOnCursor: true,
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      const indexOf = makeIndexCache();
      const eventMemo = new Map<string, string>();
      const zoneMemo = new Map<string, string>();
      return {
        mount(c) {
          canvas = c;
          c.dataset.frameworkLayer = FW_OVER;
        },
        render(args) {
          const f = setup(canvas, args, indexOf);
          if (!f) return;
          const { ctx, plot } = f;
          ctx.save();
          ctx.beginPath();
          ctx.rect(plot.x, plot.y, plot.w, plot.h);
          ctx.clip();
          const taken = obstaclesOf(f);
          const hits: Hit[] = [];
          const hudRect = renderHud(f, taken, hits);
          renderRail(f, taken, hits, hudRect);
          renderEvents(f, taken, hits, eventMemo);
          renderZones(f, taken, hits, zoneMemo);
          ctx.globalAlpha = 1;
          const cur = args.cursor;
          if (cur) {
            const hit = [...hits].reverse().find(h => cur.x >= h.rect.x && cur.x <= h.rect.x + h.rect.w && cur.y >= h.rect.y && cur.y <= h.rect.y + h.rect.h);
            if (hit && (hit.lines.length || hit.title)) renderCard(f, hit, cur);
          }
          ctx.restore();
        },
        destroy() {
          canvas = null;
          eventMemo.clear();
          zoneMemo.clear();
        },
      };
    },
  });
}
