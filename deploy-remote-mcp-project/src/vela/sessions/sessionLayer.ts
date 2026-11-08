// ─────────────────────────────────────────────────────────────
//  交易时段图表渲染图层（基于 @luxalgo/vela/plugin 的双层 Canvas）
//  · pd-session-under (below-data)：时段垂直微光色带、时段边界细虚线、00:00 UTC 日界线、
//    亚盘箱体与 AH/AL 水平延伸线
//  · pd-session-over  (above-data)：底部时段丝带（彩色下划线 + 胶囊徽标）、
//    右缘吸附的 AH/AL 价格签与扫荡菱形标记
//
//  UI 布局约定（避免与原生 UI / 价格动作互相遮挡）：
//   · 顶部留给 Vela 原生 OHLC 读数（symbol · 开/高/低/收），不绘制任何时段文字；
//   · 时段徽标统一放入绘图区底部的独立丝带轨道（时间轴上方），该区域通常只有成交量；
//   · 叠加时段（欧美重叠 / 伦敦收盘）只用更亮的下划线表达，不再堆叠第二行文字；
//   · AH/AL 价格签吸附右缘（类似价格轴标签），不与 K 线实体争抢空间，
//     且与最新价标签垂直距离过近时自动让位。
// ─────────────────────────────────────────────────────────────
import { registerRendererLayer, type RendererLayerArgs } from '@luxalgo/vela/plugin';
import {
  computeAsiaRangeLevels,
  computeDailyDividers,
  computeSessionSpans,
  DAY_MS,

  isIntradayTimeframe,
  type AsiaRangeSummary,
  type BarLike,
} from './sessionMath';
import { getSessionStore, type SessionPreferences } from './sessionStore';

export const SESSION_UNDER_ID = 'pd-session-under';
export const SESSION_OVER_ID = 'pd-session-over';

const FONT_BADGE = "500 10px 'IBM Plex Mono', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const FONT_TAG = "500 10px 'IBM Plex Mono', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 底部丝带轨道高度：徽标与下划线都限制在这条轨道内 */
const RIBBON_H = 38;
const BADGE_H = 20;
/** 左下角 Vela  attribution「V」为 DOM 元素（位于画布之上），徽标左缘让出该 gutter */
const RIBBON_LEFT = 44;

type Ctx2D = CanvasRenderingContext2D;

function inferPriceDecimals(bars: readonly BarLike[]): number {
  if (!bars.length) return 2;
  const p = bars[bars.length - 1].close;
  if (p >= 1000) return 1;
  if (p >= 10) return 2;
  if (p >= 1) return 3;
  return 4;
}

