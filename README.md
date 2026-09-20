# Agent Sessions Observer

把本机 Claude Code / Codex / Cursor 的会话记录，归纳成一张「需求解决地图」：需求解决到哪一步、谁提供了结果、还缺什么证据，一张图看完。

[![ci](https://github.com/vitoliu93/agent-sessions-observer/actions/workflows/ci.yml/badge.svg)](https://github.com/vitoliu93/agent-sessions-observer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-sessions-obs)](https://www.npmjs.com/package/agent-sessions-obs)
[![node](https://img.shields.io/node/v/agent-sessions-obs)](https://www.npmjs.com/package/agent-sessions-obs)
[![license](https://img.shields.io/npm/l/agent-sessions-obs)](./LICENSE)

<p align="center">
  <img src="docs/screenshots/map.png" alt="需求解决地图概览" width="100%">
</p>

## 为什么需要它

Agent 跑完一个大任务，过程散落在几十万行的 JSONL 日志里。想知道「这件事办到哪了」就得翻日志、猜上下文。观察台读取本地会话文件，交给本机的模型 CLI 归纳，产出一 张多目标的有向无环图：

- **五列结构**：目标 → 子目标 → 修改与问题 → 验证 → 结论与缺口；
- **署名与来源**：每张卡写明由哪个会话完成、引用来自输入的哪一行；
- **缺口独立成列**：没被证实的部分单独标出，不和「已完成」混在一起。

模型归纳是线索，不是核实。地图帮你决定去哪里查证，不替你下结论。

## 功能

- **多来源会话**：Claude Code、Codex CLI、Cursor CLI 的本地记录；自动挂载子会话（Agent/Task 派发、Herdr 派发、Codex 子线程）。
- **多目标地图**：一个会话里先后提出的多项需求各自成卡；目标之间用「接着」「推翻」连线。
- **边归纳边显示**：模型流式输出时地图实时生长，写完一张显示一张。
- **聚焦视图**：点任意一张卡，只留下它到目标和结论的整条链路。

<p align="center">
  <img src="docs/screenshots/focus.png" alt="聚焦视图" width="49%">
  <img src="docs/screenshots/detail.png" alt="卡片详情抽屉" width="49%">
</p>

- **详情抽屉**：每张卡可展开全部事实、执行步骤、直接关系与来源引用。
- **历史回放**：每次归纳保存完整快照，历史页与抽屉读同一份，可回看旧版地图。
- **本地优先**：默认只监听 `127.0.0.1:4173`，页面无外部请求，样式与图标全部打进包里。

## 快速开始

前置条件：

- Node 22+；
- 本机装有 [Codex CLI](https://github.com/openai/codex)、Claude Code 或 [pi](https://github.com/badlogic/pi-mono) 之一 —— 归纳调用它完成，消耗它的模型额度。

```sh
npx agent-sessions-obs
```

不带参数时，终端列出最近的会话（标题、目录、最后修改时间）：↑↓ 选择、输入文字筛选、回车开始观察。也可以直接给 ID：

```sh
npx agent-sessions-obs <session-id-or-prefix>          # 支持前缀
npx agent-sessions-obs codex://threads/<id>            # 直接粘贴 Codex 复制的链接
bunx agent-sessions-obs <session-id>                   # 装了 Bun 也行
```

然后浏览器打开 `http://127.0.0.1:4173`。端口被占用时用 `--port` 换一个，不会覆盖已有服务。

## 命令行参数

```sh
agent-sessions-obs <id> [<id>…] \
  --port 4174 --interval 60 --budget 400000 \
  --cli codex --model gpt-5.6-luna
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `4173` | 监听端口，仅绑定 `127.0.0.1` |
| `--interval` | `60` | 检查会话文件变化的秒数；失败后退避 5 秒至 5 分钟重试 |
| `--budget` | `400000` | 压缩后事件流的字符上限；短会话的余量让给长会话 |
| `--cli` | 自动 | 归纳用的 CLI：`codex` / `claude` / `pi`，默认取本机已装的第一个 |
| `--model` | 见下 | Codex 默认 `gpt-5.6-luna`，Claude 默认 `haiku`，`pi` 用自身配置 |

也可用环境变量 `OBS_CLI`、`OBS_MODEL`、`OBS_PROVIDER` 覆盖。

## 会话从哪里读

| 来源 | 位置 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 标题取 `custom-title`，其次 `ai-title` |
| Codex CLI | `~/.codex/sessions/`（含 `archived_sessions/`） | 子 agent 按 `parent_thread_id` 挂载；ID 前 8 位是时间戳，撞前缀时给更长前缀 |
| Cursor CLI | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | IDE 内的 SQLite 聊天库不解析 |

子会话关联：原生 Agent/Task 优先用工具结果里的 `agentId` 精确挂载；Herdr 派发按时间窗口与工作目录匹配，出现两个候选就报歧义，不瞎选。文本匹配是线索，不是身份证明；定位不了就显示未定位。临时目录（`/tmp` 等）下的会话不在列表里。

## 工作原理

1. 读取会话 JSONL，连同能明确关联的子会话；
2. 按 `--budget` 压缩事件流：各会话保留身份与头尾，剩余额度交给长会话；
3. 调用本机模型 CLI 归纳，流式输出地图 JSON，页面边写边渲染；
4. 严格校验输出：不合规的卡、边、署名、引用剔除并记入系统说明，整体不合法则整版拒绝；坏输出不覆盖上一版地图；
5. 轮询文件变化自动重新归纳；已有正式地图时，新一轮分析只在顶栏显示进度，不打断阅读。

## 隐私与安全

- 全部本地运行：会话文件只读，服务只监听回环地址，页面无外部请求；
- 归纳会把会话内容发给你指定的模型 CLI（消耗其额度）。Claude 归纳时禁用内置工具、继承的 MCP 和会话落盘；Codex 使用只读沙箱、不接受审批、不保存线程；
- 卡片状态不等于验收通过：模型的归纳受原始记录质量影响，结论仍需人工或测试确认。

## 已知限制

- 历史快照只保存在当前服务进程内，重启即丢失；
- Codex 子 agent 收到的任务正文是加密的，只能看到它的执行过程和明文回报；
- 事件流有压缩与截断，覆盖说明会列出缺失部分，地图不能替代逐条日志；
- 会话子会话匹配、卡片 ID 延续与结论质量仍受原始记录与模型能力影响。

## 开发

需要 Bun 1.2+ 和 Node 22+；浏览器测试由 Playwright 在 Node 下运行。

```sh
bun install
bun run dev:web              # 终端 1：监听 Tailwind 与前端
bun run dev:cli <session-id> # 终端 2：后端改动后自动重启
bun run typecheck            # TypeScript 严格模式检查
bun run test                 # 后端单元与 HTTP 测试
bun run build && bun run test:web   # 打包后跑前端浏览器测试
```

目录：`src/shared` 前后端数据契约；`src/cli` 会话解析、归纳与 HTTP 服务；`src/web` React 页面。发布产物只有 `dist-cli/`，单文件入口 + 静态前端，安装时不拉依赖。

浏览器测试先装一次 Chromium：`bunx playwright install --only-shell chromium`，或用 `OBS_BROWSER` 指定本机已有路径。测试全程拦截网络，不连接任何真实服务。

README 里的截图由脚本生成（构建前端后运行）：

```sh
bun run build:web && bun scripts/screenshot.ts
```

## 文档

- 设计文档：[docs/design](docs/design)
- UI 方案与产品质量约定：[docs/advanced-plans](docs/advanced-plans)

## 贡献

欢迎 Issue 和 PR。提交前请跑通 `bun run typecheck` 与 `bun run test`。

## License

[MIT](./LICENSE)
