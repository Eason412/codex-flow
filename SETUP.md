# Setup manual for agents

This manual is for AI coding agents (Claude Code and similar) that set up Codex Flow for a user. Follow the steps in order and check each step's success condition before moving on. People should read [README.md](README.md); delegation and troubleshooting rules for Claude live in [SKILL.md](SKILL.md).

## Ground rules

- Ask the user first before you: replace or move an existing `~/.claude/skills/codex` or `~/.claude/agents/codex-runner.md`; edit `~/.claude/settings.json`; edit the status line configuration; run a real Codex task (step 8 spends model quota).
- Signing in to Codex (`codex login`) is the user's job. Pause and ask them to do it. Never print tokens or the contents of `~/.codex/auth.json`.
- When a success condition fails, stop and report the command's output. Do not retry with other flags at random.
- The install path must be `~/.claude/skills/codex`: [SKILL.md](SKILL.md) and [agents/codex-runner.md](agents/codex-runner.md) call `~/.claude/skills/codex/run.sh` by that path.

## 1. Check prerequisites

| Check | Command | Expected |
| --- | --- | --- |
| Operating system | `uname -s` | `Darwin` or `Linux`. On native Windows, stop and tell the user: the executor and panel need POSIX process groups and `ps`, `kill`, `pkill` |
| Claude Code with mods | `claude plugin validate --help` | Usage text. An unknown-command error means this Claude Code build has no mod support |
| Codex CLI | `codex --version` | A version. If missing, ask, then install per the [Codex repository](https://github.com/openai/codex) |
| Codex sign-in | `codex login status` | `Logged in ...`. Otherwise ask the user to run `codex login` |
| Node.js | `node --version` | A version |
| Git | `git --version` | A version |

## 2. Get the code

If `~/.claude/skills/codex` already exists, stop and ask whether to back it up and replace it.

```bash
git clone https://github.com/Eason412/codex-flow.git ~/.claude/skills/codex
```

To keep the clone elsewhere, clone it there and link it: `ln -s <clone-path> ~/.claude/skills/codex`.

Success: `~/.claude/skills/codex/SKILL.md` exists and `~/.claude/skills/codex/run.sh` is executable.

## 3. Choose the allowed models

[models.json](models.json) lists the models and efforts Codex may use; anything else is refused before a task starts. Show the user the current list and ask which models and efforts to allow. Only list models their Codex account can use.

The optional `fast` list names the models whose tasks request Fast (`service_tier=priority`, about twice the speed at higher usage). Ask the user which models, if any, should use Fast by default; leave it empty when they want none.

If the allowed models differ from the ones named in the "默认分工" table of [SKILL.md](SKILL.md), update that table to match, so Claude picks from the allowed list.

Success, for each allowed model and effort:

```bash
node ~/.claude/skills/codex/flow/codex-flow.mjs _check --model <model> --effort <effort>
```

exits with code 0 and prints nothing.

## 4. Install the subagent

[agents/codex-runner.md](agents/codex-runner.md) is the Claude subagent that runs routine Codex tasks in the background. If `~/.claude/agents/codex-runner.md` exists, ask before replacing it.

```bash
mkdir -p ~/.claude/agents
ln -s ~/.claude/skills/codex/agents/codex-runner.md ~/.claude/agents/codex-runner.md
```

Success: `~/.claude/agents/codex-runner.md` resolves to the file in this repository.

## 5. Load the mod

The task panel is the mod in [mod/](mod/). Claude Code loads it from the `CLAUDE_CODE_PLUGIN_DIRS` variable in the `env` block of `~/.claude/settings.json` (project settings are not read for this variable). Ask before editing the file, then set:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/skills/codex/mod"
  }
}
```

Merge with the existing `env` block. If `CLAUDE_CODE_PLUGIN_DIRS` already has a value, append the path with the platform's path-list separator (`:` on macOS and Linux, `;` on Windows).

Success: `claude plugin validate ~/.claude/skills/codex/mod` prints `Validation passed` (a missing-author warning is fine).

## 6. Add the status line entry (optional)

When the panel is hidden, [flow/statusline.mjs](flow/statusline.mjs) prints one line of progress for the session's Codex tasks. It reads the status line JSON (`session_id`) from stdin, prints nothing when there is nothing to show, and needs colors preserved.

- With ccstatusline: ask, then add a widget to a new line in `~/.config/ccstatusline/settings.json`: `{"type": "custom-command", "commandPath": "node <absolute path to ~/.claude/skills/codex>/flow/statusline.mjs", "preserveColors": true}`. Set `"refreshInterval": 3` under `statusLine` in `~/.claude/settings.json` so the line updates while tasks run.
- With another status line command: ask, then append this script's output to it, passing the same stdin.

Success: `echo '{"session_id":"none"}' | node ~/.claude/skills/codex/flow/statusline.mjs` exits with code 0 and prints nothing.

## 7. Restart Claude Code

Ask the user to start a new Claude Code session; sessions that were already open do not load the mod.

Success: in the new session, typing `/flow` answers `已在输入框上方打开 Codex 任务面板。…`, and the panel above the prompt reads `本会话还没有派出 Codex 任务。`.

## 8. Run one real task

This spends Codex quota; ask first. In the new Claude Code session, run (use an allowed model and effort):

```bash
~/.claude/skills/codex/run.sh -m <model> -e <effort> -n 安装测试 "只回复 OK"
```

Success:

- The first line is `[codex] 运行中，日志目录: …`, and the exit code is 0.
- The output contains a `[codex] 实际使用: …` line without `⚠`.
- While it runs, the panel shows `安装测试` with a blue `agent` label.

## 9. Run the tests (optional)

```bash
cd ~/.claude/skills/codex
node --test flow/tests/
claude plugin test mod
```

Success: both report no failures. The executor tests use a fake `codex` and temporary directories; they do not call the real Codex.

## Updating

Run `git -C ~/.claude/skills/codex pull`, then start a new Claude Code session so the mod reloads. Keep the user's [models.json](models.json) changes when pulling.
