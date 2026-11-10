// 把四框架的各个标注「配合起来」读（2026-11-10 用户确认的示例）：
// 1. 挨得近的线、缺口、刺穿过的高低点合成带（单条带不超过 1.5 个波动单位宽），上方叫压力带、下方叫支撑带；
// 2. 只取现价上下最近的一条带；上下两条带都被刺穿后收回、中间一直来回 → 叫「箱顶 / 箱底」；
// 3. 右上角盘面：大方向 + 刚发生了什么 + 现在卡在哪 + 我等在哪、什么算看错（只有一个看错价）。
// 纯函数、只用已收盘数据；这是读盘的组织方式，不是胜率或下单建议（各单个标注的实测
// 方向命中都接近一半一半，所以从不把单个标注当成可靠信号）。
import type { FrameworkReport, RecentBar } from './frameworks';
import type { Tfbias } from './fractal';
import type { LevelTest } from './liquidity';

/** 外部给的参考价（例如亚盘最高 / 最低价），只用来给价位「起名字」 */
export interface RefPoint {
  name: string;
  price: number;
}

/** 参与合带的一个成员：一条线（lo = hi）或一个缺口 */
export interface BandItem {
  key: string;
  lo: number;
  hi: number;
  /** 悬停里的完整说法，例如「19:15 的高点 74391.5」 */
  desc: string;
  /** 短说法，例如「前高 74391.5」 */
  short: string;
  /** 这一样出现的时间（画带从哪根开始） */
  ts?: number;
}

export interface Band {
  lo: number;
  hi: number;
  items: BandItem[];
  /** 相对现价：上方 = 压力带，下方 = 支撑带；现价在里面时按偏上 / 偏下归类 */
  kind: 'pressure' | 'support';
  inside: boolean;
}

/** 合带时相邻两样最多隔多远（波动单位） */
export const BAND_GAP_UNITS = 0.8;
/** 一条带最多多宽（波动单位）：再宽就不是一个价位了 */
export const BAND_MAX_UNITS = 1.5;
/** 离现价超过这么多个波动单位的带不出标签 */
export const NEAR_UNITS = 5;

/**
 * 先按现价把成员分到上方（压力）/ 下方（支撑），再在每一侧把间隔不超过 gapUnits、合起来宽度不超过
 * maxUnits 个波动单位的成员合成一带。现价两边的东西绝不并进同一条带。跨着现价的缺口按它大部分在哪一侧归类。
 */
export function groupBands(items: readonly BandItem[], unit: number, price: number, gapUnits = BAND_GAP_UNITS, maxUnits = BAND_MAX_UNITS): Band[] {
  const sideOf = (i: BandItem): Band['kind'] =>
    i.hi < price ? 'support' : i.lo > price ? 'pressure' : i.hi - price >= price - i.lo ? 'pressure' : 'support';
  const out: Band[] = [];
  for (const kind of ['support', 'pressure'] as const) {
    const sorted = items
      .filter(i => Number.isFinite(i.lo) && Number.isFinite(i.hi) && sideOf(i) === kind)
      .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const side: Band[] = [];
    for (const it of sorted) {
      const last = side.at(-1);
      if (last && it.lo - last.hi <= gapUnits * unit && Math.max(last.hi, it.hi) - last.lo <= maxUnits * unit) {
        last.hi = Math.max(last.hi, it.hi);
        last.items.push(it);
      } else {
        side.push({ lo: it.lo, hi: it.hi, items: [it], kind, inside: false });
      }
    }
    for (const b of side) b.inside = price >= b.lo && price <= b.hi;
    out.push(...side);
  }
  return out.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
}

/** "30m" → "30 分钟"，"1H" → "1 小时"，"1D" → "日线" */
export const tfWord = (tf: string) => {
  const m = /^(\d+)\s*m$/.exec(tf);
  if (m) return `${m[1]} 分钟`;
  const h = /^(\d+)\s*H$/i.exec(tf);
  if (h) return `${h[1]} 小时`;
  if (/^1?D$/i.test(tf)) return '日线';
  if (/^1?W$/i.test(tf)) return '周线';
  return tf;
};

