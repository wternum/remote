import { useState, useSyncExternalStore } from 'react';
import type { WidgetContext } from '@luxalgo/vela';
import { ChevronDown, Crosshair, Info } from 'lucide-react';
import { tfMs } from '../okxProvider';
import { SIGNAL_TYPES, SOURCE_LABELS, type SignalItem, type SignalStore, type SignalType } from './store';

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`sa-switch ${checked ? 'is-on' : ''}`}
      onClick={onChange}
    >
      <span className="sa-switch-track"><span /></span>
    </button>
  );
}

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', {
  timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const timeframeLabel = (tf: string) => tf === 'D' ? '1D' : tf === 'W' ? '1W' : Number(tf) >= 60 ? `${Number(tf) / 60}h` : `${tf || '5'}m`;

export default function SignalPanel({ store, ctx }: { store: SignalStore; ctx: WidgetContext }) {
  const { preferences: prefs, runtime: state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [tab, setTab] = useState<'types' | 'recent'>('types');
  const [help, setHelp] = useState<SignalType | null>(null);
  const [located, setLocated] = useState<string | null>(null);
  const selected = SIGNAL_TYPES.filter(t => prefs.selected[t.id]).length;
  const base = state.symbol.split('-')[0] || '—';
  const loading = state.status === 'loading';
  const flowOn = SIGNAL_TYPES.some(t => t.group === 'flow' && prefs.selected[t.id]);
  const statusText = !prefs.enabled ? '已隐藏' : loading ? '加载中' : state.status === 'error' ? '等待数据' : '自动更新';
  const flowText = !prefs.enabled ? '标注已暂停'
    : !flowOn ? '仅价格结构'
      : !state.flowSupported ? '当前周期无成交聚合'
        : state.flowSyncing ? '成交回补中'
          : state.flowConnected ? '成交流已连接' : '等待成交流';

  const locate = (item: SignalItem) => {
    try {
      const ms = tfMs(state.timeframe);
      ctx.chart.setVisibleRange({ from: Math.max(item.fromTs, item.ts - ms * 180) - ms * 14, to: item.ts + ms * 24 });
      setLocated(item.id);
    } catch {
      ctx.toast('图表仍在加载，请稍后重试', 'info');
    }
  };

  return (
    <div className="sa-panel" role="region" aria-label="信号标注设置">
      <div className="sa-toolbar">
        <div className="sa-market">
          <div className="sa-market-symbol"><strong>{base}</strong><span>USDT</span><span className="sa-timeframe">{timeframeLabel(state.timeframe)}</span></div>
          <span className="sa-market-status">{statusText}</span>
        </div>
        <div className="sa-master">
          <span>显示标注</span>
          <Toggle checked={prefs.enabled} label="显示信号标注" onChange={() => store.patch({ enabled: !prefs.enabled })} />
        </div>
        <div className="sa-bulk">
          <span>{prefs.enabled ? `已选 ${selected} / ${SIGNAL_TYPES.length}` : '已隐藏，选择保留'}</span>
          <div><button type="button" onClick={() => store.allOn()}>全部开启</button><span aria-hidden="true" /><button type="button" onClick={() => store.allOff()}>全部关闭</button></div>
        </div>
      </div>

      <div className="sa-tabs" role="tablist" aria-label="标注侧栏视图">
        <button id="sa-types-tab" type="button" role="tab" aria-selected={tab === 'types'} aria-controls="sa-tab-content" className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')}>标注类型</button>
        <button id="sa-recent-tab" type="button" role="tab" aria-selected={tab === 'recent'} aria-controls="sa-tab-content" className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')}>最近标记<span>{state.total}</span></button>
      </div>

      <div className="sa-content">
        <div id="sa-tab-content" role="tabpanel" aria-labelledby={tab === 'types' ? 'sa-types-tab' : 'sa-recent-tab'}>
          {state.status === 'error' && <div className="sa-alert" role="status"><Info size={13} /><span>{state.message}</span></div>}
          {tab === 'types' ? (
            <>
              {(['structure', 'flow'] as const).map(group => (
                <section className="sa-group" key={group} aria-label={group === 'structure' ? '价格结构' : '逐笔订单流'}>
                  <div className="sa-group-heading"><h3>{group === 'structure' ? '价格结构' : '逐笔订单流'}</h3><span>识别数</span></div>
                  <div className="sa-type-list">
                    {SIGNAL_TYPES.filter(t => t.group === group).map(type => (
                      <div className={`sa-type ${prefs.selected[type.id] ? 'is-selected' : ''}`} key={type.id} data-signal-type={type.id}>
                        <div className="sa-type-main">
                          <div className="sa-type-name">
                            <span>{type.name}</span>
                            <button type="button" className="sa-info" aria-label={`查看${type.name}规则`} aria-expanded={help === type.id} aria-controls={`sa-rule-${type.id}`} onClick={() => setHelp(help === type.id ? null : type.id)}><Info size={12} /></button>
                          </div>
                          <span className="sa-count" title="当前回看范围内符合数据条件的识别数量">{loading ? '—' : state.counts[type.id]}</span>
                          <Toggle checked={prefs.selected[type.id]} label={`${type.name}标注`} onChange={() => store.toggle(type.id)} />
                        </div>
                        {help === type.id && <div className="sa-rule" id={`sa-rule-${type.id}`}><p>{type.description}</p><p>{type.rule}</p></div>}
                      </div>
                    ))}
                  </div>
                  {group === 'flow' && (
                    <p className={`sa-flow-note ${!state.flowSupported || prefs.allowApprox ? 'is-caution' : ''}`}>
                      {!state.flowSupported ? '该周期无真实成交聚合；可切至 5m 等支持周期。' : prefs.allowApprox ? '≈ 为 K 线代理，不代表真实主动成交。' : '双顶双底阶段看量价结构；主动买卖额仅作佐证，非订单簿 OFI，也不是胜率。'}
                    </p>
                  )}
                </section>
              ))}
            </>
          ) : (
            <div className="sa-recent">
              <div className="sa-recent-heading"><span>最近 {prefs.lookback} 根</span><span>点击定位</span></div>
              {state.visible.length ? state.visible.slice(0, 30).map(item => (
                <button type="button" key={item.id} className={`sa-record ${located === item.id ? 'is-located' : ''}`} onClick={() => locate(item)}>
                  <span className="sa-record-copy"><strong>{item.title}</strong><span>{new Date(item.ts).toLocaleDateString('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' })} {formatTime(item.ts)} UTC</span></span>
                  <span className="sa-record-meta"><span className={item.source === 'mixed' || item.source === 'approx' ? 'sa-approx' : ''}>{SOURCE_LABELS[item.source]}</span><small>{item.confirmed ? '已确认' : '预览'}</small></span>
                  <Crosshair size={13} className="sa-locate-icon" />
                </button>
              )) : (
                <div className="sa-empty">
                  <p>{!prefs.enabled ? '标注已隐藏' : '暂无符合条件的标记'}</p>
                  <span>{!prefs.enabled ? '已保留选择，可随时恢复。' : '可增加回看范围，或选择其他类型。'}</span>
                  {!prefs.enabled && <button type="button" onClick={() => store.patch({ enabled: true })}>恢复标注</button>}
                </div>
              )}
              {state.visible.length > 30 && <p className="sa-list-note">仅列出最新 30 条，图层最多保留 160 条。</p>}
            </div>
          )}
        </div>

        <details className="sa-options">
          <summary><span>显示设置</span><ChevronDown size={13} /></summary>
          <div className="sa-options-body">
            <div className="sa-option"><span>标签文字</span><Toggle checked={prefs.labels} label="显示标签文字" onChange={() => store.patch({ labels: !prefs.labels })} /></div>
            <div className="sa-option"><span>结构连线</span><Toggle checked={prefs.geometry} label="显示结构连线" onChange={() => store.patch({ geometry: !prefs.geometry })} /></div>
            <div className="sa-option"><span>回看范围</span><select aria-label="标注回看范围" value={prefs.lookback} onChange={e => store.patch({ lookback: Number(e.target.value) as 300 | 600 | 1200 })}><option value={300}>最近 300 根</option><option value={600}>最近 600 根</option><option value={1200}>最近 1200 根</option></select></div>
            <div className="sa-option"><span>未收盘 Δ 预览<small>条件变化时会撤销</small></span><Toggle checked={prefs.preview} label="未收盘预览" onChange={() => store.patch({ preview: !prefs.preview })} /></div>
            <div className="sa-option"><span>允许 K 线近似<small>缺失成交时以 ≈ 标注</small></span><Toggle checked={prefs.allowApprox} label="允许K线近似" onChange={() => store.patch({ allowApprox: !prefs.allowApprox })} /></div>
            {prefs.allowApprox && <p className="sa-approx-warning">近似由价格形态推算，不代表真实主动买卖。</p>}
            <p className="sa-settings-note">设置自动保存在本机。</p>
          </div>
        </details>
        <p className="sa-hint">{prefs.preview ? '含未收盘 Δ 预览' : '默认收盘确认'} · 收起侧栏不影响标注</p>
      </div>

      <div className="sa-data-status" title="覆盖数为当前分析范围内具有真实订单流的 K 线数量，不是信号数量。">
        <div><span className="sa-connection"><i className={`sa-dot ${state.flowConnected && prefs.enabled ? 'is-live' : ''}`} />{flowText}</span><span className="sa-coverage">{state.covered} / {state.bars} 根</span></div>
        <div><span>真实成交覆盖</span><span>{state.updatedAt ? `${formatTime(state.updatedAt)} UTC` : '等待行情'}</span></div>
      </div>
    </div>
  );
}
