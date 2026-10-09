# Architecture

[中文](architecture.md) | English

This guide is for developers reading the code, investigating a run, or contributing changes. Start with the state, results, and logs in the run directory, then use the entry points below to find the responsible module.
See the [README](../README.en.md) for setup and everyday use, and the [flow reference](flow-plan.md) (Chinese) for plan fields.

## Components

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

| Component | Role | Entry point |
| --- | --- | --- |
| Single-task script | Parses arguments, starts one invocation, registers and finalizes it | [run.sh](../run.sh) |
| codex-flow runner | Dispatches commands, validates plans, schedules tasks | [codex-flow.mjs](../flow/codex-flow.mjs), [runner.mjs](../flow/lib/runner.mjs) |
| Codex processes | Flows control sessions through app-server; single tasks receive exec events | [appserver.mjs](../flow/lib/appserver.mjs), [single.mjs](../flow/lib/single.mjs) |
| Run directory | Supplies persistent state to commands, resumed runs, and the UI | [state.mjs](../flow/lib/state.mjs) |
| mod panel | Reads state, displays tasks, and submits control requests | [register.tsx](../mod/hooks/register.tsx) |
| Status line | Reads the session ID from standard input and prints one line of progress | [statusline.mjs](../flow/statusline.mjs) |
| Model configuration | Defines allowed models, effort levels, and Fast settings | [models.json](../models.json) |
| Output formats | Supplies JSON Schemas for structured replies | [schemas/](../schemas/) |

The runner and panel exchange state and control requests through files. The panel does not own a Codex connection. Each task owns its connection; the transport handles request IDs, responses, notifications, and process exits.
Incoming interactive requests from the server are rejected and recorded in the task log so background tasks do not wait indefinitely for interaction.

## Run directories

