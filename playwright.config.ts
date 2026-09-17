// 前端浏览器测试：页面取 dist-cli/web 构建产物（先 bun run build:web），接口全部拦截，不连接用户服务
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/web', timeout: 20000, fullyParallel: true, reporter: [['list']],
  outputDir: process.env.OBS_TEST_OUT || '/tmp/observe-acceptance/frontend',
  use: {
    headless: true, viewport: { width: 1920, height: 1080 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    // OBS_BROWSER：用本机已有的 Chromium，不下载 Playwright 自带的那份
    launchOptions: process.env.OBS_BROWSER ? { executablePath: process.env.OBS_BROWSER } : {},
  },
});
