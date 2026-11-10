// Pure projection from a causal FrameworkReport into a small, readable set of chart markings
// (2026-11-10 用户确认的精简示例)。No DOM or browser globals.
//
// 图上只留：
//  · 上方最近一条压力带、下方最近一条支撑带（浅色色带；两边都被试过时叫「箱顶 / 箱底」）
//  · 成交最多价（一条线）
//  · 不在带里的、离现价最近的缺口（只画还没补的那一截，上下各最多一个）
//  · 最近 3 次「突破 / 跌破 / 假突破 / 假跌破」
//  · 右上角盘面：各周期方向 + 一个结论
// 前高前低、等高等低、密集区上下沿、亚盘高低点都只作为带的成员出现在悬停里，不再各自出标签。
//
// 悬停文案（标题 + 最多 2 行）：① 发生了什么 ② 接下来怎么看（条件 → 结论）。不写 ATR / 摆动 / 流动性
// 等术语，不写「容易 / 常」这种回测不支持的说法；共用的说明只在四框架面板底部说一次。
// 时间按北京时间：今天只写 13:50，昨天写「昨天 13:50」。
import {
  decimalsFor,
  type AnnEvent,
  type AnnLevel,
  type AnnPayload,
  type AnnTone,
  type AnnZone,
} from '@/vela/annotTypes';
import type { FrameworkReport } from './frameworks';
import { fmtWhen } from '@/lib/displayTime';
import type { Tfbias } from './fractal';
import {
  bandShort,
  buildScene,
  MAX_TEST_MARKS,
  NEAR_UNITS,
  readMarket,
  refNamesAt,
  sp,
  type Band,
  type BandItem,
  type RefPoint,
  type Touch,
} from './marketRead';

export interface FrameworkMarkPrefs {
  enabled: boolean;
  /** 突破 / 跌破 / 假突破 / 假跌破，以及高低点参与合带 */
  liquidity: boolean;
  /** 旧的分形标记开关：分形已不画在 K 线上，只用于右上角各周期方向（保留字段以兼容已存的设置） */
  fractals: boolean;
  /** 缺口 */
  wyckoffFvg: boolean;
  /** 成交最多价（以及密集区上下沿参与合带） */
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
  /** 右上角显示的方向字：上涨 / 下跌 / 震荡 / —（K 线不够） */
  word: string;
}

export interface FrameworkHud {
  rows: FrameworkHudRow[];
  /** 把各个标注配合起来读出来的结论（底栏「标注」按钮显示同一个） */
  verdict: '偏多' | '偏空' | '观望';
  tone: AnnTone;
  phase: string;
  title: string;
  detail: string[];
}

export interface FrameworkMarkResult {
  payload: AnnPayload;
  hud: FrameworkHud | null;
}

export interface FrameworkMarkExtras {
  /** 外部的右侧标签（亚盘高低点，只有仍有效的价位），一起参与合带 */
  extraLevels?: AnnLevel[];
  /** 起名字用的参考价（含已被打掉的今天 / 昨天亚盘最高、最低价） */
  refs?: RefPoint[];
}

/** 缺口：上下各最多一个 */
export const MAX_FVG_ZONES = 2;
const MAX_POOL_DISTANCE_ATR = 8;
/** 色带最早从这么多根之前画起 */
const BAND_LOOKBACK_BARS = 48;

const PHASE_TEXT: Record<string, string> = {
  accumulation: '吸筹候选',
  distribution: '分发候选',
  markup: '上涨结构',
  markdown: '下跌结构',
  balance: '均衡',
  unknown: '未知',
};

const BIAS_WORD: Record<Tfbias, string> = { bull: '上涨', bear: '下跌', range: '震荡', unknown: '方向不明' };

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

