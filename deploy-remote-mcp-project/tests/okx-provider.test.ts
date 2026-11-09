import assert from 'node:assert/strict';
import { OKXProvider, barsHub } from '../src/vela/okxProvider';

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
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const row = (ts: number, close: number) => [String(ts), String(close), String(close + 1), String(close - 1), String(close), '1', '1', String(close * 10), '1'];

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  const requests: string[] = [];
  let historyPages = 0;

  Object.assign(globalThis, {
    window: {
      setTimeout: (fn: () => void, delay: number) => {
        const id = timerId++;
        timers.set(id, { fn, delay });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: () => 1,
      clearInterval: () => undefined,
    },
    WebSocket: MockWebSocket,
    fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/market/candles')) {
        // OKX 常见倒序：最新在前。旧实现会把数组最后一根当最新推给图表。
        return new Response(JSON.stringify({ code: '0', data: [row(3_000, 103), row(2_000, 102), row(1_000, 101)] }), { status: 200 });
      }
      if (url.pathname.endsWith('/market/history-candles')) {
        historyPages++;
        if (historyPages === 1) {
          return new Response(JSON.stringify({ code: '0', data: [['bad', '1', '2', '0.5', '1', '1', '1', '10', '1'], row(500, 100)] }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200 });
    },
  });

  try {
    const provider = new OKXProvider();
    const pushed: number[] = [];
    const stop = provider.subscribe('BTC-USDT-SWAP', '5', bar => pushed.push(bar.time));
    assert.equal(MockWebSocket.instances.length, 1);
    MockWebSocket.instances[0].onopen?.();
    assert.deepEqual(pushed, [], '首次连接由 REST 初始加载负责，不额外推送旧 K 线');

    MockWebSocket.instances[0].onclose?.();
    assert.equal(timers.size, 1, '断线后应安排重连');
    const reconnect = [...timers.values()][0];
    timers.clear();
    reconnect.fn();
    assert.equal(MockWebSocket.instances.length, 2);
    MockWebSocket.instances[1].onopen?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(pushed, [3_000], '重连补洞必须推送时间戳最新的一根，而不是倒序数组最后一根');
    const mirrored = barsHub.get('BTC-USDT-SWAP', '5');
    assert.deepEqual(mirrored.map(b => b.time), [1_000, 2_000, 3_000], '镜像仍按时间升序保存');
    stop();

    const bars = await provider.getBars('BTC-USDT-SWAP', '5', { limit: 2 });
    assert.deepEqual(bars.map(b => b.time), [500, 1_000, 2_000, 3_000], '异常历史行不能污染分页游标或中断有效历史合并');
    assert.ok(requests.some(r => r.includes('/market/history-candles')), '历史分页应被请求');
    console.log('okx-provider: descending REST backfill pushes newest bar; invalid history rows do not poison pagination');
  } finally {
    Object.assign(globalThis, { fetch: originalFetch, window: originalWindow, WebSocket: originalWebSocket });
    timers.clear();
    MockWebSocket.instances = [];
  }
}

await main();