export interface Trend {
  /** 1 向上 / -1 向下 / 0 不清 */
  dir: 1 | -1 | 0;
  /** 「大方向向下：15 分钟、30 分钟、1 小时都在跌，5 分钟在喘口气」 */
  text: string;
}

const BIAS_SIGN: Record<Tfbias, number> = { bull: 1, bear: -1, range: 0, unknown: 0 };

/** 多周期合起来的大方向：各周期涨 +1 / 跌 -1，合计至少 2 才算有方向 */
export function trendOf(report: FrameworkReport): Trend {
  const rows = report.mtf.rows.filter(r => !r.insufficient && r.bias !== 'unknown');
  if (rows.length < 2) return { dir: 0, text: '大周期 K 线还不够，方向先不看' };
  const score = rows.reduce((s, r) => s + BIAS_SIGN[r.bias], 0);
  const dir: Trend['dir'] = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  const join = (list: typeof rows) => list.map(r => tfWord(r.tf)).join('、');
  const down = rows.filter(r => r.bias === 'bear');
  const up = rows.filter(r => r.bias === 'bull');
  const flat = rows.filter(r => r.bias === 'range');
  const base = report.mtf.rows[0];
  const parts: string[] = [];
  if (down.length) parts.push(`${join(down)}${down.length > 1 ? '都' : ''}在跌`);
  if (up.length) parts.push(`${join(up)}${up.length > 1 ? '都' : ''}在涨`);
  if (flat.length) {
    const onlyBase = flat.length === 1 && base && flat[0].tf === base.tf && dir !== 0;
    parts.push(onlyBase ? `${tfWord(base.tf)}在喘口气` : `${join(flat)}${dir !== 0 ? '还' : ''}在震荡`);
  }
  const head = dir < 0 ? '大方向向下' : dir > 0 ? '大方向向上' : '方向不清';
  return { dir, text: `${head}：${parts.join('，')}` };
}

/** 某个价位同时是哪些参考价（亚盘最高 / 最低价等） */
export function refNamesAt(refs: readonly RefPoint[], price: number, unit: number): string[] {
  const tol = Math.max(0.15 * unit, Math.abs(price) * 0.0002);
  return [...new Set(refs.filter(r => Math.abs(r.price - price) <= tol).map(r => r.name))];
}

export const bandRange = (b: Band, fmt: (v: number) => string) => (b.hi - b.lo > 0 ? `${fmt(b.lo)}–${fmt(b.hi)}` : fmt(b.lo));
export const bandShort = (b: Band, fmt: (v: number) => string) =>
  b.items.length === 1 ? b.items[0].short : `${bandRange(b, fmt)} 一带`;
/** 后面接数字时留空格，接中文时不留：「先看 85.39–85.73 一带」「先看缺口 74429–74586」 */
export const sp = (s: string) => (/^[\d.-]/.test(s) ? ` ${s}` : s);

// ─── 盘面场景：上下最近的带、箱体、碰到这条带的那几次 ─────────────────────

export interface Touch {
  ts: number;
  /** 冲到 / 跌到的价 */
  price: number;
}

export interface Box {
  lo: number;
  hi: number;
  /** 从哪根开始在箱子里来回 */
  startTs: number;
}

export interface Scene {
  price: number;
  unit: number;
  bands: Band[];
  /** 上方最近的压力带 / 下方最近的支撑带（离现价 NEAR_UNITS 以内） */
  P: Band | null;
  S: Band | null;
  /** P 再往上 / S 再往下的下一条带（「下一站」） */
  nextUp: Band | null;
  nextDown: Band | null;
  box: Box | null;
  /** 碰到 P / S 的那几次（已确认的高低点 + 刺穿后收回的那根） */
  touchP: Touch[];
  touchS: Touch[];
  /** 最近 3 根里冲进 P（或跌进 S）却没收进去的那根 */
  pokeP: Touch | null;
  pokeS: Touch | null;
  /** 图上要画的突破 / 跌破 / 假突破 / 假跌破（最新的在前） */
  tests: LevelTest[];
}

