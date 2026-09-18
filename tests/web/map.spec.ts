// 地图：布局、折叠、连线、参与者高亮、多目标、聚焦链路
import assert from 'node:assert/strict';
import path from 'node:path';
import { chain } from '../../src/web/lib.ts';
import { fixture } from '../frontend-fixture.ts';
import { expect, OUT, shownIds, test } from './mount.ts';

test('overview_42_16_52', async ({ page, open }) => {
  const d = fixture(); assert.equal(d.cards.length, 42); assert.equal(d.edges.length, 52); await open(d);
  const m = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth, v: innerWidth, h: document.documentElement.scrollHeight,
    goal: document.querySelector<HTMLElement>('#c-GOAL')!.getBoundingClientRect().toJSON(),
    bad: [...document.querySelectorAll('.card')].filter(x => x.scrollHeight > x.clientHeight + 1 || x.scrollWidth > x.clientWidth + 1).map(x => x.id),
    conclusions: document.querySelectorAll('.card.concl').length,
  }));
  assert.equal(m.w, m.v); assert(m.h <= 1080, JSON.stringify(m)); assert(m.goal.x < 100); assert.equal(m.bad.length, 0); assert(m.conclusions > 0);
  assert.equal(await page.locator('#pcN').textContent(), '16');
  await page.screenshot({ path: path.join(OUT, 'overview.png'), fullPage: true });
});

test('no_node_or_fold_overlap', async ({ page, open }) => {
  await open();
  const hits = await page.evaluate(() => {
    const a = [...document.querySelectorAll('.card,.foldentry')].map(x => ({ id: x.id, r: x.getBoundingClientRect() })), out: string[][] = [];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const x = a[i].r, y = a[j].r;
      if (x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top) out.push([a[i].id, a[j].id]);
    }
    return out;
  });
  assert.deepEqual(hits, []);
});

test('fold_expand_collapse_keyboard', async ({ page, open }) => {
  await open();
  const before = await page.locator('.card').count();
  await page.locator('#fold-2').focus(); await page.keyboard.press('Enter');
  assert(await page.locator('.card').count() > before);
  await page.locator('[data-col="2"]').click();
  assert.equal(await page.locator('.card').count(), before);
});

test('edges_do_not_cross_cards', async ({ page, open }) => {
  await open();
  const hits = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.card,.foldentry')].map(c => ({ id: c.id, r: c.getBoundingClientRect() }));
    const svg = document.querySelector<HTMLElement>('#edges')!.getBoundingClientRect(), hits: string[] = [];
    for (const e of document.querySelectorAll<SVGPathElement>('#edges path[data-edge]')) {
      const n = e.getTotalLength();
      for (let k = 6; k < n - 6; k += 5) {
        const p = e.getPointAtLength(k), x = p.x + svg.x, y = p.y + svg.y;
        const hit = boxes.find(b => x > b.r.left + 2 && x < b.r.right - 2 && y > b.r.top + 2 && y < b.r.bottom - 2);
        if (hit) { hits.push(hit.id); break; }
      }
    }
    return hits;
  });
  assert.deepEqual(hits, []);
});

test('no_script_error', async ({ page, open }) => {
  const state = await open();
  await expect(page.locator('#reset')).toBeHidden();
  await page.locator('#branch').selectOption('S1');
  await page.locator('#reset').click();
  await page.locator('#branch').selectOption('S2');
  await page.locator('#c-S2 .dtl').click();
  await page.keyboard.press('Escape');
  assert.deepEqual(state.errors, []);
});

test('agent_with_folded_contribution_has_visible_highlight', async ({ page, open }) => {
  await open();
  await page.locator('#pcAll').click(); await page.locator('#pcSearch').fill('agent-15'); await page.locator('.pcrow').click();
  assert(await page.locator('.foldentry.hl').count() > 0);
});

test('agent_highlights_only_signed_cards', async ({ page, open }) => {
  await open();
  await page.locator('#pcAll').click(); await page.locator('#pcSearch').fill('agent-1'); await page.locator('.pcrow[data-k="agent-1"]').click();
  const agents = await page.locator('.card.hl .sig1 b').allTextContents();
  assert(agents.length > 0); assert.deepEqual([...new Set(agents)], ['agent-1']);
});

test('hovered_card_highlights_direct_relations_only', async ({ page, open }) => {
  await open(); const d = fixture();
  await page.locator('#c-S1').hover();
  const hl = await page.locator('.card.hl').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.id!));
  const direct = new Set(['S1', ...d.edges.filter(e => e.f === 'S1' || e.t === 'S1').flatMap(e => [e.f, e.t])]);
  assert(hl.length > 1); assert(hl.every(id => direct.has(id)), hl.join());
});

test('visible_and_folded_cover_all_once', async ({ page, open }) => {
  await open();
  const r = await page.evaluate(() => ({
    shown: document.querySelectorAll('.card').length,
    folded: [...document.querySelectorAll('.foldentry .t1')].reduce((a, n) => a + parseInt(n.textContent!.match(/\d+/)![0], 10), 0),
  }));
  assert.equal(r.shown + r.folded, 43);
});

