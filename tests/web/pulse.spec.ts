// 快判：此刻状态条、证据弱标记、抽屉里的支持度；没有快判数据时都不出现
import assert from 'node:assert/strict';
import { fixture } from '../frontend-fixture.ts';
import { OUT, test } from './mount.ts';

test('pulse_bar_and_weak_evidence', async ({ page, open }) => {
  const d = fixture();
  d.pulse = { at: '2026-09-16T10:01:05Z', phase: 'waiting_user', confidence: 0.97, stuck: 0.04, changed: 0.12, ms: 340, skipped: 3, woke: false };
  // 列里的卡会折叠，给全部修改卡打分：验证卡没分数，不该出现标记
  for (const c of d.cards) if (c.type === 'change') c.support = 0.2;
  const state = await open(d);
  assert.equal(await page.locator('#pulsePhase').textContent(), '在等你回复');
  assert((await page.locator('#pulse').textContent())!.includes('已省 3 次归纳'));
  assert(await page.locator('.card.change .weak').count() > 0);
  assert.equal(await page.locator('.card.verify .weak').count(), 0);
  await page.locator('.card.change .dtl').first().click();
  assert((await page.locator('#support').textContent())!.includes('20%'));
  await page.screenshot({ path: `${OUT}/pulse.png` });
  assert.deepEqual(state.errors, []);
});

test('no_pulse_no_bar', async ({ page, open }) => {
  await open();
  assert.equal(await page.locator('#pulse').count(), 0);
  assert.equal(await page.locator('.weak').count(), 0);
});

test('review_updates_without_map_version_or_pulse_and_keeps_reading', async ({ page, open }) => {
  const d=fixture();d.engine='jev';d.pulse=null;d.review={on:true,running:false,at:null,unreviewed:5,error:null};
  const state=await open(d);
  const {expect}=await import('./mount.ts');
  await expect(page.locator('#reviewStat')).toHaveText('底稿，等慢模型审');
  await page.locator('#c-GOAL .dtl').click();
  const node=await page.evaluateHandle(()=>document.querySelector('#c-GOAL'));
  state.data=structuredClone(d);state.data.review.running=true;
  await expect(page.locator('#reviewStat')).toHaveText('慢模型审图中…',{timeout:8000});
  state.data.review.running=false;state.data.review.error='审图超时';
  await expect(page.locator('#reviewStat')).toHaveText('上次审图失败，保留已有结果',{timeout:8000});
  assert.equal(await page.locator('#reviewStat').getAttribute('title'),'审图超时');
  state.data.review.error=null;state.data.review.at='2026-09-20T01:00:00Z';state.data.review.unreviewed=0;
  await expect(page.locator('#reviewStat')).toHaveText('慢模型已审',{timeout:8000});
  assert(await page.evaluate(n=>n===document.querySelector('#c-GOAL'),node));
  assert.equal(await page.locator('#dHead h3').textContent(),d.goals[0].title);
  assert.deepEqual(state.errors,[]);
});
