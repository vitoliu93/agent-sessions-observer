# Todo: 控制台 UI 重设计

## Current State
- **Phase**: P4 — 发布 0.6.0
- **Status**: in_progress
- **Branch**: advanced-plan-2026-09-18-console-ui
- **Worktree**: /Users/liujiaxi/codebase/projects/agent-sessions-observer.worktrees/advanced-plan-2026-09-18-console-ui
- **Last done**: 实现提交 e32ff12；类型检查、干净构建、29 项单元/HTTP/终端测试、40 项浏览器测试和 Node 24.18.0 隔离联调全部通过。
- **Next**: 检查发布包，合并并推送 main；远端 CI 通过后推送 v0.6.0 标签。
- **In flight**: 版本与发布包检查。
- **Next command**: bun install --frozen-lockfile && bun run typecheck && bun run build；npm pack --dry-run --json。
- **Blockers**: 无。

## Phases

### P1 — 检查与样稿 [done]
- [x] 检查源代码、业务规则与当前页面。
- [x] 定义风格、信息取舍、实现边界。
- [x] 完成可点击离线样稿，检查桌面与窄屏、详情、筛选、历史、状态。
- [x] 用户确认样稿。
- **Acceptance**: 有明确设计规则和可交互页面；示例有来源，不冒充当前会话。
- **Verify**: Playwright 浏览器操作、DOM 几何、脚本错误、截图目检 → **Result**: 通过。证据 /tmp/console-ui-prototype-evidence/checks.json；1920/1280/900/390 无页面横向溢出，0 脚本错误，0 网络请求。1280 宽度选中卡右侧 828px，抽屉左侧 840px；键盘焦点返回通过。

### P2 — 依赖与正式页面 [done]
- [x] 引入 Tailwind CSS 与 Lucide，生产与开发构建接通。
- [x] 页面按批准样稿调整，保留原有业务交互。
- [x] 更新构建说明，明确替代旧样式约定。
- **Acceptance**: 无外部 CDN，干净构建可用，图标具名导入，重复样式减少。
- **Verify**: `bun run typecheck && bun run test && bun run build`，开发监听验证 → **Result**: 通过。删除生成 CSS 后完整构建成功；新增 w-[137px] 后 Tailwind 与 Bun 均重建；SIGTERM 后两个子进程退出。单元与 HTTP/终端测试 29/29。

### P3 — 页面回归与交付 [done]
- [x] 原有相关浏览器测试通过，新信息结构补测试。
- [x] 1920/1280/900 宽度检查，键盘操作、长文本、空会话、错误、历史、草稿可达。
- [x] 对照批准样稿检查；记录实测范围，保留工作分支，不发布。
- **Acceptance**: 无页面横向溢出，卡片与连线无遮挡，历史与实时不混读，阅读不被更新打断。
- **Verify**: `bun run test:web`、DOM 与截图 → **Result**: 40/40 通过。截图目检及 Node 产物真实 HTTP 隔离联调通过；没有真实模型或线上数据验收。详见 result.md。

### P4 — 发布 0.6.0 [in_progress]
- [ ] 版本号与包内容检查，合并并推送 main。
- [ ] main 对应提交的远端 CI 通过。
- [ ] v0.6.0 标签触发发布并成功。
- [ ] 从 npm 下载 0.6.0，检查命令入口和页面资源。
- **Acceptance**: npm latest 为 0.6.0；远端检查和发布成功；下载的包可运行，包含正式页面。
- **Verify**: GitHub Actions、npm registry、隔离安装检查。
