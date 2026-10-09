# Codex Flow

[中文](README.md) | English

**Orchestrate Codex tasks from Claude Code the way Workflows run.** Claude splits and accepts the work, and the Codex CLI carries it out: a single task runs through `run.sh`, and several tasks run in parallel phases through `codex-flow`. Progress appears in a task panel above the prompt, while stopping, completion notices and resuming use Claude Code's background task mechanism.

![The flow panel above the prompt: phases on the left, agents on the right](docs/images/panel-flow.png)

- **Codex CLI**: OpenAI's command-line coding agent, which carries out the tasks Claude dispatches.
- **Mod**: a Claude Code plugin made of hook functions that can draw panels and register commands; the task panel in this project is a mod.

Current version: [V0.4.0](https://github.com/Eason412/codex-flow/releases/tag/V0.4.0) ([all versions and release notes](https://github.com/Eason412/codex-flow/releases)). The app-server client follows the protocol usage of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).

> ⚠️ **Requirements: macOS or Linux, a signed-in Codex CLI, Node.js, and a Claude Code build with mod support.** Codex runs with full access, without sandbox or approvals, and edits files and runs commands directly.

## ✨ Features

- 🧭 **Phased orchestration and parallel execution**: Tasks within a phase run in parallel and phases run in order; a task with `after` starts as soon as its prerequisites finish, forming a pipeline. Tasks with overlapping write scopes queue automatically, and worktree isolation is available when several tasks must change the same files at once.
- 📺 **Native interface integration**: A task panel opens above the prompt when a task starts, laid out like Claude's Workflow detail view, showing progress and results and accepting extra instructions for running tasks. Stopping and completion notices match Claude Code's background tasks, run time is shown only in the panel, and Claude receives one check-in reminder if the executor process exits unexpectedly.
- 📏 **Context and usage control**: Each task's full reply is saved to a result file, and Claude reads a conclusion of up to three lines per task. Task briefs are measured by part, and the `stats` command lists each task's brief composition, token usage and reply size for comparing the cost of different splits.
- ♻️ **Acceptance checks and result reuse**: A task can declare acceptance commands and completes only when all of them pass. Resuming reruns only changed tasks and their downstream tasks; based on a snapshot of workspace contents, read-only tasks rerun when relevant files change, and reused results of writing tasks are marked stale.
- 🔍 **Model control and verification**: `models.json` defines the allowed models and efforts, refuses other requests before they start, and names the models that use Fast by default. The model and effort in each report come from Codex's own session log and are marked ⚠ when they differ from the request or cannot be verified.

## ⚙️ How it works

```text
Claude Code main conversation
 ├─ run.sh ──────────────────────► codex exec              one task
 └─ background Bash: codex-flow ─► codex app-server × N    one process per task
         │ both write run state
         ▼
 ~/.claude/codex-flow/runs/<runId>/
         │ read by
         ├─► codex-flow mod    panel above the prompt, check-ins when a run is lost
         └─► statusline.mjs    one progress line while the panel is hidden
```

| Component | Role |
| --- | --- |
| `run.sh` | Runs one Codex task, records its state and reports the actual model |
| codex-flow executor | Reads the plan, schedules by dependency, writes state, progress, results and a summary |
| codex-flow mod | Task panel, `/flow` command, stopping and steering, check-ins when a run is lost |
| `statusline.mjs` | Called by ccstatusline; shows one progress line while the panel is hidden |
| `SKILL.md` | Claude's delegation rules: when to dispatch, how to split, which model to use |
| `models.json` | Allowed models and efforts, and the models that use Fast by default |

- **Separation of display and execution**: The mod only displays and reminds, and tasks keep running when it is not loaded.
- **Task brief composition**: The brief sent to Codex has five parts: the instruction (the prompt in the plan), material (files included with `{{file:}}`), upstream results (content injected with `{{task:}}` and `{{phase:}}`), constraints (the write scope and acceptance commands the executor appends) and the schema (the reply format). Material is read into the plan at start and stays fixed during the run.
- **Result collection**: The summary gives each task one status line, a conclusion of up to three lines and the result file path; notes on failure reasons, out-of-scope writes, same-file edits, stale results and result branches appear only when they apply. When a downstream task needs only part of an upstream result, `{{path:task}}` passes just the result file path for Codex to read; when injected content exceeds 8,000 characters, the summary suggests this instead.
- **Run records**: Each run saves its plan, state, full replies, logs and summary in `~/.claude/codex-flow/runs/<runId>/` (adjustable with `CODEX_FLOW_HOME`), read by the panel, `status`, resume and `stats`. Records are kept for 7 days, or 30 days when they hold isolated result branches; cleanup needs no timer and happens at the end of the first run after that period. The run directory line in each summary states the deletion date, and `clean <runId>` removes result branches and worktrees immediately.
- **Codex thread archiving**: Each task's Codex thread is archived to `~/.codex/archived_sessions` when the task ends and stays out of Recent and Projects in the Codex desktop app, just as Claude's Workflow subagent transcripts stay out of `/resume`.
- **Path resolution**: The code contains no fixed paths, so the repository can live in any directory; relative paths in a plan resolve against the plan file and its `cwd`.

## 🧱 Parallel write strategy

Parallel writes are handled as in Claude's Workflow: the orchestrator splits tasks by file, dependent tasks run in order, and worktrees are used only when several tasks must change the same files at once. The basis is the file ownership requirement in Claude Code's agent teams documentation and a conflict study of 33,596 agent pull requests: worktrees only postpone conflicts to merge time, and conflicts drop when work is split by file, merged one at a time and checked early.

- **Write scope queueing**: A task with `writes` whose scope overlaps a running task waits until that task ends, as if `after` had been added. Tasks without `writes` run in parallel as usual, with a note at start suggesting a scope.
- **Same-file edit notes**: When two concurrently running tasks change the same file, the summary carries a line for each, and Claude decides whether to rerun the one that finished first. Detection relies on Codex's file-change records, which do not include files written by shell commands.
- **Worktree isolation (optional)**: A task with `isolation: "worktree"` runs and is checked in its own worktree, matching `isolation: 'worktree'` in Claude's Workflow. If it changes anything, the result is saved on branch `codex-flow/<runId>/<task>`, the summary gives commands to view and merge it, and Claude merges after review; nothing is kept when nothing changes. Set at the plan level it becomes the default, and a single task opts out with `false`.
- **Cost and limits of isolation**: Each isolated task takes a full checkout (about 1 second and 240 MB for an 8.5k-file repository), with at most 4 at once (`CODEX_FLOW_MAX_WORKTREES`). Tasks after an isolated task do not see its changes, so hand-offs should run in order, or in two runs with a merge in between. Ignored files stay off the result branch; the worktree directory is removed once the branch is saved, and `keepWorktree: true` keeps it.

## 🖥️ Task panel

![Task list: one flow and two single agents](docs/images/panel-list.png)

- **Levels**: The panel has three levels: task list, flow detail and agent detail. The flow detail shows phases on the left and that phase's agents on the right, finished phases included; the agent detail shows the brief, progress and result.
- **Colors and markers**: Flows are purple, single agents blue, and running items carry an animated marker; models that use Fast by default are marked with a yellow ⚡. The top border shows the name, status, token total and elapsed time, with tokens counted the same way as Claude Code's "↓ N tokens".
- **Multiple tasks**: When a new task starts while another is open, the panel keeps the current view and the top border notes "另有 N 个任务" (N other tasks); `b` returns to the list to switch.
- **One-line summary**: When a prompt draft or Claude Code's task list leaves the panel a single row, it shows one line with the current phase's progress and its agents; clearing the draft or hiding the task list with `ctrl+t` restores it.
- **Opening and closing**: The panel opens automatically when a task starts, and `/flow` opens it at any time. Press `q` at any time to hide it; tasks keep running and `/flow` reopens it; a panel that opened automatically hides 30 seconds after all tasks end.

![Agent detail: brief, progress and steer field](docs/images/panel-agent.png)

- **Steering**: A running flow task has a steer field below. Press `Enter` on the current agent to reach it, then `Enter` again to send; the executor delivers it through Codex's turn/steer within 1–2 seconds and records the outcome in the progress.
- **Steering scope**: Tasks in acceptance checks, finished tasks and single agents run by `run.sh` have no steer field, because no Codex session is left to receive instructions.

| Key | Action |
| --- | --- |
| `ctrl+x tab` or a click on the panel | Move keyboard focus to the panel |
| `↑` `↓` (`←` `→` and `Tab` do the same) | Move between items |
| `Enter` | Open a phase or an agent's detail; on the current agent, move to the steer field |
| `Enter` in the steer field | Send the instruction to that agent |
| `b` | Go back one level; in the one-line summary, return to the task list |
| `x` | Stop the selected task or the whole flow |
| `q` | Hide the panel (also while tasks run; they keep running) |
| `Esc` | Return to the prompt |
| `ctrl+x ctrl+a` | Expand the panel after Claude Code folds it |

## 🚀 Setup

Have an agent read [SETUP.md](SETUP.md) and follow its steps for installation, configuration and verification.

- **Afterwards**: Start a new Claude Code session; the mod loads when a session starts.
- **In person**: The user signs in to the Codex CLI (`codex login`).

### Personal settings

| Setting | Location | Notes |
| --- | --- | --- |
| Allowed models and efforts | `models.json` | Other models and efforts are refused |
| Models that use Fast by default | `fast` in `models.json` | Limited to models listed in `models`; omitted or empty means none |
| Duration notice interval | `CODEX_FLOW_ALERT_AFTER` in the `env` block of `~/.claude/settings.json` | Seconds, default 900; shown as an on-screen notice only, not sent to the conversation |
| Run record location | `CODEX_FLOW_HOME` in the `env` block of `~/.claude/settings.json` | Default `~/.claude/codex-flow` |
| Codex thread archiving | `CODEX_FLOW_ARCHIVE_THREADS` in the `env` block of `~/.claude/settings.json` | On by default; `0` turns it off |
| Isolated task limit | `CODEX_FLOW_MAX_WORKTREES` in the `env` block of `~/.claude/settings.json` | Default 4; further isolated tasks wait |
| Status line progress | ccstatusline custom-command | Command `node ~/.claude/skills/codex/flow/statusline.mjs`, with `preserveColors` on |

## 📖 Usage

- **Daily use**: Ask Claude in the conversation to hand work to Codex, or describe which pieces can run in parallel or in phases; Claude follows [SKILL.md](SKILL.md) (Chinese) to choose models, write a plan and start it in the background.
- **Direct use**: The commands below can also be run directly in a Claude Code session; the panel shows only the tasks dispatched from that session.

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

- **Scheduling**: "review-a" declares `after` and starts as soon as "doc-a" finishes; "summary" declares none and waits for the whole write phase.
- **Result references**: `{{task:name}}` becomes one task's result, `{{phase:title}}` the results of a whole phase, and `{{path:name}}` the result file path; every referenced task counts as a prerequisite.
- **Paths**: `promptFile` and `{{file:}}` are relative to the plan file's directory, and a task's `cwd` is relative to the plan's `cwd`.
- **Optional fields**: `"writes": ["README.md"]` limits the write scope, `"checks": ["<command>"]` names acceptance commands, `"reads"` names the files checked for changes on resume, and `"isolation": "worktree"` enables worktree isolation.

| Command | Action |
| --- | --- |
| `run.sh -m <model> -e <effort> "<task>"` | Run one task; `-r` resume, `-f` fork, `-w` new worktree, `-j` reply in a schema |
| `flow/codex-flow.mjs run <plan.json>` | Run a plan by dependency; exits when the flow ends, so start it from background Bash |
| `flow/codex-flow.mjs run --resume <runId> [--rerun <task>]` | Resume, reusing finished tasks that are not stale; `--rerun` forces a rerun and can repeat |
| `flow/codex-flow.mjs stats <runId> [--json]` | Each task's brief composition, token usage, reply size and check results |
| `flow/codex-flow.mjs clean <runId>` | Remove result branches (except ones with newer commits) and leftover worktrees |
| `flow/codex-flow.mjs status [runId]` | Show this session's runs |
| `flow/codex-flow.mjs cancel <runId> [task]` | Stop the whole flow or one task |
| `flow/codex-flow.mjs steer <runId> <task> "<text>"` | Add instructions to a running task |
| `flow/codex-flow.mjs watch <runId> [--alert-after seconds]` | Wait until the run ends and print its summary; with `--alert-after`, exit early once a task reaches that duration |
| `flow/codex-flow.mjs verdict <runId> [task] used\|partial\|unused ["reason"]` | Record after review whether the result was used, kept in `history.jsonl` with the plan's split rationale and model source for later review |
| `flow/codex-flow.mjs history --backfill` | Add runs not yet recorded to the long-term summary `history.jsonl` |

Run the `.mjs` commands with `node`; paths are relative to `~/.claude/skills/codex`. All plan fields are described in [docs/flow-plan.md](docs/flow-plan.md) (Chinese).

## 📁 Repository layout

| Path | Purpose |
| --- | --- |
| [SETUP.md](SETUP.md) | Step-by-step setup manual for agents |
| [SKILL.md](SKILL.md) | Claude's rules for delegation, model choice and investigation (Chinese) |
| [run.sh](run.sh) | Entry point for one task |
| [flow/](flow/) | codex-flow executor, status line script and tests |
| [mod/](mod/) | Task panel mod and its tests |
| [schemas/](schemas/) | Built-in `review`, `opinion`, `result` and `report` reply formats |
| [models.json](models.json) | Allowed models and efforts, and the models that use Fast by default |
| [docs/architecture.en.md](docs/architecture.en.md) | Architecture for developers: components, run directory, lifecycle, stop and resume |
| [docs/troubleshooting.en.md](docs/troubleshooting.en.md) | Troubleshooting by symptom |
| [examples/](examples/) | Runnable plan examples and a practice project |
| [LICENSE](LICENSE) | Full text of the Apache-2.0 license |

## 🤝 Contributing

Compatibility fixes, improvements and documentation edits are welcome. Before opening a PR:

- **Scope**: One PR solves one problem, without personal settings or unrelated formatting changes.
- **Tests**: After changing the executor, run `node --test flow/tests/`; after changing the mod, run `claude plugin validate mod` and `claude plugin test mod`. The executor tests use a simulated Codex and temporary directories and never call the real Codex.
- **Privacy**: Check diffs, logs and screenshots before committing, and remove account details, personal paths and task content.

## 📄 License

This project is released under the [Apache-2.0](LICENSE) license.
