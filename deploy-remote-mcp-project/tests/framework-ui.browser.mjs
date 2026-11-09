// Browser regression for framework markings and the redesigned terminal UI.
// Run after the production preview is listening: node tests/framework-ui.browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const url = process.env.TEST_URL || 'http://127.0.0.1:3000/';
const MS = 300_000;
const now = Math.floor(Date.now() / MS) * MS + 60_000;
const formingTs = Math.floor(now / MS) * MS;
const closedLast = formingTs - MS;
const count = 300;
const candles = Array.from({ length: count }, (_, i) => {
  const ts = closedLast - (count - 1 - i) * MS;
  const p = 90_000 + i * 18 + Math.sin(i / 2.5) * 140;
  return { ts, o: p, h: p + 35, l: p - 35, c: p + 12, v: p * 10, confirm: 1 };
});
const lastClose = candles[candles.length - 1].c;
const forming = { ts: formingTs, o: lastClose, h: lastClose + 40, l: lastClose - 30, c: lastClose + 8, v: 500, confirm: 0 };
const row = c => [String(c.ts), String(c.o), String(c.h), String(c.l), String(c.c), '10', '10', String(c.v), String(c.confirm)];
const restData = [forming, ...[...candles].reverse()].map(row);

await mkdir('.verification', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.routeWebSocket(/ws\.okx\.com/, socket => {
  socket.onMessage(message => { if (message === 'ping') socket.send('pong'); });
});
await page.route('https://www.okx.com/api/v5/**', async route => {
  const u = new URL(route.request().url());
  const data = u.pathname.endsWith('/candles') ? restData : [];
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '0', data }) });
});
await page.route('**/api/okx/**', async route => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: '0', data: [] }) });
});

const ink = () => page.evaluate(() => [...document.querySelectorAll('canvas[data-framework-layer]')].reduce((sum, c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return sum + n;
}, 0));
const payload = () => page.evaluate(() => window.__fwPayloads?.['pd-fw-over'] ?? null);

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.fw-bar', { timeout: 30_000 });
  await page.waitForSelector('canvas[data-framework-layer="pd-fw-over"]', { timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('canvas[data-framework-layer]')].some(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  }), null, { timeout: 30_000 });

  await page.evaluate(() => {
    const port = window.__velaWs.chart.rendererPort;
    const original = port.setNativeData.bind(port);
    window.__fwPayloads = {};
    port.setNativeData = (id, data) => {
      if (id === 'pd-fw-over' || id === 'pd-fw-under') window.__fwPayloads[id] = data;
      return original(id, data);
    };
  });

  // Force a repaint after installing the payload capture.
  await page.locator('.fw-bar-btn').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('canvas[data-framework-layer]')].every(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }), null, { timeout: 10_000 });
  assert.equal(await ink(), 0, 'master off must clear framework canvas ink');
  await page.locator('.fw-bar-btn').first().click();
  await page.waitForFunction(() => window.__fwPayloads?.['pd-fw-over']?.payload?.levels?.length > 0, null, { timeout: 10_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('canvas[data-framework-layer]')].some(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  }), null, { timeout: 10_000 });
  const initialInk = await ink();
  assert.ok(initialInk > 200, `expected visible framework markings, got ${initialInk}`);

  const p = await payload();
  assert.ok(p.payload.levels.some(l => l.id === 'fw:amt:poc'), 'quote-volume AMT POC should be drawn');
  assert.ok(p.payload.events.length > 0, 'confirmed structure/fractal events should be drawn');
  assert.ok(p.payload.events.every(e => e.ts <= closedLast && e.ts !== formingTs), 'markers must not attach to the forming candle');
  assert.ok(p.payload.levels.every(l => l.fromTs <= closedLast), 'level anchors must come from closed history');
  assert.ok(p.payload.zones.every(z => z.fromTs <= closedLast), 'FVG anchors must come from closed history');
  const keys = p.payload.events.map(e => `${e.ts}:${e.side}`);
  assert.equal(new Set(keys).size, keys.length, 'one marker per candle side');
  await page.screenshot({ path: '.verification/fw-ui-chart.png' });

  // Individual AMT toggle removes only AMT levels.
  await page.getByRole('button', { name: '展开图表标注选项' }).click();
  await page.getByRole('button', { name: /AMT 价值区/ }).click();
  await page.waitForFunction(() => {
    const levels = window.__fwPayloads?.['pd-fw-over']?.payload?.levels ?? [];
    return levels.length > 0 && levels.every(l => !l.id.startsWith('fw:amt:'));
  }, null, { timeout: 10_000 });
  await page.getByRole('button', { name: /AMT 价值区/ }).click();
  await page.waitForFunction(() => (window.__fwPayloads?.['pd-fw-over']?.payload?.levels ?? []).some(l => l.id === 'fw:amt:poc'), null, { timeout: 10_000 });
  await page.screenshot({ path: '.verification/fw-ui-menu.png' });
  await page.keyboard.press('Escape');

  // Redesigned panel: neutral terminal styling, status line instead of normal-forming warning.
  await page.getByRole('button', { name: '四框架分析', exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="四框架结构分析"]', { timeout: 10_000 });
  await page.waitForSelector('.fw-summary-cell', { timeout: 10_000 });
  assert.equal(await page.locator('.fw-summary-cell').count(), 4);
  await page.waitForFunction(() => document.querySelector('.fw-status')?.textContent?.includes('形成中'), null, { timeout: 10_000 });
  const statusText = await page.locator('.fw-status').innerText();
  assert.ok(statusText.includes(String(count)), `panel should report ${count} closed candles, got: ${statusText}`);
  const panelText = await page.locator('.fw-panel').innerText();
  assert.ok(panelText.includes('结构汇总'));
  assert.ok(panelText.includes('多周期分形对齐'));
  assert.ok(panelText.includes('拍卖市场价值区'));
  await page.screenshot({ path: '.verification/fw-ui-panel.png' });
  await page.keyboard.press('Escape');

  // Mobile layout must not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile horizontal overflow');
  await page.getByRole('button', { name: '展开图表标注选项' }).click();
  await page.screenshot({ path: '.verification/fw-ui-mobile.png' });

  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ ok: true, initialInk, levels: p.payload.levels.length, events: p.payload.events.length, zones: p.payload.zones.length, closedLast, formingTs, errors }));
} catch (error) {
  await page.screenshot({ path: '.verification/fw-ui-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
