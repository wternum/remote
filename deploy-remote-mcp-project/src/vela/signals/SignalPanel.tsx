import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WidgetContext } from '@luxalgo/vela';
import { ChevronDown, Crosshair, Info } from 'lucide-react';
import { tfMs } from '../okxProvider';
import { SIGNAL_TYPES, SOURCE_LABELS, flowRequested, type SignalItem, type SignalStore, type SignalType } from './store';
import MwStoryDetails from './MwStoryDetails';

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sa-switch ${checked ? 'is-on' : ''}`} onClick={onChange}><span className="sa-switch-track"><span /></span></button>;
}
const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' });
const tfLabel = (tf: string) => tf === 'D' ? '1D' : tf === 'W' ? '1W' : Number(tf) >= 60 ? `${Number(tf) / 60}h` : `${tf || '5'}m`;

export default function SignalPanel({ store, ctx }: { store: SignalStore; ctx: WidgetContext }) {
  const { preferences: prefs, runtime: state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [tab, setTab] = useState<'mw' | 'context' | 'types'>('mw');
  const [help, setHelp] = useState<SignalType | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [located, setLocated] = useState<string | null>(null);
  const [shown, setShown] = useState(12);
  const [history, setHistory] = useState(false);
  useEffect(() => { setExpanded(null); setLocated(null); setShown(12); setHistory(false); }, [state.symbol, state.timeframe]);
  const allStories = state.visible.filter(i => i.story);
  const activeStories = allStories.filter(i => i.story!.active);
  const stories = history ? allStories : activeStories;
  const background = state.visible.filter(i => !i.story);
  const focused = expanded === null ? (stories.find(i => i.story?.active)?.id ?? stories[0]?.id) : expanded;
  const loading = state.status === 'loading';
  const statusText = !prefs.enabled ? '已隐藏' : loading ? '加载中' : state.status === 'error' ? '等待数据' : '收盘跟踪';
  const flowText = !prefs.enabled ? '标注已暂停' : !flowRequested(prefs) ? '仅价格结构'
    : !state.flowSupported ? '当前周期无成交聚合' : state.flowSyncing ? '成交回补中' : state.flowConnected ? '成交流已连接' : '等待成交流';
  const locate = (item: SignalItem, anchor = item.ts) => {
    try {
      const ms = tfMs(state.timeframe);
      ctx.chart.setVisibleRange({ from: Math.max(item.fromTs, anchor - ms * 180) - ms * 14, to: anchor + ms * 24 });
      setLocated(item.id);
      if (item.story) store.focus(item.id);
    } catch { ctx.toast('图表仍在加载，请稍后重试', 'info'); }
  };
  const empty = (mw: boolean) => <div className="sa-empty"><p>{!prefs.enabled ? '标注已隐藏' : mw ? '当前没有正在跟踪的双顶 / 双底' : '未开启辅助观察或暂无记录'}</p><span>{!prefs.enabled ? '已保留选择，可随时恢复。' : mw ? `等待二次测试收盘确认；${allStories.length ? '可切换「含历史」查看已结束记录。' : '不会为了显示信号而降低规则。'}` : '辅助背景默认关闭，可在显示设置中选择。'}</span>{!prefs.enabled && <button type="button" onClick={() => store.patch({ enabled: true })}>恢复标注</button>}</div>;

  return <div className="sa-panel" role="region" aria-label="信号标注设置">
    <div className="sa-toolbar">
      <div className="sa-market"><div className="sa-market-symbol"><strong>{state.symbol.split('-')[0] || '—'}</strong><span>USDT</span><span className="sa-timeframe">{tfLabel(state.timeframe)}</span></div><span className="sa-market-status">{statusText}</span></div>
      <div className="sa-master"><span>双顶 / 双底观察</span><Toggle checked={prefs.enabled} label="显示信号标注" onChange={() => store.patch({ enabled: !prefs.enabled })} /></div>
      <div className="sa-bulk"><span>主线优先 · 证据可查</span><div><button type="button" onClick={() => store.allOn()}>全部开启</button><span aria-hidden="true" /><button type="button" onClick={() => store.allOff()}>全部关闭</button></div></div>
    </div>
    <div className="sa-tabs" role="tablist" aria-label="标注侧栏视图">
      {([['mw', '双顶双底', stories.length], ['context', '辅助记录', background.length], ['types', '显示设置', null]] as const).map(([id, title, count]) =>
        <button key={id} id={`sa-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="sa-tab-content" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{title}{count !== null && <span>{count}</span>}</button>)}
    </div>
    <div className="sa-content">
      <div id="sa-tab-content" role="tabpanel" aria-labelledby={`sa-tab-${tab}`}>
        {state.status === 'error' && <div className="sa-alert" role="status"><Info size={13} /><span>{state.message}</span></div>}
        {tab === 'types' ? <>
          {(['mw', 'context'] as const).map(group => <section className="sa-group" key={group} aria-label={group === 'mw' ? '双顶双底标注' : '辅助背景'}>
            <div className="sa-group-heading"><h3>{group === 'mw' ? '双顶 / 双底' : '辅助背景 · 按需开启'}</h3><span>可用数</span></div>
            <div className="sa-type-list">{SIGNAL_TYPES.filter(t => t.group === group).map(type => <div className={`sa-type ${prefs.selected[type.id] ? 'is-selected' : ''}`} key={type.id} data-signal-type={type.id}>
              <div className="sa-type-main"><div className="sa-type-name"><span>{type.name}</span><button type="button" className="sa-info" aria-label={`查看${type.name}规则`} aria-expanded={help === type.id} onClick={() => setHelp(help === type.id ? null : type.id)}><Info size={12} /></button></div><span className="sa-count" title="回看范围内符合条件的数量，区带/结构补充计为可用形态，不额外生成记录。">{loading ? '—' : state.counts[type.id]}</span><Toggle checked={prefs.selected[type.id]} label={`${type.name}标注`} onChange={() => store.toggle(type.id)} /></div>
              {help === type.id && <div className="sa-rule"><p>{type.description}</p><p>{type.rule}</p></div>}
            </div>)}</div>
          </section>)}
          <p className="sa-flow-note">{!state.flowSupported ? '该周期无真实成交聚合；可切至5m等支持周期。' : '真实主动成交只作证据，非订单簿 OFI，也不是胜率。'} 四类成交/陷阱证据已并入每个形态详情。</p>
        </> : tab === 'mw' ? <div className="sa-mw-list">
          <div className="sa-mw-filter" role="group" aria-label="形态记录范围"><button type="button" aria-pressed={!history} onClick={() => { setHistory(false); setShown(12); }}>正在跟踪 {activeStories.length}</button><button type="button" aria-pressed={history} onClick={() => { setHistory(true); setShown(12); }}>含历史 {allStories.length}</button></div>
          <div className="sa-recent-heading"><span>最近 {prefs.lookback} 根 · 一形态一条</span><span>点击展开 / 定位</span></div>
          {stories.length ? stories.slice(0, shown).map(item => <article key={item.id} className={`sa-story-record ${focused === item.id ? 'is-expanded' : ''}`} data-story-id={item.id} data-tone={item.tone}>
            <button type="button" className={`sa-record ${located === item.id ? 'is-located' : ''}`} aria-expanded={focused === item.id} onClick={() => { const closing = focused === item.id; setExpanded(closing ? '' : item.id); if (closing) store.focus(null); else locate(item); }}>
              <span className="sa-record-copy"><strong>{item.title}</strong><span>{formatTime(item.story!.lastActivityAt)} UTC · {item.story!.active ? '正在观察' : '历史记录'} · 力量{item.story!.evidence.strength.label}</span></span><Crosshair size={13} className="sa-locate-icon" />
            </button>
            {focused === item.id && <MwStoryDetails item={item} smc={prefs.selected.smartMoney} onTime={at => locate(item, at)} />}
          </article>) : empty(true)}
          {stories.length > shown && <button type="button" className="sa-more" onClick={() => setShown(n => n + 12)}>显示更多形态（剩余 {stories.length - shown}）</button>}
        </div> : <div className="sa-recent"><div className="sa-recent-heading"><span>辅助盘面记录</span><span>点击定位</span></div>
          {background.length ? background.slice(0, 30).map(item => <div key={item.id}><button type="button" className={`sa-record ${located === item.id ? 'is-located' : ''}`} onClick={() => locate(item)}><span className="sa-record-copy"><strong>{item.title}</strong><span>{formatTime(item.ts)} UTC</span></span><span className="sa-record-meta"><span>{SOURCE_LABELS[item.source]}</span><small>{item.confirmed ? '已收盘' : '预览'}</small></span><Crosshair size={13} className="sa-locate-icon" /></button>{located === item.id && <ul className="sa-context-detail">{item.detail.map((s, i) => <li key={i}>{s}</li>)}</ul>}</div>) : empty(false)}
          {background.length > 30 && <p className="sa-list-note">仅列出最新30条辅助记录，双顶双底在主线页签。</p>}
        </div>}
      </div>
      <details className="sa-options"><summary><span>运行与显示</span><ChevronDown size={13} /></summary><div className="sa-options-body">
        <div className="sa-option"><span>标签文字</span><Toggle checked={prefs.labels} label="显示标签文字" onChange={() => store.patch({ labels: !prefs.labels })} /></div>
        <div className="sa-option"><span>结构连线</span><Toggle checked={prefs.geometry} label="显示结构连线" onChange={() => store.patch({ geometry: !prefs.geometry })} /></div>
        <div className="sa-option"><span>回看范围</span><select aria-label="标注回看范围" value={prefs.lookback} onChange={e => store.patch({ lookback: Number(e.target.value) as 300 | 600 | 1200 })}>{[300, 600, 1200].map(n => <option key={n} value={n}>最近 {n} 根</option>)}</select></div>
        <div className="sa-option"><span>盘中 / Δ 预览<small>单独提示，不改收盘阶段</small></span><Toggle checked={prefs.preview} label="未收盘预览" onChange={() => store.patch({ preview: !prefs.preview })} /></div>
        <div className="sa-option"><span>允许 K 线近似<small>仅用于辅助成交力度</small></span><Toggle checked={prefs.allowApprox} label="允许K线近似" onChange={() => store.patch({ allowApprox: !prefs.allowApprox })} /></div>
        {prefs.allowApprox && <p className="sa-approx-warning">≈ 不是主动成交；不进入形态成交证据、陷阱佐证或CVD。</p>}
        <p className="sa-settings-note">设置保存在本机；旧版共有设置自动迁移。</p>
      </div></details>
      <p className="sa-hint">收起侧栏继续跟踪 · 不下单 / 不承诺回踩</p>
    </div>
    <div className="sa-data-status" title="真实覆盖是当前分析范围中买卖成交额完整的K线根数，不是信号数。">
      <div><span className="sa-connection"><i className={`sa-dot ${state.flowConnected && prefs.enabled ? 'is-live' : ''}`} />{flowText}</span><span className="sa-coverage">{state.covered} / {state.bars} 根</span></div>
      <div><span>{state.gapTruncated ? `缺口截断 · 回看${state.requested}` : state.historyShort ? `历史不足 · 请求${state.requested}` : '真实成交覆盖'}</span><span>{state.updatedAt ? `${formatTime(state.updatedAt)} UTC` : '等待行情'}</span></div>
    </div>
  </div>;
}
