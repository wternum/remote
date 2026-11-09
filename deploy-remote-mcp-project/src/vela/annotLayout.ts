// ─────────────────────────────────────────────────────────────
//  标注排版算法（纯函数，屏幕像素坐标，可单测）
//  1. mergeLevels  ：屏幕上距离很近的关键位合并成一条（缩小时合并，放大后自动分开）
//  2. layoutRail   ：右侧标签轨道 —— 拥挤时上下推开，过密时合并成「+N」
//  3. placeLabel   ：事件标签 —— 在候选位置里挑第一个不压 K 线、不压其他标签、不出界的
//  4. placeCard    ：悬停卡片 —— 优先放在鼠标右下，放不下就翻转
// ─────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const intersects = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

export const inside = (r: Rect, b: Rect) => r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;

// ─── 1. 关键位合并 ────────────────────────────────────────────
export interface LevelIn {
  id: string;
  y: number;
  price: number;
  priority: number;
}

export interface LevelGroup<T extends LevelIn> {
  /** 代表项（优先级最高）：决定样式与标签 */
  lead: T;
  items: T[];
  /** 线画在代表项的 y 上 */
  y: number;
  yTop: number;
  yBottom: number;
  lo: number;
  hi: number;
}

export function mergeLevels<T extends LevelIn>(levels: T[], gapPx = 6): LevelGroup<T>[] {
  const sorted = levels.filter(l => Number.isFinite(l.y)).sort((a, b) => a.y - b.y || b.priority - a.priority);
  const out: LevelGroup<T>[] = [];
  for (const l of sorted) {
    const g = out[out.length - 1];
    if (g && l.y - g.yBottom <= gapPx) {
      g.items.push(l);
      g.yBottom = l.y;
      g.lo = Math.min(g.lo, l.price);
      g.hi = Math.max(g.hi, l.price);
      if (l.priority > g.lead.priority) g.lead = l;
    } else {
      out.push({ lead: l, items: [l], y: l.y, yTop: l.y, yBottom: l.y, lo: l.price, hi: l.price });
    }
  }
  for (const g of out) g.y = g.lead.y;
  return out;
}

// ─── 2. 右侧标签轨道 ──────────────────────────────────────────
export interface RailIn {
  id: string;
  /** 期望的中心 y（真实价位） */
  y: number;
  h: number;
  priority: number;
}

export interface RailOut {
  id: string;
  /** 排版后的中心 y */
  y: number;
  desiredY: number;
  /** 被收进「+N」的其他标签 id */
  folded: string[];
}

export interface RailOptions {
  gap?: number;
  /** 密度窗口（像素）与窗口内最多标签数：超过就合并成「+N」 */
  window?: number;
  maxPerWindow?: number;
  /** 最多保留几个（缩得很小时用） */
  maxTotal?: number;
}

export function layoutRail(items: RailIn[], top: number, bottom: number, opts: RailOptions = {}): RailOut[] {
  const gap = opts.gap ?? 2;
  const win = opts.window ?? 60;
  const maxPer = opts.maxPerWindow ?? 4;
  const maxTotal = opts.maxTotal ?? Infinity;
  const visible = items.filter(it => Number.isFinite(it.y) && it.y >= top - it.h / 2 && it.y <= bottom + it.h / 2);

  // 先按优先级决定谁留下：窗口内已满 / 总数已满 → 折叠到最近的已保留标签
  const byPriority = [...visible].sort((a, b) => b.priority - a.priority || a.y - b.y || (a.id < b.id ? -1 : 1));
  const kept: { it: RailIn; folded: string[] }[] = [];
  for (const it of byPriority) {
    const crowd = kept.filter(k => Math.abs(k.it.y - it.y) < win / 2).length;
    if (kept.length < maxTotal && crowd < maxPer) {
      kept.push({ it, folded: [] });
      continue;
    }
    let host = kept[0];
    for (const k of kept) if (Math.abs(k.it.y - it.y) < Math.abs(host.it.y - it.y)) host = k;
    host?.folded.push(it.id);
  }

  // 再做一维避让：按期望 y 排序，重叠的合并成簇，簇整体放在使位移平方和最小的位置
  const sorted = kept.sort((a, b) => a.it.y - b.it.y || (a.it.id < b.it.id ? -1 : 1));
  interface Cluster {
    members: { it: RailIn; folded: string[]; offset: number }[];
    size: number;
    top: number;
  }
  const clusters: Cluster[] = [];
  const settle = (c: Cluster) => {
    let s = 0;
    for (const m of c.members) s += m.it.y - m.it.h / 2 - m.offset;
    c.top = s / c.members.length;
    c.top = Math.min(c.top, bottom - c.size);
    c.top = Math.max(c.top, top);
  };
  for (const k of sorted) {
    clusters.push({ members: [{ ...k, offset: 0 }], size: k.it.h, top: 0 });
    settle(clusters[clusters.length - 1]);
    while (clusters.length >= 2) {
      const b = clusters[clusters.length - 1];
      const a = clusters[clusters.length - 2];
      if (a.top + a.size + gap <= b.top) break;
      const base = a.size + gap;
      for (const m of b.members) a.members.push({ ...m, offset: m.offset + base });
      a.size = base + b.size;
      clusters.pop();
      settle(a);
    }
  }
  const out: RailOut[] = [];
  for (const c of clusters) for (const m of c.members) out.push({ id: m.it.id, y: c.top + m.offset + m.it.h / 2, desiredY: m.it.y, folded: m.folded });
  return out;
}

