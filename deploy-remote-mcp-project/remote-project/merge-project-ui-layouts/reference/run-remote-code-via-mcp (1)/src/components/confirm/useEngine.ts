import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, ExitPlan } from '@/quant/scan';
import { EXIT_PLANS } from '@/quant/scan';
import { walkForward, wilson, type WalkForward } from '@/quant/fit';
import { optimize, edgeOverBaseline } from '@/quant/optimize';
import { summarize, calibration, thresholdSweep, attribution, topKillers, gradeDistribution, equitySeries, type Summary } from '@/quant/stats';
import { FACTORS, gradeMeta, MODEL } from '@/quant/model';
import { clampThreshold, getConfig, setConfig, subscribeConfig, type EngineConfig, type EntryMode } from '@/quant/config';

export type Row = Candidate;

export interface FactorMeta {
  key: string;
  label: string;
  short: string;
  hint: string;
  group: string;
  weight: number;
  liveOnly: boolean;
}

interface Payload {
  symbol: string;
  bar: string;
  symbols?: string[];
  timeframes?: string[];
  live: boolean;
  from: number;
  to: number;
  lastTs: number;
  bars: number;
  barMs: number;
  maxHold: number;
  generatedAt: number;
  factors: FactorMeta[];
  model: { base: number; gain: number };
  flow: { bookImb?: number | null; bigBias?: number | null; volRatio?: number | null };
  confirm: Row[];
  touch: Row[];
}

const tradable = (c: Row) => !!c.outcome?.filled && Number.isFinite(c.outcome.r);

/** 分币种表现：门槛是否在个别币种上失效 */
function symbolBreakdown(rows: Row[], threshold: number) {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    if (!tradable(r)) continue;
    const k = `${r.sym ?? '—'}·${r.bar ?? ''}`;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return [...map.entries()].map(([symbol, list]) => ({
    symbol,
    base: summarize(list, 0),
    gated: summarize(list, threshold),
  }));
}

