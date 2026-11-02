import {
  Candle,
  PatternId,
  RawSignal,
  TradedSignal,
  PatternStat,
  OverallStat,
  BacktestResult,
  KeyLevel,
  HistoricalReference,
} from "./types";

// ═══════════════════════════════════════════════════════════
//  双顶 / 双底专用策略引擎（收盘确认版）
//  · 历史顶/底成为关键位；第二次测试后不再直接入场
//  · 入场只有两类：关键位收盘拒绝 / 二次测试后颈线收盘突破
//  · 逐根推进状态机，只用已收盘 K 线，实时与回测同一套逻辑
// ═══════════════════════════════════════════════════════════

export const FEE_RATE = 0.0005; // OKX 永续 taker 0.05%/边
export const SLIP_RATE = 0.0001;
export const BASE_CONF_MIN = 60; // 基础入场评分门槛（不是胜率）
export const CONF_MIN = 70; // 严格过滤门槛
export const FLOW_MIN = 55;
export const MIN_HISTORY_SAMPLES = 20;
export const MAX_HOLD_5M = 96;
export const MAX_HOLD_15M = 48;
export const RISK_USD = 100;
export const MAX_COST_RATIO = 0.3;

export interface DoubleParams {
  pivotLeft: number;
  pivotRight: number;
  lookback: number;
  minGap: number;
  minHeightAtr: number;
  priorMoveAtr: number;
  tolAtr: number;
  tolPct: number;
  sweepAtr: number;
  closeBufAtr: number;
  stopAtr: number;
  targetFrac: number;
  minRR: number;
  maxRR: number;
  enableBreak: boolean;
  breakWithin: number;
  entryMode: "confirm" | "limit";
  limitOffsetAtr: number;
  trendBlock: number;
}

// 默认：只在收盘确认后评估，不在触及关键位时假设成交
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
  enableBreak: true,
  breakWithin: 24,
  entryMode: "confirm",
  limitOffsetAtr: 0.1,
  trendBlock: 1,
};

