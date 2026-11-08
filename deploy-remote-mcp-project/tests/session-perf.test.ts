// 本地夏令时性能回归：热路径必须命中缓存，不允许每帧重建 Intl.DateTimeFormat。
// 运行：node scripts/run-ts-test.mjs tests/session-perf.test.ts
import assert from 'node:assert/strict';
import { macroWindows, localWallToUtc } from '@/vela/sessions/sessionClock';
import { computeSessionSpans, getActiveSessionClock, DAY_MS } from '@/vela/sessions/sessionMath';

const day = Date.parse('2026-06-15T00:00:00Z');
const opts = { mode: 'macro' as const, clockMode: 'local' as const, enabledSessions: { asia: true, london: true, ny: true }, showOverlap: true };

// 正确性不随缓存改变：夏令时边界仍精确。
assert.equal(macroWindows(day, 'local').find(w => w.id === 'london')!.startMs, day + 7 * 3600_000);
assert.equal(localWallToUtc('America/New_York', Date.parse('2026-03-08T00:00:00Z'), 8 * 60), Date.parse('2026-03-08T12:00:00Z'));

// 模拟图层热路径：每帧对可见范围（约4天）调用一次，连续 300 帧。
const spansWarm = computeSessionSpans(day - DAY_MS, day + 3 * DAY_MS, opts);
const t0 = performance.now();
for (let i = 0; i < 300; i++) {
  const min = day - DAY_MS + i * 60_000;
  computeSessionSpans(min, min + 4 * DAY_MS, opts);
}
const spansMs = performance.now() - t0;

// 模拟面板热路径：每次偏好变更（如拖动透明度滑杆）都会重算时钟。
getActiveSessionClock(day + 12 * 3600_000, 'macro', 'local');
const t1 = performance.now();
for (let i = 0; i < 300; i++) getActiveSessionClock(day + 12 * 3600_000 + i * 1000, 'macro', 'local');
const clockMs = performance.now() - t1;

console.log(`300帧 computeSessionSpans(local): ${spansMs.toFixed(1)}ms; 300次 getActiveSessionClock(local): ${clockMs.toFixed(1)}ms`);
// 缓存命中：同一天同一口径必须返回同一引用（O(1) 查找，而不是重算）。
assert.equal(macroWindows(day, 'local'), macroWindows(day, 'local'), 'macroWindows 应按天缓存');
// 宽松阈值防 CI 抖动；修复前该值在数百到数千 ms。
assert.ok(spansMs < 200, `图层热路径过慢：${spansMs.toFixed(1)}ms / 300帧`);
assert.ok(clockMs < 100, `面板时钟热路径过慢：${clockMs.toFixed(1)}ms / 300次`);
assert.ok(spansWarm.length > 0);
console.log('PASS 本地夏令时热路径性能与夏令时正确性');
