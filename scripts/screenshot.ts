// 生成 README 截图：挂载真实前端 + fixture 数据，存到 docs/screenshots/
// 用法：bun run build:web && bun scripts/screenshot.ts
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataView } from '../src/shared/types.ts';
import { fixture } from '../tests/frontend-fixture.ts';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-cli/web');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/screenshots');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const data: DataView = fixture();
await page.route('http://observe.test/**', async route => {
  const url = new URL(route.request().url());
  if (!url.pathname.startsWith('/api/')) {
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    return route.fulfill(await fs.readFile(file).then(body => ({ contentType: mime[path.extname(file)] || 'application/octet-stream', body }), () => ({ status: 404, body: 'not found' })));
  }
  if (url.pathname === '/api/sessions') return route.fulfill({ json: { sessions: [{ sid: data.sessionId!, short: data.sessionId!, cards: data.cards.length, syncN: 2, children: data.children.length }] } });
  return route.fulfill({ json: data });
});

await page.goto('http://observe.test/');
await page.locator('.card').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(600);

await fs.mkdir(out, { recursive: true });
await page.screenshot({ path: path.join(out, 'map.png') });
console.log('map.png done');

// 聚焦视图：点击目标卡，只留前后链路
await page.locator('.card').first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, 'focus.png') });
console.log('focus.png done');

// 详情抽屉：回到全图，打开一张卡的详情
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.locator('.card', { hasText: 'V0' }).locator('.dtl').first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, 'detail.png') });
console.log('detail.png done');

await browser.close();
