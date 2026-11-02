import { createRoot, type Root } from 'react-dom/client';
import type { Vela } from '@luxalgo/vela';
import { registerSidePanel, msg, type WidgetContext } from '@luxalgo/vela';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import TradePanel from './TradePanel';

// 顶栏按钮图标（与 vela.luxalgo.com 右上角「交易」一致的 16px 线性图标）
registerIcon(
  'pulsedesk-trade',
  svg16('<path d="M2 12.5 6 7l3 3 5-6.5"/><path d="M10 3.5h4v4"/>', 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'),
);

let openEngine: () => void = () => undefined;
export function bindEngineOpener(fn: () => void) {
  openEngine = fn;
}

/** 把 PULSEDESK 的信号/确认引擎挂成 Vela 的侧栏面板（topbar 右侧「交易」按钮） */
export function registerTradePanel() {
  return registerSidePanel({
    id: 'pulsedesk-trade',
    title: msg('pulsedesk.trade', '交易'),
    icon: 'pulsedesk-trade',
    order: 10,
    width: 380,
    resizable: true,
    minWidth: 320,
    maxWidth: 560,
    mount(ctx: WidgetContext, body: HTMLElement) {
      body.classList.add('tp-body');
      const root: Root = createRoot(body);
      const getChart = (): Vela | null => {
        try {
          return ctx.chart;
        } catch {
          return null;
        }
      };
      root.render(<TradePanel getChart={getChart} onOpenEngine={() => openEngine()} />);
      return {
        destroy() {
          root.unmount();
        },
      };
    },
  });
}
