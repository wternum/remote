import { macroWindows, overlapWindow, type SessionClockMode, type ClockWindow } from './sessionClock';
// ─────────────────────────────────────────────────────────────
//  交易时段计算引擎（UTC 基准纯函数模块）
//  支持：
//   · 模式 A (macro)   ：亚太 / 伦敦 / 纽约 三大宏观时段 + 13:00-16:00 欧美重叠黄金期
//   · 模式 B (killzone)：Asian Range / London Open / NY Open / London Close 四大 ICT 猎杀区
//   · 亚盘高低位 (AH / AL) 自动统计、向后延伸与欧美盘扫荡收回（Sweep）/ 突破检测
//   · 00:00 UTC 日界分割线计算
// ─────────────────────────────────────────────────────────────

export type SessionMode = 'macro' | 'killzone';
export type SessionId = 'asia' | 'london' | 'ny' | 'overlap' | 'london_close';

export interface SessionStyle {
  id: SessionId;
  name: string;
  shortLabel: string;
  utcWindow: string;
  cnWindow: string;
  description: string;
  hex: string;
  bandFill: string;
  bandTopBorder: string;
  dividerStroke: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
}

export interface SessionDefinition extends SessionStyle {
  /** 距离当日 00:00 UTC 的起始分钟数 [0, 1440) */
  startMin: number;
  /** 距离当日 00:00 UTC 的结束分钟数 (0, 1440] */
  endMin: number;
  /** 是否属于叠加子时段（如欧美重叠期） */
  isOverlay?: boolean;
}

export interface SessionSpan {
  key: string;
  id: SessionId;
  name: string;
  shortLabel: string;
  badgeLabel: string;
  utcWindow: string;
  dayStartMs: number;
  startMs: number;
  endMs: number;
  isOverlay: boolean;
  style: SessionStyle;
}

export interface DailyDivider {
  dayStartMs: number;
  dateLabel: string;
  openPrice: number | null;
}

export type AsiaSweepState = 'untouched' | 'swept_reject' | 'broken';

export interface AsiaRangeSummary {
  dayStartMs: number;
  dateLabel: string;
  asiaStartMs: number;
  asiaEndMs: number;
  dayEndMs: number;
  high: number;
  highBarMs: number;
  low: number;
  lowBarMs: number;
  rangePct: number;
  barCount: number;
  /** AH 延伸终点（首次被刺破的 K 线时间，若未触及则延伸至当日结束或最新 K 线） */
  highLineEndMs: number;
  highState: AsiaSweepState;
  highTouchMs: number | null;
  /** AL 延伸终点 */
  lowLineEndMs: number;
  lowState: AsiaSweepState;
  lowTouchMs: number | null;
}

export interface BarLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const DAY_MS = 86_400_000;
export const MIN_MS = 60_000;

