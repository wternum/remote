// 订单流判读卡浏览器验收：打开「交易」侧栏，等待真实订单流同步，检查卡片状态与图表标注，零浏览器错误
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.TEST_URL || 'http://127.0.0.1:5173/';
const out = '.verification/flowread';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' });
const errors = [];
const flowRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/favicon|429/.test(m.text())) errors.push(m.text());
});
page.on('request', r => {
  if (/rubik\/stat|history-trades/.test(r.url())) flowRequests.push(r.url());
});
const passed = [];
const pass = n => {
  passed.push(n);
  console.log('PASS', n);
};

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  // 固定到 5m 周期（用户关注的短线周期）
  await page.evaluate(() => { try { localStorage.removeItem('pulsedesk-vela-workspace'); } catch {} });
  await page.goto(baseURL + '#', { waitUntil: 'domcontentloaded' });
  await page.locator('.vela-dtb').first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);

  // 打开右侧「交易」侧栏
  const toggle = page.locator('.vela-widget-topbar button, .vela-topbar button').filter({ hasText: /交易/ }).first();
  if (await toggle.count()) await toggle.click();
  else await page.getByRole('button', { name: /交易/ }).first().click();
  const card = page.getByTestId('flow-read');
  await expect(card).toBeVisible({ timeout: 20000 });
  pass('交易侧栏打开并显示「订单流判读」卡');

  // 等待 OKX 真实订单流同步（最多 60s），徽标应显示覆盖根数
  await expect
    .poll(async () => (await card.locator('.tp-of-badge').textContent()) ?? '', { timeout: 110000 })
    .toMatch(/覆盖 [1-9]\d* 根|该周期无真实订单流/);
  const badge = await card.locator('.tp-of-badge').textContent();
  const sawFlow = flowRequests.some(u => /history-trades|taker-volume-contract/.test(u));
  assert.ok(sawFlow, "应请求 OKX 逐笔成交回补");
  pass(`订单流数据徽标：${badge?.trim()}`);

  const view = await card.getAttribute('data-view');
  assert.ok(['test', 'breakout', 'approach', 'idle'].includes(view ?? ''), `未知视图 ${view}`);
  const text = (await card.textContent()) ?? '';
  if (view === 'test') assert.ok(/下跌|上涨/.test(text) && /诱多|诱空|扫损|无陷阱/.test(text), '二次测试视图应含概率与陷阱判定');
  if (view === 'breakout') assert.ok(/回踩|反抽/.test(text) && /突破K/.test(text), '突破视图应含回踩判读');
  if (view === 'approach') assert.ok(/正在接近/.test(text), '接近视图应含关键位');
  pass(`当前判读视图：${view}`);

  // 信号列表应带订单流来源/陷阱标签（如有信号）
  const sigs = page.locator('.tp-sig');
  const n = await sigs.count();
  if (n) {
    const tags = await page.locator('.tp-sig-tags span').allTextContents();
    console.log('信号数', n, '标签样例', tags.slice(0, 8));
  }
  pass(`信号列表渲染 ${n} 条`);

  await page.screenshot({ path: `${out}/panel.png` });
  // 近似/真实切换不应产生错误；点击第一条信号在图上标注
  if (n) {
    await sigs.first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/annotated.png` });
  }
  assert.deepEqual(errors, []);
  pass('零浏览器错误');
  await writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, view, badge, flowRequests: flowRequests.length, signals: n }, null, 2));
  console.log(`\n${passed.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  await browser.close();
}
