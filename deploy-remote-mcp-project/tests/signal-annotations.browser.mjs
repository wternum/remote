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
const now = Date.now();
const data = (symbol, bar = '5m') => {
  const ms = bar === '1m' ? 60_000 : bar === '15m' ? 900_000 : 300_000;
  const end = Math.floor(now / ms) * ms;
  return annotationCandles(!symbol.startsWith('ETH'), 90, now).map((c, i) => ({ ...c, ts: end - (90 - i) * ms }));
};
const row = c => [String(c.ts), String(c.o), String(c.h), String(c.l), String(c.c), '1', String(c.v / c.c), String(c.v), '1'];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors = [];
const checks = [];
page.on('pageerror', e => errors.push(e.message));
const sockets = new Map();
await page.routeWebSocket(/ws\.okx\.com/, socket => {
  const keys = [];
  socket.onMessage(message => {
    if (message === 'ping') { socket.send('pong'); return; }
    try {
      const msg = JSON.parse(String(message));
      for (const arg of msg.args ?? []) {
        const key = `${arg.channel}|${arg.instId}`;
        sockets.set(key, socket); keys.push(key);
      }
    } catch { /* heartbeat */ }
  });
  socket.onClose(() => { for (const key of keys) if (sockets.get(key) === socket) sockets.delete(key); });
});
await page.route('https://www.okx.com/api/v5/**', async route => {
  const u = new URL(route.request().url());
  const symbol = u.searchParams.get('instId') || 'BTC-USDT-SWAP';
  let values = [];
  if (u.pathname.endsWith('/candles')) values = data(symbol, u.searchParams.get('bar') || '5m').map(row).reverse();
  if (u.pathname.endsWith('/history-trades')) {
    const ctVal = symbol.startsWith('BTC') ? 0.01 : symbol.startsWith('ETH') ? 0.1 : 1;
    const buy = symbol.startsWith('ETH') ? 0.85 : 0.15;
    const trades = data(symbol).flatMap((c, i) => [
      { ts: String(c.ts + 299_000), px: String(c.c), sz: String(c.v * buy / c.c / ctVal), side: 'buy', tradeId: String(i * 2 + 1) },
      { ts: String(c.ts + 299_001), px: String(c.c), sz: String(c.v * (1 - buy) / c.c / ctVal), side: 'sell', tradeId: String(i * 2 + 2) },
    ]).reverse();
    const after = Number(u.searchParams.get('after') || Infinity);
    values = trades.filter(t => Number(t.tradeId) < after).slice(0, 100);
  }
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '0', data: values }) });
});
const meta = () => page.evaluate(() => ({ ...document.querySelector('[data-signal-market]')?.dataset }));
const canvasInk = () => page.evaluate(() => [...document.querySelectorAll('canvas[data-annotation-layer]')].map(canvas => {
  const c = canvas.getContext('2d');
  const rgba = c.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) n++;
  return n;
}));
const capture = async () => page.evaluate(() => {
  const port = window.__velaWs.chart.rendererPort;
  const push = port.setNativeData;
  port.setNativeData = function (id, payload) {
    if (id === 'pd-annot-over') window.__signalTestPayload = payload;
    return push.call(this, id, payload);
  };
});
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

