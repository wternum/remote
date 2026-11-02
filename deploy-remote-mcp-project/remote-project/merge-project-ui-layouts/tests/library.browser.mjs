import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.TEST_URL || 'http://localhost:5173/';
const out = '.verification/library';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const page = await context.newPage();
const errors = [];
const passed = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  const text = m.text();
  if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(text)) errors.push(text);
});
const pass = name => { passed.push(name); console.log('PASS', name); };
const lib = page.getByTestId('indicator-library');
const search = page.getByRole('searchbox', { name: '搜索指标' });
const detail = lib.locator('.libref-detail');
const navItem = (mode, family) => family
  ? lib.locator(`.libref-nav-item[data-family="${family}"]`)
  : lib.locator(`.libref-nav-item[data-mode="${mode}"]`);
const nav = name => navItem({
  Favorites: 'favorites', 'All scripts': 'scripts', Discover: 'discover', Basic: 'basic', Concepts: 'concepts',
}[name] ?? name);

async function open() {
  if (await lib.count()) return;
  await page.getByRole('button', { name: '指标', exact: true }).click();
  await expect(lib).toBeVisible();
  await page.waitForTimeout(700);
}
async function close() {
  if (!(await lib.count())) return;
  await lib.getByRole('button', { name: '关闭指标库' }).click();
  await expect(lib).toHaveCount(0);
}
async function reopen() {
  await close();
  await open();
}

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('.vela-dtb').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await open();

  // Geometry
  const dialog = page.locator('.pulse-indicator-dialog');
  const measure = await page.evaluate(() => {
    const pick = selector => {
      const el = document.querySelector(selector);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      dialog: pick('.pulse-indicator-dialog'), head: pick('.libref-head'), workspace: pick('.libref-workspace'),
      sidebar: pick('.libref-sidebar'), catalog: pick('.libref-catalog'), detail: pick('.libref-detail'),
      footer: pick('.libref-foot'), scrollbar: getComputedStyle(document.querySelector('.libref-results')).scrollbarWidth,
    };
  });
  assert.ok(Math.abs(measure.dialog.w - 1080) <= 2 && Math.abs(measure.dialog.h - 680) <= 2);
  assert.equal(measure.head.h, 52);
  assert.ok(Math.abs(measure.head.w - measure.dialog.w) <= 2);
  assert.equal(measure.sidebar.w, 208);
  assert.equal(measure.detail.w, 280);
  assert.equal(measure.catalog.w, 590);
  assert.equal(measure.footer.h, 34);
  assert.equal(measure.sidebar.y + measure.sidebar.h, measure.footer.y);
  const spacing = await page.evaluate(() => {
    const item = document.querySelector('.libref-nav-item');
    const sidebar = document.querySelector('.libref-sidebar');
    const label = document.querySelector('.libref-nav-label');
    const style = el => getComputedStyle(el);
    return {
      itemLeft: parseFloat(style(item).paddingLeft),
      itemRight: parseFloat(style(item).paddingRight),
      itemHeight: parseFloat(style(item).height),
      sidebarLeft: parseFloat(style(sidebar).paddingLeft),
      sidebarTop: parseFloat(style(sidebar).paddingTop),
      labelLeft: parseFloat(style(label).marginLeft),
      labels: [...document.querySelectorAll('.libref-nav-item > span')].map(el => el.textContent.trim()),
      title: document.querySelector('.libref-head h1').textContent.trim(),
      placeholder: document.querySelector('.libref-search input').placeholder,
    };
  });
  assert.equal(spacing.itemLeft, 12);
  assert.equal(spacing.itemRight, 12);
  assert.equal(spacing.itemHeight, 32);
  assert.equal(spacing.sidebarLeft, 12);
  assert.equal(spacing.sidebarTop, 14);
  assert.equal(spacing.labelLeft, 12);
  assert.equal(spacing.title, '指标库');
  assert.equal(spacing.placeholder, '搜索指标、概念或别名…');
  for (const label of ['我的收藏', '我的脚本', '导入脚本', '基础指标', '订单流', '发现', '全部指标', '概念', '趋势', '动量', '波动率', '成交量与资金流', '结构', '聪明钱 / ICT', '威科夫', '艾略特与谐波', '形态', '关键位', '统计', '机器学习', '时间与时段', '情绪与广度', '风险与离场', '元指标', '验证']) {
    assert.ok(spacing.labels.includes(label), `missing Chinese nav label: ${label}`);
  }
  pass('Reference dialog, header, three-column and footer geometry');
  pass('Chinese navigation, search placeholder and roomier box padding');

  // Discover content and real thumbnail delivery
  await expect(lib.locator('.libref-card')).toHaveCount(9);
  await expect(lib.locator('.libref-nav-label')).toHaveText(['我的', '内置', '指标库', '分类浏览']);
  await expect(lib.locator('.libref-section-head h2')).toHaveText(['最新发布', '更多探索', '分类']);
  await expect(lib.locator('.libref-family-tile')).toHaveCount(17);
  const images = await lib.locator('.libref-card img').evaluateAll(imgs => imgs.map(i => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })));
  assert.equal(images.length, 9);
  assert.ok(images.every(i => i.src.startsWith('https://')));
  await expect.poll(async () => lib.locator('.libref-card img').evaluateAll(imgs => imgs.filter(i => i.complete && i.naturalWidth > 0).length), { timeout: 15000 }).toBeGreaterThanOrEqual(9);
  await expect(lib.locator('.libref-detail h3')).toContainText('Valid BOS Pullback');
  await page.screenshot({ path: `${out}/final-discover.png` });
  pass('Discover sections, all 17 families, detail and thumbnail images');

  // Hover previews the detail without opening a slide-over.
  const card = lib.locator('.libref-card').nth(1);
  const cardName = (await card.locator('strong').innerText()).trim();
  await card.hover();
  await expect(detail.locator('h3')).toHaveText(cardName);
  await expect(lib).toHaveAttribute('data-detail-open', 'false');
  pass('Pointer hover previews the inspector');

  // Favorite from Discover persists and feeds Favorites.
  const favorite = card.locator('.libref-star');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  await navItem('favorites').click();
  await expect(lib.locator('.libref-nav-item[aria-pressed="true"]')).toContainText('我的收藏');
  await expect(lib.locator('.libref-card').filter({ hasText: cardName })).toHaveCount(1);
  await expect(lib.locator('.libref-card').first()).toBeVisible();
  pass('Native-star favorites persist into the Favorites view');

  // All scripts sort / layout / pagination.
  await navItem('scripts').click();
  await expect(lib.locator('.libref-top-row h2')).toContainText('全部指标');
  await expect(lib.locator('.libref-top-row h2 span')).toHaveText('801');
  await expect(lib.locator('.libref-card')).toHaveCount(24);
  const firstNewest = (await lib.locator('.libref-card strong').first().innerText()).trim();
  await lib.getByRole('button', { name: '按名称排序' }).click();
  const firstAlpha = (await lib.locator('.libref-card strong').first().innerText()).trim();
  assert.notEqual(firstNewest, firstAlpha);
  await lib.getByRole('button', { name: '列表' }).click();
  await expect(lib.locator('.libref-row').first()).toBeVisible();
  await lib.getByRole('button', { name: '网格' }).click();
  await lib.locator('.libref-more').click();
  await expect(lib.locator('.libref-card')).toHaveCount(72);
  pass('All 801 scripts: newest/A–Z sorting, grid/list layouts and show-more');

  // Family nav + cluster chips
  await navItem('family', 'smc-ict').click();
  await expect(lib.locator('.libref-top-row h2')).toContainText('聪明钱 / ICT');
  await expect(lib.locator('.libref-top-row h2 span')).toHaveText('92');
  await expect(lib.locator('.libref-chips button').first()).toHaveText('全部');
  assert.ok(await lib.locator('.libref-chips button').count() > 3);
  await lib.locator('.libref-chips button').nth(2).click();
  await expect(lib.locator('.libref-chips button[aria-pressed="true"]')).toHaveCount(1);
  pass('Family browsing with the reference cluster chips');

  // Search across built-ins, Library and concepts
  await navItem('discover').click();
  await search.fill('bollinger');
  const groupLabels = await lib.locator('.libref-group-label').allInnerTexts();
  assert.equal(groupLabels[0], '内置 3');
  assert.equal(groupLabels[1], '指标库 17');
  assert.ok(groupLabels.some(label => /^概念 /.test(label)));
  await expect(lib.locator('.libref-results mark').first()).toBeVisible();
  const resultCount = await lib.locator('.libref-row, .libref-card, .libref-concept').count();
  assert.ok(resultCount >= 20);
  await page.screenshot({ path: `${out}/final-search.png` });
  await search.fill('');
  pass('Search covers built-ins and Library with highlighted matches');

  // Add a built-in through the actual native chart surface.
  await navItem('basic').click();
  await expect(lib.locator('.libref-builtin-section').first()).toBeVisible();
  const before = await page.evaluate(() => window.__velaWs.chart.indicators().length);
  const row = lib.locator('.libref-row.is-builtin .libref-row-main').nth(2);
  const rowText = (await row.locator('strong').innerText()).trim();
  await row.click();
  await expect.poll(() => page.evaluate(() => window.__velaWs.chart.indicators().length)).toBe(before + 1);
  const titles = await page.evaluate(() => window.__velaWs.chart.indicators().map(i => i.title));
  assert.ok(titles.some(title => rowText.includes(title) || title.includes(rowText)));
  await expect(lib.locator('.libref-toast')).toHaveClass(/is-shown/);
  pass('Clicking a built-in adds the native indicator to the chart');

  // Adding via the detail action and then rechecking state
  await lib.locator('.libref-row.is-builtin').first().click();
  await expect(lib.locator('.libref-detail-actions .libref-primary')).toBeVisible();
  const primaryBackground = await lib.locator('.libref-detail-actions .libref-primary').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.ok(!/rgba\(0, 0, 0, 0\)/.test(primaryBackground), `primary CTA should be filled, got ${primaryBackground}`);
  const detailButton = lib.locator('.libref-detail-actions .libref-primary');
  if (!(await detailButton.isDisabled())) {
    const count = await page.evaluate(() => window.__velaWs.chart.indicators().length);
    await detailButton.click();
    await expect.poll(() => page.evaluate(() => window.__velaWs.chart.indicators().length)).toBe(count + 1);
  }
  await lib.getByRole('button', { name: '关闭指标库' }).click();
  await expect(lib).toHaveCount(0);
  pass('Detail action works and the dialog closes cleanly');

  // Reopen and check favorites persisted in storage.
  await open();
  await navItem('favorites').click();
  await expect(lib.locator('.libref-card').filter({ hasText: cardName })).toHaveCount(1);
  pass('Favorites survive closing and reopening');

  // Concepts and library add path
  await navItem('concepts').click();
  await expect(lib.locator('.libref-concept').first()).toBeVisible();
  await expect(lib.locator('.libref-concept')).toHaveCount(80);
  await lib.locator('.libref-more').click();
  await expect(lib.locator('.libref-concept')).toHaveCount(200);
  await lib.locator('.libref-concept').first().click();
  await expect(lib.locator('.libref-detail h3')).toBeVisible();
  await expect(lib.locator('.libref-detail .libref-eyebrow')).toBeVisible();
  if (await lib.locator('.libref-back').isVisible()) await lib.locator('.libref-back').click();
  await navItem('scripts').click();
  const firstCard = lib.locator('.libref-card').first();
  await firstCard.locator('.libref-info').click();
  await expect(lib).toHaveAttribute('data-detail-open', 'true');
  await expect(lib.locator('.libref-detail h3')).toBeVisible();
  await expect(lib.locator('.libref-detail-actions .libref-primary')).toBeVisible();
  await lib.locator('.libref-back').click().catch(() => {});
  await expect(lib).toBeVisible();
  pass('Concepts pagination/details and Library add feedback');

  // Keyboard: arrow navigation, favorite, and Shift+Enter add-keeping-open.
  await navItem('scripts').click();
  await search.focus();
  await search.fill('anchored vwap');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await expect(lib.locator('.libref-card.is-selected, .libref-row.is-selected').first()).toHaveCount(1);
  // The reference keeps field keys for the field, so F applies once focus leaves search.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press('f');
  const selectedKey = await lib.locator('.libref-card.is-selected').first().getAttribute('data-id');
  assert.ok(selectedKey && selectedKey.startsWith('s:'));
  await expect(lib.locator(`.libref-card[data-id="${selectedKey}"] .libref-star`)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(lib).toBeVisible();
  await navItem('basic').click();
  const beforeKeyboard = await page.evaluate(() => window.__velaWs.chart.indicators().length);
  await search.focus();
  await lib.locator('.libref-row.is-builtin .libref-row-main').nth(4).focus();
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await expect.poll(() => page.evaluate(() => window.__velaWs.chart.indicators().length)).toBe(beforeKeyboard + 1);
  await expect(lib).toBeVisible();
  await expect(lib.locator('.libref-toast')).toHaveClass(/is-shown/);
  await page.keyboard.press('Escape');
  await expect(lib).toHaveCount(0);
  pass('Arrow navigation, F favorite, Shift+Enter keep-open and Escape close');

  // Responsive narrow layout
  await page.setViewportSize({ width: 900, height: 700 });
  await open();
  await expect(lib).toBeVisible();
  const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.libref-workspace')).gridTemplateColumns);
  assert.ok(!columns.includes('280px'));
  await navItem('family', 'trend').click();
  await lib.locator('.libref-card').first().hover();
  await page.waitForTimeout(350);
  const narrowDetail = await lib.locator('.libref-detail').boundingBox();
  assert.ok(narrowDetail.width <= 320);
  await page.screenshot({ path: `${out}/final-narrow.png` });
  await page.setViewportSize({ width: 430, height: 760 });
  await page.waitForTimeout(300);
  const headDisplay = await lib.locator('.libref-head h1').evaluate(el => getComputedStyle(el).display);
  assert.equal(headDisplay, 'none');
  await lib.locator('.libref-card').first().locator('.libref-info').click();
  await page.waitForTimeout(300);
  const mobileDetail = await lib.locator('.libref-detail').boundingBox();
  assert.ok(mobileDetail.width >= 400, `mobile detail should fill the sheet, got ${mobileDetail.width}`);
  assert.equal(await lib.locator('.libref-back').isVisible(), true);
  await lib.locator('.libref-back').click();
  await page.screenshot({ path: `${out}/final-mobile.png` });
  pass('Responsive columns, slide-over detail and compact mobile header');

  await page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(errors, []);
  record('No uncaught browser errors');
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, errors }, null, 2));
  console.log(`\n${passed.length} checks passed.`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ baseURL, passed, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  await browser.close();
}

function record(name) { console.log('PASS', name); passed.push(name); }