const FRESH_BARS = 48;
export const MAX_TEST_MARKS = 3;

/** 这次测试现在还算不算数（突破 / 跌破之后又收回去并停在原来那一侧 = 失败） */
export const testDir = (t: LevelTest): 1 | -1 | 0 => {
  const up = t.side === 'above';
  if (t.kind === 'false') return up ? -1 : 1;
  if (t.reclaim?.now) return 0;
  return up ? 1 : -1;
};

/**
 * 同一根、同一侧只留一个来说：真的优先；再看分量（亚盘价算两份、碰过几次）；
 * 还一样时，跌破说更低的那个、突破说更高的那个（打掉的更深）。
 */
export function pickTests(tests: readonly LevelTest[], refs: readonly RefPoint[], unit: number): LevelTest[] {
  const weight = (t: LevelTest) => t.touches + 2 * refNamesAt(refs, t.level, unit).length;
  const best = new Map<string, LevelTest>();
  for (const t of tests) {
    const key = `${t.ts}:${t.side}`;
    const prev = best.get(key);
    const better = !prev
      || (t.kind === 'break' && prev.kind === 'false')
      || (t.kind === prev.kind && (weight(t) > weight(prev)
        || (weight(t) === weight(prev) && (t.side === 'above' ? t.level > prev.level : t.level < prev.level))));
    if (better) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => b.ts - a.ts);
}

const bandOf = (list: BandItem[], kind: Band['kind'], price: number): Band => {
  const lo = Math.min(...list.map(i => i.lo)), hi = Math.max(...list.map(i => i.hi));
  return { lo, hi, items: list, kind, inside: price >= lo && price <= hi };
};

