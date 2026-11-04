// ─────────────────────────────────────────────────────────────
//  系统标注图层（Vela 插件 SDK 的 renderer layer，不占用画图工具）
//  · pd-annot-under（K 线下面）：关键位线 / 合并色带 / 回踩区 / 仓位盈亏底色
//  · pd-annot-over （K 线上面）：标记、短字标签、引线、悬停卡片
//  两层读同一份清单；画布不接管鼠标，点击 / 拖动 / 画线照常。
// ─────────────────────────────────────────────────────────────
import { registerRendererLayer, type RendererLayerArgs } from '@luxalgo/vela/plugin';
import { TONE_COLOR, type AnnEvent, type AnnLevel, type AnnPayload, type AnnTone } from './annotTypes';
import {
  buildOccupancy,
  eventCandidates,
  layoutRail,
  mergeLevels,
  pickCandidate,
  placeCard,
  wrapText,
  zoneCandidates,
  type Column,
  type LevelGroup,
  type Occupancy,
  type Rect,
} from './annotLayout';

export const ANNOT_UNDER = 'pd-annot-under';
export const ANNOT_OVER = 'pd-annot-over';

const FONT = "500 10px 'IBM Plex Mono', ui-monospace, monospace";
const FONT_BOLD = "600 11px 'IBM Plex Mono', ui-monospace, monospace";
const FONT_CARD = "400 10.5px 'IBM Plex Mono', ui-monospace, monospace";
const LABEL_H = 14;
const BG = 'rgba(13,17,25,0.82)';
const MUTED_TEXT = '#c9d1e0';

type Ctx2D = CanvasRenderingContext2D;

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const RANK_ALPHA = { focus: 0.9, read: 0.8, normal: 0.42, faint: 0.18 } as const;

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
  groups: LevelGroup<LevelY>[];
  cols: Column[];
  occ: Occupancy;
  barAt: (ts: number) => { x: number; top: number; bottom: number } | null;
  last: { x: number; closeY: number } | null;
}

// 每个渲染实例缓存 ts → 索引
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

function setup(canvas: HTMLCanvasElement | null, args: RendererLayerArgs, indexOf: ReturnType<typeof makeIndexCache>): Frame | null {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { coords, scale, bounds, bars } = args;
  const dpr = coords.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const p = args.data as AnnPayload | undefined;
  if (!p || !bars.length) return null;
  if (!p.levels.length && !p.events.length && !p.zones.length && !p.paths?.length && !p.position) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = coords.width;
  const plot: Rect = { x: 0, y: bounds.top, w: W, h: bounds.height };
  const X = (ms: number) => coords.timeToX(ms);
  const Y = (price: number) => coords.priceToY(price, scale, bounds);
  const bw = Math.max(1, coords.pxPerBar());
  const fmt = (v: number) => v.toFixed(p.decimals);

  // 可视 K 线占位
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
  const last = { x: X(lb.time), closeY: Y(lb.close) };

  // 关键位 → 屏幕坐标 → 合并
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
  return { ctx, W, plot, bw, X, Y, fmt, p, groups, cols, occ, barAt, last };
}

function dash(ctx: Ctx2D, style: AnnLevel['style']) {
  ctx.setLineDash(style === 'dashed' ? [5, 4] : style === 'dotted' ? [2, 3] : []);
}

