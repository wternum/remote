import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { startRuntime } from './runtime/bootstrap';

// 新外壳：Vela 工作区（vela.luxalgo.com 同款 UI）+ OKX 数据
const VelaTerminal = lazy(() => import('./vela/VelaTerminal'));
const IndicatorPickerHost = lazy(() => import('./vela/IndicatorPickerDialog'));
const MarketControlsHost = lazy(() => import('./vela/marketControls'));
// 入场确认引擎的完整分析面板（校准 / 样本外 / 寻优）
const ConfirmEnginePanel = lazy(() => import('./components/confirm/ConfirmEnginePanel'));
// 四框架结构分析（SMC 扫损 / 多周期分形 / Wyckoff·失衡 / 拍卖市场 AMT）
const FrameworksPanel = lazy(() => import('./components/FrameworksPanel'));
const FrameworkBar = lazy(() => import('./components/FrameworkBar'));
// 原 PULSEDESK 页面（远程项目原样），可通过 #legacy 访问
const LegacyPage = lazy(() => import('../remote/setup-mcp-project-locally/src/app/page'));
// 缺陷修复任务卡（构造 / 策略 / 订单流审计），可通过 #audit 访问
const AuditBoard = lazy(() => import('./audit/AuditBoard'));

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
  const [frameworks, setFrameworks] = useState(false);
  const hash = useHash();

  // 快捷键 C：开合确认引擎；F：开合四框架结构分析（输入框内不拦截；Vela 自己的快捷键不受影响）
  const onKey = useCallback((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input,textarea,select,[contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && e.shiftKey) {
      e.preventDefault();
      setEngine(p => !p);
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      setFrameworks(p => !p);
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

  if (hash === '#audit') {
    return (
      <Suspense fallback={<Fallback text="正在加载缺陷修复任务卡…" />}>
        <AuditBoard />
      </Suspense>
    );
  }

  return (
    <div className="terminal-root">
      <Suspense fallback={<Fallback />}>
        <VelaTerminal />
      </Suspense>
      <Suspense fallback={null}>
        <FrameworkBar panelOpen={frameworks} onTogglePanel={() => setFrameworks(p => !p)} />
      </Suspense>
      <Suspense fallback={null}>
        <IndicatorPickerHost />
      </Suspense>
      <Suspense fallback={null}>
        <MarketControlsHost />
      </Suspense>
      <Suspense fallback={null}>{engine && <ConfirmEnginePanel open={engine} onClose={() => setEngine(false)} />}</Suspense>
      <Suspense fallback={null}>{frameworks && <FrameworksPanel open={frameworks} onClose={() => setFrameworks(false)} />}</Suspense>
    </div>
  );
}
