// 轮询与快照：阅读中不替换、历史回放、草稿渐进、错误恢复
import assert from 'node:assert/strict';
import type { DataView } from '../../src/shared/types.ts';
import { fixture } from '../frontend-fixture.ts';
import { expect, test } from './mount.ts';

test('poll_keeps_dom_and_focus', async ({ page, open }) => {
  const state = await open();
  await page.locator('#c-GOAL').focus();
  const original = await page.evaluateHandle(() => document.querySelector('#c-GOAL'));
  // 改一个只影响顶栏的字段，看到它出现就说明下一次轮询已经重绘；地图数据 key 没变，不能重建卡片
  state.sessions[0].title = 'POLLED';
  await expect(page.locator('#swLabel')).toHaveText('POLLED', { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.activeElement!.id), 'c-GOAL');
  assert(await page.evaluate(n => n === document.querySelector('#c-GOAL'), original));
});

test('history_text_and_drawer', async ({ page, open }) => {
  await open();
  await page.locator('#c-GOAL .dtl').click(); await page.locator('#histBtn').click(); await page.locator('#hslider').fill('1');
  assert.equal(await page.locator('#c-GOAL h4').textContent(), '旧目标正文');
  assert.equal(await page.locator('#dHead h3').textContent(), '旧目标正文');
  await page.keyboard.press('Escape');
  await page.locator('.lcell').click();
  assert.equal(await page.locator('#lvKnown').textContent(), '旧结果');
  await page.keyboard.press('Escape');
  await page.locator('#hback').click();
  assert.equal(await page.locator('#c-GOAL h4').textContent(), '字体识别提速，判定结果不变');
});

test('pending_updates_do_not_replace_reading', async ({ page, open }) => {
  const state = await open(); await page.locator('#c-GOAL .dtl').click();
  state.data = structuredClone(state.data!); state.data.syncN = 3; state.data.updatedAt = 'new';
  const snap = structuredClone(state.data.history[1]); snap.at = 3; snap.goals[0].title = '最新目标'; state.data.history.push(snap);
  await expect(page.locator('#pending')).toBeVisible({ timeout: 8000 });   // 下一次轮询拿到新版，只提示不替换
  assert.equal(await page.locator('#dHead h3').textContent(), '字体识别提速，判定结果不变');
  await page.locator('#pending').click();
  assert.equal(await page.locator('#dHead h3').textContent(), '最新目标');
});

test('empty_is_recoverable', async ({ page, open }) => {
  await open(null);
  await page.locator('#boot').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#swBtn').isEnabled(), true);
  assert((await page.locator('#boot').textContent())!.includes('尚未观察'));
  assert.equal(await page.locator('#swBtn').isVisible(), true);
});

test('first_error_can_retry', async ({ page, open }) => {
  const d = fixture(); d.syncN = 0;
  const state = await open(d, { error: '临时读取失败' });
  await page.locator('#boot').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#swBtn').isEnabled(), true); assert.equal(await page.locator('#btnResync').isEnabled(), true);
  state.error = null; state.data = fixture();
  await page.locator('#btnResync').click(); await page.locator('#c-GOAL').waitFor();
  assert.deepEqual(state.errors, []);
});

test('poll_preserves_session_menu_focus', async ({ page, open }) => {
  const state = await open();
  await page.locator('#swBtn').click(); await page.locator('[data-sid]').focus();
  // 会话列表在下一次轮询被重绘（卡数变了），焦点仍在原来那一行
  state.sessions[0].cards = 99;
  await expect(page.locator('.swrow .meta')).toHaveText('99 卡', { timeout: 8000 });
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.sid), 'fixture-a');
});

test('history_without_selected_branch_resets_to_overview', async ({ page, open }) => {
  const d = fixture(); d.history[0].cards = d.history[0].cards.filter(c => c.id !== 'S2'); await open(d);
  await page.locator('#branch').selectOption('S2');
  await page.locator('#histBtn').click(); await page.locator('#hslider').fill('1');
  assert.equal(await page.locator('#branch').inputValue(), ''); assert(await page.locator('.card').count() > 1);
});

test('draft_renders_progressively', async ({ page, open }) => {
  const full = fixture();
  // C0 的标题先只写了 3 个字，下一次轮询写完：标题在同一个 DOM 节点里变长
  const head = full.cards[2].title.slice(0, 3);
  const d: DataView = { ...full, syncN: 0, analyzing: true, history: [], goals: [], cards: [], edges: [], draft: { goals: full.goals, cards: [...full.cards.slice(0, 2), { ...full.cards[2], title: head }], edges: full.edges.slice(0, 2), live: { now: '草稿进行中' }, chars: 900, startedAt: 'x' } };
  const state = await open(d); await page.locator('#c-C0').waitFor();
  assert.equal(await page.locator('#boot').isVisible(), false);
  assert.match((await page.locator('#stat').textContent())!, /已出 4 张卡/); assert.match((await page.locator('#notebar').textContent())!, /生成中/);
  assert.equal(await page.locator('#c-C0 h4').textContent(), head);
  const node = await page.evaluateHandle(() => document.querySelector('#c-C0'));
  const next = structuredClone(d); next.draft!.cards = full.cards.slice(0, 6); next.draft!.chars = 2000; state.data = next;
  await expect(page.locator('#c-C0 h4')).toHaveText(full.cards[2].title, { timeout: 2500 });
  assert(await page.evaluate(n => n === document.querySelector('#c-C0'), node), '标题变长时卡片不重建');
  await page.locator('#c-C0 .dtl').click();
  assert.equal(await page.locator('#dBody .kv b', { hasText: '关系' }).first().textContent(), '关系生成中');
  state.data = full; await page.locator('#stat', { hasText: '最新 · #2' }).waitFor({ timeout: 2500 });
  assert.equal(await page.locator('#pending').isVisible(), false);
  assert.match((await page.locator('#dBody .kv b', { hasText: '关系' }).first().textContent())!, /^关系 [1-9]/);
  assert.doesNotMatch((await page.locator('#notebar').textContent())!, /生成中/); assert.deepEqual(state.errors, []);
});

test('history_delta_merges_with_held_history', async ({ page, open }) => {
  const state = await open();
  const next = structuredClone(state.data!); const snap = structuredClone(next.history[1]);
  snap.at = 3; next.syncN = 3; next.updatedAt = 'n3'; next.historySince = 2; next.history = [snap]; state.data = next;
  await expect(page.locator('#stat')).toHaveText(/#3/, { timeout: 8000 });   // 下一次轮询采纳 #3
  await page.locator('#histBtn').click();
  assert.equal(await page.locator('#hslider').getAttribute('max'), '3');
  await page.locator('#hslider').fill('1');
  assert.equal(await page.locator('#c-GOAL h4').textContent(), '旧目标正文');
});
