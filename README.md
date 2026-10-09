# Codex Flow

中文 | [English](README.en.md)

**在 Claude Code 中以 Workflow 的方式编排 Codex 任务。** Claude 负责拆分与验收，Codex CLI 负责执行：单个任务由 `run.sh` 运行，多个任务由 `codex-flow` 按阶段并行。任务进度显示在输入框上方的面板中，停止、完成通知与续跑沿用 Claude Code 的后台任务机制。

![输入框上方的 flow 面板：左栏阶段，右栏 agent](docs/images/panel-flow.png)

- **Codex CLI**：OpenAI 的命令行编程智能体，在本项目中执行 Claude 派发的任务。
- **mod**：Claude Code 的插件钩子模块，可在界面上绘制面板、注册命令；本项目的任务面板即一个 mod。

当前版本：[V0.4.0](https://github.com/Eason412/codex-flow/releases/tag/V0.4.0)（[全部版本与更新说明](https://github.com/Eason412/codex-flow/releases)）。app-server 客户端的协议用法参照 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Apache-2.0）。

> ⚠️ **运行前提：macOS 或 Linux，已登录的 Codex CLI、Node.js，以及支持 mod 的 Claude Code。** Codex 以完全权限运行，无沙箱、无审批，直接修改文件并执行命令。

## ✨ 特点

- 🧭 **阶段编排与并行执行**：同一阶段的任务并行运行，阶段之间依次推进；声明了 `after` 的任务在前置任务完成后立即启动，形成流水线。写入范围重叠的任务自动排队，确需同时修改同一批文件时可启用 worktree 隔离。
- 📺 **原生界面集成**：任务启动时，输入框上方自动出现任务面板，布局参照 Claude Workflow 的详情面板，可查看过程与结果，并向运行中的任务追加指示。停止、完成通知与 Claude Code 的后台任务一致；运行时长只显示在面板上；执行器进程意外退出时，Claude 收到一次排查提醒。
- 📏 **上下文与用量控制**：任务的完整回复保存在结果文件中，Claude 只读取每个任务三行以内的结论。任务说明按组成部分计量，`stats` 命令列出各任务的说明构成、token 用量与回报大小，用于比较不同拆分方式的开销。
- ♻️ **验收与结果复用**：任务可声明验收命令，全部通过才记为完成。续跑时只重新执行修改过的任务及其下游；依据工作区内容快照，只读任务在相关文件变化后自动重跑，写入任务的复用结果标注为过期。
- 🔍 **模型管控与核实**：`models.json` 规定允许的模型与 effort，名单外的请求在启动前被拒绝，并可指定默认使用 Fast 的模型。报告中的模型与 effort 取自 Codex 自身的会话记录，与请求不符或无法核实时标注 ⚠。

## ⚙️ 工作原理

```text
Claude Code 主对话
 ├─ run.sh ─────────────────► codex exec              单个任务
 └─ 后台 Bash: codex-flow ───► codex app-server × N    每个任务一个进程
         │ 两者都写入运行状态
         ▼
 ~/.claude/codex-flow/runs/<runId>/
         │ 读取
         ├─► codex-flow mod    输入框上方的面板、异常提醒
         └─► statusline.mjs    面板收起时状态行中的一行进度
```

| 组成 | 作用 |
| --- | --- |
| `run.sh` | 运行单个 Codex 任务，登记状态并报告实际模型 |
| codex-flow 执行器 | 读取计划、按依赖调度，写入状态、过程、结果与汇总 |
| codex-flow mod | 任务面板、`/flow` 命令、停止与追加指示、异常提醒 |
| `statusline.mjs` | 供 ccstatusline 调用，面板收起时显示一行进度 |
| `SKILL.md` | Claude 的委派规则：何时派发、如何拆分、选用哪个模型 |
| `models.json` | 允许的模型与 effort、默认使用 Fast 的模型 |

- **显示与执行分离**：mod 只负责显示与提醒，未加载时任务照常运行。
- **任务说明构成**：发给 Codex 的说明由五部分组成，即指令（计划中的 prompt）、资料（`{{file:}}` 引入的文件）、上游结果（`{{task:}}`、`{{phase:}}` 注入的内容）、约束（执行器追加的写入范围与验收命令）和 schema（返回格式）。资料在启动时读入计划，运行期间保持不变。
- **结果回收**：汇总为每个任务给出一行状态、三行以内的结论与结果文件路径；失败原因、越界写入、同文件修改、结果过期与成果分支等提示仅在出现时列出。下游只需查阅上游结果的一部分时，`{{path:任务名}}` 只传递结果文件路径，由 Codex 自行读取；注入内容超过 8000 字时，汇总提示改用此方式。
- **运行记录**：每次运行在 `~/.claude/codex-flow/runs/<runId>/`（由 `CODEX_FLOW_HOME` 调整）保存计划、状态、完整回复、日志与汇总，供面板、`status`、续跑与 `stats` 读取。记录保留 7 天，含隔离成果分支的保留 30 天；清理不依赖定时任务，在保留期过后的下一次运行结束时执行。汇总中的运行目录一行注明删除日期，`clean <runId>` 可立即清理成果分支与 worktree。
- **Codex 会话归档**：每个任务的 Codex 会话在任务结束时归档至 `~/.codex/archived_sessions`，不出现在 Codex 桌面端的「最近」与「项目」列表中，与 Claude Workflow 子代理记录不进入 `/resume` 的做法一致。
- **路径解析**：代码中没有固定路径，仓库可放在任意目录；计划中的相对路径按计划文件与 `cwd` 解析。

## 🧱 并行写入策略

并行写入的处理方式与 Claude Workflow 一致：编排者按文件划分任务，需要接力的任务依次运行，只有确需同时修改同一批文件时才使用 worktree。依据是 Claude Code agent teams 文档对文件归属的要求，以及一项针对 33,596 个 agent PR 的冲突研究：worktree 只把冲突推迟到合并阶段，按文件划分、逐个合并、尽早发现才能减少冲突。

- **写入范围排队**：声明了 `writes` 的任务，若范围与正在运行的任务重叠，则等待前者结束后启动，效果等同于添加 `after`。未声明 `writes` 的任务照常并行，启动时提示补充范围。
- **同文件修改提示**：两个同时运行的任务修改了同一文件时，汇总中双方各有一行提示，由 Claude 判断是否重跑先结束的一方。检测依据是 Codex 的文件修改记录，shell 命令写入的文件不在其中。
- **worktree 隔离（可选）**：设置 `isolation: "worktree"` 的任务在独立 worktree 中运行与验收，与 Claude Workflow 的 `isolation: 'worktree'` 对应。产生改动时，成果保存为分支 `codex-flow/<runId>/<任务名>`，汇总给出查看与合并命令，由 Claude 审阅后合并；未产生改动时不保留任何内容。可写在计划顶层作为默认值，单个任务以 `false` 退出。
- **隔离的代价与限制**：每个隔离任务占用一份完整检出（8.5k 文件的仓库约 1 秒、240MB），同时最多 4 个（`CODEX_FLOW_MAX_WORKTREES`）。排在隔离任务之后的任务看不到其改动，需要接力时应改为依次运行，或分两次运行并在中间合并。被忽略的文件不进入成果分支；worktree 目录在保存分支后删除，`keepWorktree: true` 可保留。

## 🖥️ 任务面板

![任务列表：一个 flow 和两个单个 agent](docs/images/panel-list.png)

- **层级**：面板分为任务列表、flow 详情与 agent 详情三层。flow 详情左栏为阶段、右栏为该阶段的 agent，已完成的阶段同样可查看；agent 详情显示任务说明、过程与结果。
- **颜色与标记**：flow 为紫色，单个 agent 为蓝色，运行中的项目带动态标记；默认使用 Fast 的模型前标黄色 ⚡。外框上边显示名称、状态、token 合计与总时长，token 口径与 Claude Code 的「↓ N tokens」一致。
- **多任务**：查看某个任务时有新任务启动，面板保持当前视图，外框上边注明「另有 N 个任务」，按 `b` 返回列表切换。
- **空间不足时的摘要**：输入框草稿或 Claude Code 任务清单占用空间、面板只余一行时，改为一行摘要，显示当前阶段进度与其中的 agent；清空草稿或按 `ctrl+t` 收起任务清单后恢复。
- **打开与关闭**：任务启动时面板自动打开，`/flow` 可随时打开。有任务运行时面板只能折叠，全部结束后可关闭；自动打开的面板在全部结束 30 秒后收起。

![agent 详情：任务说明、过程与追加指示输入框](docs/images/panel-agent.png)

- **追加指示**：运行中的 flow 任务下方有输入框，在当前 agent 上按 `Enter` 进入，输入后再按 `Enter` 发送；执行器在 1–2 秒内通过 Codex 的 turn/steer 送达，送达与否记录在过程中。
- **适用范围**：验收中与已结束的任务、由 `run.sh` 运行的单个 agent 不提供输入框，因为此时已无可接收指示的 Codex 会话。

| 按键 | 作用 |
| --- | --- |
| `ctrl+x tab` 或点击面板 | 将键盘焦点切换到面板 |
| `↑` `↓`（`←` `→`、`Tab` 相同） | 在可选项之间移动 |
| `Enter` | 进入阶段或 agent 详情；在当前 agent 上进入输入框 |
| 输入框中的 `Enter` | 将追加指示发送给该 agent |
| `b` | 返回上一层；一行摘要中直接返回任务列表 |
| `x` | 停止选中的任务或整个 flow |
| `q` | 关闭面板，全部任务结束后可用 |
| `Esc` | 返回输入框 |
| `ctrl+x ctrl+a` | 展开被 Claude Code 折叠的面板 |

## 🚀 设置方法

由 Agent 读取 [SETUP.md](SETUP.md)，按其中步骤完成安装、配置与验收。

- **完成后**：重新打开 Claude Code 会话，mod 在会话启动时加载。
- **需用户亲自完成**：登录 Codex CLI（`codex login`）。

### 个人设置

| 设置项 | 位置 | 说明 |
| --- | --- | --- |
| 允许的模型和 effort | `models.json` | 名单外的模型和 effort 直接拒绝 |
| 默认使用 Fast 的模型 | `models.json` 的 `fast` | 限于 `models` 中已列出的模型；省略或留空时均不使用 |
| 时长提示间隔 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_ALERT_AFTER` | 单位为秒，默认 900；只弹界面提示，不进对话 |
| 运行记录位置 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_HOME` | 默认 `~/.claude/codex-flow` |
| Codex 会话归档 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_ARCHIVE_THREADS` | 默认归档，设为 `0` 时关闭 |
| 隔离任务并发上限 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_MAX_WORKTREES` | 默认 4，超出的隔离任务排队 |
| 状态行进度 | ccstatusline 的 custom-command | 命令 `node ~/.claude/skills/codex/flow/statusline.mjs`，开启 `preserveColors` |

## 📖 用法

- **日常使用**：在对话中要求 Claude 将任务交给 Codex，或说明有哪些可并行、分阶段的工作；Claude 依据 [SKILL.md](SKILL.md) 选择模型、编写计划并在后台启动。
- **直接运行**：下列命令也可在 Claude Code 会话中直接执行，面板只显示本会话派发的任务。

```json
{"name": "docs", "cwd": "/path/to/repos",
 "phases": [
   {"title": "撰写", "tasks": [
     {"label": "甲文档", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-a", "promptFile": "write-a.md"},
     {"label": "乙文档", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-b", "promptFile": "write-b.md"}]},
   {"title": "审查", "tasks": [
     {"label": "甲审查", "model": "gpt-6.1-sol", "effort": "high", "schema": "review", "cwd": "repo-a", "after": ["甲文档"], "prompt": "{{file:review.md}}\n{{task:甲文档}}"},
     {"label": "汇总", "model": "gpt-6-astra", "effort": "high", "prompt": "复核：\n{{phase:撰写}}"}]}]}
```

- **调度**：「甲审查」声明了 `after`，在「甲文档」完成后立即启动；「汇总」未声明，等待整个撰写阶段结束。
- **结果引用**：`{{task:名字}}` 替换为单个任务的结果，`{{phase:标题}}` 替换为整个阶段的结果，`{{path:名字}}` 替换为结果文件路径；被引用的任务均视为前置任务。
- **路径**：`promptFile` 与 `{{file:}}` 相对于计划文件所在目录，任务的 `cwd` 相对于计划的 `cwd`。
- **可选字段**：`"writes": ["README.md"]` 限定写入范围，`"checks": ["<命令>"]` 指定验收命令，`"reads"` 指定续跑时检查变化的文件，`"isolation": "worktree"` 启用 worktree 隔离。

| 命令 | 作用 |
| --- | --- |
| `run.sh -m <模型> -e <effort> "<任务>"` | 运行单个任务；`-r` 续接、`-f` 分叉、`-w` 使用新 worktree、`-j` 按 schema 返回 |
| `flow/codex-flow.mjs run <plan.json>` | 按计划与依赖运行，flow 结束后退出，在后台 Bash 中启动 |
| `flow/codex-flow.mjs run --resume <runId> [--rerun <任务名>]` | 续跑，复用已完成且未过期的任务；`--rerun` 强制重跑，可重复 |
| `flow/codex-flow.mjs stats <runId> [--json]` | 各任务的说明构成、token 用量、回报大小与验收结果 |
| `flow/codex-flow.mjs clean <runId>` | 删除成果分支（之后有新提交的除外）与残留 worktree |
| `flow/codex-flow.mjs status [runId]` | 查看本会话的运行记录 |
| `flow/codex-flow.mjs cancel <runId> [任务名]` | 停止整个 flow 或其中一个任务 |
| `flow/codex-flow.mjs steer <runId> <任务名> "<内容>"` | 向运行中的任务追加指示 |
| `flow/codex-flow.mjs watch <runId> [--alert-after 秒]` | 等到运行结束并打印汇总；给出 `--alert-after` 时任务跑满该时长就提前退出 |
| `flow/codex-flow.mjs verdict <runId> [任务名] used\|partial\|unused ["原因"]` | 验收后记下结果是否用上，和计划的拆分理由、模型来源一起留在 `history.jsonl` 供复盘 |
| `flow/codex-flow.mjs history --backfill` | 把尚未记录的运行补进长期摘要 `history.jsonl` |

`.mjs` 命令用 `node` 运行，路径相对于 `~/.claude/skills/codex`。计划字段的完整说明见 [docs/flow-plan.md](docs/flow-plan.md)。

## 📁 仓库结构

| 路径 | 用途 |
| --- | --- |
| [SETUP.md](SETUP.md) | 面向 Agent 的分步安装手册 |
| [SKILL.md](SKILL.md) | 面向 Claude 的委派、模型选择与排查规则 |
| [run.sh](run.sh) | 单个任务入口 |
| [flow/](flow/) | codex-flow 执行器、状态行脚本与测试 |
| [mod/](mod/) | 任务面板 mod 及其测试 |
| [schemas/](schemas/) | 内置的 `review`、`opinion`、`result`、`report` 返回格式 |
| [models.json](models.json) | 允许的模型与 effort、默认使用 Fast 的模型 |

## 🤝 贡献须知

欢迎提交兼容修复、功能改进与文档修订。提交 PR 前请注意：

- **范围**：一个 PR 只解决一个问题，不夹带个人配置或无关的格式调整。
- **测试**：修改执行器后运行 `node --test flow/tests/`，修改 mod 后运行 `claude plugin validate mod` 与 `claude plugin test mod`。执行器测试使用模拟 Codex 与临时目录，不调用真实 Codex。
- **信息保护**：提交前检查 diff、日志与截图，去除账号信息、私人路径与任务内容。
