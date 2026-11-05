// 成交量链路回归测试。
// 运行：node scripts/run-ts-test.mjs tests/volume.test.ts
//
// 覆盖：
//  · 字段换算：volCcyQuote → volCcy×价格 → 张数×面值×价格 的优先级
//  · 图表端：分批加载的旧快照不得覆盖 WebSocket 已推送的新值（成交量忽高忽低的根因）
//  · 图表端：加载期间收盘的 K 线不得被永久写成残缺成交量
//  · 图表端：向左滚动加载更早区间仍返回请求的时间段
//  · 服务端：缓存里的"残缺最新一根"收盘后必须被补拉替换，且只用 1 次请求
//  · 降级仿真：价格有界、成交额与真实量级一致、OHLC 合法
import assert from 'node:assert/strict';
import { quoteVolumeFromRow } from '@/lib/okxVolume';

const B = 300_000;
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

// ── 浏览器环境桩：provider 依赖 window 定时器与 WebSocket ──
type Sock = { onopen?: () => void; onmessage?: (e: { data: string }) => void };
const sockets: Sock[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined };
g.WebSocket = class {
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor() {
    sockets.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() {}
};
const realFetch = globalThis.fetch;
const row9 = (t: number, contracts: number) => [String(t), '100', '101', '99', '100', String(contracts), String(contracts), String(contracts * 100), '0'];
const push = (t: number, contracts: number) =>
  sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle5m' }, data: [row9(t, contracts)] }) });
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: '0', data }), { status });
const setFetch = (fn: (u: URL) => Response | Promise<Response>) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => fn(new URL(String(input)))) as typeof fetch;
};

const { OKXProvider, barsHub } = await import('@/vela/okxProvider');
const { getCandles, synthCandles } = await import('@/server/okx');

await test('字段换算优先级：volCcyQuote > volCcy×价格 > 张数×面值×价格', () => {
  // [ts, o, h, l, c, vol(张), volCcy(币), volCcyQuote(USDT)]
  assert.equal(quoteVolumeFromRow(['0', '1', '1', '1', '90', '100', '100', '9000'], 'SOL-USDT-SWAP'), 9000);
  assert.equal(quoteVolumeFromRow(['0', '1', '1', '1', '90', '100', '100', '0'], 'SOL-USDT-SWAP'), 100 * 90);
  // BTC 面值 0.01：只剩张数时必须乘面值，否则偏大 100 倍
  assert.equal(quoteVolumeFromRow(['0', '1', '1', '1', '80000', '100', '0', '0'], 'BTC-USDT-SWAP'), 100 * 0.01 * 80000);
  assert.equal(quoteVolumeFromRow(['0', '1', '1', '1', 'NaN', '100', '0', '0'], 'BTC-USDT-SWAP'), 0);
});

await test('图表端：加载中途 WebSocket 推送更新后，后续批次与镜像不再回退到旧快照', async () => {
  const now = Math.floor(Date.now() / B) * B;
  let pages = 0;
  setFetch((u) => {
    if (u.pathname.endsWith('/market/candles')) return json(Array.from({ length: 300 }, (_, i) => row9(now - i * B, i === 0 ? 1000 : 5000)));
    if (++pages === 2) push(now, 4000);
    const after = Number(u.searchParams.get('after'));
    return json(Array.from({ length: 100 }, (_, i) => row9(after - (i + 1) * B, 5000)));
  });
  const p = new OKXProvider();
  p.subscribe('V1-USDT-SWAP', '5', () => undefined);
  await new Promise((r) => setTimeout(r, 5));
  const seq: number[] = [];
  await p.getBarsProgressive('V1-USDT-SWAP', '5', { limit: 1500 } as never, (bars) => seq.push(bars.at(-1)!.volume ?? 0));
  assert.equal(barsHub.get('V1-USDT-SWAP', '5').at(-1)!.volume, 400_000);
  assert.ok(seq.every((v, i) => i === 0 || v >= seq[i - 1]), `批次出现回退：${seq.join(',')}`);
  assert.equal(seq.at(-1), 400_000);
});

await test('图表端：加载期间收盘的 K 线保留完整成交量，不被残缺快照永久覆盖', async () => {
  const now = Math.floor(Date.now() / B) * B;
  let pages = 0;
  setFetch((u) => {
    if (u.pathname.endsWith('/market/candles')) return json(Array.from({ length: 300 }, (_, i) => row9(now - i * B, i === 0 ? 1200 : 5000)));
    if (++pages === 3) {
      push(now, 5000);
      push(now + B, 300);
    }
    const after = Number(u.searchParams.get('after'));
    return json(Array.from({ length: 100 }, (_, i) => row9(after - (i + 1) * B, 5000)));
  });
  const p = new OKXProvider();
  p.subscribe('V2-USDT-SWAP', '5', () => undefined);
  await new Promise((r) => setTimeout(r, 5));
  await p.getBarsProgressive('V2-USDT-SWAP', '5', { limit: 1500 } as never, () => undefined);
  const bars = barsHub.get('V2-USDT-SWAP', '5');
  assert.equal(bars.find((b) => b.time === now)!.volume, 500_000);
  assert.equal(bars.at(-1)!.time, now + B);
});

