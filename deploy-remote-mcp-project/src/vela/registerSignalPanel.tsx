import { createRoot } from 'react-dom/client';
import { msg, registerSidePanel, registerWidgetAttachment } from '@luxalgo/vela';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import SignalPanel from './signals/SignalPanel';
import { mountSignalRuntime } from './signals/runtime';
import { SIGNAL_PANEL_ID, signalStoreFor } from './signals/store';
import './signals/signals.css';
import './signals/sessionDesk.css';

let registered = false;
export function registerSignalPanel() {
  if (registered) return;
  registered = true;
  registerIcon('pulsedesk-signal-marks', svg16(
    '<path d="M2 12.5 5.5 7l3 3 5-7"/><path d="M10.5 3H14v3.5"/><circle cx="5.5" cy="7" r="1.3"/><circle cx="8.5" cy="10" r="1.3"/>',
    'fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"',
  ));
  registerSidePanel({
    id: SIGNAL_PANEL_ID,
    title: msg('pulsedesk.signalAnnotations', '信号标注'),
    icon: 'pulsedesk-signal-marks',
    order: 5,
    width: 320,
    resizable: true,
    minWidth: 300,
    maxWidth: 440,
    mount(ctx, body) {
      body.classList.add('sa-panel-body');
      const root = createRoot(body);
      root.render(<SignalPanel store={signalStoreFor(ctx.host)} ctx={ctx} />);
      return { destroy() { queueMicrotask(() => root.unmount()); } };
    },
  });
  registerWidgetAttachment({
    id: 'pulsedesk-signal-runtime',
    mount(ctx) {
      const store = signalStoreFor(ctx.host);
      const stop = mountSignalRuntime(ctx, store);
      const welcome = window.setTimeout(() => {
        if (store.firstVisit) {
          if (window.innerWidth >= 720) ctx.togglePanel(SIGNAL_PANEL_ID, true);
          store.persist();
        }
      }, 300);
      return () => { window.clearTimeout(welcome); stop(); };
    },
  });
}
