/** Session clock conventions. Fixed UTC presets are teaching windows, not exchange local hours.
 *
 * 性能约定（本地夏令时卡顿修复，2026-11）：
 * - Intl.DateTimeFormat 构造非常昂贵（~0.1ms+/次），必须按 zone 复用；
 * - 同一 UTC 日的窗口/换算结果确定不变（IANA 表在会话内静态），按天/按键缓存；
 * - 缓存有界（setBounded），防止任意时间范围把内存撑大；
 * - 返回的数组/对象被冻结，调用方只读，避免共享缓存被意外改写。
 */
import { setBounded } from '../../lib/lru';

export type SessionClockMode = 'fixed' | 'local';
export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setBounded(formatters, zone, f, 8);
  }
  return f;
}
const parts = (zone: string, ms: number) => {
  const o: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
};
export function zoneOffsetMs(zone: string, ms: number): number {
  const p = parts(zone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const wallCache = new Map<string, number>();
export function localWallToUtc(zone: string, dayMs: number, minutes: number): number {
  const key = `${zone}|${dayMs}|${minutes}`;
  const hit = wallCache.get(key);
  if (hit !== undefined) return hit;
  const d = new Date(dayMs);
  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + minutes * 60_000;
  let utc = guess - zoneOffsetMs(zone, guess);
  utc = guess - zoneOffsetMs(zone, utc);
  setBounded(wallCache, key, utc, 2048);
  return utc;
}
export interface ClockWindow { id: string; startMs: number; endMs: number; label: string; localLabel: string; }
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

const windowsCache = new Map<string, readonly ClockWindow[]>();
/** 按 (mode, UTC日) 缓存；热路径（每帧图层 + 每次面板渲染）只做 Map 查找。 */
export function macroWindows(dayMs: number, mode: SessionClockMode): readonly ClockWindow[] {
  const key = `${mode}|${dayMs}`;
  const hit = windowsCache.get(key);
  if (hit) return hit;
  const mk = (id: string, zone: string | null, startMin: number, endMin: number, localLabel: string): ClockWindow => {
    const startMs = mode === 'local' && zone ? localWallToUtc(zone, dayMs, startMin) : dayMs + startMin * 60_000;
    const endMs = mode === 'local' && zone ? localWallToUtc(zone, dayMs, endMin) : dayMs + endMin * 60_000;
    return Object.freeze({ id, startMs, endMs, label: `${hhmm(startMs)}–${hhmm(endMs)} UTC`, localLabel });
  };
  const windows: readonly ClockWindow[] = Object.freeze(mode === 'fixed' ? [
    mk('asia', null, 0, 480, '00:00–08:00 UTC 合成亚太交易时段'),
    mk('london', null, 480, 960, '固定 UTC 预设'),
    mk('ny', null, 780, 1260, '固定 UTC 预设'),
  ] : [
    mk('asia', null, 0, 480, '00:00–08:00 UTC 合成亚太交易时段'),
    mk('london', 'Europe/London', 480, 990, '伦敦 08:00–16:30'),
    mk('ny', 'America/New_York', 480, 1020, '纽约 08:00–17:00'),
  ]);
  setBounded(windowsCache, key, windows, 800);
  return windows;
}
export function overlapWindow(windows: readonly ClockWindow[]): ClockWindow | null {
  const l = windows.find(w => w.id === 'london'), n = windows.find(w => w.id === 'ny');
  if (!l || !n) return null;
  const startMs = Math.max(l.startMs, n.startMs), endMs = Math.min(l.endMs, n.endMs);
  return endMs > startMs ? { id: 'overlap', startMs, endMs, label: `${hhmm(startMs)}–${hhmm(endMs)} UTC`, localLabel: '伦敦/纽约实际交集' } : null;
}
