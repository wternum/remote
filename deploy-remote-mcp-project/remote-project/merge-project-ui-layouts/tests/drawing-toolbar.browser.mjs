import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.TEST_URL || 'http://localhost:5173/';
const artifacts = '.verification';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ignoreDefaultArgs: ['--hide-scrollbars'],
  args: ['--no-sandbox', '--disable-gpu', '--disable-webgl'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors = [];
const passed = [];
page.on('pageerror', error => errors.push(error.message));
const rail = page.locator('.vela-dtb').first();
const menu = page.locator('.vela-dtb-flyout.quant-drawing-menu:not([data-closing])');
const cell = label => rail.locator('.vela-dtb-cell').filter({ has: page.locator(`.vela-dtb-icon[aria-label="${label}"]`) });
const search = () => menu.locator('input[type="search"]');
const record = name => { passed.push(name); console.log(`PASS ${name}`); };
const tool = () => page.evaluate(() => window.__velaWs.chart.drawings.getTool());

async function close() {
  if (await menu.count()) {
    await search().focus();
    await search().fill('');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  await page.mouse.move(700, 20);
  await page.waitForTimeout(250);
}

async function open(label, hover = false) {
  await close();
  const group = cell(label);
  await expect(group).toHaveCount(1);
  if (hover) await group.locator('.vela-dtb-icon').hover();
  else await group.locator('.vela-dtb-arrow').click();
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('.quant-drawing-menu-search')).toBeVisible();
  await page.waitForTimeout(380);
}

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(rail).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1200);
  assert.equal((await rail.boundingBox()).width, 52);
  assert.equal(await rail.evaluate(el => getComputedStyle(el).scrollbarWidth), 'thin');
  for (const label of ['线条', '斐波那契', '形态', '测量', '形状', '文字', '图标']) {
    assert.equal((await cell(label).boundingBox()).height, 38);
  }
  const sizing = await cell('文字').evaluate(el => {
    const hit = el.querySelector('.vela-dtb-hit');
    const glyph = hit.firstElementChild;
    return {
      hit: [hit.clientWidth, hit.clientHeight],
      glyph: [glyph.clientWidth, glyph.clientHeight],
      radius: getComputedStyle(hit).borderRadius,
    };
  });
  assert.deepEqual(sizing, { hit: [32, 32], glyph: [20, 20], radius: '8px' });
  record('Reference rail width, row spacing, icon size and corner radius');

  await cell('文字').locator('.vela-dtb-icon').click();
  assert.equal(await tool(), 'text');
  await open('文字');
  const box = await menu.boundingBox();
  const railBox = await rail.boundingBox();
  assert.ok(Math.abs(box.x - (railBox.x + railBox.width - 1)) < 0.1);
  assert.ok(Math.abs(box.y - (await cell('文字').boundingBox()).y) < 0.1);
  assert.ok(Math.abs(box.width - 171) < 1);
  assert.ok(Math.abs(box.height - 363.546875) < 1);
  await expect(menu.locator('.quant-drawing-section-count')).toHaveText('7');
  await expect(menu.locator('.vela-dtb-item')).toHaveCount(7);
  const edge = await menu.locator('.quant-drawing-menu-edge').getAttribute('d');
  assert.ok(edge.startsWith('M 0.5 0 Q 0.5 16.5 16.5 16.5'));
  assert.ok(!edge.endsWith('Z'));
  await page.screenshot({ path: `${artifacts}/toolbar-desktop.png` });
  record('Text menu attaches flush to rail with reference-sized curved outline');

  const selected = menu.locator('.vela-dtb-item[data-selected="1"]');
  await selected.hover();
  const star = selected.locator('.vela-dtb-star');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(menu).toHaveCount(1);
  assert.equal(await tool(), 'text');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  record('Native favorites toggle without arming a different tool or closing menu');

  await search().fill('价格');
  await expect(menu.locator('.vela-dtb-item:visible')).toHaveCount(2);
  await expect(menu.locator('.quant-drawing-section-count')).toHaveText('2');
  await expect(menu.locator('.quant-drawing-menu-footer')).toHaveText('2 个工具');
  assert.ok(Math.abs((await menu.boundingBox()).width - box.width) < 0.1);
  await search().fill('no-such-drawing-tool');
  await expect(menu.locator('.vela-dtb-item:visible')).toHaveCount(0);
  await expect(menu.locator('.quant-drawing-menu-footer')).toHaveText('没有匹配的工具');
  await page.keyboard.press('Escape');
  await expect(search()).toHaveValue('');
  await expect(menu.locator('.vela-dtb-item:visible')).toHaveCount(7);
  record('Search, section counts, empty state and stable menu width');

  await search().fill('标注');
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('.vela-dtb-item[aria-label="标注"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  assert.equal(await tool(), 'callout');
  record('Keyboard selection reaches and arms the real drawing tool');

  await open('线条', true);
  const hoverBox = await menu.boundingBox();
  await page.mouse.move(hoverBox.x + 20, hoverBox.y + 20, { steps: 4 });
  await page.waitForTimeout(400);
  await expect(menu).toHaveCount(1);
  await page.mouse.move(750, 30);
  await expect(menu).toHaveCount(0, { timeout: 3000 });
  record('Hover opens groups and safely crosses to menu, leaving dismisses');

  await open('线条');
  await page.mouse.move(750, 30);
  await page.waitForTimeout(500);
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('.vela-dtb-hint kbd').first()).toBeVisible();
  await search().focus();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(cell('线条').locator('.vela-dtb-arrow')).toBeFocused();
  record('Click-open menus remain pinned; Escape restores trigger focus');

  for (const label of ['斐波那契', '形态', '测量', '形状', '图标', '磁吸', '文字']) {
    await open(label);
    await expect(menu.locator('.quant-drawing-menu-outline')).toHaveCount(1);
    await expect(menu.locator('.quant-drawing-menu-search')).toHaveCount(1);
    assert.ok(await menu.locator('.vela-dtb-item').count());
  }
  record('All groups open with one shell; repeated opens do not duplicate rows');

  await close();
  await page.setViewportSize({ width: 1100, height: 620 });
  await page.waitForTimeout(250);
  await open('文字');
  await search().focus();
  const scroller = menu.locator('.quant-drawing-menu-scroll');
  assert.ok(await scroller.evaluate(el => el.scrollHeight > el.clientHeight));
  const footerY = (await menu.locator('.quant-drawing-menu-footer').boundingBox()).y;
  await scroller.evaluate(el => { el.scrollTop = 120; });
  await page.waitForTimeout(200);
  assert.equal((await menu.locator('.quant-drawing-menu-footer').boundingBox()).y, footerY);
  const visibleRow = menu.locator('.vela-dtb-item[aria-label="价格标签"]');
  await visibleRow.hover();
  await page.waitForTimeout(250);
  const highlight = await visibleRow.evaluate(row => {
    const list = row.closest('.quant-drawing-menu-scroll');
    const r = row.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    return {
      actual: parseFloat(list.style.getPropertyValue('--quant-hover-y')),
      expected: r.top - b.top - list.clientTop + list.scrollTop,
      width: parseFloat(list.style.getPropertyValue('--quant-hover-width')),
      rowWidth: r.width,
    };
  });
  assert.ok(Math.abs(highlight.actual - highlight.expected) < .1);
  assert.ok(Math.abs(highlight.width - highlight.rowWidth) < .1);
  const compactBox = await menu.boundingBox();
  assert.ok(compactBox.y + compactBox.height <= 620);
  await page.screenshot({ path: `${artifacts}/toolbar-compact.png` });
  record('Short viewport scrolls only menu body; footer and hover remain aligned');

  await close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await rail.locator('.vela-dtb-collapse').click();
  await expect(rail).toHaveAttribute('data-collapsed', '1');
  await expect.poll(async () => (await rail.boundingBox()).width).toBe(16);
  await rail.locator('.vela-dtb-collapse').click();
  await expect(rail).not.toHaveAttribute('data-collapsed', '1');
  await expect.poll(async () => (await rail.boundingBox()).width).toBe(52);
  record('Collapse and restore retain native toolbar behavior');

  await open('线条');
  await menu.locator('.vela-dtb-item[aria-label="趋势线"]').click();
  await expect(menu).toHaveCount(0);
  assert.equal(await tool(), 'trendline');
  const drawingsBefore = await page.evaluate(() => window.__velaWs.chart.drawings.all().length);
  await page.mouse.click(430, 245);
  await page.mouse.move(640, 310, { steps: 6 });
  await page.mouse.click(640, 310);
  await expect.poll(() => page.evaluate(() => window.__velaWs.chart.drawings.all().length)).toBe(drawingsBefore + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__velaWs.chart.drawings.all().length)).toBe(drawingsBefore);
  record('Real canvas placement creates a trend line and native undo removes it');

  await rail.locator('.vela-dtb-btn[aria-label="测量"]').click();
  assert.equal(await page.evaluate(() => window.__velaWs.chart.drawings.getMode()), 'measure');
  await rail.locator('.vela-dtb-btn[aria-label^="橡皮擦"]').click();
  assert.equal(await page.evaluate(() => window.__velaWs.chart.drawings.getMode()), 'eraser');
  await rail.locator('.vela-dtb-btn[aria-label="光标"]').click();
  assert.equal(await page.evaluate(() => window.__velaWs.chart.drawings.getMode()), null);
  assert.equal(await tool(), null);
  record('Measure, eraser and cursor controls still operate native drawing modes');

  await page.getByRole('button', { name: '指标', exact: true }).click();
  const library = page.getByTestId('indicator-library');
  await expect(library).toBeVisible();
  await expect(library.locator('.libref-card').first()).toBeVisible();
  await library.locator('.libref-close').click();
  await expect(library).toHaveCount(0);
  record('Indicator library continues to open and close unchanged');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open('文字');
  assert.equal(await menu.evaluate(el => getComputedStyle(el).animationName), 'none');
  await close();
  assert.deepEqual(errors, []);
  record('Reduced-motion preference and browser error checks');

  const scaled = await browser.newContext({
    viewport: { width: 1280, height: 600 }, deviceScaleFactor: 1.25, locale: 'zh-CN',
  });
  const scaledPage = await scaled.newPage();
  scaledPage.on('pageerror', error => errors.push(error.message));
  await scaledPage.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const scaledRail = scaledPage.locator('.vela-dtb').first();
  await expect(scaledRail).toBeVisible();
  const scaledText = scaledRail.locator('.vela-dtb-cell').filter({ has: scaledPage.locator('.vela-dtb-icon[aria-label="文字"]') });
  await scaledText.locator('.vela-dtb-icon').click();
  await scaledText.locator('.vela-dtb-arrow').click();
  const scaledMenu = scaledPage.locator('.quant-drawing-menu:not([data-closing])');
  await expect(scaledMenu).toBeVisible();
  await scaledPage.waitForTimeout(700);
  assert.equal((await scaledRail.boundingBox()).width, 52);
  assert.equal(await scaledRail.evaluate(el => getComputedStyle(el).scrollbarWidth), 'thin');
  const scaledBody = scaledMenu.locator('.quant-drawing-menu-scroll');
  assert.ok(await scaledBody.evaluate(el => el.scrollHeight > el.clientHeight));
  const croppedTop = (await scaledRail.boundingBox()).y;
  await scaledPage.screenshot({
    path: `${artifacts}/toolbar-125-percent.png`,
    clip: { x: 0, y: croppedTop, width: 292.8, height: 600 - croppedTop },
  });
  await scaled.close();
  assert.deepEqual(errors, []);
  record('125 percent display scaling keeps the rail and scrolling text menu aligned');

  await fs.writeFile(`${artifacts}/toolbar-test-results.json`, JSON.stringify({ url: baseURL, passed, errors }, null, 2));
  console.log(`\n${passed.length} browser checks passed.`);
} catch (error) {
  await page.screenshot({ path: `${artifacts}/toolbar-test-failure.png` }).catch(() => {});
  await fs.writeFile(`${artifacts}/toolbar-test-results.json`, JSON.stringify({ url: baseURL, passed, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  await browser.close();
}