// Pure projection from a causal FrameworkReport into clean, bounded chart markings.
// Every label is concise and deduplicated per (bar timestamp, side) so markers
// never stack on the same candle. No DOM or browser globals.
import {
  decimalsFor,
  type AnnEvent,
  type AnnLevel,
  type AnnPayload,
  type AnnTone,
  type AnnZone,
} from '@/vela/annotTypes';
import type { FrameworkReport } from './frameworks';
import type { HighRel, LowRel, Tfbias } from './fractal';

export interface FrameworkMarkPrefs {
  enabled: boolean;
  liquidity: boolean;
  fractals: boolean;
  wyckoffFvg: boolean;
  amt: boolean;
  labels: boolean;
}

export const DEFAULT_FRAMEWORK_MARK_PREFS: FrameworkMarkPrefs = {
  enabled: true,
  liquidity: true,
  fractals: true,
  wyckoffFvg: true,
  amt: true,
  labels: true,
};

export function normalizeFrameworkMarkPrefs(raw: unknown): FrameworkMarkPrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Partial<FrameworkMarkPrefs>) : {};
  const b = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    enabled: b(obj.enabled, DEFAULT_FRAMEWORK_MARK_PREFS.enabled),
    liquidity: b(obj.liquidity, DEFAULT_FRAMEWORK_MARK_PREFS.liquidity),
    fractals: b(obj.fractals, DEFAULT_FRAMEWORK_MARK_PREFS.fractals),
    wyckoffFvg: b(obj.wyckoffFvg, DEFAULT_FRAMEWORK_MARK_PREFS.wyckoffFvg),
    amt: b(obj.amt, DEFAULT_FRAMEWORK_MARK_PREFS.amt),
    labels: b(obj.labels, DEFAULT_FRAMEWORK_MARK_PREFS.labels),
  };
}

export interface FrameworkHudRow {
  tf: string;
  bias: Tfbias;
  insufficient: boolean;
  arrow: '↑' | '↓' | '—';
}

export interface FrameworkHud {
  rows: FrameworkHudRow[];
  verdict: '偏多' | '偏空' | '中性';
  tone: AnnTone;
  phase: string;
  title: string;
  detail: string[];
}

export interface FrameworkMarkResult {
  payload: AnnPayload;
  hud: FrameworkHud | null;
}

export const MAX_STOP_HUNT_MARKS = 2;
export const MAX_SPRING_MARKS = 2;
export const MAX_FVG_ZONES = 3;
const FRESH_STOP_HUNT_BARS = 48;
const FRESH_SPRING_BARS = 48;
const FRESH_STRUCTURE_BARS = 72;
const MAX_POOL_DISTANCE_ATR = 8;

const PHASE_TEXT: Record<string, string> = {
  accumulation: '吸筹候选',
  distribution: '分发候选',
  markup: '上涨结构',
  markdown: '下跌结构',
  balance: '均衡',
  unknown: '未知',
};

const REL_DESC: Record<HighRel | LowRel, string> = {
  HH: '更高高点 (HH)',
  LH: '更低高点 (LH)',
  EQH: '等高点 (EQH)',
  HL: '更高低点 (HL)',
  LL: '更低低点 (LL)',
  EQL: '等低点 (EQL)',
};

const emptyPayload = (decimals = 2): AnnPayload => ({
  levels: [],
  events: [],
  zones: [],
  paths: [],
  position: null,
  obstacles: [],
  decimals,
  rev: 0,
});

const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

