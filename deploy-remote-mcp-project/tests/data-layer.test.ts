// 数据拉取层故障注入回归测试。
// 运行：node scripts/run-ts-test.mjs tests/data-layer.test.ts
//
// 这里覆盖的每一条都对应一个真实出现过的缺陷：
//  · 请求没取满却被当成完整数据（short 标志算出来却没人用）
//  · 历史页失败被吞 → 缺口行情被当成真实行情缓存
//  · 上游持续限频时每次请求都整段重拉（失败结果永不命中缓存）
//  · 同 key 并发各自重复拉取
//  · 非法参数被透传给 OKX
import assert from 'node:assert/strict';
import { getCandles } from '@/server/okx';
import { parseBar, parseSymbol, SCAN_BARS_ALLOWED } from '@/lib/market';
import { setBounded } from '@/lib/lru';

const B = 300_000;
const NOW = Math.floor(1_793_000_000_000 / B) * B;
const realFetch = globalThis.fetch;

type Row = string[];
const row = (ts: number): Row => [String(ts), '100', '101', '99', '100', '1', '0', '1'];
const page = (n: number, from: number): Row[] => Array.from({ length: n }, (_, i) => row(from - i * B));
const reply = (data: Row[], status = 200, code = '0') => new Response(JSON.stringify({ code, data }), { status });

interface Script {
  /** 返回 true 表示该历史页窗口（after 值）永久失败 */
  failWindow?: (after: number) => boolean;
  /** window → 该窗口前 N 次请求失败，之后成功 */
  flaky?: Map<number, number>;
  allHistory429?: boolean;
  firstPage?: (rows: Row[]) => Row[];
  firstPageStatus?: number;
}
let calls = 0;
function install(script: Script = {}) {
  calls = 0;
  const attempts = new Map<number, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (!u.pathname.includes('candles')) return reply([]);
    calls++;
    if (u.pathname.endsWith('/market/candles')) {
      if (script.firstPageStatus) return reply([], script.firstPageStatus, '60012');
      const rows = page(300, NOW);
      return reply(script.firstPage ? script.firstPage(rows) : rows);
    }
    const after = Number(u.searchParams.get('after'));
    if (script.allHistory429) return reply([], 429, '50011');
    if (script.failWindow?.(after)) return reply([], 429, '50011');
    const failN = script.flaky?.get(after);
    if (failN) {
      const n = (attempts.get(after) ?? 0) + 1;
      attempts.set(after, n);
      if (n <= failN) return reply([], 429, '50011');
    }
    return reply(page(100, after - B));
  }) as typeof fetch;
}
const holes = (cs: { ts: number }[]) => {
  let n = 0;
  for (let i = 1; i < cs.length; i++) {
    const d = Math.round((cs[i].ts - cs[i - 1].ts) / B);
    if (d > 1) n += d - 1;
  }
  return n;
};

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

await test('完整成功：取满、无洞、gapped=false', async () => {
  install();
  const r = await getCandles('T1-USDT-SWAP', '5m', 900);
  assert.equal(r.live, true);
  assert.equal(r.candles.length, 900);
  assert.equal(holes(r.candles), 0);
  assert.equal(r.gapped, false);
});

await test('请求没取满（历史页全部 429）→ gapped=true，不得静默截断', async () => {
  install({ allHistory429: true });
  const r = await getCandles('T2-USDT-SWAP', '5m', 900);
  assert.equal(r.live, true);
  assert.equal(r.candles.length, 300);
  assert.equal(r.gapped, true);
});

await test('单页永久失败 → live=true、gapped=true、精确留下 100 根洞', async () => {
  install({ failWindow: (a) => a === NOW - 499 * B });
  const r = await getCandles('T3-USDT-SWAP', '5m', 900);
  assert.equal(r.live, true);
  assert.equal(r.gapped, true);
  assert.equal(holes(r.candles), 100);
  assert.equal(r.candles.length, 800);
});

// 重试有两层：单次请求内最多 3 次（okxGetRetry）+ 取数后对失败页再补拉一轮。
// 两个用例分别把每一层单独钉住，避免互相掩盖。
await test('单页连续失败 2 次 → 靠请求内重试补齐（第 3 次成功），无缺口', async () => {
  install({ flaky: new Map([[NOW - 499 * B, 2]]) });
  const r = await getCandles('T4A-USDT-SWAP', '5m', 900);
  assert.equal(r.candles.length, 900);
  assert.equal(holes(r.candles), 0);
  assert.equal(r.gapped, false);
});

