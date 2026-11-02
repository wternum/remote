import type { VelaWorkspace } from '@luxalgo/vela/workspace';

// ─────────────────────────────────────────────────────────────
//  顶栏标签同步
//  Vela 的 contributed action 标签是静态的；这里把「周期」「样式」按钮
//  的显示文本同步为当前值（如 "15m ▾"、"K线 ▾"），与参考站一致。
//  按钮查找一律用 data-pd-kind（文本会被本模块改写，不能再当定位依据）。
// ─────────────────────────────────────────────────────────────

const CHEVRON =
  '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export const tfText = (tf: string) => {
  if (tf === 'D') return '1D';
  if (tf === 'W') return '1W';
  const m = Number(tf);
  if (!Number.isFinite(m)) return '—';
  if (m >= 60) return `${m / 60}h`;
  return `${m}m`;
};
export const styleText = (s: string) =>
  ({ candles: 'K线', bars: '美国线', line: '折线', area: '面积图', baseline: '基准线', heikinashi: '平均K线' })[s] ?? s;

/** 当前图表样式（由 priceStyle:change 事件维护；工作区默认 K线） */
let currentStyle = 'candles';
export const readStyle = () => currentStyle;

function paint(btn: HTMLButtonElement | null, label: string, kind: 'tf' | 'style') {
  if (!btn) return;
  if (btn.dataset.pdKind !== kind) btn.dataset.pdKind = kind;
  const want = `${label}${CHEVRON}`;
  if (btn.dataset.pd === want) return;
  btn.dataset.pd = want;
  btn.textContent = label;
  btn.insertAdjacentHTML('beforeend', CHEVRON);
  btn.style.display = 'inline-flex';
  btn.style.alignItems = 'center';
  btn.style.gap = '5px';
  btn.style.fontVariantNumeric = 'tabular-nums';
}

/**
 * 首次发现：Vela 渲染 contributed action 时按钮文案就是动作 label（周期 / 样式）。
 * 一旦本模块改写过文本就不能再靠文案找，所以先给未标记的按钮打上 data-pd-kind。
 */
function discover(root: HTMLElement) {
  for (const b of root.querySelectorAll<HTMLButtonElement>('.vela-widget-topbar button')) {
    if (b.dataset.pdKind) continue;
    const t = `${b.title} ${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`;
    if (t.includes('周期')) b.dataset.pdKind = 'tf';
    else if (t.includes('样式')) b.dataset.pdKind = 'style';
  }
}

function sync(root: HTMLElement, ws: VelaWorkspace) {
  discover(root);
  let tf = '';
  try {
    tf = ws.chart.market.timeframe ?? '';
  } catch {
    return;
  }
  paint(root.querySelector<HTMLButtonElement>('[data-pd-kind="tf"]'), tfText(tf), 'tf');
  paint(root.querySelector<HTMLButtonElement>('[data-pd-kind="style"]'), styleText(currentStyle), 'style');
}

/** 挂在 workspace 上：市场 / 样式变化时刷新按钮文本 */
export function syncTopbarLabels(root: HTMLElement, ws: VelaWorkspace): () => void {
  const run = () => sync(root, ws);
  const offs: (() => void)[] = [];
  try {
    offs.push(ws.chart.on('market:changed', run));
    offs.push(
      ws.chart.on('priceStyle:change', (e: { from: string; to: string }) => {
        currentStyle = e.to;
        run();
      }),
    );
    offs.push(ws.on('cell:active', run));
  } catch {
    /* 单元格尚未就绪：由轮询兜底 */
  }
  run();
  const t = window.setInterval(run, 500);
  return () => {
    window.clearInterval(t);
    offs.forEach(f => f());
  };
}
