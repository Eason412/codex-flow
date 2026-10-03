# Codex Flow

中文 | [English](README.en.md)

**在 Claude Code 里像 Workflow 一样派发、查看和停止 Codex 任务。** Claude 把边界清楚的子任务交给 Codex CLI 执行：单个任务用 `run.sh`，多个任务用 `codex-flow` 按阶段并行。进度显示在输入框上方的任务面板里，停止、完成通知和续跑沿用 Claude Code 原生的后台任务。

![输入框上方的 flow 面板：左栏阶段，右栏 agent](docs/images/panel-flow.png)

- **Codex CLI**：OpenAI 的命令行编程智能体，本项目用它执行 Claude 派出的任务。
- **mod**：Claude Code 的插件钩子模块，可以在界面上绘制面板、注册命令。本项目的任务面板是一个 mod。

当前版本：[V0.2.0](https://github.com/Eason412/codex-flow/releases/tag/V0.2.0)（[全部版本与更新说明](https://github.com/Eason412/codex-flow/releases)）。app-server 客户端的协议用法参照 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Apache-2.0）。

> ⚠️ **前提：macOS 或 Linux，本机需有已登录的 Codex CLI、Node.js 和支持 mod 的 Claude Code。** Codex 以完全权限运行（无沙箱、不审批），会直接修改文件和执行命令。

## ✨ 特点

- 🧭 **分阶段并行与流水线**：同一阶段的任务并行，阶段之间默认按顺序；写上 `after` 的任务在前置完成后立即开跑，不等同阶段的慢任务。
- 📺 **输入框上方的实时面板**：任务开始时自动出现，布局参照 Claude Workflow 的详情面板，左栏阶段、右栏 agent；进入 agent 可看过程和结果，还能直接插话。
- 🔢 **实时 token 用量**：口径与 Claude Code 的「↓ N tokens」相同，是当前上下文加本次运行的输出，不把每次调用的输入累加；flow 任务在 Codex 每次回复后更新，单个任务每 2 秒从 Codex 会话记录读取。
- ⏹️ **原生停止与完成通知**：flow 由后台 Bash 启动，在 Background 列表按 x 即可停止，结束时自动通知 Claude；单个任务在面板中按 x 停止。
- 🛡️ **写入范围与验收**：任务可声明允许修改的路径和验收命令；结束后标出越界写入，验收命令全部通过才算完成。
- ♻️ **续跑复用结果**：`--resume` 时只重跑改动的任务和依赖它的任务；结束时的汇总给每个任务附三行以内的结论。
- 🔍 **实际模型核实**：报告中的模型和 effort 取自 Codex 自己的会话记录，与请求不一致或无法核实时标出 ⚠。
- ⏱️ **15 分钟排查提醒**：任务每运行满 15 分钟，mod 在对话中提醒 Claude 读日志并汇报；任务不会被自动停止，也不会只凭时长被判定为卡住。
- 🔒 **模型白名单**：`models.json` 列出允许的模型和 effort，名单外的请求在启动前即被拒绝。

## ⚙️ 工作原理

```text
Claude Code 主对话
 ├─ run.sh ─────────────────► codex exec              单个任务
 └─ 后台 Bash: codex-flow ───► codex app-server × N    每个任务一个进程
         │ 两者都写入运行状态
         ▼
 ~/.claude/codex-flow/runs/<runId>/
         │ 读取
         ├─► codex-flow mod    输入框上方的面板、15 分钟提醒
         └─► statusline.mjs    面板收起时状态行中的一行进度
```

| 组成 | 作用 |
| --- | --- |
| `run.sh` | 运行单个 Codex 任务，登记状态并报告实际使用的模型 |
| codex-flow 执行器 | 读取计划、按依赖推进，写入状态、过程、结果和汇总 |
| codex-flow mod | 任务面板、`/flow` 命令、停止与插话、15 分钟提醒 |
| `statusline.mjs` | 供 ccstatusline 调用，面板收起时显示一行进度 |
| `SKILL.md` | 告诉 Claude 何时委派、选用哪个模型、如何排查 |
| `models.json` | 允许的模型和 effort |

- **显示与运行分开**：mod 只负责显示和提醒；mod 未加载时，任务照常运行。
- **运行记录**：默认在 `$HOME/.claude/codex-flow`，可用 `CODEX_FLOW_HOME` 改；保留 7 天。
- **路径**：代码不写死路径。仓库可放在任意目录，脚本按自身位置找文件，计划里的相对路径按计划文件和 `cwd` 解析。

## 🖥️ 任务面板

![任务列表：一个 flow 和两个单个 agent](docs/images/panel-list.png)

- **排列**：多个任务时一行一个，flow 排在单个 agent 上面，同类中新开始的在上；任务结束后位置不变。
- **多个任务**：正在看某个任务时又有新任务开始，面板不跳走，外框上边写「另有 N 个任务」；按 `b`「返回列表」回到列表，再选另一个。
- **颜色**：flow 紫色，单个 agent 蓝色，外框颜色随列表中的任务类型变化。
- **运行标记**：运行中的 flow 和阶段是闪烁的蓝色星形（与 Claude Code 的 ✻ 一致），agent 是转圈的蓝色细点阵；几个阶段同时运行时都会闪烁，外框上边写「N 个阶段并行」。
- **外框**：上边写名称、状态、总 token 和总时长，下边放操作提示和按钮，不另占行；输入框草稿变长、面板变矮时外框仍在，先省去两栏的内框。
- **阶段栏**：依次显示序号、状态、名称、完成数和耗时；时长和 token 栏按上限预留宽度，运行变长时版面不跳。
- **两栏选择**：左右两栏随时可选。光标先走完左栏的阶段再进右栏的 agent，停在哪个阶段，右栏就换成它的 agent；已完成的阶段也能进去看。
- **长列表**：按可用行数分段显示，用「还有 N 个」翻动；查看子代理的对话时，面板让出位置。
- **空间不够时**：输入框草稿或 Claude Code 的任务清单占了位置、面板只剩一行内容时，改为一行摘要：当前阶段的进度、它的全部 agent、模型和 effort，放不下的写「+N」，有别的任务时行尾写「另有 N 个任务」；任务列表也改成一行，列出全部任务。清空草稿或按 `ctrl+t` 收起任务清单后恢复完整面板。

![agent 详情：任务说明、过程与插话框](docs/images/panel-agent.png)

- **agent 详情**：右栏显示任务说明、过程（命令、改文件和消息的次数，以及最近几步）和结果，左栏切换同阶段的其他 agent。
- **插话**：运行中的 flow 任务下面有插话框。在当前 agent 上按 `Enter` 进入，输入补充指示后再按 `Enter`，执行器在 1–2 秒内用 Codex 的 turn/steer 发给这个任务，送达或被拒都写进过程。
- **插话的范围**：框里输入的字母不会触发 `x`、`b`、`q`；验收中、已结束的任务和单个 agent 没有插话框，因为验收时 Codex 已经结束，单个 agent 由 `run.sh` 运行。

| 按键 | 作用 |
| --- | --- |
| `ctrl+x tab` 或点击面板 | 把键盘切换到面板 |
| `↑` `↓`（`←` `→`、`Tab` 相同） | 在可选项之间移动 |
| `Enter` | 进入阶段、查看 agent 详情；在详情里的当前 agent 上进入插话框 |
| 插话框里的 `Enter` | 把补充指示发给这个 agent |
| `b` | 返回上一层；一行摘要里直接回任务列表 |
| `x` | 停止选中的任务或整个 flow |
| `q` | 关闭面板，任务全部结束后出现 |
| `Esc` | 回到输入框 |
| `ctrl+x ctrl+a` | 展开被 Claude Code 折叠的面板 |

- **打开与关闭**：输入 `/flow` 可随时打开面板；有任务在跑时只能折叠、不能关闭。
- **自动收起**：全部结束 30 秒后，自动打开的面板自动收起。

## 🚀 设置方法

由 Agent 读取 [SETUP.md](SETUP.md)，按其中步骤完成安装、配置与验收。

- **完成后**：重新打开 Claude Code 会话，mod 在会话启动时加载。
- **需用户亲自完成**：登录 Codex CLI（`codex login`）。

### 个人设置

| 设置项 | 位置 | 说明 |
| --- | --- | --- |
| 允许的模型和 effort | `models.json` | 名单外的模型和 effort 直接拒绝 |
| 提醒间隔 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_ALERT_AFTER` | 单位为秒，默认 900 |
| 运行记录位置 | `~/.claude/settings.json` 的 `env`：`CODEX_FLOW_HOME` | 默认 `~/.claude/codex-flow` |
| 状态行进度 | ccstatusline 的 custom-command | 命令 `node ~/.claude/skills/codex/flow/statusline.mjs`，开启 `preserveColors` |

## 📖 用法

- **日常使用**：在对话中让 Claude「交给 Codex」，或说明有几个可以并行、分阶段的任务；Claude 按 [SKILL.md](SKILL.md) 选择模型、写计划并在后台启动。
- **直接运行**：命令也可以在 Claude Code 会话中直接运行，面板只显示本会话派出的任务。

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

- **调度**：「甲审查」写了 `after`，「甲文档」完成后立即开始；「汇总」没写，等整个撰写阶段结束。
- **引用结果**：`{{task:名字}}` 换成单个任务的结果，`{{phase:标题}}` 换成整个阶段的结果。
- **路径**：`promptFile` 和 `{{file:}}` 相对计划文件所在目录，任务的 `cwd` 相对计划的 `cwd`。
- **可选字段**：`"writes": ["README.md"]` 限定修改范围，`"checks": ["<命令>"]` 指定验收命令。

| 命令 | 作用 |
| --- | --- |
| `run.sh -m <模型> -e <effort> "<任务>"` | 运行单个任务；`-r` 续接、`-f` 分叉、`-w` 使用新 worktree、`-j` 按 schema 返回 |
| `flow/codex-flow.mjs run <plan.json>` | 按计划和任务依赖运行，flow 结束才退出，放在后台 Bash 中启动 |
| `flow/codex-flow.mjs run --resume <runId>` | 续跑，复用已完成的任务 |
| `flow/codex-flow.mjs status [runId]` | 查看本会话的运行记录 |
| `flow/codex-flow.mjs cancel <runId> [任务名]` | 停止整个 flow 或其中一个任务 |
| `flow/codex-flow.mjs steer <runId> <任务名> "<内容>"` | 向运行中的任务补充指示 |
| `flow/codex-flow.mjs watch <runId>` | 有任务运行满提醒时长或 flow 结束时输出一行并退出 |

`.mjs` 命令用 `node` 运行，路径相对于 `~/.claude/skills/codex`。计划字段的完整说明见 [SKILL.md](SKILL.md)。

## 📁 仓库结构

| 路径 | 用途 |
| --- | --- |
| [SETUP.md](SETUP.md) | 面向 Agent 的分步安装手册 |
| [SKILL.md](SKILL.md) | 面向 Claude 的委派、选模型与排查规则 |
| [run.sh](run.sh) | 单个任务入口 |
| [flow/](flow/) | codex-flow 执行器、状态行脚本和测试 |
| [mod/](mod/) | 任务面板 mod 及其测试 |
| [agents/codex-runner.md](agents/codex-runner.md) | 在后台代跑常规任务的 Claude 子代理 |
| [schemas/](schemas/) | 内置的 `review`、`opinion`、`result` 返回格式 |
| [models.json](models.json) | 允许的模型和 effort |

## 🤝 贡献须知

欢迎提交兼容修复、功能改进与文档修订。提交 PR 前请注意：

- **范围**：一个 PR 只解决一个问题，不夹带个人配置或无关的格式调整。
- **测试**：改执行器后运行 `node --test flow/tests/`，改 mod 后运行 `claude plugin validate mod` 和 `claude plugin test mod`。执行器测试使用假 Codex 和临时目录，不调用真实 Codex。
- **信息保护**：提交前检查 diff、日志与截图，去除账号信息、私人路径与任务内容。
