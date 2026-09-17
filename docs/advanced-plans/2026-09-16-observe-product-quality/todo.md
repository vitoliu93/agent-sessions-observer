# 当前工作

## Current State

- Status: 第二轮验收问题 N1–N6 已修；新增 Codex 会话与会话标题；待第三轮独立验收。
- 接手：Codex 会话 01a0a985 中断后由 Claude 接手；工作树改动未提交。
- 回归：后端 17/17，前端隔离浏览器 25/25；index.html 729 行，脚本无超 140 字符行。
- 真实会话 9161063c（4174 端口候选服务，默认预算）：30 卡、24 边、20/30 证据可定位、0 条署名被移除、丢弃 4 条连线；17/19 子会话定位到文件（2 个 no-file）。1920×1080 无横向滚动、无交叠、卡内无溢出、轮询保焦；12 次关系定位无一被抽屉遮挡，无脚本错误。
- 4173：接手时已无服务监听（首次检查即为空），本轮未启动或停止它。
- Base: 658ecff；main 干净；仓库没有 remote，无法拉远端；独立 worktree 已创建。
- 工作区：`/Users/liujiaxi/codebase/icc/kox-base/.worktrees/advanced-plan-2026-09-16-observe-product-quality`。
- 没有 issue 编号，暂不 commit/push。用户现有服务只读。
- 审核基线和代码建议已复制到仓内 docs/refs/astra-review。
- 后端只读审核：独立 explorer `/root/backend_audit`；主模型负责浏览器验收与前端。

## Phase 1：独立验收与缺陷清单

**Acceptance**: 旧 B1–B6 逐条验收，建立可复现产品缺陷清单，区分真实数据、浏览器实测和构造边界。
**Verify**: 原代码函数反例、实际 /api/data 只读快照、Playwright 隔离页面 1920×1080 的 DOM 取证与截图。
Result: 完成。acceptance-initial.md / findings.md；原版目标卡重叠、仅1条边、5秒失焦。基线截图与DOM在 /tmp/observe-acceptance/。

## Phase 2：数据与同步真实性

**Acceptance**: 快照完整；失败可重试；输出校验、队列去重、错误会话不串图；子代理有效贡献保留。
**Verify**: node:test 隔离 JSONL、假模型、HTTP 服务红绿测试。
Result: 完成。真实数据补出 Q17–Q19（见 findings），均有红绿测试。

## Phase 3：地图与交互

**Acceptance**: 大会话概览清楚；边方向和折叠关系可读；键盘可达；无变化轮询保焦；所有等待和错误可恢复。
**Verify**: 42 卡 / 16 人 / 52 边的确定样例；浏览器交互与几何断言；真实会话快照复验。
Result: 完成。前端 17 项浏览器测试通过；真实会话几何取证见 Current State。

## Phase 4：整体复验与交付

**Acceptance**: 独立复跑，源码行数不膨胀；证据不夸大；列出剩余边界，提供可运行结果。
**Verify**: 后端测试 + 前端浏览器测试 + 原始数据流程 + 截图目检 + 独立审核；逐条对照 goal/spec。
Result: 待做。
