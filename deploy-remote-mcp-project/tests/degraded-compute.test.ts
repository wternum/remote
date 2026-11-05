// Fail-closed regression tests: 不完整/仿真行情不能被当作真实连续样本计算。
// 运行：node scripts/run-ts-test.mjs tests/degraded-compute.test.ts
import assert from 'node:assert/strict';

const B = 300_000;
const NOW = Math.floor(Date.now() / B) * B - 2 * B;
let mode: 'gapped' | 'synthetic' = 'gapped';
let fetchCount = 0;
const realFetch = globalThis.fetch;

function row(ts: number, i: number) {
  // 有明确方向变化和非零成交，若错误地继续计算，本应把它作为一份交易样本分析；
  // 单点时间缺口仍能让内部信号识别，但不能被当成连续时间轴。
  const close = 100 + Math.sin(i / 18) * 8 + Math.sin(i / 3) * 0.8;
  const open = close - Math.cos(i / 5) * 0.5;
  const high = Math.max(open, close) + 0.3;
  const low = Math.min(open, close) - 0.3;
  const quote = 1_000_000 + (i % 17) * 10_000;
  return [String(ts), String(open), String(high), String(low), String(close), '1000', '1000', String(quote), '1'];
}

// 故意返回 8640 个有效行但时间轴上跳过一根：让 getCandles 判定 gapped=true，
// 同时无需分页，从而测试快速、稳定，不把上游限频混进路由测试。
function gappedRows() {
  const out = [];
  for (let i = 0; i <= 8640; i++) {
    if (i === 4320) continue;
    out.push(row(NOW - i * B, i));
  }
  return out;
}

// Route 下游会直接调用真实 getCandles / backtest / runScan；只有 OKX 的 fetch 被注入。
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCount++;
  const u = new URL(String(input));
  if (u.pathname.endsWith('/market/candles')) {
    if (mode === 'synthetic') return new Response(JSON.stringify({ code: '60012', data: [] }), { status: 400 });
    return new Response(JSON.stringify({ code: '0', data: gappedRows() }));
  }
  if (u.pathname.endsWith('/history-candles')) {
    return new Response(JSON.stringify({ code: '0', data: [] }));
  }
  throw new Error(`unexpected upstream URL: ${u}`);
}) as typeof fetch;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 1;
  }
}

// 动态加载：确保上面的上游 fetch 替身先于路由模块初始化。
const [{ GET: backtestGET }, { GET: engineGET }] = await Promise.all([
  import('@/app/api/backtest/route'),
  import('@/api/engine'),
]);

await test('缺口 K 线：回测显式标记 dataReady=false，不输出交易统计、不落库', async () => {
  mode = 'gapped';
  const before = fetchCount;
  const res = await backtestGET(new Request('http://localhost/api/backtest?symbol=BTC-USDT-SWAP&bar=5m&fresh=1'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.live, true);
  assert.equal(body.gapped, true);
  assert.equal(body.dataReady, false);
  assert.match(body.dataIssue, /不完整/);
  assert.equal(body.overall.executed, 0);
  assert.equal(body.overall.signals, 0);
  assert.equal(body.signals.length, 0);
  assert.ok(fetchCount > before, '应实际经过上游数据读取');
});

await test('缺口 K 线：引擎扫描显式标记 dataReady=false，confirm/touch 都为空', async () => {
  mode = 'gapped';
  const res = await engineGET(new Request('http://localhost/api/engine/scan?symbol=ETH-USDT-SWAP&bar=5m&fresh=1'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.live, true);
  assert.equal(body.gapped, true);
  assert.equal(body.dataReady, false);
  assert.match(body.dataIssue, /不完整/);
  assert.equal(body.confirm.length, 0);
  assert.equal(body.touch.length, 0);
});

await test('仿真行情：回测和引擎都标记 dataReady=false，不伪造真实回测结果', async () => {
  mode = 'synthetic';
  const bt = await (await backtestGET(new Request('http://localhost/api/backtest?symbol=SOL-USDT-SWAP&bar=5m&fresh=1'))).json();
  assert.equal(bt.live, false);
  assert.equal(bt.dataReady, false);
  assert.match(bt.dataIssue, /仿真|非实时/);
  assert.equal(bt.overall.executed, 0);
  assert.equal(bt.signals.length, 0);

  const engine = await (await engineGET(new Request('http://localhost/api/engine/scan?symbol=SOL-USDT-SWAP&bar=5m&fresh=1'))).json();
  assert.equal(engine.live, false);
  assert.equal(engine.dataReady, false);
  assert.equal(engine.confirm.length, 0);
  assert.equal(engine.touch.length, 0);
});

globalThis.fetch = realFetch;
console.log(`\ndegraded-compute: ${passed} 组断言通过`);
process.exit(process.exitCode ?? 0);
