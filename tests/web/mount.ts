// open fixture：静态文件从 dist-cli/web 读，/api/* 按 state 应答；用例改 state 就能模拟下一次轮询拿到的数据
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataView, SessionItem } from '../../src/shared/types.ts';
import { fixture } from '../frontend-fixture.ts';

export const OUT = process.env.OBS_TEST_OUT || '/tmp/observe-acceptance/frontend';
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-cli/web');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

export interface State {
  data: DataView | null; sessions: Partial<SessionItem>[];
  /** 页面脚本错误 */
  errors: string[];
  /** /api/data 被拉了几次：等下一次轮询用它，不睡固定时长 */
  polls: number;
  delay?: number; error?: string | null;
}

export const test = base.extend<{ open: (data?: DataView | null, init?: Partial<State>) => Promise<State> }>({
  open: async ({ page }, use) => {
    await use(async (data = fixture(), init = {}) => {
      const state: State = { errors: [], polls: 0, sessions: [], ...init, data };
      state.sessions = data ? [{ sid: data.sessionId!, short: data.sessionId!, cards: data.cards.length, syncN: data.syncN, children: data.children.length }] : [];
      page.on('pageerror', e => state.errors.push(e.message));
      await page.route('http://observe.test/**', async route => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) {
          const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
          return route.fulfill(await fs.readFile(file).then(body => ({ contentType: mime[path.extname(file)] || 'application/octet-stream', body }), () => ({ status: 404, body: 'not found' })));
        }
        if (state.delay) await new Promise(r => setTimeout(r, state.delay));
        if (url.pathname === '/api/sessions') return route.fulfill({ json: { sessions: state.sessions } });
        if (state.error) return route.fulfill({ status: 503, json: { error: state.error } });
        state.polls++;
        return route.fulfill({ json: state.data });
      });
      await page.goto('http://observe.test/');
      if (data?.syncN) await page.locator('.card').first().waitFor({ timeout: 10000 });
      return state;
    });
  },
});

/** 当前没淡出的卡片 ID，排好序；聚焦用例用 expect.poll 等它变成期望值 */
export const shownIds = (page: Page) => page.locator('.card:not(.out)').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.id!).sort());

export { expect, type Page };
