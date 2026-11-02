import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Crosshair,
  Gauge,
  Layers3,
  ListFilter,
  LogOut,
  FlaskConical,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { clampThreshold, LIMITS } from '@/quant/config';
import { contributionOf, gradeMeta, useEngine, type Row } from './useEngine';
import type { FactorMeta } from './useEngine';
import type { FactorAttribution } from '@/quant/stats';

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const CYAN = '#37c8dd';
const AMBER = '#f0b90b';
const MUT = '#8c96ab';
const LINE = '#1d2534';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: number, d = 0) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
const hhmm = (ts: number) => {
  const t = new Date(ts);
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

/** 持仓上限（K 线根数）换算成小时，用于说明形态是否已过期 */
const cutoffLabel = (bars: number, barMs = 300_000) => `${((bars * barMs) / 3_600_000).toFixed(1)}h 窗口`;

const SYMBOLS = [
  { id: 'BTC-USDT-SWAP', base: 'BTC' },
  { id: 'ETH-USDT-SWAP', base: 'ETH' },
  { id: 'SOL-USDT-SWAP', base: 'SOL' },
];

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, style: { animationDelay: '60ms', ...({} as object) }, shown: seen } as const;
}

function Section({
  title,
  sub,
  icon,
  right,
  children,
}: {
  title: string;
  sub?: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`panel mb-2 p-3 transition-all duration-500 ${shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
    >
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[#37c8dd]">{icon}</span>
          <div className="min-w-0">
            <h3 className="panel-title !text-[11px] !tracking-[0.16em] text-[#e7ecf5]">{title}</h3>
            {sub && <p className="mt-0.5 truncate text-[10px] leading-relaxed text-[#5b6579]">{sub}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, tone = MUT }: { label: string; value: string; sub?: ReactNode; tone?: string }) {
  return (
    <div className="kpi !py-2">
      <div className="k text-[9px]">{label}</div>
      <div className="mono v !text-[18px]" style={{ color: tone }}>
        {value}
      </div>
      {sub && <div className="mono mt-0.5 text-[9px] text-[#5b6579]">{sub}</div>}
    </div>
  );
}

function Delta({ v, suffix = '', goodWhenPositive = true, digits = 1 }: { v: number; suffix?: string; goodWhenPositive?: boolean; digits?: number }) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return <span className="mono text-[9px] text-[#5b6579]">±0{suffix}</span>;
  const good = v > 0 === goodWhenPositive;
  const color = good ? LONG : SHORT;
  return (
    <span className="mono inline-flex items-center gap-0.5 text-[9px] font-semibold" style={{ color }}>
      {v > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {Math.abs(v).toFixed(digits)}
      {suffix}
    </span>
  );
}

function EvidenceBar({ v, weight, showValue = true }: { v: number | null; weight: number; showValue?: boolean }) {
  if (v == null) {
    return (
      <div className="flex h-[7px] w-full items-center justify-center rounded bg-[#0d1119]">
        <span className="text-[8px] tracking-wider text-[#3a4356]">NO LIVE DATA</span>
      </div>
    );
  }
  const width = Math.min(100, Math.abs(v) * 100);
  const good = v >= 0;
  const contrib = contributionOf(v, weight);
  return (
    <div className="ce-evidence relative h-[7px] w-full overflow-hidden rounded bg-[#0d1119]">
      <div className="absolute left-1/2 top-0 h-full w-px bg-[#273245]" />
      <span
        className="absolute top-0 block h-full rounded-sm"
        style={{
          width: `${width / 2}%`,
          left: good ? '50%' : undefined,
          right: good ? undefined : '50%',
          background: good ? LONG : SHORT,
          opacity: 0.55 + Math.min(0.45, Math.abs(v) * 0.45),
        }}
      />
      {showValue && (
        <span className="mono absolute -top-px right-1 text-[8px] leading-[7px] text-[#5b6579]">{signed(contrib, 2)}</span>
      )}
    </div>
  );
}

function Ring({ p, size = 86 }: { p: number; size?: number }) {
  const meta = gradeMeta(p >= 0.66 ? 'A' : p >= 0.58 ? 'B' : p >= 0.5 ? 'C' : 'D');
  const r = (size - 9) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="conf-ring relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1d2534" strokeWidth={5} />
        <circle
          className="fg"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={meta.color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0.02, p))}
          style={{ filter: `drop-shadow(0 0 5px ${meta.color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="mono text-[19px] font-bold leading-none" style={{ color: meta.color }}>
          {Math.round(p * 100)}
        </span>
        <span className="text-[8px] tracking-[0.16em] text-[#5b6579]">概率 %</span>
      </div>
    </div>
  );
}

function tooltip(rows: { name: string; value: string | number; color?: string }[], title?: string) {
  return (
    <div className="rounded-md border border-[#273245] bg-[#0d1119]/95 px-2.5 py-1.5 shadow-2xl backdrop-blur">
      {title && <div className="mono mb-1 text-[9px] text-[#5b6579]">{title}</div>}
      {rows.map(r => (
        <div key={r.name} className="mono flex items-center gap-2 text-[10px]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.color ?? MUT }} />
          <span className="text-[#8c96ab]">{r.name}</span>
          <span className="ml-auto font-semibold text-[#e7ecf5]">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const axis = { stroke: '#273245', tick: { fill: MUT, fontSize: 9 }, tickLine: false, axisLine: { stroke: LINE } } as const;

function ChartTip({ active, payload, label, unit }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string | number; unit?: string }) {
  if (!active || !payload?.length) return null;
  return tooltip(
    payload.map(p => ({ name: p.name, value: `${typeof p.value === 'number' ? p.value.toFixed(unit === '%' ? 0 : 2) : p.value}${unit ?? ''}`, color: p.color })),
    typeof label === 'number' ? undefined : label,
  );
}

function FactorRows({ factors, row, attribution }: { factors: FactorMeta[]; row: Row | null; attribution: FactorAttribution[] | undefined }) {
  const list = factors.map((f, i) => {
    const a = attribution?.find(x => x.key === f.key);
    const e = row?.evidence[i] ?? null;
    return { f, e, a };
  });
  list.sort((x, y) => (y.a?.edge ?? 0) - (x.a?.edge ?? 0));
  return (
    <div className="flex flex-col gap-1.5">
      {list.map(({ f, e, a }) => (
        <div key={f.key} className="grid grid-cols-[104px_1fr_54px] items-center gap-2" title={f.hint}>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="truncate text-[11px] font-semibold text-[#e7ecf5]">{f.label}</span>
              {f.liveOnly && <span className="rounded bg-[#37c8dd]/12 px-1 text-[8px] text-[#37c8dd]">实时</span>}
            </div>
            <div className="mono text-[8px] tracking-wider text-[#3a4356]">
              {f.short} · W{f.weight.toFixed(2)} · {f.group}
            </div>
          </div>
          <EvidenceBar v={e} weight={f.weight} />
          <div className="text-right">
            <div className="mono text-[9px]" style={{ color: (a?.edge ?? 0) > 0.05 ? LONG : (a?.edge ?? 0) < -0.05 ? SHORT : MUT }}>
              区分 {signed(a?.edge ?? 0, 2)}
            </div>
            <div className="mono text-[8px] text-[#3a4356]">覆盖 {pct((a?.coverage ?? 0) * 100)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ConfirmEnginePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const eng = useEngine(open);
  const { cfg, payload, rows, stats, current: setup, factors, loading, error } = eng;
  const current = setup.row;
  const [openRow, setOpenRow] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const list = useMemo(() => [...rows].sort((a, b) => b.ts - a.ts).slice(0, 60), [rows]);
  const chartCalib = useMemo(
    () => (stats?.calib ?? []).map(b => ({ ...b, idealPct: b.ideal * 100, win: b.winRate })),
    [stats],
  );
  const sweepData = useMemo(() => {
    const s = stats?.sweep ?? [];
    const idx = s.reduce((best, p, i) => (Math.abs(p.thr - cfg.threshold) < Math.abs(s[best].thr - cfg.threshold) ? i : best), 0);
    return { data: s.map(p => ({ ...p, label: `${Math.round(p.thr * 100)}%` })), current: s[idx]?.label ?? '' };
  }, [stats, cfg.threshold]);
  const equityData = useMemo(() => {
    const g = stats?.equityGated ?? [];
    const r = stats?.equityRaw ?? [];
    const n = Math.max(g.length, r.length);
    return Array.from({ length: n }, (_, i) => ({ i, gated: g[i]?.cumR ?? null, raw: r[i]?.cumR ?? null }));
  }, [stats]);

  if (!open) return null;
  const now = stats?.now;
  const base = stats?.all;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="ce-backdrop absolute inset-0 bg-[#05070b]/70 backdrop-blur-[2px]" onClick={onClose} />
      <aside
        className="ce-panel relative flex h-full w-full max-w-[680px] flex-col border-l border-[#1d2534] bg-[#0a0d13] shadow-[-24px_0_60px_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-label="入场确认引擎"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[#1d2534] bg-[#0d1119]/90 px-3 py-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#37c8dd]/40 bg-gradient-to-br from-[#37c8dd]/20 to-[#2ebd85]/10">
            <ShieldCheck size={15} className="text-[#37c8dd]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-bold tracking-wide text-[#e7ecf5]">入场确认引擎</h2>
              <span className="mono rounded bg-[#141a27] px-1.5 py-px text-[9px] text-[#8c96ab]">
                {payload?.symbols?.length ?? 1} 标的 · {payload?.timeframes?.length ?? 1} 周期 · {payload?.bars ?? 0} 根 ·{' '}
                {payload?.live ? 'OKX 实时' : 'SIM 仿真'}
              </span>
            </div>
            <p className="truncate text-[10px] text-[#5b6579]">双顶 / 双底二次测试 → 14 项订单流与结构证据 → 概率门槛</p>
          </div>
          <div className="flex items-center gap-1">
            {[{ id: 'ALL', base: '全部' }, ...SYMBOLS].map(s => (
              <button
                key={s.id}
                onClick={() => eng.setMarket({ ...eng.market, symbol: s.id })}
                className={`mono rounded px-1.5 py-0.5 text-[10px] font-bold transition-all ${
                  eng.market.symbol === s.id ? 'bg-[#182335] text-[#37c8dd]' : 'text-[#5b6579] hover:text-[#e7ecf5]'
                }`}
                title={s.id === 'ALL' ? 'BTC + ETH + SOL 合并样本（更多笔数）' : undefined}
              >
                {s.base}
              </button>
            ))}
            {['5m', '15m', 'ALL'].map(b => (
              <button
                key={b}
                onClick={() => eng.setMarket({ ...eng.market, bar: b })}
                className={`mono rounded px-1.5 py-0.5 text-[9px] transition-all ${
                  eng.market.bar === b ? 'bg-[#1a2334] text-[#e7ecf5]' : 'text-[#5b6579] hover:text-[#8c96ab]'
                }`}
                title={b === 'ALL' ? '5m + 15m 合并样本' : undefined}
              >
                {b === 'ALL' ? '双周期' : b}
              </button>
            ))}
            <button
              onClick={eng.followPage}
              className="rounded-md border border-[#1d2534] bg-[#141a27] p-1.5 text-[#8c96ab] transition-colors hover:text-[#37c8dd]"
              title="跟随页面当前币种与周期"
            >
              <Crosshair size={12} />
            </button>
            <button
              onClick={() => void eng.reload(true)}
              className="rounded-md border border-[#1d2534] bg-[#141a27] p-1.5 text-[#8c96ab] transition-colors hover:text-[#e7ecf5]"
              title="重新扫描（绕过缓存）"
            >
              <RotateCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-[#1d2534] bg-[#141a27] p-1.5 text-[#8c96ab] transition-colors hover:text-[#f6465d]"
              title="关闭 (Esc)"
            >
              <X size={12} />
            </button>
          </div>
        </div>

        {/* 门槛控制条 */}
        <div className="shrink-0 border-b border-[#1d2534] bg-[#0d1119] px-3 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[#37c8dd]">
              <SlidersHorizontal size={13} />
              <span className="text-[10px] font-semibold tracking-wider">概率门槛</span>
            </div>
            <div className="mono text-[22px] font-bold leading-none text-[#e7ecf5]">
              {Math.round(cfg.threshold * 100)}
              <span className="text-[11px] text-[#5b6579]">%</span>
            </div>
            <input
              type="range"
              className="ce-range min-w-0 flex-1"
              min={LIMITS.min}
              max={LIMITS.max}
              step={LIMITS.step}
              value={cfg.threshold}
              onChange={e => eng.setThreshold(clampThreshold(Number(e.target.value)))}
              aria-label="入场概率门槛"
            />
            {(() => {
              const best = (stats?.sweep ?? [])
                .filter(s => s.traded >= 15)
                .reduce<{ thr: number; avgR: number } | null>((b, s) => (!b || s.avgR > b.avgR ? { thr: s.thr, avgR: s.avgR } : b), null);
              if (!best) return null;
              const applied = Math.abs(best.thr - cfg.threshold) < 0.011;
              return (
                <button
                  onClick={() => eng.setThreshold(best.thr)}
                  disabled={applied}
                  className="mono rounded-md border px-2 py-1 text-[9px] transition-all"
                  style={{
                    borderColor: applied ? LINE : 'rgba(240,185,11,.45)',
                    background: applied ? '#0d1119' : 'rgba(240,185,11,.12)',
                    color: applied ? '#5b6579' : AMBER,
                  }}
                  title="取期望值最高、且样本量足够（≥15 笔）的门槛。注意这是样本内最优，需实盘继续验证"
                >
                  {applied ? '已在样本内最优点' : `跳到样本内最优 ${Math.round(best.thr * 100)}%`}
                </button>
              );
            })()}
            <div className="flex overflow-hidden rounded-md border border-[#1d2534]">
              {(
                [
                  ['confirm', '等确认K收盘'],
                  ['touch', '触价即成交'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => eng.setMode(k)}
                  className={`px-2 py-1 text-[10px] font-semibold transition-all ${
                    cfg.entryMode === k ? 'bg-[#37c8dd]/18 text-[#37c8dd]' : 'bg-[#141a27] text-[#8c96ab] hover:text-[#e7ecf5]'
                  }`}
                  title={k === 'confirm' ? '拒绝K收盘确认后才进场（推荐）' : '碰到关键位即成交：远程项目的原始行为，用作对照组'}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 border-t border-[#1d2534] pt-2">
            <div className="flex items-center gap-1.5 text-[#8c96ab]">
              <LogOut size={12} />
              <span className="text-[10px] font-semibold tracking-wider">出场方案</span>
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {eng.exitPlans.map(p => (
                <button
                  key={p.id}
                  onClick={() => eng.setExitPlan(p.id)}
                  title={p.hint}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-all ${
                    eng.exitPlan === p.id
                      ? 'bg-[#2ebd85]/18 text-[#2ebd85] shadow-[inset_0_0_0_1px_rgba(46,189,133,.4)]'
                      : 'bg-[#141a27] text-[#8c96ab] hover:text-[#e7ecf5]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mono mt-1.5 flex items-center gap-2 text-[9px] text-[#5b6579]">
            <span>门槛同时作用于实时检测与回测统计</span>
            <span className="text-[#3a4356]">·</span>
            <span>拖动即时重算，无需重新拉取行情</span>
            {error && (
              <span className="ml-auto inline-flex items-center gap-1 text-[#f6465d]">
                <AlertTriangle size={10} /> 扫描失败：{error}
              </span>
            )}
          </div>
        </div>

        <div ref={scroller} className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2.5">
          {!payload && !error && (
            <div className="flex h-64 flex-col items-center justify-center gap-2">
              <div className="skeleton h-4 w-40" />
              <span className="text-[11px] text-[#5b6579]">正在扫描全部二次测试形态…</span>
            </div>
          )}

          {payload && (
            <>
              {/* 结论条 */}
              <div className="ce-rise panel mb-2 flex items-center gap-3 border-[#273245] bg-gradient-to-r from-[#141a27] to-[#10151f] p-3">
                {current ? (
                  <>
                    <Ring p={current.proba} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="rounded px-1.5 py-px text-[10px] font-bold"
                          style={{
                            background: current.side === 'long' ? 'rgba(46,189,133,.16)' : 'rgba(246,70,93,.16)',
                            color: current.side === 'long' ? LONG : SHORT,
                          }}
                        >
                          {current.side === 'long' ? '做多 BUY' : '做空 SELL'}
                        </span>
                        <span className="text-[12px] font-bold text-[#e7ecf5]">
                          {current.pattern.startsWith('db') ? 'W双底' : 'M双顶'} · {gradeMeta(current.grade).label}
                        </span>
                      </div>
                      <div className="mono mt-1 grid grid-cols-4 gap-1 text-[10px]">
                        <div>
                          <span className="text-[#5b6579]">关键位 </span>
                          <span className="text-[#e7ecf5]">{current.level}</span>
                        </div>
                        <div>
                          <span className="text-[#5b6579]">E </span>
                          <span className="text-[#f0b90b]">{current.entry}</span>
                        </div>
                        <div>
                          <span className="text-[#5b6579]">SL </span>
                          <span className="text-[#f6465d]">{current.stop}</span>
                        </div>
                        <div>
                          <span className="text-[#5b6579]">TP </span>
                          <span className="text-[#2ebd85]">{current.tp}</span>
                        </div>
                      </div>
                      <div className="mono mt-1 flex flex-wrap gap-1">
                        {current.tags.slice(0, 5).map((t, i) => (
                          <span key={`${t}-${i}`} className="rounded bg-[#1a2334] px-1 py-px text-[9px] text-[#8c96ab]">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div
                        className="mono rounded px-2 py-1 text-[11px] font-bold"
                        style={{
                          background: setup.expired ? 'rgba(140,150,171,.12)' : current.proba >= cfg.threshold ? 'rgba(46,189,133,.14)' : 'rgba(246,70,93,.14)',
                          color: setup.expired ? MUT : current.proba >= cfg.threshold ? LONG : SHORT,
                        }}
                      >
                        {setup.expired
                          ? `已超出 ${cutoffLabel(payload?.maxHold ?? 0, payload?.barMs)} · 不再追单`
                          : current.proba >= cfg.threshold
                            ? '通过门槛 · 可执行'
                            : '确认不足 · 放弃'}
                      </div>
                      <div className="mono mt-1 flex items-center justify-end gap-1.5 text-[9px] text-[#5b6579]">
                        <span>{hhmm(current.ts)} 信号K</span>
                        <span className={setup.ageBars > 3 ? 'text-[#f0b90b]' : 'text-[#2ebd85]'}>
                          {setup.fresh ? '最新收盘K' : `距今 ${setup.ageBars} 根`}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex w-full items-center gap-3">
                    <Crosshair size={16} className="text-[#5b6579]" />
                    <div className="text-[11px] leading-relaxed text-[#8c96ab]">
                      该样本窗口内没有可结算的二次测试形态。
                      <span className="text-[#5b6579]"> 引擎不会为了出信号而降低标准 —— 没有确认就不进场；可切到「全部 / 双周期」扩大样本。</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 执行方案：把概率换算成可操作的仓位与失效条件 */}
              {current && (
                <div className="ce-rise mb-2 grid grid-cols-3 gap-1.5">
                  {(() => {
                    const p = current.proba;
                    const rr = Math.max(0.2, current.rr || 1);
                    const kelly = Math.max(0, p - (1 - p) / rr);
                    const frac = Math.min(0.25, kelly * 0.5);
                    const riskPct = current.entry > 0 ? (Math.abs(current.entry - current.stop) / current.entry) * 100 : 0;
                    const costPct = 2 * (0.05 + 0.01);
                    return (
                      <>
                        <div className="kpi !py-2">
                          <div className="k text-[9px]">半 Kelly 仓位系数</div>
                          <div className="mono v !text-[17px]" style={{ color: frac > 0 ? LONG : MUT }}>
                            {(frac * 100).toFixed(1)}%
                          </div>
                          <div className="mono mt-0.5 text-[9px] text-[#5b6579]">
                            p={pct(p * 100, 0)} · 1R={fmt(riskPct, 2)}% · 上限 25%
                          </div>
                        </div>
                        <div className="kpi !py-2">
                          <div className="k text-[9px]">{current.mode === 'touch' ? '触价挂单' : '确认进场'} / 失效</div>
                          <div className="mono v !text-[15px] text-[#f0b90b]">@{current.entry}</div>
                          <div className="mono mt-0.5 text-[9px] text-[#5b6579]">
                            收盘{current.side === 'long' ? '跌破' : '站上'} {current.level} 即作废
                          </div>
                        </div>
                        <div className="kpi !py-2">
                          <div className="k text-[9px]">成本 / 目标</div>
                          <div className="mono v !text-[15px]" style={{ color: costPct / (riskPct || 1) > 0.3 ? SHORT : LONG }}>
                            {fmt(costPct / (riskPct || 1) * 100, 0)}% · {current.tp}
                          </div>
                          <div className="mono mt-0.5 text-[9px] text-[#5b6579]">
                            往返成本占风险 · 盈亏比 {fmt(rr, 2)}R
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* KPI */}
              <div className="mb-2 grid grid-cols-3 gap-1.5">
                <Kpi
                  label="门槛后胜率"
                  value={pct(now?.winRate ?? 0, 1)}
                  tone={LONG}
                  sub={
                    <span title="Wilson 95% 置信区间：样本越少，区间越宽">
                      95%CI {pct(stats?.ci?.lo ?? 0, 0)}–{pct(stats?.ci?.hi ?? 0, 0)}{' '}
                      <Delta v={(now?.winRate ?? 0) - (base?.winRate ?? 0)} suffix="pp" />
                    </span>
                  }
                />
                <Kpi
                  label="期望值 R/笔"
                  value={signed(now?.avgR ?? 0)}
                  tone={(now?.avgR ?? 0) >= 0 ? LONG : SHORT}
                  sub={<Delta v={(now?.avgR ?? 0) - (base?.avgR ?? 0)} suffix="R" />}
                />
                <Kpi
                  label="净收益 R"
                  value={signed(now?.totalR ?? 0, 1)}
                  tone={(now?.totalR ?? 0) >= 0 ? LONG : SHORT}
                  sub={<Delta v={(now?.totalR ?? 0) - (base?.totalR ?? 0)} suffix="R" digits={1} />}
                />
                <Kpi label="成交笔数" value={String(now?.traded ?? 0)} sub={`检出 ${now?.detected ?? 0} · 过滤 ${(now?.detected ?? 0) - (now?.traded ?? 0)}`} />
                <Kpi label="盈亏因子 PF" value={fmt(now?.pf ?? 0, 2)} tone={(now?.pf ?? 0) >= 1 ? LONG : SHORT} sub={<Delta v={(now?.pf ?? 0) - (base?.pf ?? 0)} suffix="pf" />} />
                <Kpi label="最大回撤 R" value={fmt(now?.maxDD ?? 0, 1)} tone={SHORT} sub={<Delta v={-(now?.maxDD ?? 0) + (base?.maxDD ?? 0)} suffix="R" />} />
              </div>

              {/* 当前配置是否真的更好：不好就直说 */}
              {stats?.edge && (
                <div
                  className="ce-rise mb-2 flex items-start gap-2 rounded-lg border px-3 py-2"
                  style={{
                    borderColor: stats.edge.better ? 'rgba(46,189,133,.4)' : stats.edge.worse ? 'rgba(246,70,93,.4)' : 'rgba(240,185,11,.35)',
                    background: stats.edge.better ? 'rgba(46,189,133,.07)' : stats.edge.worse ? 'rgba(246,70,93,.07)' : 'rgba(240,185,11,.06)',
                  }}
                >
                  {stats.edge.better ? (
                    <CheckCircle2 size={14} className="mt-px shrink-0 text-[#2ebd85]" />
                  ) : (
                    <AlertTriangle size={14} className="mt-px shrink-0" style={{ color: stats.edge.worse ? SHORT : AMBER }} />
                  )}
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold text-[#e7ecf5]">
                      {!stats.edge.enough
                        ? '样本量不足，暂无法判定门槛是否有效'
                        : stats.edge.better
                          ? `当前门槛有效：期望值 ${signed(stats.edge.dEv)}R/笔、胜率 ${signed(stats.edge.dWin, 1)}pp`
                          : stats.edge.worse
                            ? `当前门槛没有带来提升：期望值 ${signed(stats.edge.dEv)}R/笔`
                            : '当前门槛与不设门槛基本持平'}
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-[#8c96ab]">
                      对照的是<span className="text-[#e7ecf5]">同一批形态、同一出场方案</span>，唯一差别是有没有概率门槛。
                      {stats.edge.worse && ' 门槛过滤掉的恰好是盈利单时会出现这种情况 —— 用下方「配置寻优」换一组参数，或先按不设门槛观察。'}
                    </p>
                  </div>
                </div>
              )}

              {/* 配置寻优 */}
              <Section
                title="配置寻优 · 入场 × 出场 × 门槛"
                sub={
                  stats?.optimize?.combos.length
                    ? `网格搜索后按样本外表现排序：前 ${stats.optimize.totalIs} 笔观察 / 后 ${stats.optimize.totalOos} 笔检验，通过双重检验 ${stats.optimize.validated} 组`
                    : '样本不足，无法做配置寻优'
                }
                icon={<Wand2 size={13} />}
                right={
                  stats?.optimize?.best ? (
                    <button
                      onClick={() => eng.applyCombo(stats.optimize.best!)}
                      className="rounded-md border border-[#37c8dd]/45 bg-[#37c8dd]/12 px-2 py-1 text-[10px] font-semibold text-[#37c8dd] transition-all hover:bg-[#37c8dd]/20 active:scale-95"
                      title="优先应用通过样本外双重检验的组合，并同步门槛、入场方式与出场方案"
                    >
                      应用最优组合
                    </button>
                  ) : null
                }
              >
                {stats?.optimize?.combos.length ? (
                  <div className="flex flex-col gap-1">
                    <div className="mono grid grid-cols-[128px_1fr_1fr_54px] gap-1 px-1 text-[8px] tracking-wider text-[#3a4356]">
                      <span>组合</span>
                      <span>样本内</span>
                      <span>样本外（更靠后的时间）</span>
                      <span className="text-right">判定</span>
                    </div>
                    {stats.optimize.combos.map(c => {
                      const active =
                        c.entryMode === cfg.entryMode &&
                        c.exitPlan === eng.exitPlan &&
                        Math.abs(c.threshold - cfg.threshold) < 0.011;
                      const color = c.verdict === 'validated' ? LONG : c.verdict === 'weak' ? AMBER : SHORT;
                      return (
                        <button
                          key={c.id}
                          onClick={() => eng.applyCombo(c)}
                          className={`ce-row grid grid-cols-[128px_1fr_1fr_54px] items-center gap-1 rounded-md border px-1.5 py-1.5 text-left ${
                            active ? 'border-[#37c8dd]/50 bg-[#101a22]' : 'border-[#1d2534] bg-[#0d1119]'
                          }`}
                          title="点击应用这组参数"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[10px] font-semibold text-[#e7ecf5]">
                              {c.entryMode === 'confirm' ? '等确认K' : '触价'} · {c.exitLabel}
                            </span>
                            <span className="mono text-[9px] text-[#37c8dd]">门槛 {Math.round(c.threshold * 100)}%</span>
                          </span>
                          <span className="mono text-[9px]">
                            <span className="text-[#e7ecf5]">{pct(c.is.winRate, 0)}</span>
                            <span className="text-[#5b6579]"> · n{c.is.traded} · </span>
                            <span style={{ color: c.is.avgR >= 0 ? LONG : SHORT }}>{signed(c.is.avgR)}R</span>
                          </span>
                          <span className="mono text-[9px]">
                            <span className="text-[#e7ecf5]">{pct(c.oos.winRate, 0)}</span>
                            <span className="text-[#5b6579]"> · n{c.oos.n} · </span>
                            <span style={{ color: c.oos.avgR >= 0 ? LONG : SHORT }}>{signed(c.oos.avgR)}R</span>
                          </span>
                          <span className="text-right text-[9px] font-semibold" style={{ color }}>
                            {c.verdict === 'validated' ? '通过' : c.verdict === 'weak' ? '偏弱' : '不通过'}
                          </span>
                        </button>
                      );
                    })}
                    <p className="mt-1 text-[9px] leading-relaxed text-[#3a4356]">
                      「通过」= 样本外期望 &gt; +0.05R 且样本内同向、样本外 ≥8 笔。网格搜索本身会带来选择偏差，排名第一的组合仍需继续向前验证。
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-[#5b6579]">切到「全部 / 双周期」扩大样本后即可寻优。</p>
                )}
              </Section>

              {/* A/B 对照 */}
              <Section
                title="A/B 对照 · 见形态就进场 vs 确认后进场"
                sub={`基线：${stats?.baselineKind ?? '—'} · 同一批形态候选，唯一差别是入场条件与概率门槛`}
                icon={<Layers3 size={13} />}
                right={
                  (now?.traded ?? 0) < 30 ? (
                    <span className="mono inline-flex items-center gap-1 rounded bg-[#f0b90b]/12 px-1.5 py-0.5 text-[9px] text-[#f0b90b]" title="笔数过少时胜率波动极大，只用于验证机制，不代表稳健的统计结论">
                      <AlertTriangle size={10} /> 样本 n={(now?.traded ?? 0) < 30 ? '偏少' : 'OK'}
                    </span>
                  ) : null
                }
              >
                <div className="flex flex-col gap-1.5">
                  {(
                    [
                      { k: '同批形态 · 无门槛', s: stats?.structureOnly, color: MUT },
                      { k: `同批形态 + 概率 ${Math.round(cfg.threshold * 100)}%`, s: stats?.now, color: CYAN },
                      { k: '参考 · 触价即成交', s: stats?.all, color: '#5b6579' },
                    ] as const
                  ).map(x => (
                    <div key={x.k} className="grid grid-cols-[132px_1fr] items-center gap-2 rounded-md border border-[#1d2534] bg-[#0d1119] px-2 py-1.5">
                      <div className="text-[11px] font-semibold" style={{ color: x.color }}>
                        {x.k}
                      </div>
                      <div className="mono flex items-center gap-3 text-[10px]">
                        <span className="text-[#8c96ab]">
                          胜率 <b className="text-[#e7ecf5]">{pct(x.s?.winRate ?? 0, 1)}</b>
                        </span>
                        <span className="text-[#8c96ab]">
                          笔数 <b className="text-[#e7ecf5]">{x.s?.traded ?? 0}</b>
                        </span>
                        <span className="text-[#8c96ab]">
                          期望 <b style={{ color: (x.s?.avgR ?? 0) >= 0 ? LONG : SHORT }}>{signed(x.s?.avgR ?? 0)}</b>
                        </span>
                        <span className="text-[#8c96ab]">
                          净R <b style={{ color: (x.s?.totalR ?? 0) >= 0 ? LONG : SHORT }}>{signed(x.s?.totalR ?? 0, 1)}</b>
                        </span>
                        <span className="ml-auto text-[#8c96ab]">
                          回撤 <b className="text-[#e7ecf5]">{fmt(x.s?.maxDD ?? 0, 1)}</b>
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="mono flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-[#5b6579]">
                    <span>止盈命中 {pct(stats?.now?.tpRate ?? 0)}</span>
                    <span>止损 {pct(stats?.now?.slRate ?? 0)}</span>
                    <span>超时 {pct(stats?.now?.timeRate ?? 0)}</span>
                    <span>平均持仓 {fmt(stats?.now?.avgHold ?? 0, 0)} 根</span>
                    <span>赔付比 {fmt(stats?.now?.payoff ?? 0, 2)}</span>
                    <span>稳定性 R/σ {fmt(stats?.now?.sharpeR ?? 0, 2)}</span>
                  </div>
                </div>
              </Section>

              {/* 样本外验证 */}
              <Section
                title="样本外验证 · Walk-Forward"
                sub={
                  stats?.walkForward
                    ? `前 ${stats.walkForward.trainN} 笔拟合，后 ${stats.walkForward.testN} 笔检验；三个模型取同等录取笔数（${stats.walkForward.prior.n} 笔）以保证可比`
                    : '样本不足 40 笔，暂不做拟合检验'
                }
                icon={<FlaskConical size={13} />}
                right={
                  stats?.walkForward ? (
                    <span
                      className="mono rounded px-1.5 py-0.5 text-[9px]"
                      style={{
                        background: stats.walkForward.fitted.auc >= 0.55 ? 'rgba(46,189,133,.12)' : 'rgba(240,185,11,.12)',
                        color: stats.walkForward.fitted.auc >= 0.55 ? LONG : AMBER,
                      }}
                      title="测试段 AUC：0.5 = 与抛硬币无异，>0.55 才说明概率排序真的有信息量"
                    >
                      OOS AUC {fmt(stats.walkForward.fitted.auc, 3)}
                    </span>
                  ) : null
                }
              >
                {stats?.walkForward ? (
                  <>
                    <div className="mb-1.5 grid grid-cols-4 gap-1">
                      {(
                        [
                          { k: '全部形态', s: stats.walkForward.raw, c: MUT },
                          { k: '先验模型', s: stats.walkForward.prior, c: CYAN },
                          { k: '全因子拟合', s: stats.walkForward.fitted, c: AMBER },
                          { k: '精简模型', s: stats.walkForward.sparse, c: LONG },
                        ] as const
                      ).map(x => (
                        <div key={x.k} className="rounded-md border border-[#1d2534] bg-[#0d1119] px-2 py-1.5">
                          <div className="text-[9px] font-semibold" style={{ color: x.c }}>
                            {x.k}
                          </div>
                          <div className="mono text-[15px] font-bold text-[#e7ecf5]">{pct(x.s.winRate, 1)}</div>
                          <div className="mono text-[9px] text-[#5b6579]">
                            n={x.s.n} · CI {pct(x.s.ciLo, 0)}–{pct(x.s.ciHi, 0)}
                          </div>
                          <div className="mono text-[9px]" style={{ color: x.s.avgR >= 0 ? LONG : SHORT }}>
                            {signed(x.s.avgR)}R/笔 · AUC {fmt(x.s.auc, 2)}
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mono mb-2 text-[9px] leading-relaxed text-[#5b6579]">
                      精简模型只保留训练段单变量 AUC 偏离 0.5 ≥0.04 的因子（{stats.walkForward.sparseKept.length} 个）：
                      <span className="text-[#8c96ab]">{stats.walkForward.sparseKept.join(' · ') || '无'}</span>
                    </p>
                    {stats.walkForward.folds.length > 0 && (
                      <div className="mono mb-2 flex flex-wrap gap-1 text-[9px]">
                        {stats.walkForward.folds.map(f => (
                          <span key={f.i} className="rounded border border-[#1d2534] bg-[#0d1119] px-1.5 py-0.5 text-[#8c96ab]">
                            折{f.i} n={f.testN} · 先验{' '}
                            <b style={{ color: f.prior.avgR >= 0 ? LONG : SHORT }}>{signed(f.prior.avgR)}</b> / 拟合{' '}
                            <b style={{ color: f.fitted.avgR >= 0 ? LONG : SHORT }}>{signed(f.fitted.avgR)}</b>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mb-1 flex items-center justify-between text-[9px] text-[#5b6579]">
                      <span>系数对比：灰=人工先验，彩=训练段拟合（L2 向先验收缩）</span>
                      <span className="mono">
                        {stats.walkForward.fit.converged ? '已收敛' : '未收敛'} · {stats.walkForward.fit.iterations} 次迭代
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {[...stats.walkForward.coefficients]
                        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                        .slice(0, 8)
                        .map(c => (
                          <div key={c.key} className="grid grid-cols-[100px_1fr_86px] items-center gap-2">
                            <span className="truncate text-[10px] text-[#8c96ab]">{c.label}</span>
                            <div className="relative h-[7px] overflow-hidden rounded bg-[#0d1119]">
                              <div className="absolute left-1/2 top-0 h-full w-px bg-[#273245]" />
                              <span
                                className="absolute top-0 h-full rounded-sm bg-[#3a4356]"
                                style={{
                                  width: `${Math.min(50, Math.abs(c.prior) * 90)}%`,
                                  left: c.prior >= 0 ? '50%' : undefined,
                                  right: c.prior >= 0 ? undefined : '50%',
                                }}
                              />
                              <span
                                className="absolute top-[1px] h-[5px] rounded-sm"
                                style={{
                                  width: `${Math.min(50, Math.abs(c.fitted) * 90)}%`,
                                  left: c.fitted >= 0 ? '50%' : undefined,
                                  right: c.fitted >= 0 ? undefined : '50%',
                                  background: c.fitted >= 0 ? LONG : SHORT,
                                }}
                              />
                            </div>
                            <span className="mono text-right text-[9px]" style={{ color: c.delta >= 0 ? LONG : SHORT }}>
                              {fmt(c.prior, 2)}→{fmt(c.fitted, 2)}
                            </span>
                          </div>
                        ))}
                    </div>
                    {/* 单因子样本外诊断 */}
                    <div className="mt-2 border-t border-[#1d2534] pt-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-[#e7ecf5]">单因子样本外诊断</span>
                        <span className="mono text-[9px] text-[#5b6579]">
                          两段方向一致 {stats.walkForward.stableCount}/{stats.walkForward.diagnostics.length}
                        </span>
                      </div>
                      <div className="mono mb-1 grid grid-cols-[1fr_46px_46px_38px] gap-1 text-[8px] tracking-wider text-[#3a4356]">
                        <span>因子（单变量 AUC）</span>
                        <span className="text-right">训练段</span>
                        <span className="text-right">测试段</span>
                        <span className="text-right">结论</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {stats.walkForward.diagnostics.map(d => (
                          <div key={d.key} className="grid grid-cols-[1fr_46px_46px_38px] items-center gap-1">
                            <span className="flex min-w-0 items-center gap-1">
                              <span className="truncate text-[10px] text-[#8c96ab]">{d.label}</span>
                              {d.liveOnly && <span className="shrink-0 rounded bg-[#37c8dd]/12 px-1 text-[8px] text-[#37c8dd]">实时</span>}
                            </span>
                            <span className="mono text-right text-[9px]" style={{ color: Math.abs(d.trainAuc - 0.5) < 0.03 ? MUT : d.trainAuc > 0.5 ? LONG : SHORT }}>
                              {fmt(d.trainAuc, 2)}
                            </span>
                            <span className="mono text-right text-[9px]" style={{ color: Math.abs(d.testAuc - 0.5) < 0.03 ? MUT : d.testAuc > 0.5 ? LONG : SHORT }}>
                              {fmt(d.testAuc, 2)}
                            </span>
                            <span className="text-right text-[9px]" style={{ color: d.stable ? LONG : '#5b6579' }}>
                              {d.stable ? '稳定' : d.n < 16 ? '无数据' : '不稳'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div
                      className="mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5"
                      style={{
                        borderColor: stats.walkForward.fitted.auc >= 0.55 ? 'rgba(46,189,133,.35)' : 'rgba(246,70,93,.35)',
                        background: stats.walkForward.fitted.auc >= 0.55 ? 'rgba(46,189,133,.07)' : 'rgba(246,70,93,.07)',
                      }}
                    >
                      {stats.walkForward.fitted.auc >= 0.55 ? (
                        <CheckCircle2 size={12} className="mt-px shrink-0 text-[#2ebd85]" />
                      ) : (
                        <AlertTriangle size={12} className="mt-px shrink-0 text-[#f6465d]" />
                      )}
                      <p className="text-[9px] leading-relaxed text-[#8c96ab]">
                        {stats.walkForward.fitted.auc >= 0.55
                          ? '测试段通过判别力检验：概率排序在未见过的数据上仍然有效，可按门槛执行并继续跟踪。'
                          : '测试段未通过判别力检验（AUC ≤ 0.55）：当前样本下这套证据无法稳定预测胜负，门槛只能筛掉低质量形态，不等于有正期望。建议先用模拟盘验证、或只采纳上表标记「稳定」的因子。'}
                        实时下单一律使用先验权重，拟合结果只作检验，不回写交易规则。
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-[10px] text-[#5b6579]">切到「全部 / 双周期」扩大样本后即可做样本外检验。</p>
                )}
              </Section>

              {/* 出场方案对照 */}
              <Section
                title="出场方案对照"
                sub={`同一批入场、同一门槛 ${Math.round(cfg.threshold * 100)}%，只改变离场规则`}
                icon={<LogOut size={13} />}
              >
                <div className="flex flex-col gap-1">
                  {(stats?.exitCompare ?? []).map(x => {
                    const active = x.id === eng.exitPlan;
                    return (
                      <button
                        key={x.id}
                        onClick={() => eng.setExitPlan(x.id)}
                        title={x.hint}
                        className={`ce-row grid grid-cols-[104px_1fr] items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                          active ? 'border-[#2ebd85]/45 bg-[#101a17]' : 'border-[#1d2534] bg-[#0d1119]'
                        }`}
                      >
                        <span className="text-[11px] font-semibold" style={{ color: active ? LONG : MUT }}>
                          {x.label}
                        </span>
                        <span className="mono flex items-center gap-3 text-[10px]">
                          <span className="text-[#8c96ab]">
                            胜率 <b className="text-[#e7ecf5]">{pct(x.stat.winRate, 1)}</b>
                          </span>
                          <span className="text-[#8c96ab]">
                            n <b className="text-[#e7ecf5]">{x.stat.traded}</b>
                          </span>
                          <span style={{ color: x.stat.avgR >= 0 ? LONG : SHORT }}>期望 {signed(x.stat.avgR)}R</span>
                          <span className="ml-auto" style={{ color: x.stat.totalR >= 0 ? LONG : SHORT }}>
                            净 {signed(x.stat.totalR, 1)}R
                          </span>
                          <span className="text-[#5b6579]">保本 {pct(x.stat.timeRate, 0)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>

              {/* 校准 */}
              <Section title="概率校准" sub="按预测概率分桶：柱=样本数，线=实际胜率，虚线=理想对角" icon={<Gauge size={13} />} right={<span className="mono text-[9px] text-[#5b6579]">n={stats?.calib?.reduce((s, b) => s + b.traded, 0) ?? 0}</span>}>
                {chartCalib.length > 1 ? (
                  <div className="h-[168px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartCalib} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
                        <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="label" {...axis} />
                        <YAxis yAxisId="n" {...axis} width={44} />
                        <YAxis yAxisId="p" orientation="right" domain={[0, 100]} {...axis} width={34} />
                        <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(55,200,221,0.06)' }} />
                        <Bar yAxisId="n" dataKey="traded" name="样本数" fill="#1f2a3d" radius={[2, 2, 0, 0]} maxBarSize={26} />
                        <Line yAxisId="p" type="monotone" dataKey="idealPct" name="理想" stroke="#3a4356" strokeDasharray="4 3" dot={false} strokeWidth={1.4} />
                        <Line yAxisId="p" type="monotone" dataKey="win" name="实际胜率" stroke={CYAN} strokeWidth={2.1} dot={{ r: 2.4, fill: CYAN }} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="text-[10px] text-[#5b6579]">样本不足以分桶校准（需要更多已收盘的二次测试形态）。</p>
                )}
              </Section>

              {/* 门槛扫描 */}
              <Section title="门槛扫描" sub="提高门槛是否真的提高质量？当前门槛用竖线标出" icon={<ListFilter size={13} />}>
                {sweepData.data.length > 2 ? (
                  <div className="h-[158px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={sweepData.data} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                        <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="label" {...axis} interval={2} />
                        <YAxis yAxisId="w" {...axis} width={40} unit="" />
                        <YAxis yAxisId="r" orientation="right" {...axis} width={34} />
                        <Tooltip content={<ChartTip />} cursor={{ stroke: '#273245' }} />
                        <Bar yAxisId="w" dataKey="traded" name="成交笔数" fill="#18202f" radius={[2, 2, 0, 0]} maxBarSize={16} />
                        <Line yAxisId="w" type="monotone" dataKey="winRate" name="胜率%" stroke={LONG} strokeWidth={2} dot={false} />
                        <Line yAxisId="r" type="monotone" dataKey="avgR" name="期望R" stroke={AMBER} strokeWidth={1.8} strokeDasharray="5 3" dot={false} />
                        {sweepData.current && <ReferenceLine yAxisId="w" x={sweepData.current} stroke={CYAN} strokeWidth={1.4} strokeDasharray="3 3" />}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="text-[10px] text-[#5b6579]">样本不足。</p>
                )}
              </Section>

              {/* 资金曲线 */}
              <Section title="累计净 R · 门槛前 vs 门槛后" sub="同一批形态、同一套成交规则，只改变入场许可" icon={<Sparkles size={13} />}>
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={equityData} margin={{ top: 4, right: 6, bottom: 0, left: -24 }}>
                      <defs>
                        <linearGradient id="gGate" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={LONG} stopOpacity={0.42} />
                          <stop offset="100%" stopColor={LONG} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="i" {...axis} tickFormatter={v => `#${v + 1}`} interval={Math.max(0, Math.floor(equityData.length / 8))} />
                      <YAxis {...axis} width={44} />
                      <Tooltip content={<ChartTip />} />
                      <Area type="monotone" dataKey="raw" name="原始触价进场" stroke="#3a4356" fill="none" strokeWidth={1.3} strokeDasharray="4 3" dot={false} />
                      <Area type="monotone" dataKey="gated" name="确认引擎" stroke={LONG} fill="url(#gGate)" strokeWidth={2} dot={false} connectNulls />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Section>

              {/* 分币种 */}
              {stats && stats.bySymbol.length > 1 ? (
                <Section title="分币种表现" sub="门槛是否在某个币上失效，一目了然" icon={<Gauge size={13} />}>
                  <div className="grid grid-cols-3 gap-1.5">
                    {stats.bySymbol.map(b => (
                      <div key={b.symbol} className="ce-row rounded-md border border-[#1d2534] bg-[#0d1119] px-2 py-1.5">
                        <div className="mono text-[10px] font-bold text-[#e7ecf5]">{b.symbol.replace('-USDT-SWAP', '')}</div>
                        <div className="mono text-[9px] text-[#8c96ab]">
                          {b.gated.traded}/{b.base.traded} 笔
                        </div>
                        <div className="mono text-[10px]">
                          <span style={{ color: b.gated.winRate >= b.base.winRate ? LONG : SHORT }}>
                            {pct(b.gated.winRate, 0)}
                          </span>
                          <span className="text-[#3a4356]"> vs {pct(b.base.winRate, 0)}</span>
                        </div>
                        <div className="mono text-[9px]" style={{ color: b.gated.totalR >= 0 ? LONG : SHORT }}>
                          {signed(b.gated.totalR, 1)}R
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              {/* 因子看板 */}
              <Section
                title="因子看板"
                sub="按“区分力”排序：盈利单与亏损单的平均证据差越大越有效；右侧为当前形态的证据与对数几率贡献"
                icon={<Layers3 size={13} />}
              >
                <FactorRows factors={factors} row={current} attribution={stats?.attribution} />
              </Section>

              {/* 拒绝归因 */}
              {stats?.killers?.length ? (
                <Section title="被门槛挡掉的主因" sub={`共 ${((stats.now?.detected ?? 0) - (stats.now?.traded ?? 0))} 个形态未通过 ${Math.round(cfg.threshold * 100)}% 门槛`} icon={<AlertTriangle size={13} />}>
                  <div className="grid grid-cols-2 gap-1.5">
                    {stats.killers.map(k => (
                      <div key={k.key} className="ce-row rounded-md border border-[#1d2534] bg-[#0d1119] px-2 py-1.5">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] font-semibold text-[#e7ecf5]">{k.label}</span>
                          <span className="mono text-[10px]" style={{ color: k.avg < 0 ? SHORT : MUT }}>
                            {signed(k.avg, 2)}
                          </span>
                        </div>
                        <div className="mt-1 h-[3px] overflow-hidden rounded bg-[#141a27]">
                          <span className="block h-full rounded" style={{ width: `${Math.min(100, Math.abs(k.avg) * 100)}%`, background: k.avg < 0 ? SHORT : AMBER }} />
                        </div>
                        <div className="mono mt-0.5 text-[8px] text-[#3a4356]">出现在 {k.n} 个被拒形态中</div>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              {/* 明细 */}
              <Section title="逐单明细与归因" sub="点开任意一笔，查看它凭什么通过 / 被拒" icon={<CheckCircle2 size={13} />} right={<span className="mono text-[9px] text-[#5b6579]">最近 {list.length} 笔</span>}>
                {list.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-6 text-center">
                    <AlertTriangle size={20} className="text-[#5b6579]" />
                    <p className="text-[11px] text-[#8c96ab]">该周期内没有检出可结算的双顶/双底二次测试</p>
                    <p className="max-w-[320px] text-[10px] leading-relaxed text-[#5b6579]">
                      可切换 15m 或 BTC/ETH/SOL，或降低门槛观察更边缘的形态。远程项目自带的 OKX 限频降级会改用仿真行情，此时形态分布与真实盘面不同。
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {list.map(c => {
                      const meta = gradeMeta(c.grade);
                      const pass = c.proba >= cfg.threshold;
                      const expanded = openRow === c.id;
                      return (
                        <div key={c.id} className={`rounded-md border transition-colors ${expanded ? 'border-[#37c8dd]/45 bg-[#10151f]' : 'border-[#1d2534] bg-[#0d1119]'}`}>
                          <button
                            className="ce-row ce-sig-row flex w-full items-center gap-2 px-2 py-1.5 text-left"
                            onClick={() => setOpenRow(expanded ? null : c.id)}
                          >
                            <span className="mono w-[92px] shrink-0 text-[9px] text-[#5b6579]">{hhmm(c.ts)}</span>
                            <span className="mono w-[34px] shrink-0 text-[10px] font-bold" style={{ color: c.side === 'long' ? LONG : SHORT }}>
                              {c.side === 'long' ? '多' : '空'}
                            </span>
                            <span className="w-[54px] shrink-0 text-[10px] font-semibold text-[#e7ecf5]">{c.pattern.startsWith('db') ? 'W双底' : 'M双顶'}</span>
                            <span className="relative h-[6px] w-[64px] shrink-0 overflow-hidden rounded bg-[#141a27]">
                              <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${c.proba * 100}%`, background: pass ? meta.color : '#3a4356' }} />
                            </span>
                            <span className="mono w-[34px] shrink-0 text-[10px]" style={{ color: pass ? meta.color : MUT }}>
                              {Math.round(c.proba * 100)}%
                            </span>
                            <span className="mono ml-auto shrink-0 text-[10px] font-semibold" style={{ color: (c.outcome?.r ?? 0) >= 0 ? LONG : SHORT }}>
                              {signed(c.outcome?.r ?? 0)}R
                            </span>
                            <span className="mono w-[52px] shrink-0 text-right text-[9px]" style={{ color: pass ? LONG : MUT }}>
                              {pass ? (c.outcome?.why === 'tp' ? '止盈' : c.outcome?.why === 'sl' ? '止损' : '超时') : '门槛外'}
                            </span>
                          </button>
                          {expanded && (
                            <div className="border-t border-[#1d2534] px-2 py-2">
                              <p className="mb-1.5 text-[10px] leading-relaxed text-[#8c96ab]">{c.note}</p>
                              <div className="mono mb-2 grid grid-cols-4 gap-1 rounded bg-[#0a0d13] p-1.5 text-[9px]">
                                <span>
                                  <span className="text-[#5b6579]">关键位 </span>
                                  <span className="text-[#e7ecf5]">{c.level}</span>
                                </span>
                                <span>
                                  <span className="text-[#5b6579]">颈线 </span>
                                  <span className="text-[#e7ecf5]">{c.neck}</span>
                                </span>
                                <span>
                                  <span className="text-[#5b6579]">跨度 </span>
                                  <span className="text-[#e7ecf5]">{c.spanBars} 根</span>
                                </span>
                                <span>
                                  <span className="text-[#5b6579]">高度 </span>
                                  <span className="text-[#e7ecf5]">{fmt(c.heightAtr, 1)} ATR</span>
                                </span>
                              </div>
                              <div className="flex flex-col gap-1">
                                {factors.map((f, i) => {
                                  const e = c.evidence[i];
                                  const contrib = contributionOf(e, f.weight);
                                  return (
                                    <div key={f.key} className="grid grid-cols-[96px_1fr_70px] items-center gap-2" title={f.hint}>
                                      <span className="truncate text-[10px] text-[#8c96ab]">{f.label}</span>
                                      <EvidenceBar v={e} weight={f.weight} showValue={false} />
                                      <span className="mono text-right text-[9px]" style={{ color: contrib > 0.02 ? LONG : contrib < -0.02 ? SHORT : MUT }}>
                                        {e == null ? (
                                          '无实时数据'
                                        ) : (
                                          <>
                                            证据 {signed(e, 2)}
                                            <span className="text-[#3a4356]"> · </span>
                                            贡献 {signed(contrib, 2)}
                                          </>
                                        )}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>

              <p className="px-1 pb-2 text-[9px] leading-relaxed text-[#3a4356]">
                概率由固定权重的 logistic 组合得出（base {eng.model.base} · gain {eng.model.gain}），校准曲线用于检验其在当前样本上的可靠性；样本外仍需复核。实时盘口/大单类因子只在实时行情可用，回测中按 0 贡献处理，不做臆测加成。
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
