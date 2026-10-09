# Troubleshooting

[中文](troubleshooting.md) | English

For users and Claude when investigating a problem. Run the commands below from the repository root and replace values in angle brackets; use the run directory printed at startup or in the summary.

## The panel does not appear

Enter `/flow` first; if the command is unavailable, check the mod configuration in [SETUP.md](../SETUP.md#4-load-the-mod) and start a new Claude Code session. If the panel says “本会话还没有派出 Codex 任务。”, check whether the task was started in another session: the panel filters runs by session, as described in the [panel guide (Chinese)](panel.md#打开与收起); use the command below to inspect a known run.

```bash
node flow/codex-flow.mjs status <runId>
```

## The panel is one line tall, or you want to hide it

If you see “▸ plugin panel hidden”, click that line or press `ctrl+x ctrl+a` to expand it; for a one-line summary caused by limited space, follow the [terminal layout guide (Chinese)](panel.md#终端版面). To hide the panel yourself, in a terminal focus it with `ctrl+x tab` and press `q`; on desktop click 收起 (Hide) at the bottom of the panel. Enter `/flow` to reopen it when needed, while tasks continue running.

## The panel still looks old after an update

A desktop session loads the mod once when it starts, so later changes in the repository do not take effect there, for example a newly added button is missing. Start a new session; to make desktop sessions reload on save like terminal sessions, add `CLAUDE_CODE_PLUGIN_DIR_WATCH` as described in the [panel guide (Chinese)](panel.md#打开与收起).

## The actual model differs or cannot be verified

“⚠ 实际模型” in a summary means the returned model differs from the request; “找不到 Codex 会话记录，无法核实实际模型和 effort” or “这次没有开始新一轮，无法核实实际模型和 effort” at the end of `run.sh` means the records needed to verify this invocation are missing. Have Claude read the run logs and `state.json`, compare the requested values with `actualModel` and `actualEffort`, and report differences or unverified values to the user; do not substitute the request for the actual values. If only Fast reports “新开的 exec 会话记录不写 tier，无法核实”, interpret it using the [single-task output guide (Chinese)](flow-plan.md#runsh-的输出), rather than treating it as a failure to verify the model.

## A model or effort is rejected

“不在允许范围:” comes from the allowlist check before execution; [models.json](../models.json) is the source of allowed values. Change the invocation or plan to use an allowed value; if the list needs changing, follow the [model setup steps](../SETUP.md#3-choose-the-allowed-models), then run the check below—a zero exit code means the local allowlist check passed.

```bash
node flow/codex-flow.mjs _check --model <model> --effort <effort>
```

## Acceptance checks fail

“验收未通过：” identifies the failed command and its exit code or timeout reason; first read `logs/<任务>.checks.log` in the run directory. When the reuse conditions hold, resuming reruns only the checks without calling Codex again; see the [plan and resume guide (Chinese)](flow-plan.md#字段与行为). If Codex needs to fix the work, take the task's `threadId` from `state.json` and use the second command below with the directory that needs editing; see the [isolation guide (Chinese)](isolation.md) for isolated results. To redo a task with revised instructions, edit the plan and use the third command.

```bash
node flow/codex-flow.mjs run --resume <runId>
./run.sh -m <model> -e <effort> -C <cwd> -r <threadId> "<follow-up>"
node flow/codex-flow.mjs run <plan.json> --resume <runId> --rerun <label>
```

## A notification says the executor exited

“执行器进程已退出但状态仍是 running。” means the process has disappeared while its state still records an active run; the notification includes the run directory and logs for tasks that were still running. Claude should read those logs and `state.json`, inspect existing changes, and report to the user without automatically restarting; once continuing is the chosen action, use the resume command above for a flow or `-r` for a single task. See [notifications and debugging (Chinese)](panel.md#提醒与调试) for the detection rules; elapsed time or a pause in log updates alone does not establish that the executor is lost.

## Resume or cleanup says the run is still active

“还在运行” can also appear after tasks have ended while the executor is finishing up; do not edit `state.json` to bypass the check. Run the command below to wait for this round's summary or for the process to exit, then retry the resume or cleanup operation; see the [plan guide (Chinese)](flow-plan.md#字段与行为) for stop and shutdown behavior.

```bash
node flow/codex-flow.mjs watch <runId>
```

## A task stays queued

A task may be waiting for dependencies, overlapping write scopes to become available, or an isolated worktree slot; inspect its `needs` and `waiting` in `state.json`, where the latter lists blocking task names or “worktree 上限”. Check whether those tasks are still executing; if the declared scope is too broad, verify the actual write scope before editing the plan and resuming, rather than removing a real overlap to force parallel execution. See the [scheduling rules (Chinese)](flow-plan.md#字段与行为) for scope matching and the [isolation guide (Chinese)](isolation.md) for the worktree limit.

## A downstream task is skipped

“前置任务都没有完成” means every dependency has ended but none has completed successfully. Address the upstream failure or cancellation before resuming; also check the plan's `after` and result references against the [dependency rules (Chinese)](flow-plan.md#字段与行为) to ensure they refer to the intended tasks.

## Write-scope or concurrent-edit messages appear

“⚠ 越界写入：” and “工作区另有 … 处来源未定的变动” use different evidence for attribution: distinguish them using the [write-scope guide (Chinese)](flow-plan.md#字段与行为), then inspect `scope.outside` and `scope.unclaimed` in `state.json` and run `git diff` in the relevant directory; do not attribute unclaimed changes directly to that task. For “同时改了：”, inspect `collisions` and the final file contents, decide whether the task that finished first needs new checks or a rerun, and report confirmed scope violations and collisions to the user.

## A follow-up instruction is rejected or not delivered

“单发运行不支持 steer，请用 run.sh -r <threadId> 续接”, “已经不在运行” for a run, or “不在运行” for a task means there is no active task that can receive the instruction. If “已发给” is followed by “插话没有送达” in the activity log, check whether the Codex turn had just ended using the [steering rules (Chinese)](flow-plan.md#字段与行为); use the `-r` command above for follow-up work after completion instead of repeatedly sending `steer`.

## Resume reports a preserved worktree

“上次的 worktree 保留在” means the executor found an old directory, preserved it, and used another directory for the new round; the old directory may contain changes not yet saved to a branch. Run `git status --short` and `git diff` there, inspect untracked files, and recover anything needed before following the [leftover worktree instructions (Chinese)](isolation.md); these directories are recorded in `leftovers.worktrees` in `state.json`, so do not run `clean` before inspecting them.

## A task finishes without changing the main working tree

If the summary says “成果在分支” and “没有合进主工作区”, the result is stored on an isolated branch. Copy the summary's “查看” command to review it, then run its “合进主工作区” command when ready; see the [isolated results guide (Chinese)](isolation.md) for applying changes and handling conflicts. Run the cleanup command below only after recovering the result or deciding to discard it.

```bash
node flow/codex-flow.mjs clean <runId>
```

## An old run record cannot be found

“找不到运行记录:” means the state for that run ID cannot be read from the current run storage location; check the ID and the [run storage setting in the README](../README.en.md#personal-settings), then check the deletion date in the original summary. See the [long-term summary guide (Chinese)](flow-plan.md#长期运行摘要) for expiration timing and what `history.jsonl` retains: it cannot restore task instructions, full responses, or deleted results, so save those separately before cleanup if you need them.
