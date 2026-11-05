// Deterministic UI integration suite. Mocked market data never enters the shipped application.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const url = process.env.TEST_URL || 'http://127.0.0.1:3000/';
await mkdir('.verification', { recursive: true });
const bundle = path.resolve('.verification/signal-fixtures.mjs');
await build({ entryPoints: ['tests/signal-fixtures.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', alias: { '@': path.resolve('src') }, logLevel: 'silent' });
const { annotationCandles } = await import(pathToFileURL(bundle).href);
const MS = 300_000;
const now = Math.floor(Date.now() / MS) * MS + 60_000;
const data = (symbol, bar = '5m') => {
  const ms = bar === '1m' ? 60_000 : bar === '15m' ? 900_000 : MS;
  const end = Math.floor(now / ms) * ms;
  return annotationCandles(!symbol.startsWith('ETH'), 90, now).map((c, i) => ({ ...c, ts: end - (90 - i) * ms }));
};
const row = c => [String(c.ts), String(c.o), String(c.h), String(c.l), String(c.c), '1', String(c.v / c.c), String(c.v), '1'];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
await page.clock.install({ time: now });
const errors = [], checks = [], sockets = new Map();
page.on('pageerror', e => errors.push(e.message));
await page.routeWebSocket(/ws\.okx\.com/, socket => {
  const keys = [];
  socket.onMessage(message => {
    if (message === 'ping') { socket.send('pong'); return; }
    try { for (const arg of JSON.parse(String(message)).args ?? []) { const key = `${arg.channel}|${arg.instId}`; sockets.set(key, socket); keys.push(key); } } catch { /* heartbeat */ }
  });
  socket.onClose(() => { for (const key of keys) if (sockets.get(key) === socket) sockets.delete(key); });
});
const reply = async route => {
  const u = new URL(route.request().url());
  const symbol = u.searchParams.get('instId') || 'BTC-USDT-SWAP', buy = symbol.startsWith('ETH') ? .85 : .15;
  let values = [];
  if (u.pathname.endsWith('/candles')) values = data(symbol, u.searchParams.get('bar') || '5m').map(row).reverse();
  if (u.pathname.endsWith('/taker-volume-contract')) {
    const end = Number(u.searchParams.get('end') || Infinity);
    values = data(symbol).filter(c => c.ts < end).map(c => [String(c.ts), String(c.v * (1 - buy)), String(c.v * buy)]).reverse();
  }
  if (u.pathname.endsWith('/history-trades')) {
    const ctVal = symbol.startsWith('BTC') ? .01 : symbol.startsWith('ETH') ? .1 : 1;
    const after = Number(u.searchParams.get('after') || Infinity);
    values = data(symbol).flatMap((c, i) => [
      { ts: String(c.ts + 299_000), px: String(c.c), sz: String(c.v * buy / c.c / ctVal), side: 'buy', tradeId: String(i * 2 + 1) },
      { ts: String(c.ts + 299_001), px: String(c.c), sz: String(c.v * (1 - buy) / c.c / ctVal), side: 'sell', tradeId: String(i * 2 + 2) },
    ]).reverse().filter(t => Number(t.tradeId) < after).slice(0, 100);
  }
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '0', data: values }) });
};
await page.route('https://www.okx.com/api/v5/**', reply);
await page.route('**/api/okx/**', reply); // Do not let the server proxy mix real data with fixtures.
const meta = () => page.evaluate(() => ({ ...document.querySelector('[data-signal-market]')?.dataset }));
const payload = () => page.evaluate(() => window.__signalTestPayload);
const capture = async () => page.evaluate(() => {
  const port = window.__velaWs.chart.rendererPort, push = port.setNativeData;
  port.setNativeData = function(id, data) { if (id === 'pd-annot-over') window.__signalTestPayload = data; return push.call(this, id, data); };
});
const ink = () => page.evaluate(() => [...document.querySelectorAll('canvas[data-annotation-layer]')].reduce((sum, c) => {
  const bytes = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) n++;
  return sum + n;
}, 0));
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const tab = name => page.getByRole('tab', { name: new RegExp(name) }).click();
const openPanel = async () => { if (!(await page.getByRole('region', { name: '信号标注设置' }).isVisible())) await page.getByRole('button', { name: '信号标注', exact: true }).click(); };
const sendCandle = c => sockets.get('candle5m|BTC-USDT-SWAP').send(JSON.stringify({ arg: { channel: 'candle5m', instId: 'BTC-USDT-SWAP' }, data: [row(c)] }));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: '信号标注设置' })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.sa-story-record')).toHaveCount(1, { timeout: 30000 });
  assert.equal(await page.getByRole('button', { name: '交易', exact: true }).count(), 0);
  await expect(page.locator('.sa-story-detail .sa-story-section')).toHaveCount(6);
  await expect(page.locator('.sa-story-evidence-bar')).toContainText('成交 2/2', { timeout: 30000 });
  await expect(page.locator('.sa-story-key-prices')).toContainText('120');
  await expect(page.getByRole('button', { name: /^正在跟踪/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^含历史/ }).click();
  await expect(page.getByRole('button', { name: /^含历史/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^正在跟踪/ }).click();
  pass('默认先看双顶双底，一形态一记录、六段证据、真实覆盖可见');

  await capture();
  await page.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect.poll(ink).toBe(0);
  await page.getByRole('switch', { name: '显示信号标注', exact: true }).click();
  await expect.poll(async () => (await payload())?.events.filter(e => e.id.startsWith('mw:')).length).toBe(1);
  assert.ok((await payload()).zones.length <= 2);
  assert.ok((await payload()).levels.length <= 2);
  assert.ok((await payload()).paths.length === 1);
  await expect.poll(ink).toBeGreaterThan(0);
  pass('实际canvas有一组M/W标记、关键位/颈线和有限区带，无重复证据标签');

  await page.locator('.sa-story-section').filter({ has: page.locator('summary', { hasText: '真实成交证据' }) }).locator('summary').click();
  await expect(page.locator('.sa-story-detail')).toContainText('OKX 官方统计');
  await expect(page.locator('.sa-story-detail')).toContainText('不是订单簿 OFI');
  await page.locator('.sa-story-timeline summary').click();
  await expect(page.locator('.sa-story-timeline ol button').first()).toBeVisible();
  await page.locator('.sa-story-timeline ol button').first().click();
  await expect(page.locator('.sa-record.is-located')).toHaveCount(1);
  pass('六段详情可展开、事件时间线可点击定位，不把观察说成胜率');

  await tab('显示设置');
  await expect(page.locator('.sa-type')).toHaveCount(7);
  await expect(page.locator('.sa-group[aria-label="双顶双底标注"] .sa-type')).toHaveCount(3);
  await expect(page.locator('.sa-group[aria-label="辅助背景"] .sa-type')).toHaveCount(4);
  await expect(page.getByRole('switch', { name: '成交力度标注', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-signal-type="bullTrap"], [data-signal-type="keyLevelFlow"], [data-signal-type="cvdDivergence"]')).toHaveCount(0);
  await page.getByRole('switch', { name: '突破回踩区标注', exact: true }).click();
  await expect.poll(async () => (await payload()).zones.length).toBe(0);
  assert.equal((await payload()).events.filter(e => e.id.startsWith('mw:')).length, 1);
  await page.getByRole('switch', { name: '突破回踩区标注', exact: true }).click();
  await page.getByRole('switch', { name: '双顶判读标注', exact: true }).click();
  await expect.poll(async () => (await payload()).events.length + (await payload()).zones.length).toBe(0);
  await page.getByRole('switch', { name: '双顶判读标注', exact: true }).click();
  await expect.poll(async () => (await payload()).events.length).toBeGreaterThan(0);
  pass('7个控制项生效：区带单独切换；关闭形态无孤儿标记/区带');

  const inset = await page.locator('.sa-type-main').first().evaluate(el => {
    const r = el.getBoundingClientRect(), kids = [...el.children].map(x => x.getBoundingClientRect());
    return { left: Math.min(...kids.map(k => k.left)) - r.left, right: r.right - Math.max(...kids.map(k => k.right)), overflow: el.scrollWidth > el.clientWidth };
  });
  assert.ok(inset.left >= 11.5 && inset.right >= 11.5 && !inset.overflow);
  const drawingId = await page.evaluate(() => window.__velaWs.chart.drawings.add('hline', { anchors: [{ time: Date.now() - 300_000, price: 110 }] })?.id);
  assert.ok(drawingId);
  await page.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect.poll(ink).toBe(0);
  assert.ok(await page.evaluate(id => window.__velaWs.chart.drawings.all().some(d => d.id === id), drawingId));
  await page.getByRole('switch', { name: '显示信号标注', exact: true }).click();
  await expect.poll(() => sockets.has('trades|BTC-USDT-SWAP'), { timeout: 15000 }).toBe(true);
  pass('类型列表内边距正确；隐藏不删手绘；快速关闭/恢复后成交流重连');

  await tab('双顶双底');
  const originalTitle = await page.locator('.sa-story-record .sa-record-copy strong').first().textContent();
  await expect.poll(() => sockets.has('candle5m|BTC-USDT-SWAP')).toBe(true);
  const ts = Math.floor(now / MS) * MS;
  sendCandle({ ts, o: 114, h: 151, l: 113, c: 150, v: 3_500_000 });
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.sa-story-record .sa-record-copy strong').first().textContent(), originalTitle);
  await expect(page.locator('.sa-story-preview')).toHaveCount(0);
  await page.locator('.sa-options > summary').click();
  await page.getByRole('switch', { name: '未收盘预览', exact: true }).click();
  await page.locator('.sa-options > summary').click();
  await expect(page.locator('.sa-story-preview')).toContainText('盘中', { timeout: 15000 });
  assert.equal(await page.locator('.sa-story-record .sa-record-copy strong').first().textContent(), originalTitle);
  pass('未收盘价剧变不改已确认结论；开启预览只增加独立盘中提示');

  await tab('显示设置');
  await page.getByRole('switch', { name: '成交力度标注', exact: true }).click();
  await page.getByRole('button', { name: '信号标注', exact: true }).click();
  await expect(page.getByRole('region', { name: '信号标注设置' })).toBeHidden();
  sendCandle({ ts, o: 114, h: 116, l: 113, c: 115, v: 3_500_000 });
  await expect.poll(() => sockets.has('trades|BTC-USDT-SWAP'), { timeout: 15000 }).toBe(true);
  sockets.get('trades|BTC-USDT-SWAP').send(JSON.stringify({ arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [
    { ts: String(ts + 10), px: '115', sz: String(3_500_000 * .85 / 115 / .01), side: 'buy', tradeId: '10001' },
    { ts: String(ts + 20), px: '115', sz: String(3_500_000 * .15 / 115 / .01), side: 'sell', tradeId: '10002' },
  ] }));
  await expect.poll(async () => !!(await payload())?.events.some(e => e.ts === ts && e.text.includes('预览')), { timeout: 20000 }).toBe(true);
  await openPanel(); await tab('双顶双底');
  await expect(page.locator('.sa-story-preview')).toContainText('115');
  pass('收起侧栏仍处理WebSocket K线与成交；Δ预览明确标识');

  await tab('显示设置');
  await page.getByRole('switch', { name: '结构补充标注', exact: true }).click();
  await tab('双顶双底');
  await expect(page.locator('[data-mw-smc]')).toHaveCount(1);
  await expect(page.locator('.sa-story-record')).toHaveCount(1);
  pass('SMC结构补充并入同一详情，不再生成重复形态记录');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => !!window.__velaWs?.chart), { timeout: 45000 }).toBe(true);
  await openPanel();
  await expect(page.locator('.sa-story-record')).toHaveCount(1, { timeout: 30000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pulsedesk.signal-annotations.v2')));
  assert.equal(saved.version, 2); assert.equal(saved.preview, true); assert.equal(saved.selected.smartMoney, true);
  assert.equal(Object.keys(saved.selected).length, 7);
  pass('新版7项偏好与预览选项刷新后保留');

  await capture();
  await page.evaluate(() => window.__velaWs.chart.setMarket({ symbol: 'okx:ETH-USDT-SWAP', timeframe: '5' }));
  await expect.poll(async () => (await meta()).signalMarket, { timeout: 30000 }).toBe('ETH-USDT-SWAP|5');
  await expect(page.locator('.sa-story-record .sa-record-copy strong').first()).toContainText('双底', { timeout: 30000 });
  await expect.poll(async () => !!(await payload())?.events.some(e => e.id.startsWith('mw:bottom:'))).toBe(true);
  assert.ok(!(await payload()).events.some(e => e.id.startsWith('mw:top:')));
  pass('切换市场立即清旧标注，ETH镜像显示双底而非残留双顶');

  await page.evaluate(() => window.__velaWs.chart.setMarket({ symbol: 'okx:ETH-USDT-SWAP', timeframe: '1' }));
  await expect.poll(async () => (await meta()).signalMarket, { timeout: 30000 }).toBe('ETH-USDT-SWAP|1');
  await expect(page.locator('.sa-data-status')).toContainText('当前周期无成交聚合');
  await tab('显示设置');
  await expect(page.locator('.sa-flow-note')).toContainText('该周期无真实成交聚合');
  pass('不支持成交聚合的周期明确提示，不复用旧周期证据');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800); await openPanel(); await tab('双顶双底');
  await expect(page.locator('.sa-story-detail')).toBeVisible();
  const mobile = await page.locator('.sa-panel').evaluate(el => ({ width: el.getBoundingClientRect().width, overflow: el.scrollWidth > el.clientWidth }));
  assert.ok(mobile.width <= 390 && !mobile.overflow);
  await page.screenshot({ path: '.verification/mw-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500); await openPanel();
  await page.screenshot({ path: '.verification/mw-desktop.png' });
  assert.deepEqual(errors, []);
  pass('移动端六段详情可读、无横向溢出，桌面/手机截图完成，零脚本异常');
  await writeFile('.verification/mw-browser-report.json', JSON.stringify({ url, checks, errors, source: 'TEST-ONLY deterministic REST/WS fixtures, not market performance.' }, null, 2));
} catch (error) {
  console.error('BROWSER FAIL', error);
  console.error('BODY', (await page.locator('body').innerText()).slice(-12000));
  console.error('META', await meta()); console.error('ERRORS', errors);
  await page.screenshot({ path: '.verification/mw-browser-failure.png' }).catch(() => undefined);
  process.exitCode = 1;
} finally { await browser.close(); }
