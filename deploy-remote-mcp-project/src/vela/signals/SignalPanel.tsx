import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { WidgetContext } from '@luxalgo/vela';
import { ChevronDown, Info, RotateCcw } from 'lucide-react';
import type { SignalStore } from './store';
import {
  utcDayFloor, getActiveSessionClock, computeSessionSpans, KILLZONE_SESSIONS, MACRO_SESSIONS,
  type AsiaSweepState, type SessionDefinition, type SessionMode,
} from '../sessions/sessionMath';
import { getSessionStore, type SessionStore } from '../sessions/sessionStore';
import { MARKERS_ENABLED } from './runtime';
import { fmtClock } from '@/lib/displayTime';

/** 时段窗口按北京时间显示（窗口本身仍按 UTC / 当地夏令时定义） */
const bjRange = (startMs: number, endMs: number) => `${fmtClock(startMs)}–${fmtClock(endMs)}`;
/** 轨道仍是一个 UTC 自然日（北京 08:00 → 次日 08:00），刻度写北京时间 */
const RAIL_TICKS = [0, 6, 12, 18, 24].map(h => ({ h, label: String((h + 8) % 24).padStart(2, '0') }));

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sa-switch ${checked ? 'is-on' : ''}`} onClick={onChange}><span className="sa-switch-track"><span /></span></button>;
}
const tfLabel = (tf: string) => tf === 'D' ? '日线' : tf === 'W' ? '周线' : Number(tf) >= 60 ? `${Number(tf) / 60}小时` : `${tf || '5'}分钟`;
function sweepText(state: AsiaSweepState, high: boolean) {
  return state === 'swept_reject' ? (high ? '越过高点·收回' : '越过低点·收回') : state === 'broken' ? (high ? '收盘站上高点' : '收盘跌破低点') : '尚未测试';
}
const waitText = (m: number) => m >= 60 ? `${Math.floor(m / 60)}小时${Math.round(m % 60)}分` : `${Math.max(0, Math.round(m))}分`;
const accent = (color: string) => ({ '--sx-accent': color } as CSSProperties);

function SessionRail({ now, mode, clockMode, prefs, onToggle }: {
  now: number; mode: SessionMode; clockMode: 'fixed' | 'local'; prefs: ReturnType<SessionStore['getSnapshot']>['preferences']; onToggle: (id: SessionDefinition['id']) => void;
}) {
  const minuteMs = Math.floor(now / 60_000) * 60_000;
  const day = utcDayFloor(now);
  const defs = mode === 'macro' ? MACRO_SESSIONS : KILLZONE_SESSIONS;
  // 轨道/时钟只随分钟与口径变化；拖动透明度滑杆（bandOpacity）不触发重算。
  const clock = useMemo(() => getActiveSessionClock(minuteMs, mode, clockMode), [minuteMs, mode, clockMode]);
  // Use exactly the same span resolver as the chart, including preset-specific
  // windows and the rule that an overlap needs both parent sessions enabled.
  const { asia, london, ny } = { asia: prefs.enabledSessions.asia, london: prefs.enabledSessions.london, ny: prefs.enabledSessions.ny };
  const spans = useMemo(() => computeSessionSpans(day, day + 86_400_000 - 1, {
    mode, clockMode, enabledSessions: { asia, london, ny }, showOverlap: prefs.showOverlap,
  }), [day, mode, clockMode, asia, london, ny, prefs.showOverlap]);
  const windows = spans.map(sp => ({ id: sp.id, startMs: sp.startMs, endMs: sp.endMs, label: `北京 ${bjRange(sp.startMs, sp.endMs)}（${sp.utcWindow}）` }));
  const disabled = (id: string) => id === 'asia' ? !prefs.enabledSessions.asia : id === 'london' ? !prefs.enabledSessions.london : id === 'ny' ? !prefs.enabledSessions.ny : !prefs.showOverlap;
  return <div className={`sx-rail-wrap ${prefs.enabled ? '' : 'is-disabled'}`}>
    <div className="sx-rail-legend" aria-label="时段完整名称">{spans.filter(sp => !sp.isOverlay && !disabled(sp.id)).map(sp =>
      <span key={sp.id} style={{ color: sp.style.badgeText }}><i style={{ background: sp.style.hex }} />{sp.name}</span>
    )}</div>
    <div className="sx-rail" aria-label="24小时交易时段轨道">
      {[0, 6, 12, 18, 24].map(h => <i key={h} className="sx-hour-tick" style={{ left: `${h / 24 * 100}%` }} />)}
      {windows.map((w, i) => {
        const left = Math.max(0, (w.startMs - day) / 86_400_000 * 100);
        const right = Math.min(100, (w.endMs - day) / 86_400_000 * 100);
        if (right <= left) return null;
        const def = defs.find(d => d.id === w.id);
        const enabled = !disabled(w.id);
        const opacity = !prefs.enabled ? 0.12 : enabled ? (w.id === 'overlap' || w.id === 'london_close' ? 0.8 : Math.max(0.06, prefs.bandOpacity / 100)) : 0.18;
        return <button key={w.id} type="button" className={`sx-rail-seg ${w.id === 'overlap' || w.id === 'london_close' ? 'is-overlay' : ''} ${enabled ? '' : 'is-muted'}`} style={{ left: `${left}%`, width: `${right - left}%`, opacity, ...accent(def?.hex ?? '#868a96'), zIndex: i + 1 }} aria-label={`切换${def?.name ?? w.id}`} aria-pressed={enabled} title={`${def?.name ?? w.id} ${w.label}`} onClick={() => onToggle(w.id as SessionDefinition['id'])} />;
      })}
      <div className="sx-now" style={{ left: `${clock.dayProgressPct}%` }}><i /></div>
    </div>
    <div className="sx-hours">{RAIL_TICKS.slice(0, 2).map(t => <span key={t.h}>{t.label}</span>)}<span className="sx-rail-current" style={{ left: `${Math.max(7, Math.min(93, clock.dayProgressPct))}%` }}>{fmtClock(now)}</span>{RAIL_TICKS.slice(2).map(t => <span key={t.h}>{t.label}</span>)}</div>
  </div>;
}

export default function SignalPanel({ store }: { store: SignalStore; ctx: WidgetContext }) {
  const { preferences: prefs, runtime: state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const sessionStore = getSessionStore();
  const { preferences: sp, summary } = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const [details, setDetails] = useState<string | null>(null);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const minuteMs = Math.floor(now / 60_000) * 60_000;
  const clock = useMemo(() => getActiveSessionClock(minuteMs, sp.mode, sp.clockMode), [minuteMs, sp.mode, sp.clockMode]);
  const defs = sp.mode === 'killzone' ? KILLZONE_SESSIONS : MACRO_SESSIONS;
  const checked = (id: string) => id === 'asia' ? sp.enabledSessions.asia : id === 'london' ? sp.enabledSessions.london : id === 'ny' ? sp.enabledSessions.ny : sp.showOverlap;
  const toggle = (id: SessionDefinition['id']) => { if (id === 'asia' || id === 'london' || id === 'ny') sessionStore.toggleSession(id); else sessionStore.patch({ showOverlap: !sp.showOverlap }); };
  const asia = summary.latestAsia;
  const decimals = asia ? asia.high >= 1000 ? 1 : asia.high >= 10 ? 2 : 3 : 2;
  const status = MARKERS_ENABLED && !prefs.enabled ? '观察关闭' : state.status === 'loading' ? '载入行情' : state.status === 'error' ? '等待数据' : '收盘跟踪';
  const layers = [
    ['showBands', '背景', '时段底色'], ['showBadges', '标签', '中文时段标记'], ['showAsiaRange', '锚点', '亚太交易时段高低点'],
    ['showDailyOpen', '日界', '零点分割线'], ['showOverlap', '重叠', '重叠窗口'],
  ] as const;
  return <div className="sa-panel sx-panel" role="region" aria-label="信号标注设置">
    <header className="sx-market">
      <div className="sx-symbol"><strong>{state.symbol.split('-')[0] || 'BTC'}</strong><span>USDT 永续</span><b>{tfLabel(state.timeframe)}</b></div>
      <div className="sx-live"><i className={state.status === 'error' ? 'is-wait' : ''} />{status}</div>
    </header>
    <div className="sa-scroll sx-scroll" data-testid="session-panel">
      {state.status === 'error' && <div className="sa-alert" role="status"><Info size={13} /><span>{state.message}</span></div>}
      <section className="sx-desk" aria-label="交易时段调度台">
        <div className="sx-desk-head"><div><span className="sx-eyebrow">市场调度台</span><h2>交易时段</h2></div><Toggle checked={sp.enabled} label="显示交易时段标注" onChange={() => sessionStore.patch({ enabled: !sp.enabled })} /></div>
        <div className="sx-clock-line"><span className="sx-clock-now" title={clock.utcHHMM}>北京 {fmtClock(now)}</span><span>{clock.activeSessions.length ? clock.activeSessions.map(d => d.shortLabel).join(' · ') + ' 进行中' : `距${clock.nextSession.def.shortLabel} ${waitText(clock.nextSession.inMinutes)}`}</span></div>
        <SessionRail now={now} mode={sp.mode} clockMode={sp.clockMode} prefs={sp} onToggle={toggle} />
        {!summary.intraday && <p className="sx-note">当前周期已折叠日内色带；切回分钟或小时周期查看。</p>}
        <div className="sx-control-line"><span>时间口径</span><div className="sx-segment" role="group" aria-label="时间口径"><button type="button" aria-pressed={sp.clockMode === 'fixed'} className={sp.clockMode === 'fixed' ? 'is-active' : ''} onClick={() => sessionStore.patch({ clockMode: 'fixed' })}>固定 UTC</button><button type="button" aria-pressed={sp.clockMode === 'local'} className={sp.clockMode === 'local' ? 'is-active' : ''} onClick={() => sessionStore.patch({ clockMode: 'local' })}>本地夏令时</button></div></div>
        <div className="sx-control-line"><span>时段预设</span><div className="sx-segment" role="group" aria-label="时段预设"><button type="button" aria-pressed={sp.mode === 'macro'} className={sp.mode === 'macro' ? 'is-active' : ''} onClick={() => sessionStore.patch({ mode: 'macro' })}>宏观时段</button><button type="button" aria-pressed={sp.mode === 'killzone'} className={sp.mode === 'killzone' ? 'is-active' : ''} onClick={() => sessionStore.patch({ mode: 'killzone' })}>观察窗口</button></div></div>
        <p className="sx-note">{sp.mode === 'killzone' ? '观察窗口为固定 UTC 教学预设，不等同全年交易所本地开盘。' : sp.clockMode === 'local' ? '伦敦/纽约按当地夏令时换算；亚太交易时段仍为北京 08–16 合成区间。时间均按北京时间显示。' : '固定 UTC 教学预设，按北京时间显示；背景只标注时间，不证明方向或机构意图。'}</p>
        <div className="sx-opacity"><div><label htmlFor="sx-band-opacity">背景浓度</label><output htmlFor="sx-band-opacity">{sp.bandOpacity}%</output></div><input id="sx-band-opacity" type="range" min="0" max="100" step="1" value={sp.bandOpacity} disabled={!sp.enabled || !sp.showBands} aria-label="时段背景浓度" onChange={e => sessionStore.patch({ bandOpacity: Number(e.target.value) })} style={{ '--sx-range': `${sp.bandOpacity}%` } as CSSProperties} /><div className="sx-range-ends"><span>透明</span><span>清晰</span></div></div>
      </section>
      <section className="sx-section" aria-label="时段列表">
        <div className="sx-section-head"><h3>时段通道</h3><span>点击轨道或右侧开关</span></div>
        <div className="sx-session-list">{defs.map(def => {
          const w = clock.windows.find(x => x.id === def.id) ?? (def.id === 'overlap' ? clock.overlap : null);
          const active = clock.activeSessions.some(x => x.id === def.id);
          return <div className={`sx-session ${checked(def.id) ? '' : 'is-muted'} ${active ? 'is-active' : ''}`} key={`${sp.mode}-${def.id}`} data-session-id={def.id} style={accent(def.hex)}>
            <i className="sx-session-dot" /><div className="sx-session-main"><button type="button" className="sx-session-name" aria-expanded={details === def.id} onClick={() => setDetails(details === def.id ? null : def.id)}><strong>{def.name}</strong>{active && <small>进行中</small>}<ChevronDown size={12} className={details === def.id ? 'is-open' : ''} /></button><span className="sx-session-time" title={w?.label ?? def.utcWindow}>{w ? bjRange(w.startMs, w.endMs) : def.cnWindow.replace('北京 ', '')}</span>{details === def.id && <p>{def.description}<br />{sp.mode === 'macro' && sp.clockMode === 'local' ? w?.localLabel ?? def.cnWindow : def.cnWindow}</p>}</div>
            <Toggle checked={checked(def.id)} label={`切换${def.name}`} onChange={() => toggle(def.id)} />
          </div>;
        })}</div>
      </section>
      <section className="sx-section" aria-label="图层要素">
        <div className="sx-section-head"><h3>图层要素</h3><button type="button" className="sx-reset" onClick={() => sessionStore.reset()} title="恢复默认时段设置"><RotateCcw size={12} />重置</button></div>
        <div className="sx-layer-grid">{layers.map(([key, label, title]) => <button type="button" key={key} className={sp[key] ? 'is-active' : ''} aria-pressed={sp[key]} title={title} onClick={() => sessionStore.patch({ [key]: !sp[key] })}><i />{label}</button>)}</div>
        {MARKERS_ENABLED && <div className="sx-signal-toggle"><span>双顶 / 双底观察</span><Toggle checked={prefs.enabled} label="显示信号标注" onChange={() => store.patch({ enabled: !prefs.enabled })} /></div>}
      </section>
      {asia && <section className="sx-section sx-anchor" aria-label="亚太交易时段高低点">
        <div className="sx-section-head"><h3>亚太交易时段高低点</h3><span>{asia.dateLabel} · 北京 08–16</span></div>
        <div className="sx-anchor-grid"><div><span>区间高点</span><strong>{asia.high.toFixed(decimals)}</strong><small>{sweepText(asia.highState, true)}</small></div><div><span>区间低点</span><strong>{asia.low.toFixed(decimals)}</strong><small>{sweepText(asia.lowState, false)}</small></div></div>
        <div className="sx-anchor-foot"><span>区间振幅</span><b>{asia.rangePct.toFixed(2)}%</b><span>价格事实 · 非方向信号</span></div>
      </section>}
    </div>
  </div>;
}