// ─── 3. K 线占位 + 事件 / 区域标签选位 ───────────────────────
export interface Column {
  /** K 线中心 x */
  x: number;
  /** 最高价对应的 y（屏幕上方） */
  top: number;
  /** 最低价对应的 y */
  bottom: number;
}

export interface Occupancy {
  /** x 区间内所有 K 线的最高 / 最低 y；没有 K 线返回 null */
  span(x0: number, x1: number): { top: number; bottom: number } | null;
  /** 矩形是否压到任何 K 线（逐根检查，允许标签放在 K 线之间的空隙里） */
  hits(r: Rect, pad?: number): boolean;
}

export function buildOccupancy(cols: Column[], halfWidth: number): Occupancy {
  const cs = [...cols].sort((a, b) => a.x - b.x);
  const firstAtOrAfter = (x: number) => {
    let lo = 0;
    let hi = cs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].x < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    span(x0, x1) {
      let top = Infinity;
      let bottom = -Infinity;
      for (let i = firstAtOrAfter(x0 - halfWidth); i < cs.length && cs[i].x <= x1 + halfWidth; i++) {
        top = Math.min(top, cs[i].top);
        bottom = Math.max(bottom, cs[i].bottom);
      }
      return top === Infinity ? null : { top, bottom };
    },
    hits(r, pad = 1) {
      for (let i = firstAtOrAfter(r.x - halfWidth - pad); i < cs.length && cs[i].x <= r.x + r.w + halfWidth + pad; i++) {
        const c = cs[i];
        if (c.top - pad < r.y + r.h && r.y < c.bottom + pad) return true;
      }
      return false;
    },
  };
}

export interface Candidate {
  rect: Rect;
  /** 越小越好 */
  cost: number;
  key: string;
}

/** 候选位置是否合法：在边界内、不压 K 线、不压已放置的标签 / 障碍 */
export function isFree(r: Rect, occ: Occupancy, taken: Rect[], bounds: Rect) {
  if (!inside(r, bounds)) return false;
  if (occ.hits(r)) return false;
  for (const t of taken) if (intersects(r, t, 2)) return false;
  return true;
}

