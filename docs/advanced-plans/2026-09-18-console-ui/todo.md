# Todo: 控制台 UI 重设计

## Current State
- **Phase**: P3 — 页面回归与交付
- **Status**: in_progress
- **Branch**: advanced-plan-2026-09-18-console-ui
- **Worktree**: /Users/liujiaxi/codebase/projects/agent-sessions-observer.worktrees/advanced-plan-2026-09-18-console-ui
- **Last done**: 正式页面按样稿实现；Tailwind 与 Lucide 接通；干净构建、开发监听、29 项单元与 HTTP/终端测试、浏览器回归及 Node 产物隔离联调通过。
- **Next**: 完整复跑 40 项浏览器测试，写交付结果并提交工作分支。
- **In flight**: 无
- **Next command**: 读取本目录 goal.md、spec.md、prototype.html
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

### P3 — 页面回归与交付 [in_progress]
- [ ] 原有相关浏览器测试通过，新信息结构补测试。
- [ ] 1920/1280/900 宽度检查，键盘操作、长文本、空会话、错误、历史、草稿可达。
- [ ] 对照批准样稿检查；记录实测范围，保留工作分支，不发布。
- **Acceptance**: 无页面横向溢出，卡片与连线无遮挡，历史与实时不混读，阅读不被更新打断。
- **Verify**: `bun run test:web`、DOM 与截图 → **Result**: 未运行。
