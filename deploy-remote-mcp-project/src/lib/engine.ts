// ─────────────────────────────────────────────────────────────
//  双顶/双底入场引擎覆盖层（预览与实盘检测共用）
//  · 形态识别仍用远程原引擎的几何（scanDoubles），只替换“是否入场”的判定
//  · conf = 结构质量（原语义）；confl = 订单流确认概率（原来是结构质量的副本）
//  · 门槛不达标 → status='skipped'，保留“检出但未执行”的可观测性
// ─────────────────────────────────────────────────────────────
export * from '../../remote/setup-mcp-project-locally/src/lib/engine';

import type { Candle, RawSignal, TradedSignal } from './types';
import {
  DEFAULT_PARAMS,
  CONF_MIN,
  MAX_HOLD_5M,
  MAX_HOLD_15M,
  PATTERN_META,
  scanDoubles,
  type OFInput,
  type ScanSignal,
  type BacktestOptions,
  type DoubleParams,
} from '../../remote/setup-mcp-project-locally/src/lib/engine';
import { buildContext, candidateFrom, type LiveFlow } from '@/quant/scan';
import { FACTORS, gradeMeta } from '@/quant/model';
import { getConfig, type EntryMode } from '@/quant/config';

const maxHoldOf = (bar: string) => (bar === '15m' ? MAX_HOLD_15M : MAX_HOLD_5M);

/**
 * 形态几何沿用远程参数；唯一差异：把「趋势屏蔽」这个一刀切的开关关掉，
 * 改由连续的 trendExhaust（趋势衰竭度）证据 + 概率门槛来决定能否进场，
 * 避免把最需要接的二次测试直接屏蔽掉。
 */
const paramsFor = (mode: EntryMode, base?: DoubleParams): DoubleParams => ({
  ...(base ?? DEFAULT_PARAMS),
  entryMode: mode === 'touch' ? 'limit' : 'confirm',
  trendBlock: 50,
});

function flowFrom(of?: OFInput): LiveFlow | undefined {
  if (!of) return undefined;
  return { bookImb: of.bookImb ?? null, bigBias: of.bigBias ?? null, volRatio: of.volRatio ?? null };
}

/** 概率标签：把模型输出直接写进既有的 tags / note，UI 与推送自动带上依据 */
function annotate(sig: ScanSignal, proba: number, mode: EntryMode) {
  const grade = gradeMeta(
    proba >= 0.66 ? 'A' : proba >= 0.58 ? 'B' : proba >= 0.5 ? 'C' : 'D',
  );
  const pct = Math.round(proba * 100);
  const entryTag = mode === 'confirm' ? '等确认K' : '触价挂单';
  return {
    conf: sig.conf,
    confl: pct,
    tags: [`确认 ${pct}% · ${grade.grade}级`, entryTag, ...(sig.tags ?? [])],
    note: `${sig.note ?? PATTERN_META[sig.pattern].label} · 订单流确认概率 ${pct}%（${grade.label}）`,
  };
}

/**
 * 回测入口：与远程引擎同名同签名，因此远程 route / 统计面板无需改动即可享受门槛。
 */
export function simulate(
  cs: Candle[],
  symbol: string,
  bar: string,
  opts: BacktestOptions,
  p: DoubleParams = DEFAULT_PARAMS,
  confMin = CONF_MIN,
): TradedSignal[] {
  const cfg = getConfig();
  const mode: EntryMode = cfg.entryMode;
  const threshold = opts.flowFilter ? Math.min(0.9, cfg.threshold + 0.05) : cfg.threshold;
  const ctx = buildContext(cs);
  const maxHold = maxHoldOf(bar);
  const { signals } = scanDoubles(cs, paramsFor(mode, p));
  const recs: TradedSignal[] = [];
  for (const s of signals) {
    const cand = candidateFrom(ctx, s, mode, maxHold);
    if (!cand) continue;
    const meta = annotate(s, cand.proba, mode);
    const base: TradedSignal = {
      id: `${symbol}_${bar}_${s.ts}_${s.pattern}_${s.side}`,
      sym: symbol,
      ts: s.ts,
      side: s.side,
      pattern: s.pattern,
      entry: s.entry,
      stop: s.stop,
      tp: s.tp,
      conf: meta.conf,
      confl: meta.confl,
      note: meta.note,
      tags: meta.tags,
      geo: s.geo,
      status: 'skipped',
    };
    if (opts.flowFilter && s.conf < confMin) continue; // 原结构质量门槛仍然生效
    if (!cand.outcome) continue;
    if (cand.proba < threshold || !cand.outcome.filled) {
      recs.push({
        ...base,
        ...({
          proba: cand.proba,
          grade: cand.grade,
          evidence: cand.evidence,
          rejectReason: cand.outcome ? (cand.proba < threshold ? 'confirm' : 'unfilled') : 'noNextBar',
        } as Record<string, unknown>),
      } as TradedSignal);
      continue;
    }
    const o = cand.outcome;
    recs.push({
      ...base,
      status: 'done',
      entryTs: o.entryTs,
      entryPrice: o.entryPrice,
      exitPrice: o.exitPrice,
      exitTs: o.exitTs,
      r: o.r,
      pnlPct: o.pnlPct,
      costR: o.costR,
      holdingBars: o.holdingBars,
      exitReason: o.why === 'gap' ? 'time' : o.why,
      ...({ proba: cand.proba, grade: cand.grade, evidence: cand.evidence, rr: cand.rr } as Record<string, unknown>),
    } as TradedSignal);
  }
  return recs;
}

/**
 * 实时入口：把远程引擎丢弃的订单流入参真正接上，并做概率门槛判定。
 * 返回的信号一律是「拒绝K已收盘」的确认信号（confirm 模式），不再触价即进场。
 */
export function detectAt(
  cs: Candle[],
  i: number,
  of?: OFInput,
  p: DoubleParams = DEFAULT_PARAMS,
): RawSignal[] {
  const cfg = getConfig();
  if (i < 30 || i >= cs.length) return [];
  const from = Math.max(0, i - (3 * p.lookback + 300));
  const sub = cs.slice(from, i + 1);
  const mode: EntryMode = cfg.entryMode;
  const { signals } = scanDoubles(sub, paramsFor(mode, p));
  const atBar = signals.filter(s => s.idx === sub.length - 1);
  if (!atBar.length) return [];
  const ctx = buildContext(sub);
  const live = flowFrom(of);
  const out: RawSignal[] = [];
  for (const s of atBar) {
    const cand = candidateFrom(ctx, s, mode, MAX_HOLD_5M, live);
    if (!cand) continue;
    if (cand.proba < cfg.threshold) {
      // 门槛未过：不产生交易信号，但把依据留在 console，便于人工复盘
      const worst = FACTORS.map((f, k) => ({ f, e: cand.evidence[k] ?? 0 }))
        .sort((a, b) => a.e - b.e)
        .slice(0, 3);
      console.info(
        `[确认引擎] ${PATTERN_META[s.pattern].label} 概率 ${Math.round(cand.proba * 100)}% < 门槛 ${Math.round(
          cfg.threshold * 100,
        )}%，放弃。主要拖累：${worst.map(w => `${w.f.label}(${w.e.toFixed(2)})`).join(' / ')}`,
      );
      continue;
    }
    const meta = annotate(s, cand.proba, mode);
    out.push({ ...s, fill: mode === 'touch' ? 'limit' : 'close', ...meta });
  }
  return out;
}
