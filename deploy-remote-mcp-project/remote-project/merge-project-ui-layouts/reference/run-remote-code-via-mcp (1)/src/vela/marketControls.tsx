import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { PriceStyle } from '@luxalgo/vela';
import { registerWidgetAction } from '@luxalgo/vela';
import type { WidgetContext } from '@luxalgo/vela';

// ─────────────────────────────────────────────────────────────
//  顶栏「周期」「图表样式」控件
//  Vela 内置弹层与 WebGL 画布存在命中翻转（视觉在上、命中在画布），
//  这里彻底绕开：控件由本模块注册，下拉面板渲染在 React 树（body 下），
//  z-index 高于画布，点击必然命中。
// ─────────────────────────────────────────────────────────────

export const TIMEFRAMES: { value: string; label: string; group: string }[] = [
  { value: '1', label: '1m', group: '分钟' },
  { value: '3', label: '3m', group: '分钟' },
  { value: '5', label: '5m', group: '分钟' },
  { value: '15', label: '15m', group: '分钟' },
  { value: '30', label: '30m', group: '分钟' },
  { value: '60', label: '1h', group: '小时' },
  { value: '240', label: '4h', group: '小时' },
  { value: 'D', label: '1D', group: '天 / 周' },
  { value: 'W', label: '1W', group: '天 / 周' },
];

export const STYLES: { value: PriceStyle; label: string }[] = [
  { value: 'candles', label: 'K线' },
  { value: 'bars', label: '美国线' },
  { value: 'line', label: '折线' },
  { value: 'area', label: '面积图' },
  { value: 'baseline', label: '基准线' },
  { value: 'heikinashi', label: '平均K线' },
];

type Kind = 'timeframes' | 'styles';
interface Request {
  kind: Kind;
  ctx: WidgetContext;
  rect: { x: number; y: number; w: number; h: number };
}
type Listener = (r: Request | null) => void;
let listener: Listener | null = null;
function emit(r: Request | null) {
  listener?.(r);
}

/** 锚点 = 顶栏上对应的触发按钮（由 topbarLabels 打的 data-pd-kind 标记） */
function anchorOf(kind: Kind): { x: number; y: number; w: number; h: number } {
  const sel = kind === 'timeframes' ? '[data-pd-kind="tf"]' : '[data-pd-kind="style"]';
  const el = document.querySelector(sel);
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0) return { x: r.left, y: r.bottom, w: r.width, h: r.height };
  const bar = document.querySelector('.vela-widget-topbar')?.getBoundingClientRect();
  return { x: (bar?.left ?? 8) + 120, y: bar?.bottom ?? 40, w: 120, h: 32 };
}

/** 把弹层钳制进视口，避免被定位到屏幕外 */
function clamp(x: number, y: number, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(8, Math.min(x, vw - w - 8)),
    y: Math.max(8, Math.min(y, vh - h - 8)),
  };
}

export function registerMarketControls() {
  const mk = (kind: Kind, id: string, label: string) =>
    registerWidgetAction({
      id,
      target: 'topbar',
      label,
      iconOnly: false,
      run: ctx => emit({ kind, ctx, rect: anchorOf(kind) }),
    });
  const off1 = mk('timeframes', 'pd-timeframes', '周期');
  const off2 = mk('styles', 'pd-style', '样式');
  return () => {
    off1();
    off2();
  };
}

/** 弹窗宿主：挂在 App 上，渲染周期 / 样式下拉 */
export default function MarketControlsHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    listener = setReq;
    return () => {
      listener = null;
    };
  }, []);

  // 打开期间轮询 ctx 的实时值（timeframe / priceStyle 是 live getter）
  useEffect(() => {
    if (!req) return;
    const t = window.setInterval(() => setTick(v => v + 1), 300);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setReq(null);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [req]);

  if (!req) return null;
  void tick;

  const ctx = req.ctx;
  const currentTf = (() => {
    try {
      return ctx.timeframe;
    } catch {
      return '';
    }
  })();
  const currentStyle = (() => {
    try {
      return ctx.priceStyle;
    } catch {
      return '';
    }
  })();

  const groups = [...new Set(TIMEFRAMES.map(t => t.group))];

  // 依内容估算尺寸后钳制进视口
  const popW = req.kind === 'timeframes' ? 150 : 150;
  const popH = req.kind === 'timeframes' ? 380 : 250;
  const pos = clamp(req.rect.x, req.rect.y + 6, popW, popH);

  return createPortal(
    <div
      className="mc-overlay"
      onPointerDown={e => {
        if (e.target === e.currentTarget) setReq(null);
      }}
    >
      <div className="mc-pop" style={{ left: pos.x, top: pos.y }} role="menu">
        {req.kind === 'timeframes' ? (
          <>
            {groups.map(g => (
              <div key={g}>
                <div className="mc-group">{g}</div>
                {TIMEFRAMES.filter(t => t.group === g).map(t => (
                  <button
                    key={t.value}
                    className={`mc-row ${currentTf === t.value ? 'on' : ''}`}
                    onClick={() => {
                      // setMarket 才是稳定路径（ctx.setTimeframe 在部分场景不生效）
                      try {
                        void ctx.chart
                          .setMarket({ timeframe: t.value })
                          .then(() => console.info('[pd] 周期已切到', t.value))
                          .catch((e: unknown) => console.warn('[pd] setMarket 失败', e));
                      } catch (e) {
                        console.warn('[pd] 切换周期异常', e);
                      }
                      setReq(null);
                    }}
                  >
                    <span className="mc-check">{currentTf === t.value && <Check size={12} strokeWidth={3} />}</span>
                    <span className="mc-label">{t.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="mc-group">图表样式</div>
            {STYLES.map(s => (
              <button
                key={s.value}
                className={`mc-row ${currentStyle === s.value ? 'on' : ''}`}
                onClick={() => {
                  try {
                    ctx.setPriceStyle(s.value);
                  } catch (e) {
                    console.warn('切换样式失败', e);
                  }
                  setReq(null);
                }}
              >
                <span className="mc-check">{currentStyle === s.value && <Check size={12} strokeWidth={3} />}</span>
                <span className="mc-label">{s.label}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

void ChevronDown;
