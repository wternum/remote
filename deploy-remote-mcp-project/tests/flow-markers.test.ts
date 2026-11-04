// 价格精度 / rubik 代理 / 努力与结果（吸收）标记
import assert from 'node:assert/strict';
import { OKXProvider } from '../src/vela/okxProvider';
import { GET as proxy } from '../src/app/api/okx/[...path]/route';
import { analyzeSignals, projectSignals } from '../src/vela/signals/analyze';
import { DEFAULT_PREFERENCES, type SignalPreferences } from '../src/vela/signals/store';
import type { Candle } from '../src/lib/types';
import type { FlowSnapshot } from '../src/quant/flow';

let passed = 0;
const pass = (n: string) => { passed++; console.log(`  ✓ ${n}`); };

// 1. Vela price axis needs `mintick`, otherwise it shows zoom-dependent decimals.
{
  const p = new OKXProvider();
  const sol = await p.getSymbolInfo('SOL-USDT-SWAP');
  const btc = await p.getSymbolInfo('BTC-USDT-SWAP');
  assert.equal(sol?.mintick, 0.01);
  assert.equal(btc?.mintick, 0.1);
  pass('OKXProvider 提供 mintick（SOL 0.01 / BTC 0.1），价格轴初始即显示正确小数位');
}

// 2. Proxy is strictly whitelisted.
{
  const res = await proxy(new Request('http://x/api/okx/api/v5/account/balance'), { params: Promise.resolve({ path: ['api', 'v5', 'account', 'balance'] }) });
  assert.equal(res.status, 404);
  pass('rubik 代理只放行 taker-volume / open-interest，其它路径 404');
}

// 3. Absorption vs push with real taker data.
{
  const MS = 300_000;
  const NOW = 1_800_000_000_000;
  const end = Math.floor(NOW / MS) * MS - MS;
  const cs: Candle[] = Array.from({ length: 100 }, (_, i) => ({ ts: end - (99 - i) * MS, o: 100, h: 100.3, l: 99.7, c: 100, v: 1000 }));
  cs[70] = { ...cs[70], o: 100, h: 100.2, l: 98.8, c: 99.0, v: 3000 };   // heavy selling, closes low → push
  cs[80] = { ...cs[80], o: 99.6, h: 100.3, l: 99.0, c: 100.2, v: 3000 }; // heavy selling, closes high → absorbed
  cs[90] = { ...cs[90], o: 100, h: 100.1, l: 97.5, c: 98.4, v: 9000 };   // 16x-style climax, balanced taker
  const bars = new Map(cs.map((c, i) => {
    const r = i === 70 || i === 80 ? -0.35 : i === 90 ? -0.08 : 0;
    return [c.ts, { ts: c.ts, buy: c.v * (1 + r) / 2, sell: c.v * (1 - r) / 2, src: 'rubik' as const }];
  }));
  const flow: FlowSnapshot = { instId: 'SOL-USDT-SWAP', period: '5m', barMs: MS, bars, from: cs[0].ts, to: cs.at(-1)!.ts, oiFrom: Infinity, updatedAt: 0, complete: true, tape: { connected: true, trades: 1, bootstrapped: true } };
  const prefs: SignalPreferences = { ...DEFAULT_PREFERENCES, selected: { ...DEFAULT_PREFERENCES.selected, deltaImpulse: true } };
  const items = analyzeSignals(cs, MS, prefs, flow, NOW).items.filter(i => i.type === 'deltaImpulse');
  const push = items.find(i => i.ts === cs[70].ts);
  const absorbed = items.find(i => i.ts === cs[80].ts);
  assert.ok(push && push.event!.text === '卖得猛', `push marker: ${push?.event?.text}`);
  assert.equal(push!.tone, 'short');
  assert.ok(absorbed && absorbed.event!.text === '跌不下去', `absorption marker: ${absorbed?.event?.text}`);
  assert.equal(absorbed!.tone, 'long', 'absorbed selling is a buy-side read');
  assert.ok(absorbed!.detail[0].includes('买 ') && absorbed!.detail[0].includes('卖 '), 'shows actual buy/sell notional');
  const climax = items.find(i => i.ts === cs[90].ts);
  assert.ok(climax && climax.event!.text === '爆量', `climax marker: ${climax?.event?.text}`);
  assert.equal(climax!.tone, 'warn');
  // 密度收敛：即使一段行情里有很多放量 K，图上最多只画 4 个，且彼此至少隔 6 根。
  const crowd: Candle[] = Array.from({ length: 120 }, (_, i) => ({ ts: end - (119 - i) * MS, o: 100, h: 100.3, l: 99.7, c: 100, v: 1000 }));
  for (const i of [60, 64, 68, 72, 76, 80]) crowd[i] = { ...crowd[i], o: 100, h: 100.2, l: 98.5, c: 98.7, v: 6000 };
  const cflow: FlowSnapshot = { ...flow, bars: new Map(crowd.map(c => [c.ts, { ts: c.ts, buy: c.v * 0.3, sell: c.v * 0.7, src: 'rubik' as const }])) };
  const crowdAnalysis = analyzeSignals(crowd, MS, prefs, cflow, NOW);
  const crowdItems = crowdAnalysis.items.filter(i => i.type === 'deltaImpulse');
  assert.ok(crowdItems.length >= 4, '侧栏列表保留全部放量事件');
  const { payload, visible } = projectSignals(crowdAnalysis, prefs);
  const paintedIds = new Set(payload.events.map(e => e.id));
  const painted = crowdItems.filter(i => paintedIds.has(`delta:${i.ts}`));
  assert.ok(painted.length <= 4, `画布最多 4 个力度标签，实际 ${painted.length}`);
  const idx = painted.map(i => crowd.findIndex(c => c.ts === i.ts)).sort((a, b) => a - b);
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] - idx[k - 1] >= 6, '画布上的标签至少隔 6 根');
  assert.equal(visible.filter(i => i.type === 'deltaImpulse').length, crowdItems.length, '侧栏仍能看到全部');
  pass('放量卖出收低 → 卖得猛；收高 → 跌不下去；巨量均衡 → 爆量；画布最多 4 个、间隔 ≥6 根，列表完整');
}

console.log(`\nflow-markers: ${passed} 组断言全部通过`);
