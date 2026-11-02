import {
  Candle,
  RawSignal,
  PatternId,
  TradedSignal,
  PatternStat,
  HourDayStat,
  OverallStat,
  BacktestResult,
  KeyLevel,
} from "./types";

// ═══════════════════════════════════════════════════════════
//  双顶 / 双底专用策略引擎
//  · 历史顶部/底部（摆动点）自动成为关键位，可跨越很长时间被再次测试
//  · 入场只有两类：关键位第二次测试拒绝 / 二次测试后颈线突破
//  · 逐根推进的状态机，只使用已收盘 K 线，实时与回测完全同一套逻辑
// ═══════════════════════════════════════════════════════════

// ─── 交易参数（真实费率与滑点）─────────────────────────────
export const FEE_RATE = 0.0005; // OKX 永续 taker 0.05%/边
export const SLIP_RATE = 0.0001; // 滑点 0.01%/边
export const CONF_MIN = 60; // 结构质量门槛（质量过滤开启时生效）
export const MAX_HOLD_5M = 96; // 8 小时超时
export const MAX_HOLD_15M = 48; // 12 小时超时
export const RISK_USD = 100; // 盈亏折算：每笔固定风险 100 USDT
export const MAX_COST_RATIO = 0.3; // 预估往返成本 / 风险 上限

export interface DoubleParams {
  pivotLeft: number; // 顶/底左侧确认根数
  pivotRight: number; // 顶/底右侧确认根数
  lookback: number; // 历史顶/底最长有效回看根数
  minGap: number; // 两次测试最少间隔根数
  minHeightAtr: number; // 颈线距离关键位 ≥ x ATR
  priorMoveAtr: number; // 第一个顶/底之前的趋势腿 ≥ x ATR
  tolAtr: number; // 等高/等低容差（ATR）
  tolPct: number; // 等高/等低容差（价格比例下限）
  sweepAtr: number; // 允许刺破关键位的深度（ATR）
  closeBufAtr: number; // 拒绝收盘需离开关键位的距离（ATR）
  stopAtr: number; // 止损放在形态外的缓冲（ATR）
  targetFrac: number; // 目标 = 到颈线距离 × frac（突破单为测量目标 × frac）
  minRR: number; // 最低盈亏比
  maxRR: number; // 目标封顶（R）
  enableBreak: boolean; // 是否交易二次测试后的颈线突破
  breakWithin: number; // 二次测试后多少根内的颈线突破才有效
  entryMode: "confirm" | "limit"; // confirm=拒绝K收盘后进场；limit=关键位挂单
  limitOffsetAtr: number; // 挂单价 = 关键位 + x ATR（不超过等高/等低容差）
  trendBlock: number; // 逆势强度超过该值（EMA20-EMA50 / ATR）不做；≥50 视为关闭
}

// 默认方案：关键位挂单 + 趋势保护（BTC/ETH/SOL × 5m/15m 历史数据训练段选择，样本外单独检验）
export const DEFAULT_PARAMS: DoubleParams = {
  pivotLeft: 8,
  pivotRight: 5,
  lookback: 288,
  minGap: 8,
  minHeightAtr: 2,
  priorMoveAtr: 1.5,
  tolAtr: 0.35,
  tolPct: 0.0004,
  sweepAtr: 0.5,
  closeBufAtr: 0.05,
  stopAtr: 0.75,
  targetFrac: 1,
  minRR: 1.2,
  maxRR: 4,
  enableBreak: false,
  breakWithin: 24,
  entryMode: "limit",
  limitOffsetAtr: 0.1,
  trendBlock: 1,
};

export const PATTERN_META: Record<
  PatternId,
  { label: string; short: string; hint: string; family: "double" }
> = {
  db_reject: {
    label: "W双底·二次测试",
    short: "W",
    hint: "历史底部（可以是很久之前的低点）被第二次测试，等低支撑区收盘拒绝后做多；止损放在双底下方，目标看颈线",
    family: "double",
  },
  dt_reject: {
    label: "M双顶·二次测试",
    short: "M",
    hint: "历史顶部被第二次测试，等高阻力区收盘拒绝后做空；止损放在双顶上方，目标看颈线",
    family: "double",
  },
  db_break: {
    label: "W双底·颈线突破",
    short: "W↑",
    hint: "双底完成二次测试后，收盘站上颈线做多；目标为形态测量高度",
    family: "double",
  },
  dt_break: {
    label: "M双顶·颈线跌破",
    short: "M↓",
    hint: "双顶完成二次测试后，收盘跌破颈线做空；目标为形态测量高度",
    family: "double",
  },
};

