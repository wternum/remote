import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Crosshair, RefreshCw, X } from 'lucide-react';
import type { FrameworkReport } from '@/quant/frameworks';
import { decimalsFor } from '@/vela/annotTypes';
import { getFrameworkMarkStore } from '@/vela/frameworkMarkStore';
import { useFrameworks } from './frameworks/useFrameworks';
import './frameworks/frameworks.css';

const fixed = (v: number | null | undefined, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
const fmtPrice = (n: number | null | undefined, ref: number) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const d = decimalsFor(ref);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signed = (v: number | null | undefined, d = 2) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const timeOf = (ts: number) => ts > 0 ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

type Tone = 'long' | 'short' | undefined;
const toneOf = (bias: number, unavailable = false): Tone => unavailable ? undefined : bias > 0 ? 'long' : bias < 0 ? 'short' : undefined;
const biasText = (bias: number, unavailable = false) => unavailable ? '—' : bias > 0 ? '偏多' : bias < 0 ? '偏空' : '中性';

function BiasText({ bias, unavailable = false }: { bias: number; unavailable?: boolean }) {
  return <span className="fw-bias" data-tone={toneOf(bias, unavailable)}>{biasText(bias, unavailable)}</span>;
}

function Section({ title, sub, right, children }: { title: string; sub?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="fw-section">
      <div className="fw-block-head">
        <div>
          <h3 className="fw-block-title">{title}</h3>
          {sub && <p className="fw-block-sub">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function KV({ k, v, tone }: { k: string; v: ReactNode; tone?: Tone | 'amber' }) {
  return (
    <div className="fw-kv">
      <span className="fw-k">{k}</span>
      <span className="fw-v mono" data-tone={tone}>{v}</span>
    </div>
  );
}

const Reason = ({ children }: { children: ReactNode }) => <p className="fw-reason">{children}</p>;

/** Aggregate adjacent bins for display; the underlying profile remains unchanged. */
function VaapHistogram({ report }: { report: FrameworkReport }) {
  const p = report.auction.profile;
  if (!p.bins.length) return <p className="fw-reason">价值区数据不足，或成交额来源不足以构建分布。</p>;
  const size = Math.max(1, Math.ceil(p.bins.length / 34));
  const groups: { lo: number; hi: number; vol: number; count: number }[] = [];
  for (let i = 0; i < p.bins.length; i += size) {
    const slice = p.bins.slice(i, i + size);
    groups.push({ lo: slice[0].price, hi: slice[slice.length - 1].price + p.bin, vol: slice.reduce((s, b) => s + b.vol, 0), count: slice.length });
  }
  const max = Math.max(1e-9, ...groups.map(g => g.vol));
  const price = report.lastPrice;
  return (
    <div className="fw-hist">
      {[...groups].reverse().map(g => {
        const mid = (g.lo + g.hi) / 2;
        const isPoc = p.poc != null && p.poc >= g.lo && p.poc < g.hi;
        const isPrice = price >= g.lo && price < g.hi;
        const inVa = p.vah != null && p.val != null && mid >= p.val && mid < p.vah;
        const color = isPrice ? 'var(--amber)' : isPoc ? 'var(--text)' : inVa ? 'var(--faint)' : 'var(--line2)';
        return (
          <div key={g.lo} className="fw-hist-row" title={`${fmtPrice(g.lo, price)}–${fmtPrice(g.hi, price)} · ${g.count} 桶 · 成交额 ${g.vol.toFixed(0)}`}>
            <span className="fw-hist-price mono">{fmtPrice(mid, price)}</span>
            <div className="fw-hist-track">
              <span className="fw-hist-fill" style={{ width: `${Math.max(1, g.vol / max * 100)}%`, background: color }} />
            </div>
            <span className="fw-hist-mark mono" style={{ color: isPrice ? 'var(--amber)' : isPoc ? 'var(--text)' : 'transparent' }}>
              {isPrice ? '▸' : isPoc ? '◆' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const phaseLabel = (p: string) => ({ accumulation: '吸筹候选', distribution: '分发候选', markup: '上涨结构', markdown: '下跌结构', balance: '均衡 / 待确认', unknown: '未知' }[p] ?? p);
const posLabel = (p: string) => p === 'above' ? '价值区上方' : p === 'below' ? '价值区下方' : p === 'unknown' ? '未知' : '价值区内';
const verdictLabel = (v: string | undefined) => v === 'long' ? '多个视角同向偏多' : v === 'short' ? '多个视角同向偏空' : v === 'lean_long' ? '结构启发式偏多' : v === 'lean_short' ? '结构启发式偏空' : '中性 / 分歧 / 数据不足';

export default function FrameworksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const live = useFrameworks(open);
  const markStore = getFrameworkMarkStore();
  const markPrefs = useSyncExternalStore(markStore.subscribe, markStore.getSnapshot, markStore.getSnapshot);
  const { market, report, status, message, updatedAt } = live;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const ref = report?.lastPrice ?? 0;
  const confluence = report?.confluence;
  const criticalIssues = report?.quality.issues.filter(issue => !issue.includes('未收盘')) ?? [];
  const summary = report ? [
    { label: '流动性', bias: report.liquidity.bias, strength: report.liquidity.strength, na: !report.liquidity.pools.length && !report.liquidity.structure && !report.liquidity.stopHunts.length },
    { label: '多周期', bias: report.mtf.bias, strength: report.mtf.strength, na: report.mtf.considered < 2 },
    { label: 'Wyckoff', bias: report.wyckoff.bias, strength: report.wyckoff.strength, na: report.wyckoff.phase === 'unknown' },
    { label: 'AMT', bias: report.auction.bias, strength: report.auction.strength, na: report.auction.profile.poc == null },
  ] : [];

  return (
    <div className="fw-overlay">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <aside className="fw-panel" role="dialog" aria-modal="true" aria-label="四框架结构分析">
        <header className="fw-panel-head">
          <div className="min-w-0">
            <h2 className="fw-panel-title">四框架结构分析</h2>
            <div className="fw-panel-meta mono">
              <span>{market.symbol.replace('-USDT-SWAP', '')}</span>
              <span>{report?.bar ?? market.tf}</span>
              <span>{report?.bars ?? 0} 根</span>
              {report && <span>{fmtPrice(report.lastPrice, ref)}</span>}
              <span>{report ? (report.source === 'real' ? '含真实成交佐证' : '价格结构') : status === 'error' ? '计算异常' : '等待数据'}</span>
            </div>
          </div>
          <div className="fw-panel-actions">
            <button type="button" onClick={live.follow} className="fw-icon-btn" title="跟随图表当前币种与周期" aria-label="跟随图表"><Crosshair size={12} /></button>
            <button type="button" onClick={live.refresh} className="fw-icon-btn" title="重新读取已加载行情" aria-label="刷新分析"><RefreshCw size={12} className={status === 'loading' ? 'animate-spin' : ''} /></button>
            <button type="button" onClick={onClose} className="fw-icon-btn" title="关闭（Esc）" aria-label="关闭"><X size={12} /></button>
          </div>
        </header>

        <div className="fw-toolbar">
          <button
            type="button"
            onClick={() => markStore.toggle('enabled')}
            aria-pressed={markPrefs.enabled}
            className={`fw-toggle ${markPrefs.enabled ? 'is-on' : ''}`}
          >
            图表标注 {markPrefs.enabled ? '开' : '关'}
          </button>
          {([
            ['liquidity', '流动性'],
            ['fractals', '分形'],
            ['wyckoffFvg', 'Wyckoff / FVG'],
            ['amt', 'AMT'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              disabled={!markPrefs.enabled}
              onClick={() => markStore.toggle(key)}
              aria-pressed={markPrefs[key]}
              className={`fw-toggle ${markPrefs.enabled && markPrefs[key] ? 'is-on' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="fw-body scroll-slim">
          {!report ? (
            <div className="fw-empty" role="status">
              <RefreshCw size={18} className={status === 'loading' ? 'animate-spin' : ''} />
              <div>{status === 'error' ? '结构计算暂不可用' : '等待足够的连续已收盘行情'}</div>
              <p>{message || '面板复用图表已加载的数据，不额外请求行情接口。请先在图表加载该市场，或点击“跟随图表”。'}</p>
            </div>
          ) : (
            <>
              <div className="fw-status">
                <span>已收盘 <b className="mono">{report.bars}</b> 根</span>
                <span>形成中 <b className="mono">{report.quality.forming}</b> 根不参与</span>
                <span>AMT 成交额 <b>{report.quality.auctionVolumeReady ? 'quote' : '不足'}</b></span>
                <span>更新 <b className="mono">{timeOf(updatedAt)}</b></span>
              </div>
              {criticalIssues.length > 0 && (
                <div className="fw-note">数据边界：{criticalIssues.join('；')}。</div>
              )}

              <div className="fw-block">
                <div className="fw-block-head">
                  <div>
                    <h3 className="fw-block-title">结构汇总</h3>
                    <p className="fw-block-sub">同一行情上的相关视角，不是独立投票或胜率</p>
                  </div>
                  {confluence && <span className="fw-bias" data-tone={toneOf(confluence.net)}>{verdictLabel(confluence.verdict)}</span>}
                </div>
                <div className="fw-summary">
                  {summary.map(f => (
                    <div key={f.label} className="fw-summary-cell">
                      <div className="fw-summary-label">{f.label}</div>
                      <div className="fw-summary-value" data-tone={toneOf(f.bias, f.na)}>{biasText(f.bias, f.na)}</div>
                      <div className="fw-summary-strength mono">{f.na ? '无数据' : `强调 ${f.strength.toFixed(2)}`}</div>
                    </div>
                  ))}
                </div>
                {confluence && (
                  <div className="fw-summary-line" title={confluence.headline}>
                    <span>多 {confluence.long} / 空 {confluence.short} / 平 {confluence.neutral} / 无数据 {confluence.unavailable}</span>
                    <span className="mono">加权 {signed(confluence.net)}</span>
                  </div>
                )}
              </div>

              <Section title="流动性与扫位" sub="已确认摆动参考价 · 扫位收回 / 收盘越位" right={<BiasText bias={report.liquidity.bias} />}>
                <div className="fw-kvs">
                  {report.liquidity.nearestAbove && (
                    <KV k="上方最近参考" v={`${fmtPrice(report.liquidity.nearestAbove.price, ref)} · ${report.liquidity.nearestAbove.equal ? '等高' : '摆动'} ${report.liquidity.nearestAbove.touches} 个`} tone="short" />
                  )}
                  {report.liquidity.nearestBelow && (
                    <KV k="下方最近参考" v={`${fmtPrice(report.liquidity.nearestBelow.price, ref)} · ${report.liquidity.nearestBelow.equal ? '等低' : '摆动'} ${report.liquidity.nearestBelow.touches} 个`} tone="long" />
                  )}
                  {report.liquidity.structure && (
                    <KV k="结构事件" v={`${report.liquidity.structure.kind} · ${report.liquidity.structure.dir > 0 ? '向上' : '向下'}越过 ${fmtPrice(report.liquidity.structure.price, ref)}`} tone={report.liquidity.structure.dir > 0 ? 'long' : 'short'} />
                  )}
                </div>
                {report.liquidity.stopHunts.length > 0 ? (
                  <div className="fw-events">
                    {report.liquidity.stopHunts.slice(0, 3).map(h => (
                      <div key={`${h.idx}:${h.side}`} className="fw-event">
                        <div className="fw-event-top">
                          <span className="fw-event-tag" data-tone={h.kind === 'sweep' ? 'amber' : undefined}>{h.kind === 'sweep' ? '扫位收回' : '收盘越位'}</span>
                          <span className="mono">{h.side === 'above' ? '上方' : '下方'} {fmtPrice(h.level, ref)}</span>
                          <span className="fw-event-meta mono">{h.ageBars} 根前 · {h.touches} 个摆动{h.taker != null ? ` · Δ ${h.taker.toFixed(2)}` : ''}</span>
                        </div>
                        <p className="fw-event-reason">{h.reason}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Reason>近期没有“多个已确认摆动参考价被刺穿”的新事件。</Reason>
                )}
                <Reason>{report.liquidity.headline}</Reason>
              </Section>

              <Section title="多周期分形对齐" sub="完整收盘高级别 K 线 · 右侧确认 · HH/HL 与 LH/LL" right={<BiasText bias={report.mtf.bias} unavailable={report.mtf.considered < 2} />}>
                <table className="fw-table">
                  <thead>
                    <tr><th>周期</th><th>高点</th><th>低点</th><th>结构</th><th>样本</th></tr>
                  </thead>
                  <tbody>
                    {report.mtf.rows.map(r => (
                      <tr key={r.tf} title={r.reason}>
                        <td className="mono">{r.tf}</td>
                        {r.insufficient ? (
                          <>
                            <td colSpan={3}>完整 K 线不足，不参与对齐</td>
                            <td className="mono">{r.bars}/{r.requiredBars}</td>
                          </>
                        ) : (
                          <>
                            <td className="mono">{r.highRel}</td>
                            <td className="mono">{r.lowRel}</td>
                            <td><BiasText bias={r.bias === 'bull' ? 1 : r.bias === 'bear' ? -1 : 0} />{r.invalidated ? ' · 防守位已破' : ''}</td>
                            <td className="mono">{r.bars}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Reason>{report.mtf.headline}</Reason>
              </Section>

              <Section title="Wyckoff 与失衡" sub="prior 基线努力 / 结果 · 弹簧 / 上冲 · 未回补三棒缺口" right={<BiasText bias={report.wyckoff.bias} unavailable={report.wyckoff.phase === 'unknown'} />}>
                <div className="fw-kvs">
                  <KV k="阶段候选" v={phaseLabel(report.wyckoff.phase)} tone={toneOf(report.wyckoff.bias)} />
                  <KV k="努力 / 结果" v={`${fixed(report.wyckoff.effort.effort)}× · ${fixed(report.wyckoff.effort.result)} ATR`} />
                  <KV k="净推进" v={`${signed(report.wyckoff.effort.netMoveAtr)} ATR`} tone={(report.wyckoff.effort.netMoveAtr ?? 0) >= 0 ? 'long' : 'short'} />
                  <KV k="开放 FVG" v={`${report.wyckoff.imbalances.length} 个`} />
                </div>
                {report.wyckoff.springs.length > 0 && (
                  <div className="fw-events">
                    {report.wyckoff.springs.slice(0, 2).map(s => (
                      <div key={`${s.idx}:${s.kind}`} className="fw-event">
                        <div className="fw-event-top">
                          <span className="fw-event-tag" data-tone={s.kind === 'spring' ? 'long' : 'short'}>{s.kind === 'spring' ? '弹簧' : '上冲回落'}</span>
                          <span className="mono">{fmtPrice(s.level, ref)}</span>
                          <span className="fw-event-meta mono">{s.ageBars} 根前 · {fixed(s.effortRatio, 1)}×</span>
                        </div>
                        <p className="fw-event-reason">{s.reason}</p>
                      </div>
                    ))}
                  </div>
                )}
                {report.wyckoff.imbalances.length > 0 && (
                  <div className="fw-list">
                    {report.wyckoff.imbalances.map(z => (
                      <div key={`${z.from}:${z.to}`} className="fw-list-row">
                        <span>{z.kind === 'bullish' ? '多头失衡' : '空头失衡'} FVG</span>
                        <span className="mono" style={{ color: z.kind === 'bullish' ? 'var(--long)' : 'var(--short)' }}>
                          {fmtPrice(z.lo, ref)}–{fmtPrice(z.hi, ref)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <Reason>{report.wyckoff.phaseReason} {report.wyckoff.effort.reason}</Reason>
              </Section>

              <Section title="拍卖市场价值区" sub={`滚动 ${report.auction.profile.window.bars} 根 · quote 成交额均匀分摊近似 · 70% 价值区`} right={<BiasText bias={report.auction.bias} unavailable={report.auction.profile.poc == null} />}>
                <div className="fw-kvs fw-kvs--3">
                  <KV k="POC" v={fmtPrice(report.auction.profile.poc, ref)} />
                  <KV k="VAH" v={fmtPrice(report.auction.profile.vah, ref)} tone="short" />
                  <KV k="VAL" v={fmtPrice(report.auction.profile.val, ref)} tone="long" />
                </div>
                <div className="fw-kvs" style={{ marginTop: 6 }}>
                  <KV k="收盘位置" v={posLabel(report.auction.profile.position)} />
                  <KV k="距 POC" v={`${fixed(report.auction.profile.pocDistanceAtr)} ATR`} />
                  {report.auction.migration && <KV k="POC 迁移" v={`${signed(report.auction.migration.shiftAtr)} ATR`} tone={toneOf(report.auction.migration.dir)} />}
                  <KV k="价值区宽" v={`${fixed(report.auction.profile.valueWidthAtr, 1)} ATR`} />
                </div>
                <div className="fw-block-sub" style={{ marginTop: 10 }}>成交额分布（聚合显示，非逐价成交） · ▸ 收盘 · ◆ POC</div>
                <VaapHistogram report={report} />
                {report.auction.lowVolumeNodes.length > 0 && (
                  <div className="fw-list">
                    {report.auction.lowVolumeNodes.slice(0, 3).map(v => (
                      <div key={v.from} className="fw-list-row">
                        <span>低成交额节点 · {v.side === 'above' ? '上方' : '下方'}</span>
                        <span className="mono">{fmtPrice(v.from, ref)}–{fmtPrice(v.to, ref)} · {v.bins} 桶</span>
                      </div>
                    ))}
                  </div>
                )}
                <Reason>{report.auction.regimeReason}</Reason>
              </Section>

              <p className="fw-foot">
                四个视角共享同一 OHLCV 行情，多周期也是同源聚合，因此不是独立统计证据。加权分仅为未校准的结构强调度，不是概率、胜率或交易建议。AMT 需要逐根 exact quote 成交额；估算量不会冒充真实分布。真实主动差只在对应 K 线覆盖合格时显示。
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
