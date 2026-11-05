import assert from 'node:assert/strict';
import { fetchStatsProxy } from '@/runtime/statsProxy';
import { syncFlow, releaseTape, getFlow } from '@/quant/flow';
const req = () => new Request('http://localhost/api/okx/api/v5/rubik/stat/taker-volume-contract');
let calls = 0;
{
  const error = Response.json({ code: '502', data: [] }, { status: 502 });
  assert.equal(await fetchStatsProxy(req(), async () => { calls++; return error; }), error);
  assert.equal(calls, 1, 'do not retry direct to non-CORS upstream after a proxy error');
  const html = await fetchStatsProxy(req(), async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(html.status, 503); assert.deepEqual((await html.json()).data, []);
  const ctl = new AbortController();
  const r = new Request(req(), { signal: ctl.signal }); ctl.abort();
  const before = calls;
  await assert.rejects(fetchStatsProxy(r, async () => { calls++; return Response.json({ data: [] }); }), { name: 'AbortError' });
  assert.equal(calls, before);
  await assert.rejects(fetchStatsProxy(req(), async () => { throw new DOMException('aborted', 'AbortError'); }), { name: 'AbortError' });
  console.log('PASS proxy JSON errors pass through, HTML is not statistics, abort never becomes upstream CORS fallback');
}
{
  const g = globalThis as unknown as Record<string, unknown>;
  const original = { window: g.window, WebSocket: g.WebSocket, fetch: globalThis.fetch };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null;
    onmessage: unknown; onerror: unknown;
    constructor() { sockets.push(this); }
    send() { /* no actual network */ }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  try {
    g.window = { location: { origin: 'http://localhost' } }; g.WebSocket = FakeSocket;
    const ctl = new AbortController();
    globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    const pending = syncFlow('BTC-USDT-SWAP', '5m', { minTs: 0, maxPages: 1, oiPages: 0, bootstrapPages: 0, signal: ctl.signal });
    assert.equal(sockets.length, 1, 'live WebSocket must exist before the first history response');
    ctl.abort(); await pending;
    assert.equal(getFlow('BTC-USDT-SWAP', '5m')!.rubikFailedAt, 0, 'user cancellation is not a 5-minute upstream outage');
    releaseTape('BTC-USDT-SWAP');
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({ code: '0', data: [] }); }) as typeof fetch;
    await syncFlow('BTC-USDT-SWAP', '5m', { minTs: 0, maxPages: 1, oiPages: 0, bootstrapPages: 0 });
    assert.equal(sockets.length, 2); assert.ok(requests > 0, 're-enable must retry statistics rather than inherit cancellation cooldown');
    console.log('PASS live tape connects before history; cancellation does not block immediate re-subscription');
  } finally {
    releaseTape('BTC-USDT-SWAP'); globalThis.fetch = original.fetch;
    if (original.window === undefined) delete g.window; else g.window = original.window;
    g.WebSocket = original.WebSocket;
  }
}
