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
  await expect(page.locator('#hist')).toBeHidden();
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

test('sync_details_use_the_reading_snapshot', async ({ page, open }) => {
  const d = fixture();
  d.history[0].stamps = [{ at: 1, data: 'OLD_DATA_TIME', summary: 'OLD_SUMMARY_TIME' }];
  await open(d);
  await page.locator('#histBtn').click();
  await page.locator('#hslider').fill('1');
  await page.getByRole('button', { name: '查看同步详情' }).click();
  await expect(page.locator('#stData')).toHaveText('OLD_DATA_TIME');
  await expect(page.locator('#stSum')).toHaveText('OLD_SUMMARY_TIME');
  await expect(page.locator('#stat')).toHaveText('历史快照 · #1');
});

test('coverage_warning_is_not_hidden_in_details', async ({ page, open }) => {
  const d = fixture();
  for (const snapshot of [d, ...d.history]) {
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
  for (const [button, panel] of [['#swBtn', '#swMenu'], ['#pcAll', '#pcPanel']]) {
    await page.locator(button).click();
    await expect(page.locator(button)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(button)).toBeFocused();
  }
});

test('participant_filter_wins_over_hover_after_menu_closes', async ({ page, open }) => {
  await open();
  await page.locator('#pcAll').click();
  await page.locator('#pcSearch').fill('agent-1');
  await page.locator('[data-k="agent-1"]').click();
  await page.locator('#c-GOAL').hover();
  const names = await page.locator('.card.hl .sig1 b').allTextContents();
  assert(names.length > 0); assert.deepEqual([...new Set(names)], ['agent-1']);
});

test('history_controls_remain_clickable_beside_details', async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  await page.locator('#c-GOAL .dtl').click();
  await page.locator('#histBtn').click();
  await page.locator('#hslider').fill('1');
  await expect(page.locator('#dHead h3')).toHaveText('旧目标正文');
  await page.locator('#hback').click();
  await expect(page.locator('#dHead h3')).toHaveText(fixture().goals[0].title);
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
