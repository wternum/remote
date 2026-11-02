import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { Activity, ArrowDownRight, ArrowUpRight, Crosshair, Eye, EyeOff, ShieldCheck, SlidersHorizontal, Target, Zap } from 'lucide-react';
import { runScan, EXIT_PLANS, type Candidate, type ExitPlan } from '@/quant/scan';
import { computeLevels } from '@/lib/engine';
import { summarize, thresholdSweep } from '@/quant/stats';
import { gradeMeta } from '@/quant/model';
import { clampThreshold, getConfig, LIMITS, setConfig, subscribeConfig, type EngineConfig } from '@/quant/config';
import { useChartBars } from './useChartBars';
import { useFlow } from './useFlow';
import FlowRead from './FlowRead';
import { annotateCandidate, clearAnnotations, clearLevels, clearRead, paintLevels, paintRead, type ReadAnnotation } from './annotate';
import { tfMs } from './okxProvider';
import type { Ctx } from '@/quant/scan';

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const CYAN = '#37c8dd';
const AMBER = '#f0b90b';
const MUT = '#8c96ab';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
const hhmm = (ts: number) => {
  const t = new Date(ts);
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};
const tfLabel = (tf: string) => (tf === 'D' ? '1D' : tf === 'W' ? '1W' : Number(tf) >= 60 ? `${Number(tf) / 60}H` : `${tf}m`);

type Tab = 'signals' | 'engine';

