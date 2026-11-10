import assert from 'node:assert/strict';
import {
  computeAsiaRangeLevels,
  computeDailyDividers,
  computeSessionSpans,
  DAY_MS,
  getActiveSessionClock,
  isIntradayTimeframe,
  MIN_MS,
  type BarLike,
} from '@/vela/sessions/sessionMath';
import {
  createSessionStore,
  DEFAULT_SESSION_PREFERENCES,
  normalizeSessionPreferences,
  SESSION_STORAGE_KEY,
} from '@/vela/sessions/sessionStore';

const BASE_DAY = Date.UTC(2026, 10, 7, 0, 0, 0); // 2026-11-07 00:00:00 UTC

// 1. 测试模式 A（三大宏观时段 + 欧美重叠）
{
  const spans = computeSessionSpans(BASE_DAY, BASE_DAY + DAY_MS - 1, {
    mode: 'macro',
    enabledSessions: { asia: true, london: true, ny: true },
    showOverlap: true,
  });

  const ids = spans.filter(s => s.dayStartMs === BASE_DAY).map(s => s.id);
  assert.deepEqual(ids, ['asia', 'london', 'ny', 'overlap']);

  const asia = spans.find(s => s.dayStartMs === BASE_DAY && s.id === 'asia')!;
  assert.equal(asia.startMs, BASE_DAY);
  assert.equal(asia.endMs, BASE_DAY + 8 * 3600_000);
  assert.equal(asia.badgeLabel, '亚太交易时段 08:00–16:00'); // 徽标为北京时间

  const london = spans.find(s => s.dayStartMs === BASE_DAY && s.id === 'london')!;
  assert.equal(london.startMs, BASE_DAY + 8 * 3600_000);
  assert.equal(london.endMs, BASE_DAY + 16 * 3600_000);
  assert.equal(london.badgeLabel, '伦敦交易时段 16:00–00:00');

  const ny = spans.find(s => s.dayStartMs === BASE_DAY && s.id === 'ny')!;
  assert.equal(ny.startMs, BASE_DAY + 13 * 3600_000);
  assert.equal(ny.endMs, BASE_DAY + 21 * 3600_000);
  assert.equal(ny.badgeLabel, '纽约交易时段 21:00–05:00');

  const overlap = spans.find(s => s.dayStartMs === BASE_DAY && s.id === 'overlap')!;
  assert.equal(overlap.startMs, BASE_DAY + 13 * 3600_000);
  assert.equal(overlap.endMs, BASE_DAY + 16 * 3600_000);
  assert.equal(overlap.isOverlay, true);
}

// 2. 测试模式 B（ICT 猎杀区 Killzones）
{
  const spans = computeSessionSpans(BASE_DAY, BASE_DAY + DAY_MS - 1, {
    mode: 'killzone',
    enabledSessions: { asia: true, london: true, ny: true },
    showOverlap: true,
  }).filter(s => s.dayStartMs === BASE_DAY);

  assert.deepEqual(
    spans.map(s => [s.id, (s.startMs - BASE_DAY) / MIN_MS, (s.endMs - BASE_DAY) / MIN_MS]),
    [
      ['asia', 0, 480],           // 00:00 - 08:00 UTC
      ['london', 420, 600],       // 07:00 - 10:00 UTC
      ['ny', 750, 930],           // 12:30 - 15:30 UTC
      ['london_close', 900, 1020], // 15:00 - 17:00 UTC
    ],
  );
}

