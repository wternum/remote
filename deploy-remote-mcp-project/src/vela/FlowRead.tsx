import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Radio, Waves } from 'lucide-react';
import type { Candidate, Ctx } from '@/quant/scan';
import { latestBreakout, nearestLevel, readBreakout, readTouch, scanBreakouts, scanTouches, windowFlow, type BreakoutRead, type SecondTestRead, type TouchRead, type TouchStats } from '@/quant/orderflow';
import type { ReadAnnotation } from './annotate';
import { subscribeLastPrice } from './useChartBars';

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const AMBER = '#f0b90b';
const CYAN = '#37c8dd';
const MUT = '#8c96ab';

const pct = (v: number, d = 0) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const hhmm = (ts: number) => {
  const t = new Date(ts);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

export interface FlowInfo {
  coverage: number;
  covered: number;
  syncing: boolean;
  unsupported: boolean;
  /** 实时成交流是否已连接 */
  live: boolean;
}

interface Props {
  ctx: Ctx | null;
  rows: Candidate[];
  closedTs: number;
  threshold: number;
  /** 兼容旧调用；实时价由组件自行订阅，价格跳动不会重渲染 */
  lastPx?: number | null;
  barMs: number;
  flow: FlowInfo;
  onAnnotate: (ann: ReadAnnotation | null) => void;
}

type View =
  | { kind: 'test'; cand: Candidate; read: SecondTestRead; ageBars: number }
  | { kind: 'breakout'; read: BreakoutRead }
  | { kind: 'approach'; price: number; side: 'top' | 'bottom'; distAtr: number; recent: { ratio: number; volRatio: number; known: number }; touch: TouchRead }
  | { kind: 'idle' };

function makeView(
  ctx: Ctx | null,
  rows: Candidate[],
  lastPx: number | null,
  stats: ReturnType<typeof scanBreakouts>['stats'] | null,
): View {
  if (!ctx || ctx.n < 60) return { kind: 'idle' };
  const last = ctx.n - 1;
  const cand = rows.find(c => c.idx >= last - 12 && c.read);
  const brk = latestBreakout(ctx, 48);
  if (cand && (!brk || cand.idx >= brk.breakIdx)) return { kind: 'test', cand, read: cand.read, ageBars: last - cand.idx };
  if (brk) return { kind: 'breakout', read: readBreakout(ctx, brk.level, brk.breakIdx, last, stats ?? undefined) };
  const px = lastPx ?? ctx.cs[last].c;
  const near = nearestLevel(ctx, px, 0.6);
  if (near) {
    const w = windowFlow(ctx, last - 5, last);
    return { kind: 'approach', price: near.level.price, side: near.level.side, distAtr: near.distAtr, recent: { ratio: w.ratio, volRatio: w.volRatio, known: w.known }, touch: readTouch(ctx, near.level, last) };
  }
  return { kind: 'idle' };
}

/** 结论没变就不更新：价格跳动不改变这条签名 */
function summaryOf(v: View) {
  if (v.kind === 'test') {
    const top = v.read.scene === 'doubleTop';
    const trap = v.read.trap.kind;
    const word = trap === 'bullTrap' ? '诱多' : trap === 'bearTrap' ? '诱空' : v.read.sweep.occurred ? '扫损未确认' : '无陷阱';
    return `${top ? '下跌' : '上涨'} ${Math.round(v.cand.proba * 100)}% · ${word}`;
  }
  if (v.kind === 'breakout') {
    const up = v.read.dir > 0;
    const word = v.read.verdict === 'failed' ? (up ? '假突破' : '假跌破') : v.read.verdict === 'follow' ? '可跟随' : up ? '等回踩' : '等反抽';
    return `${up ? '回踩' : '反抽'} · 突破K · ${word}`;
  }
  if (v.kind === 'approach') {
    const k = v.touch.kind === 'sweep' ? '刺破' : v.touch.kind === 'touch' ? '触及' : '接近';
    return `${k}${v.side === 'top' ? '前高' : '前低'} · 假突破 ${Math.round(v.touch.fakeProb * 100)}%`;
  }
  return '价格不在关键位附近';
}

function viewSignature(v: View) {
  if (v.kind === 'test') return `t|${v.cand.id}|${Math.round(v.cand.proba * 100)}|${v.read.trap.kind}|${v.read.headline}`;
  if (v.kind === 'breakout') return `b|${v.read.breakTs}|${v.read.verdict}|${Math.round(v.read.followProb * 100)}|${v.read.headline}`;
  if (v.kind === 'approach') return `a|${v.side}|${v.price}|${v.touch.kind}|${v.touch.verdict}|${Math.round(v.touch.fakeProb * 100)}`;
  return 'i';
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="tp-of-row">
      <span>{k}</span>
      <b style={tone ? { color: tone } : undefined}>{v}</b>
    </div>
  );
}

