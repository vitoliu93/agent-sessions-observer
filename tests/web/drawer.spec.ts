// 详情抽屉：键盘打开关闭、关系跳转、参与者面板、抽屉不遮住定位到的卡
import assert from 'node:assert/strict';
import { fixture } from '../frontend-fixture.ts';
import { expect, test } from './mount.ts';

test('detail_enter_escape_quotes', async ({ page, open }) => {
  await open();
  const b = page.locator('.card.change .dtl').first(); await b.focus(); await page.keyboard.press('Enter');
  await page.locator('#drawer.open').waitFor();
  assert((await page.locator('#dBody').textContent())!.includes('"118s"'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawer.open').count(), 0);
  assert((await page.evaluate(() => document.activeElement!.id)).startsWith('c-'));
});

test('all_agents_and_live_keyboard', async ({ page, open }) => {
  await open();
  await page.locator('#pcAll').click(); assert.equal(await page.locator('.pcrow').count(), 16);
  await page.locator('#pcSearch').fill('agent-15'); await page.locator('.pcrow').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#pcPanel.open').count(), 0);
  await page.locator('.lcell').first().focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#dHead h3').textContent(), '当前进展全文');
});

test('relationship_jumps_to_target_in_focus', async ({ page, open }) => {
  await open(); const target = 'C14';
  assert.equal(await page.locator('#c-' + target).count(), 0);
  await page.locator('#c-S1 .dtl').click(); await page.locator(`[data-target="${target}"]`).click();
  assert.equal(await page.locator('#c-' + target).count(), 1);
  assert((await page.locator('#dHead h3').textContent())!.includes(target));
});

test('narrow_view_and_long_detail_remain_readable', async ({ page, open }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const d = fixture(); d.history[1].cards[2].facts = ['LONG_' + 'x'.repeat(3000)]; await open(d);
  await page.locator('.card.change .dtl').first().click();
  const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, v: innerWidth, body: document.querySelector<HTMLElement>('#dBody')!.scrollWidth, drawer: document.querySelector<HTMLElement>('#dBody')!.clientWidth }));
  assert.equal(dims.w, dims.v); assert.equal(dims.body, dims.drawer);
});

for (const w of [1920, 1280]) test('located_card_not_under_drawer_' + w, async ({ page, open }) => {
  await page.setViewportSize({ width: w, height: 900 }); await open();
  const w0 = await page.locator('#c-GOAL').evaluate(n => (n as HTMLElement).offsetWidth);
  const v = page.locator('.card.verify').first(); await v.locator('.dtl').click(); await page.locator('#drawer.open').waitFor();
  assert.equal(await page.locator('#c-GOAL').evaluate(n => (n as HTMLElement).offsetWidth), w0, '打开抽屉不重排');
  const targets = await page.locator('#dBody [data-target]').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.target!)); assert(targets.some(t => t.startsWith('K')));
  const vid = await v.getAttribute('data-id');
  const seen = (id: string) => page.evaluate(id => {
    const n = document.getElementById('c-' + id)!, r = n.getBoundingClientRect();
    return [[r.left + 4, r.top + 4], [r.right - 4, r.bottom - 4]].every(([x, y]) => n.contains(document.elementFromPoint(x, y)));
  }, id);
  for (const t of targets) {
    if (!await page.locator(`#dBody [data-target="${t}"]`).count()) { await page.keyboard.press('Escape'); await page.locator(`#c-${vid} .dtl`).click(); }
    await page.locator(`#dBody [data-target="${t}"]`).first().click();
    await expect.poll(() => seen(t), { message: t + ' covered at ' + w }).toBe(true);   // 等地图滚开抽屉，不睡固定时长
  }
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#wrap').evaluate(n => n.scrollLeft), 0);
});

test('keyboard_focus_after_fold_and_live_drawer', async ({ page, open }) => {
  await open();
  await page.locator('#fold-2').focus(); await page.keyboard.press('Enter');
  assert((await page.evaluate(() => document.activeElement!.id)).startsWith('c-'));
  const cell = page.locator('.lcell').first(); await cell.focus(); await page.keyboard.press('Enter');
  await page.locator('#drawer.open').waitFor(); await page.keyboard.press('Escape');
  assert(await cell.evaluate(n => n === document.activeElement));
});
