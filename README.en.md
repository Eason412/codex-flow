# Codex Flow

[中文](README.md) | English

**Dispatch, watch and stop Codex tasks from Claude Code, the way you use Workflows.** Claude hands well-scoped subtasks to the Codex CLI: one task through `run.sh`, several through `codex-flow`, which runs them in parallel phases. Progress shows in a task panel above the prompt, while stopping, completion notices and resuming use Claude Code's native background tasks.

![The flow panel above the prompt: phases on the left, agents on the right](docs/images/panel-flow.png)

- **Codex CLI**: OpenAI's command-line coding agent, which runs the tasks Claude dispatches.
- **Mod**: a Claude Code plugin made of hook functions that can draw panels and register commands. The task panel in this project is a mod.

Current version: [V0.3.0](https://github.com/Eason412/codex-flow/releases/tag/V0.3.0) ([all versions and release notes](https://github.com/Eason412/codex-flow/releases)). The app-server client follows the protocol usage of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).

> ⚠️ **Requires macOS or Linux with a signed-in Codex CLI, Node.js, and a Claude Code build with mod support.** Codex runs with full access (no sandbox, no approvals) and edits files and runs commands directly.

## ✨ Features

- 🧭 **Parallel phases and pipelines**: Tasks within a phase run in parallel and phases run in order by default; a task with `after` starts as soon as its prerequisites finish, without waiting for slower tasks in the same phase.
- 📺 **Live panel above the prompt**: The panel appears as soon as a task starts, laid out like Claude's Workflow detail view with phases on the left and agents on the right; an agent opens to show its progress and result and takes extra instructions directly.
- 🔢 **Live token usage**: Counted the way Claude Code's "↓ N tokens" is, as the current context plus this run's output rather than the sum of every call's input; flow tasks update after each Codex reply, and single tasks are read from the Codex session log every 2 seconds.
- ⏹️ **Native stop and completion notices**: A flow starts from a background Bash command, so pressing x in the Background list stops it, and Claude is notified when it ends; single tasks stop with x in the panel.
- 🛡️ **Write scope and acceptance checks**: A task can declare the paths it may change and the commands that accept its work; tasks with overlapping scopes queue automatically, both sides are flagged when two tasks actually change the same file, and a task completes only if every check passes.
- ♻️ **Resume with cached results**: With `--resume`, only changed tasks and the tasks that depend on them run again; each run records a snapshot of the workspace contents, and files changed afterwards rerun read-only tasks and mark reused results of writing tasks as stale.
- 📏 **Measured task briefs, compact results**: The brief sent to Codex is counted in five parts, and `stats` shows the cost in one command; full replies stay in files, and Claude reads a conclusion of up to three lines per task.
- 🔍 **Verified models**: The model and effort in each report come from Codex's own session log, with ⚠ when they differ from the request or cannot be verified.
- ⏱️ **15-minute check-ins**: Each time a task passes another 15 minutes, the mod asks Claude in the conversation to read the log and report. Tasks are never stopped automatically, and elapsed time alone never marks a task as stuck.
- 🔒 **Model allowlist**: `models.json` lists the allowed models and efforts; any other request is refused before it starts.
- ⚡ **Fast by model**: The `fast` list in `models.json` names the models that use Fast by default (currently only `gpt-6.1-sol`). Their tasks request `service_tier=priority`; other models never do. The panel and status line mark these models with a yellow ⚡.

## 🧱 Three design points: sending, collecting, parallel writes

codex-flow follows Claude Code's Workflow: Claude is the orchestrator and decides the subtasks after seeing the actual work, and Codex is the worker. The three points below decide whether the brief sent out is clear, whether the results brought back crowd Claude's context, and whether parallel tasks overwrite each other's files.

### Sending: a task brief in five measured parts

- **Parts**: The brief sent to Codex is assembled from five parts: the instruction (the prompt in the plan), material (files included with `{{file:}}`), upstream results (results injected with `{{task:}}` and `{{phase:}}`), constraints (the write scope and acceptance commands that the runner appends), and the schema (the required reply format).
- **Measurement**: The character count and estimated tokens of each part go into the run state, along with the size of the reply; `codex-flow.mjs stats <runId>` lists, per task, the brief's composition, the actual Codex token usage, the reply size, and the checks, followed by totals, so different splits and wordings can be compared.
- **Material versions**: Material is read into the plan at start and its digest recorded, so a task never reads what another task is writing; when a run is resumed by runId alone and a material file has changed since, the runner says the old content is still in use.

### Collecting: conclusions to Claude, full text in files

- **Summary**: Each task's full reply goes into a result file in the run directory; the summary gives Claude one status line per task, a conclusion of up to three lines, and the file path, to read only when needed.
- **References instead of content**: When a downstream task needs an upstream result, `{{path:task}}` passes only the path of the result file for Codex to read itself, instead of pasting the full text into the brief; when injected upstream results exceed 8,000 characters, the summary suggests switching to it.
- **One line per warning**: Failure reasons, out-of-scope writes, the same file changed by another task at the same time, stale reused results, and the merge outcome of isolated tasks each take one line, and appear only when they apply.

### Parallel writes: queue first, isolate only when needed

- **Basis**: Claude Code's agent teams documentation asks parallel agents to own different files and lists same-file edits as unsuited to parallel work; a study of 33,596 agent pull requests found that worktrees only postpone conflicts to merge time, and that conflicts drop when work is split by file, merged one at a time, and checked early.
- **Default: queue and detect**. A task with `writes` waits while its scope overlaps a running task; when two concurrently running tasks actually change the same file, both are flagged and the one that finished first is checked again in the main workspace. Tasks without `writes` still run in parallel, with a note at start suggesting a scope.
- **Optional: `isolation: "worktree"`**. Like `isolation: 'worktree'` in Claude's Workflow, use it only when several tasks really must change the same files at the same time; each isolated task takes the disk space of one more checkout, which depends on the repository (about 1 second and 240 MB for an 8.5k-file repository), and at most 4 exist at once (`CODEX_FLOW_MAX_WORKTREES`). Set at the plan level it becomes the default, and a task opts out with `false`.
- **Same as Claude**: The worktree is locked while the task runs, removed when nothing changed, and only worktrees created by codex-flow are ever cleaned up.
- **Different from Claude**: Claude keeps a worktree with changes for the main agent to merge; in codex-flow the next phase often uses the previous phase's changes directly, so the result merges back into the main workspace after its checks pass. The merge is all or nothing: if the task changed files outside its scope, failed its checks, hits a three-way merge conflict, or is stopped before merging, no file in the main workspace is touched. If the main workspace changed in the meantime, the checks run again there after the merge; if they fail then, the changes are already in the main workspace, are not rolled back, and the task is marked failed. A result that was not merged is kept as a private git ref and the worktree directory is removed right away; the summary prints commands to view and retrieve it. If a merge fails halfway through writing, the worktree and refs are kept for manual review. Ignored files are not snapshotted, so output written into ignored directories such as `build/` is not merged back.

## ⚙️ How it works

```text
Claude Code main conversation
 ├─ run.sh ──────────────────────► codex exec              one task
 └─ background Bash: codex-flow ─► codex app-server × N    one process per task
         │ both write run state
         ▼
 ~/.claude/codex-flow/runs/<runId>/
         │ read by
         ├─► codex-flow mod    panel above the prompt, 15-minute check-ins
         └─► statusline.mjs    one progress line while the panel is hidden
```

| Component | Role |
| --- | --- |
| `run.sh` | Runs one Codex task, records its state and reports the model actually used |
| codex-flow executor | Reads the plan, follows dependencies, writes state, progress, results and a summary |
| codex-flow mod | Task panel, `/flow` command, stopping and steering, 15-minute check-ins |
| `statusline.mjs` | Called by ccstatusline; shows one progress line while the panel is hidden |
| `SKILL.md` | Tells Claude when to delegate, which model to pick and how to investigate |
| `models.json` | Allowed models and efforts, and the models that use Fast by default |

- **Display apart from execution**: The mod only displays and reminds; tasks keep running when it is not loaded.
- **Run records**: Stored in `$HOME/.claude/codex-flow` by default (override with `CODEX_FLOW_HOME`) and kept for 7 days, or 30 days when they hold unmerged isolated results.
- **Paths**: The code hardcodes no paths. The repository can live in any directory, scripts find their files relative to their own location, and relative paths in a plan resolve against the plan file and its `cwd`.

## 🖥️ Task panel

![Task list: one flow and two single agents](docs/images/panel-list.png)

- **Order**: With several tasks, each gets one row; flows stay above single agents, newer tasks come first within each group, and rows keep their place when a task ends.
- **Several tasks**: When a new task starts while you are viewing another, the panel stays where it is and the top edge of the frame says "另有 N 个任务" (N other tasks); press `b` (返回列表, back to list) to return to the list and pick another. When another task ends, the note says it has ended (已结束); the task stays at the bottom of the list, dimmed and at most five of them, and the back key stays until the panel closes.
- **Colors**: Flows are purple and single agents blue; the frame color follows the kinds of task in the list. The flow and agent counts in the list title use the same colors, and the top-right corner shows the token total across all tasks. Models running on Fast carry a yellow ⚡.
- **Running marks**: Running flows and phases carry a pulsing blue star, matching Claude Code's own ✻; running agents carry a spinning blue dot. When several phases run at once they all pulse, and the top edge of the frame reads 「N 个阶段并行」 (N phases in parallel).
- **Frame**: The top edge carries the name, status, total tokens and total time; the bottom edge carries the key hints and buttons, so the frame costs no extra rows. When a long draft in the prompt squeezes the panel, the frame stays and the inner two-column box goes first.
- **Fixed size**: The task list, the two-column flow view and the agent details all take the same 16 rows and the full width, so moving between levels changes only the layout, as in Claude Code's Workflow panel; when fewer rows are free above the prompt, the panel uses what is available.
- **Phase column**: Each row shows number, status, name, completed count and elapsed time; time and token columns reserve their maximum width so the layout does not shift as a run grows.
- **Two-column selection**: Both columns are selectable at any time. The cursor walks the phases on the left before the agents on the right, the right column follows the phase under the cursor, and finished phases can be opened too.
- **Long lists**: The panel shows as many rows as fit and pages through the rest with "N more" rows; it steps aside while you view a subagent's conversation.
- **Little space**: When a prompt draft or Claude Code's task list leaves the panel a single content row, it shows a one-line summary instead: the current phase's progress, all of its agents, and their model and effort, with "+N" for agents that do not fit and "另有 N 个任务" (N other tasks) at the end when other tasks exist; the task list also collapses to one line that lists every task. Clearing the draft or hiding the task list with `ctrl+t` brings back the full panel.

![Agent detail: brief, progress and steer field](docs/images/panel-agent.png)

- **Agent detail**: The right column shows the brief, the progress (counts of commands, file edits and messages, plus the latest steps) and the result; the left column switches to other agents in the same phase.
- **Steering**: A running flow task has a steer field below. Press `Enter` on the current agent to reach it, type an instruction and press `Enter` again; the executor sends it to that task with Codex's turn/steer within a couple of seconds, and progress shows whether it was delivered or rejected.
- **Steering limits**: Letters typed in the field never trigger `x`, `b` or `q`. Tasks in acceptance checks, finished tasks and single agents have no steer field, because Codex has already finished during checks and single agents run under `run.sh`.

| Key | Action |
| --- | --- |
| `ctrl+x tab` or a click on the panel | Move the keyboard to the panel |
| `↑` `↓` (`←` `→` and `Tab` do the same) | Move between items |
| `Enter` | Open a phase or an agent's detail; on the current agent in a detail, move to the steer field |
| `Enter` in the steer field | Send the instruction to that agent |
| `b` | Go back one level; in the one-line summary, go straight to the task list |
| `x` | Stop the selected task or the whole flow |
| `q` | Close the panel; appears once all tasks have ended |
| `Esc` | Return to the prompt |
| `ctrl+x ctrl+a` | Expand the panel after Claude Code folds it |

- **Opening and closing**: `/flow` opens the panel at any time; while tasks run, it can be folded but not closed.
- **Auto-hide**: A panel that opened automatically hides itself 30 seconds after all tasks end.

## 🚀 Setup

Have an agent read [SETUP.md](SETUP.md) and follow its steps for installation, configuration and verification.

- **Afterwards**: Start a new Claude Code session; the mod loads when a session starts.
- **In person**: The user signs in to the Codex CLI (`codex login`).

### Personal settings

| Setting | Location | Notes |
| --- | --- | --- |
| Allowed models and efforts | `models.json` | Other models and efforts are refused |
| Models that use Fast by default | `fast` in `models.json` | Only models listed in `models`; omitted or empty means none |
| Check-in interval | `CODEX_FLOW_ALERT_AFTER` in the `env` block of `~/.claude/settings.json` | Seconds, default 900 |
| Run record location | `CODEX_FLOW_HOME` in the `env` block of `~/.claude/settings.json` | Default `~/.claude/codex-flow` |
| Concurrent isolated tasks | `CODEX_FLOW_MAX_WORKTREES` in the `env` block of `~/.claude/settings.json` | Default 4; further isolated tasks wait |
| Status line progress | ccstatusline custom-command | Command `node ~/.claude/skills/codex/flow/statusline.mjs`, with `preserveColors` on |

## 📖 Usage

- **Day to day**: Ask Claude to "hand it to Codex", or describe several tasks that can run in parallel or in phases; Claude follows [SKILL.md](SKILL.md) (Chinese) to choose models, write a plan and start it in the background.
- **Direct use**: The commands also work when run directly inside a Claude Code session; the panel shows only the tasks dispatched from that session.

```json
{"name": "docs", "cwd": "/path/to/repos",
 "phases": [
   {"title": "write", "tasks": [
     {"label": "doc-a", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-a", "promptFile": "write-a.md"},
     {"label": "doc-b", "model": "gpt-6.1-sol", "effort": "high", "cwd": "repo-b", "promptFile": "write-b.md"}]},
   {"title": "review", "tasks": [
     {"label": "review-a", "model": "gpt-6.1-sol", "effort": "high", "schema": "review", "cwd": "repo-a", "after": ["doc-a"], "prompt": "{{file:review.md}}\n{{task:doc-a}}"},
     {"label": "summary", "model": "gpt-6-astra", "effort": "high", "prompt": "Recheck:\n{{phase:write}}"}]}]}
```

- **Scheduling**: `review-a` has `after`, so it starts as soon as `doc-a` finishes; `summary` has none and waits for the whole write phase.
- **Quoting results**: `{{task:name}}` becomes one task's result and `{{phase:title}}` the results of a whole phase.
- **Paths**: `promptFile` and `{{file:}}` are relative to the plan file's directory, and a task's `cwd` is relative to the plan's `cwd`.
- **Optional fields**: `"writes": ["README.md"]` limits what a task changes, `"checks": ["<command>"]` names its acceptance commands, `"reads"` names the files to watch when resuming, and `"isolation": "worktree"` runs the task in its own worktree.
- **Path only**: `{{path:name}}` becomes the path of that task's result file, and also counts as a dependency.

| Command | Action |
| --- | --- |
| `run.sh -m <model> -e <effort> "<task>"` | Run one task; `-r` resume, `-f` fork, `-w` new worktree, `-j` reply in a schema |
| `flow/codex-flow.mjs run <plan.json>` | Run a plan by phases and task dependencies; exits when the flow ends, so start it from background Bash |
| `flow/codex-flow.mjs run --resume <runId> [--rerun <task>]` | Resume, reusing finished tasks whose results are not stale; `--rerun` forces a task to run again and can repeat |
| `flow/codex-flow.mjs stats <runId> [--json]` | Each task's brief composition, token usage, reply size, and checks |
| `flow/codex-flow.mjs clean <runId>` | Remove isolated results kept by that run (private refs and leftover worktrees) |
| `flow/codex-flow.mjs status [runId]` | Show this session's runs |
| `flow/codex-flow.mjs cancel <runId> [task]` | Stop the whole flow or one task |
| `flow/codex-flow.mjs steer <runId> <task> "<text>"` | Add instructions to a running task |
| `flow/codex-flow.mjs watch <runId>` | Print one line and exit when a task passes the check-in time or the flow ends |

Run the `.mjs` commands with `node`; paths are relative to `~/.claude/skills/codex`. All plan fields are described in [SKILL.md](SKILL.md) (Chinese).

## 📁 Repository layout

| Path | Purpose |
| --- | --- |
| [SETUP.md](SETUP.md) | Step-by-step setup manual for agents |
| [SKILL.md](SKILL.md) | Claude's rules for delegating, choosing models and investigating (Chinese) |
| [run.sh](run.sh) | Entry point for one task |
| [flow/](flow/) | codex-flow executor, status line script and tests |
| [mod/](mod/) | Task panel mod and its tests |
| [agents/codex-runner.md](agents/codex-runner.md) | Claude subagent that runs routine tasks in the background (Chinese) |
| [schemas/](schemas/) | Built-in `review`, `opinion` and `result` reply formats |
| [models.json](models.json) | Allowed models and efforts, and the models that use Fast by default |

## 🤝 Contributing

Compatibility fixes, improvements and documentation edits are welcome. Before opening a PR:

- **Scope**: One PR solves one problem, without personal settings or unrelated formatting changes.
- **Tests**: After changing the executor, run `node --test flow/tests/`; after changing the mod, run `claude plugin validate mod` and `claude plugin test mod`. The executor tests use a fake Codex and temporary directories and never call the real Codex.
- **Privacy**: Check diffs, logs and screenshots before committing, and remove account details, personal paths and task content.
