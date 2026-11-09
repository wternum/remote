import { useEffect, useRef } from 'react';
import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerLocale, unregisterSidePanel, unregisterWidgetAction } from '@luxalgo/vela';
import { localStorageAdapter, decodeState, encodeState } from '@luxalgo/vela/widget';
import zhHans from '@luxalgo/vela/locales/zh-Hans';
import { OKXProvider, OKX_TIMEFRAMES } from './okxProvider';
import { registerIndicatorPicker } from './registerIndicatorPicker';
import { registerMarketControls } from './marketControls';
import { installVelaHitFix } from './hitFix';
import { installStackGuard } from './stackGuard';
import { syncTopbarLabels } from './topbarLabels';
import { enhanceDrawingMenus } from '../lib/drawing-menu';
import { installQuantHover } from './toolbarSlide';
import { installToolbarHover } from './toolbarHover';
import { registerAnnotLayers } from './annotLayer';
import { registerSignalPanel } from './registerSignalPanel';
import { registerSessionLayers } from './sessions/sessionLayer';
import { registerFrameworkMarking } from './frameworkRuntime';

// 逐棒审计侧栏已下线：同时清理旧注册，避免热更新/持久布局留下入口。
unregisterSidePanel('pulsedesk-price-action');
unregisterWidgetAction('pd-price-action');

// 一次性注册：语言包、指标、标注侧栏及其独立运行器（构造前完成）
registerLocale(zhHans);
registerIndicatorPicker();
registerMarketControls();
registerSignalPanel();
// 系统标注图层与交易时段图层：渲染器在构造时按注册表实例化图层，必须先于 new VelaWorkspace
registerAnnotLayers();
registerSessionLayers();
registerFrameworkMarking();

/** Remove retired audit-panel references from old persisted layouts before Vela restores them. */
export function workspaceStorage() {
  const base = localStorageAdapter('pulsedesk-vela-workspace');
  const clean = (raw: string | null): string | null => {
    if (!raw) return raw;
    try {
      const state = decodeState(raw);
      if (!state?.panels) return raw;
      let changed = false;
      if (state.panels.open === 'pulsedesk-price-action') { delete state.panels.open; changed = true; }
      if (state.panels.pinned?.includes('pulsedesk-price-action')) { state.panels.pinned = state.panels.pinned.filter(id => id !== 'pulsedesk-price-action'); changed = true; }
      if (state.panels.widths && 'pulsedesk-price-action' in state.panels.widths) { delete state.panels.widths['pulsedesk-price-action']; changed = true; }
      return changed ? encodeState(state) : raw;
    } catch { return raw; }
  };
  return {
    get: async (key: string) => clean(await base.get(key)),
    set: async (key: string, value: string) => { const next = clean(value); if (next != null) await base.set(key, next); },
    remove: async (key: string) => { await base.remove?.(key); },
  };
}

export interface VelaTerminalProps {
  symbol?: string;
  timeframe?: string;
  onReady?: (ws: VelaWorkspace) => void;
}

/**
 * vela.luxalgo.com 同款外壳：顶栏（搜索/周期/样式/指标/撤销）· 左侧绘图栏 ·
 * 状态行 · 符号水印 · 底部区间栏 —— 数据源换成 OKX 永续。
 */
// 默认 5m：双顶/双底 + 订单流判读聚焦的短线周期（已保存的工作区状态优先）
export default function VelaTerminal({ symbol = 'okx:BTC-USDT-SWAP', timeframe = '5', onReady }: VelaTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<VelaWorkspace | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let ws: VelaWorkspace | null = null;
    const unfix = installVelaHitFix();
    const unguard = installStackGuard(host);
    let unhover: (() => void) | null = null;
    let unhoverMenus: (() => void) | null = null;
    let unsync: (() => void) | null = null;
    let stopEnhancingDrawings: (() => void) | null = null;
    let symbolGuard = 0;
    try {
      ws = new VelaWorkspace(host, {
        layout: false,
        symbol,
        timeframe,
        live: true,
        theme: 'dark',
        locale: 'zh-Hans',
        timezone: 'Etc/UTC',
        providers: { okx: () => new OKXProvider() },
        timeframes: [...OKX_TIMEFRAMES],
        volume: true,
        // Native tool selection is retained; drawing-toolbar.css only styles the shell.
        drawingToolbar: true,
        upColor: '#2ebd85',
        downColor: '#f6465d',
        glow: 0.25,
        persist: 'pulsedesk-vela-workspace',
        storage: workspaceStorage(),
        autofocus: true,
        // 周期 / 样式 / 指标 都由本模块接管（内置弹层与画布有命中冲突）
        topbar: {
          left: ['symbol', 'pd-timeframes', 'pd-style', 'indicators', 'actions', 'undo-redo'],
          right: ['actions', 'alerts', 'panels', 'screenshot'],
        },
      });
      wsRef.current = ws;
      // 调试 / 测试入口（生产无副作用）
      (window as unknown as { __velaWs?: VelaWorkspace }).__velaWs = ws;
      stopEnhancingDrawings = enhanceDrawingMenus(ws.root);
      unhover = installQuantHover(ws.root);
      unhoverMenus = installToolbarHover(ws.root);
      // The picker is limited to BTC/ETH/SOL; a persisted removed symbol falls back to BTC.
      symbolGuard = window.setTimeout(() => {
        try {
          const base = (ws?.chart.market.symbol ?? '').replace(/^okx:/i, '').split('-')[0].toUpperCase();
          if (base && !['BTC', 'ETH', 'SOL'].includes(base)) {
            void ws?.chart.setMarket({ symbol: 'okx:BTC-USDT-SWAP' });
          }
        } catch {
          /* Market not ready: the next load keeps the provider's default. */
        }
      }, 1600);
      // 顶栏按钮显示当前周期 / 样式值
      unsync = syncTopbarLabels(ws.root, ws);
      onReady?.(ws);
    } catch (e) {
      console.error('VelaWorkspace 初始化失败', e);
    }
    return () => {
      window.clearTimeout(symbolGuard);
      unhoverMenus?.();
      stopEnhancingDrawings?.();
      unhover?.();
      unsync?.();
      unfix();
      unguard();
      try {
        ws?.destroy();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="vela-host" />;
}
