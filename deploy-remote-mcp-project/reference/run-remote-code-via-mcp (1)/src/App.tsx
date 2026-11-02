import { Suspense, lazy, useCallback, useEffect, useState, type CSSProperties } from 'react';
import { startRuntime } from './runtime/bootstrap';
import { bindEngineOpener } from './vela/registerTradePanel';

// 新外壳：Vela 工作区（vela.luxalgo.com 同款 UI）+ OKX 数据 + 右侧「交易」侧栏
const VelaTerminal = lazy(() => import('./vela/VelaTerminal'));
const IndicatorPickerHost = lazy(() => import('./vela/IndicatorPickerDialog'));
const MarketControlsHost = lazy(() => import('./vela/marketControls'));
// 入场确认引擎的完整分析面板（校准 / 样本外 / 寻优）
const ConfirmEnginePanel = lazy(() => import('./components/confirm/ConfirmEnginePanel'));
// 原 PULSEDESK 页面（远程项目原样），可通过 #legacy 访问
const LegacyPage = lazy(() => import('../remote/setup-mcp-project-locally/src/app/page'));

const runtime = startRuntime();

const screenStyle: CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 18,
  background: '#0a0d13',
  color: '#e7ecf5',
  fontFamily: '"Space Grotesk", "Microsoft YaHei", sans-serif',
};

function BootScreen({ error = false, text }: { error?: boolean; text?: string }) {
  return (
    <div style={screenStyle} role="status" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className={error ? '' : 'pulse-dot'} style={{ width: 9, height: 9, borderRadius: '50%', background: error ? '#f6465d' : '#2ebd85' }} />
        <strong style={{ fontSize: 25, letterSpacing: '0.12em' }}>PULSEDESK</strong>
      </div>
      <p style={{ margin: 0, color: '#8c96ab', fontSize: 13 }}>{error ? '运行环境加载失败，请刷新页面重试。' : text ?? '正在启动图表工作区…'}</p>
      {error && (
        <button className="btn-ghost" onClick={() => window.location.reload()}>
          重新加载
        </button>
      )}
    </div>
  );
}

const useHash = () => {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [engine, setEngine] = useState(false);
  const hash = useHash();

  useEffect(() => {
    let active = true;
    runtime
      .then(() => active && setReady(true))
      .catch(reason => {
        console.error('Preview runtime failed:', reason);
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    bindEngineOpener(() => setEngine(true));
  }, []);

  // 快捷键 C：开合确认引擎（输入框内不拦截；Vela 自己的快捷键不受影响）
  const onKey = useCallback((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.key.toLowerCase() === 'c' && e.shiftKey && !t?.closest('input,textarea,select,[contenteditable="true"]')) {
      e.preventDefault();
      setEngine(p => !p);
    }
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  if (error) return <BootScreen error />;
  if (!ready) return <BootScreen />;

  if (hash === '#legacy') {
    return (
      <Suspense fallback={<BootScreen text="正在加载原始 PULSEDESK 页面…" />}>
        <LegacyPage />
      </Suspense>
    );
  }

  return (
    <div className="terminal-root">
      <Suspense fallback={<BootScreen />}>
        <VelaTerminal />
      </Suspense>
      <Suspense fallback={null}>
        <IndicatorPickerHost />
      </Suspense>
      <Suspense fallback={null}>
        <MarketControlsHost />
      </Suspense>
      <Suspense fallback={null}>{engine && <ConfirmEnginePanel open={engine} onClose={() => setEngine(false)} />}</Suspense>
    </div>
  );
}
