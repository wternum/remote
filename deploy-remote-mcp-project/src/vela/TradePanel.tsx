import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { ChevronDown, Crosshair, Eye, EyeOff, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { runScan, liveFlowOf, EXIT_PLANS, type Candidate, type ExitPlan } from '@/quant/scan';
import { computeLevels } from '@/lib/engine';
import { summarize, thresholdSweep } from '@/quant/stats';
import { gradeMeta } from '@/quant/model';
import { clampThreshold, getConfig, LIMITS, setConfig, subscribeConfig, type EngineConfig } from '@/quant/config';
import { useChartBars, useLastPrice } from './useChartBars';
import { useFlow } from './useFlow';
import { useLiveFlow } from './useLiveFlow';
import FlowRead from './FlowRead';
import { annotateCandidate, clearAnnotations, clearLevels, clearRead, hoverSignal, paintLevels, paintRead, type ReadAnnotation } from './annotate';
import { tfMs } from './okxProvider';
import type { Ctx } from '@/quant/scan';

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const MUT = '#8c96ab';
const LATEST_BARS = 12;

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
const hm = (ts: number) => {
  const t = new Date(ts);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};
const tfLabel = (tf: string) => (tf === 'D' ? '1D' : tf === 'W' ? '1W' : Number(tf) >= 60 ? `${Number(tf) / 60}H` : `${tf}m`);
const shapeOf = (c: Candidate) => (c.pattern.startsWith('db') ? 'W 双底' : 'M 双顶');

function resultOf(c: Candidate, pass: boolean) {
  const r = c.outcome?.filled ? c.outcome.r : null;
  if (r == null) return { text: '进行中', tone: MUT };
  if (!pass) return { text: '未过门槛', tone: MUT };
  return { text: `${signed(r, 1)}R`, tone: r > 0 ? LONG : SHORT };
}

function Price() {
  const px = useLastPrice();
  return <div className="tp-px">{px != null ? px.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</div>;
}

export default function TradePanel({ getChart, onOpenEngine }: { getChart: () => Vela | null; onOpenEngine: () => void }) {
  const bars = useChartBars(getChart);
  const [cfg, setCfg] = useState<EngineConfig>(() => getConfig());
  const [exitPlan, setExitPlan] = useState<ExitPlan>('r15');
  const [focus, setFocus] = useState<string | null>(null);
  const [showLevels, setShowLevels] = useState(true);
  const [onlyPass, setOnlyPass] = useState(false);
  const [gear, setGear] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [detail, setDetail] = useState(false);
  const [glow, setGlow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = subscribeConfig(setCfg);
    return () => {
      off();
    };
  }, []);

  const barMs = tfMs(bars.timeframe || '5');
  const engineBar = Number(bars.timeframe) >= 15 ? '15m' : '5m';
  const flow = useFlow(bars.symbol, bars.timeframe, bars.closedTs, bars.candles[0]?.ts ?? 0);

  // 实时订单流因子（盘口失衡 / 大单主动方向）：通过 ref 参与下一次重算，避免每 5s 全量重扫
  const liveFlow = useLiveFlow(bars.symbol, bars.timeframe);
  const liveFlowRef = useRef(liveFlow);
  liveFlowRef.current = liveFlow;

  const scanKey = `${bars.symbol}|${bars.timeframe}|${bars.closedTs}|${exitPlan}|${cfg.entryMode}|flow${flow.version}`;
  const scanKeyRef = useRef('');
  const candlesRef = useRef(bars.candles);
  candlesRef.current = bars.candles;
  const [scan, setScan] = useState<{ rows: Candidate[]; levels: ReturnType<typeof computeLevels>; n: number; ctx: Ctx; coverage: number } | null>(null);
  const flowRef = useRef(flow.snapshot);
  flowRef.current = flow.snapshot;

  useEffect(() => {
    if (scanKey === scanKeyRef.current) return;
    scanKeyRef.current = scanKey;
    const candles = candlesRef.current;
    if (candles.length < 60) {
      setScan(null);
      return;
    }
    const t = window.setTimeout(() => {
      const closed = candles.slice(0, -1);
      // 传入实时盘口 / 大单方向：bookImbalance、tapeBias、thrustVolume 不再恒为 null
      const lf = liveFlowRef.current;
      const live = liveFlowOf(closed, lf.bookImb, lf.bigBias);
      const r = runScan(closed, engineBar, live, bars.symbol, exitPlan, flowRef.current);
      const pool = (cfg.entryMode === 'touch' ? r.touch : r.confirm).sort((a, b) => b.ts - a.ts);
      setScan({ rows: pool, levels: computeLevels(closed), n: closed.length, ctx: r.ctx, coverage: r.ctx.flowCoverage });
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const threshold = cfg.threshold;
  const latest = useMemo(() => (scan ? scan.rows.find(c => c.idx >= scan.n - 1 - LATEST_BARS) ?? null : null), [scan]);
  const old = useMemo(
    () => (scan?.rows ?? []).filter(c => c.id !== latest?.id && (!onlyPass || c.proba >= threshold)),
    [scan, latest, onlyPass, threshold],
  );
  const stat = useMemo(() => summarize(scan?.rows ?? [], threshold), [scan, threshold]);
  const base = useMemo(() => summarize(scan?.rows ?? [], 0), [scan]);
  const sweep = useMemo(() => thresholdSweep(scan?.rows ?? [], 0.42, 0.82, 11), [scan]);

  useEffect(() => {
    if (!latest) return;
    setGlow(true);
    const t = window.setTimeout(() => setGlow(false), 1100);
    return () => window.clearTimeout(t);
  }, [latest?.id]);

  useEffect(() => {
    const chart = getChart();
    if (!chart) return;
    if (!showLevels || !scan) {
      clearLevels(chart);
      return;
    }
    paintLevels(chart, scan.levels);
  }, [scan, showLevels, getChart]);

  useEffect(() => {
    const chart = getChart();
    setFocus(null);
    setDetail(false);
    if (chart) {
      clearAnnotations(chart);
      clearRead(chart);
    }
  }, [bars.symbol, bars.timeframe, getChart]);

  useEffect(() => {
    if (!gear) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.tp-pop, .tp-gear')) setGear(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [gear]);

  const onReadAnnotate = useCallback(
    (ann: ReadAnnotation | null) => {
      const chart = getChart();
      if (chart) paintRead(chart, ann);
    },
    [getChart],
  );
  const flowInfo = useMemo(
    () => ({ coverage: scan?.coverage ?? 0, covered: Math.round((scan?.coverage ?? 0) * (scan?.n ?? 0)), syncing: flow.syncing, unsupported: flow.unsupported, live: !!flow.snapshot?.tape.connected }),
    [scan, flow.syncing, flow.unsupported, flow.snapshot],
  );

  const pick = useCallback(
    (c: Candidate) => {
      const chart = getChart();
      if (!chart) return;
      hoverSignal(chart, null);
      if (focus === c.id) {
        setFocus(null);
        clearAnnotations(chart);
        return;
      }
      setFocus(c.id);
      annotateCandidate(chart, c, { barMs, maxHold: engineBar === '15m' ? 48 : 96 });
    },
    [getChart, focus, barMs, engineBar],
  );

  const hover = useCallback(
    (c: Candidate | null) => {
      const chart = getChart();
      if (chart) hoverSignal(chart, c);
    },
    [getChart],
  );

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const items = [latest, ...old].filter((c): c is Candidate => !!c);
    if (!items.length) return;
    e.preventDefault();
    const i = Math.max(0, items.findIndex(c => c.id === focus));
    if (e.key === 'Enter') pick(items[i] ?? items[0]);
    else pick(items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]);
  };

  const baseSym = bars.symbol.replace('-USDT-SWAP', '') || '—';

  return (
    <div className="tp-root">
      <div className="tp-head">
        <div className="tp-sym">
          <span className="tp-sym-main">{baseSym}</span>
          <span className="tp-sym-sub">{bars.timeframe ? tfLabel(bars.timeframe) : '—'} · OKX</span>
        </div>
        <div className="tp-head-right">
          <Price />
          <button className="tp-gear" aria-label="设置" aria-expanded={gear} onClick={() => setGear(v => !v)}>
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      {gear && (
        <div className="tp-pop" role="dialog" aria-label="设置">
          <label className="tp-pop-row">
            <span>概率门槛</span>
            <b>{Math.round(threshold * 100)}%</b>
          </label>
          <input
            type="range"
            className="ce-range"
            min={LIMITS.min}
            max={LIMITS.max}
            step={LIMITS.step}
            value={threshold}
            onChange={e => setConfig({ threshold: clampThreshold(Number(e.target.value)) })}
            aria-label="概率门槛"
          />
          <label className="tp-pop-row">
            <span>出场</span>
            <select value={exitPlan} onChange={e => setExitPlan(e.target.value as ExitPlan)} aria-label="出场方案">
              {EXIT_PLANS.map(p => (
                <option key={p.id} value={p.id} title={p.hint}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button className={`tp-chip ${showLevels ? 'on' : ''}`} onClick={() => setShowLevels(v => !v)}>
            {showLevels ? <Eye size={11} /> : <EyeOff size={11} />} 关键位
          </button>
          <button className="tp-chip accent" onClick={onOpenEngine}>
            <ShieldCheck size={11} /> 引擎详情
          </button>
        </div>
      )}

      <div className="tp-sec">
        <div className="tp-sec-h">
          最新信号
          <button className="tp-help" title="最近 12 根 K 线内、价格第二次回到历史顶/底且订单流达到门槛时给出。概率是模型倾向，不是历史胜率。">?</button>
        </div>
        {!scan ? (
          <div className="tp-skel" aria-busy="true">
            <i /><i /><i />
          </div>
        ) : latest ? (
          <LatestCard c={latest} threshold={threshold} on={focus === latest.id} glow={glow} open={detail} onToggle={() => setDetail(v => !v)} onPick={() => pick(latest)} />
        ) : (
          <div className="tp-quiet">暂无新信号</div>
        )}
        <FlowRead ctx={scan?.ctx ?? null} rows={scan?.rows ?? []} closedTs={bars.closedTs} threshold={threshold} barMs={barMs} flow={flowInfo} onAnnotate={onReadAnnotate} />
      </div>

      <div className="tp-sec tp-sec-grow">
        <div className="tp-sec-h">
          旧信号
          <span className="tp-count">{old.length}</span>
          <button className={`tp-filter ${onlyPass ? 'on' : ''}`} onClick={() => setOnlyPass(v => !v)} aria-pressed={onlyPass}>
            {onlyPass ? '通过门槛' : '全部'}
          </button>
        </div>
        <div className="tp-list" ref={listRef} tabIndex={0} onKeyDown={onListKey} aria-label="旧信号，方向键切换，回车查看">
          {scan && old.length === 0 ? (
            <div className="tp-quiet">{onlyPass ? '没有通过门槛的旧信号' : '没有更早的信号'}</div>
          ) : (
            old.slice(0, 80).map(c => {
              const pass = c.proba >= threshold;
              const res = resultOf(c, pass);
              return (
                <button
                  key={c.id}
                  className={`tp-item ${focus === c.id ? 'on' : ''} ${pass ? '' : 'dim'}`}
                  onClick={() => pick(c)}
                  onMouseEnter={() => hover(c)}
                  onMouseLeave={() => hover(null)}
                >
                  <i className={c.side === 'long' ? 'up' : 'dn'} />
                  <b>{shapeOf(c)}</b>
                  <span>{hm(c.ts)}</span>
                  <span className="tp-item-p" style={{ color: pass ? gradeMeta(c.grade).color : MUT }}>{Math.round(c.proba * 100)}%</span>
                  <em style={{ color: res.tone }}>{res.text}</em>
                </button>
              );
            })
          )}
        </div>
      </div>

      <button className="tp-foot" onClick={() => setStatsOpen(v => !v)} aria-expanded={statsOpen}>
        <span>门槛 {Math.round(threshold * 100)}% · {stat.traded} 笔 · 胜率 {fmt(stat.winRate, 0)}% · 期望 {signed(stat.avgR)}R</span>
        <ChevronDown size={13} className={statsOpen ? 'flip' : ''} />
      </button>
      {statsOpen && (
        <div className="tp-stats">
          <div className="tp-kpis">
            <div className="tp-kpi"><span>胜率</span><b style={{ color: LONG }}>{fmt(stat.winRate, 1)}%</b><i>{stat.traded}/{base.traded}</i></div>
            <div className="tp-kpi"><span>期望</span><b style={{ color: stat.avgR >= 0 ? LONG : SHORT }}>{signed(stat.avgR)}</b><i>无门槛 {signed(base.avgR)}</i></div>
            <div className="tp-kpi"><span>净收益</span><b style={{ color: stat.totalR >= 0 ? LONG : SHORT }}>{signed(stat.totalR, 1)}R</b><i>回撤 {fmt(stat.maxDD, 1)}R</i></div>
          </div>
          <div className="tp-sweep" title="不同门槛下的期望值，点击切换">
            {sweep.map(s => {
              const h = Math.min(100, Math.abs(s.avgR) * 120 + 8);
              const cur = Math.abs(s.thr - threshold) < 0.021;
              return (
                <div key={s.thr} className={`tp-sweep-col ${cur ? 'cur' : ''}`} onClick={() => setConfig({ threshold: clampThreshold(s.thr) })}>
                  <div className="tp-sweep-bar" style={{ height: `${h}%`, background: s.avgR >= 0 ? LONG : SHORT, opacity: s.traded ? 0.85 : 0.2 }} />
                  <span>{Math.round(s.thr * 100)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LatestCard({
  c, threshold, on, glow, open, onToggle, onPick,
}: {
  c: Candidate; threshold: number; on: boolean; glow: boolean; open: boolean; onToggle: () => void; onPick: () => void;
}) {
  const pass = c.proba >= threshold;
  const g = gradeMeta(c.grade);
  const res = resultOf(c, pass);
  return (
    <div className={`tp-card ${pass ? 'ok' : 'weak'} ${on ? 'on' : ''} ${glow ? 'glow' : ''}`}>
      <div className="tp-card-top">
        <i className={c.side === 'long' ? 'up' : 'dn'} />
        <b>{shapeOf(c)} · {c.side === 'long' ? '做多' : '做空'}</b>
        <span className="tp-card-p" style={{ color: g.color }}>{Math.round(c.proba * 100)}% {c.grade}</span>
      </div>
      <div className="tp-card-sub">{hm(c.ts)} · {res.text}{pass ? '' : ' · 未过门槛'}</div>
      <div className="tp-card-px">
        <span>入场 <b>{c.entry}</b></span>
        <span>止损 <b>{c.stop}</b></span>
        <span>目标 <b>{c.tp}</b></span>
      </div>
      {open && <div className="tp-card-note">{c.headline || c.note}</div>}
      <div className="tp-card-acts">
        <button onClick={onPick}><Crosshair size={12} /> {on ? '取消' : '在图上查看'}</button>
        <button onClick={onToggle}>{open ? '收起' : '详情'}</button>
      </div>
    </div>
  );
}