await test('图表端：向左滚动加载更早区间，返回的全部在 range.to 之前', async () => {
  const now = Math.floor(Date.now() / B) * B;
  const to = now - 2000 * B;
  setFetch((u) => {
    const after = Number(u.searchParams.get('after'));
    const n = u.pathname.endsWith('/market/candles') ? 300 : 100;
    return json(Array.from({ length: n }, (_, i) => row9(after - (i + 1) * B, 5000)));
  });
  const p = new OKXProvider();
  p.subscribe('V3-USDT-SWAP', '5', () => undefined);
  await new Promise((r) => setTimeout(r, 5));
  push(now, 777);
  const out = await p.getBarsProgressive('V3-USDT-SWAP', '5', { limit: 400, to } as never, () => undefined);
  assert.ok(out.length > 0 && out.every((b) => b.time <= to));
});

await test('服务端：缓存中的残缺最新一根收盘后被补拉替换，仅 1 次请求；补拉失败则整段重拉', async () => {
  const realNow = Date.now;
  let fakeNow = Math.floor(1_793_000_000_000 / B) * B + 200_000;
  Date.now = () => fakeNow;
  try {
    const forming = Math.floor(fakeNow / B) * B;
    let firstPage = 0, history = 0, failTail = false;
    const row8 = (t: number, v: number) => [String(t), '100', '101', '99', '100', String(v), String(v), String(v * 100)];
    setFetch((u) => {
      const cur = Math.floor(fakeNow / B) * B;
      const partial = Math.round(5000 * ((fakeNow - cur) / B));
      if (u.pathname.endsWith('/market/candles')) {
        firstPage++;
        if (failTail) {
          failTail = false;
          return new Response('{}', { status: 500 });
        }
        return json(Array.from({ length: 300 }, (_, i) => row8(cur - i * B, i === 0 ? partial : 5000)));
      }
      history++;
      const after = Number(u.searchParams.get('after'));
      return json(Array.from({ length: 100 }, (_, i) => row8(after - (i + 1) * B, 5000)));
    });
    await getCandles('VS-USDT-SWAP', '5m', 600);
    const f0 = firstPage, h0 = history;
    fakeNow = forming + B + 1000;
    const r = await getCandles('VS-USDT-SWAP', '5m', 600);
    assert.equal(r.candles.find((c) => c.ts === forming)!.v, 500_000, '收盘后仍返回残缺成交量');
    assert.equal(firstPage - f0, 1);
    assert.equal(history, h0, '不应整段重拉');
    assert.equal(r.candles.length, 600);
    assert.equal(r.candles.at(-1)!.ts, forming + B);

    fakeNow = forming + 2 * B + 1000;
    failTail = true;
    const h1 = history;
    const r2 = await getCandles('VS-USDT-SWAP', '5m', 600);
    assert.equal(r2.candles.find((c) => c.ts === forming + B)!.v, 500_000);
    assert.ok(history > h1, '补拉失败时必须整段重拉，而不是继续用残缺缓存');
  } finally {
    Date.now = realNow;
  }
});

await test('降级仿真：价格有界、成交额与真实量级一致、OHLC 合法', () => {
  // 真实 5m 成交额中位数量级（USDT）：BTC ~1300万、ETH ~1400万、SOL ~220万
  const real: Record<string, number> = { 'BTC-USDT-SWAP': 13e6, 'ETH-USDT-SWAP': 14e6, 'SOL-USDT-SWAP': 2.2e6 };
  for (const [id, ref] of Object.entries(real)) {
    for (let d = 0; d < 6; d++) {
      const cs = synthCandles(id, '5m', 8640, 1_793_000_000_000 + d * 86_400_000);
      const closes = cs.map((c) => c.c);
      const ratio = Math.max(...closes) / Math.min(...closes);
      assert.ok(ratio < 3, `${id} 价格漂移 ${ratio.toExponential(2)}×（修复前可达 1e28）`);
      const vols = cs.map((c) => c.v).sort((a, b) => a - b);
      const median = vols[Math.floor(vols.length / 2)];
      assert.ok(median > ref / 4 && median < ref * 4, `${id} 成交额中位数 ${median.toExponential(2)} 偏离真实量级 ${ref.toExponential(2)}`);
      assert.ok(cs.every((c) => [c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.l > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)));
    }
  }
});

globalThis.fetch = realFetch;
console.log(`\nvolume: ${passed} 组断言通过`);
process.exit(process.exitCode ?? 0);
