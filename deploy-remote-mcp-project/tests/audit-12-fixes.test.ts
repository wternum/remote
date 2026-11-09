// 回归：2026-11-10 全项目审计的 12 项修复。每组对应修正方案中的一个编号。
import assert from 'node:assert/strict';
import type { Candle, TradedSignal } from '@/lib/types';
import { GET as okxProxyGet, clientKeyOf } from '@/app/api/okx/[...path]/route';
import { persistedStatus } from '@/app/api/backtest/route';
import { catchUpPages, getFlow, MAX_CATCHUP_PAGES, syncFlow } from '@/quant/flow';
import { buildContext } from '@/quant/context';
import { findSprings } from '@/quant/wyckoff';
import { parseStoredConfig, LIMITS, DEFAULT_CONFIG } from '@/quant/config';
import { getActiveSessionClock } from '@/vela/sessions/sessionMath';
import { panelShortcut } from '@/lib/shortcuts';
import { engineBarOf } from '@/components/confirm/useEngine';
import { analyzeSignals } from '@/vela/signals/analyze';
import { DEFAULT_PREFERENCES } from '@/vela/signals/store';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const g = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const B = 300_000;

// 1. rubik 代理上游失败：返回 502，且不留下未处理的 Promise 拒绝
{
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  globalThis.fetch = (async () => { throw new Error('upstream down'); }) as typeof fetch;
  try {
    const res = await okxProxyGet(
      new Request('http://127.0.0.1:3000/api/okx/api/v5/rubik/stat/taker-volume-contract?instId=FAIL-USDT-SWAP&period=5m'),
      { params: Promise.resolve({ path: ['api', 'v5', 'rubik', 'stat', 'taker-volume-contract'] }) },
    );
    assert.equal(res.status, 502);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, 'INFLIGHT cleanup must not leave an unhandled rejection');
  } finally {
    globalThis.fetch = realFetch;
    process.off('unhandledRejection', onUnhandled);
  }
  pass('1 · rubik 代理上游失败只回 502，不产生未处理的 Promise 拒绝');
}

// 3. rubik 增量刷新以 rubik 自己的最后一根为界，长时间离线后能补回缺口
{
  assert.equal(catchUpPages(Date.now() - 50 * B, B, 1), 2);
  assert.equal(catchUpPages(Date.now() - 100_000 * B, B, 1), MAX_CATCHUP_PAGES);
  assert.equal(catchUpPages(Date.now(), B, 4), 4, 'never fewer pages than the caller asked for');

  const origWin = g.window;
  delete g.window; // Node 直连路径
  let takerCalls = 0;
  const now = Math.floor(Date.now() / B) * B - 2 * B;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const end = Number(u.searchParams.get('end') ?? String(now + B));
    if (u.pathname.includes('taker-volume-contract')) {
      takerCalls++;
      return new Response(JSON.stringify({ code: '0', data: Array.from({ length: 100 }, (_, i) => [String(end - (i + 1) * B), '5000', '6000']) }));
    }
    if (u.pathname.includes('open-interest-history')) {
      return new Response(JSON.stringify({ code: '0', data: Array.from({ length: 100 }, (_, i) => [String(end - (i + 1) * B), '1000', '10', '100000']) }));
    }
    return new Response(JSON.stringify({ code: '0', data: [] }));
  }) as typeof fetch;
  try {
    await syncFlow('GAP-USDT-SWAP', '5m', { minTs: 0, maxPages: 2, oiPages: 1 });
    const snap = getFlow('GAP-USDT-SWAP', '5m')!;
    assert.ok(snap.rubikTo && snap.rubikTo >= now - B, 'rubikTo tracks the newest rubik bar');
    // 模拟睡眠 500 根：实时 tape 已把 snap.to 推到现在，但 rubik 停在 500 根前，中间没有数据。
    const stale = now - 500 * B;
    for (const ts of [...snap.bars.keys()]) if (ts > stale) snap.bars.delete(ts);
    snap.rubikTo = stale;
    snap.to = now;
    takerCalls = 0;
    await syncFlow('GAP-USDT-SWAP', '5m', { minTs: 0, maxPages: 1, oiPages: 1 });
    assert.ok(takerCalls >= 5, `offline gap must be paged back in (got ${takerCalls} page(s))`);
    assert.equal(snap.bars.get(now - 250 * B)?.src, 'rubik', 'a bar in the middle of the gap is backfilled');
  } finally {
    if (origWin !== undefined) g.window = origWin;
    globalThis.fetch = realFetch;
  }
  pass('3 · rubik 离线缺口按 rubikTo 追补，不被 tape 推进的 snap.to 截断');
}

