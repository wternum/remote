// 显示时区：北京时间（Asia/Shanghai，无夏令时，固定 UTC+8）。
// 只用于「给人看」的时间与日界；OKX 数据对齐、伦敦/纽约时段定义等计算仍以 UTC 为准。
export const DISPLAY_TZ = 'Asia/Shanghai';
export const DISPLAY_TZ_LABEL = '北京';
export const DISPLAY_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const shifted = (ts: number) => new Date(ts + DISPLAY_OFFSET_MS);
const pad = (n: number) => String(n).padStart(2, '0');

/** "11-10 06:50"（北京时间） */
export function fmtDateTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const d = shifted(ts);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "06:50"（北京时间） */
export function fmtClock(ts: number): string {
  const d = shifted(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "11-10"（北京日期） */
export function fmtMonthDay(ts: number): string {
  const d = shifted(ts);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 某时刻所在北京自然日的 00:00（返回 UTC 毫秒） */
export function displayDayFloor(ts: number): number {
  return Math.floor((ts + DISPLAY_OFFSET_MS) / DAY_MS) * DAY_MS - DISPLAY_OFFSET_MS;
}