await test('单页连续失败 4 次 → 请求内重试耗尽，靠失败页补拉一轮补齐，无缺口', async () => {
  install({ flaky: new Map([[NOW - 499 * B, 4]]) });
  const r = await getCandles('T4B-USDT-SWAP', '5m', 900);
  assert.equal(r.candles.length, 900);
  assert.equal(holes(r.candles), 0);
  assert.equal(r.gapped, false);
});

await test('单页连续失败 6 次 → 两层重试都耗尽，如实留下 100 根洞', async () => {
  install({ flaky: new Map([[NOW - 499 * B, 6]]) });
  const r = await getCandles('T4C-USDT-SWAP', '5m', 900);
  assert.equal(holes(r.candles), 100);
  assert.equal(r.gapped, true);
});

await test('畸形行（字段不足 / NaN / high<low）被剔除，且如实留下缺口', async () => {
  install({
    firstPage: (rows) => {
      rows[5] = ['bad'];
      rows[9] = [rows[9][0], 'NaN', '1', '1', '1', '1', '0', '1'];
      rows[20] = [rows[20][0], '100', '99', '101', '100', '1', '0', '1'];
      return rows;
    },
  });
  const r = await getCandles('T5-USDT-SWAP', '5m', 300);
  assert.equal(r.live, true, '畸形行不应导致整体降级为合成行情');
  assert.equal(holes(r.candles), 3);
  assert.equal(r.gapped, true);
  assert.ok(r.candles.every((c) => [c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)));
});

await test('上游持续限频：冷却期内不重复整段重拉；更浅请求命中缓存；更深请求仍重拉', async () => {
  install({ allHistory429: true });
  await getCandles('T6-USDT-SWAP', '5m', 900);
  const first = calls;
  assert.ok(first > 0);
  await getCandles('T6-USDT-SWAP', '5m', 900);
  await getCandles('T6-USDT-SWAP', '5m', 900);
  assert.equal(calls, first, '失败结果必须在冷却期内被缓存');
  await getCandles('T6-USDT-SWAP', '5m', 300);
  assert.equal(calls, first, '更浅请求应复用缓存');
  await getCandles('T6-USDT-SWAP', '5m', 1200);
  assert.ok(calls > first, '更深请求必须重拉');
});

await test('5 个并发同 key 请求只拉一次（1 首页 + 3 历史页）', async () => {
  install();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => getCandles('T7-USDT-SWAP', '5m', 600)));
  assert.equal(calls, 4);
  assert.ok(rs.every((r) => JSON.stringify(r.candles) === JSON.stringify(rs[0].candles)));
});

await test('确定性 4xx 不重试', async () => {
  install({ firstPageStatus: 400 });
  const r = await getCandles('T8-USDT-SWAP', '5m', 600);
  assert.equal(calls, 1);
  assert.equal(r.live, false, '应降级为合成行情');
});

await test('缓存按 symbol / bar 隔离', async () => {
  install();
  const a = await getCandles('T9A-USDT-SWAP', '5m', 600);
  const b = await getCandles('T9B-USDT-SWAP', '15m', 600);
  assert.ok(a.candles.every((c) => c.ts % 300_000 === 0));
  assert.equal(b.live, true);
});

await test('参数白名单：未知标的 / 周期返回 null，okx: 前缀被剥离', () => {
  assert.equal(parseSymbol('FAKE-USDT-SWAP'), null);
  assert.equal(parseSymbol('okx:ETH-USDT-SWAP'), 'ETH-USDT-SWAP');
  assert.equal(parseSymbol('ALL'), null);
  assert.equal(parseSymbol('ALL', { allowAll: true }), 'ALL');
  assert.equal(parseSymbol(null, { fallback: 'BTC-USDT-SWAP' }), 'BTC-USDT-SWAP');
  assert.equal(parseBar('7m', SCAN_BARS_ALLOWED), null);
  assert.equal(parseBar('15m', SCAN_BARS_ALLOWED), '15m');
});

await test('有界缓存：超限淘汰最早写入，重复写入刷新顺序', () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 10; i++) setBounded(m, `k${i}`, i, 3);
  assert.deepEqual([...m.keys()], ['k7', 'k8', 'k9']);
  setBounded(m, 'k7', 99, 3);
  setBounded(m, 'k10', 10, 3);
  assert.deepEqual([...m.keys()], ['k9', 'k7', 'k10']);
});

globalThis.fetch = realFetch;
console.log(`\ndata-layer: ${passed} 组断言通过`);
if (process.exitCode) process.exit(process.exitCode);