/** 与页面顶栏的实时选择保持同步（只读 DOM，不改远程组件） */
export function readActiveMarket(): { symbol: string; bar: string } {
  const out = { symbol: 'BTC-USDT-SWAP', bar: '5m' };
  try {
    const header = document.querySelector('header');
    if (!header) return out;
    const btns = [...header.querySelectorAll('button')];
    const sym = btns.find(b => /text-\[#37c8dd\]/.test(b.className) && /^(BTC|ETH|SOL)$/.test(b.textContent?.trim() ?? ''));
    const br = btns.find(b => /bg-\[#1a2334\]/.test(b.className) && /^(5m|15m)$/.test(b.textContent?.trim() ?? ''));
    const map: Record<string, string> = { BTC: 'BTC-USDT-SWAP', ETH: 'ETH-USDT-SWAP', SOL: 'SOL-USDT-SWAP' };
    if (sym) out.symbol = map[sym.textContent!.trim()] ?? out.symbol;
    if (br) out.bar = br.textContent!.trim();
  } catch {
    /* ignore */
  }
  return out;
}

export function useEngine(open: boolean) {
  // 默认用三币种合并样本：形态笔数足够，胜率/期望才有统计意义
  const [market, setMarket] = useState(() => ({ symbol: 'ALL', bar: 'ALL' }));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<EngineConfig>(() => getConfig());
  // 默认「1R 减半 + 保本」：对照实验中它的胜率与净 R 均优于原颈线目标
  const [exitPlan, setExitPlan] = useState<ExitPlan>('partial');
  const requested = useRef('');

  useEffect(() => {
    const off = subscribeConfig(next => setCfg(next));
    return () => {
      off();
    };
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ symbol: market.symbol, bar: market.bar });
        if (fresh) q.set('fresh', '1');
        const res = await fetch(`/api/engine/scan?${q}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPayload((await res.json()) as Payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [market.bar, market.symbol],
  );

  useEffect(() => {
    if (!open) return;
    const key = `${market.symbol}|${market.bar}`;
    if (requested.current === key && payload) return;
    requested.current = key;
    void load(false);
  }, [open, market.symbol, market.bar, load, payload]);

  // 门槛变更后：让页面自身的回测重跑一次（调用它自己的刷新按钮，不改动其代码）
  const syncTimer = useRef<number | null>(null);
  const applyConfig = useCallback((patch: Partial<EngineConfig>) => {
    const next = setConfig({ ...patch, ...(patch.threshold != null ? { threshold: clampThreshold(patch.threshold) } : {}) });
    setCfg(next);
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      try {
        const btn = [...document.querySelectorAll<HTMLElement>('header button')].find(
          b => b.title === '重新扫描最新行情与信号',
        );
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      } catch {
        /* 页面尚未挂载则跳过 */
      }
    }, 900);
  }, []);

  const setThreshold = useCallback((v: number) => applyConfig({ threshold: v }), [applyConfig]);
  const setMode = useCallback((entryMode: EntryMode) => applyConfig({ entryMode }), [applyConfig]);

  /** 把候选切换到指定出场方案（结果已由服务端一次算好，切换是纯本地计算） */
  const withPlan = useCallback(
    (list: Row[], plan: ExitPlan): Row[] => list.map(c => ({ ...c, outcome: c.exits?.[plan] ?? c.outcome })),
    [],
  );

  const confirmPool = useMemo(
    () => withPlan(payload?.confirm ?? [], exitPlan),
    [payload, exitPlan, withPlan],
  );
  const touchPoolAll = useMemo(() => withPlan(payload?.touch ?? [], exitPlan), [payload, exitPlan, withPlan]);

  const rows = useMemo<Row[]>(() => {
    if (!payload) return [];
    const active = cfg.entryMode === 'touch' ? touchPoolAll : confirmPool;
    const deduped = active.filter(tradable);
    return deduped.length ? deduped : active;
  }, [payload, cfg.entryMode, confirmPool, touchPoolAll]);

  const baseline = useMemo(() => touchPoolAll.filter(tradable), [touchPoolAll]);

  const stats = useMemo(() => {
    if (!payload) return null;
    const gatedPool = cfg.entryMode === 'touch' ? touchPoolAll : confirmPool;
    const touchPool = touchPoolAll.filter(tradable);
    const structureOnly = summarize(gatedPool, 0);
    const now = summarize(gatedPool, cfg.threshold);
    const ci = wilson(now.wins, now.traded);
    // 五种出场方案在同一门槛下横向对比
    const exitCompare = EXIT_PLANS.map(p => ({
      ...p,
      stat: summarize(withPlan(confirmPool, p.id), cfg.threshold),
    }));
    const wf: WalkForward | null = walkForward(confirmPool, cfg.threshold);
    const opt = optimize(confirmPool, touchPoolAll);
    // 严格可比的基线：同一批确认形态、同一出场方案，只是不设概率门槛
    const edge = edgeOverBaseline(now, structureOnly);
    return {
      now,
      edge,
      optimize: opt,
      ci: { lo: ci.lo * 100, hi: ci.hi * 100 },
      // 基线优先用「触价即成交」原逻辑；真实费率下它常常没有可成交样本，
      // 此时退化为「同一批确认形态但不设概率门槛」，保证 A/B 可比。
      all: touchPool.length >= 15 ? summarize(touchPool, 0) : structureOnly,
      baselineKind: touchPool.length >= 15 ? ('触价即成交（原逻辑）' as const) : ('同批形态 · 不设概率门槛' as const),
      structureOnly,
      exitCompare,
      walkForward: wf,
      calib: calibration(confirmPool, 8),
      sweep: thresholdSweep(confirmPool, 0.42, 0.82, 21),
      attribution: attribution(confirmPool, cfg.threshold),
      killers: topKillers(confirmPool, cfg.threshold),
      grades: gradeDistribution(confirmPool),
      bySymbol: symbolBreakdown(confirmPool, cfg.threshold),
      equityGated: equitySeries(confirmPool, cfg.threshold),
      equityRaw: equitySeries(touchPool.length >= 15 ? touchPool : confirmPool, 0),
    };
  }, [payload, cfg.threshold, cfg.entryMode, confirmPool, touchPoolAll, withPlan]);

  /** 最近一个二次测试形态（含距今多少根），用于「当下该不该进场」判断 */
  const current = useMemo(() => {
    const empty = { row: null as Row | null, ageBars: 0, fresh: false, expired: false };
    if (!payload) return empty;
    const want = cfg.entryMode === 'touch' ? 'touch' : 'confirm';
    const pool = [...payload.confirm, ...payload.touch].filter(c => c.mode === want);
    if (!pool.length) return empty;
    pool.sort((a, b) => b.ts - a.ts);
    const row = pool[0];
    const ageBars = Math.round(Math.max(0, (payload.lastTs - row.ts) / (payload.barMs || 300_000)));
    return { row, ageBars, fresh: !!row.live, expired: ageBars > payload.maxHold };
  }, [payload, cfg.entryMode]);

  return {
    market,
    setMarket,
    payload,
    loading,
    error,
    cfg,
    rows,
    baseline,
    stats,
    current,
    setThreshold,
    setMode,
    exitPlan,
    setExitPlan,
    exitPlans: EXIT_PLANS,
    applyCombo: (c: { entryMode: EntryMode; exitPlan: ExitPlan; threshold: number }) => {
      setExitPlan(c.exitPlan);
      applyConfig({ entryMode: c.entryMode, threshold: c.threshold });
    },
    followPage: () => setMarket(readActiveMarket()),
    reload: load,
    factors: payload?.factors ?? FACTORS.map(f => ({ ...f, liveOnly: !!f.liveOnly })),
    model: payload?.model ?? MODEL,
  };
}

export function contributionOf(evidence: number | null, weight: number) {
  if (evidence == null) return 0;
  return MODEL.gain * weight * evidence;
}

export { gradeMeta };
export type { Payload, Summary };