export const PATTERN_META: Record<PatternId, { label: string; short: string; hint: string }> = {
  db_reject: {
    label: "W双底·二次测试",
    short: "W",
    hint: "历史底部被第二次测试，支撑区收盘拒绝后做多；止损在形态下方，目标看颈线",
  },
  dt_reject: {
    label: "M双顶·二次测试",
    short: "M",
    hint: "历史顶部被第二次测试，阻力区收盘拒绝后做空；止损在形态上方，目标看颈线",
  },
  db_break: {
    label: "W双底·颈线突破",
    short: "W↑",
    hint: "双底二次测试后，收盘站上颈线做多；目标为形态测量高度",
  },
  dt_break: {
    label: "M双顶·颈线跌破",
    short: "M↓",
    hint: "双顶二次测试后，收盘跌破颈线做空；目标为形态测量高度",
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

// K 线近似主动成交 delta（收盘在区间位置加权）—— 历史估算，非逐笔
export function approxDeltaAt(cs: Candle[], i: number): number {
  const c = cs[i];
  const range = c.h - c.l;
  if (range <= 0) return c.c > c.o ? c.v / 2 : c.c < c.o ? -c.v / 2 : 0;
  return c.v * (2 * ((c.c - c.l) / range) - 1);
}

const closePos = (c: Candle) => (c.h - c.l > 0 ? (c.c - c.l) / (c.h - c.l) : 0.5);

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
  confl: number;
  tags: string[];
  note: string;
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

  const volAround = (k: number) => (w[Math.max(0, k - 1)].v + w[k].v) / 2;
  const legRatio = (from: number, to: number) => {
    let d = 0;
    let v = 0;
    for (let q = Math.max(0, from); q <= to; q++) {
      d += dw[q];
      v += w[q].v;
    }
    return v > 0 ? d / v : 0;
  };
  // 历史 K 线没有逐笔方向 —— 用 K 线量价估算，界面需明确标注
  const estimatedFlow = (i: number, weakening = false) => {
    const c = w[i];
    const directional = c.v > 0 ? Math.max(-1, Math.min(1, dw[i] / c.v)) : 0;
    return Math.round(Math.max(0, Math.min(100, 50 + 30 * directional + (weakening ? 8 : 0))));
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
  const trendOk = (i: number) =>
    p.trendBlock >= 50 || !(atr[i] > 0) || (ef[i] - es[i]) / atr[i] >= -p.trendBlock;
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
    const weakening = legRatio(lv.frozenNeckIdx + 1, t) > legRatio(lv.priorIdx + 1, lv.j) + 0.05;
    if (weakening) {
      s += 8;
      tags.push(T("K线估算卖压减弱", "K线估算买压减弱"));
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
    return {
      idx: i,
      kind: "reject",
      entry,
      stop,
      tp,
      strength: Math.min(100, s),
      confl: estimatedFlow(i, weakening),
      tags,
      note: `${i - lv.j} 根前的${T("底部", "顶部")}被第二次测试，${T("支撑", "阻力")}区收盘拒绝确认`,
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
      tags.push(T("K线估算卖压减弱", "K线估算买压减弱"));
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
      confl: estimatedFlow(i),
      tags,
      note: `${i - lv.j} 根前的${T("底部", "顶部")}被第二次测试，${T("等低支撑", "等高阻力")}区挂单成交`,
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
    let av = 0;
    let m = 0;
    for (let q = Math.max(0, i - 20); q < i; q++) {
      av += w[q].v;
      m++;
    }
    av = m ? av / m : 0;
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
      tags.push(T("K线估算买压占优", "K线估算卖压占优"));
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
      confl: estimatedFlow(i),
      tags,
      note: `二次测试后第 ${i - lv.t} 根收盘${T("站上", "跌破")}颈线`,
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
        const qualified =
          lv.state === "fresh" && i - lv.j >= p.minGap && lv.neck - lv.price >= p.minHeightAtr * a;
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
            lv.state = "tested";
          } else if (i - lv.t >= 3) {
            lv.state = "tested";
          }
        } else if (lv.state === "tested") {
          if (
            p.enableBreak &&
            !lv.aboveNeck &&
            i - lv.t <= p.breakWithin &&
            w[i - 1].c <= lv.frozenNeck &&
            c.c > lv.frozenNeck
          ) {
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

    // 新的顶/底确认（右侧 R 根已全部收盘，无未来函数）
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
  const dw: number[] = new Array(cs.length);
  for (let i = 0; i < cs.length; i++) dw[i] = approxDeltaAt(cs, i);
  const last = cs.length - 1;
  for (const sgn of [1, -1] as const) {
    const top = sgn === -1;
    const w = top ? cs.map((c) => ({ ts: c.ts, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v })) : cs;
    const m = top ? dw.map((d) => -d) : dw;
    const r = scanSide(w, m, atr, p, top);
    const P = (x: number) => sgn * x;
    for (const s of r.sigs) {
      const pattern: PatternId =
        s.kind === "break" ? (top ? "dt_break" : "db_break") : top ? "dt_reject" : "db_reject";
      const strength = Math.round(s.strength);
      const baseConf = Math.round(strength * 0.65 + s.confl * 0.35);
      signals.push({
        idx: s.idx,
        barIndex: s.idx,
        ts: cs[s.idx].ts,
        side: top ? "short" : "long",
        pattern,
        entry: P(s.entry),
        stop: P(s.stop),
        tp: P(s.tp),
        conf: baseConf,
        baseConf,
        confl: s.confl,
        flowSource: "ohlcv",
        strength,
        note: s.note,
        tags: s.tags,
        level: { fromTs: cs[s.line.fromK].ts, toTs: cs[s.line.toK].ts, price: P(s.line.price), label: s.line.label },
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

// 实时逐笔订单流评分（仅当覆盖足够时才使用真实成交）
export interface TapeSample {
  buy: number;
  sell: number;
  count: number;
  coverage: number;
  bookImb?: number;
}

export function applyTapeFlow(signal: RawSignal, tape?: TapeSample): RawSignal {
  if (
    !tape ||
    !Number.isFinite(tape.buy) ||
    !Number.isFinite(tape.sell) ||
    tape.buy < 0 ||
    tape.sell < 0 ||
    !Number.isFinite(tape.count) ||
    tape.count < 20 ||
    !Number.isFinite(tape.coverage) ||
    tape.coverage < 0.8
  )
    return signal;
  const total = tape.buy + tape.sell;
  if (!(total > 0)) return signal;
  const delta = (tape.buy - tape.sell) / total;
  const direction = signal.side === "long" ? 1 : -1;
  const book = tape.bookImb != null && Number.isFinite(tape.bookImb) ? Math.max(-1, Math.min(1, tape.bookImb)) : 0;
  const confl = Math.round(Math.max(0, Math.min(100, 50 + 40 * delta * direction + 10 * book * direction)));
  const conf = Math.round(signal.baseConf * 0.7 + confl * 0.3);
  return {
    ...signal,
    conf,
    confl,
    flowSource: "tape",
    flowDelta: delta,
    flowTrades: tape.count,
    tags: [direction * delta >= 0 ? "逐笔成交方向支持" : "逐笔成交方向冲突", ...signal.tags],
  };
}

export function qualifiesForEntry(signal: RawSignal, strict = false): boolean {
  const direction = signal.side === "long" ? 1 : -1;
  const minimum = strict ? CONF_MIN : BASE_CONF_MIN;
  return (
    signal.baseConf >= minimum &&
    signal.conf >= minimum &&
    signal.confl >= FLOW_MIN &&
    !(signal.flowSource === "tape" && signal.flowDelta != null && direction * signal.flowDelta < -0.05)
  );
}

export function validEntry(
  signal: { side: "long" | "short"; stop: number; tp: number },
  price: number,
  p: DoubleParams = DEFAULT_PARAMS,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const risk = signal.side === "long" ? price - signal.stop : signal.stop - price;
  const reward = signal.side === "long" ? signal.tp - price : price - signal.tp;
  return (
    risk > 0 &&
    reward > 0 &&
    reward / risk >= p.minRR &&
    (price * 2 * (FEE_RATE + SLIP_RATE)) / risk <= MAX_COST_RATIO
  );
}

export function historicalReference(
  signal: { pattern: PatternId; baseConf: number; ts: number },
  records: TradedSignal[],
): HistoricalReference {
  const highQuality = signal.baseConf >= CONF_MIN;
  const prior = records.filter(
    (r) =>
      r.status === "done" &&
      r.r != null &&
      r.exitTs != null &&
      r.exitTs < signal.ts &&
      r.pattern === signal.pattern &&
      (r.baseConf >= CONF_MIN) === highQuality,
  );
  const wins = prior.filter((r) => (r.r ?? 0) > 0).length;
  return {
    samples: prior.length,
    wins,
    winRate: prior.length >= MIN_HISTORY_SAMPLES ? (wins / prior.length) * 100 : null,
  };
}

// ═══════════════════════════════════════════════════════════
//  回测：信号收盘确认 → 下一根开盘进场（含滑点），同根先算止损
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
      ts: s.ts,
      side: s.side,
      pattern: s.pattern,
      entry: s.entry,
      stop: s.stop,
      tp: s.tp,
      conf: s.conf,
      baseConf: s.baseConf,
      confl: s.confl,
      flowSource: s.flowSource,
      note: s.note,
      tags: s.tags,
      status: "done",
    };
    if (!qualifiesForEntry(s) || (opts.flowFilter && s.conf < confMin)) {
      recs.push({ ...base, status: "skipped" });
      continue;
    }
    // 默认收盘确认模式：下一根开盘进场
    const next = cs[i + 1];
    const entryPrice = s.side === "long" ? next.o * (1 + SLIP_RATE) : next.o * (1 - SLIP_RATE);
    // 跳空破坏止损/目标/最低盈亏比时不模拟入场
    if (!validEntry(s, entryPrice, p)) {
      recs.push({ ...base, status: "skipped" });
      continue;
    }
    let exitPrice: number | null = null;
    let exitTs = 0;
    let exitReason: "tp" | "sl" | "time" = "time";
    let exitIdx = -1;
    const endJ = Math.min(i + opts.maxHold, n - 1);
    for (let j = i + 1; j <= endJ; j++) {
      const k = cs[j];
      // 同根同时触及时保守先算止损
      const hitSL = s.side === "long" ? k.l <= s.stop : k.h >= s.stop;
      const hitTP = s.side === "long" ? k.h >= s.tp : k.l <= s.tp;
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
      // 仍在持仓期内 —— 未结算，不计入统计
      if (endJ < i + opts.maxHold) continue;
      exitPrice = cs[endJ].c;
      exitTs = cs[endJ].ts;
      exitIdx = endJ;
    }
    const exitAdj = s.side === "long" ? exitPrice * (1 - SLIP_RATE) : exitPrice * (1 + SLIP_RATE);
    const gross = s.side === "long" ? exitAdj - entryPrice : entryPrice - exitAdj;
    const fee = (entryPrice + exitAdj) * FEE_RATE;
    const pnl = gross - fee;
    const risk = s.side === "long" ? entryPrice - s.stop : s.stop - entryPrice;
    const r = risk > 0 ? pnl / risk : 0;
    recs.push({
      ...base,
      entryTs: next.ts,
      entryPrice,
      exitPrice: exitAdj,
      exitTs,
      r,
      pnlPct: (pnl / entryPrice) * 100,
      holdingBars: exitIdx - i,
      exitReason,
    });
  }
  for (const rec of recs) {
    if (rec.status === "done") rec.history = historicalReference(rec, recs);
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
  for (const r of done) {
    cum += r.r ?? 0;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  const costR = done.reduce((s, r) => {
    const risk = r.side === "long" ? (r.entryPrice ?? 0) - r.stop : r.stop - (r.entryPrice ?? 0);
    if (!(risk > 0)) return s;
    const fee = ((r.entryPrice ?? 0) + (r.exitPrice ?? 0)) * FEE_RATE;
    return s + fee / risk;
  }, 0);
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
    tpCount: done.filter((r) => r.exitReason === "tp").length,
    slCount: done.filter((r) => r.exitReason === "sl").length,
    timeCount: done.filter((r) => r.exitReason === "time").length,
    costR,
  };
}

export function summarize(
  recs: TradedSignal[],
  meta: { symbol: string; bar: string; from: number; to: number; bars: number; flowFilter: boolean },
): BacktestResult {
  const byPattern: PatternStat[] = (Object.keys(PATTERN_META) as PatternId[])
    .map((pid) => {
      const st = computeStats(recs.filter((r) => r.pattern === pid));
      return {
        id: pid,
        label: PATTERN_META[pid].label,
        short: PATTERN_META[pid].short,
        n: st.executed,
        wins: st.wins,
        winRate: st.winRate,
        avgR: st.avgR,
        totalR: st.totalR,
        pf: st.pf,
      };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.totalR - a.totalR);
  return {
    symbol: meta.symbol,
    bar: meta.bar,
    from: meta.from,
    to: meta.to,
    bars: meta.bars,
    generatedAt: Date.now(),
    flowFilter: meta.flowFilter,
    overall: computeStats(recs),
    bySide: {
      long: computeStats(recs.filter((r) => r.side === "long")),
      short: computeStats(recs.filter((r) => r.side === "short")),
    },
    byPattern,
    signals: recs.slice().sort((a, b) => b.ts - a.ts),
  };
}
