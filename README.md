# agent-observe — Agent Session「需求解决地图」观察台

给一个 Claude Code session ID，把它（连同它派生出的子 agent 会话）重建为一张
**「目标 → 解决路径 → 验收结果」地图**：LLM 把压缩事件流归纳成六类卡片 + 动词边 +
每张卡的贡献者署名，浏览器实时渲染，可回放历史状态。

不是过程监控，而是**按需的会话取证**：回答三个问题——
1. 需求解决到哪一步了？
2. 谁（哪个 agent）贡献了什么？
3. 还差什么才能完成？

设计原则（经 astra 评审的 v2 方案，见 `docs/design/astra-review-v2.md`）：

- **机制不画**：派发、挂哨兵、等待、收束这类编排动作不建卡，只体现为对应验证卡上的
  一行「报告 · sentinel」署名。
- **代理不是地点，是署名**：每张卡 `sig: [{verb, agent}]`，主 agent 转述别人的判断
  不能改成自己署名。
- **诚实**：未知就建 gap，失败记录保留，不做完成度百分比。

## 快速开始

零依赖，Node ≥ 18：

```bash
node observe.mjs 9161063c                     # session ID 或前缀
# 打开 http://127.0.0.1:4173
```

常用参数：

```bash
node observe.mjs <id> [<id>…] \
  [--port 4173] [--interval 60] \
  [--cli claude|pi|codex] [--provider p] [--model m] \
  [--budget 400000]
```

- `--cli`：压缩用的无头 LLM CLI，默认 `claude`（`claude -p`）。也可用 `pi`
  （需 provider/key 环境）或 `codex`（`codex exec`，订阅额度独立于 claude，撞限额时换它）。
- `--interval`：文件变化检测周期（秒）；被观察的 JSONL 有增长才触发重新压缩，
  增量同步保持卡片 id 稳定。
- Header 的下拉菜单可随时追加/移除观察者（`POST /api/sessions/add|remove`），
  多个 session 切换着看。

## 它如何工作

```
~/.claude/projects/<munged-cwd>/<uuid>.jsonl
   │  parse.mjs      事件流：user/assistant 块，跳过 attachment/snapshot 等 12 类噪音
   │  tree.mjs       树重建：Bash 里 herdr agent prompt 派发的兄弟会话
   │                 （prompt 头 60 字匹配 + 同名合并 + 体积择优 + 排除自指），
   │                 Agent/Task 工具原生子 agent（agent-<id6>）
   │  segment.mjs    分段压缩成 LLM 事件流（用户回合切分、结果头尾截取、16k/段、总预算）
   ▼  summarize.mjs  claude/pi/codex -p → 六类卡片 schema JSON（严格 normalizeMap 过滤）
Observer（observe.mjs）  per-card born / states[] 历史 → 任意历史时刻回放
   ▼
web/index.html    五列地图（目标｜子目标｜方案/风险｜验证｜结论/缺口）+ SVG 动词边
                  分层披露：卡=类型+状态+标题(clamp2)+核心事实(clamp2)+署名摘要+详情，
                  全文/步骤/关系面板进 480px 抽屉；zone>3 卡自动折叠成
                  「其余 N 项·M 项未解决」入口（可展开）；边三级显隐（默认主线+≤6 个
                  未解决标签，选中/hover 显全部直接关系）；live 三格 clamp2 可点开；
                  参与者摘要+可搜索面板；历史默认收起；列宽/卡高实测，无列内滚动
```

多 agent 收束：herdr 并行会话与原生 Task 子 agent 都挂在主线的派发点下，
其产出以「署名」出现在卡片上，而不是画成泳道——地图上只有一条主线。

## 卡片 schema

| type    | 含义 | 边动词（出） |
|---------|------|--------------|
| goal    | 目标（全图 1 张，含 acc 验收数组） | 拆成 |
| subgoal | 可独立验收的子目标 | 采用 / 检查 |
| change  | 方案/修改（一句动作 + 一个结果） | 解决 / 检查 |
| risk    | 风险/障碍（区分 doing 与已 failed） | 妨碍 |
| verify  | 验证（注明样本范围/被测版本） | 支持 |
| concl   | 结论（证据不足用 partial） | 留下缺口 |
| gap     | 缺口（还差哪些证明） | — |
| group   | 失败→修复→重验 折叠组（steps 数组） | 解决 |

每卡：`sig[{verb,agent}]` 署名、`st`（doing/done/failed/partial/risk/resolved）、
`zone`（所属子目标分区）、`facts` 证据要点、`ev` 来源。
LLM 输出经 `normalizeMap` 过滤：非法边、缺题卡片一律丢弃。

## 已知边界（诚实清单）

- **Cursor Agent CLI 子会话已支持**：`herdr --kind cursor` 派发的会话落在
  `~/.cursor/projects/<munged-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`，
  按「prompt 头在前 300 字内 + mtime 时间窗」匹配（转写无 tool_result，结果体现在
  assistant 文本里）。
- **Cursor IDE 聊天**（`~/.cursor/chats/*/*/store.db` SQLite）仍不解析——它包含
  `<user_info>` 等大段注入文本，误配风险高，暂不采信。
- 压缩质量依赖所选模型；默认 `claude→haiku`、`codex→gpt-5.6-luna`，可用
  `--cli/--model` 覆盖。haiku 压缩更激进（同会话 ~25 卡 vs 大模型 ~40 卡）。
- 增量同步假设「同一工作的延续」，LLM 可能重排卡片——id 稳定性靠 prompt 约束 +
  prev cards 注入，非强保证。

## 设计文档与致谢

- v2 地图方案：`docs/design/astra-review-v2.md`（gpt-6-astra 评审，mechanism-ban、
  honesty 规则、六类节点/动词边均出自该评审）
- 早期调研与两版 mock：`docs/design/`（v1 泳道方案已被否决，留档对照）

## Roadmap

- 多 session 对比视图（同一需求两次执行的 diff）
- 会话内截图/产物关联到卡片 `ev`
