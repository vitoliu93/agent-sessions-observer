# Agent Session 观察台

## 大前提

地图要回答：需求解决到哪一步、谁提供了结果、还缺什么证据。派发、等待、挂哨兵不作为业务卡。一个会话里用户会先后提出多项需求，地图是多目标的有向无环图。

## 小前提

输入 Claude Code / Codex session ID。读取本机 JSONL 和能明确关联的子会话，由本机模型 CLI 归纳成地图。后端是 TypeScript 写的 Node CLI，前端是 React 单页，打包后随 npm 包一起发布；发布产物是打包好的单文件，用户安装时不下载依赖。

## 结论

保留目标、解决路径、验证、缺口。先看概览，点卡看全文；模型归纳不是独立核实。

### 运行

```sh
npx agent-sessions-obs                       # 列出最近会话，在终端里选一个
npx agent-sessions-obs <session-id-or-prefix> --port 4174
npx agent-sessions-obs codex://threads/<id>  # 也可以直接粘贴 Codex 复制的链接
bunx agent-sessions-obs <session-id>         # 装了 Bun 也可以这样跑
```

不给 ID 时，终端里列出最近的 Claude Code 与 Codex 主会话（标题、目录、最后修改时间），不列临时目录（`/tmp`、`/private/tmp` 等）下的会话：↑↓ 选择，输入文字筛选，回车开始观察，Esc 退出。不在终端里运行（管道、脚本）时照旧空启动，在页面添加。页面添加框同样接受 ID、前缀和 `codex://threads/<id>` 链接。

Node 22+。默认监听本机 `127.0.0.1:4173`。已有服务时换端口，不要覆盖或停止它。

```sh
agent-sessions-obs <id> [<id>…] \
  --port 4174 --interval 60 --budget 400000 \
  --cli codex --model gpt-5.6-luna
```

- `--interval`：检查输入文件变化的秒数，不是强制重新调用模型。失败后退避 5 秒至 5 分钟，在下一次检查时重试；手动同步可以立即重试。
- `--budget`：压缩事件流的字符上限，不是 token 上限。各会话保留身份和头尾；短会话剩余额度交给长会话。前一版地图和指令另占输入。
- `--cli`：分析用的模型 CLI，支持 `codex`、`claude`、`pi`。不指定时按这个顺序用本机已安装的第一个；指定的命令找不到、或三个都没装时，启动即报错退出。模型调用会使用该 CLI 的额度；测试不会调用真实模型。
- 默认模型为 Codex `gpt-5.6-luna`、Claude `haiku`；`pi` 使用自身配置。可通过参数或 `OBS_CLI`、`OBS_MODEL`、`OBS_PROVIDER` 覆盖。
- Claude 归纳禁用内置工具、继承的 MCP 和会话落盘；Codex 使用只读沙箱、不接受审批请求、不保存线程。
- 模型边输出边解析：终端每 15 秒打印一次进度（已收到字数、已出卡片数）；第一版地图生成中，页面每秒刷新，写完的目标、卡片和边先显示出来。已有正式地图时，新一轮分析只在顶栏显示进度，不用草稿替换正式地图。

### 地图与阅读

- 五列：目标｜子目标｜修改和问题｜验证｜结论和缺口。目标固定第一列。
- 用户每提一项新需求建一张目标卡。目标之间两种边：「接着」由旧目标指向在其基础上继续的新目标；「推翻」由新目标指向被推倒重来的旧目标。无关的新任务不连边。用户的新需求不记成缺口。
- 概览每列最多三张，保留修改和结论入口；其余显示折叠记录数、待解决风险/缺口数、失败记录数。
- 标题与摘要最多两行，正文不在卡内堆叠。详情包含全部事实、来源、署名、步骤和直接关系。
- 选择子目标只看相关路径；归属不明的卡单独可查，不用相似标题猜关系。
- 连线有箭头。默认只强调主线与未解决问题；悬停显示直接关系。折叠入口上的边代表组内记录，完整关系在抽屉。
- 点一张卡（或打开详情）进入聚焦：只留下它前面（往目标方向）和后面（往结论方向）的整条链路，链路上的卡全部展开。链路外的卡先淡出，留下的卡滑到新位置，连线随后淡入。点空白处、按 Esc 或「重置视图」回到完整地图。
- 模型漏写子目标到卡片的边、但卡上写了归属（goalId）时，补一条虚线「包含」，地图、聚焦和详情都能看到。只认 ID，不按标题猜；草稿生成中不补。
- 参与者显示摘要和可搜索名单；选择参与者时，折叠入口也会提示其贡献。
- 同版轮询不重建地图。阅读详情、选中卡片或回放历史时，新摘要先提示“点击更新”，不打断阅读。
- Enter 打开详情，Esc 关闭；live、折叠入口、参与者、关系均支持键盘。

### 历史与失败

