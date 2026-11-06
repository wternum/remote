import { useSyncExternalStore } from 'react';
import type { WidgetContext } from '@luxalgo/vela';
import { Info } from 'lucide-react';
import type { SignalStore } from './store';

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sa-switch ${checked ? 'is-on' : ''}`} onClick={onChange}><span className="sa-switch-track"><span /></span></button>;
}
const tfLabel = (tf: string) => tf === 'D' ? '1D' : tf === 'W' ? '1W' : Number(tf) >= 60 ? `${Number(tf) / 60}h` : `${tf || '5'}m`;

/**
 * 信号标注侧栏（最小外壳）：
 * 形态记录列表、三个页签、展开详情与批量开关已整体下线，仅保留行情行与
 * 主开关（计算运行器仍挂在工作区，恢复内容时从 git 历史取回原组件即可）。
 */
export default function SignalPanel({ store }: { store: SignalStore; ctx: WidgetContext }) {
  const { preferences: prefs, runtime: state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const loading = state.status === 'loading';
  const statusText = !prefs.enabled ? '已隐藏' : loading ? '加载中' : state.status === 'error' ? '等待数据' : '收盘跟踪';

  return <div className="sa-panel" role="region" aria-label="信号标注设置">
    <div className="sa-toolbar">
      <div className="sa-market"><div className="sa-market-symbol"><strong>{state.symbol.split('-')[0] || '—'}</strong><span>USDT</span><span className="sa-timeframe">{tfLabel(state.timeframe)}</span></div><span className="sa-market-status">{statusText}</span></div>
      <div className="sa-master"><span>双顶 / 双底观察</span><Toggle checked={prefs.enabled} label="显示信号标注" onChange={() => store.patch({ enabled: !prefs.enabled })} /></div>
    </div>
    {state.status === 'error' && <div className="sa-alert" role="status"><Info size={13} /><span>{state.message}</span></div>}
  </div>;
}