test('multiple_goals_dag', async ({ page, open }) => {
  const d = fixture(); const extra = (id: string, title: string) => ({ ...d.goals[0], id, title, st: 'doing' as const, acc: [] });
  for (const x of [d, ...d.history]) {
    x.goals.push(extra('GOAL2', '接着做：结果缓存'), extra('GOAL3', '推倒重来：换识别模型'));
    x.edges.push({ f: 'GOAL', t: 'GOAL2', v: '接着' }, { f: 'GOAL3', t: 'GOAL', v: '推翻' });
  }
  const state = await open(d);
  for (const id of ['GOAL', 'GOAL2', 'GOAL3']) assert((await page.locator('#c-' + id).boundingBox())!.x < 100, id);
  await page.locator('#c-GOAL2').hover(); assert((await page.locator('#edges text.hl').allTextContents()).includes('接着'));
  await page.locator('#branch').selectOption('GOAL'); assert.equal(await page.locator('#c-GOAL2').count(), 0); assert.equal(await page.locator('#c-S1').count(), 1);
  await page.locator('#branch').selectOption('S1'); assert.equal(await page.locator('#c-GOAL').count(), 1); assert.equal(await page.locator('#c-S2').count(), 0);
  assert.deepEqual(state.errors, []);
});

test('focus_chain_then_back_to_full_map', async ({ page, open }) => {
  const d = fixture(); const all = [...d.goals, ...d.cards]; const state = await open(d);
  const ids = () => shownIds(page);
  const before = await ids(), folds = await page.locator('.foldentry').count(); assert(folds > 0);
  const rid = (await page.locator('.card.risk').first().getAttribute('data-id'))!, n = rid.slice(1);
  const expected = [...chain(all, d.edges, rid)].sort();
  assert.deepEqual(expected, ['C' + n, 'G' + n, 'GOAL', 'K' + n, rid, 'S' + (+n % 2 + 1), 'V' + n].sort());
  await page.locator('#c-' + rid).click(); assert(await page.locator('.card.out').count() > 0, '链路外的卡先淡出');
  // 淡出一开始链路集合就对了，折叠入口要等 180 ms 后的重排才消失：两个都等
  await expect.poll(ids).toEqual(expected); await expect(page.locator('.foldentry')).toHaveCount(0);
  assert.match((await page.locator('#scope').textContent())!, /聚焦.*7 张卡/);
  assert.match(await page.locator('#c-' + rid).evaluate(n => getComputedStyle(n).transition), /top/);
  const tops = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.card')].map(n => n.offsetTop)); assert(tops.every(y => y < 1080));
  await page.locator('#c-K' + n).click(); await expect.poll(ids).toEqual([...chain(all, d.edges, 'K' + n)].sort());
  await page.mouse.move(5, 5); await page.keyboard.press('Escape');
  await expect.poll(ids).toEqual(before); await expect(page.locator('.foldentry')).toHaveCount(folds);
  assert.doesNotMatch((await page.locator('#scope').textContent())!, /聚焦/); assert.deepEqual(state.errors, []);
});

test('owned_cards_without_edges_stay_in_focus', async ({ page, open }) => {
  const d = fixture();
  const like = (id: string, type: string, goalId: string, title: string) => ({ ...d.cards.find(c => c.type === type)!, id, goalId, title });
  for (const x of [d, ...d.history]) {
    x.cards.push(like('S3', 'subgoal', 'S3', '收尾'), like('V10', 'verify', 'S3', '核对合并'), like('K10', 'concl', 'S3', '已收尾'));
    x.edges.push({ f: 'GOAL', t: 'S3', v: '拆成' }, { f: 'V10', t: 'K10', v: '支持' });
  }
  const state = await open(d); await page.locator('#branch').selectOption('S3');
  assert.equal(await page.locator('#edges path.implied').count(), 1, '只给 V10 补一条虚线，K10 顺着 V10 找得到');
  await page.locator('#c-V10 .dtl').click();
  await expect.poll(() => shownIds(page)).toEqual(['GOAL', 'K10', 'S3', 'V10']);
  assert((await page.locator('#dBody .relrow').allTextContents()).some(t => t.startsWith('← 包含'))); assert.deepEqual(state.errors, []);
});

test('card_click_closes_open_menus', async ({ page, open }) => {
  await open();
  await page.locator('#swBtn').click(); assert.equal(await page.locator('#swMenu.open').count(), 1);
  await page.locator('#c-GOAL').click(); assert.equal(await page.locator('#swMenu.open').count(), 0);
  await page.locator('#pcAll').click(); await page.locator('#c-S1').click();
  assert.equal(await page.locator('#pcPanel.open').count(), 0); assert.equal(await page.locator('#c-S1.sel').count(), 1);
});