// Measure the content bounds, not just the declared padding, so hover/selected
// rows cannot regress to having labels or controls against the highlight edge.
const assertRowInsets = async (selector, vertical) => {
  const insets = await page.locator(selector).first().evaluate(el => {
    const box = el.getBoundingClientRect();
    const children = [...el.children].map(child => child.getBoundingClientRect());
    return {
      left: Math.min(...children.map(r => r.left)) - box.left,
      right: box.right - Math.max(...children.map(r => r.right)),
      top: Math.min(...children.map(r => r.top)) - box.top,
      bottom: box.bottom - Math.max(...children.map(r => r.bottom)),
      overflow: el.scrollWidth > el.clientWidth,
    };
  });
  assert.ok(insets.left >= 11.5, `${selector}: left content inset must be at least 12px: ${JSON.stringify(insets)}`);
  assert.ok(insets.right >= 11.5, `${selector}: right content inset must be at least 12px: ${JSON.stringify(insets)}`);
  assert.ok(insets.top >= vertical - 0.5 && insets.bottom >= vertical - 0.5, `${selector}: vertical content inset must be at least ${vertical}px: ${JSON.stringify(insets)}`);
  assert.equal(insets.overflow, false, `${selector}: padded content must not overflow`);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: '信号标注设置' })).toBeVisible({ timeout: 45000 });
  await expect.poll(async () => Number((await meta()).signalMarkers), { timeout: 30000 }).toBeGreaterThan(0);
  assert.equal(await page.getByRole('button', { name: '交易', exact: true }).count(), 0);
  const priceGroup = page.locator('.sa-group[aria-label="价格结构"]');
  const tradeGroup = page.locator('.sa-group[aria-label="逐笔订单流"]');
  await expect(priceGroup.locator('.sa-type')).toHaveCount(4);
  await expect(tradeGroup.locator('.sa-type')).toHaveCount(5);
  assert.equal(await priceGroup.locator('[data-signal-type="retest"]').count(), 1, 'price retest must not be misrepresented as trade-flow OFI');
  assert.equal(await tradeGroup.locator('[data-signal-type="keyLevelFlow"]').count(), 1, 'key-level taker context belongs with trade-flow observations');
  assert.equal(await tradeGroup.locator('[data-signal-type="cvdDivergence"]').count(), 1);
  await expect(page.locator('.sa-flow-note')).toContainText('非订单簿 OFI');
  await capture();
  // The runtime skips identical payloads. Explicitly hide then show so the observer
  // sees a real update even when the default selections already cover all fixture marks.
  await page.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect.poll(async () => (await canvasInk()).reduce((s, n) => s + n, 0)).toBe(0);
  await page.getByRole('button', { name: '全部开启', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.__signalTestPayload?.events.some(e => e.id.startsWith('pattern:')))).toBe(true);
  await expect.poll(async () => (await canvasInk()).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
  pass('原生标注侧栏可见，旧交易入口未恢复，真实画布有标记像素');

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.sa-panel');
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--vela-surface)';
    panel.append(probe);
    const themeBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const elements = [panel, ...panel.querySelectorAll('*')];
    const rows = [...panel.querySelectorAll('.sa-type')];
    const content = panel.querySelector('.sa-content').getBoundingClientRect();
    return {
      width: panel.getBoundingClientRect().width,
      background: getComputedStyle(panel).backgroundColor,
      themeBackground,
      gradients: elements.filter(el => getComputedStyle(el).backgroundImage.includes('gradient')).length,
      decoration: panel.querySelectorAll('.sa-intro, .sa-glyph, .sa-title-row, .sa-type-art').length,
      cards: rows.some(el => getComputedStyle(el).borderRadius !== '0px'),
      allRowsFit: rows.at(-1).getBoundingClientRect().bottom <= content.bottom,
    };
  });
  assert.ok(layout.width <= 320 && layout.width >= 300);
  assert.equal(layout.background, layout.themeBackground);
  assert.equal(layout.gradients, 0);
  assert.equal(layout.decoration, 0);
  assert.equal(layout.cards, false);
  assert.equal(layout.allRowsFit, true);
  assert.equal(await page.locator('.sa-header-tag').count(), 0);
  pass('侧栏沿用 Vela 主题色，320px 紧凑列表，无渐变、装饰卡片或英文徽章');

  await page.locator('.sa-type-main').first().hover();
  await assertRowInsets('.sa-type-main', 6);
  const columnAlignment = await page.locator('.sa-group').first().evaluate(group => {
    const heading = group.querySelector('.sa-group-heading > span').getBoundingClientRect();
    const count = group.querySelector('.sa-count').getBoundingClientRect();
    const title = group.querySelector('.sa-group-heading h3').getBoundingClientRect();
    const name = group.querySelector('.sa-type-name').getBoundingClientRect();
    return { countDelta: Math.abs(heading.right - count.right), nameDelta: Math.abs(title.left - name.left) };
  });
  assert.ok(columnAlignment.countDelta <= 1 && columnAlignment.nameDelta <= 1, `Padded header must stay aligned: ${JSON.stringify(columnAlignment)}`);
  await page.locator('.sa-panel').screenshot({ path: '.verification/signals-type-row-spacing.png' });
  pass('类型悬停行左右 12px、上下至少 6px 留白，表头和数量列保持对齐');

  await page.evaluate(() => {
    const d = window.__velaWs.chart.drawings.add('hline', { anchors: [{ time: Date.now() - 300_000, price: 110 }] });
    window.__signalTestDrawing = d?.id;
  });
  assert.ok(await page.evaluate(() => !!window.__signalTestDrawing));
  await page.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect.poll(async () => Number((await meta()).signalMarkers) + Number((await meta()).signalLevels)).toBe(0);
  await expect.poll(async () => (await canvasInk()).reduce((s, n) => s + n, 0)).toBe(0);
  assert.ok(await page.evaluate(() => window.__velaWs.chart.drawings.all().some(d => d.id === window.__signalTestDrawing)));
  pass('一键关闭清空标注画布，不删除用户手动画线');

  await page.getByRole('switch', { name: '显示信号标注', exact: true }).click();
  await expect.poll(async () => Number((await meta()).signalMarkers)).toBeGreaterThan(0);
  await page.getByRole('switch', { name: '双顶标注', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__signalTestPayload?.events.filter(e => e.id.startsWith('pattern:')).length)).toBe(0);
  await page.getByRole('switch', { name: '双顶标注', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__signalTestPayload?.events.some(e => e.id.startsWith('pattern:')))).toBe(true);
  pass('单项开关与总开关可以立即隐藏/恢复同一批标记');

  await page.locator('.sa-options > summary').click();
  await page.getByRole('switch', { name: '未收盘预览', exact: true }).click();
  await page.locator('.sa-options > summary').click();
  await page.getByRole('button', { name: '信号标注', exact: true }).click();
  await expect(page.getByRole('region', { name: '信号标注设置' })).toBeHidden();
  const ts = Math.floor(Date.now() / 300_000) * 300_000;
  const c = { ts, o: 114, h: 116, l: 113, c: 115, v: 3_500_000 };
  await expect.poll(() => sockets.has('candle5m|BTC-USDT-SWAP') && sockets.has('trades|BTC-USDT-SWAP')).toBe(true);
  sockets.get('candle5m|BTC-USDT-SWAP').send(JSON.stringify({ arg: { channel: 'candle5m', instId: 'BTC-USDT-SWAP' }, data: [row(c)] }));
  sockets.get('trades|BTC-USDT-SWAP').send(JSON.stringify({ arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [
    { ts: String(ts + 10), px: '115', sz: String(c.v * 0.85 / 115 / 0.01), side: 'buy', tradeId: '10001' },
    { ts: String(ts + 20), px: '115', sz: String(c.v * 0.15 / 115 / 0.01), side: 'sell', tradeId: '10002' },
  ] }));
  await expect.poll(() => page.evaluate(ts => window.__signalTestPayload?.events.some(e => e.ts === ts && e.text.includes('预览')), ts), { timeout: 15000 }).toBe(true);
  pass('收起侧栏后 WebSocket 新 K 线及成交继续触发标注预览');
  await page.getByRole('button', { name: '信号标注', exact: true }).click();
  await page.getByRole('tab', { name: /最近标记/ }).click();
  await page.locator('.sa-record').first().hover();
  await assertRowInsets('.sa-record', 12);
  await page.locator('.sa-record').first().click();
  await expect(page.locator('.sa-record.is-located')).toHaveCount(1);
  await assertRowInsets('.sa-record.is-located', 12);
  await page.locator('.sa-panel').screenshot({ path: '.verification/signals-recent-row-spacing.png' });
  pass('最近标记列表可定位到图表，悬停和选中项四周至少 12px 留白');
  await page.getByRole('tab', { name: /标注类型/ }).click();
  await page.screenshot({ path: '.verification/signals-fixture-desktop.png' });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.sa-panel').waitFor({ state: 'attached', timeout: 45000 });
  if (!await page.getByRole('region', { name: '信号标注设置' }).isVisible()) await page.getByRole('button', { name: '信号标注', exact: true }).click();
  await expect(page.getByRole('switch', { name: '显示信号标注', exact: true })).toHaveAttribute('aria-checked', 'true');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pulsedesk.signal-annotations.v1')));
  assert.equal(saved.preview, true);
  assert.ok(Object.values(saved.selected).every(Boolean));
  pass('刷新页面保留标注选择和显示设置');

  await capture();
  await page.evaluate(() => window.__velaWs.chart.setMarket({ symbol: 'okx:ETH-USDT-SWAP', timeframe: '5' }));
  await expect.poll(async () => (await meta()).signalMarket, { timeout: 30000 }).toBe('ETH-USDT-SWAP|5');
  await expect.poll(() => page.evaluate(() => window.__signalTestPayload?.events.some(e => e.text === 'W 双底')), { timeout: 30000 }).toBe(true);
  assert.ok(await page.evaluate(() => !window.__signalTestPayload.events.some(e => e.text === 'M 双顶')));
  pass('切换币种清除旧标注并重新识别当前市场');

  await page.evaluate(() => window.__velaWs.chart.setMarket({ symbol: 'okx:ETH-USDT-SWAP', timeframe: '1' }));
  await expect.poll(async () => (await meta()).signalMarket, { timeout: 30000 }).toBe('ETH-USDT-SWAP|1');
  await expect(page.locator('.sa-flow-note')).toContainText('该周期无真实成交聚合');
  pass('不支持真实订单流的周期明确提示，不混用旧周期证据');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  console.log('MOBILE PANEL', await page.getByRole('region', { name: '信号标注设置' }).isVisible());
  if (await page.getByRole('region', { name: '信号标注设置' }).isVisible()) {
    const box = await page.locator('.sa-panel').boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= 391, 'sidebar must fit mobile viewport');
    await page.getByRole('button', { name: '全部关闭', exact: true }).click();
    await expect(page.getByRole('switch', { name: '显示信号标注', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: '全部开启', exact: true }).click();
    await page.locator('.sa-type-main').first().scrollIntoViewIfNeeded();
    await assertRowInsets('.sa-type-main', 6);
    await page.getByRole('tab', { name: /最近标记/ }).click();
    await expect(page.locator('.sa-record').first()).toBeVisible();
    await assertRowInsets('.sa-record', 12);
    await page.locator('.sa-panel').screenshot({ path: '.verification/signals-recent-row-spacing-mobile.png' });
    await page.getByRole('tab', { name: /标注类型/ }).click();
    pass('移动端两类列表均保留内边距，无横向溢出且一键开关可用');
  } else {
    throw new Error('Mobile layout hid the open annotation panel; verify native mobile entry.');
  }
  await page.screenshot({ path: '.verification/signals-mobile.png' });
  assert.deepEqual(errors, [], 'browser must not raise uncaught JavaScript errors');
  pass('浏览器零脚本异常');
  await writeFile('.verification/signals-browser-report.json', JSON.stringify({ checks, errors, dataSource: 'Test-only mocked OKX REST/WS fixtures; production never imports them.' }, null, 2));
} catch (e) {
  console.error('BROWSER FAIL', e);
  await page.screenshot({ path: '.verification/signals-failure.png' }).catch(() => undefined);
  console.log('BODY', (await page.locator('body').innerText()).slice(-6500));
  console.log('ERRORS', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
