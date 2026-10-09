# 架构说明

中文 | [English](architecture.en.md)

本文面向读代码、排查运行问题和参与贡献的开发者。排查时先看运行目录的状态、结果和日志，再沿下面的入口定位负责的模块。
安装和日常用法见 [README](../README.md)，计划字段见 [flow 参考](flow-plan.md)。

## 组成与关系

```text
Claude Code
  +-- run.sh ----------------> codex exec
  |      +-- single.mjs / tokens.mjs
  +-- flow/codex-flow.mjs ----> runner.mjs --> task.mjs
                                 |              +--> codex app-server (per task)
                                 +--> checks.mjs     (stdio JSON-RPC)
          | state / results / logs / summary
          v
  $CODEX_FLOW_HOME/runs/<runId>/
          +--> mod/hooks/register.tsx --> terminal / desktop
          |         +--> control/ --> task.mjs / checks.mjs
          +--> flow/statusline.mjs
                    ^
  $CODEX_FLOW_HOME/panel-<session>.json <-- mod

  models.json / schemas/ --> execution inputs
  run completion --------> $CODEX_FLOW_HOME/history.jsonl
```

| 组成 | 作用 | 入口文件 |
| --- | --- | --- |
| 单发脚本 | 参数解析、启动单次调用、登记与收尾 | [run.sh](../run.sh) |
| codex-flow 执行器 | 命令分发、计划校验、任务调度 | [codex-flow.mjs](../flow/codex-flow.mjs)、[runner.mjs](../flow/lib/runner.mjs) |
| Codex 进程 | flow 通过 app-server 控制会话；单发通过 exec 接收事件 | [appserver.mjs](../flow/lib/appserver.mjs)、[single.mjs](../flow/lib/single.mjs) |
| 运行目录 | 向命令行、续跑和界面提供持久状态 | [state.mjs](../flow/lib/state.mjs) |
| mod 面板 | 读取状态、呈现任务、提交控制请求 | [register.tsx](../mod/hooks/register.tsx) |
| 状态行 | 从标准输入读取会话标识，输出一行进度 | [statusline.mjs](../flow/statusline.mjs) |
| 模型配置 | 提供允许的模型、effort 和 Fast 配置 | [models.json](../models.json) |
| 返回格式 | 提供结构化回复的 JSON Schema | [schemas/](../schemas/) |

执行器和面板之间以文件交换状态与控制请求，面板不持有 Codex 连接。Codex 连接由任务拥有；传输层处理请求编号、响应、通知和进程退出。
服务端发来的交互请求会被拒绝，并记入任务日志，避免后台任务无限等待交互。

## 运行目录

