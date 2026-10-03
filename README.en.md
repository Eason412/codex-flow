# Codex Flow

[中文](README.md) | English

**Dispatch, watch and stop Codex tasks from Claude Code, the way you use Workflows.** Claude hands well-scoped subtasks to the Codex CLI: one task through `run.sh`, several through `codex-flow`, which runs them in parallel phases. Progress shows in a task panel above the prompt, while stopping, completion notices and resuming use Claude Code's native background tasks.

![The flow panel above the prompt: phases on the left, agents on the right](docs/images/panel-flow.png)

- **Codex CLI**: OpenAI's command-line coding agent, which runs the tasks Claude dispatches.
- **Mod**: a Claude Code plugin made of hook functions that can draw panels and register commands. The task panel in this project is a mod.

Current version: [V0.1.0](https://github.com/Eason412/codex-flow/releases/tag/V0.1.0). The app-server client follows the protocol usage of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0).

> ⚠️ **Requires a signed-in Codex CLI, Node.js, and a Claude Code build with mod support.** Codex runs with full access (no sandbox, no approvals) and edits files and runs commands directly.

## ✨ Features

- 🧭 **Parallel phases**: A plan file lists only phases and tasks. Tasks within a phase run in parallel, phases run in order, and a later phase quotes an earlier one's results with `{{phase:title}}`. There is no cap on the number of tasks.
- 📺 **Live panel above the prompt**: The panel appears as soon as a task starts, laid out like Claude's Workflow detail view: phases on the left, agents on the right, each row with model, effort, tokens and elapsed time. Step in to read results.
- 🔢 **Live token usage**: Flow tasks update after each Codex reply; single tasks are read from the Codex session log every 2 seconds. Resuming or forking an earlier conversation counts only the current run.
- ⏹️ **Native stop and completion notices**: A flow starts from a background Bash command, so pressing x in the Background list stops it, and Claude is notified when it ends. Single tasks stop with x in the panel, and `steer` adds instructions to a running task.
- ♻️ **Resume with cached results**: With `--resume`, finished tasks whose prompts are unchanged reuse their results; only changed tasks and the phases after them run again.
- 🔍 **Verified models**: The model and effort in each report come from Codex's own session log, with ⚠ when they differ from the request or cannot be verified.
- ⏱️ **15-minute check-ins**: Each time a task passes another 15 minutes, the mod asks Claude in the conversation to read the log and report to the user. Tasks are never stopped automatically, and elapsed time alone never marks a task as stuck.
- 🔒 **Model allowlist**: `models.json` lists the allowed models and efforts; any other request is refused before it starts.
- 📐 **Windowed long lists**: The panel shows as many rows as fit and pages through the rest with "N more" rows. It steps aside while you view a subagent's conversation.

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
| codex-flow executor | Reads the plan, runs phases, writes state, results and a summary |
| codex-flow mod | Task panel, `/flow` command, stopping single tasks, 15-minute check-ins |
| `statusline.mjs` | Called by ccstatusline; shows one progress line while the panel is hidden |
| `SKILL.md` | Tells Claude when to delegate, which model to pick and how to investigate |
| `models.json` | Allowed models and efforts |

The mod only displays and reminds; tasks keep running when it is not loaded. Run records are kept for 7 days.

## 🖥️ Task panel

With several tasks, each gets one row: flows stay above single agents, newer tasks come first within each group, and rows keep their place when a task ends. Flows are purple, single agents blue, and the frame color follows the kinds of task in the list. Running flows and phases carry a pulsing blue star, matching Claude Code's own ✻ indicator, and running agents a spinning blue dot; each phase row shows its number, status, name, completed count and elapsed time; the title line keeps the name and status on the left and aligns total tokens and total time with the columns below. Time and token columns reserve their maximum width so the layout does not shift as a run grows, and a short panel drops the frame cleanly instead of leaving stray borders.

![Task list: one flow and two single agents](docs/images/panel-list.png)

Inside an agent, the right column shows its brief and result, and the left column switches to other agents in the same phase.

![Agent detail: brief and result](docs/images/panel-agent.png)

| Key | Action |
| --- | --- |
| `ctrl+x tab` or a click on the panel | Move the keyboard to the panel |
| `↑` `↓` (`←` `→` and `Tab` do the same) | Move between items |
| `Enter` | Open a phase, view an agent's result |
| `b` | Go back one level |
| `x` | Stop the selected task or the whole flow |
| `q` | Close the panel; appears once all tasks have ended |
| `Esc` | Return to the prompt |
| `ctrl+x ctrl+a` | Expand the panel after Claude Code folds it |

While tasks run, the panel can be folded but not closed; `/flow` opens it at any time. A panel that opened automatically hides itself 30 seconds after all tasks end.

## 🚀 Setup

Have an agent read [SETUP.md](SETUP.md) and follow its steps for installation, configuration and verification. Afterwards, start a new Claude Code session; the mod loads when a session starts.

The user must do one thing in person: sign in to the Codex CLI (`codex login`).

### Personal settings

| Setting | Location | Notes |
| --- | --- | --- |
| Allowed models and efforts | `models.json` | Other models and efforts are refused |
| Check-in interval | `CODEX_FLOW_ALERT_AFTER` in the `env` block of `~/.claude/settings.json` | Seconds, default 900 |
| Run record location | `CODEX_FLOW_HOME` in the `env` block of `~/.claude/settings.json` | Default `~/.claude/codex-flow` |
| Status line progress | ccstatusline custom-command | Command `node ~/.claude/skills/codex/flow/statusline.mjs`, with `preserveColors` on |

## 📖 Usage

Day to day, ask Claude to "hand it to Codex", or describe several tasks that can run in parallel or in phases; Claude follows [SKILL.md](SKILL.md) (Chinese) to choose models, write a plan and start it in the background. The commands also work when run directly inside a Claude Code session; the panel shows only the tasks dispatched from that session.

```json
{"name": "review-api", "cwd": "/path/to/repo",
 "phases": [
   {"title": "review", "tasks": [
     {"label": "security", "model": "gpt-6.1-sol", "effort": "high", "schema": "review", "prompt": "…"},
     {"label": "performance", "model": "gpt-6.1-sol", "effort": "high", "prompt": "…"}]},
   {"title": "recheck", "tasks": [
     {"label": "summary", "model": "gpt-6-astra", "effort": "high", "prompt": "Recheck these review results:\n{{phase:review}}"}]}]}
```

| Command | Action |
| --- | --- |
| `run.sh -m <model> -e <effort> "<task>"` | Run one task; `-r` resume, `-f` fork, `-w` new worktree, `-j` reply in a schema |
| `flow/codex-flow.mjs run <plan.json>` | Run a plan in phases; exits when the flow ends, so start it from background Bash |
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