// 4. 回测落库状态与统计口径一致
{
  const rec = (r: number | undefined, status: TradedSignal['status'] = 'done') => ({ status, r } as TradedSignal);
  assert.equal(persistedStatus(rec(0.8)), 'won');
  assert.equal(persistedStatus(rec(-1)), 'lost');
  assert.equal(persistedStatus(rec(0)), 'time', 'r === 0 is flat, not a loss');
  assert.equal(persistedStatus(rec(undefined, 'skipped')), 'skipped');
  pass('4 · r=0 落库为 time（flat），不再记成 lost');
}

// 5. Wyckoff 弹簧的区间背景按收回那根 K 线判断：窗口起点之后才形成的区间也能识别
{
  const MS = B, T0 = 1_800_000_000_000;
  // 折线行情：0→100、30 底 96、60 顶 104、150 底 96.6、180 顶 104.1、210 底 96.5，240 扫低收回
  const way: [number, number][] = [[0, 100], [30, 96], [60, 104], [150, 96.6], [180, 104.1], [210, 96.5], [239, 98.5]];
  const cs: Candle[] = [];
  for (let k = 0; k + 1 < way.length; k++) {
    const [i0, p0] = way[k], [i1, p1] = way[k + 1];
    for (let i = i0; i < i1; i++) {
      const p = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
      cs.push({ ts: T0 + i * MS, o: p, h: p + 0.3, l: p - 0.3, c: p, v: 1000, confirm: 1, volumeSource: 'quote' });
    }
  }
  cs.push({ ts: T0 + 239 * MS, o: 98.5, h: 98.8, l: 98.2, c: 98.5, v: 1000, confirm: 1, volumeSource: 'quote' });
  cs.push({ ts: T0 + 240 * MS, o: 97.5, h: 97.6, l: 95.5, c: 97.2, v: 3000, confirm: 1, volumeSource: 'quote' });
  for (let i = 241; i < 250; i++) cs.push({ ts: T0 + i * MS, o: 97.5, h: 97.8, l: 97.2, c: 97.5, v: 1000, confirm: 1, volumeSource: 'quote' });
  // lookback 160 → 窗口起点为第 90 根：那时只确认了一顶一底（旧实现在此判区间 → 漏掉弹簧）；
  // 到第 240 根已有两顶两底的非单边区间。
  const springs = findSprings(buildContext(cs), 160);
  assert.ok(springs.some(s => s.kind === 'spring' && s.idx === 240 && Math.abs(s.level - 95.7) < 0.01),
    `range known at the reclaim bar must allow the spring (got ${JSON.stringify(springs.map(s => [s.kind, s.idx, s.level]))})`);
  pass('5 · Wyckoff 区间背景在收回 K 线处判断，窗口起点后形成的区间不再被漏掉');
}

// 6. 本地存储的门槛不可信：读取时夹到合法区间
{
  assert.equal(parseStoredConfig(JSON.stringify({ threshold: 5 })).threshold, LIMITS.max);
  assert.equal(parseStoredConfig(JSON.stringify({ threshold: -1 })).threshold, LIMITS.min);
  assert.equal(parseStoredConfig(JSON.stringify({ threshold: 0.6012 })).threshold, 0.6);
  assert.equal(parseStoredConfig(JSON.stringify({ threshold: 'x', replaceConfFilter: 'yes' })).replaceConfFilter, DEFAULT_CONFIG.replaceConfFilter);
  assert.deepEqual(parseStoredConfig('{bad json'), DEFAULT_CONFIG);
  pass('6 · localStorage 门槛读取时夹取并校验类型');
}

// 7. 观察窗口模式：伦敦收盘时段参与「进行中」与倒计时
{
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 10, h, m);
  const active = getActiveSessionClock(at(16), 'killzone');
  assert.ok(active.activeSessions.some(d => d.id === 'london_close'), 'london_close active at 16:00 UTC');
  const before = getActiveSessionClock(at(14), 'killzone');
  assert.equal(before.nextSession.def.id, 'london_close');
  assert.equal(Math.round(before.nextSession.inMinutes), 60);
  assert.ok(getActiveSessionClock(at(14), 'macro').activeSessions.some(d => d.id === 'overlap'), 'macro overlap unchanged');
  pass('7 · london_close 在观察窗口模式下显示进行中并参与倒计时');
}

