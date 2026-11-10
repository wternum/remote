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
import type { LiquidityPoolCluster } from './liquidity';

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

/** 每种分形关系对短线的一句话含义 */
const REL_MEANING: Record<HighRel | LowRel, string> = {
  HH: '高点还在抬高，多头仍在往上推。',
  LH: '高点在降低，往上攻的力气变弱。',
  EQH: '两次冲到差不多的价位都没过去，上方有压力。',
  HL: '低点在抬高，回调时有人接。',
  LL: '低点还在降低，空头仍在往下压。',
  EQL: '两次跌到差不多的价位都没破，下方有支撑。',
};

const BIAS_TEXT: Record<Tfbias, string> = { bull: '上涨', bear: '下跌', range: '震荡', unknown: '数据不足' };

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

/** 图表时区为 UTC：悬停里统一写 "11-09 22:50"，不再附加 "UTC" 噪音 */
const fmtTime = (ts: number | null | undefined) =>
  ts != null && Number.isFinite(ts) ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '—';
/** 窗口时长：5m→"10 小时"，4H→"20 天"，1D→"120 天"（不再出现"2880 小时"） */
const hoursText = (bars: number, barMs: number) => {
  const h = (bars * barMs) / 3_600_000;
  const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (h >= 48) return `${num(h / 24)} 天`;
  return h >= 1 ? `${num(h)} 小时` : `${Math.round(h * 60)} 分钟`;
};

