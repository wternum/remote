// 回归：每个币种 / 周期各算各的，结果不取决于用户当前正在看哪张图。
import assert from 'node:assert/strict';
import type { Candle } from '@/lib/types';
import { buildFrameworks } from '@/quant/frameworks';
import { DEFAULT_FRAMEWORK_MARK_PREFS, projectFrameworkMarks } from '@/quant/frameworkMarks';

let passed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const g = globalThis as unknown as Record<string, unknown>;

// 1. 浏览器里的确认引擎扫描 ALL：三个币各自同步自己的 rubik 统计，不开实时 WS
{
  const B = 300_000;
  const last = Math.floor(Date.now() / B) * B - B; // 最新一根已收盘
  const base: Record<string, number> = { 'BTC-USDT-SWAP': 75000, 'ETH-USDT-SWAP': 2100, 'SOL-USDT-SWAP': 86 };
  const row = (inst: string, ts: number) => {
    const p = base[inst] * (1 + 0.002 * Math.sin(ts / B / 7));
    return [String(ts), String(p), String(p * 1.001), String(p * 0.999), String(p), '100', '10', String(10 * p), '1'];
  };
  const rubikHits = new Map<string, number>();
  let sockets = 0;
  const origWin = g.window, origWs = g.WebSocket, origFetch = globalThis.fetch;
  g.window = { location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
  g.WebSocket = class { constructor() { sockets++; } close() {} send() {} };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const inst = u.searchParams.get('instId') ?? '';
    const limit = Number(u.searchParams.get('limit') ?? 100);
    if (u.pathname.includes('/rubik/')) {
      rubikHits.set(inst, (rubikHits.get(inst) ?? 0) + 1);
      assert.ok(u.href.startsWith('http://127.0.0.1:3000/api/okx/'), `browser rubik must use the same-origin proxy: ${u.href}`);
      return Response.json({ code: '0', data: [] });
    }
    if (u.pathname.endsWith('/market/candles') || u.pathname.endsWith('/market/history-candles')) {
      const after = Number(u.searchParams.get('after') ?? last + B);
      const rows = Array.from({ length: limit }, (_, k) => row(inst, after - (k + 1) * B));
      return Response.json({ code: '0', data: rows });
    }
    return Response.json({ code: '0', data: [] });
  }) as typeof fetch;
  try {
    const { GET } = await import('@/api/engine');
    const res = await GET(new Request('http://127.0.0.1:3000/api/engine/scan?symbol=ALL&bar=5m&fresh=1'));
    const body = await res.json() as { dataReady: boolean };
    assert.equal(body.dataReady, true);
    for (const inst of Object.keys(base)) assert.ok((rubikHits.get(inst) ?? 0) > 0, `${inst} must sync its own flow, got ${JSON.stringify([...rubikHits])}`);
    assert.equal(sockets, 0, 'a batch scan must not open live trade WebSockets nobody releases');
  } finally {
    if (origWin === undefined) delete g.window; else g.window = origWin;
    if (origWs === undefined) delete g.WebSocket; else g.WebSocket = origWs;
    globalThis.fetch = origFetch;
  }
  pass('1 · 浏览器端扫描 ALL 时 BTC/ETH/SOL 各自经代理同步订单流，不再只有当前图表那个币有数据');
}

// 2. 窗口时长按周期换算：4H 显示天数，不再是"480 小时"
{
  const H4 = 4 * 3_600_000, T0 = 1_800_000_000_000;
  const cs: Candle[] = Array.from({ length: 200 }, (_, i) => {
    const p = 100 + Math.sin(i / 5) * 3;
    return { ts: T0 + i * H4, o: p, h: p + 0.6, l: p - 0.6, c: p + 0.1, v: 1000, confirm: 1, volumeSource: 'quote' };
  });
  const r = buildFrameworks(cs, H4, 'SOL-USDT-SWAP', '4h', null, T0 + 200 * H4)!;
  const poc = projectFrameworkMarks(r, DEFAULT_FRAMEWORK_MARK_PREFS, H4).payload.levels.find(l => l.id === 'fw:amt:poc')!;
  assert.ok(poc.detail![0].startsWith('最近 20 天'), poc.detail![0]);
  pass('2 · 4H 价值区窗口写作"最近 20 天"，不是"480 小时"');
}

console.log(`\nmarket-isolation: ${passed} groups passed`);