// ─── 基础指标 ─────────────────────────────────────────────
export function atrSeries(cs: Candle[], p = 14): number[] {
  const n = cs.length;
  const out = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = cs[i];
    const pc = cs[i - 1].c;
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum += tr[i];
    if (i - p >= 1) sum -= tr[i - p];
    out[i] = sum / Math.min(i, p);
  }
  return out;
}

export function atrAt(cs: Candle[], i: number, p = 14): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(1, i - p + 1); j <= i; j++) {
    const c = cs[j];
    const pc = cs[j - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// K 线近似主动成交 delta（收盘在区间位置加权）
export function approxDeltaAt(cs: Candle[], i: number): number {
  const c = cs[i];
  const range = c.h - c.l;
  if (range <= 0) return c.c > c.o ? c.v / 2 : c.c < c.o ? -c.v / 2 : 0;
  return c.v * (2 * ((c.c - c.l) / range) - 1);
}

export function approxDeltaSeries(cs: Candle[]): number[] {
  const out: number[] = new Array(cs.length);
  for (let i = 0; i < cs.length; i++) out[i] = approxDeltaAt(cs, i);
  return out;
}

const closePos = (c: Candle) => (c.h - c.l > 0 ? (c.c - c.l) / (c.h - c.l) : 0.5);

// ─── 单方向扫描（底部坐标系；双顶通过价格镜像复用）────────
interface Lvl {
  j: number;
  price: number;
  priorIdx: number;
  prior: number;
  neck: number;
  neckIdx: number;
  state: "fresh" | "pending" | "tested" | "done";
  t: number;
  frozenNeck: number;
  frozenNeckIdx: number;
  brokenAt: number;
  aboveNeck: boolean;
  tested: boolean;
  expired: boolean;
}

interface LocalSig {
  idx: number;
  kind: "reject" | "break" | "limit";
  entry: number;
  stop: number;
  tp: number;
  strength: number;
  tags: string[];
  note: string;
  pts: { k: number; price: number; label: string; low: boolean }[];
  line: { fromK: number; toK: number; price: number; label: string };
}

function scanSide(w: Candle[], dw: number[], atr: number[], p: DoubleParams, top: boolean) {
  const n = w.length;
  const L = Math.max(1, Math.round(p.pivotLeft));
  const R = Math.max(1, Math.round(p.pivotRight));
  const priorBars = Math.max(3 * L, 24);
  const active: Lvl[] = [];
  const all: Lvl[] = [];
  const sigs: LocalSig[] = [];
  const T = (b: string, t: string) => (top ? t : b);

  const volAround = (k: number) => (w[Math.max(0, k - 1)].v + w[k].v + w[Math.min(n - 1, k + 1)].v) / 3;
  const legRatio = (from: number, to: number) => {
    let d = 0;
    let v = 0;
    for (let q = Math.max(0, from); q <= to; q++) {
      d += dw[q];
      v += w[q].v;
    }
    return v > 0 ? d / v : 0;
  };
  const avgVolBefore = (k: number) => {
    let s = 0;
    let m = 0;
    for (let q = Math.max(0, k - 20); q < k; q++) {
      s += w[q].v;
      m++;
    }
    return m ? s / m : 0;
  };
  const emaOf = (period: number) => {
    const k = 2 / (period + 1);
    const out = new Array<number>(n);
    let e = w[0]?.c ?? 0;
    for (let q = 0; q < n; q++) {
      e = q === 0 ? w[0].c : w[q].c * k + e * (1 - k);
      out[q] = e;
    }
    return out;
  };
  const ef = emaOf(20);
  const es = emaOf(50);
  const trendOk = (i: number) => p.trendBlock >= 50 || !(atr[i] > 0) || (ef[i] - es[i]) / atr[i] >= -p.trendBlock;
  const avgVolRange = (from: number, to: number) => {
    let sv = 0;
    let m = 0;
    for (let q = Math.max(0, from); q <= to; q++) {
      sv += w[q].v;
      m++;
    }
    return m ? sv / m : 0;
  };
  const costOk = (entry: number, risk: number) =>
    risk > 0 && (Math.abs(entry) * 2 * (FEE_RATE + SLIP_RATE)) / risk <= MAX_COST_RATIO;

  const rejectNow = (c: Candle, level: number, a: number) => {
    const range = Math.max(1e-12, c.h - c.l);
    const lowerWick = (Math.min(c.o, c.c) - c.l) / range;
    return c.c >= level + p.closeBufAtr * a && closePos(c) >= 0.5 && (c.c > c.o || lowerWick >= 0.35);
  };

  const basePts = (lv: Lvl, t: number) => [
    { k: lv.priorIdx, price: lv.prior, label: T("起跌点", "起涨点"), low: false },
    { k: lv.j, price: lv.price, label: T("一底", "一顶"), low: true },
    { k: lv.frozenNeckIdx, price: lv.frozenNeck, label: "颈线", low: false },
    { k: t, price: w[t].l, label: T("二底", "二顶"), low: true },
  ];

  const makeReject = (lv: Lvl, t: number, i: number, a: number): LocalSig | null => {
    const c = w[i];
    const testLow = Math.min(w[t].l, c.l);
    const entry = c.c;
    const stop = Math.min(lv.price, testLow) - p.stopAtr * a;
    const risk = entry - stop;
    if (!costOk(entry, risk)) return null;
    const room = (lv.frozenNeck - entry) * p.targetFrac;
    if (!(room > 0)) return null;
    const tp = entry + Math.min(room, p.maxRR * risk);
    const rr = (tp - entry) / risk;
    if (rr < p.minRR) return null;

    const tags: string[] = [];
    let s = 50;
    const height = lv.frozenNeck - lv.price;
    if (testLow < lv.price) {
      s += 6;
      tags.push(T("扫低收回", "扫高回落"));
    } else {
      tags.push(testLow - lv.price <= 0.1 * a ? T("等低双底", "等高双顶") : T("二底抬高", "二顶降低"));
    }
    if (volAround(t) < volAround(lv.j) * 0.9) {
      s += 10;
      tags.push(T("二底缩量", "二顶缩量"));
    }
    if (legRatio(lv.frozenNeckIdx + 1, t) > legRatio(lv.priorIdx + 1, lv.j) + 0.05) {
      s += 8;
      tags.push(T("卖压衰竭", "买盘衰竭"));
    }
    const tb = w[t];
    if ((Math.min(tb.o, tb.c) - tb.l) / Math.max(1e-12, tb.h - tb.l) >= 0.45) {
      s += 6;
      tags.push(T("下影承接", "上影受压"));
    }
    if (closePos(c) >= 0.7) {
      s += 5;
      tags.push(T("强势收盘", "弱势收盘"));
    }
    if (height >= 3 * a) {
      s += 6;
      tags.push("形态高度充足");
    }
    if (i - lv.j >= 96) {
      s += 5;
      tags.push(T("历史底部", "历史顶部"));
    }
    if (rr >= 2) {
      s += 4;
      tags.push(`盈亏比 ${rr.toFixed(1)}`);
    }
    const pts = basePts(lv, t);
    if (t !== i) pts.push({ k: i, price: c.c, label: "确认", low: false });
    return {
      idx: i,
      kind: "reject",
      entry,
      stop,
      tp,
      strength: Math.min(100, s),
      tags,
      note: `${i - lv.j} 根前的${T("底部", "顶部")}被第二次测试，${T("支撑", "阻力")}区收盘拒绝确认`,
      pts,
      line: { fromK: lv.j, toK: i, price: lv.price, label: T("双底支撑", "双顶阻力") },
    };
  };

  const makeLimit = (lv: Lvl, i: number, a: number, entryPx: number): LocalSig | null => {
    const c = w[i];
    const fill = Math.min(c.o, entryPx);
    const stop = lv.price - p.stopAtr * a;
    const risk0 = entryPx - stop;
    if (!costOk(entryPx, risk0) || fill <= stop) return null;
    const room = (lv.frozenNeck - entryPx) * p.targetFrac;
    if (!(room > 0)) return null;
    const tp = entryPx + Math.min(room, p.maxRR * risk0);
    const rr = (tp - entryPx) / risk0;
    if (rr < p.minRR) return null;
    const tags = [T("等低支撑挂单", "等高阻力挂单")];
    let s = 50;
    const height = lv.frozenNeck - lv.price;
    if (avgVolRange(lv.frozenNeckIdx + 1, i) < avgVolRange(lv.priorIdx + 1, lv.j) * 0.9) {
      s += 8;
      tags.push(T("回测缩量", "反弹缩量"));
    }
    if (legRatio(lv.frozenNeckIdx + 1, i) > legRatio(lv.priorIdx + 1, lv.j) + 0.05) {
      s += 8;
      tags.push(T("卖压衰竭", "买盘衰竭"));
    }
    if (height >= 3 * a) {
      s += 6;
      tags.push("形态高度充足");
    }
    if (i - lv.j >= 96) {
      s += 5;
      tags.push(T("历史底部", "历史顶部"));
    }
    if (rr >= 2) {
      s += 4;
      tags.push(`盈亏比 ${rr.toFixed(1)}`);
    }
    return {
      idx: i,
      kind: "limit",
      entry: fill,
      stop,
      tp,
      strength: Math.min(100, s),
      tags,
      note: `${i - lv.j} 根前的${T("底部", "顶部")}被第二次测试，${T("等低支撑", "等高阻力")}区挂单成交`,
      pts: basePts(lv, i),
      line: { fromK: lv.j, toK: i, price: lv.price, label: T("双底支撑", "双顶阻力") },
    };
  };

  const makeBreak = (lv: Lvl, i: number, a: number): LocalSig | null => {
    const c = w[i];
    const N = lv.frozenNeck;
    const height = N - lv.price;
    if (!(c.c > c.o) || closePos(c) < 0.55 || c.c - N > 0.5 * height) return null;
    const entry = c.c;
    const stop = entry - (0.5 * height + p.stopAtr * a);
    const risk = entry - stop;
    if (!costOk(entry, risk)) return null;
    const tp = N + height * p.targetFrac;
    const rr = (tp - entry) / risk;
    if (rr < p.minRR) return null;
    const tags = [T("颈线突破", "颈线跌破")];
    let s = 52;
    const av = avgVolBefore(i);
    const vr = av > 0 ? c.v / av : 1;
    if (vr >= 1.5) {
      s += 8;
      tags.push(`${T("突破", "跌破")}放量 ${vr.toFixed(1)}x`);
    } else if (vr < 1) s -= 4;
    if (closePos(c) >= 0.7) {
      s += 5;
      tags.push(T("强势收盘", "弱势收盘"));
    }
    if (c.v > 0 && dw[i] / c.v >= 0.2) {
      s += 5;
      tags.push(T("主动买入", "主动卖出"));
    }
    if (height >= 3 * a) {
      s += 4;
      tags.push("形态高度充足");
    }
    return {
      idx: i,
      kind: "break",
      entry,
      stop,
      tp,
      strength: Math.min(100, s),
      tags,
      note: `二次测试后第 ${i - lv.t} 根收盘${T("站上", "跌破")}颈线`,
      pts: [...basePts(lv, lv.t), { k: i, price: c.c, label: T("突破", "跌破"), low: false }],
      line: { fromK: lv.frozenNeckIdx, toK: i, price: N, label: "颈线" },
    };
  };

  for (let i = 1; i < n; i++) {
    const a = atr[i];
    const c = w[i];
    if (a > 0) {
      const cands: LocalSig[] = [];
      for (const lv of active) {
        if (lv.state === "done") continue;
        const tol = Math.max(p.tolAtr * a, p.tolPct * Math.abs(lv.price));
        const qualified = lv.state === "fresh" && i - lv.j >= p.minGap && lv.neck - lv.price >= p.minHeightAtr * a;
        // 关键位挂单：价格回到关键位即成交；即使同一根直接击穿，也按成交后止损记账
        if (p.entryMode === "limit" && qualified) {
          const entryPx = lv.price + Math.min(p.limitOffsetAtr * a, tol);
          if (c.l <= entryPx) {
            lv.frozenNeck = lv.neck;
            lv.frozenNeckIdx = lv.neckIdx;
            lv.t = i;
            lv.tested = true;
            lv.state = "tested";
            if (trendOk(i)) {
              const s = makeLimit(lv, i, a, entryPx);
              if (s) cands.push(s);
            }
          }
        }
        if (c.l < lv.price - p.sweepAtr * a || c.c < lv.price - tol) {
          lv.state = "done";
          lv.brokenAt = i;
          continue;
        }
        const touch = c.l <= lv.price + tol;
        if (lv.state === "fresh") {
          if (touch && qualified) {
            lv.frozenNeck = lv.neck;
            lv.frozenNeckIdx = lv.neckIdx;
            lv.t = i;
            lv.tested = true;
            if (p.entryMode === "limit") {
              lv.state = "tested";
            } else if (rejectNow(c, lv.price, a)) {
              const s = trendOk(i) ? makeReject(lv, i, i, a) : null;
              if (s) cands.push(s);
              lv.state = "tested";
            } else {
              lv.state = "pending";
            }
          } else if (c.h > lv.neck) {
            lv.neck = c.h;
            lv.neckIdx = i;
          }
        } else if (lv.state === "pending") {
          const tb = w[lv.t];
          if (trendOk(i) && c.c > c.o && c.c > tb.c && c.c >= lv.price + p.closeBufAtr * a && closePos(c) >= 0.5) {
            const s = makeReject(lv, lv.t, i, a);
            if (s) cands.push(s);
          }
          lv.state = "tested";
        } else if (lv.state === "tested") {
          if (p.enableBreak && !lv.aboveNeck && i - lv.t <= p.breakWithin && c.c > lv.frozenNeck) {
            lv.aboveNeck = true;
            const s = trendOk(i) ? makeBreak(lv, i, a) : null;
            if (s) cands.push(s);
          }
        }
      }
      if (cands.length) {
        cands.sort((x, y) => y.strength - x.strength);
        sigs.push(cands[0]);
      }
      for (let q = active.length - 1; q >= 0; q--) {
        const lv = active[q];
        if (lv.state === "fresh" && i - lv.j > p.lookback) {
          lv.state = "done";
          lv.expired = true;
        } else if (lv.state === "tested" && i - lv.j > 3 * p.lookback) {
          lv.state = "done";
          lv.expired = true;
        }
        if (lv.state === "done") active.splice(q, 1);
      }
    }

    // 新的顶/底确认（j + R = i，右侧 K 线均已收盘，无未来函数）
    const j = i - R;
    if (j - L >= 0) {
      const lj = w[j].l;
      let ok = true;
      for (let k = j - L; k < j; k++)
        if (w[k].l <= lj) {
          ok = false;
          break;
        }
      if (ok)
        for (let k = j + 1; k <= i; k++)
          if (w[k].l < lj) {
            ok = false;
            break;
          }
      const aj = atr[i] > 0 ? atr[i] : atr[j];
      if (ok && aj > 0) {
        let prior = -Infinity;
        let priorIdx = j;
        for (let k = Math.max(0, j - priorBars); k < j; k++)
          if (w[k].h > prior) {
            prior = w[k].h;
            priorIdx = k;
          }
        const tol = Math.max(p.tolAtr * aj, p.tolPct * Math.abs(lj));
        const dup = active.some((lv) => lv.state !== "done" && Math.abs(lv.price - lj) <= tol);
        if (!dup && prior - lj >= p.priorMoveAtr * aj) {
          let neck = -Infinity;
          let neckIdx = j;
          for (let k = j + 1; k <= i; k++)
            if (w[k].h > neck) {
              neck = w[k].h;
              neckIdx = k;
            }
          const lv: Lvl = {
            j,
            price: lj,
            priorIdx,
            prior,
            neck,
            neckIdx,
            state: "fresh",
            t: -1,
            frozenNeck: neck,
            frozenNeckIdx: neckIdx,
            brokenAt: -1,
            aboveNeck: false,
            tested: false,
            expired: false,
          };
          active.push(lv);
          all.push(lv);
        }
      }
    }
  }
  return { sigs, levels: all };
}

export interface ScanSignal extends RawSignal {
  idx: number;
}

export function scanDoubles(cs: Candle[], p: DoubleParams = DEFAULT_PARAMS): { signals: ScanSignal[]; levels: KeyLevel[] } {
  const signals: ScanSignal[] = [];
  const levels: KeyLevel[] = [];
  if (cs.length < 30) return { signals, levels };
  const atr = atrSeries(cs);
  const delta = approxDeltaSeries(cs);
  const last = cs.length - 1;
  for (const sgn of [1, -1] as const) {
    const top = sgn === -1;
    const w = top ? cs.map((c) => ({ ts: c.ts, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v })) : cs;
    const dw = top ? delta.map((d) => -d) : delta;
    const r = scanSide(w, dw, atr, p, top);
    const P = (x: number) => sgn * x;
    for (const s of r.sigs) {
      const pattern: PatternId =
        s.kind === "break" ? (top ? "dt_break" : "db_break") : top ? "dt_reject" : "db_reject";
      const pts = s.pts.map((pt) => ({
        ts: cs[pt.k].ts,
        price: P(pt.price),
        label: pt.label,
        pos: (pt.low !== top ? "below" : "above") as "below" | "above",
      }));
      const path = [...pts]
        .sort((a, b) => a.ts - b.ts)
        .filter((pt, k, arr) => k === 0 || pt.ts !== arr[k - 1].ts)
        .map((pt) => ({ ts: pt.ts, price: pt.price }));
      const strength = Math.round(s.strength);
      signals.push({
        idx: s.idx,
        ts: cs[s.idx].ts,
        side: top ? "short" : "long",
        pattern,
        entry: P(s.entry),
        stop: P(s.stop),
        tp: P(s.tp),
        conf: strength,
        confl: strength,
        fill: s.kind === "limit" ? "limit" : "close",
        strength,
        note: s.note,
        tags: s.tags,
        geo: {
          pts,
          path,
          neck: { from: cs[s.line.fromK].ts, to: cs[s.line.toK].ts, price: P(s.line.price), label: s.line.label },
        },
      });
    }
    for (const lv of r.levels) {
      if (lv.expired) continue;
      if (lv.brokenAt >= 0 && !lv.tested) continue;
      levels.push({
        from: cs[lv.j].ts,
        to: cs[lv.brokenAt >= 0 ? lv.brokenAt : last].ts,
        price: P(lv.price),
        side: top ? "top" : "bottom",
        tested: lv.tested,
        broken: lv.brokenAt >= 0,
      });
    }
  }
  signals.sort((a, b) => a.idx - b.idx);
  return { signals, levels };
}

// 图表用：当前仍有效的历史顶/底关键位 + 已形成并被打破的双顶/双底
export function computeLevels(cs: Candle[], p: DoubleParams = DEFAULT_PARAMS, keepPerSide = 8): KeyLevel[] {
  const { levels } = scanDoubles(cs, p);
  const out: KeyLevel[] = [];
  for (const side of ["top", "bottom"] as const) {
    const sideLv = levels.filter((l) => l.side === side);
    const live = sideLv.filter((l) => !l.broken).sort((a, b) => b.from - a.from).slice(0, keepPerSide);
    const done = sideLv.filter((l) => l.broken && l.tested).sort((a, b) => b.to - a.to).slice(0, 4);
    out.push(...live, ...done);
  }
  return out;
}

// 实时：只返回第 i 根（刚收盘）K 线上的双顶/双底信号
export interface OFInput {
  delta?: number[];
  volRatio?: number;
  bookImb?: number;
  bigBias?: number;
}

export function detectAt(cs: Candle[], i: number, _of?: OFInput, p: DoubleParams = DEFAULT_PARAMS): RawSignal[] {
  void _of;
  if (i < 30 || i >= cs.length) return [];
  const from = Math.max(0, i - (3 * p.lookback + 300));
  const sub = cs.slice(from, i + 1);
  return scanDoubles(sub, p).signals.filter((s) => s.idx === sub.length - 1);
}

// ═══════════════════════════════════════════════════════════
//  回测：信号收盘确认 → 下根开盘进场（含滑点），同根先算止损
// ═══════════════════════════════════════════════════════════
export interface BacktestOptions {
  flowFilter: boolean;
  maxHold: number;
}

export function simulate(
  cs: Candle[],
  symbol: string,
  bar: string,
  opts: BacktestOptions,
  p: DoubleParams = DEFAULT_PARAMS,
  confMin = CONF_MIN,
): TradedSignal[] {
  const n = cs.length;
  const recs: TradedSignal[] = [];
  const { signals } = scanDoubles(cs, p);
  for (const s of signals) {
    const i = s.idx;
    if (i < 30 || i > n - 2) continue;
    const base: TradedSignal = {
      id: `${symbol}_${bar}_${s.ts}_${s.pattern}_${s.side}`,
      sym: symbol,
      ts: s.ts,
      side: s.side,
      pattern: s.pattern,
      entry: s.entry,
      stop: s.stop,
      tp: s.tp,
      conf: s.conf,
      confl: s.confl,
      note: s.note,
      tags: s.tags,
      geo: s.geo,
      status: "done",
    };
    if (opts.flowFilter && s.conf < confMin) {
      recs.push({ ...base, status: "skipped" });
      continue;
    }
    const limit = s.fill === "limit";
    const next = cs[i + 1];
    // 挂单：信号K内以挂单价成交（无入场滑点）；确认单：下一根开盘市价进场
    const entryRef = limit ? s.entry : next.o;
    const entryPrice = limit ? s.entry : s.side === "long" ? next.o * (1 + SLIP_RATE) : next.o * (1 - SLIP_RATE);
    // 跳空越过止损：不成交
    if (!limit && ((s.side === "long" && next.o <= s.stop) || (s.side === "short" && next.o >= s.stop))) {
      recs.push({ ...base, status: "skipped" });
      continue;
    }
    let exitPrice: number | null = null;
    let exitTs = 0;
    let exitReason: "tp" | "sl" | "time" = "time";
    let exitIdx = -1;
    const endJ = Math.min(i + opts.maxHold, n - 1);
    for (let j = limit ? i : i + 1; j <= endJ; j++) {
      const k = cs[j];
      const hitSL = s.side === "long" ? k.l <= s.stop : k.h >= s.stop;
      // 挂单成交K：无法确定先后，只计止损（保守）
      const hitTP = !(limit && j === i) && (s.side === "long" ? k.h >= s.tp : k.l <= s.tp);
      if (hitSL) {
        exitPrice = s.stop;
        exitReason = "sl";
      } else if (hitTP) {
        exitPrice = s.tp;
        exitReason = "tp";
      }
      if (exitPrice != null) {
        exitTs = k.ts;
        exitIdx = j;
        break;
      }
    }
    if (exitPrice == null) {
      exitPrice = cs[endJ].c;
      exitTs = cs[endJ].ts;
      exitIdx = endJ;
    }
    const exitAdj = s.side === "long" ? exitPrice * (1 - SLIP_RATE) : exitPrice * (1 + SLIP_RATE);
    const gross = s.side === "long" ? exitAdj - entryPrice : entryPrice - exitAdj;
    const fee = (entryPrice + exitAdj) * FEE_RATE;
    const slipCost = (limit ? exitPrice : entryRef + exitPrice) * SLIP_RATE;
    const pnl = gross - fee;
    const risk = s.side === "long" ? entryPrice - s.stop : s.stop - entryPrice;
    const r = risk > 0 ? pnl / risk : 0;
    recs.push({
      ...base,
      entryTs: limit ? s.ts : next.ts,
      entryPrice,
      exitPrice: exitAdj,
      exitTs,
      r,
      pnlPct: (pnl / entryPrice) * 100,
      costR: risk > 0 ? (fee + slipCost) / risk : 0,
      holdingBars: exitIdx - i,
      exitReason,
    });
  }
  return recs;
}

export function computeStats(recsIn: TradedSignal[]): OverallStat {
  const done = recsIn
    .filter((r) => r.status === "done" && r.r != null)
    .sort((a, b) => (a.exitTs ?? a.ts) - (b.exitTs ?? b.ts));
  const wins = done.filter((r) => (r.r ?? 0) > 0);
  const losses = done.filter((r) => (r.r ?? 0) <= 0);
  const grossWinR = wins.reduce((s, r) => s + (r.r ?? 0), 0);
  const grossLossR = Math.abs(losses.reduce((s, r) => s + (r.r ?? 0), 0));
  const totalR = grossWinR - grossLossR;
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  let ws = 0;
  let ls = 0;
  let maxWS = 0;
  let maxLS = 0;
  for (const r of done) {
    cum += r.r ?? 0;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    if ((r.r ?? 0) > 0) {
      ws++;
      ls = 0;
    } else {
      ls++;
      ws = 0;
    }
    maxWS = Math.max(maxWS, ws);
    maxLS = Math.max(maxLS, ls);
  }
  const avgWinR = wins.length ? grossWinR / wins.length : 0;
  const avgLossR = losses.length ? grossLossR / losses.length : 0;
  return {
    signals: recsIn.length,
    executed: done.length,
    skipped: recsIn.length - done.length,
    wins: wins.length,
    losses: losses.length,
    winRate: done.length ? (wins.length / done.length) * 100 : 0,
    avgR: done.length ? totalR / done.length : 0,
    totalR,
    pf: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? 99 : 0,
    avgHold: done.length ? done.reduce((s, r) => s + (r.holdingBars ?? 0), 0) / done.length : 0,
    maxDD,
    bestR: done.length ? Math.max(...done.map((r) => r.r ?? 0)) : 0,
    worstR: done.length ? Math.min(...done.map((r) => r.r ?? 0)) : 0,
    grossWinR,
    grossLossR,
    avgWinR,
    avgLossR,
    payoff: avgLossR > 0 ? avgWinR / avgLossR : avgWinR > 0 ? 99 : 0,
    maxWinStreak: maxWS,
    maxLossStreak: maxLS,
    tpCount: done.filter((r) => r.exitReason === "tp").length,
    slCount: done.filter((r) => r.exitReason === "sl").length,
    timeCount: done.filter((r) => r.exitReason === "time").length,
    costR: done.reduce((s, r) => s + (r.costR ?? 0), 0),
    netPct: done.reduce((s, r) => s + (r.pnlPct ?? 0), 0),
  };
}

const R_BUCKETS = [
  { label: "≤-1.5", from: -Infinity, to: -1.5 },
  { label: "-1.5~-1", from: -1.5, to: -1 },
  { label: "-1~-0.5", from: -1, to: -0.5 },
  { label: "-0.5~0", from: -0.5, to: 0 },
  { label: "0~0.5", from: 0, to: 0.5 },
  { label: "0.5~1", from: 0.5, to: 1 },
  { label: "1~1.5", from: 1, to: 1.5 },
  { label: "1.5~2", from: 1.5, to: 2 },
  { label: "2~3", from: 2, to: 3 },
  { label: ">3", from: 3, to: Infinity },
];

export function summarize(
  recs: TradedSignal[],
  meta: { symbol: string; bar: string; from: number; to: number; bars: number; scope: "single" | "all"; opts: BacktestOptions; symbols: string[] },
): BacktestResult {
  const done = recs
    .filter((r) => r.status === "done" && r.r != null)
    .sort((a, b) => (a.exitTs ?? a.ts) - (b.exitTs ?? b.ts));
  const equity: { ts: number; cumR: number }[] = [];
  let cum = 0;
  for (const r of done) {
    cum += r.r ?? 0;
    equity.push({ ts: r.exitTs ?? r.ts, cumR: Number(cum.toFixed(2)) });
  }

  const byPattern: PatternStat[] = (Object.keys(PATTERN_META) as PatternId[])
    .map((pid) => {
      const st = computeStats(recs.filter((r) => r.pattern === pid));
      return {
        id: pid,
        label: PATTERN_META[pid].label,
        short: PATTERN_META[pid].short,
        n: st.executed,
        wins: st.wins,
        losses: st.losses,
        winRate: st.winRate,
        avgR: st.avgR,
        totalR: st.totalR,
        grossWinR: st.grossWinR,
        grossLossR: st.grossLossR,
        pf: st.pf,
        avgHold: st.avgHold,
      };
    })
    .filter((p) => p.n > 0)
    .sort((a, b) => b.totalR - a.totalR);

  const hd: Record<string, { n: number; sum: number }> = {};
  for (const r of done) {
    const d = new Date(r.ts);
    const key = `${d.getDay()}_${d.getHours()}`;
    const cell = hd[key] ?? { n: 0, sum: 0 };
    cell.n++;
    cell.sum += r.r ?? 0;
    hd[key] = cell;
  }
  const byHourDay: HourDayStat[] = [];
  for (let day = 0; day < 7; day++)
    for (let hour = 0; hour < 24; hour++) {
      const cell = hd[`${day}_${hour}`];
      if (cell) byHourDay.push({ day, hour, n: cell.n, avgR: cell.sum / cell.n });
    }

  const rDist = R_BUCKETS.map((b) => ({
    label: b.label,
    from: b.from === -Infinity ? -2 : b.from,
    n: done.filter((r) => (r.r ?? 0) > b.from && (r.r ?? 0) <= b.to).length,
  }));

  return {
    live: false,
    scope: meta.scope,
    symbol: meta.symbol,
    bar: meta.bar,
    from: meta.from,
    to: meta.to,
    bars: meta.bars,
    generatedAt: Date.now(),
    params: {
      feeBps: FEE_RATE * 10000,
      slipBps: SLIP_RATE * 10000,
      maxHold: meta.opts.maxHold,
      flowFilter: meta.opts.flowFilter,
      confMin: CONF_MIN,
      riskUsd: RISK_USD,
    },
    strategy: { ...DEFAULT_PARAMS },
    overall: computeStats(recs),
    bySide: {
      long: computeStats(recs.filter((r) => r.side === "long")),
      short: computeStats(recs.filter((r) => r.side === "short")),
    },
    byPattern,
    bySymbol: meta.symbols.map((s) => ({ symbol: s, stat: computeStats(recs.filter((r) => r.sym === s)) })),
    byHourDay,
    rDist,
    equity,
    signals: recs.slice().sort((a, b) => a.ts - b.ts).slice(-400),
  };
}