/** 窗口时长：5m→"10 小时"，4H→"20 天"，1D→"120 天" */
const hoursText = (bars: number, barMs: number) => {
  const h = (bars * barMs) / 3_600_000;
  const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (h >= 48) return `${num(h / 24)} 天`;
  return h >= 1 ? `${num(h)} 小时` : `${Math.round(h * 60)} 分钟`;
};

const COUNT = ['', '一', '两', '三', '四', '五', '六'];
const countWord = (n: number) => COUNT[n] ?? String(n);

/** 还没补的那一截缺口 */
interface OpenGap {
  kind: 'bullish' | 'bearish';
  lo: number;
  hi: number;
  fromTs: number;
  /** 回来补到的最远价和那根的时间（没回来碰过为 null） */
  touchTs: number | null;
  touchPrice: number | null;
}

/** 按形成之后的已收盘 K 线把缺口裁成「还没补的那一截」；价格上重叠的同向缺口并成一个 */
function openGaps(report: FrameworkReport): OpenGap[] {
  const out: OpenGap[] = [];
  for (const z of report.wyckoff.imbalances) {
    if (!(z.hi > z.lo) || !Number.isFinite(z.fromTs)) continue;
    const bull = z.kind === 'bullish';
    let lo = z.lo, hi = z.hi, touchTs: number | null = null, touchPrice: number | null = null;
    for (const b of report.recent) {
      if (b.ts <= z.toTs) continue;
      if (bull ? b.l < hi : b.h > lo) {
        if (bull ? b.l < (touchPrice ?? hi) : b.h > (touchPrice ?? lo)) {
          touchPrice = bull ? b.l : b.h;
          touchTs = b.ts;
        }
      }
    }
    if (touchPrice != null) {
      if (bull) hi = Math.min(hi, touchPrice);
      else lo = Math.max(lo, touchPrice);
    }
    if (!(hi > lo)) continue;
    out.push({ kind: z.kind, lo, hi, fromTs: z.fromTs, touchTs, touchPrice });
  }
  const merged: OpenGap[] = [];
  for (const g of out.sort((a, b) => a.lo - b.lo)) {
    const last = merged.at(-1);
    if (last && last.kind === g.kind && g.lo <= last.hi) {
      last.hi = Math.max(last.hi, g.hi);
      last.fromTs = Math.max(last.fromTs, g.fromTs);
      if (g.touchTs != null && (last.touchTs == null || g.touchTs > last.touchTs)) {
        last.touchTs = g.touchTs;
        last.touchPrice = g.touchPrice;
      }
    } else merged.push({ ...g });
  }
  return merged;
}

