---
name: codex
description: "把边界清楚、能独立完成的子任务交给 Codex CLI 执行，每次指定模型和 effort，并报告 Codex 实际使用的值；难题时找 Astra 讨论，高难度任务收尾时让 Codex 审查。用户说“交给 Codex”时也用。"
---

# 调用

```bash
~/.claude/skills/codex/run.sh -m <模型> -e <effort> [-C <目录>] [-r <thread_id> | -f <thread_id> | -w] [-j <schema>] "<任务>"
```

- `-r` 接着同一个 Codex 对话继续；`-f` 从某个对话分叉出新对话，试另一个方向而不打乱原对话。
- `-w` 在新的 git worktree 里运行，并行改文件时用；这种任务之后不能 `-r` 或 `-f`。
- `-j` 让 Codex 按固定 JSON 返回：`review`（审查）、`opinion`（讨论意见）、`result`（实现结果），也可以给 schema 文件路径。审查和讨论一律加 `-j`。
- 输出第一行是日志目录；结尾的「实际使用」一行来自 Codex 自己的会话记录（只认这次运行期间的记录），不是回显请求参数。出现 ⚠ 表示无法核实，要告诉用户。运行中的 token 用量每 2 秒从 Codex 会话记录更新到面板；续接（`-r`）和分叉（`-f`）只算这一次的用量。
- Codex 以完全权限运行（无沙箱、不审批），会直接改文件、跑命令。不要加 `--ephemeral`，否则没有会话记录可核实。

# 默认分工（每次都显式指定模型和 effort）

允许的模型和 effort 写在本目录的 `models.json`（现在是 `gpt-6.1-sol` 和 `gpt-6-astra`），run.sh 和 codex-flow 都按它检查，名单外直接拒绝；以后增减模型只改这个文件。用户指定了模型或 effort 时以用户为准；否则按下表选：

| 任务 | 模型 / effort |
|---|---|
| 常规任务：查找、批量修改、补测试、跑命令收集信息、边界清楚的小功能、原因明确的 bug 修复、代码审查 | `gpt-6.1-sol` / `high` |
| 难题：架构和方案取舍、自己试过仍没解决的 bug、较大改动的第二意见 | 和 `gpt-6-astra` 讨论，`medium` 起步，特别难用 `high` |
| 很高难度的任务做完后，审查一次改动 | `gpt-6-astra` / `high`，加 `-j review` |

平时不做自动审查，只有很高难度的任务在收尾时审查一次。

# 和 Astra 讨论（独立判断）

1. 先在自己心里定下倾向，但不要告诉 Astra。只给它背景、证据、约束、已尝试的办法和卡点，写明「只分析、不要修改文件」，加 `-j opinion`。
2. 它的判断和我不同时，用 `-r` 反驳一轮：说出我的方案和理由，请它指出哪里站不住。只来回这一轮。
3. 想试另一个方向时用 `-f` 分叉，不要在原对话里反复改前提。
4. 最后由 Claude 决定方案并实施，向用户说明采纳或不采纳 Astra 意见的原因。

# 前台还是后台

- 需要审查结论的任务（Astra 讨论、代码审查、难题排查）由主 agent 自己运行并读完整输出，不交给后台子代理转述。
- 常规的 Sol 任务想放后台时，交给 `codex-runner` 子代理（Sonnet）去跑，它只带回实际模型/effort、结果要点和完整输出路径；需要细看时再读完整输出。
- 前台运行时 Bash 的 timeout 设为 600000。预计超过 10 分钟的任务用 `run_in_background`，跑满 15 分钟时按下面「跑满 15 分钟时排查」处理。
- run.sh 加 `-n <显示名>` 时，状态行和 `/flow` 面板用这个简短中文名；不加时取任务描述的开头。

# 多个任务一起跑：codex-flow

有两个以上要并行或分阶段的 Codex 任务时，写一个计划文件放在 scratchpad，用 `run_in_background` 交给 codex-flow，不再逐个调 run.sh：

```bash
node ~/.claude/skills/codex/flow/codex-flow.mjs run <plan.json>
```