export function buildScene(report: FrameworkReport, items: readonly BandItem[], unit: number, barMs: number, refs: readonly RefPoint[] = []): Scene {
  const price = report.lastPrice;
  const bands = groupBands(items, unit, price);
  const dist = (b: Band) => (b.inside ? 0 : b.kind === 'pressure' ? b.lo - price : price - b.hi);
  const above = bands.filter(b => b.kind === 'pressure').sort((a, b) => a.lo - b.lo);
  const below = bands.filter(b => b.kind === 'support').sort((a, b) => b.hi - a.hi);
  /**
   * 离现价最近、而且不只是一条密集区上下沿的那条带；更远一点（多 1 个波动单位以内）有叠了几样的带就用它。
   */
  const pick = (list: Band[]) => {
    const close = list.filter(b => dist(b) <= NEAR_UNITS * unit && !b.items.every(i => i.key.startsWith('amt:')));
    const base = close[0];
    if (!base) return null;
    return close.find(b => b.items.length >= 2 && dist(b) <= dist(base) + unit) ?? base;
  };
  let P = pick(above);
  let S = pick(below);
  let nextUp = P ? above[above.indexOf(P) + 1] ?? null : null;
  let nextDown = S ? below[below.indexOf(S) + 1] ?? null : null;

  const since = report.lastTs - FRESH_BARS * barMs;
  const tests = pickTests(report.liquidity.tests.filter(t => t.ts >= since), refs, unit);
  const inBand = (b: Band | null, v: number, pad = 0.1) => !!b && v >= b.lo - pad * unit && v <= b.hi + pad * unit;
  const falseIn = (b: Band | null, side: 'above' | 'below') =>
    tests.filter(t => t.kind === 'false' && t.side === side && inBand(b, t.extreme, 0.3));

  // 箱体：上面那条带被冲过又收回、下面那条带被跌破又收回，之后收盘一直在两条带之间
  let box: Box | null = null;
  const fp = falseIn(P, 'above'), fs = falseIn(S, 'below');
  if (P && S && fp.length && fs.length) {
    const startTs = Math.min(...fp.map(t => t.ts), ...fs.map(t => t.ts));
    const inBox = report.recent.filter(b => b.ts >= startTs);
    const held = inBox.length > 0 && inBox.every(b => b.c >= S!.lo - 0.1 * unit && b.c <= P!.hi + 0.1 * unit);
    if (held) {
      // 箱子的上下沿 = 这段时间真正冲到 / 跌到的最高、最低价
      box = { lo: Math.min(...inBox.map(b => b.l)), hi: Math.max(...inBox.map(b => b.h)), startTs };
      // 带里比箱子还远、这段时间没被碰过的价位：不算箱顶 / 箱底，改作「下一站」
      const clip = (b: Band, pressure: boolean): { band: Band; rest: Band | null } => {
        const edge = pressure ? box!.hi : box!.lo;
        const keep = b.items.filter(i => (pressure ? i.lo <= edge + 0.1 * unit : i.hi >= edge - 0.1 * unit));
        const rest = b.items.filter(i => !keep.includes(i));
        if (!rest.length || !keep.length) return { band: b, rest: null };
        const band = bandOf(keep, b.kind, price);
        if (pressure) band.hi = Math.min(band.hi, Math.max(edge, band.lo)); else band.lo = Math.max(band.lo, Math.min(edge, band.hi));
        return { band, rest: bandOf(rest, b.kind, price) };
      };
      const cp = clip(P, true), cs = clip(S, false);
      P = cp.band; S = cs.band;
      if (cp.rest) nextUp = cp.rest;
      if (cs.rest) nextDown = cs.rest;
    }
  }

  const touchesOf = (b: Band | null, side: 'above' | 'below'): Touch[] => {
    if (!b) return [];
    const from = box ? box.startTs : since;
    const map = new Map<number, Touch>();
    for (const s of report.liquidity.swings) {
      if (s.side === side && s.ts >= from && !s.broken && inBand(b, s.price)) map.set(s.ts, { ts: s.ts, price: s.price });
    }
    for (const t of tests) {
      if (t.kind === 'false' && t.side === side && t.ts >= from && inBand(b, t.extreme, 0.3)) map.set(t.ts, { ts: t.ts, price: t.extreme });
    }
    return [...map.values()].sort((x, y) => x.ts - y.ts);
  };

  const pokeOf = (b: Band | null, up: boolean): Touch | null => {
    if (!b) return null;
    const tail: RecentBar[] = report.recent.slice(-3).reverse();
    for (const r of tail) {
      if (up ? r.h >= b.lo && r.c < b.lo : r.l <= b.hi && r.c > b.hi) return { ts: r.ts, price: up ? r.h : r.l };
    }
    return null;
  };

  return {
    price, unit, bands, P, S, nextUp, nextDown, box,
    touchP: touchesOf(P, 'above'), touchS: touchesOf(S, 'below'),
    pokeP: P && !P.inside ? pokeOf(P, true) : null,
    pokeS: S && !S.inside ? pokeOf(S, false) : null,
    tests,
  };
}

// ─── 右上角盘面 ──────────────────────────────────────────────

export interface ReadInput {
  report: FrameworkReport;
  scene: Scene;
  refs: readonly RefPoint[];
  /** 精确价（影线、收盘价） */
  fmt: (v: number) => string;
  /** 价位 / 带的边（BTC 这种五位数价格取整） */
  fmtR: (v: number) => string;
  when: (ts: number) => string;
  barMs: number;
}

export interface MarketRead {
  verdict: '偏多' | '偏空' | '观望';
  headline: string;
  lines: string[];
}

const COUNT = ['', '一', '两', '三', '四', '五', '六'];
const countWord = (n: number) => COUNT[n] ?? String(n);
const pctAway = (a: number, b: number) => `${(Math.abs(a - b) / Math.max(1e-9, Math.abs(b)) * 100).toFixed(1)}%`;

