import { useEffect, useState } from 'react';
import type { WidgetContext } from '@luxalgo/vela';
import { onIndicatorPicker } from './indicatorStore';
import IndicatorBrowser from './library/IndicatorBrowser';

/**
 * 指标库宿主：顶栏「指标」按钮 → registerIndicatorPicker → indicatorStore 事件
 * → 本宿主渲染 run-remote-code-via-mcp 项目的「指标库」布局（卡片网格 + 详情 + 快捷键脚注）。
 */
export default function IndicatorPickerHost() {
  const [ctx, setCtx] = useState<WidgetContext | null>(null);
  useEffect(() => onIndicatorPicker(c => setCtx(c)), []);
  return ctx ? <IndicatorBrowser ctx={ctx} onClose={() => setCtx(null)} /> : null;
}
