import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5173/';
const out = '.verification/symbols';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const errors = [];
const passed = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text())) errors.push(m.text()); });
const pass = name => { passed.push(name); console.log('PASS', name); };

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('.vela-dtb').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);

  // Symbol picker: three OKX perpetuals, official marks, only relevant tabs.
  await page.locator('.vela-widget-symbol').first().click();
  await page.waitForTimeout(900);
  const dialog = page.locator('.vela-sp-tabs').first();
  await expect(dialog).toBeVisible();
  const rows = page.locator('.vela-dialog').filter({ hasText: '品种搜索' }).locator('button, [role="option"], li');
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.src.startsWith('data:image/svg+xml')).every(i => i.complete && i.naturalWidth > 0)), { timeout: 10000 }).toBe(true);
  const names = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.vela-sp-tab')];
    const visibleTabs = tabs.filter(t => t.getBoundingClientRect().width > 0).map(t => t.textContent.trim());
    const tabsRoot = tabs[0]?.closest('.vela-dialog');
    const imgs = [...(tabsRoot ?? document).querySelectorAll('img')].filter(i => i.src.startsWith('data:image/svg+xml')).map(i => ({
      w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height,
      ok: i.complete && i.naturalWidth > 0, src: decodeURIComponent(i.src).slice(0, 300),
    }));
    const list = [...(tabsRoot ?? document).querySelectorAll('*')].filter(n => /^[A-Z]+-USDT-SWAP$/.test((n.textContent || '').trim()) && n.children.length === 0).map(n => n.textContent.trim());
    return { visibleTabs, imgs, list };
  });
  assert.deepEqual([...new Set(names.list)].sort(), ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
  assert.deepEqual(names.visibleTabs, ['全部', '加密货币']);
  console.log('IMGS', JSON.stringify(names.imgs, null, 1));
  assert.equal(names.imgs.length, 3);
  assert.ok(names.imgs.every(i => i.ok && i.w >= 24));
  assert.ok(names.imgs.some(i => i.src.includes('#F7931A')));
  assert.ok(names.imgs.some(i => i.src.includes('#627EEA')));
  assert.ok(names.imgs.some(i => i.src.includes('#9945FF')));
  await page.screenshot({ path: `${out}/final-picker.png` });
  pass('Symbol picker lists exactly BTC/ETH/SOL with all three brand marks');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  for (const [coin, symbol] of [['BTC', 'okx:BTC-USDT-SWAP'], ['ETH', 'okx:ETH-USDT-SWAP'], ['SOL', 'okx:SOL-USDT-SWAP']]) {
    await page.locator('.vela-widget-symbol').first().click();
    await page.waitForTimeout(700);
    await page.getByText(`${coin}-USDT-SWAP`, { exact: true }).first().click();
    await page.waitForTimeout(2200);
    assert.equal(await page.evaluate(() => window.__velaWs.chart.market.symbol), symbol);
    await expect(page.locator('.vela-widget-symbol').first()).toContainText(coin);
  }
  await page.screenshot({ path: `${out}/final-sol-chart.png` });
  pass('Each of the three markets switches the chart and topbar');

  // Library search field: one rounded container, no nested focus rectangle.
  await page.getByRole('button', { name: '指标', exact: true }).click();
  const lib = page.getByTestId('indicator-library');
  await expect(lib).toBeVisible();
  const search = page.getByRole('searchbox', { name: '搜索指标' });
  await search.focus();
  await page.waitForTimeout(250);
  const focus = await lib.locator('.libref-search').evaluate(el => {
    const input = el.querySelector('input');
    const c = getComputedStyle(el); const i = getComputedStyle(input);
    const inner = [...el.querySelectorAll('*')].filter(n => {
      if (n === input || n.closest('kbd, button')) return false;
      const s = getComputedStyle(n);
      return parseFloat(s.borderTopWidth) > 0 || (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0);
    }).length;
    return {
      container: [{ radius: c.borderRadius, borderWidth: c.borderTopWidth, borderColor: c.borderColor, ring: c.boxShadow }],
      input: { outline: i.outlineStyle, outlineWidth: i.outlineWidth, borderWidth: i.borderTopWidth, borderRadius: i.borderRadius, background: i.backgroundColor, shadow: i.boxShadow },
      innerBordered: inner,
      height: el.getBoundingClientRect().height,
    };
  });
  assert.equal(focus.container[0].borderWidth, '1px');
  assert.equal(focus.container[0].radius, '9px');
  assert.ok(parseFloat(focus.container[0].borderColor.match(/[\d.]+/)?.[0] ?? '0') > 0.2);
  assert.equal(focus.input.outline, 'none');
  assert.equal(focus.input.borderWidth, '0px');
  assert.equal(focus.input.borderRadius, '0px');
  assert.equal(focus.innerBordered, 0);
  assert.equal(focus.height, 36);
  await page.screenshot({ path: `${out}/final-search-focus.png`, clip: { x: 170, y: 100, width: 1100, height: 90 } });
  await search.fill('solana');
  await page.waitForTimeout(250);
  const clear = await lib.locator('.libref-clear').evaluate(el => ({ display: getComputedStyle(el).display, radius: getComputedStyle(el).borderRadius, size: el.getBoundingClientRect().width }));
  assert.equal(clear.display, 'flex');
  assert.equal(clear.radius, '50%');
  assert.equal(clear.size, 22);
  await page.screenshot({ path: `${out}/final-search-filled.png`, clip: { x: 170, y: 100, width: 1100, height: 90 } });
  await page.getByRole('button', { name: '关闭指标库' }).click();
  await expect(lib).toHaveCount(0);
  pass('Search field is one rounded container with a circular clear action');

  assert.deepEqual(errors, []);
  pass('No browser errors');
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, errors }, null, 2));
  console.log(`\n${passed.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  await browser.close();
}