type Pool = LiquidityPoolCluster;

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
    // Anchor rolling levels at report.lastTs (where the rolling window completed),
    // not retrospectively back at window.fromTs.
    const fromTs = report.lastTs;
    const mig = report.auction.migration;
    const span = `最近 ${hoursText(prof.window.bars, barMs)}（${prof.window.bars} 根，${fmtTime(prof.window.fromTs)} 至 ${fmtTime(prof.window.toTs)}）`;
    const estimate = '按每根 K 线的成交额在高低点之间平均分摊估算，不是逐笔成交分布；窗口随新 K 线滚动。';
    const drift = mig && mig.earlyPoc != null && mig.latePoc != null
      ? mig.dir === 0
        ? `成交重心基本没动（前半段 ${fmt(mig.earlyPoc)} → 后半段 ${fmt(mig.latePoc)}）。`
        : `成交重心在${mig.dir > 0 ? '上移' : '下移'}：前半段 ${fmt(mig.earlyPoc)} → 后半段 ${fmt(mig.latePoc)}。`
      : null;
    levels.push({
      id: 'fw:amt:poc',
      price: prof.poc,
      fromTs,
      toTs: null,
      tone: 'neck',
      name: 'POC 成交最密',
      style: 'solid',
      rank: 'read',
      priority: 86,
      label: prefs.labels,
      detail: [
        `${span}成交最集中的价格。`,
        '多空都认可的"公允价"，价格常围着它来回拉扯；离得远了容易被拉回来。',
        ...(drift ? [drift] : []),
        `现价距它 ${prof.pocDistanceAtr.toFixed(1)} ATR。`,
        estimate,
      ],
    });
    const area = `${span}约 70% 的成交落在 ${fmt(prof.val)}–${fmt(prof.vah)} 之间（价值区）`;
    levels.push({
      id: 'fw:amt:vah',
      price: prof.vah,
      fromTs,
      toTs: null,
      tone: 'top',
      name: 'VAH 价值上沿',
      style: 'dotted',
      rank: 'normal',
      priority: 66,
      label: prefs.labels,
      detail: [
        `${area}，这是上沿。`,
        `收盘站上并守住：可能向上找新价位；冲上去又收回：常回落到 POC ${fmt(prof.poc)}。`,
        estimate,
      ],
    });
    levels.push({
      id: 'fw:amt:val',
      price: prof.val,
      fromTs,
      toTs: null,
      tone: 'bottom',
      name: 'VAL 价值下沿',
      style: 'dotted',
      rank: 'normal',
      priority: 66,
      label: prefs.labels,
      detail: [
        `${area}，这是下沿。`,
        `收盘跌破并收不回：可能向下找新价位；跌下去又收回：常回升到 POC ${fmt(prof.poc)}。`,
        estimate,
      ],
    });
  }

  // 2. Liquidity: nearest reference + nearest equal-level pool, fresh stop-hunts, latest BOS/CHoCH.
  if (prefs.liquidity) {
    const { nearestAbove, nearestBelow, poolAbove, poolBelow, stopHunts, structure, structureTs, structureAgeBars } = report.liquidity;
    const poolLevel = (p: Pool, id: string): AnnLevel => {
      const up = p.side === 'above';
      const word = up ? '高点' : '低点';
      return {
        id,
        price: p.price,
        fromTs: p.confirmedTs,
        toTs: null,
        tone: up ? 'top' : 'bottom',
        name: p.equal ? `${up ? 'EQH 等高' : 'EQL 等低'}×${p.touches}` : up ? '前高' : '前低',
        style: p.equal ? 'dashed' : 'dotted',
        rank: 'read',
        priority: p.equal ? 80 : 62,
        label: prefs.labels,
        detail: [
          p.equal
            ? `${p.touches} 个几乎一样${up ? '高' : '低'}的${word}（${fmtTime(p.firstTs)} 到 ${fmtTime(p.lastTs)}），${up ? '上方' : '下方'}最容易堆积止损和突破单。`
            : `${up ? '上方' : '下方'}最近一个还没被${up ? '突破' : '跌破'}的${word}（${fmtTime(p.firstTs)} 那根）。`,
          up
            ? '刺破后收回 = 假突破（扫高），偏空看；收盘站上并守住 = 真突破。'
            : '刺破后收回 = 假跌破（扫低），偏多看；收盘跌破并收不回 = 真跌破。',
          `距现价 ${p.distanceAtr.toFixed(1)} ATR · ${fmtTime(p.confirmedTs + barMs)} 才确认（右侧 5 根收盘后）${p.active ? '' : ' · 此前被收盘击穿过，参考性变弱'}。`,
          '止损单位置是常见经验推测，公共行情看不到真实挂单。',
        ],
      };
    };
    const within = (p: Pool | null): p is Pool => !!p && Number.isFinite(p.price) && p.distanceAtr <= MAX_POOL_DISTANCE_ATR;
    if (within(nearestAbove)) levels.push(poolLevel(nearestAbove, 'fw:liq:above'));
    if (within(nearestBelow)) levels.push(poolLevel(nearestBelow, 'fw:liq:below'));
    // 更近的单个前高/前低会挡住真正的等高/等低池（例如 SOL 86.21 前低挡住 86.10 双底）：两者都画。
    if (within(poolAbove) && poolAbove.price !== nearestAbove?.price) levels.push(poolLevel(poolAbove, 'fw:liq:pool-above'));
    if (within(poolBelow) && poolBelow.price !== nearestBelow?.price) levels.push(poolLevel(poolBelow, 'fw:liq:pool-below'));

    for (const h of stopHunts.filter(x => x.ageBars <= FRESH_STOP_HUNT_BARS).slice(0, MAX_STOP_HUNT_MARKS)) {
      const above = h.side === 'above';
      const sweep = h.kind === 'sweep';
      const label = sweep ? (above ? '扫高收回' : '扫低收回') : (above ? '收破前高↑' : '收破前低↓');
      const tone: AnnTone = sweep ? (above ? 'warn' : 'long') : (above ? 'long' : 'short');
      const what = sweep
        ? `价格刺破${above ? '上方' : '下方'} ${h.touches} 个前${above ? '高' : '低'}（${fmt(h.level)}）${h.depthAtr.toFixed(2)} ATR 后又收了回来 → 假${above ? '突破' : '跌破'}，偏${above ? '空' : '多'}看。`
        : `收盘${above ? '站上' : '跌破'}了${above ? '上方' : '下方'} ${h.touches} 个前${above ? '高' : '低'}（${fmt(h.level)}）→ ${above ? '突破' : '跌破'}成立；回踩不破可偏${above ? '多' : '空'}看，收回去则变成假${above ? '突破' : '跌破'}。`;
      putEvent({
        id: `fw:hunt:${h.ts}:${h.side}`,
        ts: h.ts,
        side: h.side,
        tone,
        text: prefs.labels ? label : '',
        priority: sweep ? 92 : 76,
        marker: sweep ? 'tri' : 'diamond',
        title: `${label} · ${fmt(h.level)}`,
        detail: [
          what,
          `${h.ageBars} 根前（${fmtTime(h.ts)}）${h.taker != null ? ` · 这根主动买卖差 ${h.taker >= 0 ? '+' : ''}${(h.taker * 100).toFixed(0)}%` : ''}`,
          '只是价格行为，看不到真实止损单或机构身份。',
        ],
      });
    }

    if (structure && structureTs != null && structureAgeBars != null && structureAgeBars <= FRESH_STRUCTURE_BARS) {
      const up = structure.dir > 0;
      const choch = structure.kind === 'CHOCH';
      const short = `${choch ? 'CHoCH' : 'BOS'}${up ? '↑' : '↓'}`;
      putEvent({
        id: `fw:struct:${structureTs}:${structure.kind}`,
        ts: structureTs,
        side: up ? 'above' : 'below',
        tone: up ? 'long' : 'short',
        text: prefs.labels ? short : '',
        priority: 78,
        marker: 'diamond',
        title: `${short} · ${up ? '收破前高' : '收破前低'} ${fmt(structure.price)}`,
        detail: [
          choch
            ? `之前在走${up ? '低' : '高'}，这根${up ? '向上收破前高' : '向下收破前低'} ${fmt(structure.price)} → 可能由${up ? '空转多' : '多转空'}（CHoCH），等回踩确认。`
            : `${up ? '向上收破前高' : '向下收破前低'} ${fmt(structure.price)} → ${up ? '上涨' : '下跌'}结构延续（BOS）。`,
          `${structureAgeBars} 根前（${fmtTime(structureTs)}）· 只看收盘价，没有成交量确认${structureAgeBars > FRESH_STOP_HUNT_BARS ? ' · 已较久，参考性变弱' : ''}。`,
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
      const quality = s.quality === 'strong' ? '强' : s.quality === 'moderate' ? '中' : '弱';
      const springText = above
        ? `震荡区间上沿 ${fmt(s.level)} 被刺破 ${s.depthAtr.toFixed(2)} ATR 后收回 → 假突破（Wyckoff 上冲回落），偏空看。`
        : `震荡区间下沿 ${fmt(s.level)} 被刺破 ${s.depthAtr.toFixed(2)} ATR 后收回 → 假跌破（Wyckoff 弹簧），偏多看。`;
      const springMeta = `${s.effortRatio != null ? `成交额是平时的 ${s.effortRatio.toFixed(1)} 倍 · ` : ''}强度${quality} · ${s.ageBars} 根前；之后回踩不破${above ? '上沿' : '下沿'}才算确认。`;
      if (existing && existing.id.startsWith('fw:hunt:')) {
        const mergedLabel = above ? '扫高·上冲' : '扫低·弹簧';
        eventMap.set(key, {
          ...existing,
          id: `fw:merged:${s.ts}:${side}`,
          tone: above ? 'warn' : 'long',
          text: prefs.labels ? mergedLabel : '',
          priority: 95,
          title: `${mergedLabel} · ${fmt(s.level)}`,
          detail: [...(existing.detail ?? []), springMeta],
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
          title: `${label}（Wyckoff）· ${fmt(s.level)}`,
          detail: [springText, springMeta],
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
        title: `${bull ? '多头缺口 FVG↑' : '空头缺口 FVG↓'} · ${fmt(z.lo)}–${fmt(z.hi)}`,
        detail: [
          `${bull ? '快速上涨' : '快速下跌'}留下的价格空白（${fmtTime(z.fromTs)} 起），这段价格几乎没有来回成交。`,
          `价格回到这里常有反应：${bull ? '多头缺口偏支撑' : '空头缺口偏压力'}；被完全填满就失效。`,
          z.touched ? '已经回踩了一部分，还没填满。' : '还没被回踩过。',
        ],
      });
    }
  }

  // 4. Current-TF confirmed Williams fractals (max 2 highs + 2 lows).
  if (prefs.fractals) {
    const baseRow = report.mtf.rows[0];
    if (baseRow && !baseRow.insufficient) {
      for (const p of baseRow.recentPivots) {
        const upBias = p.rel === 'HH' || p.rel === 'HL';
        const downBias = p.rel === 'LH' || p.rel === 'LL';
        const tone: AnnTone = upBias ? 'long' : downBias ? 'short' : 'neck';
        const high = p.kind === 'high';
        const side: 'above' | 'below' = high ? 'above' : 'below';
        const diff = p.price - p.prevPrice;
        const versus = p.rel === 'EQH' || p.rel === 'EQL'
          ? `和前一个${high ? '高点' : '低点'} ${fmt(p.prevPrice)} 几乎一样（差 ${fmt(Math.abs(diff))}）。`
          : `比前一个${high ? '高点' : '低点'} ${fmt(p.prevPrice)} ${diff > 0 ? '高' : '低'} ${fmt(Math.abs(diff))}。`;
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
            `${REL_MEANING[p.rel]}${versus}`,
            `${baseRow.tf} 小波段：左右各 2 根都${high ? '更低' : '更高'}才算；${fmtTime(p.confirmedAt)} 才确认，标在极值那根。`,
          ],
        });
      }
    }
  }

  // 5. Compact MTF + 4-framework summary HUD (independent of fractal candle markers toggle).
  const c = report.confluence;
  const hudVerdict: FrameworkHud['verdict'] =
    c.verdict === 'long' || c.verdict === 'lean_long'
      ? '偏多'
      : c.verdict === 'short' || c.verdict === 'lean_short'
        ? '偏空'
        : '中性';
  const hudTone: AnnTone = hudVerdict === '偏多' ? 'long' : hudVerdict === '偏空' ? 'short' : 'neck';
  const usable = report.mtf.rows.filter(r => !r.insufficient);
  const hud: FrameworkHud = {
    rows: report.mtf.rows.map(r => ({
      tf: r.tf,
      bias: r.bias,
      insufficient: r.insufficient,
      arrow: r.insufficient ? '—' : r.bias === 'bull' ? '↑' : r.bias === 'bear' ? '↓' : '—',
    })),
    verdict: hudVerdict,
    tone: hudTone,
    phase: PHASE_TEXT[report.wyckoff.phase] ?? '未知',
    title: `多周期 & 四框架汇总 · ${hudVerdict}`,
    detail: [
      `多周期结构：${usable.length ? usable.map(r => `${r.tf} ${BIAS_TEXT[r.bias]}`).join(' · ') : '高级别 K 线还不够'}${report.mtf.verdict === 'mixed' ? '（没有形成同向共振）' : ''}。`,
      `Wyckoff 阶段：${PHASE_TEXT[report.wyckoff.phase] ?? report.wyckoff.phase}。`,
      `四框架汇总：${hudVerdict}（偏多 ${c.long} · 偏空 ${c.short} · 中性 ${c.neutral}${c.unavailable ? ` · 无数据 ${c.unavailable}` : ''}）${hudVerdict === '中性' && c.long + c.short === 1 ? '，只有 1 个视角有方向，不算共振' : ''}。`,
      '四个视角用的是同一份 K 线，只是不同看法，不是胜率或下单建议。',
    ],
  };

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