export default function FlowRead({ ctx, rows, closedTs, threshold, lastPx, barMs, flow, onAnnotate }: Props) {
  const stats = useMemo(() => (ctx ? scanBreakouts(ctx).stats : null), [ctx]);
  const touchStats = useMemo<TouchStats | null>(() => (ctx ? scanTouches(ctx).stats : null), [ctx]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const sigRef = useRef('');
  const pxRef = useRef<number | null>(lastPx ?? null);
  const ctxRef = useRef(ctx);
  const rowsRef = useRef(rows);
  const statsRef = useRef(stats);
  ctxRef.current = ctx;
  rowsRef.current = rows;
  statsRef.current = stats;

  const recompute = useCallback((price: number | null) => {
    const next = makeView(ctxRef.current, rowsRef.current, price, statsRef.current);
    const sig = viewSignature(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setView(next);
  }, []);

  useEffect(() => {
    recompute(pxRef.current);
  }, [ctx, rows, stats, recompute]);

  useEffect(() => {
    let timer = 0;
    const off = subscribeLastPrice(px => {
      pxRef.current = px;
      // 价格跳动很密，判读最多每 0.8 秒重算一次，且结论不变时不刷新
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        recompute(pxRef.current);
      }, 800);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [recompute]);

  // 图上标注
  useEffect(() => {
    // 图上只放短字；概率、理由、交易计划进悬停卡片
    if (view.kind === 'test' && view.read.trap.kind) {
      const r = view.read;
      const top = r.scene === 'doubleTop';
      const bar = ctx?.cs[r.test.idx];
      const pc = Math.round(view.cand.proba * 100);
      const c = view.cand;
      onAnnotate({
        kind: 'event',
        ts: bar?.ts ?? c.ts,
        side: top ? 'above' : 'below',
        tone: top ? 'short' : 'long',
        text: `${top ? '诱多' : '诱空'} ${pc}%`,
        title: top ? `诱多 · 扫高收回 · 下跌概率 ${pc}%` : `诱空 · 扫低收回 · 上涨概率 ${pc}%`,
        detail: [r.headline, ...r.trap.reasons.slice(0, 4), `${top ? '做空' : '做多'} E ${c.entry} · SL ${c.stop} · TP ${c.tp}（R:R ${c.rr}）`],
      });
    } else if (view.kind === 'approach' && view.touch.verdict === 'reject') {
      const tr = view.touch;
      const top = tr.side === 'top';
      const bar = ctx?.cs[tr.testIdx];
      const pc = Math.round(tr.fakeProb * 100);
      onAnnotate({
        kind: 'event',
        ts: bar?.ts ?? ctx?.cs[ctx.n - 1]?.ts ?? 0,
        side: top ? 'above' : 'below',
        tone: top ? 'short' : 'long',
        text: `假突破 ${pc}%`,
        title: `${top ? '触顶' : '触底'} ${tr.level} · 假突破 ${pc}% · 真突破 ${100 - pc}%`,
        detail: [
          tr.headline,
          ...tr.reasons.slice(0, 4),
          ...(tr.plan ? [`${top ? '做空' : '做多'} E ${tr.plan.entry} · SL ${tr.plan.stop} · TP ${tr.plan.tp}（R:R ${tr.plan.rr}）`] : []),
        ],
      });
    } else if (view.kind === 'breakout') {
      const r = view.read;
      const up = r.dir > 0;
      const failed = r.verdict === 'failed';
      onAnnotate({
        kind: 'zone',
        fromTs: r.breakTs,
        toTs: r.breakTs + barMs * Math.max(r.barsSince + 12, 24),
        lo: r.zone.lo,
        hi: r.zone.hi,
        tone: failed ? 'warn' : r.verdict === 'follow' ? (up ? 'long' : 'short') : 'zone',
        text: failed ? (up ? '假突破' : '假跌破') : up ? '回踩区' : '反抽区',
        title: `${up ? '向上突破' : '向下跌破'} ${r.level} · ${r.headline}`,
        detail: [`${up ? '回踩续涨' : '反抽续跌'}概率 ${Math.round(r.followProb * 100)}%`, ...r.reasons.slice(0, 4)],
        levelPrice: r.level,
        failed,
      });
    } else {
      onAnnotate(null);
    }
  }, [view, onAnnotate, barMs, ctx]);

  const badge = flow.unsupported ? (
    <span className="tp-of-badge off">该周期无真实订单流 · 使用 K 线近似</span>
  ) : flow.covered > 0 ? (
    <span className="tp-of-badge on">
      <Radio size={10} /> OKX 逐笔主动买卖 · 覆盖 {flow.covered} 根{flow.live ? ' · 实时' : ''}{flow.syncing ? ' · 回补中' : ''}
    </span>
  ) : (
    <span className="tp-of-badge off">{flow.syncing ? '正在回补 OKX 逐笔成交…' : flow.live ? '实时成交流已连接 · 等待首根完整 K 线' : '暂无真实订单流 · 使用 K 线近似'}</span>
  );

  return (
    <div className="tp-of tp-flow" data-testid="flow-read" data-view={view.kind}>
      <button type="button" className="tp-flow-line" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <Waves size={12} />
        <span className="tp-flow-sum">{summaryOf(view)}</span>
        <span className="tp-flow-more">{open ? '收起' : '详情'}</span>
      </button>
      <div hidden={!open}>
      <div className="tp-of-head">
        <Waves size={12} />
        <span>订单流判读</span>
        {badge}
      </div>

      {view.kind === 'test' && (() => {
        const { cand, read } = view;
        const top = read.scene === 'doubleTop';
        const prob = cand.proba;
        const color = top ? SHORT : LONG;
        const trap = read.trap.kind;
        const pass = prob >= threshold;
        return (
          <div className="tp-of-body">
            <div className="tp-of-main">
              <div className="tp-of-prob" style={{ ['--c' as string]: color, ['--p' as string]: `${Math.round(prob * 100)}%` }}>
                <b>{Math.round(prob * 100)}%</b>
                <i>{top ? '下跌' : '上涨'}</i>
              </div>
              <div className="tp-of-text">
                <div className="tp-of-title">
                  {top ? <ArrowDown size={13} color={SHORT} /> : <ArrowUp size={13} color={LONG} />}
                  {top ? 'M 双顶 · 二次测试' : 'W 双底 · 二次测试'} <em>{hhmm(cand.ts)}{view.ageBars ? ` · ${view.ageBars} 根前` : ' · 刚收盘'}</em>
                </div>
                <div className="tp-of-sub">{read.headline}</div>
                <div className="tp-of-chips">
                  <span className={`tp-of-chip ${trap ? 'warn' : ''}`}>
                    {trap ? <AlertTriangle size={10} /> : null}
                    {trap === 'bullTrap' ? '诱多' : trap === 'bearTrap' ? '诱空' : read.sweep.occurred ? '扫损但未确认' : '无陷阱特征'} {Math.round(read.trap.score * 100)}
                  </span>
                  <span className={`tp-of-chip ${pass ? 'ok' : ''}`}>{pass ? `过 ${Math.round(threshold * 100)}% 门槛 · 可执行` : `低于门槛 · 观望`}</span>
                  <span className="tp-of-chip">{top ? '上涨' : '下跌'} {Math.round((1 - prob) * 100)}%</span>
                </div>
              </div>
            </div>
            <div className="tp-of-grid">
              <Row
                k={top ? '触顶订单流' : '触底订单流'}
                v={`假突破 ${Math.round(read.touch.fakeProb * 100)}% · 真突破 ${Math.round(read.touch.breakProb * 100)}%`}
                tone={read.touch.verdict === 'reject' ? color : read.touch.verdict === 'breakout' ? AMBER : MUT}
              />
              <Row k={top ? '第二腿主动买入' : '第二腿主动卖出'} v={`${pct(top ? read.leg2.ratio : -read.leg2.ratio)} vs 第一腿 ${pct(top ? read.leg1.ratio : -read.leg1.ratio)}`} tone={read.legDeltaDiff > 0.2 ? color : MUT} />
              <Row k="CVD 极值背离" v={read.cvdDiv > 0.25 ? `成立 (${fmt(read.cvdDiv)})` : read.cvdDiv < -0.25 ? `反向 (${fmt(read.cvdDiv)})` : `不明显 (${fmt(read.cvdDiv)})`} tone={read.cvdDiv > 0.25 ? color : MUT} />
              <Row k="二次测试量能" v={`${fmt(read.legVolRatio)}x 第一腿`} tone={read.legVolRatio < 0.85 ? color : MUT} />
              <Row
                k={top ? '扫高' : '扫低'}
                v={read.sweep.occurred ? `${fmt(read.sweep.depthAtr)} ATR · ${read.sweep.bars} 根${read.sweep.flow ? ` · 主动差 ${pct(read.sweep.flow.ratio)} · 量 ${fmt(read.sweep.flow.volRatio, 1)}x` : ''}` : '无'}
                tone={read.sweep.occurred ? AMBER : MUT}
              />
              <Row k="关键位吸收" v={`${read.absorption.count} 根吸收 / ${read.absorption.breach} 根击穿`} tone={read.absorption.count > read.absorption.breach ? color : MUT} />
              <Row k="确认K主动差" v={`${pct(read.confirm.deltaRatio)}${read.confirm.known ? '' : '（近似）'} · 量 ${fmt(read.confirm.volRatio, 1)}x`} tone={read.confirm.deltaRatio * read.dir > 0.05 ? color : MUT} />
              <Row k="第二腿持仓变化（张）" v={read.oi.pct == null ? '无数据' : pct(read.oi.pct, 2)} tone={read.oi.pct != null && read.oi.pct > 0.003 ? AMBER : MUT} />
            </div>
            {(read.touch.reasons.length > 0 || read.trap.reasons.length > 0) && (
              <ul className="tp-of-reasons">
                {[...read.touch.reasons.filter(r => !r.startsWith('刺破')).slice(0, 3), ...read.trap.reasons].slice(0, 5).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            <div className="tp-of-action" style={{ borderColor: pass ? color : '#3a4356' }}>
              {pass
                ? `${top ? '做空' : '做多'} E ${cand.entry} · SL ${cand.stop} · TP ${cand.tp}（R:R ${cand.rr}）`
                : top
                  ? `概率 ${Math.round(prob * 100)}% 未过门槛：不追空；若后续收盘站上 ${cand.level} 且主动买入占优，按突破处理`
                  : `概率 ${Math.round(prob * 100)}% 未过门槛：不抄底；若后续收盘跌破 ${cand.level} 且主动卖出占优，按跌破处理`}
            </div>
          </div>
        );
      })()}

      {view.kind === 'breakout' && (() => {
        const r = view.read;
        const up = r.dir > 0;
        const color = r.verdict === 'failed' ? AMBER : r.verdict === 'follow' ? (up ? LONG : SHORT) : r.verdict === 'avoid' ? SHORT : r.verdict === 'follow_weak' ? AMBER : CYAN;
        const chase = r.chaseRate;
        return (
          <div className="tp-of-body">
            <div className="tp-of-main">
              <div className="tp-of-prob" style={{ ['--c' as string]: color, ['--p' as string]: `${Math.round(r.followProb * 100)}%` }}>
                <b>{Math.round(r.followProb * 100)}%</b>
                <i>{r.verdict === 'failed' ? '继续概率' : up ? '回踩续涨' : '反抽续跌'}</i>
              </div>
              <div className="tp-of-text">
                <div className="tp-of-title">
                  {up ? <ArrowUp size={13} color={LONG} /> : <ArrowDown size={13} color={SHORT} />}
                  {up ? '向上突破阻力' : '向下跌破支撑'} {r.level} <em>{hhmm(r.breakTs)} · {r.barsSince} 根前</em>
                </div>
                <div className="tp-of-sub" style={{ color }}>
                  {r.headline}
                </div>
                <div className="tp-of-chips">
                  <span className={`tp-of-chip ${r.verdict === 'follow' ? 'ok' : r.verdict === 'failed' || r.verdict === 'avoid' || r.verdict === 'follow_weak' ? 'warn' : ''}`}>
                    {r.verdict === 'follow' ? '可跟随' : r.verdict === 'follow_weak' ? '守住但兑现率低 · 轻仓' : r.verdict === 'failed' ? '假突破 · 不跟' : r.verdict === 'avoid' ? '暂不跟随' : r.verdict === 'wait_pullback' ? '等回踩' : r.verdict === 'strong_hold' ? '强势不回调' : '不追'}
                  </span>
                  <span className="tp-of-chip">
                    回踩区 {fmt(r.zone.lo, r.level >= 1000 ? 1 : 2)} ~ {fmt(r.zone.hi, r.level >= 1000 ? 1 : 2)}
                  </span>
                </div>
              </div>
            </div>
            <div className="tp-of-grid">
              <Row k="突破K" v={`量 ${fmt(r.impulse.volRatio, 1)}x · 主动差 ${pct(r.impulse.deltaRatio)} · 离位 ${fmt(r.impulse.extensionAtr, 1)} ATR`} tone={r.impulse.climax ? AMBER : MUT} />
              <Row
                k={up ? '回调' : '反弹'}
                v={r.pullback.started ? `深度 ${Math.round(r.pullback.depth * 100)}% · 量 ${fmt(r.pullback.volRatio)}x · 主动差 ${pct(r.pullback.deltaRatio)}` : '尚未开始'}
                tone={r.pullback.started ? (r.pullback.volRatio <= 0.8 ? LONG : SHORT) : MUT}
              />
              <Row k={up ? '回踩关键位' : '反抽关键位'} v={r.pullback.failed ? '收盘跌回 · 失败' : r.pullback.held ? '触及并守住' : r.pullback.touched ? '触及 · 等确认K' : '未触及'} tone={r.pullback.failed ? AMBER : r.pullback.held ? LONG : MUT} />
              <Row k="突破段持仓（张）" v={r.oiPct == null ? '无数据' : pct(r.oiPct, 2)} tone={MUT} />
              <Row
                k="本图历史"
                v={stats ? `突破即追 ${chase == null ? '样本不足' : `${Math.round(chase * 100)}% (${stats.chase.n})`} · 等回踩 ${stats.buckets.retest_hold.n ? `${Math.round((stats.buckets.retest_hold.win / stats.buckets.retest_hold.n) * 100)}% (${stats.buckets.retest_hold.n})` : '样本不足'}` : '—'}
                tone={MUT}
              />
            </div>
            <ul className="tp-of-reasons">
              {r.reasons.slice(0, 4).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            <div className="tp-of-action" style={{ borderColor: color }}>
              {r.verdict === 'follow'
                ? `${up ? '在回踩区上方顺势做多' : '在反抽区下方顺势做空'}，止损放在 ${up ? '关键位下方' : '关键位上方'} ${fmt(up ? r.zone.lo : r.zone.hi, r.level >= 1000 ? 1 : 2)} 外`
                : r.verdict === 'follow_weak'
                  ? `回踩虽守住，但本图历史上同类回踩继续走的只有 ${Math.round(r.followProb * 100)}%：只宜轻仓，或等再一次缩量回踩 + 主动${up ? '买入' : '卖出'}接管`
                  : r.verdict === 'failed'
                  ? `突破盘已被套：${up ? '不追多，反而留意回落到突破前区间的空机会' : '不追空，反而留意反弹回区间的多机会'}`
                  : r.verdict === 'avoid'
                    ? `${up ? '回调放量、主动卖出占优' : '反弹放量、主动买入占优'}：等待缩量或关键位重新守住再评估`
                    : `${up ? '不追高' : '不追空'}：等价格回到回踩区并出现缩量 + 收盘守住，再跟随`}
            </div>
          </div>
        );
      })()}

      {view.kind === 'approach' && (() => {
        const tr = view.touch;
        const top = view.side === 'top';
        const color = top ? SHORT : LONG;
        const prob = tr.fakeProb;
        const pass = tr.verdict === 'reject' && prob >= threshold && !!tr.plan;
        const hist = touchStats;
        const histRate = hist && hist.n > 0 ? hist.reject / hist.n : 0;
        const hiRate = hist && hist.hiN > 0 ? hist.hiReject / hist.hiN : 0;
        const act = top ? '做空' : '做多';
        return (
          <div className="tp-of-body">
            <div className="tp-of-main">
              <div className="tp-of-prob" style={{ ['--c' as string]: tr.verdict === 'breakout' ? AMBER : color, ['--p' as string]: `${Math.round(prob * 100)}%` }}>
                <b>{Math.round(prob * 100)}%</b>
                <i>假突破</i>
              </div>
              <div className="tp-of-text">
                <div className="tp-of-title">
                  {top ? <ArrowDown size={13} color={SHORT} /> : <ArrowUp size={13} color={LONG} />}
                  {tr.kind === 'approach' ? '接近' : tr.kind === 'sweep' ? '刺破' : '触及'}
                  {top ? '历史顶部' : '历史底部'} {view.price} <em>距 {fmt(view.distAtr)} ATR</em>
                </div>
                <div className="tp-of-sub">{tr.headline}</div>
                <div className="tp-of-chips">
                  <span className={`tp-of-chip ${tr.verdict === 'reject' ? 'ok' : tr.verdict === 'breakout' ? 'warn' : ''}`}>
                    {tr.verdict === 'reject' ? '订单流：偏拒绝' : tr.verdict === 'breakout' ? '订单流：偏突破' : '订单流：不明朗'}
                  </span>
                  <span className="tp-of-chip">真突破 {Math.round(tr.breakProb * 100)}%</span>
                </div>
              </div>
            </div>
            <div className="tp-of-grid">
              <Row
                k={top ? '冲顶主动买入' : '杀底主动卖出'}
                v={`${pct(tr.approach.ratio * (top ? 1 : -1))}${view.recent.known < 0.5 ? '（近似）' : ''} · 量 ${fmt(tr.approach.volRatio, 2)}x`}
                tone={tr.pressure > 0.2 ? AMBER : tr.pressure < 0 ? color : MUT}
              />
              <Row k="触及那根" v={`量 ${fmt(tr.bar.volRatio, 1)}x · 主动差 ${pct(tr.bar.deltaRatio)} · 影线 ${Math.round(tr.bar.wick * 100)}%`} tone={MUT} />
              <Row k="本图同类触及" v={hist && hist.n > 0 ? `${hist.n} 次 · 被拒绝 ${Math.round(histRate * 100)}%` : '样本不足'} tone={MUT} />
              <Row
                k="订单流判拒绝时"
                v={hist && hist.hiN >= 3 ? `${hist.hiN} 次 · 兑现 ${Math.round(hiRate * 100)}%` : '样本不足'}
                tone={hist && hist.hiN >= 3 && hiRate > histRate ? color : MUT}
              />
            </div>
            {tr.reasons.length > 0 && (
              <ul className="tp-of-reasons">
                {tr.reasons.slice(0, 4).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            <div className="tp-of-action" style={{ borderColor: pass ? color : '#3a4356' }}>
              {pass && tr.plan
                ? `${act}（${tr.kind === 'approach' ? '触及即入 · 挂单' : '订单流确认 · 可入'}）E ${tr.plan.entry} · SL ${tr.plan.stop} · TP ${tr.plan.tp}（R:R ${tr.plan.rr}）`
                : tr.verdict === 'reject'
                  ? `假突破概率 ${Math.round(prob * 100)}% 未过 ${Math.round(threshold * 100)}% 门槛：先观望`
                  : tr.verdict === 'breakout'
                    ? `${top ? '不抢空' : '不抢多'}：${top ? '买盘' : '卖盘'}仍在推进；若刺破后收回且${top ? '主动卖出' : '主动买入'}接管 → 转为假突破信号；收盘站稳${top ? '上' : '下'}方按突破处理`
                    : `订单流不明朗：等${top ? '扫高收回 / 上影拒绝K' : '扫低收回 / 下影拒绝K'}，或等收盘站稳${top ? '上' : '下'}方确认突破`}
            </div>
          </div>
        );
      })()}

      {view.kind === 'idle' && (
        <div className="tp-of-body tp-of-idle">
          {ctx ? '价格不在历史顶/底关键位附近，最近 4 小时内也没有关键位突破。等待二次测试或突破出现。' : '等待图表加载足够的 K 线…'}
          <small>最近收盘 {closedTs ? hhmm(closedTs) : '—'}</small>
        </div>
      )}
      </div>
    </div>
  );
}
