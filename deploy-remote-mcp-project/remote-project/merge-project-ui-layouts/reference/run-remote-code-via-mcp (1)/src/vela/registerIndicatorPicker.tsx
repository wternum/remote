import { registerWidgetAction } from '@luxalgo/vela';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import { openIndicatorPicker } from './indicatorStore';

const ICON_ID = 'pulsedesk-indicators';

function ensureIcon() {
  try {
    registerIcon(
      ICON_ID,
      svg16(
        '<path d="M2 12.5 6 7l3 3 5-6.5"/>',
        'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
      ),
    );
  } catch {
    /* 已注册 */
  }
}

/** 接管顶栏「指标」槽位：多选对话框替换内置的逐个添加 */
export function registerIndicatorPicker() {
  ensureIcon();
  return registerWidgetAction({
    id: 'indicators',
    target: 'topbar',
    label: '指标',
    icon: ICON_ID,
    run: ctx => openIndicatorPicker(ctx.chart),
  });
}