/** 极简克制的暗黑配色方案（避免干扰红绿 K 线与现有信号标注） */
export const SESSION_STYLES: Record<SessionId, SessionStyle> = {
  asia: {
    id: 'asia',
    name: '亚太交易时段',
    shortLabel: '亚太交易时段',
    utcWindow: '00:00–08:00 UTC',
    cnWindow: '北京 08:00–16:00',
    description: '东京/香港/新加坡主力时段，通常呈区间震荡蓄积，构建时段高点与时段低点参照。',
    hex: '#8b5cf6',
    bandFill: 'rgba(139, 92, 246, 0.055)',
    bandTopBorder: 'rgba(167, 139, 250, 0.48)',
    dividerStroke: 'rgba(167, 139, 250, 0.24)',
    badgeBg: 'rgba(24, 19, 42, 0.88)',
    badgeBorder: 'rgba(139, 92, 246, 0.45)',
    badgeText: '#c4b5fd',
  },
  london: {
    id: 'london',
    name: '伦敦交易时段',
    shortLabel: '伦敦交易时段',
    utcWindow: '08:00–16:00 UTC',
    cnWindow: '北京 16:00–24:00',
    description: '欧洲时段观察窗口；越位/收回只描述价格事实，不证明机构意图或止损触发。',
    hex: '#0ea5e9',
    bandFill: 'rgba(14, 165, 233, 0.06)',
    bandTopBorder: 'rgba(56, 189, 248, 0.52)',
    dividerStroke: 'rgba(56, 189, 248, 0.26)',
    badgeBg: 'rgba(12, 28, 44, 0.88)',
    badgeBorder: 'rgba(14, 165, 233, 0.48)',
    badgeText: '#7dd3fc',
  },
  ny: {
    id: 'ny',
    name: '纽约交易时段',
    shortLabel: '纽约交易时段',
    utcWindow: '13:00–21:00 UTC',
    cnWindow: '北京 21:00–05:00',
    description: '美股与宏观数据相关观察窗口；量能峰值需按当日真实数据验证。',
    hex: '#f59e0b',
    bandFill: 'rgba(245, 158, 11, 0.06)',
    bandTopBorder: 'rgba(251, 191, 36, 0.55)',
    dividerStroke: 'rgba(251, 191, 36, 0.28)',
    badgeBg: 'rgba(38, 25, 10, 0.88)',
    badgeBorder: 'rgba(245, 158, 11, 0.48)',
    badgeText: '#fcd34d',
  },
  overlap: {
    id: 'overlap',
    name: '伦敦与纽约重叠时段',
    shortLabel: '伦敦与纽约重叠时段',
    utcWindow: '13:00–16:00 UTC',
    cnWindow: '北京 21:00–24:00',
    description: '伦敦与纽约窗口交集；深度与成交峰值是待验证假设，不是方向信号。',
    hex: '#10b981',
    bandFill: 'rgba(16, 185, 129, 0.065)',
    bandTopBorder: 'rgba(52, 211, 153, 0.65)',
    dividerStroke: 'rgba(52, 211, 153, 0.32)',
    badgeBg: 'rgba(11, 35, 29, 0.90)',
    badgeBorder: 'rgba(16, 185, 129, 0.52)',
    badgeText: '#6ee7b7',
  },
  london_close: {
    id: 'london_close',
    name: '伦敦收盘观察时段',
    shortLabel: '伦敦收盘观察时段',
    utcWindow: '15:00–17:00 UTC',
    cnWindow: '北京 23:00–01:00',
    description: '欧盘头寸平仓结算与 16:00 UTC 资金费率节点，常见日内趋势减速或回撤再平衡。',
    hex: '#10b981',
    bandFill: 'rgba(16, 185, 129, 0.055)',
    bandTopBorder: 'rgba(52, 211, 153, 0.52)',
    dividerStroke: 'rgba(52, 211, 153, 0.26)',
    badgeBg: 'rgba(11, 35, 29, 0.88)',
    badgeBorder: 'rgba(16, 185, 129, 0.45)',
    badgeText: '#6ee7b7',
  },
};

/** 模式 A：三大宏观交易时段定义 */
export const MACRO_SESSIONS: readonly SessionDefinition[] = [
  {
    ...SESSION_STYLES.asia,
    startMin: 0,
    endMin: 8 * 60, // 00:00 - 08:00 UTC
  },
  {
    ...SESSION_STYLES.london,
    startMin: 8 * 60,
    endMin: 16 * 60, // 08:00 - 16:00 UTC
  },
  {
    ...SESSION_STYLES.ny,
    startMin: 13 * 60,
    endMin: 21 * 60, // 13:00 - 21:00 UTC
  },
  {
    ...SESSION_STYLES.overlap,
    startMin: 13 * 60,
    endMin: 16 * 60, // 13:00 - 16:00 UTC 欧美重叠
    isOverlay: true,
  },
];