// ─── K 线下面 ────────────────────────────────────────────────
function renderUnder(f: Frame) {
  const { ctx, plot, X, Y, p, groups } = f;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // 回踩区 / 反抽区：淡底 + 细虚边
  for (const z of p.zones) {
    const x0 = X(z.fromTs);
    const x1 = X(z.toTs);
    const y0 = Y(z.hi);
    const y1 = Y(z.lo);
    const c = TONE_COLOR[z.tone];
    ctx.fillStyle = rgba(c, z.failed ? 0.07 : 0.1);
    ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
    ctx.strokeStyle = rgba(c, 0.45);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, Math.min(y0, y1) + 0.5, x1 - x0, Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }

  // 仓位盈亏底色
  if (p.position) {
    const pos = p.position;
    const xa = X(pos.entryTs);
    const xb = Math.max(X(pos.endTs), xa + f.bw * 8);
    const ye = Y(pos.entry);
    ctx.fillStyle = rgba(TONE_COLOR.target, 0.1);
    ctx.fillRect(xa, Math.min(ye, Y(pos.tp)), xb - xa, Math.abs(Y(pos.tp) - ye));
    ctx.fillStyle = rgba(TONE_COLOR.stop, 0.1);
    ctx.fillRect(xa, Math.min(ye, Y(pos.stop)), xb - xa, Math.abs(Y(pos.stop) - ye));
  }

  // 关键位：合并后的每组一条线；多价位合并时画一条细色带
  for (const g of groups) {
    const l = g.lead;
    const c = TONE_COLOR[l.tone];
    const a = RANK_ALPHA[l.rank];
    const x0 = Math.min(...g.items.map(i => i.x0));
    const x1 = Math.max(...g.items.map(i => i.x1));
    if (g.yBottom - g.yTop >= 1.5) {
      ctx.fillStyle = rgba(c, Math.min(0.16, a * 0.25));
      ctx.fillRect(x0, g.yTop - 1, x1 - x0, g.yBottom - g.yTop + 2);
    }
    ctx.strokeStyle = rgba(c, a);
    ctx.lineWidth = l.rank === 'focus' ? 1.2 : 1;
    dash(ctx, l.style);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(g.y) + 0.5);
    ctx.lineTo(x1, Math.round(g.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ─── K 线上面 ────────────────────────────────────────────────
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

function pill(ctx: Ctx2D, r: Rect, text: string, tone: AnnTone, solid: boolean) {
  const c = TONE_COLOR[tone];
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 6);
  ctx.fillStyle = solid ? c : BG;
  ctx.fill();
  if (!solid) {
    ctx.strokeStyle = rgba(c, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.font = FONT;
  ctx.fillStyle = solid ? '#0a0d13' : c;
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
    // 在 K 线上方，尖朝下指向 K 线
    ctx.moveTo(x, apexY);
    ctx.lineTo(x - s, apexY - s * 1.5);
    ctx.lineTo(x + s, apexY - s * 1.5);
  } else {
    ctx.moveTo(x, apexY);
    ctx.lineTo(x - s, apexY + s * 1.5);
    ctx.lineTo(x + s, apexY + s * 1.5);
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
  // 左上角图例（品种 / 指标名）
  const out: Rect[] = [{ x: 0, y: plot.y, w: Math.min(320, W * 0.45), h: 44 }];
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

/** 右侧轨道：价位类标签 */
function renderRail(f: Frame, taken: Rect[], hits: Hit[]) {
  const { ctx, plot, W, bw, fmt, groups, last, occ } = f;
  type Entry = { g: LevelGroup<LevelY>; lead: LevelY; labeled: LevelY[] };
  const pool: Entry[] = [];
  for (const g of groups) {
    const labeled = g.items.filter(i => i.label).sort((a, b) => b.priority - a.priority);
    if (labeled.length) pool.push({ g, lead: labeled[0], labeled });
  }
  // 普通关键位只标离现价最近的上下各 3 条；焦点 / 判读 / 仓位始终标
  const yc = last?.closeY ?? plot.y + plot.h / 2;
  const normal = pool.filter(e => e.lead.rank === 'normal' || e.lead.rank === 'faint');
  const keepNormal = new Set<Entry>([
    ...normal.filter(e => e.g.y <= yc).sort((a, b) => yc - a.g.y - (yc - b.g.y)).slice(0, 3),
    ...normal.filter(e => e.g.y > yc).sort((a, b) => a.g.y - yc - (b.g.y - yc)).slice(0, 3),
  ]);
  const entries = pool.filter(e => (e.lead.rank !== 'normal' && e.lead.rank !== 'faint') || keepNormal.has(e));
  const byId = new Map(entries.map(e => [e.lead.id, e]));

  const placed = layoutRail(
    entries.map(e => ({ id: e.lead.id, y: e.g.y, h: LABEL_H, priority: e.lead.priority })),
    plot.y + 2,
    plot.y + plot.h - 2,
    { gap: 2, window: 60, maxPerWindow: 4, maxTotal: bw < 3 ? 4 : Infinity },
  );

  const railRight = W - 4;
  // 轨道短字：千位以上去掉小数（完整价位在悬停卡片里）
  const fmtShort = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : fmt(v));
  for (const r of placed) {
    const e = byId.get(r.id);
    if (!e) continue;
    const { lead, labeled, g } = e;
    const sameName = labeled.filter(i => i.name === lead.name);
    const lo = Math.min(...sameName.map(i => i.price));
    const hi = Math.max(...sameName.map(i => i.price));
    const priceTxt = hi - lo > 0 ? `${fmt(lo)}–${fmt(hi)}` : fmt(lead.price);
    const priceShort = hi - lo > 0 ? `${fmtShort(lo)}–${fmtShort(hi)}` : fmtShort(lead.price);
    const extra = labeled.length - sameName.length + r.folded.length;
    const suffix = extra > 0 ? ` +${extra}` : '';
    const full = `${lead.name} ${priceTxt}${suffix}`;
    // 逐级退让：完整 → 名称+短价 → 只有短价 → 贴边小色块；每一级都逐根检查是否压到 K 线
    const y0 = Math.round(r.y - LABEL_H / 2);
    const tries = [full, `${lead.name} ${priceShort}${suffix}`, `${priceShort}${suffix}`];
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
      // 色块也会压到 K 线就不画
      if (occ.hits(rect, 0)) continue;
    }
    const c = TONE_COLOR[lead.tone];
    if (tab) {
      ctx.fillStyle = rgba(c, 0.85);
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y + 2, rect.w, rect.h - 4, 2);
      ctx.fill();
    } else {
      if (Math.abs(r.y - r.desiredY) > 2) {
        leader(ctx, [[rect.x, r.y], [rect.x - 5, r.desiredY], [rect.x - 11, r.desiredY]], c);
      }
      pill(ctx, rect, text, lead.tone, !!lead.solid);
    }
    taken.push(rect);
    const folded = r.folded.map(id => groups.flatMap(gg => gg.items).find(i => i.id === id)).filter((i): i is LevelY => !!i);
    const lines: string[] = [];
    const members = [...g.items.filter(i => i.label), ...folded];
    const single = members.length === 1;
    for (const it of members) {
      // 只有一项时标题已经写了名称和价位，不再重复
      if (!single) lines.push(`· ${it.name} ${fmt(it.price)}`);
      for (const d of it.detail ?? []) if (d) lines.push(single ? d : `  ${d}`);
    }
    hits.push({ rect: tab ? { ...rect, x: rect.x - 4, w: rect.w + 8 } : rect, title: full.replace(suffix, ''), lines, tone: lead.tone });
  }
}

/** 事件：标记 + 绕开 K 线的短字 */
function renderEvents(f: Frame, taken: Rect[], hits: Hit[], memo: Map<string, string>) {
  const { ctx, bw, W, plot, occ } = f;
  const seen = new Set<string>();
  const events = [...f.p.events].sort((a, b) => b.priority - a.priority);
  const s = bw < 3 ? 3.5 : 5;
  const showText = bw >= 3 && W >= 520;
  // 先放所有标记，标签之间互相避让时也要避开别的标记
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
    if (!pick) continue; // 放不下就只留标记，悬停仍可看详情
    memo.set(ev.id, pick.key);
    const r = { ...pick.rect, x: Math.round(pick.rect.x), y: Math.round(pick.rect.y) };
    const nearY = ev.side === 'above' && r.y + r.h <= g.edge ? r.y + r.h : r.y >= g.edge ? r.y : r.y + r.h / 2;
    const nearX = Math.max(r.x, Math.min(g.b.x, r.x + r.w));
    if (Math.hypot(nearX - g.b.x, nearY - g.edge) > 7) leader(ctx, [[g.b.x, g.edge], [nearX, nearY]], c);
    pill(ctx, r, ev.text, ev.tone, false);
    taken.push(r);
    hits.push({ rect: r, title: ev.title ?? ev.text, lines: hitLines, tone: ev.tone });
  }
  for (const k of [...memo.keys()]) if (!seen.has(k)) memo.delete(k);
}

/** 区域：框右端的短字 */
function renderZones(f: Frame, taken: Rect[], hits: Hit[], memo: Map<string, string>) {
  const { ctx, X, Y, plot, occ } = f;
  for (const z of [...f.p.zones].sort((a, b) => b.priority - a.priority)) {
    if (!z.text) continue;
    const x0 = Math.max(0, X(z.fromTs));
    const x1 = Math.min(f.W, X(z.toTs));
    const y0 = Y(z.hi);
    const y1 = Y(z.lo);
    if (x1 <= x0) continue;
    const box: Rect = { x: x0, y: Math.min(y0, y1), w: x1 - x0, h: Math.abs(y1 - y0) };
    const w = textW(ctx, z.text) + 8;
    const pick = pickCandidate(zoneCandidates(box, w, LABEL_H, occ), occ, taken, plot, memo.get(z.id));
    if (!pick) continue;
    memo.set(z.id, pick.key);
    const r = pick.rect;
    // 标签离开框（越过 K 线放置）时，用引线连回框的右端
    if (r.y + r.h < box.y - 4 || r.y > box.y + box.h + 4) {
      const fromY = r.y + r.h < box.y ? box.y : box.y + box.h;
      const toY = r.y + r.h < box.y ? r.y + r.h : r.y;
      leader(ctx, [[r.x + r.w - 6, fromY], [r.x + r.w - 6, toY]], TONE_COLOR[z.tone]);
    }
    pill(ctx, r, z.text, z.tone, false);
    taken.push(pick.rect);
    hits.push({ rect: pick.rect, title: z.title ?? z.text, lines: z.detail ?? [], tone: z.tone });
  }
}

function renderCard(f: Frame, hit: Hit, cursor: { x: number; y: number }) {
  const { ctx, plot } = f;
  const maxW = 260;
  const measure = (s: string) => textW(ctx, s, FONT_CARD);
  const lines = hit.lines.flatMap(l => wrapText(l, maxW - 16, measure));
  const titleLines = wrapText(hit.title, maxW - 16, s => textW(ctx, s, FONT_BOLD));
  const w = Math.min(maxW, Math.max(...titleLines.map(s => textW(ctx, s, FONT_BOLD)), ...lines.map(measure), 60) + 16);
  const h = 8 + titleLines.length * 15 + (lines.length ? 4 + lines.length * 14 : 0) + 6;
  const r = placeCard(cursor, w, h, plot);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 8);
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
  ctx.font = FONT_CARD;
  ctx.fillStyle = MUTED_TEXT;
  for (const l of lines) {
    ctx.fillText(l, r.x + 8, y);
    y += 14;
  }
}

let registered = false;

export function registerAnnotLayers() {
  if (registered) return;
  registered = true;

  registerRendererLayer({
    id: ANNOT_UNDER,
    placement: 'below-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      const indexOf = makeIndexCache();
      return {
        mount(c) {
          canvas = c;
          c.dataset.annotationLayer = ANNOT_UNDER;
        },
        render(args) {
          const f = setup(canvas, args, indexOf);
          if (f) renderUnder(f);
        },
      };
    },
  });

  registerRendererLayer({
    id: ANNOT_OVER,
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
          c.dataset.annotationLayer = ANNOT_OVER;
        },
        render(args) {
          const f = setup(canvas, args, indexOf);
          if (!f) return;
          // 不在拖动时变淡：实时图表会自己跟着价格微移，和用户拖动无法可靠区分，变淡就是闪烁的来源
          const { ctx, plot } = f;
          ctx.save();
          ctx.beginPath();
          ctx.rect(plot.x, plot.y, plot.w, plot.h);
          ctx.clip();
          const taken = obstaclesOf(f);
          const hits: Hit[] = [];
          // 顺序即优先级：仓位与焦点在轨道上最先占位，其次事件，最后区域
          renderRail(f, taken, hits);
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
      };
    },
  });
}