// 8. 面板快捷键只认纯 Shift 组合
{
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...mods }) as KeyboardEvent;
  assert.equal(panelShortcut(key('C')), 'engine');
  assert.equal(panelShortcut(key('F')), 'frameworks');
  assert.equal(panelShortcut(key('C', { ctrlKey: true })), null, 'Ctrl+Shift+C belongs to DevTools');
  assert.equal(panelShortcut(key('C', { metaKey: true })), null);
  assert.equal(panelShortcut(key('F', { altKey: true })), null);
  assert.equal(panelShortcut(key('C', { repeat: true })), null);
  assert.equal(panelShortcut(key('c', { shiftKey: false })), null);
  pass('8 · Ctrl/⌘/Alt 组合与自动重复不再开合面板');
}

// 9. 图表周期不在 5m/15m 时，引擎映射需显式标出
{
  assert.deepEqual(engineBarOf('5'), { bar: '5m' });
  assert.deepEqual(engineBarOf('15'), { bar: '15m' });
  assert.deepEqual(engineBarOf('240'), { bar: '15m', mappedFrom: '4h' });
  assert.deepEqual(engineBarOf('30'), { bar: '15m', mappedFrom: '30m' });
  assert.deepEqual(engineBarOf('1'), { bar: '5m', mappedFrom: '1m' });
  assert.deepEqual(engineBarOf('D'), { bar: '15m', mappedFrom: '1D' });
  pass('9 · 4h / 1D 等周期映射为 15m 时带 mappedFrom 供面板提示');
}

// 10. M/W 分析与四框架同口径：中间漏推 confirm=1 的 K 线不截断连续段
{
  const T0 = 1_800_000_000_000;
  const cs: Candle[] = Array.from({ length: 300 }, (_, i) =>
    ({ ts: T0 + i * B, o: 100, h: 100.4, l: 99.6, c: 100, v: 1000, confirm: i === 150 ? 0 : 1, volumeSource: 'quote' }));
  const a = analyzeSignals(cs, B, { ...DEFAULT_PREFERENCES, lookback: 300 }, null, T0 + 300 * B + 2000);
  assert.equal(a.bars, 300, 'stale middle confirm=0 bar must not split the series');
  assert.equal(a.gapTruncated, false);
  pass('10 · analyzeSignals 保留中间漏推确认的 K 线，不再误报缺口');
}

// 11. 限流客户端标识：默认不信任可伪造的转发头
{
  const req = new Request('http://127.0.0.1:3000/x', { headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' } });
  const prev = process.env.PULSEDESK_TRUST_PROXY_HEADERS;
  try {
    delete process.env.PULSEDESK_TRUST_PROXY_HEADERS;
    assert.equal(clientKeyOf(req), null, 'spoofable header ignored unless explicitly trusted');
    process.env.PULSEDESK_TRUST_PROXY_HEADERS = '1';
    assert.equal(clientKeyOf(req), '6.6.6.6');
  } finally {
    if (prev === undefined) delete process.env.PULSEDESK_TRUST_PROXY_HEADERS;
    else process.env.PULSEDESK_TRUST_PROXY_HEADERS = prev;
  }
  pass('11 · x-forwarded-for 仅在 PULSEDESK_TRUST_PROXY_HEADERS=1 时用于分桶');
}

// 2. 浏览器 fetch 拦截器：放行的请求不消费 Request 对象的 body（放在最后：需要伪造 window）
{
  const seen: string[] = [];
  const origWin = g.window;
  g.window = {
    location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // throws if the interceptor already used the body; Node needs an explicit base for relative URLs
      const req = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), 'http://127.0.0.1:3000/'), init);
      seen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
      return new Response('ok');
    },
  };
  try {
    const { startRuntime } = await import('@/runtime/bootstrap');
    await startRuntime();
    const w = g.window as { fetch: typeof fetch };
    await w.fetch(new Request('https://www.okx.com/api/v5/x', { method: 'POST', body: 'cross' }));
    await w.fetch(new Request('http://127.0.0.1:3000/not-an-api', { method: 'POST', body: 'same' }));
    await w.fetch('/relative-asset');
    assert.deepEqual(seen, ['POST /api/v5/x cross', 'POST /not-an-api same', 'GET /relative-asset ']);
  } finally {
    if (origWin === undefined) delete g.window;
    else g.window = origWin;
  }
  pass('2 · 拦截器放行跨域 / 非 API 请求时 Request 的 body 保持可用');
}

console.log(`\naudit-12-fixes: ${passed} groups passed`);