/** 模式 B：ICT / 经典猎杀区 Killzones 定义 */
export const KILLZONE_SESSIONS: readonly SessionDefinition[] = [
  {
    ...SESSION_STYLES.asia,
    name: '亚太交易观察区间',
    shortLabel: '亚太交易观察区间',
    utcWindow: '00:00–08:00 UTC',
    cnWindow: '北京 08:00–16:00',
    description: '00:00–08:00 UTC 合成亚太交易区间，提供时段高点与时段低点参照。',
    startMin: 0,
    endMin: 8 * 60, // 00:00 - 08:00 UTC
  },
  {
    ...SESSION_STYLES.london,
    name: '伦敦开盘观察窗口',
    shortLabel: '伦敦开盘观察窗口',
    utcWindow: '07:00–10:00 UTC',
    cnWindow: '北京 15:00–18:00',
    description: '固定 UTC 教学窗口；不等同全年伦敦本地开盘时间。',
    startMin: 7 * 60,
    endMin: 10 * 60, // 07:00 - 10:00 UTC
  },
  {
    ...SESSION_STYLES.ny,
    name: '纽约开盘观察窗口',
    shortLabel: '纽约开盘观察窗口',
    utcWindow: '12:30–15:30 UTC',
    cnWindow: '北京 20:30–23:30',
    description: '美国宏观数据（12:30/13:30）与美股开盘（13:30/14:30）窗口，二级突破与深度回踩高发期。',
    startMin: 12 * 60 + 30,
    endMin: 15 * 60 + 30, // 12:30 - 15:30 UTC
  },
  {
    ...SESSION_STYLES.london_close,
    startMin: 15 * 60,
    endMin: 17 * 60, // 15:00 - 17:00 UTC
    isOverlay: true,
  },
];

export interface SessionComputeOptions {
  mode: SessionMode;
  clockMode?: SessionClockMode;
  enabledSessions: {
    asia: boolean;
    london: boolean;
    ny: boolean;
  };
  showOverlap: boolean;
}