Paths in the following table are relative to `$CODEX_FLOW_HOME/runs/<runId>/`.
Root configuration and its default location are documented under [personal settings](../README.en.md#personal-settings).
Flow run IDs start with `r-`, and single-task IDs with `s-`. They share a state format but use different file layouts.

| Path | Contents | Writer → reader |
| --- | --- | --- |
| `state.json` | Run, phase, and task status; PID, timestamps, result paths, metrics, and diagnostics | Runner or single-task registration/watcher → mod, status line, CLI, resume logic |
| `plan.json` | Flow plan after material expansion and validation | `prepareFlow` → resume logic |
| `summary.txt` | Summary for the completed round | Flow or single-task finalization → main conversation, `watch` |
| `results/<task>.md` / `results/<task>.json` | Final reply from a flow task | `writeTaskResult` → downstream tasks, summary, mod, resume logic |
| `logs/<task>.prompt.txt` | The prompt actually sent | `prepareTask` → developers investigating the run |
| `logs/<task>.jsonl` | Selected protocol notifications and control records | `task.mjs` → developers investigating the run |
| `logs/<task>.checks.log` | Acceptance commands and their output | `checks.mjs` → developers investigating the run |
| `control/<task>.stop` | Request to stop one flow task | CLI or mod → scheduler, task, check runner |
| `control/<task>.steer.<timestamp>.txt` | Additional instructions | CLI or mod → task control polling |
| `task.txt` | Single-task prompt | `run.sh` → initial or fallback registration |
| `events.jsonl` | Codex JSON events for a single task | `run.sh` redirection → watcher and finalization |
| `last.md` | Single-task final reply, which may contain JSON | Codex → single-task finalization, mod |
| `stderr.log` / `unarchive.log` | Single-task errors; output from unarchiving before resume or fork | `run.sh` redirection → final report, developers |
| `control/stop` | Single-task stop marker | CLI or mod → single-task finalization |

`<task>` is the task label transformed by `fileSafe` in `runtime.mjs`. Plan validation rejects names that would collide in result, log, or stop files.
Steering files are renamed to `.sent` when picked up; unconsumed files left after the task ends become `.unsent`.
The `.sent` suffix means the file was consumed. Check the activity record to confirm delivery.

Three kinds of data live outside individual run directories:

| Location | Contents and ownership |
| --- | --- |
| `$CODEX_FLOW_HOME/history.jsonl` | `history.mjs` appends run summaries and verdicts for review and backfill deduplication |
| `$CODEX_FLOW_HOME/worktrees/<runId>/` | Checkouts managed by the isolation modules for execution and acceptance checks |
| `$CODEX_FLOW_HOME/panel-<session>.json` | mod writes visibility and diagnostic snapshots; the status line reads visibility |

See [long-term run summaries](flow-plan.md#长期运行摘要) (Chinese) for retention, cleanup timing, and history fields.
The implementation uses `keepDaysOf` and `pruneOldRuns` in `state.mjs`, plus `ensureHistory` in `history.mjs`:
before deleting a run, it ensures the current round has a history entry. A failed history write preserves the directory.
Cleanup of isolated checkouts and result branches is handled separately by `archive.mjs`.

## Flow lifecycle

### Plan and state

After parsing the command, `codex-flow.mjs` enters `runFlow` in `runner.mjs`. It calls `prepareFlow`, `createFlowState`, and `populateFlowTasks` in order, then starts scheduling.

`prepareFlow` uses `loadPlan` in [plan.mjs](../flow/lib/plan.mjs) to read source material,
and `validatePlan` to check fields, models, name collisions, isolation prerequisites, and the dependency graph.
It then creates run subdirectories, clears old control files, saves the plan, and removes the previous summary.
Material references and task-result references are resolved in separate steps; see the [flow reference](flow-plan.md#字段与行为) (Chinese) for paths and syntax.

The new state includes the session ID, runner PID, phases, and tasks. Reuse decisions are made before scheduling. The `save` function in `runtime.mjs` sends the current state to the shared writer.

### Scheduling and prompts

`scheduleTasks` waits for every prerequisite to reach a terminal state before considering a task for execution.
If there are prerequisites and none completed successfully, it skips the task; it does not require every prerequisite to succeed.

[leases.mjs](../flow/lib/leases.mjs) manages write leases within one flow.
The scheduler checks conflicting leases, stop files, and isolation capacity. Task completion releases the lease and advances scheduling.
Tasks that only rerun acceptance checks use this same entry point and still participate in the queue.

For new tasks, `promptFor` calls `renderPrompt` and `withContract` to add upstream results and constraints.
[meter.mjs](../flow/lib/meter.mjs) records prompt composition here; the measurement definitions are in the [README](../README.en.md).

### Codex invocation

`runTask` in [task.mjs](../flow/lib/task.mjs) first calls `prepareTask` to register the start time, log, and prompt.
It captures the workspace and creates an isolated checkout as needed, then calls `startTurn`.

`AppServer.start` launches and initializes the process, followed by `thread/start` and `turn/start` requests.
The notification handler collects the last agent reply, file-change records, token usage, and activity.
`activity.mjs` converts activity into recent steps and counters; control polling persists changes and handles stops and steering.

Once the turn ends, the task clears polling, attempts session archival, waits for app-server to close, and enters `finishTurn`.
Session archival is managed by [threads.mjs](../flow/lib/threads.mjs) and is separate from run-directory cleanup.

### Results and checks

When Codex completes normally, `writeTaskResult` saves its reply first. With a schema configured, a reply that parses as JSON is saved as `.json`; otherwise it is preserved as `.md`.

A regular task then checks its writes through [scope.mjs](../flow/lib/scope.mjs) before entering [checks.mjs](../flow/lib/checks.mjs).
Scope checking comes first so files generated by acceptance commands are not attributed to Codex.
Failed and interrupted Codex tasks also have their writes checked. Scope diagnostics do not directly determine completion status.

For isolated tasks, `judgeResult` records the output and checks scope, acceptance runs in the checkout, and `closeWorktree` finalizes it.
See [isolation](isolation.md) (Chinese) for branch and directory preservation rules.

`checkTask` sets the checking flag, and `runChecks` executes commands in order, stopping at the first failure.
`settleChecks` sets the terminal task status. A failed check preserves the Codex reply for a later check-only rerun.
Timeout and process-group termination rules are in the [flow reference](flow-plan.md#字段与行为) (Chinese).

### Summary and history

After each task returns, `afterTask` releases its lease, measures the reply, and calls `collisions.mjs` to record concurrent write collisions.
Once all tasks reach terminal states, the runner retries session archival and computes the overall status and workspace content snapshot.

[summary.mjs](../flow/lib/summary.mjs) renders the summary. The runner saves the summary and state, prints the summary,
calls `appendHistory` in [history.mjs](../flow/lib/history.mjs), and attempts cleanup of expired records.
The exit code is 0 when all tasks complete, or 1 for other statuses reached through normal finalization.

### Single-task lifecycle

`run.sh` validates arguments and model configuration, creates a directory, writes the prompt, and registers through `_single-start`.
The background `_single-watch` uses [tokens.mjs](../flow/lib/tokens.mjs) to follow events and session records.
The script then selects a new, resumed, or forked exec invocation and waits for it to exit.

It stops the watcher and calls `_single-end` to verify the completion event, settle usage, and write the summary and history.
Actual model verification uses records for the current invocation read by [rollout.mjs](../flow/lib/rollout.mjs).
Single tasks have no flow dependency scheduler or acceptance-command list; see [single-task output](flow-plan.md#runsh-的输出) (Chinese) for reporting rules.

## Stopping and resuming

### Stop paths

The `cancel` command in [commands.mjs](../flow/lib/commands.mjs) and mod provide stop controls; Claude Code can also stop the background task.
A task-level stop reaches task or check polling through a control file. A whole-flow stop triggers `onStop` through a signal.
For a single task, cancellation writes a stop marker and terminates the script's children; the script's own signal handler also records termination.

`onStop` prevents further checks, kills existing check process groups, marks unfinished tasks, and saves the workspace snapshot and state.
It then waits for app-server processes to exit, retries archival, preserves isolated output, writes the summary and history, and exits with 143.
If the signal arrives during archival after all tasks have ended, the overall status still reflects their results.

### Reuse paths

`populateFlowTasks` checks that an old reply exists and compares the prompt hash, working directory, dependencies, and isolation mode.
It recursively checks whether prerequisites can be reused and applies forced-rerun and content-freshness decisions.
The hash includes the prompt, model, effort, and schema; acceptance commands and write scope are compared separately.

If checks failed, an earlier round left a recheck marker, or acceptance commands changed, the scheduler calls `recheckTask`.
This path reuses the Codex reply and rebuilds an isolated check directory from saved output when needed.
[freshness.mjs](../flow/lib/freshness.mjs) distinguishes automatic read-only reruns from stale-result warnings for writing tasks; see [resume rules](flow-plan.md#字段与行为) (Chinese) for the scope of comparison.

`busy` prevents resume or cleanup from overlapping finalization; `watch` only accepts the current round's summary.
`carryLeftovers` preserves old checkouts, results, and unarchived sessions in state when tasks are replaced.
See [isolation](isolation.md) (Chinese) for recovering and cleaning up output.

## Panel state flow

`register.tsx` refreshes immediately when a session starts and every 2 seconds thereafter. Concurrent refreshes share an in-flight read.
[state-reader.ts](../mod/hooks/state-reader.ts) reads run states, validates fields, filters by session, and falls back to the last valid state on read errors.
Replies are loaded by result path when opening details. Activity comes directly from recent state records, without rescanning protocol logs.

When state still says running but the runner PID no longer exists, the reader reports the run as lost.
`register.tsx` manages reminder deduplication, waits for the main conversation to become idle, and issues elapsed-time notifications; see [panel diagnostics](panel.md#提醒与调试) (Chinese) for the rules.

[render-flow.tsx](../mod/hooks/render-flow.tsx) dispatches rendering to the terminal's two-column layout or the desktop's vertical layout.
`navigation.ts` and `panel-actions.ts` manage navigation and windows; task details and the desktop layout have separate rendering modules.
See the [panel reference](panel.md) (Chinese) for keys, layout differences, and behavior when space is limited.

mod also writes a visibility record that lets the status line suppress duplicate progress.
The status line reads run records independently and takes no part in scheduling, checks, or task control.

## Design choices

- **File ownership with optional isolation**: leases handle declared write conflicts, while isolated output is kept for review. Rationale and costs are in [concurrent writes](../README.en.md) and [task decomposition](splitting.md) (Chinese).
- **Atomic state replacement**: `writeText` writes a temporary file in the same directory and renames it, so readers do not see partial states or summaries.
- **Shared model configuration**: both execution entry points use the same validator. Configuration is read when validating execution, so viewing state does not depend on it being available.
- **Selective activity recording**: app-server initialization disables token-by-token delta notifications; the source comment identifies log size as the reason.
- **History separate from content**: the history module retains metadata and measurements for later review, without keeping copies of prompts, reply bodies, or file lists.

## Tests

[Runner tests](../flow/tests/) use simulated Codex processes, temporary run directories, and temporary Git repositories.
They cover plan expansion, dependencies and leases, write diagnostics, checks, stop/resume behavior, isolated output, history, and single-task reports.
[Panel tests](../mod/tests/flow.test.ts) mock files, processes, and clocks through the host testing interface, covering read failures, reminders, navigation, controls, and both layouts.

Run these commands from the repository root, as required by the [project rules](../AGENTS.md) (Chinese):

```bash
node --test flow/tests/
claude plugin validate mod
claude plugin test mod
```

Runner tests do not call real Codex. For changes to the single-task script, the project rules additionally require one minimal real invocation to verify its output.
That check confirms actual invocation behavior that simulations cannot establish.
