import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronUp, RotateCcw } from 'lucide-react';
import { getFrameworkMarkStore } from '@/vela/frameworkMarkStore';
import { frameworkLiveStore } from '@/vela/frameworkRuntime';
import type { FrameworkMarkPrefs } from '@/quant/frameworkMarks';
import './frameworks/frameworks.css';

const MARK_ITEMS: {
  key: keyof Pick<FrameworkMarkPrefs, 'liquidity' | 'fractals' | 'wyckoffFvg' | 'amt'>;
  label: string;
  legend: string;
}[] = [
  { key: 'liquidity', label: '流动性 / 扫位', legend: '前高前低、扫位收回、BOS / CHoCH' },
  { key: 'fractals', label: '分形 / MTF', legend: 'HH、HL、LH、LL 与多周期摘要' },
  { key: 'wyckoffFvg', label: 'Wyckoff / FVG', legend: '弹簧、上冲回落、未回补失衡区' },
  { key: 'amt', label: 'AMT 价值区', legend: 'POC、VAH、VAL；需要 quote 成交额' },
];

type Tone = 'long' | 'short' | 'neutral' | undefined;

export default function FrameworkBar({
  panelOpen,
  onTogglePanel,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const store = getFrameworkMarkStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const live = useSyncExternalStore(
    frameworkLiveStore.subscribe,
    frameworkLiveStore.getSnapshot,
    frameworkLiveStore.getSnapshot,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const verdict = live.report?.confluence.verdict;
  const bullish = verdict === 'long' || verdict === 'lean_long';
  const bearish = verdict === 'short' || verdict === 'lean_short';
  const tone: Tone = !prefs.enabled || live.status === 'error' ? undefined : bullish ? 'long' : bearish ? 'short' : live.report ? 'neutral' : undefined;
  const verdictText = !prefs.enabled
    ? '关'
    : live.status === 'error'
      ? '异常'
      : bullish
        ? '偏多'
        : bearish
          ? '偏空'
          : live.report
            ? '中性'
            : '等待';

  return (
    <div ref={wrapRef} className="fw-bar">
      {menuOpen && (
        <div className="fw-menu" role="dialog" aria-label="图表标注开关与图例">
          <div className="fw-menu-head">
            <div>
              <div className="fw-menu-title">图表标注</div>
              <div className="fw-menu-sub">仅使用已收盘 K 线，不接管绘图工具</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.enabled}
              aria-label="显示图表标注"
              className={`fw-switch ${prefs.enabled ? 'is-on' : ''}`}
              onClick={() => store.toggle('enabled')}
            >
              <span />
            </button>
          </div>

          <div className="fw-menu-list">
            {MARK_ITEMS.map(item => {
              const on = prefs[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!prefs.enabled}
                  onClick={() => store.toggle(item.key)}
                  aria-pressed={on}
                  className={`fw-menu-item ${on && prefs.enabled ? 'is-on' : ''}`}
                >
                  <span className="fw-check" aria-hidden>{on && prefs.enabled ? <Check size={9} strokeWidth={2.4} /> : null}</span>
                  <span>
                    <span className="fw-menu-label">{item.label}</span>
                    <span className="fw-menu-legend">{item.legend}</span>
                  </span>
                  <span className="fw-menu-state">{on ? '显示' : '隐藏'}</span>
                </button>
              );
            })}
          </div>

          <div className="fw-menu-foot">
            <button
              type="button"
              disabled={!prefs.enabled}
              onClick={() => store.toggle('labels')}
              aria-pressed={prefs.labels}
              className={`fw-menu-item ${prefs.labels && prefs.enabled ? 'is-on' : ''}`}
              title="关闭后保留线条、区域和小标记，悬停仍可看说明"
            >
              <span className="fw-check" aria-hidden>{prefs.labels && prefs.enabled ? <Check size={9} strokeWidth={2.4} /> : null}</span>
              <span className="fw-menu-label">文字标签</span>
            </button>
            <button type="button" className="fw-reset" onClick={() => store.reset()} title="恢复默认标注">
              <RotateCcw size={10} />
              重置
            </button>
          </div>
        </div>
      )}

      <div className="fw-bar-group">
        <button
          type="button"
          onClick={() => store.toggle('enabled')}
          className={`fw-bar-btn ${prefs.enabled ? 'is-active' : ''}`}
          title={prefs.enabled ? '关闭图表标注' : '开启图表标注'}
          aria-pressed={prefs.enabled}
        >
          <span className="fw-dot" data-tone={tone} aria-hidden />
          <span>标注</span>
          <span className="fw-bar-verdict" data-tone={tone}>{verdictText}</span>
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          className="fw-bar-btn fw-bar-caret"
          title="标注选项"
          aria-expanded={menuOpen}
          aria-label="展开图表标注选项"
        >
          <ChevronUp size={12} className={menuOpen ? 'rotate-180' : ''} />
        </button>
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            onTogglePanel();
          }}
          aria-expanded={panelOpen}
          className={`fw-bar-btn ${panelOpen ? 'is-active' : ''}`}
          title="四框架结构分析（Shift+F）"
        >
          四框架分析
        </button>
      </div>
    </div>
  );
}