export default function TradePanel({ getChart, onOpenEngine }: { getChart: () => Vela | null; onOpenEngine: () => void }) {
  const bars = useChartBars(getChart);
  const [cfg, setCfg] = useState<EngineConfig>(() => getConfig());
  const [exitPlan, setExitPlan] = useState<ExitPlan>('r15');
  const [tab, setTab] = useState<Tab>('signals');
  const [focus, setFocus] = useState<string | null>(null);
  const [showLevels, setShowLevels] = useState(true);
  const [onlyPass, setOnlyPass] = useState(false);
  const lastToastRef = useRef('');

  useEffect(() => {
    const off = subscribeConfig(setCfg);
    return () => {
      off();
    };
  }, []);

  const barMs = tfMs(bars.timeframe || '5');
  const engineBar = Number(bars.timeframe) >= 15 ? '15m' : '5m';
  // 真实订单流（OKX 主动买卖成交额 / 持仓量）：随市场与收盘 K 线同步
  const flow = useFlow(bars.symbol, bars.timeframe, bars.closedTs, bars.candles[0]?.ts ?? 0);

  // 扫描只在「市场 / 已收盘 K 线变化 / 出场方案」变化时重算，
  // 而不是每个实时 tick（6000 根全量扫描会卡顿）。
  const scanKey = `${bars.symbol}|${bars.timeframe}|${bars.closedTs}|${exitPlan}|${cfg.entryMode}|flow${flow.version}`;
  const scanKeyRef = useRef('');
  const candlesRef = useRef(bars.candles);
  candlesRef.current = bars.candles;
  const [scan, setScan] = useState<{ rows: Candidate[]; levels: ReturnType<typeof computeLevels>; n: number; ctx: Ctx; coverage: number } | null>(null);
  const flowRef = useRef(flow.snapshot);
  flowRef.current = flow.snapshot;
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (scanKey === scanKeyRef.current) return;
    scanKeyRef.current = scanKey;
    const candles = candlesRef.current;
    if (candles.length < 60) {
      setScan(null);
      return;
    }
    setScanning(true);
    // 让出主线程一帧，避免与图表渲染争抢
    const t = window.setTimeout(() => {
      const closed = candles.slice(0, -1);
      const r = runScan(closed, engineBar, undefined, bars.symbol, exitPlan, flowRef.current);
      const pool = (cfg.entryMode === 'touch' ? r.touch : r.confirm).sort((a, b) => b.ts - a.ts);
      setScan({ rows: pool, levels: computeLevels(closed), n: closed.length, ctx: r.ctx, coverage: r.ctx.flowCoverage });
      setScanning(false);
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const rows = useMemo(() => (scan?.rows ?? []).filter(c => !onlyPass || c.proba >= cfg.threshold), [scan, onlyPass, cfg.threshold]);
  void scanning;
  const stat = useMemo(() => summarize(scan?.rows ?? [], cfg.threshold), [scan, cfg.threshold]);
  const base = useMemo(() => summarize(scan?.rows ?? [], 0), [scan]);
  const sweep = useMemo(() => thresholdSweep(scan?.rows ?? [], 0.42, 0.82, 11), [scan]);

  // 最新一笔是否刚在刚收盘 K 线出现（实时提醒）
  const live = useMemo(() => {
    const r = scan?.rows[0];
    if (!r || !bars.closedTs) return null;
    return r.ts === bars.closedTs ? r : null;
  }, [scan, bars.closedTs]);

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
    // 市场切换时清理聚焦标注
    const chart = getChart();
    setFocus(null);
    if (chart) {
      clearAnnotations(chart);
      clearRead(chart);
    }
  }, [bars.symbol, bars.timeframe, getChart]);

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

  useEffect(() => {
    if (!live) return;
    const key = `${bars.symbol}|${live.id}`;
    if (lastToastRef.current === key) return;
    lastToastRef.current = key;
  }, [live, bars.symbol]);

  const pick = useCallback(
    (c: Candidate) => {
      const chart = getChart();
      if (!chart) return;
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

  const threshold = cfg.threshold;

  return (
    <div className="tp-root">
      {/* 市场摘要 */}
      <div className="tp-head">
        <div className="tp-sym">
          <span className="tp-sym-main">{bars.symbol.replace('-USDT-SWAP', '') || '—'}</span>
          <span className="tp-sym-sub">USDT 永续 · {bars.timeframe ? tfLabel(bars.timeframe) : '—'} · OKX</span>
        </div>
        <div className="tp-px" style={{ color: live ? (live.side === 'long' ? LONG : SHORT) : '#e7ecf5' }}>
          {bars.lastPx != null ? bars.lastPx.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}
        </div>
      </div>

      {/* 实时结论 */}
      <div className={`tp-live ${live ? (live.proba >= threshold ? 'ok' : 'weak') : ''}`}>
        {live ? (
          <>
            <div className="tp-live-ring" style={{ ['--p' as string]: `${Math.round(live.proba * 100)}%`, ['--c' as string]: gradeMeta(live.grade).color }}>
              <b>{Math.round(live.proba * 100)}</b>
              <i>%</i>
            </div>
            <div className="tp-live-body">
              <div className="tp-live-title">
                <span className={`tp-side ${live.side}`}>{live.side === 'long' ? '做多 BUY' : '做空 SELL'}</span>
                {live.pattern.startsWith('db') ? 'W 双底二次测试' : 'M 双顶二次测试'}
              </div>
              <div className="tp-live-sub">
                {live.proba >= threshold ? `通过 ${Math.round(threshold * 100)}% 门槛 · ${gradeMeta(live.grade).label}` : `低于 ${Math.round(threshold * 100)}% 门槛 · 不入场`}
              </div>
              <div className="tp-live-prices">
                <span>E <b style={{ color: AMBER }}>{live.entry}</b></span>
                <span>SL <b style={{ color: SHORT }}>{live.stop}</b></span>
                <span>TP <b style={{ color: LONG }}>{live.tp}</b></span>
                <span>R:R <b>{fmt(live.rr, 1)}</b></span>
              </div>
            </div>
            <button className="tp-mini-btn" title="在图上标注" onClick={() => pick(live)}>
              <Crosshair size={13} />
            </button>
          </>
        ) : (
          <>
            <Activity size={15} className="tp-dim" />
            <div className="tp-live-body">
              <div className="tp-live-title tp-dim">最新收盘 K 线上没有二次测试形态</div>
              <div className="tp-live-sub">引擎只在价格第二次回到历史顶/底关键位、且订单流与结构证据达标时发出信号</div>
            </div>
          </>
        )}
      </div>

      {/* 订单流判读：二次测试概率 / 诱多诱空 / 突破回调跟随 */}
      <FlowRead ctx={scan?.ctx ?? null} rows={scan?.rows ?? []} closedTs={bars.closedTs} threshold={threshold} lastPx={bars.lastPx} barMs={barMs} flow={flowInfo} onAnnotate={onReadAnnotate} />

      {/* 门槛 */}
      <div className="tp-threshold">
        <SlidersHorizontal size={12} />
        <span className="tp-th-label">概率门槛</span>
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
        <b className="tp-th-val">{Math.round(threshold * 100)}%</b>
      </div>

      {/* 出场方案 + 显示开关 */}
      <div className="tp-row">
        <div className="tp-chips">
          {EXIT_PLANS.map(p => (
            <button key={p.id} className={`tp-chip ${exitPlan === p.id ? 'on' : ''}`} title={p.hint} onClick={() => setExitPlan(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="tp-row tp-row-tools">
        <button className={`tp-chip ${showLevels ? 'on' : ''}`} onClick={() => setShowLevels(v => !v)} title="在图上显示当前仍有效的历史顶/底关键位">
          {showLevels ? <Eye size={11} /> : <EyeOff size={11} />} 关键位
        </button>
        <button className={`tp-chip ${onlyPass ? 'on' : ''}`} onClick={() => setOnlyPass(v => !v)}>
          <Target size={11} /> 仅看通过门槛
        </button>
        <button className="tp-chip accent" onClick={onOpenEngine} title="打开完整的入场确认引擎（校准 / 样本外 / 寻优）">
          <ShieldCheck size={11} /> 引擎详情
        </button>
      </div>

      {/* KPI */}
      <div className="tp-kpis">
        <div className="tp-kpi">
          <span>门槛后胜率</span>
          <b style={{ color: LONG }}>{fmt(stat.winRate, 1)}%</b>
          <i>{stat.traded}/{base.traded} 笔</i>
        </div>
        <div className="tp-kpi">
          <span>期望 R/笔</span>
          <b style={{ color: stat.avgR >= 0 ? LONG : SHORT }}>{signed(stat.avgR)}</b>
          <i>
            无门槛 {signed(base.avgR)}
          </i>
        </div>
        <div className="tp-kpi">
          <span>净收益 R</span>
          <b style={{ color: stat.totalR >= 0 ? LONG : SHORT }}>{signed(stat.totalR, 1)}</b>
          <i>回撤 {fmt(stat.maxDD, 1)}R</i>
        </div>
      </div>

      {/* 门槛扫描迷你图 */}
      <div className="tp-sweep" title="不同门槛下的期望值（绿=正，红=负）与成交笔数">
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

      {/* Tabs */}
      <div className="tp-tabs">
        <button className={tab === 'signals' ? 'on' : ''} onClick={() => setTab('signals')}>
          <Zap size={11} /> 信号 {rows.length}
        </button>
        <button className={tab === 'engine' ? 'on' : ''} onClick={() => setTab('engine')}>
          <ShieldCheck size={11} /> 说明
        </button>
      </div>

      {tab === 'signals' ? (
        <div className="tp-list">
          {rows.length === 0 ? (
            <div className="tp-empty">
              {scan ? '该范围内没有可结算的双顶/双底二次测试' : '等待图表加载足够的 K 线…'}
              <small>可切换币种/周期，或放宽门槛</small>
            </div>
          ) : (
            rows.slice(0, 80).map(c => {
              const pass = c.proba >= threshold;
              const g = gradeMeta(c.grade);
              const r = c.outcome?.filled ? c.outcome.r : null;
              return (
                <button key={c.id} className={`tp-sig ${focus === c.id ? 'focus' : ''} ${pass ? '' : 'skip'}`} onClick={() => pick(c)} style={{ borderLeftColor: c.side === 'long' ? LONG : SHORT }}>
                  <div className="tp-sig-top">
                    <span className={`tp-side ${c.side}`}>{c.side === 'long' ? '多' : '空'}</span>
                    <span className="tp-sig-name">{c.pattern.startsWith('db') ? 'W 双底' : 'M 双顶'}</span>
                    <span className="tp-sig-time">{hhmm(c.ts)}</span>
                    <span className="tp-sig-p" style={{ color: pass ? g.color : MUT }}>
                      {Math.round(c.proba * 100)}% {c.grade}
                    </span>
                  </div>
                  <div className="tp-sig-bar">
                    <i style={{ width: `${c.proba * 100}%`, background: pass ? g.color : '#3a4356' }} />
                    <em style={{ left: `${threshold * 100}%` }} />
                  </div>
                  <div className="tp-sig-bot">
                    <span>E {c.entry}</span>
                    <span>SL {c.stop}</span>
                    <span>TP {c.tp}</span>
                    <span className="tp-sig-r" style={{ color: r == null ? MUT : r > 0 ? LONG : SHORT }}>
                      {r == null ? '进行中' : pass ? `${signed(r)}R` : '门槛外'}
                      {r != null && (r > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />)}
                    </span>
                  </div>
                  {c.tags.length > 0 && (
                    <div className="tp-sig-tags">
                      {c.tags.slice(0, 4).map((t, i) => (
                        <span key={`${t}${i}`} className={t.startsWith('诱') ? 'trap' : undefined}>{t}</span>
                      ))}
                      {c.flowSource === 'taker' && <span className="real">真实订单流</span>}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div className="tp-list tp-doc">
          <p>
            <b style={{ color: CYAN }}>怎么判定入场</b>
            <br />
            引擎识别历史顶部/底部关键位，等价格<b>第二次</b>回到该区域；只有当订单流（二次测试缩量、主动成交背离、CVD 极值背离、扫损陷阱、关键位吸收、拒绝影线、确认K主动方向、持仓被套）与结构（关键位完整度、形态高度、跨度、趋势转平、推进减速）证据合成的概率 ≥ 门槛，才给出信号。
          </p>
          <p>
            <b style={{ color: CYAN }}>订单流判读卡</b>
            <br />
            主动买卖差来自 OKX 公共接口的每根 K 线真实 taker 买入/卖出成交额（约覆盖最近 4–5 天），更早的 K 线退回 K 线形态近似。双顶给出<b>下跌概率</b>、双底给出<b>上涨概率</b>；「诱多/诱空」= 刺穿前高/前低后收回，且刺穿期间主动成交站在反转一侧或追单被吸收；「突破回调」判断突破 K 的量能与主动方向、回调是否缩量、回踩关键位是否守住，并给出本图历史上「突破即追」与「等回踩」的兑现率。
          </p>
          <p>
            <b style={{ color: CYAN }}>图上标注</b>
            <br />
            点击任意一笔：虚线射线 = 关键位；点线 = 颈线；头寸框 = 入场/止损/目标（框头显示 R:R）；箭头 = 信号 K 与概率等级。再点一次取消。
          </p>
          <p>
            <b style={{ color: CYAN }}>出场方案</b>
            <br />
            原项目目标看颈线，超时平仓占比高。默认改用「固定 1.5R」；可切换对照，统计即时重算。
          </p>
          <p>
            <b style={{ color: AMBER }}>统计口径</b>
            <br />
            本面板统计仅基于当前图表加载的 K 线（{scan?.n ?? 0} 根）；样本外检验、概率校准与配置寻优请打开「引擎详情」。
          </p>
        </div>
      )}
    </div>
  );
}
