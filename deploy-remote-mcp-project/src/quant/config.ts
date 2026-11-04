// 确认引擎的可调参数：概率门槛 + 入场方式。UI 与实盘检测共用同一份状态。
export type EntryMode = 'confirm' | 'touch';

export interface EngineConfig {
  /** 概率门槛：低于该值不入场 */
  threshold: number;
  /** confirm = 等拒绝K收盘确认；touch = 触价即成交（原项目默认行为，用于 A/B 对照） */
  entryMode: EntryMode;
  /** true 时门槛同时替换原项目的结构质量过滤（CONF_MIN） */
  replaceConfFilter: boolean;
}

/**
 * 默认门槛 58%（B 级 · 标准执行档）：单币种单周期样本较小时仍能出信号，
 * 避免界面长期空转。面板的「门槛扫描 / 跳到样本内最优」显示更严格的档位
 * （3 币种 × 双周期样本上 66–72% 才把期望值明显做正），由使用者按数据决定。
 */
export const DEFAULT_CONFIG: EngineConfig = {
  threshold: 0.58,
  entryMode: 'confirm',
  replaceConfFilter: true,
};

export const LIMITS = { min: 0.42, max: 0.82, step: 0.005 } as const;

const KEY = 'pulsedesk.confirm-engine.v1';
let current: EngineConfig = { ...DEFAULT_CONFIG };
const listeners = new Set<(c: EngineConfig) => void>();

function read(): EngineConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<EngineConfig>;
    return {
      threshold: typeof parsed.threshold === 'number' ? parsed.threshold : DEFAULT_CONFIG.threshold,
      entryMode: parsed.entryMode === 'touch' ? 'touch' : 'confirm',
      replaceConfFilter: parsed.replaceConfFilter ?? DEFAULT_CONFIG.replaceConfFilter,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// 服务端（Next 路由）读不到 localStorage，因此把同一份配置镜像到非敏感 cookie，
// 让 /api/backtest 等服务端回测使用与 UI 完全相同的门槛 / 入场方式。
export const CONFIG_COOKIE = 'pulsedesk.confirm-engine';

export interface EngineConfigOverrides {
  threshold?: number;
  entryMode?: EntryMode;
  replaceConfFilter?: boolean;
}

function writeCookie(cfg: EngineConfig) {
  try {
    if (typeof document === 'undefined') return;
    const value = encodeURIComponent(
      JSON.stringify({ t: cfg.threshold, m: cfg.entryMode, r: cfg.replaceConfFilter ? 1 : 0 }),
    );
    document.cookie = `${CONFIG_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 从 Cookie 头还原配置（仅服务端路由使用；非法内容一律忽略） */
export function configFromCookie(header: string | null | undefined): EngineConfigOverrides {
  if (!header) return {};
  try {
    const part = header
      .split(';')
      .map(s => s.trim())
      .find(s => s.startsWith(`${CONFIG_COOKIE}=`));
    if (!part) return {};
    const raw = JSON.parse(decodeURIComponent(part.slice(CONFIG_COOKIE.length + 1))) as {
      t?: number;
      m?: string;
      r?: number;
    };
    const out: EngineConfigOverrides = {};
    if (typeof raw.t === 'number' && Number.isFinite(raw.t)) out.threshold = clampThreshold(raw.t);
    if (raw.m === 'touch' || raw.m === 'confirm') out.entryMode = raw.m;
    if (raw.r === 0 || raw.r === 1) out.replaceConfFilter = raw.r === 1;
    return out;
  } catch {
    return {};
  }
}

function write(cfg: EngineConfig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 隐私模式忽略 */
  }
  writeCookie(cfg);
}

export function getConfig(): EngineConfig {
  return current;
}

export function setConfig(patch: Partial<EngineConfig>): EngineConfig {
  current = { ...current, ...patch };
  write(current);
  listeners.forEach(fn => fn(current));
  window.dispatchEvent(new CustomEvent('pulsedesk:confirm-config', { detail: current }));
  return current;
}

export function subscribeConfig(fn: (c: EngineConfig) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') {
  current = read();
  // 多标签页共享同一份门槛
  window.addEventListener('storage', event => {
    if (event.key === KEY) {
      current = read();
      listeners.forEach(fn => fn(current));
    }
  });
}

export function clampThreshold(v: number) {
  return Math.min(LIMITS.max, Math.max(LIMITS.min, Math.round(v / LIMITS.step) * LIMITS.step));
}
