// 回归：盘中形成中那根 K 线的成交量不能往回退（2026-11-10 实测：重连补洞拿到的 REST 快照
// 3,947,416 比已推送的 3,974,587 旧，直接交给图表，成交量柱和高低收往回跳一下）。
// 以及：图层每一帧只遍历屏幕里的 K 线。
import assert from 'node:assert/strict';
import { OKXProvider } from '../src/vela/okxProvider';
import { visibleSpan } from '../src/vela/frameworkLayer';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

type Timer = { fn: () => void; delay: number };
const timers = new Map<number, Timer>();
let timerId = 1;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}

/** OKX 一行：[ts, o, h, l, c, 张, 币, 成交额(USDT), confirm] */
const row = (ts: number, close: number, quote: number, confirm = '0') =>
  [String(ts), '100', String(Math.max(100, close) + 1), String(Math.min(100, close) - 1), String(close), '10', '1', String(quote), confirm];

async function main() {
  const original = { fetch: globalThis.fetch, window: (globalThis as Record<string, unknown>).window, ws: (globalThis as Record<string, unknown>).WebSocket };
  const T = 1_800_000_000_000; // 形成中那根的开盘时间
  let restQuote = 110; // 重连时 REST 返回的形成中那根：比推送旧
  Object.assign(globalThis, {
    window: {
      setTimeout: (fn: () => void, delay: number) => { const id = timerId++; timers.set(id, { fn, delay }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: () => 1,
      clearInterval: () => undefined,
    },
    WebSocket: MockWebSocket,
    fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/market/candles')) {
        return new Response(JSON.stringify({ code: '0', data: [row(T, 100.4, restQuote), row(T - 300_000, 100, 500, '1')] }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200 });
    },
  });

  try {
    const provider = new OKXProvider();
    const got: { time: number; volume: number; close: number }[] = [];
    const stop = provider.subscribe('BTC-USDT-SWAP', '5', b => got.push({ time: b.time, volume: b.volume ?? 0, close: b.close }));
    const ws1 = MockWebSocket.instances.at(-1)!;
    ws1.onopen?.();
    const push = (ws: MockWebSocket, quote: number, close: number) =>
      ws.onmessage?.({ data: JSON.stringify({ arg: { channel: 'candle5m' }, data: [row(T, close, quote)] }) });

    push(ws1, 100, 100.5);
    push(ws1, 120, 100.6);
    // 迟到的旧推送：成交额更小
    push(ws1, 115, 100.3);
    assert.deepEqual(got.map(g => g.volume), [100, 120, 120], '迟到的旧推送不能把成交量改回去');
    assert.equal(got.at(-1)!.close, 100.6);
    pass('1 · 形成中那根：迟到的旧推送不会让成交量和收盘价往回跳');

    // 断线重连：补洞拿到的 REST 快照（110）比已推送的（120）旧
    ws1.onclose?.();
    const reconnect = [...timers.values()].filter(t => t.delay >= 1000 && t.delay <= 30_000).sort((a, b) => a.delay - b.delay)[0];
    timers.clear();
    reconnect.fn();
    const ws2 = MockWebSocket.instances.at(-1)!;
    assert.notEqual(ws2, ws1);
    ws2.onopen?.();
    await new Promise(r => setTimeout(r, 20));
    const after = got.filter(g => g.time === T);
    assert.ok(after.length >= 4, `补洞也应推送形成中那根：${JSON.stringify(got)}`);
    assert.ok(after.every((g, i) => i === 0 || g.volume >= after[i - 1].volume), `成交量不能往回退：${JSON.stringify(after.map(g => g.volume))}`);
    assert.equal(after.at(-1)!.volume, 120);
    pass('2 · 断线重连补洞：REST 快照比推送旧时，图表仍拿到更新的那份（成交量 120，不是 110）');

    // REST 比推送新（推送断了一会儿）：照常用 REST 的
    restQuote = 150;
    ws2.onclose?.();
    const again = [...timers.values()].filter(t => t.delay >= 1000 && t.delay <= 30_000).sort((a, b) => a.delay - b.delay)[0];
    timers.clear();
    again.fn();
    MockWebSocket.instances.at(-1)!.onopen?.();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(got.at(-1)!.volume, 150);
    pass('3 · REST 比推送新时照常采用（断流期间成交继续累加）');
    stop();
  } finally {
    Object.assign(globalThis, { fetch: original.fetch, window: original.window, WebSocket: original.ws });
  }

  // 图层只遍历屏幕里的 K 线
  const bars = Array.from({ length: 10_000 }, (_, i) => ({ time: i * 60_000 }));
  const X = (ms: number) => (ms - 9_000 * 60_000) / 60_000 * 5; // 第 9000 根在 x=0，每根 5px
  const [from, to] = visibleSpan(bars, X, -10, 800 + 10);
  assert.deepEqual([from, to], [8998, 9162]);
  assert.deepEqual(visibleSpan(bars, X, 1e9, 2e9), [10_000, 9_999], '全在屏幕外：空范围');
  pass('4 · 图层每一帧只换算屏幕里的约 165 根，而不是全部 1 万根');
  console.log(`live-forming: ${passed} 项通过`);
}

void main().catch(err => { console.error(err); process.exit(1); });