```json
{"name": "docs", "cwd": "/path/to/repos",
 "phases": [
   {"title": "撰写", "tasks": [
     {"label": "甲文档", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-a", "promptFile": "write-a.md"},
     {"label": "乙文档", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-b", "promptFile": "write-b.md"}]},
   {"title": "审查", "tasks": [
     {"label": "甲审查", "model": "gpt-6.1-sol", "effort": "high", "schema": "review", "cwd": "repo-a", "after": ["甲文档"], "prompt": "{{file:review.md}}\n撰写结果：{{task:甲文档}}"},
     {"label": "汇总", "model": "gpt-6-astra", "effort": "high", "prompt": "复核：\n{{phase:撰写}}"}]}]}
```

- 调度：没写 `after` 的任务等上一阶段全部结束，同一阶段的任务并行，数量不设上限。写了 `after`（任务名或阶段标题的数组）的任务只等列出的任务，前置一完成就开跑，不等同阶段的慢任务；上例「甲审查」在「甲文档」写完后立刻开始，不等「乙文档」。要流水线就写 `after`，不写就是按阶段顺序。
- `{{phase:标题}}` 换成该阶段所有任务的结果，`{{task:名字}}` 换成单个任务的结果，被引用的任务自动算作前置。前置任务一个都没完成时，这个任务记为跳过，等它的任务也跟着跳过。引用不存在的任务、引用自己所在的阶段或依赖成环时拒绝启动。
- 长 prompt 写进文件用 `promptFile`；几个任务共用的背景放进文件，用 `{{file:路径}}` 引用。两者都相对计划文件所在目录，在启动时读进计划，不会读到其他任务运行中写出的内容，那些用 `{{task:}}` 或让 Codex 自己读。
- `cwd` 可以写在任务上，相对计划的 `cwd`；不写就用计划的 `cwd`。
- 先探路（可选）：几个写手要读同一批材料时，先派一个只读的 Sonnet 子代理（`simple-task` 或 `standard-task`）把要读的出处、核对过的事实和约束整理成探路包，各写手用 `{{file:}}` 附在 prompt 末尾，并写明「以仓库文件为准，探路包只作索引」，免得包里的错被每个写手照抄。2026-10-03 的对照（同一撰写任务，带包和不带包各 2 次，gpt-6.1-sol high）：带包的写手非缓存 token 低约 28%（均值约 8.7 万对 12.1 万），盲评事实错误两组都是 0，验收都通过，所以只能说省 token，不能说提高质量；探路花了约 7.6 万 Sonnet token，而每个写手只省约 3.3 万 Codex token。一个探路包供三个以上写手共用，或 Codex 额度比 Claude 额度紧时才划算；只有一两个写手时直接写。每组只有 2 次，作参考。
- `writes`（可选）：任务可以修改的路径或 glob，相对任务的 `cwd`，也可写绝对路径；写目录名包含其下所有文件，`.` 表示整个工作目录，glob 也匹配点开头的文件，单层 `*` 不含子目录；`[]` 表示只读。`checks`（可选）：任务结束后由执行器在任务的 `cwd` 依次运行的验收命令。两者都会写进 prompt 末尾，让 Codex 自己先核对。
- 写入核对只报告、不改任务状态，失败或被停掉的任务也核对：Codex 改文件记录里范围外的路径记为「越界写入」，这是唯一能确定归属的依据；同一时段 git 工作区里范围外、没有任务认领的变动记为「范围外变动，来源未定」，多半是 shell 命令写的，几个任务同时在一个仓库里写或跑验收时也可能来自别的任务。同一仓库里并行写文件的任务，各自的 `writes` 不要重叠。
- 验收全部退出码为 0 才算完成；失败或超时（默认 10 分钟，环境变量 `CODEX_FLOW_CHECK_TIMEOUT` 按秒改，超时后先 SIGTERM、3 秒后强制结束，命令留下的后台进程一并结束）记为失败，保留结果，下游按前置未完成处理。输出在运行目录的 `logs/<任务>.checks.log`。续跑时，验收失败或改了 `checks` 的任务复用 Codex 结果、只重跑验收，已完成的下游沿用原结果；只改 `writes` 不重跑，越界记录按新范围重筛。
- `label` 在整个计划里唯一，会显示给用户，用简短中文名；`brief` 可选，是 `/flow` 详情页里的一句话说明；`schema` 用内置的 `review` / `opinion` / `result` 或 schema 文件路径。模型和 effort 照上面的分工表，只能用 `models.json` 里的。
- 结束时会收到后台任务通知。读输出里的汇总（也在运行目录的 `summary.txt`）：每个任务下有验收结果、越界提醒和三行以内的结论，schema 结果写判断、问题数和 summary，md 结果取正文第一段；不用 schema 的任务在 prompt 里要求回复先用三行以内写结论。需要细看时再按结果路径读；汇总里出现「⚠ 实际模型」要告诉用户。
- 停整个 flow：用户在 Background 里按 x，或我用 TaskStop。停单个任务：用户在 `/flow` 面板按 x，或 `codex-flow.mjs cancel <runId> <label>`。中途补充要求：`codex-flow.mjs steer <runId> <label> "<内容>"`；用户让我转告某个运行中的 Codex 时也用它。用户也可以在面板 agent 详情的插话框里直接发，送达或被拒都记在该任务 state 的 `recent` 里（面板「过程」区）。Codex 一结束（`turnEnded`，之后可能还在验收 `checking`）就不再取插话，之后写进来的改名为 `.unsent` 并在过程里注明「插话没有送达」。看进度：`codex-flow.mjs status [runId]`。
- 续跑：`codex-flow.mjs run <改过的 plan.json> --resume <runId>`，或不给计划只写 `run --resume <runId>`。没改过且已完成的任务复用结果，改过的任务和等它的任务重跑。
- 显示部分：输入框上方的任务面板和提醒是 `mod/` 下的 mod，由 `~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS` 加载到每个会话（之前已开着的会话要重开才加载）。flow 和 run.sh 单个任务开始时面板自动出现（flow 紫色、agent 蓝色）；有任务在跑时面板不能关闭，全部结束后可按 q 关闭，否则自动打开的面板在 30 秒后收起；关闭后同一批任务不再弹出。`/flow` 只负责打开，面板已自动打开时输 `/flow` 会转为手动打开，结束后不自动收起。面板右上角的 `[-]` 是 Claude Code 自带的折叠，折叠后只剩一行「▸ plugin panel hidden」，插件解除不了，用户点那一行或按 ctrl+x ctrl+a 展开。任务很多时各列只显示一段窗口，用「还有 N 个」翻动。按 `after` 提前开跑时几个阶段会同时显示蓝色星形，外框上边写「N 个阶段并行」，默认看第一个运行中的阶段，↑/↓ 切换。左右两栏随时可选，已完成的阶段也能进去看；agent 详情显示过程（命令、改文件、消息的次数和最近几步，来自 state 的 `activity`、`recent`）和结果。面板显示时状态行（`flow/statusline.mjs`，ccstatusline 调用）不画 codex 那一行，靠 mod 写的 `~/.claude/codex-flow/panel-<会话>.json` 判断。改 mod 后跑 `claude plugin validate` 和 `claude plugin test`；改执行器后跑 `node --test flow/tests/`。