export function durationText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.round(h / 24)} 天`;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/** 「19:15、19:45」 */
const timesOf = (list: readonly Touch[], when: (ts: number) => string) => list.map(t => when(t.ts)).join('、');

/** 「下面 84.12–84.18 是 19:00、19:30 两次跌下去又收回来的地方」 */
function supportWhat(S: Band, touches: readonly Touch[], read: ReadInput): string {
  const r = bandRange(S, read.fmtR);
  if (touches.length) return `下面 ${r} 是 ${timesOf(touches, read.when)}${touches.length > 1 ? ` ${countWord(touches.length)}次` : ' '}跌下去又收回来的地方`;
  return `下面先看${sp(bandShort(S, read.fmtR))}`;
}

function pressureWhat(P: Band, touches: readonly Touch[], read: ReadInput): string {
  const r = bandRange(P, read.fmtR);
  if (touches.length) return `上面 ${r} 是 ${timesOf(touches, read.when)}${touches.length > 1 ? ` ${countWord(touches.length)}次` : ' '}冲上去又回落的地方`;
  return `上面先看${sp(bandShort(P, read.fmtR))}`;
}

export function readMarket(read: ReadInput): MarketRead {
  const { report, scene, refs, fmtR, when, barMs } = read;
  const { P, S, box, price, unit } = scene;
  const trend = trendOf(report);
  const lines: string[] = [];
  const now = fmtR(price);

  // 刚发生的突破 / 跌破（还算数的那几次，按时间先后）
  const breaks = scene.tests.filter(t => t.kind === 'break' && !t.reclaim?.now).sort((a, b) => a.ts - b.ts).slice(-2);
  const lastBreak = breaks.at(-1) ?? null;
  const breakText = breaks.map((t, i) => {
    const up = t.side === 'above';
    const names = refNamesAt(refs, t.level, unit);
    const verb = i === 1 && breaks[0].side === t.side ? `又${up ? '突破' : '跌破'}` : `收盘${up ? '突破' : '跌破'}`;
    return `${when(t.ts)} ${verb}${names.length ? names.join('、') : ''} ${fmtR(t.level)}`;
  }).join('，');

  // ── 箱体：先观望；走到边上才站队 ──
  if (box) {
    const h = box.hi - box.lo;
    const nearTop = box.hi - price <= 0.25 * h;
    const nearBottom = price - box.lo <= 0.25 * h;
    const verdict: MarketRead['verdict'] = nearTop && trend.dir <= 0 ? '偏空' : nearBottom && trend.dir >= 0 ? '偏多' : '观望';
    const headline = verdict === '偏空' ? '偏空 · 在箱顶' : verdict === '偏多' ? '偏多 · 在箱底' : '先观望 · 在箱子里';
    const range = `${fmtR(box.lo)}–${fmtR(box.hi)}`;
    lines.push(`${when(box.startTs)} 以后一直在 ${range} 之间来回，已经 ${durationText(report.lastTs + barMs - box.startTs)}。`);
    const tp = scene.touchP, ts = scene.touchS;
    if (tp.length && ts.length) {
      lines.push(`两头都试过：${timesOf(tp, when)} 冲上沿${tp.length > 1 ? '都' : ''}没站稳，${timesOf(ts, when)} 跌下沿${ts.length > 1 ? '都' : ''}收了回来。`);
    }
    lines.push(verdict === '偏空'
      ? `现在 ${now} 靠近箱顶：再压不上去，是我想空的地方。`
      : verdict === '偏多'
        ? `现在 ${now} 靠近箱底：再守得住，是我想多的地方。`
        : `现在 ${now} 在箱子中间，两头都不划算，等它走到边上。`);
    const up = scene.nextUp ? `，先看${sp(bandShort(scene.nextUp, fmtR))}` : '';
    const dn = scene.nextDown ? `，先看${sp(bandShort(scene.nextDown, fmtR))}` : '';
    lines.push(`收盘站上 ${fmtR(box.hi)} → 偏多${up}；收盘跌破 ${fmtR(box.lo)} → 偏空${dn}。`);
    return { verdict, headline, lines };
  }

  // ── 趋势：跟大方向，刚发生的反向突破 / 跌破会让我先停一停 ──
  const fresh = lastBreak && report.lastTs - lastBreak.ts <= 24 * barMs ? testDir(lastBreak) : 0;
  const verdict: MarketRead['verdict'] = trend.dir !== 0 && fresh !== -trend.dir ? (trend.dir > 0 ? '偏多' : '偏空') : '观望';
  lines.push(`${trend.text}。${breakText ? `${breakText}。` : ''}`);

  // 现在在哪
  const dP = P ? (P.inside ? 0 : P.lo - price) : Infinity;
  const dS = S ? (S.inside ? 0 : price - S.hi) : Infinity;
  const atP = !!P && (dP <= 0.5 * unit || !!scene.pokeP);
  const atS = !!S && (dS <= 0.5 * unit || !!scene.pokeS);
  const parts = (b: Band) => b.items.map(i => i.short).join('、');
  if (P && atP && (verdict !== '偏多' || !atS)) {
    const poke = scene.pokeP ? `，${when(scene.pokeP.ts)} 冲到 ${read.fmt(scene.pokeP.price)} 没收上去` : '';
    lines.push(`现在 ${now} 已经顶到压力带 ${bandRange(P, fmtR)}（${parts(P)}）${poke}。`);
  } else if (S && atS) {
    const poke = scene.pokeS ? `，${when(scene.pokeS.ts)} 跌到 ${read.fmt(scene.pokeS.price)} 又收了回来` : '';
    lines.push(`现在 ${now} 已经落到支撑带 ${bandRange(S, fmtR)}（${parts(S)}）${poke}。`);
  } else {
    const where = [P ? `上面压力带 ${bandRange(P, fmtR)} 还差 ${pctAway(P.lo, price)}` : '', S ? `下面支撑带 ${bandRange(S, fmtR)} 还差 ${pctAway(S.hi, price)}` : ''].filter(Boolean);
    lines.push(`现在 ${now}${where.length ? `：${where.join('，')}` : ''}。`);
  }

  let headline: string = verdict === '观望' ? '先观望' : verdict;
  if (verdict === '偏空') {
    const tight = S && !atP && dS <= 1.0 * unit;
    headline = tight ? '偏空 · 下面有支撑，不追' : '偏空 · 等反抽';
    if (P) {
      const next = scene.nextUp ? `，先看${sp(bandShort(scene.nextUp, fmtR))}` : '';
      lines.push(atP
        ? `这里压得住，才是我想空的地方；收盘站上 ${fmtR(P.hi)} → 我看错了${next}。`
        : `反抽到 ${bandRange(P, fmtR)} 压不上去再空；收盘站上 ${fmtR(P.hi)} → 我看错了${next}。`);
    } else if (lastBreak) {
      lines.push(`收盘站回 ${fmtR(lastBreak.level)} 上面 → 我看错了。`);
    }
    if (S) {
      lines.push(tight
        ? `下面 ${bandRange(S, fmtR)} 离现在只有 ${pctAway(S.hi, price)}，这里追空不划算。`
        : `${supportWhat(S, scene.touchS, read)}，跌破收不回就继续往下。`);
    }
  } else if (verdict === '偏多') {
    const tight = P && !atS && dP <= 1.0 * unit;
    headline = tight ? '偏多 · 上面有压力，不追' : '偏多 · 等回踩';
    if (S) {
      const next = scene.nextDown ? `，先看${sp(bandShort(scene.nextDown, fmtR))}` : '';
      lines.push(atS
        ? `这里守得住，才是我想多的地方；收盘跌破 ${fmtR(S.lo)} → 我看错了${next}。`
        : `回踩到 ${bandRange(S, fmtR)} 守得住再多；收盘跌破 ${fmtR(S.lo)} → 我看错了${next}。`);
    } else if (lastBreak) {
      lines.push(`收盘跌回 ${fmtR(lastBreak.level)} 下面 → 我看错了。`);
    }
    if (P) {
      lines.push(tight
        ? `上面 ${bandRange(P, fmtR)} 离现在只有 ${pctAway(P.lo, price)}，这里追多不划算。`
        : `${pressureWhat(P, scene.touchP, read)}，站上去守住就继续往上。`);
    }
  } else {
    const up = P ? `收盘站上 ${fmtR(P.hi)} 再偏多看` : '';
    const dn = S ? `跌破 ${fmtR(S.lo)} 再偏空看` : '';
    lines.push(`几样说法不一致，我先不站队${up || dn ? `：${[up, dn].filter(Boolean).join('，')}` : ''}。`);
  }
  return { verdict, headline, lines };
}
