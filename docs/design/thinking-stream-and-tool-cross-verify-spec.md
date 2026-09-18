# Specification: 归纳 Agent 思考流滚轮展示与只读工具交叉验证

## 1. 背景与问题定义

在观察大型 coding agent（如 Codex、Claude Code）的长会话时，归纳模型（如 `glm-5.3-flash` 配合深度思考模式）会展开密集的逻辑推演与证据比对。经日志分析：
1. **思考过程盲等**：归纳模型输出中约 80% 为 Reasoning/Thinking Token（可达数万字符），但 Observer 仅监听了正文的 `text_delta`，完全忽略了 `thinking_delta`。导致终端与前端连续 5~8 分钟显示“等待模型开始输出”，造成卡死无响应的体感；
2. **缺乏交叉验证能力**：原系统的 System Prompt 强制规定“只读输入文本，不执行任何命令”，且进程目录写死为 `/tmp`，导致归纳模型遇到会话中截断的报错、存疑的修改范围或发布状态时，无法查验真实工程文件与 git 提交记录；
3. **CLI 权限与扩展未受控**：原先对 `pi` 等 CLI 未限制技能与扩展加载，导致数十个业务技能和工具注入上下文，浪费上千 Token 且存在行为不确定性。

---

## 2. 设计目标

1. **高级感无边框滚轮展示（Thinking Wheel）**：
   - 首版地图生成前，在视窗中央呈现纯净、无生硬边框的居中推演流动效果；
   - 顶部和底部采用双向渐隐遮罩（Vertical Fade Mask），上方历史自然淡出，下方新推演平滑淡入，带精密滚轮向上推进质感；
   - 交叉验证的工具调用以轻量胶囊自然内联穿插在推演流中；
   - 首版地图生成后，滚轮平滑淡出，五列需求解决地图无缝展开。
2. **只读工具交叉验证（Cross-Verification）**：
   - 允许归纳 Agent 使用 `read`、`bash`、`grep` 工具查验工程代码、配置与 git 记录；
   - 严禁任何形式的文件修改（禁止 `edit`、`write` 等）。
3. **三大 CLI 同等权限与环境限制**：
   - 对 `pi`、`Claude Code`、`Codex` 实施同等的最小只读权限白名单、隔离外部技能/扩展、无痕会话（不污染磁盘）以及绑定被观察项目的真实工作目录（CWD）。

---

## 3. 架构与数据契约

### 3.1 共享类型协议 (`src/shared/types.ts`)

```ts
/** 只读工具调用状态视图 */
export interface ToolCallView {
  id?: string;
  name: string;
  args?: any;
  result?: string;
  isError?: boolean;
}

/** 草稿状态扩展：包含当前累积的思考文本与工具调用 */
export interface Draft {
  goals: Card[];
  cards: Card[];
  edges: Edge[];
  live: Live;
  chars: number;
  startedAt: string;
  /** 累积的思考/思维链内容 */
  thinking?: string;
  /** 交叉验证工具调用记录 */
  toolCalls?: ToolCallView[];
}
```

---

## 4. 后端实现方案

### 4.1 工作目录（CWD）绑定
在 `Observer.analyze()` 中提取被观察会话的真实工作目录：
```ts
const projectCwd = host.events.find(e => e.cwd)?.cwd || host.project || process.cwd();
```
传递给 `runModel(prompt, { ..., cwd: projectCwd })`，使所有只读命令在被测工程的真实源码树下执行。

### 4.2 System Prompt 指令调优
移除“只读文本、不执行命令”的死指令，换为安全只读指引：
```ts
const SYSTEM = '你是会话记录归纳器。主要依据输入的会话事件流归纳需求解决地图。为确保事实与证据准确，当对代码变动、测试结果或文件现状存疑时，可使用 read、grep、bash 工具对当前项目进行交叉验证（仅允许查看与只读检查，严禁修改文件）；最终必须严格输出指定的 JSON 地图对象。';
```

### 4.3 三大 CLI 启动参数同等限制矩阵

| 维度 | `pi` | `claude` (Claude Code) | `codex` (Codex app-server) |
| :--- | :--- | :--- | :--- |
| **只读工具白名单** | `--tools read,bash,grep` | `--tools "Bash,Read,Grep,Glob"`<br>`--disallowed-tools "Edit,Write,NotebookCell"` | `sandbox: 'read-only'` (OS 级沙箱拦截一切写入) |
| **外部扩展与技能隔离** | `--no-skills`<br>`--no-extensions`<br>`--no-prompt-templates`<br>`--no-context-files` | `--safe-mode`<br>`--strict-mcp-config` | `-c 'mcp_servers={}'`<br>`--disable plugins`<br>`--ignore-rules` |
| **无痕一次性会话** | `--no-session` | `--no-session-persistence` | `ephemeral: true` |
| **自动化权限** | 默认 non-interactive | `--permission-mode dontAsk` | `approvalPolicy: 'never'` |
| **工程目录绑定** | `cwd: projectCwd` | `cwd: projectCwd` | `cwd: projectCwd` |

### 4.4 事件总线流式处理
- `onPi`:
  - 捕获 `thinking_delta` 追加至 `draft.thinking`；
  - 捕获 `tool_execution_start` / `tool_execution_end` 记录到 `draft.toolCalls`；
  - 捕获 `text_delta` 追加至 `draft.chars` 与 JSON 临时草稿；
- `onClaude`:
  - 捕获 `content_block_delta` 中 `thinking_delta` 与 `tool_use`；
- `onCodex`:
  - 捕获 agent 消息与 tool 输出。
- 终端进度心跳改造：
  - 思考中打印：`[sid] 分析中 30s：思考中（已推演 X 字）`
  - 交叉验证时打印：`[sid] 分析中 45s：交叉验证 read package.json`
  - 正文吐出时打印：`[sid] 分析中 60s：已收到 Y 字，已出 Z 张卡`

---

## 5. 前端交互与视觉规范

1. **初始阶段（未出第一版地图）**：
   - 隐藏传统卡片网格，展示居中无边框滚轮容器（`max-width: 680px`, `height: 380px`）；
   - 使用 CSS `mask-image: linear-gradient(to bottom, transparent 0%, black 35%, black 80%, transparent 100%)` 建立上下自然渐隐；
   - 滚轮内容随文字增加自动平滑向上滚动，展示推演内容与只读工具验证卡片；
   - 顶部保留 Topbar，显示极简呼吸状态指示灯与已推演字符统计。
2. **转场动效**：
   - 当收到正式地图（或校验出目标卡）时，滚轮容器执行 `opacity: 0, transform: translateY(-12px)` 淡出；
   - 五列地图主界面执行 `opacity: 1, transform: translateY(0)` 平滑淡入。
3. **完成阶段**：
   - 右上角与数据说明面板保留思考推演与验证回溯入口。