// 3. 测试亚盘高低位 (AH / AL) 与欧美盘扫荡收回 vs 突破识别
{
  const bars: BarLike[] = [
    // 亚盘 00:00 - 08:00 UTC：高点 92000，低点 90000
    { time: BASE_DAY + 1 * 3600_000, open: 90500, high: 91200, low: 90000, close: 91000 },
    { time: BASE_DAY + 3 * 3600_000, open: 91000, high: 92000, low: 90800, close: 91500 },
    { time: BASE_DAY + 6 * 3600_000, open: 91500, high: 91800, low: 90400, close: 91100 },
    // 伦盘 09:00 UTC：向上刺破 AH (92000) 到 92150 后收盘回到 91850（扫高收回 / 诱多候选）
    { time: BASE_DAY + 9 * 3600_000, open: 91600, high: 92150, low: 91500, close: 91850 },
    // 美盘 14:00 UTC：向下实体跌破 AL (90000)，收盘在 89600（实体破低）
    { time: BASE_DAY + 14 * 3600_000, open: 90200, high: 90300, low: 89500, close: 89600 },
  ];

  const summaries = computeAsiaRangeLevels(bars, BASE_DAY, BASE_DAY + DAY_MS);
  assert.equal(summaries.length, 1);
  const ar = summaries[0];
  assert.equal(ar.high, 92000);
  assert.equal(ar.low, 90000);
  assert.equal(ar.highState, 'swept_reject');
  assert.equal(ar.highTouchMs, BASE_DAY + 9 * 3600_000);
  assert.equal(ar.lowState, 'broken');
  assert.equal(ar.lowTouchMs, BASE_DAY + 14 * 3600_000);
}

// 4. 测试 00:00 UTC 日界分割线与周期自适应
{
  const bars5m: BarLike[] = [
    { time: BASE_DAY - 300_000, open: 90000, high: 90100, low: 89900, close: 90050 },
    { time: BASE_DAY, open: 90050, high: 90200, low: 90000, close: 90150 },
    { time: BASE_DAY + 300_000, open: 90150, high: 90300, low: 90100, close: 90250 },
  ];
  assert.equal(isIntradayTimeframe(bars5m), true);

  // 日界线是北京时间 00:00（= 前一日 16:00 UTC），与 OKX 1D 换日一致；UTC 00:00 不再画线
  assert.equal(computeDailyDividers(bars5m, BASE_DAY - 600_000, BASE_DAY + 600_000).length, 0);
  const BJ_DAY = BASE_DAY - 8 * 3_600_000;
  const bjBars: BarLike[] = bars5m.map(b => ({ ...b, time: b.time - 8 * 3_600_000 }));
  const divs = computeDailyDividers(bjBars, BJ_DAY - 600_000, BJ_DAY + 600_000);
  assert.equal(divs.length, 1);
  assert.equal(divs[0].dayStartMs, BJ_DAY);
  assert.equal(divs[0].dateLabel, '11-07 00:00');
  assert.equal(divs[0].openPrice, 90050);

  const bars1D: BarLike[] = [
    { time: BASE_DAY - DAY_MS, open: 89000, high: 91000, low: 88000, close: 90000 },
    { time: BASE_DAY, open: 90000, high: 92000, low: 89500, close: 91500 },
    { time: BASE_DAY + DAY_MS, open: 91500, high: 93000, low: 91000, close: 92500 },
  ];
  assert.equal(isIntradayTimeframe(bars1D), false);
}

// 5. 测试实时 UTC 时钟与活跃时段判定
{
  // 14:15 UTC 处于伦敦时段 + 纽约时段 + 欧美重叠期
  const clock = getActiveSessionClock(BASE_DAY + (14 * 60 + 15) * MIN_MS, 'macro');
  assert.equal(clock.utcHHMM, '14:15 UTC');
  assert.deepEqual(
    clock.activeSessions.map(s => s.id),
    ['london', 'ny', 'overlap'],
  );
}

// 6. 测试 SessionStore 状态变更与持久化
{
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  const store = createSessionStore(storage);
  assert.deepEqual(store.getSnapshot().preferences, DEFAULT_SESSION_PREFERENCES);

  store.patch({ mode: 'killzone', showBadges: false });
  store.toggleSession('asia');
  assert.equal(store.getSnapshot().preferences.mode, 'killzone');
  assert.equal(store.getSnapshot().preferences.showBadges, false);
  assert.equal(store.getSnapshot().preferences.enabledSessions.asia, false);
  assert.ok(mem.has(SESSION_STORAGE_KEY));

  // 重新从存储恢复
  const restored = createSessionStore(storage);
  assert.equal(restored.getSnapshot().preferences.mode, 'killzone');
  assert.equal(restored.getSnapshot().preferences.showBadges, false);
  assert.equal(restored.getSnapshot().preferences.enabledSessions.asia, false);

  // 非法存储容错
  assert.deepEqual(normalizeSessionPreferences('invalid-json'), DEFAULT_SESSION_PREFERENCES);
}

console.log('PASS trading-sessions.test.ts');