每次成功归纳保存完整内存快照：标题、正文、署名、边、live、覆盖范围与来源时间。历史页面和抽屉读取同一快照，不把新正文套在旧状态上。

坏模型输出不会替换上一版地图，也不会消费输入变化。首次分析、手动同步和自动同步统一排队，同一观察者不会重复入队。未知会话返回 404；不回退到其它会话。

**历史只在当前服务进程内保存，重启即丢失。** 旧版没有完整快照时禁用回放，不补造历史。

### 身份与来源边界

- 原生 Agent/Task：优先使用工具结果中的 `agentId` 定位 `session/subagents/agent-*.jsonl`；子会话的 sidechain 事件保留。
- Herdr：使用首条需求开头、派发时间窗口、记录中的工作目录匹配 Claude 或 Cursor 转写；两个候选即报告歧义。同角色不同会话不合并成一个身份。
- **文本匹配是关联线索，不是身份的绝对证明。** 缺少记录、复杂 shell、过晚启动、改写首条提示等情况可能无法匹配，显示未定位，不随便选一个。
- Cursor CLI 支持 `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`；IDE 的 SQLite 聊天库不解析。
- Codex：会话在 `~/.codex/sessions`（含 `archived_sessions`）。子 agent 按首行 `parent_thread_id` 精确挂载，key 取 `agent_path`（如 `backend_fix`）；审批用 guardian 线程不计入。子 agent 收到的任务正文加密，只能看到它的执行过程和明文回报。Codex id 前 8 位是时间戳，前缀只匹配用户开的主线程，撞前缀时请给更长的前缀。
- 标题：Claude Code 取 `custom-title`，其次 `ai-title`；Codex 取 `~/.codex/session_index.jsonl` 的 `thread_name`。
- 署名必须使用输入会话 key；来源引用必须出现在输入片段中。引用存在不代表内容已被独立证实。
- 事件会压缩、截断；覆盖说明列出缺失与截断。地图不是完整逐条日志替代品。
- 子会话匹配、卡片 ID 延续和结论质量仍受原始记录及模型影响。不能用卡片“已完成”替代人工或测试验收。

### 输出约定

业务类型：`goal/subgoal/change/risk/verify/concl/gap`，另有修复过程容器 `group`。目标放在 `goals` 数组，可以有多个；兼容模型输出旧格式的单个 `goal`。

状态：`doing/done/failed/partial/risk/resolved/unknown`。目标未声明有效状态时为 unknown。

卡片含 `id/title/sub/st/facts/ev/sig/steps`；`goalId` 指向子目标 ID。旧 `zone` 仅按唯一精确标题兼容，不作相似匹配。

边仅允许：拆成、接着、推翻、采用、妨碍、解决、检查、支持、留下缺口，并校验端点类型；不合规的边丢弃，备注写明条数。整体结构不合法（缺 cards/edges 数组、没有一个合法目标）时整版拒绝。单张卡类型、标题或 ID 不合法或重复时丢弃该卡，备注写明张数；状态不合法记为未知。署名、步骤执行者不在输入会话中、或来源引用在输入片段里找不到时，只移除该项，写进卡片的系统说明（不算事实）。重复的连线只保留一条。修改、验证、结论引用用户需求原话或模型思考作来源时，该引用被移除。

### 开发

需要 Bun 1.2+ 和 Node 22+；浏览器测试由 Playwright 在 Node 下运行。

```sh
bun install
bun run dev:web              # 终端 1：前端改动后自动重新打包到 dist-cli/web
bun run dev:cli <session-id> # 终端 2：后端改动后自动重启，托管 dist-cli/web
bun run typecheck            # TypeScript 严格模式检查
bun run test                 # 后端单元与 HTTP 测试
bun run build && bun run test:web   # 打包后跑前端浏览器测试
bun run build && node dist-cli/index.js <session-id>   # 用纯 Node 验证发布产物
```

目录：`src/shared` 前后端数据契约；`src/cli` 会话解析、归纳与 HTTP 服务；`src/web` React 页面。发布内容只有 `dist-cli/`（`index.js` 与 `web/`）。

前端浏览器测试用 `@playwright/test` 驱动（`playwright test` 在 Node 下运行）。浏览器先装一次：`bunx playwright install --only-shell chromium`；也可用 `OBS_BROWSER` 指定本机已有的 Chromium 路径。失败时的截图和 trace 落在 `/tmp/observe-acceptance/frontend`（可用 `OBS_TEST_OUT` 改）。浏览器测试依赖仅用于开发，不进入产品。HTTP 测试启动独立临时 HOME 和假模型服务，结束后清理；前端浏览器测试拦截请求，使用 42 卡、16 参与者、52 边样例，不连接用户服务。

证据边界、未完成项与本轮判断见 `docs/advanced-plans/2026-09-16-observe-product-quality/`；原设计见 `docs/design/astra-review-v2.md`。