function drawRoundedPill(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string,
  stroke?: string,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawDiamond(ctx: Ctx2D, cx: number, cy: number, r: number, fill: string, stroke: string) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 计算当前视口与可见 K 线的时间跨度 */
function getVisibleTimeRange(args: RendererLayerArgs): { minMs: number; maxMs: number } | null {
  const { bars } = args;
  if (!bars || !bars.length) return null;
  const first = bars[0].time;
  const last = bars[bars.length - 1].time;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  // 向前多扩展 1 个自然日以确保跨日边界的亚盘区间与色带完整
  return {
    minMs: first - DAY_MS,
    maxMs: last + DAY_MS * 0.5,
  };
}

function renderSessionUnder(canvas: HTMLCanvasElement | null, args: RendererLayerArgs | null, prefs: SessionPreferences) {
  if (!canvas || !args) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { coords, scale, bounds, bars } = args;
  const dpr = coords.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!prefs.enabled || !bars.length) return;

  const intraday = isIntradayTimeframe(bars);
  if (!intraday) {
    getSessionStore().updateSummary({ intraday: false, latestAsia: null, visibleSpans: 0 });
    return;
  }

  const range = getVisibleTimeRange(args);
  if (!range) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = coords.width;
  const plotTop = bounds.top;
  const plotH = bounds.height;
  const plotBottom = plotTop + plotH;

  ctx.beginPath();
  ctx.rect(0, plotTop, W, plotH);
  ctx.clip();

  const X = (ms: number) => coords.timeToX(ms);
  const Y = (price: number) => coords.priceToY(price, scale, bounds);

  // 1. 时段背景微光色带（不再绘制顶部亮条，顶部完全让位给原生 OHLC 读数）
  const spans = computeSessionSpans(range.minMs, range.maxMs, {
    mode: prefs.mode,
    clockMode: prefs.clockMode,
    enabledSessions: prefs.enabledSessions,
    showOverlap: prefs.showOverlap,
  });

  let visibleSpanCount = 0;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const x0 = X(sp.startMs);
    const x1 = X(sp.endMs);
    if (x1 < 0 || x0 > W) continue;
    const cx0 = Math.max(0, x0);
    const cx1 = Math.min(W, x1);
    const w = cx1 - cx0;
    if (w < 1.5) continue;
    visibleSpanCount++;

    if (prefs.showBands) {
      ctx.save();
      ctx.globalAlpha = prefs.bandOpacity / 100;
      ctx.fillStyle = sp.style.bandFill;
      ctx.fillRect(cx0, plotTop, w, plotH);
      ctx.restore();

      // 时段开启边界细虚线（叠加时段更淡，避免竖线过密）
      if (x0 >= 0 && x0 <= W) {
        ctx.save();
        ctx.strokeStyle = sp.style.dividerStroke;
        ctx.globalAlpha = sp.isOverlay ? 0.55 : 1;
        ctx.lineWidth = 1;
        ctx.setLineDash(sp.isOverlay ? [2, 4] : [3, 5]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, plotTop);
        ctx.lineTo(Math.round(x0) + 0.5, plotBottom);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 2. 00:00 UTC 日界分割线（仅细虚线，日期信息并入底部 ASIA 徽标）
  if (prefs.showDailyOpen) {
    const dividers = computeDailyDividers(bars, range.minMs, range.maxMs);
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.13)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    for (const div of dividers) {
      const x = X(div.dayStartMs);
      if (x < 0 || x > W) continue;
      const rx = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(rx, plotTop);
      ctx.lineTo(rx, plotBottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. 亚盘高低点 (AH / AL) 箱体与水平延伸线
  const asiaSummaries = computeAsiaRangeLevels(bars, range.minMs, range.maxMs);
  const latestAsia: AsiaRangeSummary | null =
    asiaSummaries.length > 0 ? asiaSummaries[asiaSummaries.length - 1] : null;

  if (prefs.showAsiaRange && asiaSummaries.length > 0) {
    for (const ar of asiaSummaries) {
      const boxX0 = X(ar.asiaStartMs);
      const boxX1 = X(ar.asiaEndMs);
      const lineEndHighX = X(ar.highLineEndMs);
      const lineEndLowX = X(ar.lowLineEndMs);
      const maxRightX = Math.max(boxX1, lineEndHighX, lineEndLowX);
      if (maxRightX < 0 || boxX0 > W) continue;

      const yHigh = Y(ar.high);
      const yLow = Y(ar.low);

      // 亚盘箱体微弱轮廓 (00:00 - 08:00 UTC)
      if (boxX1 > 0 && boxX0 < W) {
        const bx0 = Math.max(0, boxX0);
        const bx1 = Math.min(W, boxX1);
        const by0 = Math.max(plotTop, Math.min(yHigh, yLow));
        const by1 = Math.min(plotBottom, Math.max(yHigh, yLow));
        if (bx1 > bx0 + 2 && by1 > by0 + 2) {
          ctx.save();
          ctx.strokeStyle = 'rgba(167, 139, 250, 0.18)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 4]);
          ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
          ctx.restore();
        }
      }

      // AH 水平延伸线
      const ahStartX = Math.max(0, X(ar.highBarMs));
      const ahEndX = Math.min(W, lineEndHighX);
      if (ahEndX > ahStartX + 4 && yHigh >= plotTop && yHigh <= plotBottom) {
        ctx.save();
        ctx.strokeStyle =
          ar.highState === 'swept_reject'
            ? 'rgba(251, 191, 36, 0.62)'
            : ar.highState === 'broken'
              ? 'rgba(167, 139, 250, 0.34)'
              : 'rgba(196, 181, 253, 0.5)';
        ctx.lineWidth = ar.highState === 'swept_reject' ? 1.25 : 1;
        ctx.setLineDash(ar.highState === 'broken' ? [2, 4] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(ahStartX, Math.round(yHigh) + 0.5);
        ctx.lineTo(ahEndX, Math.round(yHigh) + 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // AL 水平延伸线
      const alStartX = Math.max(0, X(ar.lowBarMs));
      const alEndX = Math.min(W, lineEndLowX);
      if (alEndX > alStartX + 4 && yLow >= plotTop && yLow <= plotBottom) {
        ctx.save();
        ctx.strokeStyle =
          ar.lowState === 'swept_reject'
            ? 'rgba(52, 211, 153, 0.62)'
            : ar.lowState === 'broken'
              ? 'rgba(56, 189, 248, 0.34)'
              : 'rgba(125, 211, 252, 0.5)';
        ctx.lineWidth = ar.lowState === 'swept_reject' ? 1.25 : 1;
        ctx.setLineDash(ar.lowState === 'broken' ? [2, 4] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(alStartX, Math.round(yLow) + 0.5);
        ctx.lineTo(alEndX, Math.round(yLow) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  ctx.restore();
  getSessionStore().updateSummary({
    intraday: true,
    latestAsia,
    visibleSpans: visibleSpanCount,
  });
}

function renderSessionOver(canvas: HTMLCanvasElement | null, args: RendererLayerArgs | null, prefs: SessionPreferences) {
  if (!canvas || !args) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { coords, scale, bounds, bars } = args;
  const dpr = coords.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!prefs.enabled || !bars.length || !isIntradayTimeframe(bars)) return;

  const range = getVisibleTimeRange(args);
  if (!range) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = coords.width;
  const plotTop = bounds.top;
  const plotH = bounds.height;
  const plotBottom = plotTop + plotH;

  ctx.beginPath();
  ctx.rect(0, plotTop, W, plotH);
  ctx.clip();

  const X = (ms: number) => coords.timeToX(ms);
  const Y = (price: number) => coords.priceToY(price, scale, bounds);
  const decimals = inferPriceDecimals(bars);
  const lastCloseY = Y(bars[bars.length - 1].close);

  // 底部丝带轨道：所有时段文字/下划线都限制在 plotBottom - RIBBON_H 之内，
  // 不侵占顶部 OHLC 读数，也不堆叠到 K 线实体上。
  const ribbonTop = plotBottom - RIBBON_H;

  // 1. 底部时段丝带：先画彩色下划线，再画主时段胶囊徽标
  if (prefs.showBadges) {
    const spans = computeSessionSpans(range.minMs, range.maxMs, {
      mode: prefs.mode,
      clockMode: prefs.clockMode,
      enabledSessions: prefs.enabledSessions,
      showOverlap: prefs.showOverlap,
    });

    // 1a. 下划线：主时段贴底 2px，叠加时段在其上方 2px（更亮），用颜色而非文字表达重叠
    for (const sp of spans) {
      const x0 = X(sp.startMs);
      const x1 = X(sp.endMs);
      if (x1 < 0 || x0 > W) continue;
      const cx0 = Math.max(0, x0);
      const cx1 = Math.min(W, x1);
      if (cx1 - cx0 < 2) continue;
      const uy = sp.isOverlay ? plotBottom - 4 : plotBottom - 2;
      ctx.globalAlpha = sp.isOverlay ? 0.85 : 0.5;
      ctx.fillStyle = sp.isOverlay ? sp.style.bandTopBorder : sp.style.hex;
      ctx.fillRect(cx0, uy, cx1 - cx0, 2);
    }
    ctx.globalAlpha = 1;

    // 1b. 主时段胶囊徽标（单行、左吸附、防重叠；叠加时段不画文字）
    ctx.font = FONT_BADGE;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const badgeY = plotBottom - BADGE_H - 5;
    let lastRight = -Infinity;

    for (const sp of spans) {
      if (sp.isOverlay) continue;
      const x0 = X(sp.startMs);
      const x1 = X(sp.endMs);
      if (x1 < 12 || x0 > W - 12) continue;

      // 完整中文名称 + 实际起止时间。长名称分两行，避免横向截断；
      // 窄到连两行都放不下时才隐藏，侧栏完整图例仍可查。
      const timeLabel = sp.utcWindow.replace(/\s*UTC$/, '');
      const twoLine = ctx.measureText(`${sp.name} ${timeLabel}`).width + 20 > Math.min(260, x1 - Math.max(RIBBON_LEFT, x0 + 4));
      const pillW = Math.ceil(Math.max(ctx.measureText(sp.name).width, twoLine ? ctx.measureText(timeLabel).width : ctx.measureText(`${sp.name} ${timeLabel}`).width) + 20);
      const pillH = twoLine ? 29 : BADGE_H;
      const bx = Math.min(Math.max(RIBBON_LEFT, x0 + 4), W - pillW - 4);
      const by = twoLine ? plotBottom - pillH - 5 : badgeY;
      if (x1 - bx < pillW + 4 || bx < lastRight + 6) continue;
      lastRight = bx + pillW;
      drawRoundedPill(ctx, bx, by, pillW, pillH, 3.5, sp.style.badgeBg, sp.style.badgeBorder);
      ctx.beginPath();
      ctx.arc(bx + 6, by + (twoLine ? 8 : pillH / 2), 2, 0, Math.PI * 2);
      ctx.fillStyle = sp.style.hex;
      ctx.fill();
      ctx.fillStyle = sp.style.badgeText;
      if (twoLine) {
        ctx.fillText(sp.name, bx + 11, by + 8);
        ctx.fillText(timeLabel, bx + 11, by + 20);
      } else {
        ctx.fillText(`${sp.name} ${timeLabel}`, bx + 11, by + pillH / 2 + 0.5);
      }
    }
  }

  // 2. AH / AL：扫荡菱形标记 + 右缘吸附价格签（不再把大胶囊压在 K 线上）
  if (prefs.showAsiaRange) {
    const asiaSummaries = computeAsiaRangeLevels(bars, range.minMs, range.maxMs);
    ctx.font = FONT_TAG;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const drawEdgeTag = (
      yPrice: number,
      label: string,
      bg: string,
      border: string,
      fg: string,
    ) => {
      // 与最新价标签垂直距离过近时让位，避免右缘标签堆叠
      if (Math.abs(yPrice - lastCloseY) < 18) return;
      if (yPrice < plotTop + 4 || yPrice > ribbonTop - 4) return;
      const tw = ctx.measureText(label).width;
      const pw = Math.ceil(tw + 10);
      const ph = 15;
      const lx = W - pw - 2;
      const ly = Math.max(plotTop + 2, Math.min(ribbonTop - ph - 2, Math.round(yPrice) - ph / 2));
      drawRoundedPill(ctx, lx, ly, pw, ph, 3, bg, border);
      ctx.fillStyle = fg;
      ctx.fillText(label, lx + 5, ly + ph / 2 + 0.5);
    };

    for (const ar of asiaSummaries) {
      const ahEndX = X(ar.highLineEndMs);
      const yHigh = Y(ar.high);
      if (ahEndX > 20 && ahEndX < W && yHigh >= plotTop && yHigh <= plotBottom) {
        if (ar.highTouchMs != null) {
          drawDiamond(
            ctx,
            ahEndX,
            yHigh,
            3.5,
            ar.highState === 'swept_reject' ? '#f59e0b' : '#a78bfa',
            '#0f172a',
          );
        }
        drawEdgeTag(
          yHigh,
          `亚太交易时段高点 ${ar.high.toFixed(decimals)}`,
          ar.highState === 'swept_reject' ? 'rgba(45, 27, 10, 0.92)' : 'rgba(24, 19, 42, 0.9)',
          ar.highState === 'swept_reject' ? 'rgba(245, 158, 11, 0.55)' : 'rgba(167, 139, 250, 0.42)',
          ar.highState === 'swept_reject' ? '#fcd34d' : '#ddd6fe',
        );
      }

      const alEndX = X(ar.lowLineEndMs);
      const yLow = Y(ar.low);
      if (alEndX > 20 && alEndX < W && yLow >= plotTop && yLow <= plotBottom) {
        if (ar.lowTouchMs != null) {
          drawDiamond(
            ctx,
            alEndX,
            yLow,
            3.5,
            ar.lowState === 'swept_reject' ? '#10b981' : '#38bdf8',
            '#0f172a',
          );
        }
        drawEdgeTag(
          yLow,
          `亚太交易时段低点 ${ar.low.toFixed(decimals)}`,
          ar.lowState === 'swept_reject' ? 'rgba(10, 38, 30, 0.92)' : 'rgba(12, 28, 44, 0.9)',
          ar.lowState === 'swept_reject' ? 'rgba(16, 185, 129, 0.55)' : 'rgba(56, 189, 248, 0.42)',
          ar.lowState === 'swept_reject' ? '#6ee7b7' : '#bae6fd',
        );
      }
    }
  }

  ctx.restore();
}

let sessionLayersRegistered = false;

export function registerSessionLayers() {
  if (sessionLayersRegistered) return;
  sessionLayersRegistered = true;

  const store = getSessionStore();

  registerRendererLayer({
    id: SESSION_UNDER_ID,
    placement: 'below-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      let lastArgs: RendererLayerArgs | null = null;
      const unsub = store.subscribe(() => {
        if (canvas && lastArgs) {
          renderSessionUnder(canvas, lastArgs, store.getSnapshot().preferences);
        }
      });
      return {
        mount(c) {
          canvas = c;
          c.dataset.sessionLayer = SESSION_UNDER_ID;
        },
        render(args) {
          lastArgs = args;
          renderSessionUnder(canvas, args, store.getSnapshot().preferences);
        },
        destroy() {
          unsub();
          canvas = null;
          lastArgs = null;
        },
      };
    },
  });

  registerRendererLayer({
    id: SESSION_OVER_ID,
    placement: 'above-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      let lastArgs: RendererLayerArgs | null = null;
      const unsub = store.subscribe(() => {
        if (canvas && lastArgs) {
          renderSessionOver(canvas, lastArgs, store.getSnapshot().preferences);
        }
      });
      return {
        mount(c) {
          canvas = c;
          c.dataset.sessionLayer = SESSION_OVER_ID;
        },
        render(args) {
          lastArgs = args;
          renderSessionOver(canvas, args, store.getSnapshot().preferences);
        },
        destroy() {
          unsub();
          canvas = null;
          lastArgs = null;
        },
      };
    },
  });
}