下表中的路径相对于 `$CODEX_FLOW_HOME/runs/<runId>/`。
根目录的配置与默认位置沿用 [README 的设置说明](../README.md#个人设置)。
flow 的运行标识以 `r-` 开头，单发以 `s-` 开头；二者共享状态格式，但文件布局不同。

| 路径 | 内容 | 写入方 → 读取方 |
| --- | --- | --- |
| `state.json` | 运行、阶段、任务状态，PID、时间、结果路径、计量与诊断字段 | 执行器或单发登记/监视器 → mod、状态行、命令行、续跑 |
| `plan.json` | 展开资料并校验后的 flow 计划 | `prepareFlow` → 续跑 |
| `summary.txt` | 本轮结束汇总 | flow 或单发收尾 → 主对话、`watch` |
| `results/<task>.md` / `results/<task>.json` | flow 任务的最终回复 | `writeTaskResult` → 下游任务、汇总、mod、续跑 |
| `logs/<task>.prompt.txt` | 实际发送的任务说明 | `prepareTask` → 排查人员 |
| `logs/<task>.jsonl` | 筛选后的协议通知与控制记录 | `task.mjs` → 排查人员 |
| `logs/<task>.checks.log` | 验收命令及输出 | `checks.mjs` → 排查人员 |
| `control/<task>.stop` | 停止一个 flow 任务的请求 | CLI 或 mod → 调度器、任务、验收器 |
| `control/<task>.steer.<timestamp>.txt` | 追加指示 | CLI 或 mod → 任务控制轮询 |
| `task.txt` | 单发任务说明 | `run.sh` → 单发登记及补登 |
| `events.jsonl` | 单发的 Codex JSON 事件 | `run.sh` 重定向 → 单发监视器及收尾 |
| `last.md` | 单发最终回复，也可能是 JSON 文本 | Codex → 单发收尾、mod |
| `stderr.log` / `unarchive.log` | 单发错误输出；续接或分叉前取消归档的输出 | `run.sh` 重定向 → 收尾报告、排查人员 |
| `control/stop` | 单发停止标记 | CLI 或 mod → 单发收尾 |

`<task>` 是 `runtime.mjs` 中 `fileSafe` 处理后的任务名。结果、日志和停止文件的名称冲突由计划校验提前拦截。
追加指示被取走后改名为 `.sent`；未送达且任务已结束的文件改名为 `.unsent`。
`.sent` 表示已取走，是否成功送达还要看过程记录。

运行目录之外还有三类数据：

| 位置 | 内容与读写方 |
| --- | --- |
| `$CODEX_FLOW_HOME/history.jsonl` | `history.mjs` 追加运行摘要与验收结论，供复盘及补录判重 |
| `$CODEX_FLOW_HOME/worktrees/<runId>/` | 隔离模块管理的检出目录，供任务执行与验收 |
| `$CODEX_FLOW_HOME/panel-<session>.json` | mod 写入可见性和诊断快照，状态行读取可见性 |

保留期、触发清理的时机和长期摘要字段见 [运行记录说明](flow-plan.md#长期运行摘要)。
实现入口是 `state.mjs` 的 `keepDaysOf`、`pruneOldRuns` 和 `history.mjs` 的 `ensureHistory`：
删除记录前确认本轮已有历史摘要，写历史失败时保留运行目录。
隔离目录与成果分支的清理另由 `archive.mjs` 执行。

## flow 生命周期

### 计划与状态

`codex-flow.mjs` 解析命令后进入 `runner.mjs` 的 `runFlow`。它依次调用 `prepareFlow`、`createFlowState`、`populateFlowTasks`，再进入调度。

`prepareFlow` 通过 [plan.mjs](../flow/lib/plan.mjs) 的 `loadPlan` 读取资料，
通过 `validatePlan` 检查字段、模型、名称冲突、隔离前提和依赖图。
随后创建运行子目录，清空旧控制文件，保存计划，并删除上轮汇总。
资料引用和任务结果引用分两次处理；路径规则与引用语法见 [flow 参考](flow-plan.md#字段与行为)。

新状态包含会话标识、执行器 PID、阶段和任务列表。续跑的复用判断在调度前完成；`runtime.mjs` 的 `save` 将当前状态交给统一写入函数。

### 调度与说明

`scheduleTasks` 等待前置任务全部进入终态，再判断能否启动当前任务。
存在前置任务而且没有任何一个完成时，当前任务记为跳过；并非要求所有前置任务成功。

[leases.mjs](../flow/lib/leases.mjs) 管理同一 flow 的写入租约。
调度器同时检查租约冲突、停止文件和隔离容量；任务结束后释放租约，再推进下一轮调度。
只重跑验收的任务也走这个入口，因此仍参与排队。

新任务通过 `promptFor` 调用 `renderPrompt` 和 `withContract`，补入上游结果及约束。
[meter.mjs](../flow/lib/meter.mjs) 在这里登记说明组成；具体计量口径见 [README](../README.md)。

### Codex 调用

[task.mjs](../flow/lib/task.mjs) 的 `runTask` 先调用 `prepareTask` 登记开始时间、日志和说明，
按需记录工作区快照、创建隔离目录，再调用 `startTurn`。

`AppServer.start` 启动进程并完成初始化，随后依次发送 `thread/start`、`turn/start`。
通知处理器收集最后一条 agent 回复、文件修改记录、token 用量和任务过程。
`activity.mjs` 把过程转换为最近几步与累计数；控制轮询负责落盘变化、停止和追加指示。

收到本轮结束通知后，任务清除轮询，尝试归档会话，等待 app-server 关闭，再进入 `finishTurn`。
会话归档由 [threads.mjs](../flow/lib/threads.mjs) 管理，与运行目录清理是两回事。

### 结果与验收

正常完成的 Codex 回复先由 `writeTaskResult` 保存。设置 schema 且回复能解析为 JSON 时写 `.json`，否则原样写 `.md`。

普通任务随后通过 [scope.mjs](../flow/lib/scope.mjs) 核对写入，再进入 [checks.mjs](../flow/lib/checks.mjs)。
核对发生在验收前，避免把验收生成的文件算作 Codex 写入。
失败或被中断的 Codex 任务也会核对已发生的写入；范围诊断不会直接改变完成状态。

隔离任务先经 `judgeResult` 记录成果、核对范围，在隔离目录验收，最后经 `closeWorktree` 收尾。
保存分支和目录的具体规则见 [隔离说明](isolation.md)。

`checkTask` 设置验收标记，`runChecks` 依次执行命令，首个失败即停止。
`settleChecks` 根据结果设定任务终态；验收失败保留 Codex 回复，供以后只重跑验收。
超时及进程组终止规则见 [flow 参考](flow-plan.md#字段与行为)。

### 汇总与历史

每个任务返回后，`afterTask` 释放租约、计量回复，并调用 `collisions.mjs` 登记并发写入碰撞。
所有任务进入终态后，执行器补归档会话，计算总状态和工作区内容快照。

[summary.mjs](../flow/lib/summary.mjs) 生成汇总，执行器保存汇总和状态、输出汇总，
再调用 [history.mjs](../flow/lib/history.mjs) 的 `appendHistory`，最后尝试清理过期记录。
全部完成退出码为 0，其他正常收尾的状态退出码为 1。

### 单发流程

`run.sh` 先校验参数和模型配置，创建目录、写入任务说明，通过 `_single-start` 登记。
后台 `_single-watch` 由 [tokens.mjs](../flow/lib/tokens.mjs) 跟踪事件与会话记录；
脚本随后选择新建、续接或分叉的 exec 调用，并等待退出。

结束后脚本停止监视器，通过 `_single-end` 核对本轮完成事件、结算用量、生成汇总及历史。
实际模型的核对依赖 [rollout.mjs](../flow/lib/rollout.mjs) 读取的本轮会话记录。
单发没有 flow 的依赖调度或验收列表，输出规则见 [单发输出说明](flow-plan.md#runsh-的输出)。

## 停止与续跑

### 停止路径

[commands.mjs](../flow/lib/commands.mjs) 的 `cancel` 和 mod 提供停止入口，后台任务也可由 Claude Code 停止。
单任务停止通过控制文件进入任务或验收轮询；整个 flow 则由信号触发 `onStop`。
单发先写停止标记并终止脚本的子进程，脚本自己的信号处理则负责登记结束。

`onStop` 的收尾顺序是：阻止后续验收并杀掉现有验收进程组，标记未结束的任务，保存快照与状态；
等待 app-server 退出，补归档会话，再保存隔离成果，最后写汇总、历史并以 143 退出。
如果停止发生在全部任务已结束后的补归档阶段，总状态仍按任务结果计算。

### 复用路径

`populateFlowTasks` 逐个判断旧回复是否存在，比较说明摘要、工作目录、依赖和隔离方式，
并递归判断前置任务能否复用；强制重跑和内容过期判断也在这里生效。
说明摘要包含 prompt、模型、effort、schema；验收和写入范围另行比较。

验收失败、上轮留下重验标记或验收命令变化时，调度器调用 `recheckTask`。
这条路径复用 Codex 回复，隔离任务按已保存成果重建验收目录。
[freshness.mjs](../flow/lib/freshness.mjs) 区分只读任务重跑与写入任务的过期提示；具体判断范围见 [续跑规则](flow-plan.md#字段与行为)。

`busy` 防止续跑或清理与尚未结束的收尾过程重叠；`watch` 只接收本轮汇总。
旧隔离目录、旧成果和未归档会话由 `carryLeftovers` 保留在状态中，不因任务被替换而丢掉。
成果取回与清理方法见 [隔离说明](isolation.md)。

## 面板状态流

`register.tsx` 在会话开始时立即刷新，并每 2 秒调用一次读取流程；并发刷新复用同一个进行中的读取。
[state-reader.ts](../mod/hooks/state-reader.ts) 读取运行状态，校验字段、按会话筛选，读取失败时使用上次有效值。
进入详情后才按结果路径读取回复；过程直接来自状态中的最近记录，不重新扫描协议日志。

状态仍为运行中而执行器 PID 已不存在时，读取层给出失联状态。
`register.tsx` 管理提醒去重、等待主对话空闲，以及界面计时提醒；判定和通知规则见 [面板参考](panel.md#提醒与调试)。

[render-flow.tsx](../mod/hooks/render-flow.tsx) 分派渲染，终端使用两栏，桌面使用竖排。
导航和窗口状态由 `navigation.ts`、`panel-actions.ts` 管理，详情渲染与桌面布局分别拆在独立模块中。
按键、版面差别与空间不足时的行为见 [面板参考](panel.md)。

mod 另外写入面板可见性记录，状态行据此决定是否输出，避免重复呈现同一进度。
状态行独立读取运行记录；它不参与调度、验收或任务控制。

## 关键取舍

- **按文件分工，隔离按需启用**：租约处理声明的写入冲突，隔离成果留待审阅；依据与成本见 [并行写入策略](../README.md) 和 [拆分判据](splitting.md)。
- **状态原子替换**：`writeText` 先写同目录临时文件再改名，避免读者看到半截状态或汇总。
- **模型配置集中读取**：两个执行入口共用校验函数；配置只在执行校验时读取，查看状态不依赖配置可用。
- **过程记录保留必要信息**：app-server 初始化时关闭逐字增量通知，源码说明其目的在于避免日志膨胀。
- **长期摘要与正文分开**：历史模块只保留复盘所需元数据与计量，不长期复制说明、回复正文和文件清单。

## 测试

[执行器测试](../flow/tests/) 使用模拟 Codex、临时运行目录和临时 Git 仓库，
覆盖计划展开、依赖与租约、写入诊断、验收、停止续跑、隔离成果、历史及单发报告。
[面板测试](../mod/tests/flow.test.ts) 使用宿主测试接口模拟文件、进程和时钟，覆盖读取容错、提醒、导航、控制与两种版面。

按 [项目规则](../AGENTS.md)，从仓库根目录运行：

```bash
node --test flow/tests/
claude plugin validate mod
claude plugin test mod
```

执行器测试不调用真实 Codex。修改单发脚本时，项目规则另外要求一次最小真实任务核对输出；
它用于确认模拟测试无法证明的实际调用行为。
