# codex-flow 项目规则

本仓库是 `codex` Skill：`run.sh` 单任务调用 Codex CLI，`flow/` 是多任务分阶段并行的执行器，`mod/` 是 Claude Code 里的进度面板插件。任务按 [SKILL.md](SKILL.md) 执行，运行行为以源码和测试为准。

## 安装与生效

整个仓库软链为 `~/.claude/skills/codex`，改动保存后立即作用于本机所有正在使用该 Skill 的会话。会改变 run.sh 参数、flow 状态文件或面板读取格式的修改，要先确认没有正在运行的 flow 依赖旧格式，再完成前后两端的同步。

允许的模型、effort 和 Fast 名单只在 `models.json` 维护，run.sh 与执行器都从这里读取，不在别处另写名单。

## 修改与验证

| 改动 | 检查 |
| --- | --- |
| `flow/` 执行器 | `node --test flow/tests/`（使用模拟 Codex 与临时目录，不调用真实 Codex） |
| `mod/` 面板 | `claude plugin validate mod` 与 `claude plugin test mod` |
| `run.sh` | 用一个最小真实任务核对输出首行的日志目录和结尾的「实际使用」行 |
| `SKILL.md`、README | 检查内容与差异；中英文 README 同步，链接用 project-docs 的 `check_readme.py` 检查 |

真实 Codex 调用会消耗额度，只在模拟测试覆盖不到的行为上做。

## 提交与发布

验证通过后提交并推送 `main`。版本 tag 沿用 `V0.x.0` 格式，只在用户要求发布时打 tag 和发 Release。
