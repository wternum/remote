import type { SignalItem } from './store';
import { decimalsFor } from '../annotTypes';

const at = (ts: number) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const px = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: decimalsFor(value), maximumFractionDigits: decimalsFor(value) });

/** Complete evidence lives in a scrollable, keyboard-accessible sidebar, not an oversized canvas tooltip. */
export default function MwStoryDetails({ item, smc, onTime }: { item: SignalItem; smc: boolean; onTime: (barTs: number) => void }) {
  const s = item.story;
  if (!s) return null;
  const coverage = Number(s.evidence.test !== null) + Number(s.evidence.confirmation !== null);
  return (
    <div className="sa-story-detail" data-mw-phase={s.phase} role="region" aria-label={`${s.side === 'top' ? '双顶' : '双底'}判读详情`}>
      <div className="sa-story-key-prices">
        <div><span>{s.side === 'top' ? '双顶阻力' : '双底支撑'}</span><strong>{px(s.level)}</strong></div>
        <div><span>颈线</span><strong>{px(s.neck)}</strong></div>
      </div>
      <div className="sa-story-evidence-bar">
        <span>反转证据{s.evidence.strength.label}</span>
        <span title="同一根兼作测试与确认时，不代表两根独立样本。">测试 / 确认成交 {coverage}/2</span>
      </div>
      <p className="sa-story-origin">形态确认 {at(s.origin.confirmedAt)} UTC<br />最新事件 {at(s.lastActivityAt)} UTC · {s.patternCount} 个重叠描述归并</p>
      {s.preview && <p className="sa-story-preview" role="status">{s.preview}</p>}
      {s.sections.map((section, i) => (
        <details key={section.id} className="sa-story-section" open={i === 0 || i === 1 || i === 4 ? true : undefined}>
          <summary><span className="sa-story-number">{String(i + 1).padStart(2, '0')}</span>{section.title}<span className="sa-story-chevron">⌄</span></summary>
          <ul>{section.lines.map((line, q) => <li key={q}>{line}</li>)}</ul>
        </details>
      ))}
      <details className="sa-story-timeline">
        <summary>事件时间线 <span>{s.timeline.length}</span></summary>
        <p>显示当时已知的收盘事件，点击定位。最多列出最近 12 项。</p>
        <ol>{s.timeline.slice(-12).map(e => (
          <li key={e.id}><button type="button" onClick={() => onTime(e.barTs)}><time dateTime={new Date(e.at).toISOString()}>{at(e.at)} UTC</time><span>{e.label}</span></button></li>
        ))}</ol>
      </details>
      {smc && s.smc && <details className="sa-story-section" data-mw-smc>
        <summary>结构补充 · SMC {s.smc.hits}/5</summary>
        <ul>{s.smc.lines.length ? s.smc.lines.map((line, i) => <li key={i}>{line}</li>) : <li>未满足可描述的结构条件。</li>}<li>只计结构条件，不推断机构身份、止损或胜率。</li></ul>
      </details>}
    </div>
  );
}