export function projectFrameworkMarks(
  report: FrameworkReport | null,
  prefs: FrameworkMarkPrefs,
  barMs: number,
  extras: FrameworkMarkExtras = {},
): FrameworkMarkResult {
  const extraLevels = extras.extraLevels ?? [];
  if (!report || !prefs.enabled) {
    const payload = emptyPayload(report ? decimalsFor(report.lastPrice) : 2);
    payload.levels.push(...extraLevels);
    return { payload, hud: null };
  }

  const decimals = decimalsFor(report.lastPrice);
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(decimals) : '—');
  // 价位、带的边：五位数价格（BTC）取整，其余照常
  const fmtR = (v: number) => (Number.isFinite(v) ? v.toFixed(Math.abs(report.lastPrice) >= 10_000 ? 0 : decimals) : '—');
  // 参考时刻 = 最近一根已收盘 K 线的收盘时间：同一天只写 "13:50"
  const when = (ts: number | null | undefined) => fmtWhen(ts, report.lastTs + barMs);
  const unit = report.atr > 0 ? report.atr : Math.abs(report.lastPrice) * 0.002;
  const price = report.lastPrice;
  const refs = extras.refs ?? [];
  const L = report.liquidity;

  // 1. 参与合带的成员
  const items: BandItem[] = [];
  if (prefs.liquidity) {
    for (const p of L.pools) {
      if (!p.active || !Number.isFinite(p.price) || p.distanceAtr > MAX_POOL_DISTANCE_ATR) continue;
      const up = p.side === 'above';
      items.push({
        key: `pool:${p.side}:${p.price}`, lo: p.price, hi: p.price, ts: p.lastTs,
        desc: p.equal ? `${countWord(p.touches)}次没${up ? '过去的高点' : '破的低点'} ${fmtR(p.price)}` : `${when(p.firstTs)} 的${up ? '高点' : '低点'} ${fmtR(p.price)}`,
        short: p.equal ? `${up ? '等高' : '等低'}×${p.touches} ${fmtR(p.price)}` : `${up ? '前高' : '前低'} ${fmtR(p.price)}`,
      });
    }
    for (const pd of [L.pendingAbove, L.pendingBelow]) {
      if (!pd || !Number.isFinite(pd.price) || pd.distanceAtr > MAX_POOL_DISTANCE_ATR) continue;
      if (items.some(i => Math.abs(i.lo - pd.price) <= Math.abs(pd.price) * 0.0002)) continue;
      const up = pd.side === 'above';
      items.push({
        key: `pending:${pd.side}`, lo: pd.price, hi: pd.price, ts: pd.ts,
        desc: `${when(pd.ts)} 的${up ? '高点' : '低点'} ${fmtR(pd.price)}（还没确认）`,
        short: `${up ? '高点' : '低点'} ${fmtR(pd.price)}（未确认）`,
      });
    }
    // 刺穿后收回的那根冲到 / 跌到的价：这一带真正被试过的边
    for (const t of L.tests) {
      if (t.kind !== 'false' || report.lastTs - t.ts > BAND_LOOKBACK_BARS * barMs) continue;
      const up = t.side === 'above';
      if (items.some(i => i.lo === t.extreme)) continue;
      items.push({
        key: `test:${t.ts}:${t.side}`, lo: t.extreme, hi: t.extreme, ts: t.ts,
        desc: `${when(t.ts)} ${up ? '冲到' : '跌到'}的 ${fmt(t.extreme)}`,
        short: `${when(t.ts)} ${up ? '冲到' : '跌到'}的 ${fmt(t.extreme)}`,
      });
    }
  }
  const prof = report.auction.profile;
  const amtReady = prefs.amt && report.quality.auctionVolumeReady && prof.poc != null && prof.vah != null && prof.val != null;
  if (amtReady) {
    items.push({ key: 'amt:vah', lo: prof.vah!, hi: prof.vah!, desc: `密集区上沿 ${fmtR(prof.vah!)}`, short: `密集区上沿 ${fmtR(prof.vah!)}` });
    items.push({ key: 'amt:val', lo: prof.val!, hi: prof.val!, desc: `密集区下沿 ${fmtR(prof.val!)}`, short: `密集区下沿 ${fmtR(prof.val!)}` });
  }
  const gaps = prefs.wyckoffFvg ? openGaps(report) : [];
  for (const g of gaps) {
    items.push({
      key: `gap:${g.fromTs}:${g.kind}`, lo: g.lo, hi: g.hi, ts: g.fromTs,
      desc: `${when(g.fromTs)} 留下${g.touchTs != null ? '还没补的' : '的'}缺口 ${fmtR(g.lo)}–${fmtR(g.hi)}`,
      short: `缺口 ${fmtR(g.lo)}–${fmtR(g.hi)}`,
    });
  }
  for (const l of extraLevels) {
    const day = l.name.startsWith('今日') ? '今天' : l.name.startsWith('昨日') ? '昨天' : l.name.replace(/亚盘[高低]$/, '');
    const word = `${day}亚盘最${l.name.endsWith('高') ? '高' : '低'}价 ${fmtR(l.price)}`;
    items.push({ key: l.id, lo: l.price, hi: l.price, ts: l.fromTs, desc: word, short: word });
  }

  // 2. 上下最近的带、箱体
  const scene = buildScene(report, items, unit, barMs, refs);
  const { P, S, box } = scene;
  const levels: AnnLevel[] = [];
  const zones: AnnZone[] = [];
  const bandStart = (b: Band) => {
    const ts = b.items.map(i => i.ts).filter((t): t is number => Number.isFinite(t));
    const floor = report.lastTs - BAND_LOOKBACK_BARS * barMs;
    return ts.length ? Math.max(floor, Math.min(...ts)) : report.lastTs - 12 * barMs;
  };
  const touchText = (list: readonly Touch[], up: boolean) =>
    `${list.map(t => `${when(t.ts)} ${up ? '冲到' : '跌到'} ${fmt(t.price)}`).join('、')}，${countWord(list.length)}次都收了回来。`;
  const bandLevel = (b: Band, pressure: boolean): AnnLevel => {
    const touches = pressure ? scene.touchP : scene.touchS;
    const next = pressure ? scene.nextUp : scene.nextDown;
    const name = box ? (pressure ? '箱顶' : '箱底') : pressure ? '压力带' : '支撑带';
    const edge = b.inside ? (price - b.lo <= b.hi - price ? b.lo : b.hi) : pressure ? b.lo : b.hi;
    const first = touches.length >= 2
      ? touchText(touches, pressure)
      : b.items.length >= 2
        ? `这里叠着${countWord(b.items.length)}样：${b.items.map(i => i.desc).join('、')}。`
        : `${b.items[0].desc}。`;
    const nextText = next ? `，${pressure ? '上面' : '下面'}先看${sp(bandShort(next, fmtR))}` : '';
    const second = pressure
      ? `再到这里压不上去，我才考虑空；收盘站上 ${fmtR(b.hi)} → ${box ? '箱子向上破' : '这条压力带作废'}${nextText}。`
      : `回到这里守得住，我才考虑多；收盘跌破 ${fmtR(b.lo)} → ${box ? '箱子向下破' : '这条支撑带作废'}${nextText}。`;
    return {
      id: `fw:band:${pressure ? 'pressure' : 'support'}`,
      price: edge,
      ...(b.hi > b.lo ? { range: [b.lo, b.hi] as [number, number] } : {}),
      fromTs: bandStart(b),
      toTs: null,
      tone: pressure ? 'top' : 'bottom',
      name,
      style: 'dashed',
      rank: 'read',
      priority: 90,
      label: prefs.labels,
      detail: [first, second],
    };
  };
  if (P) levels.push(bandLevel(P, true));
  if (S) levels.push(bandLevel(S, false));

  // 3. 成交最多价
  if (amtReady) {
    const poc = prof.poc!;
    levels.push({
      id: 'fw:amt:poc',
      // 滚动窗口在最新一根收盘时才算完：线从这里画起，不往回画
      price: poc,
      fromTs: report.lastTs,
      toTs: null,
      tone: 'neck',
      name: '成交最多',
      style: 'solid',
      rank: 'read',
      priority: 86,
      label: prefs.labels && Math.abs(poc - price) <= MAX_POOL_DISTANCE_ATR * unit,
      detail: [
        `最近 ${hoursText(prof.window.bars, barMs)}成交最多的价格，现在价格在它${price < poc ? '下面' : price > poc ? '上面' : '上'}。`,
        '（按 K 线成交额估算）',
      ],
    });
  }

  // 4. 缺口：不在两条带里的，上下各取离现价最近的一个
  const fvgEnd = report.lastTs + Math.max(60_000, barMs) * 2;
  const inPicked = (g: OpenGap) => [P, S].some(b => b && b.items.some(i => i.key === `gap:${g.fromTs}:${g.kind}`));
  const near = (g: OpenGap) => (g.lo > price ? g.lo - price : g.hi < price ? price - g.hi : 0) <= NEAR_UNITS * unit;
  const pickGap = (list: OpenGap[]) => list.filter(g => !inPicked(g) && near(g))[0];
  const shown = [
    pickGap(gaps.filter(g => g.hi > price).sort((a, b) => a.lo - b.lo)),
    pickGap(gaps.filter(g => g.lo < price && !(g.hi > price)).sort((a, b) => b.hi - a.hi)),
  ].filter((g): g is OpenGap => !!g);
  for (const g of shown) {
    const bull = g.kind === 'bullish';
    zones.push({
      id: `fw:fvg:${g.fromTs}:${g.kind}`,
      fromTs: g.fromTs,
      toTs: fvgEnd,
      lo: g.lo,
      hi: g.hi,
      tone: bull ? 'long' : 'short',
      text: prefs.labels ? '缺口' : '',
      priority: 55,
      title: `缺口 ${fmtR(g.lo)}–${fmtR(g.hi)}${g.touchTs != null ? '（还没补的部分）' : ''}`,
      detail: [
        `${when(g.fromTs)} 一口气${bull ? '涨上去' : '跌下来'}留下的${g.touchTs != null ? `，${when(g.touchTs)} 补到了 ${fmt(g.touchPrice!)}` : '，还没回来碰过'}。`,
        `${bull ? `跌到 ${fmtR(g.lo)}` : `涨到 ${fmtR(g.hi)}`} 就补满了。`,
      ],
    });
  }

  // 5. 突破 / 跌破 / 假突破 / 假跌破：最近 3 次，同一根同一侧只留一个（真的优先）
  const events: AnnEvent[] = [];
  if (prefs.liquidity) {
    const picked = scene.tests.slice(0, MAX_TEST_MARKS);
    const inBox = (v: number) => !!box && v > box.lo && v < box.hi;
    for (const t of picked) {
      const up = t.side === 'above';
      const lv = fmtR(t.level);
      const names = refNamesAt(refs, t.level, unit);
      const what = names.length
        ? `${names.join('、')}${t.touches >= 2 ? `，前面也 ${t.touches} 次没${up ? '过去' : '破'}` : ''}`
        : t.touches >= 2 ? `前面 ${t.touches} 次没${up ? '过去的高点' : '破的低点'}` : `${when(t.levelTs)} 的${up ? '高点' : '低点'}`;
      const vol = t.effortRatio != null && t.effortRatio >= 1.5 ? `，放量 ${t.effortRatio.toFixed(1)} 倍` : '';
      let text: string, tone: AnnTone, lines: string[];
      if (t.kind === 'false') {
        text = up ? '假突破' : '假跌破';
        tone = up ? 'short' : 'long';
        const first = t.confirmTs != null
          ? `${when(t.ts)} ${up ? '冲到' : '跌到'} ${fmt(t.extreme)}，收盘只${up ? '高' : '低'} ${fmt(Math.abs(t.close - t.level))}，没站稳；${when(t.confirmTs)} 收回到 ${fmt(t.confirmClose!)}${vol}。`
          : `${when(t.ts)} ${up ? '冲到' : '跌到'} ${fmt(t.extreme)}，收盘 ${fmt(t.close)} 又回到${up ? '下面' : '上面'}${vol}。`;
        const r = t.retests.at(-1);
        const role = box ? (up ? '箱顶' : '箱底') : up ? '压力' : '支撑';
        const second = r
          ? `${when(r.ts)} 再${up ? '冲到' : '跌到'} ${fmt(r.extreme)} 也收了回来 → 这一带是${role}。`
          : `之后收盘${up ? '站上' : '跌破'} ${fmtR(t.extreme)} → 这次不算。`;
        lines = [first, second];
      } else {
        const failed = !!t.reclaim?.now;
        text = failed ? (up ? '突破又跌回' : '跌破又收回') : up ? '突破' : '跌破';
        tone = failed ? 'neck' : up ? 'long' : 'short';
        const multi = names.length + (t.touches >= 2 ? 1 : 0) >= 2;
        // 「先假后真」只说紧挨着的（6 根以内）；隔得久的只提一句那次收回来过
        const ff = t.falseFirstTs;
        const close = ff != null && t.ts - ff <= 6 * barMs;
        const first = close
          ? `${when(ff)} 先${up ? '冲上去' : '刺下去'}又收回，${when(t.ts)} 收盘${up ? '站上' : '跌穿'} —— 先假后真，${up ? '多头' : '空头'}占上风。`
          : `${when(t.ts)} 收盘${up ? '站上' : '跌穿'}${multi ? `，几层${up ? '压力一起被突破' : '支撑一起被打掉'}` : ''}${vol}${ff != null ? `；${when(ff)} 那次${up ? '冲上去' : '跌下去'}还收回来过` : ''}。`;
        const rc = t.reclaim;
        const span = rc ? (rc.count === 1 ? when(rc.firstTs) : `${when(rc.firstTs)}–${when(rc.lastTs)}`) : '';
        // 现价已经离这条线超过 1 个波动单位（顺着突破 / 跌破的方向）：回抽没站住，仍然有效
        const away = up ? price - t.level > unit : t.level - price > unit;
        const second = !rc
          ? `${up ? '回落跌不回' : '反弹收不回'} ${lv} ${up ? '下面' : '上面'}，${up ? '突破' : '跌破'}就还有效。`
          : rc.now
            ? `${when(rc.firstTs)} 起收回 ${lv} ${up ? '下面' : '上面'} → 这次${up ? '突破' : '跌破'}失败了。`
            : inBox(t.level)
              ? `${span} 又收回${up ? '下面' : '上面'} ${rc.count} 根，然后又${up ? '站了上去' : '掉了下来'}；这条线现在夹在箱子中间，分量变轻。`
              : away
                ? `${span} ${up ? '回落到下面' : '反抽回上面'} ${rc.count} 根没站住，${up ? '突破' : '跌破'}还有效。`
                : `${span} 又收回${up ? '下面' : '上面'} ${rc.count} 根，然后又${up ? '站了上去' : '掉了下来'}；这条线被来回穿，分量变轻。`;
        lines = [first, second];
      }
      events.push({
        id: `fw:test:${t.ts}:${t.side}:${t.kind}`,
        ts: t.ts,
        side: t.side,
        tone,
        text: prefs.labels ? text : '',
        priority: t.kind === 'break' ? 80 : 78,
        marker: t.kind === 'break' ? 'diamond' : 'tri',
        title: `${text} · ${lv}（${what}）`,
        detail: lines,
        // 刺穿那根没收回、后面才收回：小尾巴指到收回那根
        ...(t.confirmTs != null && t.confirmTs > t.ts ? { confirmTs: t.confirmTs } : {}),
      });
    }
  }

  // 6. 右上角盘面
  const read = readMarket({ report, scene, refs, fmt, fmtR, when: ts => when(ts), barMs });
  const hudTone: AnnTone = read.verdict === '偏多' ? 'long' : read.verdict === '偏空' ? 'short' : 'neck';
  const hud: FrameworkHud = {
    rows: report.mtf.rows.map(r => ({
      tf: r.tf,
      bias: r.bias,
      insufficient: r.insufficient,
      arrow: r.insufficient ? '—' : r.bias === 'bull' ? '↑' : r.bias === 'bear' ? '↓' : '—',
      word: r.insufficient ? '—' : BIAS_WORD[r.bias] === '方向不明' ? '—' : BIAS_WORD[r.bias],
    })),
    verdict: read.verdict,
    tone: hudTone,
    phase: PHASE_TEXT[report.wyckoff.phase] ?? '未知',
    title: `盘面：${read.headline}`,
    detail: read.lines,
  };

  // 亚盘线由时段图层画；它们已经并进带里说过，不再单独出右侧标签
  const extras2 = extraLevels.map(l => ({ ...l, label: false }));
  return {
    payload: {
      levels: [...levels, ...extras2],
      events,
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

