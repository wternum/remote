import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5173/';
await mkdir('.verification', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const errors = [];
const warnings = [];
const responses = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('response', response => {
  if (response.status() >= 400) responses.push({ url: response.url(), status: response.status() });
});

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('.vela-dtb').first().waitFor({ timeout: 45000 });
  await expect.poll(() => page.evaluate(async () => {
    try {
      const response = await fetch(new URL('/api/health', location.href));
      const body = await response.json();
      return response.status === 200 && body.ok === true;
    } catch {
      return false;
    }
  }), { timeout: 45000, message: 'The local PostgreSQL API should become healthy' }).toBe(true);
  await page.waitForTimeout(3500);
  const state = await page.evaluate(() => ({
    title: document.title,
    workspace: Boolean(window.__velaWs),
    market: window.__velaWs?.chart.market.symbol,
    timeframe: window.__velaWs?.chart.market.timeframe,
    canvases: document.querySelectorAll('canvas').length,
  }));
  assert.equal(state.workspace, true);
  assert.equal(state.market, 'okx:BTC-USDT-SWAP');
  assert.ok(state.canvases > 0);
  await page.screenshot({ path: '.verification/home-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: '.verification/home-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await writeFile('.verification/runtime-smoke.json', JSON.stringify({
    baseURL, state, database: 'healthy', desktop: 'passed', mobile: 'passed', errors, warnings, responses,
  }, null, 2));
  console.log('PASS Desktop chart, mobile layout, local PostgreSQL API, and browser errors');
} catch (error) {
  await page.screenshot({ path: '.verification/runtime-failure.png' }).catch(() => {});
  await writeFile('.verification/runtime-smoke.json', JSON.stringify({
    baseURL, failure: error.message, errors, warnings, responses,
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}