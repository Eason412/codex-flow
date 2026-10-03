# Codex Flow

[中文](README.md) | English

**Dispatch, watch and stop Codex tasks from Claude Code, the way you use Workflows.** Claude hands well-scoped subtasks to the Codex CLI: one task through `run.sh`, several through `codex-flow`, which runs them in parallel phases. Progress shows in a task panel above the prompt, while stopping, completion notices and resuming use Claude Code's native background tasks.

![The flow panel above the prompt: phases on the left, agents on the right](docs/images/panel-flow.png)

- **Codex CLI**: OpenAI's command-line coding agent, which runs the tasks Claude dispatches.
- **Mod**: a Claude Code plugin made of hook functions that can draw panels and register commands. The task panel in this project is a mod.

Current version: [V0.2.0](https://github.com/Eason412/codex-flow/releases/tag/V0.2.0) ([all versions and release notes](https://github.com/Eason412/codex-flow/releases)). The app-server client follows the protocol usage of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).

> ⚠️ **Requires macOS or Linux with a signed-in Codex CLI, Node.js, and a Claude Code build with mod support.** Codex runs with full access (no sandbox, no approvals) and edits files and runs commands directly.

## ✨ Features

- 🧭 **Parallel phases and pipelines**: Tasks within a phase run in parallel and phases run in order by default; a task with `after` starts as soon as its prerequisites finish, without waiting for slower tasks in the same phase.
- 📺 **Live panel above the prompt**: The panel appears as soon as a task starts, laid out like Claude's Workflow detail view with phases on the left and agents on the right; an agent opens to show its progress and result and takes extra instructions directly.
- 🔢 **Live token usage**: Counted the way Claude Code's "↓ N tokens" is, as the current context plus this run's output rather than the sum of every call's input; flow tasks update after each Codex reply, and single tasks are read from the Codex session log every 2 seconds.
- ⏹️ **Native stop and completion notices**: A flow starts from a background Bash command, so pressing x in the Background list stops it, and Claude is notified when it ends; single tasks stop with x in the panel.
- 🛡️ **Write scope and acceptance checks**: A task can declare the paths it may change and the commands that accept its work; writes outside the scope are flagged, and the task completes only if every check passes.
- ♻️ **Resume with cached results**: With `--resume`, only changed tasks and the tasks that depend on them run again; the final summary gives each task a conclusion of up to three lines.
- 🔍 **Verified models**: The model and effort in each report come from Codex's own session log, with ⚠ when they differ from the request or cannot be verified.
- ⏱️ **15-minute check-ins**: Each time a task passes another 15 minutes, the mod asks Claude in the conversation to read the log and report. Tasks are never stopped automatically, and elapsed time alone never marks a task as stuck.
- 🔒 **Model allowlist**: `models.json` lists the allowed models and efforts; any other request is refused before it starts.

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
| `models.json` | Allowed models and efforts |

- **Display apart from execution**: The mod only displays and reminds; tasks keep running when it is not loaded.
- **Run records**: Stored in `$HOME/.claude/codex-flow` by default (override with `CODEX_FLOW_HOME`) and kept for 7 days.
- **Paths**: The code hardcodes no paths. The repository can live in any directory, scripts find their files relative to their own location, and relative paths in a plan resolve against the plan file and its `cwd`.

## 🖥️ Task panel

![Task list: one flow and two single agents](docs/images/panel-list.png)

- **Order**: With several tasks, each gets one row; flows stay above single agents, newer tasks come first within each group, and rows keep their place when a task ends.
- **Several tasks**: When a new task starts while you are viewing another, the panel stays where it is and the top edge of the frame says "另有 N 个任务" (N other tasks); press `b` (返回列表, back to list) to return to the list and pick another.
- **Colors**: Flows are purple and single agents blue; the frame color follows the kinds of task in the list. The flow and agent counts in the list title use the same colors, and the top-right corner shows the token total across all tasks.
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
| Check-in interval | `CODEX_FLOW_ALERT_AFTER` in the `env` block of `~/.claude/settings.json` | Seconds, default 900 |
| Run record location | `CODEX_FLOW_HOME` in the `env` block of `~/.claude/settings.json` | Default `~/.claude/codex-flow` |
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
- **Optional fields**: `"writes": ["README.md"]` limits what a task changes, and `"checks": ["<command>"]` names its acceptance commands.

| Command | Action |
| --- | --- |
| `run.sh -m <model> -e <effort> "<task>"` | Run one task; `-r` resume, `-f` fork, `-w` new worktree, `-j` reply in a schema |
| `flow/codex-flow.mjs run <plan.json>` | Run a plan by phases and task dependencies; exits when the flow ends, so start it from background Bash |
| `flow/codex-flow.mjs run --resume <runId>` | Resume, reusing finished tasks |
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
| [models.json](models.json) | Allowed models and efforts |

## 🤝 Contributing

Compatibility fixes, improvements and documentation edits are welcome. Before opening a PR:

- **Scope**: One PR solves one problem, without personal settings or unrelated formatting changes.
- **Tests**: After changing the executor, run `node --test flow/tests/`; after changing the mod, run `claude plugin validate mod` and `claude plugin test mod`. The executor tests use a fake Codex and temporary directories and never call the real Codex.
- **Privacy**: Check diffs, logs and screenshots before committing, and remove account details, personal paths and task content.
