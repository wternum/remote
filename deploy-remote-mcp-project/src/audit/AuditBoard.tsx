import { useMemo, useState } from 'react';
import { AUDIT_META, AUDIT_TASKS, statusWeight, type AuditArea, type AuditStatus, type AuditTask } from './tasks';

const LONG = '#2ebd85';
const SHORT = '#f6465d';
const CYAN = '#37c8dd';
const AMBER = '#f0b90b';
const MUT = '#8c96ab';
const FAINT = '#5b6579';
const LINE = '#1d2534';

const STATUS_META: Record<AuditStatus, { label: string; color: string; bg: string }> = {
  done: { label: '已完成', color: LONG, bg: 'rgba(46,189,133,0.12)' },
  doing: { label: '进行中', color: CYAN, bg: 'rgba(55,200,221,0.12)' },
  pending: { label: '待处理', color: MUT, bg: 'rgba(140,150,171,0.10)' },
};

const SEVERITY_COLOR: Record<AuditTask['severity'], string> = { 严重: SHORT, 高: AMBER, 中: CYAN };
const AREAS: (AuditArea | '全部')[] = ['全部', '构建', '后端', '策略', '订单流', '前端'];

function Block({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.14em', color: tone ?? FAINT, marginBottom: 6 }}>{title}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
        {items.map((t, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.65, color: '#c9d1e0' }}>
            <span style={{ color: tone ?? FAINT, flexShrink: 0 }}>·</span>
            <code style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskCard({ task, open, onToggle }: { task: AuditTask; open: boolean; onToggle: () => void }) {
  const st = STATUS_META[task.status];
  return (
    <section
      style={{
        border: `1px solid ${task.status === 'done' ? 'rgba(46,189,133,0.28)' : LINE}`,
        background: task.status === 'done' ? 'linear-gradient(180deg, rgba(46,189,133,0.05), rgba(16,21,31,0.9))' : '#10151f',
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer',
          padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start', color: 'inherit',
        }}
      >
        <span
          style={{
            marginTop: 2, width: 30, height: 30, borderRadius: 9, flexShrink: 0,
            display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
            fontFamily: "'IBM Plex Mono', monospace", color: st.color, background: st.bg,
            border: `1px solid ${st.color}44`,
          }}
        >
          {task.status === 'done' ? '✓' : task.id}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 13.5, color: '#e7ecf5', fontWeight: 600 }}>{task.title}</b>
          </span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <i style={{ fontStyle: 'normal', fontSize: 10, padding: '2px 7px', borderRadius: 5, color: st.color, background: st.bg }}>{st.label}</i>
            <i style={{ fontStyle: 'normal', fontSize: 10, padding: '2px 7px', borderRadius: 5, color: SEVERITY_COLOR[task.severity], background: 'rgba(255,255,255,0.04)' }}>{task.severity}</i>
            <i style={{ fontStyle: 'normal', fontSize: 10, padding: '2px 7px', borderRadius: 5, color: MUT, background: 'rgba(255,255,255,0.04)' }}>{task.area}</i>
            <i style={{ fontStyle: 'normal', fontSize: 10, color: FAINT, fontFamily: "'IBM Plex Mono', monospace" }}>{task.files.join(' · ')}</i>
          </span>
        </span>
        <span style={{ color: FAINT, fontSize: 12, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s' }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px 58px' }}>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, lineHeight: 1.75, color: '#dbe3f0' }}>{task.symptom}</p>
          <Block title="核验证据" items={task.evidence} tone={CYAN} />
          <Block title="根因" items={task.rootCause} tone={AMBER} />
          <Block title="修复方案" items={task.fix} tone={LONG} />
          <Block title={task.status === 'done' ? '验证（已通过）' : '验证标准'} items={task.verify} tone={task.status === 'done' ? LONG : MUT} />
        </div>
      )}
    </section>
  );
}

export default function AuditBoard() {
  const [area, setArea] = useState<AuditArea | '全部'>('全部');
  const [openId, setOpenId] = useState<string | null>(AUDIT_TASKS[0]?.id ?? null);
  const done = AUDIT_TASKS.filter(t => t.status === 'done').length;
  const doing = AUDIT_TASKS.filter(t => t.status === 'doing').length;
  const progress = Math.round((AUDIT_TASKS.reduce((s, t) => s + statusWeight(t.status), 0) / AUDIT_TASKS.length) * 100);
  const list = useMemo(() => AUDIT_TASKS.filter(t => area === '全部' || t.area === area), [area]);

  return (
    <div style={{ minHeight: '100dvh', overflowY: 'auto', background: '#0a0d13', color: '#e7ecf5', fontFamily: "'Space Grotesk','PingFang SC',system-ui,sans-serif" }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 20px 60px' }}>
        <a href="#terminal" onClick={e => { e.preventDefault(); window.location.hash = ''; }} style={{ fontSize: 11, color: MUT, textDecoration: 'none' }}>← 返回交易终端</a>
        <header style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 18, justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.22em', color: CYAN }}>PULSEDESK · FIX BOARD</div>
            <h1 style={{ margin: '8px 0 6px', fontSize: 26, fontWeight: 650, letterSpacing: '-0.01em' }}>{AUDIT_META.title}</h1>
            <p style={{ margin: 0, fontSize: 12, color: MUT, maxWidth: 640, lineHeight: 1.7 }}>{AUDIT_META.method}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, color: done === AUDIT_TASKS.length ? LONG : CYAN, lineHeight: 1 }}>
              {done}<span style={{ fontSize: 15, color: FAINT }}>/{AUDIT_TASKS.length}</span>
            </div>
            <div style={{ fontSize: 11, color: MUT, marginTop: 6 }}>已完成 · {doing} 进行中</div>
          </div>
        </header>

        <div style={{ marginTop: 18, height: 6, borderRadius: 99, background: '#141a27', overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: `linear-gradient(90deg, ${CYAN}, ${LONG})`, transition: 'width .4s ease' }} />
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11, color: FAINT }}>
          <span>范围：{AUDIT_META.scope}</span>
          <span>原则：{AUDIT_META.principle}</span>
        </div>

        <nav style={{ display: 'flex', gap: 6, marginTop: 22, flexWrap: 'wrap' }}>
          {AREAS.map(a => (
            <button
              key={a}
              onClick={() => setArea(a)}
              style={{
                fontSize: 11, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${area === a ? 'rgba(55,200,221,0.45)' : LINE}`,
                background: area === a ? 'rgba(55,200,221,0.10)' : '#10151f',
                color: area === a ? CYAN : MUT,
              }}
            >
              {a}{a !== '全部' ? ` ${AUDIT_TASKS.filter(t => t.area === a).length}` : ''}
            </button>
          ))}
        </nav>

        <main style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          {list.map(t => (
            <TaskCard key={t.id} task={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
          ))}
        </main>

        <footer style={{ marginTop: 26, fontSize: 11, color: FAINT, lineHeight: 1.8, borderTop: `1px solid ${LINE}`, paddingTop: 14 }}>
          状态随修复进度逐项更新：pending → doing → done。验证列为实际执行的检查（单元测试 / 接口复现 / SQL / 构建），未执行完成不会标记为已完成。
        </footer>
      </div>
    </div>
  );
}