/** 选第一个合法且代价最小的候选；上一帧用过的位置有加分，避免来回跳 */
export function pickCandidate(cands: Candidate[], occ: Occupancy, taken: Rect[], bounds: Rect, prevKey?: string): Candidate | null {
  let best: Candidate | null = null;
  let bestCost = Infinity;
  for (const c of cands) {
    if (!isFree(c.rect, occ, taken, bounds)) continue;
    const cost = c.cost - (prevKey && c.key === prevKey ? 30 : 0);
    if (cost < bestCost) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

export interface EventGeom {
  x: number;
  /** 标记的外缘：above 时为标记顶部 y，below 时为标记底部 y */
  markerEdge: number;
  side: 'above' | 'below';
  w: number;
  h: number;
}

/** 事件标签候选：先贴着标记、再左右挪、再抬高、最后换到另一侧 */
export function eventCandidates(g: EventGeom, occ: Occupancy): Candidate[] {
  const out: Candidate[] = [];
  const shifts = [0, 0.6, -0.6, 1.2, -1.2, 2, -2];
  const lifts = [0, 12, 26, 44];
  for (const side of [g.side, g.side === 'above' ? 'below' : 'above'] as const) {
    const flip = side !== g.side;
    for (const s of shifts) {
      const x = g.x + s * g.w - g.w / 2;
      const span = occ.span(x, x + g.w);
      for (const lift of lifts) {
        let y: number;
        if (side === 'above') {
          const ref = Math.min(flip ? Infinity : g.markerEdge, span ? span.top : Infinity);
          y = (Number.isFinite(ref) ? ref : g.markerEdge) - 4 - g.h - lift;
        } else {
          const ref = Math.max(flip ? -Infinity : g.markerEdge, span ? span.bottom : -Infinity);
          y = (Number.isFinite(ref) ? ref : g.markerEdge) + 4 + lift;
        }
        const dist = Math.abs((side === 'above' ? y + g.h : y) - g.markerEdge);
        out.push({
          rect: { x, y, w: g.w, h: g.h },
          cost: Math.abs(s) * 18 + lift * 0.8 + dist * 0.25 + (flip ? 60 : 0),
          key: `${side}:${s}:${lift}`,
        });
      }
    }
  }
  return out;
}

/** 区域标签候选：框内右上 / 右下 → 框上方右端 / 下方右端 → 越过这段 K 线的上方 / 下方（画引线连回框） */
export function zoneCandidates(box: Rect, w: number, h: number, occ?: Occupancy): Candidate[] {
  const right = box.x + box.w - w - 4;
  const span = occ?.span(right, right + w);
  const beyond: Candidate[] = span
    ? [
        { rect: { x: right, y: span.top - h - 4, w, h }, cost: 30, key: 'over-candles' },
        { rect: { x: right, y: span.bottom + 4, w, h }, cost: 32, key: 'under-candles' },
      ]
    : [];
  return [
    ...beyond,
    { rect: { x: right, y: box.y + 3, w, h }, cost: 0, key: 'in-top' },
    { rect: { x: right, y: box.y + box.h - h - 3, w, h }, cost: 5, key: 'in-bottom' },
    { rect: { x: right, y: box.y - h - 3, w, h }, cost: 10, key: 'above' },
    { rect: { x: right, y: box.y + box.h + 3, w, h }, cost: 12, key: 'below' },
    { rect: { x: box.x + 4, y: box.y - h - 3, w, h }, cost: 20, key: 'above-left' },
    { rect: { x: box.x + 4, y: box.y + box.h + 3, w, h }, cost: 22, key: 'below-left' },
  ];
}

/** 区域标签与所属区域之间允许的最大像素间隙（贴边，不漂移）。 */
export const ZONE_LABEL_MAX_GAP = 4;

/**
 * 「贴附式」区域标签候选：每个候选都紧贴区域边框（内部、上下边沿或左右两端），
 * 与区域的间隙不超过 ZONE_LABEL_MAX_GAP。
 *
 * 与 zoneCandidates 的区别：不提供「越过这段 K 线的上方 / 下方」远端位置。
 * 窄区域（例如 FVG）的右端常与最新 K 线重叠，远端候选会让标签漂到整段 K 线
 * 的顶部/底部并画出长引线，看起来像标到了别的价位。放不下时宁可只画区域、
 * 不画文字（悬停区域仍可看详情），也不把文字放到错误价位。
 */
export function attachedZoneCandidates(box: Rect, w: number, h: number): Candidate[] {
  const cy = box.y + box.h / 2;
  const gap = 2;
  const fitsInside = box.h >= h + 2;
  const insideY = fitsInside ? box.y + (box.h - h) / 2 : cy - h / 2;
  const rightIn = box.x + box.w - w - 4;
  const leftIn = box.x + 4;
  return [
    // 区域右端外侧、价位居中：区域延伸到最新 K 线右侧的空白里，通常最清晰
    { rect: { x: box.x + box.w + gap + 2, y: cy - h / 2, w, h }, cost: 0, key: 'right-mid' },
    { rect: { x: rightIn, y: insideY, w, h }, cost: 4, key: 'in-right' },
    { rect: { x: rightIn, y: box.y - h - gap, w, h }, cost: 8, key: 'above-right' },
    { rect: { x: rightIn, y: box.y + box.h + gap, w, h }, cost: 10, key: 'below-right' },
    { rect: { x: box.x - w - gap - 2, y: cy - h / 2, w, h }, cost: 14, key: 'left-mid' },
    { rect: { x: leftIn, y: insideY, w, h }, cost: 16, key: 'in-left' },
    { rect: { x: leftIn, y: box.y - h - gap, w, h }, cost: 18, key: 'above-left' },
    { rect: { x: leftIn, y: box.y + box.h + gap, w, h }, cost: 20, key: 'below-left' },
  ];
}

/** 标签矩形到区域矩形的最短像素距离（重叠为 0），用于验证贴附约束。 */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

// ─── 4. 悬停卡片 ──────────────────────────────────────────────
export function placeCard(cursor: { x: number; y: number }, w: number, h: number, bounds: Rect, offset = 14): Rect {
  let x = cursor.x + offset;
  let y = cursor.y + offset;
  if (x + w > bounds.x + bounds.w) x = cursor.x - offset - w;
  if (y + h > bounds.y + bounds.h) y = cursor.y - offset - h;
  x = Math.max(bounds.x + 2, Math.min(x, bounds.x + bounds.w - w - 2));
  y = Math.max(bounds.y + 2, Math.min(y, bounds.y + bounds.h - h - 2));
  return { x, y, w, h };
}

/** 按像素宽度折行（中英文混排，逐字测量） */
export function wrapText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of text) {
    const next = line + ch;
    if (line && measure(next) > maxW) {
      out.push(line);
      line = ch.trimStart();
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}
