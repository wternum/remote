import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, BarChart3, Check, ChevronRight, Compass, Heart, Layers3, LineChart, Search, SlidersHorizontal, Star, Waves, X } from 'lucide-react';
import type { Vela } from '@luxalgo/vela';
import { nativeIndicatorDescriptors } from '@luxalgo/vela';
import { onIndicatorPicker } from './indicatorStore';
import { barsHub } from './okxProvider';

type Category = 'discover' | 'favorites' | 'all' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'structure';
type Row = { type: string; title: string; overlay: boolean; beta: boolean; category: Exclude<Category, 'discover' | 'favorites' | 'all'> };
const FAVORITES_KEY = 'pulsedesk-indicator-favorites';
const FEATURED = ['ema', 'rsi', 'macd'];

function categoryOf(type: string, title: string): Row['category'] {
  const value = `${type} ${title}`.toLowerCase();
  if (/volume|vwap|money flow|chaikin|accumulation|on.balance|obv|force index|adl|market profile/.test(value)) return 'volume';
  if (/rsi|momentum|stochastic|macd|oscillator|cci|williams|roc|trix|fisher|strength index/.test(value)) return 'momentum';
  if (/volatil|bollinger|band|atr|average true|keltner|donchian|std|channel|range/.test(value)) return 'volatility';
  if (/pivot|zigzag|fractal|high.low|support|resistance|structure/.test(value)) return 'structure';
  return 'trend';
}

function readFavorites(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}

const descriptions: Record<string, string> = {
  ema: '指数移动平均线会为近期价格赋予更高权重，帮助辨识趋势方向和动态支撑、阻力。可以与价格行为形态结合使用。',
  sma: '简单移动平均线以所选周期内的收盘价计算均值，平滑价格波动，观察市场趋势和潜在交叉信号。',
  rsi: '相对强弱指数衡量价格上涨与下跌的动量。结合双顶双底时，可观察第二次测试是否出现动量背离。',
  macd: '移动平均收敛/发散指标通过快慢均线观察趋势动量。柱状图缩短时，可作为形态推进减速的参考。',
  volume: '成交量展示每根 K 线的交易活跃程度。形态二次测试缩量或放量，是确认入场的重要上下文。',
};

function describe(row: Row): string {
  const key = row.type.toLowerCase();
  const match = Object.keys(descriptions).find(word => key === word || key.includes(word));
  return match ? descriptions[match] : `${row.title} 是 Vela 内置${row.overlay ? '主图叠加' : '副图'}指标。添加后可在图表图例中打开设置、调整参数或移除。指标仅供辅助分析，不能独立作为交易依据。`;
}

function ChartPreview({ chart, variant }: { chart: Vela; variant?: string }) {
  const bars = barsHub.get((chart.market.symbol || '').replace(/^okx:/i, ''), chart.market.timeframe || '15').slice(-36);
  if (bars.length < 3) return <div className="ip-preview-empty">图表数据加载中</div>;
  const min = Math.min(...bars.map(b => b.low));
  const span = Math.max(...bars.map(b => b.high)) - min || 1;
  const closes = bars.map(b => b.close);
  const ema = (period: number) => {
    const k = 2 / (period + 1);
    let value = closes[0];
    return closes.map(close => (value = close * k + value * (1 - k)));
  };
  const isMomentum = /rsi|macd|oscillator|stoch/i.test(variant || '');
  const fast = ema(7);
  const slow = ema(17);
  const momentum = fast.map((value, i) => value - slow[i]);
  const peak = Math.max(...momentum.map(Math.abs), 0.00001);
  return <svg className="ip-chart-preview" viewBox="0 0 300 152" preserveAspectRatio="none" aria-label="当前市场最近 36 根 K 线">
    {[35, 75, 115].map(y => <path key={y} d={`M0 ${y} H300`} stroke="#252831" strokeWidth="1" />)}
    {!isMomentum && bars.map((b, i) => {
      const x = 8 + i * 8;
      const y = (price: number) => 140 - ((price - min) / span) * 126;
      return <g key={b.time} stroke={b.close >= b.open ? '#089981' : '#f23645'}>
        <path d={`M${x} ${y(b.high)}V${y(b.low)}`} strokeWidth="1" />
        <path d={`M${x} ${y(b.open)}V${y(b.close)}`} strokeWidth="4" />
      </g>;
    })}
    {!isMomentum && variant && <polyline fill="none" stroke="#e0b400" strokeWidth="1.5" points={fast.map((price, i) => `${8 + i * 8},${140 - ((price - min) / span) * 126}`).join(' ')} />}
    {isMomentum && momentum.map((value, i) => <path key={i} d={`M${8 + i * 8} 76 V${76 - value / peak * 54}`} stroke={value >= 0 ? '#089981' : '#f23645'} strokeWidth="4" />)}
    {isMomentum && <polyline fill="none" stroke="#e0b400" strokeWidth="1.5" points={momentum.map((value, i) => `${8 + i * 8},${76 - value / peak * 54}`).join(' ')} />}
  </svg>;
}