/** 格式化 UTC 日期为 MM-DD */
export function formatUtcMonthDay(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/** 格式化分钟偏移为 HH:MM */
export function formatMinToHHMM(totalMin: number): string {
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 获取某个毫秒时间戳所在 UTC 自然日的 00:00:00.000 时间戳 */
export function utcDayFloor(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * 判断当前 K 线周期是否适合展示日内交易时段
 * 日线 (1D) / 周线 (1W) 或单根 K 线跨度 >= 12 小时时自动折叠日内时段，避免密集竖纹。
 */
export function isIntradayTimeframe(bars: readonly BarLike[]): boolean {
  if (bars.length < 2) return true;
  // 取相邻 K 线最小正间隔估算周期
  let minStep = Infinity;
  const sampleCount = Math.min(bars.length - 1, 25);
  for (let i = bars.length - sampleCount; i < bars.length; i++) {
    const dt = bars[i].time - bars[i - 1].time;
    if (dt > 0 && dt < minStep) minStep = dt;
  }
  if (!Number.isFinite(minStep)) return true;
  return minStep < 12 * 3600_000;
}

/**
 * 计算指定时间范围 [minTimeMs, maxTimeMs] 内的所有交易时段区间
 */
export function computeSessionSpans(
  minTimeMs: number,
  maxTimeMs: number,
  options: SessionComputeOptions,
): SessionSpan[] {
  if (!Number.isFinite(minTimeMs) || !Number.isFinite(maxTimeMs) || maxTimeMs < minTimeMs) {
    return [];
  }
  const defs = options.mode === 'killzone' ? KILLZONE_SESSIONS : MACRO_SESSIONS;
  const firstDay = utcDayFloor(minTimeMs);
  const lastDay = utcDayFloor(maxTimeMs);
  // 防御极端时间跨度：最多计算最近 60 个自然日
  const maxDays = 60;
  const startDay = Math.max(firstDay, lastDay - maxDays * DAY_MS);

  const spans: SessionSpan[] = [];
  const clockMode = options.clockMode ?? 'fixed';
  for (let dayMs = startDay; dayMs <= lastDay; dayMs += DAY_MS) {
    // 每天只解析一次窗口（命中按天缓存）；此前在 def 循环内重复解析，
    // 本地夏令时模式下每天构造 32 个 Intl 格式化器，是图表卡顿的根源。
    const windows = options.mode === 'macro' ? macroWindows(dayMs, clockMode) : null;
    const ov = windows ? overlapWindow(windows) : null;
    for (const def of defs) {
      if (def.id === 'asia' && !options.enabledSessions.asia) continue;
      if (def.id === 'london' && !options.enabledSessions.london) continue;
      if (def.id === 'ny' && !options.enabledSessions.ny) continue;
      if ((def.id === 'overlap' || def.id === 'london_close') && !options.showOverlap) continue;
      // An overlap is an intersection, not an independent session.
      if (def.id === 'overlap' && (!options.enabledSessions.london || !options.enabledSessions.ny)) continue;

      const w = windows ? (def.id === 'overlap' ? ov : windows.find(x => x.id === def.id)) : null;
      const startMs = w ? w.startMs : dayMs + def.startMin * MIN_MS;
      const endMs = w ? w.endMs : dayMs + def.endMin * MIN_MS;
      if (endMs < minTimeMs || startMs > maxTimeMs) continue;

      spans.push({
        key: `${options.mode}:${options.clockMode ?? 'fixed'}:${def.id}:${dayMs}`,
        id: def.id,
        name: def.name,
        shortLabel: def.shortLabel,
        badgeLabel: `${def.name} ${w ? w.label.replace(/\s*UTC$/, '') : formatMinToHHMM(def.startMin) + '–' + formatMinToHHMM(def.endMin)}`,
        utcWindow: w ? w.label : def.utcWindow,
        dayStartMs: dayMs,
        startMs,
        endMs,
        isOverlay: Boolean(def.isOverlay),
        style: def,
      });
    }
  }
  return spans;
}

/**
 * 计算可视范围内的 00:00 UTC 日界分割线
 */
export function computeDailyDividers(
  bars: readonly BarLike[],
  minTimeMs: number,
  maxTimeMs: number,
): DailyDivider[] {
  if (!bars.length || maxTimeMs < minTimeMs) return [];
  const firstDay = utcDayFloor(minTimeMs);
  const lastDay = utcDayFloor(maxTimeMs);
  const startDay = Math.max(firstDay, lastDay - 60 * DAY_MS);

  // 为每天找到第一根 >= dayStartMs 的开盘价
  const dividers: DailyDivider[] = [];
  let barIdx = 0;
  for (let dayMs = startDay; dayMs <= lastDay; dayMs += DAY_MS) {
    if (dayMs < minTimeMs || dayMs > maxTimeMs) continue;
    while (barIdx < bars.length && bars[barIdx].time < dayMs) {
      barIdx++;
    }
    const openBar = barIdx < bars.length && bars[barIdx].time < dayMs + DAY_MS ? bars[barIdx] : null;
    dividers.push({
      dayStartMs: dayMs,
      dateLabel: `${formatUtcMonthDay(dayMs)} 00:00`,
      openPrice: openBar ? openBar.open : null,
    });
  }
  return dividers;
}

/**
 * 计算每个 UTC 自然日的亚盘高低点 (Asian High / Low) 及其在欧美盘的扫荡/突破状态
 */
export function computeAsiaRangeLevels(
  bars: readonly BarLike[],
  minTimeMs: number,
  maxTimeMs: number,
): AsiaRangeSummary[] {
  if (!bars.length || maxTimeMs < minTimeMs) return [];
  const firstDay = utcDayFloor(minTimeMs);
  const lastDay = utcDayFloor(maxTimeMs);
  const startDay = Math.max(firstDay, lastDay - 30 * DAY_MS);
  const lastBarTime = bars[bars.length - 1].time;

  // 按 UTC 日分桶
  const dayMap = new Map<number, BarLike[]>();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < startDay || b.time > lastDay + DAY_MS) continue;
    const d = utcDayFloor(b.time);
    let list = dayMap.get(d);
    if (!list) {
      list = [];
      dayMap.set(d, list);
    }
    list.push(b);
  }

  const summaries: AsiaRangeSummary[] = [];
  for (const [dayStartMs, dayBars] of dayMap.entries()) {
    const asiaStartMs = dayStartMs;
    const asiaEndMs = dayStartMs + 8 * 3600_000; // 08:00 UTC
    const dayEndMs = dayStartMs + DAY_MS;

    let high = -Infinity;
    let highBarMs = asiaStartMs;
    let low = Infinity;
    let lowBarMs = asiaStartMs;
    let barCount = 0;

    const postAsiaBars: BarLike[] = [];
    for (const b of dayBars) {
      if (b.time >= asiaStartMs && b.time < asiaEndMs) {
        barCount++;
        if (b.high > high) {
          high = b.high;
          highBarMs = b.time;
        }
        if (b.low < low) {
          low = b.low;
          lowBarMs = b.time;
        }
      } else if (b.time >= asiaEndMs && b.time < dayEndMs) {
        postAsiaBars.push(b);
      }
    }

    // 至少有 2 根亚盘 K 线才构建有效的亚盘高低位
    if (barCount < 2 || !Number.isFinite(high) || !Number.isFinite(low) || high <= 0 || low <= 0) {
      continue;
    }

    const defaultEndMs = Math.min(dayEndMs, Math.max(asiaEndMs, lastBarTime));
    let highLineEndMs = defaultEndMs;
    let highState: AsiaSweepState = 'untouched';
    let highTouchMs: number | null = null;

    let lowLineEndMs = defaultEndMs;
    let lowState: AsiaSweepState = 'untouched';
    let lowTouchMs: number | null = null;

    // 扫描 08:00 UTC 之后的欧美盘 K 线，检测对 AH / AL 的首次扫荡或实体突破
    for (const b of postAsiaBars) {
      if (highState === 'untouched' && b.high > high) {
        highTouchMs = b.time;
        highLineEndMs = b.time;
        // 刺破后收盘回到 AH 下方 = 扫位收回（诱多候选）；收盘站稳 AH 上方 = 实体突破
        highState = b.close <= high ? 'swept_reject' : 'broken';
      }
      if (lowState === 'untouched' && b.low < low) {
        lowTouchMs = b.time;
        lowLineEndMs = b.time;
        // 刺破后收盘回到 AL 上方 = 扫位收回（诱空候选）；收盘跌破 AL 下方 = 实体跌破
        lowState = b.close >= low ? 'swept_reject' : 'broken';
      }
      if (highState !== 'untouched' && lowState !== 'untouched') break;
    }

    const rangePct = ((high - low) / low) * 100;
    summaries.push({
      dayStartMs,
      dateLabel: formatUtcMonthDay(dayStartMs),
      asiaStartMs,
      asiaEndMs,
      dayEndMs,
      high,
      highBarMs,
      low,
      lowBarMs,
      rangePct,
      barCount,
      highLineEndMs,
      highState,
      highTouchMs,
      lowLineEndMs,
      lowState,
      lowTouchMs,
    });
  }

  return summaries;
}

export interface ActiveSessionClock {
  utcHHMM: string;
  utcMinutes: number;
  dayProgressPct: number;
  activeSessions: SessionDefinition[];
  nextSession: { def: SessionDefinition; inMinutes: number };
}

/**
 * 根据给定时间戳（默认当前系统时间）计算当前所处的 UTC 交易时段状态
 */
export function getActiveSessionClock(nowMs: number = Date.now(), mode: SessionMode = 'macro', clockMode: SessionClockMode = 'fixed'): ActiveSessionClock & { windows: readonly ClockWindow[]; overlap: ClockWindow | null } {
  const d = new Date(nowMs);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const utcMinutes = h * 60 + m;
  const utcHHMM = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`;
  const dayProgressPct = Math.min(100, Math.max(0, (utcMinutes / 1440) * 100));

  const defs = mode === 'killzone' ? KILLZONE_SESSIONS : MACRO_SESSIONS;
  const day = utcDayFloor(nowMs);
  const windows = mode === 'macro' ? macroWindows(day, clockMode) : defs.filter(d => !d.isOverlay).map(d => ({ id: d.id, startMs: day + d.startMin * MIN_MS, endMs: day + d.endMin * MIN_MS, label: d.utcWindow, localLabel: '固定 UTC 教学窗口' }));
  const overlap = mode === 'macro' ? overlapWindow(windows) : null;
  const all = overlap ? [...windows, overlap] : windows;
  const activeSessions = defs.filter(def => all.some(w => w.id === def.id && nowMs >= w.startMs && nowMs < w.endMs));
  let bestDef = defs[0];
  let bestWait = Infinity;
  for (const offset of [-DAY_MS, 0, DAY_MS]) {
    const ws = mode === 'macro' ? macroWindows(day + offset, clockMode) : defs.filter(d => !d.isOverlay).map(d => ({ id: d.id, startMs: day + offset + d.startMin * MIN_MS }));
    for (const w of ws) {
      const wait = (w.startMs - nowMs) / MIN_MS;
      if (wait > 0 && wait < bestWait) { bestWait = wait; bestDef = defs.find(d => d.id === w.id) ?? defs[0]; }
    }
  }
  return { utcHHMM, utcMinutes, dayProgressPct, activeSessions, nextSession: { def: bestDef, inMinutes: bestWait }, windows, overlap };
}