export function projectFrameworkMarks(
  report: FrameworkReport | null,
  prefs: FrameworkMarkPrefs,
  barMs: number,
): FrameworkMarkResult {
  if (!report || !prefs.enabled) {
    return { payload: emptyPayload(report ? decimalsFor(report.lastPrice) : 2), hud: null };
  }

  const decimals = decimalsFor(report.lastPrice);
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(decimals) : '—');
  const levels: AnnLevel[] = [];
  const zones: AnnZone[] = [];
  const eventMap = new Map<string, AnnEvent>();

  const putEvent = (ev: AnnEvent, extraDetail?: string[]) => {
    const key = `${ev.ts}:${ev.side}`;
    const prev = eventMap.get(key);
    if (!prev) {
      eventMap.set(key, ev);
      return;
    }
    if (ev.priority > prev.priority) {
      eventMap.set(key, {
        ...ev,
        detail: [...(ev.detail ?? []), ...(extraDetail ?? prev.detail ?? [])],
      });
    } else {
      prev.detail = [...(prev.detail ?? []), ...(extraDetail ?? ev.detail ?? [])];
    }
  };

  // 1. AMT reference levels (strictly requires exchange quote turnover).
  const prof = report.auction.profile;
  if (prefs.amt && report.quality.auctionVolumeReady && prof.poc != null && prof.vah != null && prof.val != null) {
    const fromTs = prof.window.fromTs ?? report.lastTs;
    const mig = report.auction.migration;
    const amtCommon = `滚动 ${prof.window.bars} 根 OHLC quote 成交额近似 · 价值区宽 ${prof.valueWidthAtr.toFixed(1)} ATR`;
    levels.push({
      id: 'fw:amt:poc',
      price: prof.poc,
      fromTs,
      toTs: null,
      tone: 'neck',
      name: 'POC',
      style: 'solid',
      rank: 'read',
      priority: 86,
      label: prefs.labels,
      detail: [
        amtCommon,
        `成交额最密价位 ${fmt(prof.poc)}（距收盘 ${prof.pocDistanceAtr.toFixed(2)} ATR）`,
        ...(mig ? [`POC 迁移：${signed(mig.shiftAtr)} ATR（早期 ${fmt(mig.earlyPoc ?? 0)} → 近期 ${fmt(mig.latePoc ?? 0)}）`] : []),
      ],
    });
    levels.push({
      id: 'fw:amt:vah',
      price: prof.vah,
      fromTs,
      toTs: null,
      tone: 'top',
      name: 'VAH',
      style: 'dotted',
      rank: 'normal',
      priority: 66,
      label: prefs.labels,
      detail: [amtCommon, `70% 价值区上沿 ${fmt(prof.vah)}（收盘突破不自动等同接受）`],
    });
    levels.push({
      id: 'fw:amt:val',
      price: prof.val,
      fromTs,
      toTs: null,
      tone: 'bottom',
      name: 'VAL',
      style: 'dotted',
      rank: 'normal',
      priority: 66,
      label: prefs.labels,
      detail: [amtCommon, `70% 价值区下沿 ${fmt(prof.val)}（收盘跌破不自动等同接受）`],
    });
  }

  // 2. Liquidity pools + fresh stop-hunts + latest BOS/CHoCH.
  if (prefs.liquidity) {
    const { nearestAbove, nearestBelow, stopHunts, structure, structureTs, structureAgeBars } = report.liquidity;
    if (nearestAbove && Number.isFinite(nearestAbove.price) && nearestAbove.distanceAtr <= MAX_POOL_DISTANCE_ATR) {
      levels.push({
        id: 'fw:liq:above',
        price: nearestAbove.price,
        fromTs: nearestAbove.firstTs,
        toTs: null,
        tone: 'top',
        name: nearestAbove.equal ? `上等高×${nearestAbove.touches}` : '前高参考',
        style: nearestAbove.equal ? 'dashed' : 'dotted',
        rank: 'read',
        priority: nearestAbove.equal ? 80 : 62,
        label: prefs.labels,
        detail: [
          `${nearestAbove.equal ? `上方等高流动性池（${nearestAbove.touches} 个摆动参考）` : '上方最近已确认摆动高点'} · ${fmt(nearestAbove.price)}`,
          `距收盘 ${nearestAbove.distanceAtr.toFixed(1)} ATR · ${nearestAbove.active ? '尚未被收盘击穿' : '此前曾被击穿'}`,
          '公共行情无法观测真实止损挂单位置，仅供结构参考。',
        ],
      });
    }
    if (nearestBelow && Number.isFinite(nearestBelow.price) && nearestBelow.distanceAtr <= MAX_POOL_DISTANCE_ATR) {
      levels.push({
        id: 'fw:liq:below',
        price: nearestBelow.price,
        fromTs: nearestBelow.firstTs,
        toTs: null,
        tone: 'bottom',
        name: nearestBelow.equal ? `下等低×${nearestBelow.touches}` : '前低参考',
        style: nearestBelow.equal ? 'dashed' : 'dotted',
        rank: 'read',
        priority: nearestBelow.equal ? 80 : 62,
        label: prefs.labels,
        detail: [
          `${nearestBelow.equal ? `下方等低流动性池（${nearestBelow.touches} 个摆动参考）` : '下方最近已确认摆动低点'} · ${fmt(nearestBelow.price)}`,
          `距收盘 ${nearestBelow.distanceAtr.toFixed(1)} ATR · ${nearestBelow.active ? '尚未被收盘击穿' : '此前曾被击穿'}`,
          '公共行情无法观测真实止损挂单位置，仅供结构参考。',
        ],
      });
    }

    for (const h of stopHunts.filter(x => x.ageBars <= FRESH_STOP_HUNT_BARS).slice(0, MAX_STOP_HUNT_MARKS)) {
      const above = h.side === 'above';
      const label = h.kind === 'sweep' ? (above ? '扫高收回' : '扫低收回') : (above ? '越位↑' : '越位↓');
      const tone: AnnTone = h.kind === 'sweep' ? (above ? 'warn' : 'long') : (above ? 'long' : 'short');
      putEvent({
        id: `fw:hunt:${h.ts}:${h.side}`,
        ts: h.ts,
        side: h.side,
        tone,
        text: prefs.labels ? label : '',
        priority: h.kind === 'sweep' ? 92 : 76,
        marker: h.kind === 'sweep' ? 'tri' : 'diamond',
        title: `${label} · ${fmt(h.level)}`,
        detail: [h.reason, `${h.ageBars} 根前 · ${h.touches} 个摆动参考 · 刺穿 ${h.depthAtr.toFixed(2)} ATR`],
      });
    }

    if (structure && structureTs != null && structureAgeBars != null && structureAgeBars <= FRESH_STRUCTURE_BARS) {
      const up = structure.dir > 0;
      const short = `${structure.kind === 'CHOCH' ? 'CHoCH' : 'BOS'}${up ? '↑' : '↓'}`;
      putEvent({
        id: `fw:struct:${structureTs}:${structure.kind}`,
        ts: structureTs,
        side: up ? 'above' : 'below',
        tone: up ? 'long' : 'short',
        text: prefs.labels ? short : '',
        priority: 78,
        marker: 'diamond',
        title: `${short} · 越过 ${fmt(structure.price)}`,
        detail: [
          `${structure.kind === 'CHOCH' ? '性质转变 (CHoCH)' : '结构延续 (BOS)'}：${up ? '向上' : '向下'}收盘越过摆动位 ${fmt(structure.price)}`,
          `${structureAgeBars} 根前确认 · 不包含成交量或机构意图确认。`,
        ],
      });
    }
  }

  // 3. Wyckoff springs/upthrusts (merged cleanly if on same bar as a sweep) + open FVGs.
  if (prefs.wyckoffFvg) {
    for (const s of report.wyckoff.springs.filter(x => x.ageBars <= FRESH_SPRING_BARS).slice(0, MAX_SPRING_MARKS)) {
      const above = s.kind === 'upthrust';
      const side: 'above' | 'below' = above ? 'above' : 'below';
      const key = `${s.ts}:${side}`;
      const existing = eventMap.get(key);
      if (existing && existing.id.startsWith('fw:hunt:')) {
        const mergedLabel = above ? '扫高·上冲' : '扫低·弹簧';
        eventMap.set(key, {
          ...existing,
          id: `fw:merged:${s.ts}:${side}`,
          tone: above ? 'warn' : 'long',
          text: prefs.labels ? mergedLabel : '',
          priority: 95,
          title: `${mergedLabel} · ${fmt(s.level)}`,
          detail: [...(existing.detail ?? []), `Wyckoff：${s.reason}`],
        });
      } else {
        const label = above ? '上冲' : '弹簧';
        putEvent({
          id: `fw:wy:${s.ts}:${s.kind}`,
          ts: s.ts,
          side,
          tone: above ? 'warn' : 'long',
          text: prefs.labels ? label : '',
          priority: 82,
          marker: 'diamond',
          title: `Wyckoff ${label} · ${fmt(s.level)}`,
          detail: [s.reason, `${s.ageBars} 根前 · 强度评估：${s.quality === 'strong' ? '强' : s.quality === 'moderate' ? '中' : '弱'}`],
        });
      }
    }

    const nearestFvgs = [...report.wyckoff.imbalances]
      .filter(z => z.hi > z.lo && Number.isFinite(z.fromTs))
      .sort((a, b) => {
        const da = Math.abs((a.lo + a.hi) / 2 - report.lastPrice);
        const db = Math.abs((b.lo + b.hi) / 2 - report.lastPrice);
        return da - db || b.to - a.to;
      })
      .slice(0, MAX_FVG_ZONES);

    const fvgEnd = report.lastTs + Math.max(60_000, barMs) * 2;
    for (const z of nearestFvgs) {
      const bull = z.kind === 'bullish';
      zones.push({
        id: `fw:fvg:${z.fromTs}:${z.kind}`,
        fromTs: z.fromTs,
        toTs: fvgEnd,
        lo: z.lo,
        hi: z.hi,
        tone: bull ? 'long' : 'short',
        text: prefs.labels ? (bull ? 'FVG↑' : 'FVG↓') : '',
        priority: 55,
        title: `${bull ? '多头失衡 FVG↑' : '空头失衡 FVG↓'} · ${fmt(z.lo)}–${fmt(z.hi)}`,
        detail: [
          `三根 K 线未重叠缺口：${fmt(z.lo)} – ${fmt(z.hi)}`,
          z.touched ? '已被部分回踩，尚未完全回补。' : '尚未被价格回踩。',
          '仅标识历史价格失衡区，不承诺必然回补或必然反应。',
        ],
      });
    }
  }

  // 4. Current-TF confirmed Williams fractals (max 2 highs + 2 lows) + compact MTF HUD.
  let hud: FrameworkHud | null = null;
  if (prefs.fractals) {
    const baseRow = report.mtf.rows[0];
    if (baseRow && !baseRow.insufficient) {
      for (const p of baseRow.recentPivots) {
        const upBias = p.rel === 'HH' || p.rel === 'HL';
        const downBias = p.rel === 'LH' || p.rel === 'LL';
        const tone: AnnTone = upBias ? 'long' : downBias ? 'short' : 'neck';
        const side: 'above' | 'below' = p.kind === 'high' ? 'above' : 'below';
        putEvent({
          id: `fw:frac:${p.ts}:${p.kind}`,
          ts: p.ts,
          side,
          tone,
          text: prefs.labels ? p.rel : '',
          priority: 62,
          marker: 'tri',
          title: `${REL_DESC[p.rel]} · ${fmt(p.price)}`,
          detail: [
            `当前周期 (${baseRow.tf}) 已确认 Williams 分形`,
            `右侧 2 根收盘后确认，无未来函数回溯。`,
          ],
        });
      }
    }

    const hudVerdict: FrameworkHud['verdict'] =
      report.confluence.verdict === 'long' || report.confluence.verdict === 'lean_long'
        ? '偏多'
        : report.confluence.verdict === 'short' || report.confluence.verdict === 'lean_short'
          ? '偏空'
          : '中性';
    const hudTone: AnnTone = hudVerdict === '偏多' ? 'long' : hudVerdict === '偏空' ? 'short' : 'neck';
    hud = {
      rows: report.mtf.rows.map(r => ({
        tf: r.tf,
        bias: r.bias,
        insufficient: r.insufficient,
        arrow: r.insufficient ? '—' : r.bias === 'bull' ? '↑' : r.bias === 'bear' ? '↓' : '—',
      })),
      verdict: hudVerdict,
      tone: hudTone,
      phase: PHASE_TEXT[report.wyckoff.phase] ?? '未知',
      title: `多周期对齐 & 四框架汇总 · ${hudVerdict}`,
      detail: [
        report.mtf.headline,
        `Wyckoff 阶段：${PHASE_TEXT[report.wyckoff.phase] ?? report.wyckoff.phase}`,
        report.confluence.headline,
      ],
    };
  }

  return {
    payload: {
      levels,
      events: [...eventMap.values()],
      zones,
      paths: [],
      position: null,
      obstacles: [],
      decimals,
      rev: 0,
    },
    hud,
  };
}