function IndicatorDialog({ chart, onClose }: { chart: Vela; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('discover');
  const [selected, setSelected] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(readFavorites);
  const [active, setActive] = useState<Set<string>>(() => new Set(chart.indicators().map(h => h.nativeType).filter((v): v is string => !!v)));
  const searchRef = useRef<HTMLInputElement>(null);
  const rows = useMemo<Row[]>(() => nativeIndicatorDescriptors().map(d => ({
    type: d.type, title: d.title, overlay: !!d.overlay, beta: !!d.beta, category: categoryOf(d.type, d.title),
  })), []);
  const current = rows.find(r => r.type === selected) || rows.find(r => r.type.toLowerCase().includes('ema')) || rows[0];
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return rows.filter(row => {
      if (category === 'favorites' && !favorites.has(row.type)) return false;
      if (!['discover', 'favorites', 'all'].includes(category) && row.category !== category) return false;
      return !text || `${row.title} ${row.type} ${row.category}`.toLowerCase().includes(text);
    });
  }, [rows, category, query, favorites]);
  const featured = FEATURED.map(term => rows.find(r => r.type.toLowerCase() === term) || rows.find(r => r.type.toLowerCase().includes(term))).filter((r): r is Row => !!r);

  function toggleFavorite(type: string) {
    setFavorites(previous => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type); else next.add(type);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function toggleIndicator(row: Row) {
    try {
      if (active.has(row.type)) chart.indicators().find(h => h.nativeType === row.type)?.remove();
      else chart.addNativeIndicator(row.type);
      setActive(new Set(chart.indicators().map(h => h.nativeType).filter((v): v is string => !!v)));
    } catch (error) { console.warn('切换指标失败', row.type, error); }
  }

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nav: { id: Category; label: string; icon: typeof Search }[] = [
    { id: 'discover', label: '发现', icon: Compass }, { id: 'favorites', label: '收藏', icon: Star },
    { id: 'all', label: '全部指标', icon: Layers3 }, { id: 'trend', label: '趋势', icon: LineChart },
    { id: 'momentum', label: '动量', icon: Activity }, { id: 'volatility', label: '波动率', icon: Waves },
    { id: 'volume', label: '成交量与资金流', icon: BarChart3 }, { id: 'structure', label: '结构', icon: SlidersHorizontal },
  ];

  return createPortal(<div className="ip-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <section className="ip-dialog" role="dialog" aria-modal="true" aria-label="指标">
      <header className="ip-head">
        <strong>指标</strong>
        <label className="ip-search"><Search size={17} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索指标、类别或关键词" aria-label="搜索指标" /></label>
        <button className="ip-x" onClick={onClose} aria-label="关闭"><X size={19} /></button>
      </header>
      <div className="ip-layout">
        <nav className="ip-nav" aria-label="指标分类">
          <div className="ip-nav-title">个人</div>
          {nav.slice(1, 2).map(item => <button key={item.id} className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}><item.icon size={16} />{item.label}<small>{favorites.size}</small></button>)}
          <div className="ip-nav-title">内置</div>
          {nav.slice(2, 3).map(item => <button key={item.id} className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}><item.icon size={16} />{item.label}<small>{rows.length}</small></button>)}
          <div className="ip-nav-title">探索</div>
          {nav.slice(0, 1).map(item => <button key={item.id} className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}><item.icon size={16} />{item.label}</button>)}
          <div className="ip-nav-title">分类</div>
          {nav.slice(3).map(item => <button key={item.id} className={category === item.id ? 'on' : ''} onClick={() => setCategory(item.id)}><item.icon size={16} />{item.label}<small>{rows.filter(r => r.category === item.id).length}</small></button>)}
        </nav>
        <main className="ip-main" aria-label="指标列表">
          {category === 'discover' && !query && <>
            <div className="ip-section-heading"><strong>常用指标</strong><span>精选 Vela 内置指标</span></div>
            <div className="ip-featured">{featured.map(row => <button key={row.type} className={`ip-feature ${selected === row.type ? 'selected' : ''}`} onClick={() => setSelected(row.type)}>
              <span className="ip-feature-graph"><ChartPreview chart={chart} variant={row.type} /></span><span className="ip-feature-title">{row.title}</span>
              <span className="ip-feature-meta">{row.overlay ? '主图 · 趋势' : '副图 · 动量'}</span>
            </button>)}</div>
          </>}
          <div className="ip-section-heading"><strong>{query ? `搜索结果 · ${filtered.length}` : category === 'discover' ? '所有内置指标' : nav.find(x => x.id === category)?.label}</strong><span>{filtered.length} 个可用</span></div>
          <div className="ip-results">{filtered.map(row => <div key={row.type} className={`ip-result ${current?.type === row.type ? 'selected' : ''}`}>
            <button className="ip-result-select" onClick={() => setSelected(row.type)}>
              <span className="ip-result-symbol">{row.overlay ? <LineChart size={18} /> : <Activity size={18} />}</span>
              <span><strong>{row.title}</strong><small>{row.overlay ? '主图叠加' : '独立副图'} · {nav.find(x => x.id === row.category)?.label}</small></span>
              {active.has(row.type) && <span className="ip-added"><Check size={12} /> 已添加</span>}
              {row.beta && <span className="ip-beta">BETA</span>}
            </button>
            <button className={`ip-star ${favorites.has(row.type) ? 'on' : ''}`} onClick={() => toggleFavorite(row.type)} aria-label={`${favorites.has(row.type) ? '取消收藏' : '收藏'} ${row.title}`}><Star size={16} fill={favorites.has(row.type) ? 'currentColor' : 'none'} /></button>
          </div>)}{filtered.length === 0 && <div className="ip-empty">没有找到匹配的指标。试试其他关键词或分类。</div>}</div>
        </main>
        <aside className="ip-detail" aria-label="指标详情">{current && <>
          <div className="ip-detail-preview"><ChartPreview chart={chart} variant={current.type} /></div>
          <div className="ip-detail-body"><span className="ip-detail-kicker">{current.overlay ? '主图叠加' : '独立副图'} · Vela 内置</span><h2>{current.title}</h2><p>{describe(current)}</p></div>
          <div className="ip-detail-actions"><button className={`ip-add ${active.has(current.type) ? 'is-added' : ''}`} onClick={() => toggleIndicator(current)}>{active.has(current.type) ? <><Check size={16} /> 已添加 · 点击移除</> : <>添加到图表 <ChevronRight size={17} /></>}</button><button className={`ip-favorite ${favorites.has(current.type) ? 'on' : ''}`} onClick={() => toggleFavorite(current.type)}><Heart size={16} fill={favorites.has(current.type) ? 'currentColor' : 'none'} />{favorites.has(current.type) ? '已收藏' : '收藏'}</button></div>
        </>}</aside>
      </div>
      <footer className="ip-foot"><span>Esc 关闭 <span className="ip-foot-sep">·</span> 可连续添加多个指标</span><span>{rows.length} 个内置指标 <span className="ip-foot-sep">·</span> 已添加 {active.size}</span></footer>
    </section>
  </div>, document.body);
}

export default function IndicatorPickerHost() {
  const [chart, setChart] = useState<Vela | null>(null);
  useEffect(() => onIndicatorPicker(setChart), []);
  return chart ? <IndicatorDialog chart={chart} onClose={() => setChart(null)} /> : null;
}
