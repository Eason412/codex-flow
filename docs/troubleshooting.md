# 排障

中文 | [English](troubleshooting.en.md)

供使用者和协助排查的 Claude 按现象查找。以下命令在仓库根目录运行，尖括号中的内容需替换；运行目录以启动输出或汇总给出的路径为准。

## 面板没有出现

先输入 `/flow`；若命令不可用，按 [SETUP.md](../SETUP.md#4-load-the-mod) 检查 mod 加载配置，并重新打开 Claude Code 会话。若面板显示「本会话还没有派出 Codex 任务。」，检查任务是否在另一个会话启动：面板按会话筛选，具体规则见[面板说明](panel.md#打开与收起)，已知运行可用下面的命令查看。

```bash
node flow/codex-flow.mjs status <runId>
```

## 面板只剩一行或想收起

看到「▸ plugin panel hidden」时，点击该行或按 `ctrl+x ctrl+a` 展开；空间不足造成的一行摘要，按[终端版面说明](panel.md#终端版面)恢复。想主动收起时，终端先用 `ctrl+x tab` 把焦点移到面板再按 `q`，桌面直接点面板底部的「收起」；需要时输入 `/flow` 重新打开，任务会继续运行。

## 更新后面板还是旧样子

桌面会话只在开始时加载一次 mod，之后仓库里的改动不会自动生效，例如看不到新加的按钮。重开会话即可；想让桌面会话也像终端那样保存即更新，按[面板说明](panel.md#打开与收起)加上 `CLAUDE_CODE_PLUGIN_DIR_WATCH`。

## 实际模型不符或无法核实

汇总中的「⚠ 实际模型」表示返回的模型与请求不同；`run.sh` 结尾的「找不到 Codex 会话记录，无法核实实际模型和 effort」或「这次没有开始新一轮，无法核实实际模型和 effort」表示缺少本次核实所需的记录。让 Claude 读取该运行的日志与 `state.json`，核对请求值和 `actualModel`、`actualEffort`，向用户报告差异或未核实项；不要用请求参数代替实际值。仅 Fast 显示「新开的 exec 会话记录不写 tier，无法核实」时，按[单发输出说明](flow-plan.md#runsh-的输出)解读，不要把它当成模型核实失败。

## 模型或 effort 被拒绝

「不在允许范围:」来自启动前的名单检查，允许值以 [models.json](../models.json) 为准。将调用或计划改为名单内的值；确需调整名单时按[模型设置步骤](../SETUP.md#3-choose-the-allowed-models)操作，再运行下面的检查，退出码为 0 表示通过本地名单校验。

```bash
node flow/codex-flow.mjs _check --model <model> --effort <effort>
```

## 验收未通过

「验收未通过：」后面给出失败命令及退出码或超时原因，先读运行目录中的 `logs/<任务>.checks.log`；复用条件满足时，续跑只重跑验收，不再次调用 Codex，条件见[计划与续跑说明](flow-plan.md#字段与行为)。需要 Codex 补做时，从 `state.json` 取该任务的 `threadId`，用下面第二条命令续接，并将工作目录设为需要修改的目录；隔离成果的处理见[隔离说明](isolation.md)。需要修改任务说明后重做时，修改计划并使用第三条命令。

```bash
node flow/codex-flow.mjs run --resume <runId>
./run.sh -m <model> -e <effort> -C <cwd> -r <threadId> "<follow-up>"
node flow/codex-flow.mjs run <plan.json> --resume <runId> --rerun <label>
```

## 收到执行器退出提醒

「执行器进程已退出但状态仍是 running。」表示进程已消失，而状态记录尚未结束；提醒会附运行目录和当时仍在运行的任务日志。Claude 应先读这些日志和 `state.json`，检查已有改动并向用户汇报，不自动重跑；确定继续后，flow 使用上一节的续跑命令，单发使用 `-r` 续接。提醒的判定见[提醒与调试](panel.md#提醒与调试)，仅耗时长或日志暂未更新不足以判定失联。

## 续跑或清理提示还在运行

「还在运行」也可能出现在任务已经结束、执行器仍在收尾时，不应通过修改 `state.json` 绕过检查。运行下面的命令等待本轮汇总或进程退出后，再重试原来的续跑或清理操作；停止与收尾规则见[计划说明](flow-plan.md#字段与行为)。

```bash
node flow/codex-flow.mjs watch <runId>
```

## 任务一直排队

任务可能在等前置任务、等待重叠写入范围释放，或等待隔离 worktree 名额；查看 `state.json` 中该任务的 `needs` 和 `waiting`，后者会列出阻挡任务名或「worktree 上限」。先检查对应任务是否仍在执行；若是范围声明过宽，核对实际写集后修改计划再续跑，不要删掉真实的重叠声明来强行并行。范围判定见[调度说明](flow-plan.md#字段与行为)，隔离上限见[隔离说明](isolation.md)。

## 下游任务被跳过

「前置任务都没有完成」表示所有前置任务都已结束，但没有一个状态为完成。先处理上游失败或停止的原因，再续跑；同时按[依赖规则](flow-plan.md#字段与行为)核对计划中的 `after` 和结果引用，避免依赖了错误的任务。

## 出现写入范围或同文件修改提示

「⚠ 越界写入：」与「工作区另有 … 处来源未定的变动」的归属依据不同，先按[写入核对说明](flow-plan.md#字段与行为)区分，再读 `state.json` 中的 `scope.outside`、`scope.unclaimed` 并检查对应目录的 `git diff`，不要把来源未定的改动直接归给该任务。看到「同时改了：」时，检查 `collisions` 和相关文件的最终内容，判断先结束的任务是否需要重新验收或重做，并把确认的越界与碰撞告知用户。

## 追加指示被拒绝或未送达

「单发运行不支持 steer，请用 run.sh -r <threadId> 续接」、运行「已经不在运行」或任务「不在运行」都表示当前没有可接收这条指示的运行中任务。若已显示「已发给」但过程里又出现「插话没有送达」，按[插话规则](flow-plan.md#字段与行为)检查是否恰好结束了 Codex 本轮；结束后的补做使用上文的 `-r` 命令，不重复发送 `steer`。

## 续跑提示旧 worktree 被保留

「上次的 worktree 保留在」表示执行器发现旧目录，保留它并为新一轮使用其他目录，旧目录中可能有尚未存成分支的改动。先在提示的目录运行 `git status --short` 和 `git diff`，检查未跟踪文件并取回需要的成果，再按[残留目录处理说明](isolation.md)清理；记录位置是 `state.json` 的 `leftovers.worktrees`，不要在查看前直接运行 `clean`。

## 任务完成但主工作区没有改动

若汇总写着「成果在分支」和「没有合进主工作区」，成果保存在隔离分支中。复制汇总的「查看」命令审阅，确认后执行「合进主工作区」命令，冲突处理及合并方式见[隔离成果说明](isolation.md)；成果已取回或决定不要后，再运行下面的清理命令。

```bash
node flow/codex-flow.mjs clean <runId>
```

## 找不到旧运行记录

「找不到运行记录:」表示当前运行记录位置读不到该 runId 的状态，先核对 ID 和 [README 中的运行记录位置设置](../README.md#个人设置)，再查看原汇总注明的删除日期。到期删除时机与 `history.jsonl` 保留内容见[长期运行摘要](flow-plan.md#长期运行摘要)：它不能恢复任务说明、完整回复或已删除的成果；需要留存这些内容，应在清理前另行保存。