# 跑满 15 分钟时排查

- 任何 Codex 任务（flow 里的或 run.sh 单发的）跑满 15 分钟，codex-flow mod 会在对话里发一条 `[codex-flow]` 提醒，之后每满 15 分钟再提醒一次。收到后读提醒里给的日志，看它最近在做什么、有没有进展，向用户汇报。不自动停止，停不停由用户决定。
- 没加载 mod 时（没有 `/flow` 命令），flow 启动后另开一个后台 Bash 跑 `codex-flow.mjs watch <runId>`：有任务跑满 15 分钟时它输出提醒并退出，我收到通知后照上一条处理。
- 只凭时长，或日志一段时间没有新内容，不能说任务“卡住”。要有具体证据（反复出现同一个错误、在等交互请求、进程已经退出）才下结论，并把证据告诉用户。

# 委派规则

- 开跑前告诉用户：交给 Codex 做什么、用哪个模型和 effort。结束后报告「实际使用」的模型和 effort，以及结果要点。
- 任务描述要自包含，Codex 看不到本次对话：写清目标、相关文件路径、约束、验收标准，以及要它返回什么。
- 同一时间不要和 Codex 改同一批文件。并行的改文件任务各用 `-w`。它改完后用 `git diff` 看一遍再向用户汇报；worktree 任务到输出里的「工作目录」看 diff，确认后再合并。
- 不交给 Codex：一两步就能做完的小事、依赖本次对话上下文或需要用户拍板的事、删除或强推等不可逆操作。
- 自动委派走本脚本；插件的 `/codex:review`、`/codex:rescue` 等留给用户手动使用。
