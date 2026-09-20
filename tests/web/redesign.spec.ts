// 新布局的验收：次要内容按需显示，风险不隐藏，Tailwind 和图标实际进入产物。
import assert from 'node:assert/strict';
import { fixture } from '../frontend-fixture.ts';
import { expect, test } from './mount.ts';

for (const width of [1920, 1280, 900, 390]) test(`redesign_layout_${width}`, async ({ page, open }) => {
  await page.setViewportSize({ width, height: 1080 });
  await open();
  const dims = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth, viewport: innerWidth,
    bg: getComputedStyle(document.body).backgroundColor,
    cardBackgrounds: [...document.querySelectorAll('.card')].map(n => getComputedStyle(n).backgroundImage),
    overflow: [...document.querySelectorAll<HTMLElement>('.card')].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.id),
    mapOverflow: document.querySelector('#wrap')!.scrollWidth > document.querySelector('#wrap')!.clientWidth,
    syncIconWidth: document.querySelector('#btnResync svg')!.getBoundingClientRect().width,
  }));
  assert.equal(dims.page, dims.viewport);
  assert.equal(dims.bg, 'rgb(246, 247, 247)');
  assert(dims.cardBackgrounds.every(x => x === 'none'));
  assert.deepEqual(dims.overflow, []);
  assert.equal(dims.syncIconWidth, 14);
  if (width < 1100) assert(dims.mapOverflow);
});

test('secondary_information_is_available_on_demand', async ({ page, open }) => {
  await open();
  await expect(page.locator('#reset')).toBeHidden();
  await expect(page.locator('#pcPanel')).toBeHidden();
  assert.equal(await page.locator('#histBtn').count(), 0);   // 不留历史版本
  assert.equal(await page.locator('#sigchips').count(), 0);
  assert.equal(await page.locator('#stData').count(), 0);
  assert.equal(await page.locator('#lvKnown').count(), 0);
  await page.getByRole('button', { name: '进展详情' }).click();
  await expect(page.locator('#lvKnown')).toHaveText(fixture().live.known!);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '查看同步详情' }).click();
  await expect(page.locator('#dHead')).toHaveText('同步详情');
  await expect(page.locator('#stData')).toHaveText('10:01:00');
  assert.match((await page.locator('#dBody').textContent())!, /可重复测试夹具，不是生产事实/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查看同步详情' })).toBeFocused();
});


test('coverage_warning_is_not_hidden_in_details', async ({ page, open }) => {
  const d = fixture();
  for (const snapshot of [d]) {
    snapshot.coverage = { truncated: true, missing: ['agent-lost'], sessions: [], note: '输入已截断，缺少 agent-lost 的记录。' };
    snapshot.children[0].matched = 'no-file';
  }
  await open(d);
  await expect(page.locator('#notebar')).toBeVisible();
  await expect(page.locator('#notebar')).toContainText('输入已截断');
  await expect(page.locator('#notebar')).toContainText('不代表完整覆盖');
});

test('menus_close_with_escape_and_return_focus', async ({ page, open }) => {
  await open();
  for (const [button, panel] of [['#swBtn', '#swMenu']]) {
    await page.locator(button).click();
    await expect(page.locator(button)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(button)).toBeFocused();
  }
});

test('header_stays_on_top_while_page_scrolls', async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await open();
  await page.evaluate(() => scrollTo(0, 500));
  await expect.poll(async () => Math.round((await page.locator('header').boundingBox())!.y)).toBe(0);
  await expect(page.locator('#btnResync')).toBeInViewport();
});


test('map_remeasures_columns_after_window_resize', async ({ page, open }) => {
  await open();
  const initial = await page.locator('#c-GOAL').evaluate(n => n.getBoundingClientRect().width);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => page.locator('#c-GOAL').evaluate(n => n.getBoundingClientRect().width)).toBeLessThan(initial);
  const dims = await page.evaluate(() => ({
    wrap: document.querySelector('#wrap')!.clientWidth,
    goal: document.querySelector('#c-GOAL')!.getBoundingClientRect().width,
    last: document.querySelector('.card.concl')!.getBoundingClientRect().right,
  }));
  assert(Math.abs(dims.goal - (dims.wrap - 16 - 4 * 36) / 5) < 1);
  assert(dims.last < 1280);
});
