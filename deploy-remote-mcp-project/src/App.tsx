import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
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

// 运行时（本地持久化 + /api 路由）在后台初始化；不再阻塞首屏，也没有启动动画
void startRuntime().catch(reason => {
  console.warn('Preview runtime 初始化失败（本地持久化不可用，图表不受影响）:', reason);
});

const Fallback = ({ text }: { text?: string }) => (
  <div
    style={{
      minHeight: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0d13',
      color: '#8c96ab',
      fontSize: 13,
      letterSpacing: '0.08em',
    }}
    role="status"
    aria-live="polite"
  >
    {text ?? '加载中…'}
  </div>
);

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
  const [engine, setEngine] = useState(false);
  const hash = useHash();

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

  if (hash === '#legacy') {
    return (
      <Suspense fallback={<Fallback text="正在加载原始 PULSEDESK 页面…" />}>
        <LegacyPage />
      </Suspense>
    );
  }

  return (
    <div className="terminal-root">
      <Suspense fallback={<Fallback />}>
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
