# 计划示例

中文 | [English](README.en.md)

这里有三个场景、四份可运行计划。配套的 [starter](starter/) 是两个互不调用的 Node.js 模块，起始实现故意未满足全部测试，用来演示委派和验收。真实项目的任务边界仍需根据文件、调用关系和测试确定，依据见 [拆分判据](../docs/splitting.md)。

| 场景 | 计划 | 适用情况 |
| --- | --- | --- |
| 独立模块 | [parallel-modules.json](parallel-modules.json) | 修法已确定，两个模块可以各自修改和验收 |
| 定位后修复 | [investigate.json](investigate-then-fix/investigate.json)、[fix.json](investigate-then-fix/fix.json) | 先收集两个独立故障的证据，再由 Claude 定修法 |
| 隔离候选 | [isolated-edits.json](isolated-edits.json) | 同一契约需要两个完整实现供比较，两者都要改相同文件 |

计划字段、路径解析、结果和续跑命令见 [计划参考](../docs/flow-plan.md)。运行条件与安装入口见 [仓库 README](../README.md)。

## 演示项目

在 codex-flow 仓库根目录执行下面的准备命令。它把练习文件复制到一个新的临时 Git 仓库；每次尝试不同场景时重新准备，定位与修复两轮则使用同一个演示项目。

```bash
codex_flow_repo="$PWD"
codex_flow_demo=$(mktemp -d)
cp -R "$codex_flow_repo/examples/starter/." "$codex_flow_demo/"
cd "$codex_flow_demo"
git init -q
git add .
git -c user.name=Example -c user.email=example@example.invalid commit -qm 'Initial example'
```

后面的命令都在这个演示项目目录执行。计划没有设置 `cwd`，执行器使用调用时的当前目录。`codex_flow_repo` 指向计划和执行器所在的仓库，`codex_flow_demo` 指向被修改的演示项目。直接运行会调用已登录的真实 Codex；仅验证计划可运行时，使用下面的模拟测试命令。

## 独立模块

名称整理和区间计算各有实现与测试，互相不调用，各自不需要另一个任务的产出。因此两个任务放在一个阶段，分别负责本模块的代码和测试；`writes` 不重叠，各自的 `checks` 运行已有测试。目标与契约已确定，两项都使用 `gpt-6.1-sol` / `high`。

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/parallel-modules.json"
```

完成后 Claude 对照任务契约查看改动与验收结果。两个模块的任务说明分别在 [名称说明](prompts/fix-names.md) 和 [区间说明](prompts/fix-ranges.md)。

## 定位与修复

第一轮的两个任务分别核对一个模块的测试失败，只收集证据。它们互不依赖，放在一个阶段，用 `gpt-6.1-sol` / `high`；`writes: []` 表示只读，结果用 `report` 返回。此轮故意没有 `checks`：模块测试失败是要调查的输入，不能把复现失败当成定位任务失败。

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/investigate-then-fix/investigate.json"
```

Claude 读完结果，核对失败用例与实现，决定测试契约是否正确、哪些地方需要修复，再准备第二轮。配套的 [fix.json](investigate-then-fix/fix.json) 演示的是 Claude 已决定保留现有契约的情况，复用前面的两份任务说明；若决定不同，先调整计划和说明。这个判断关口没有用 `after` 自动连接，也没有在同一个 flow 里继续修复。

完成判断后，在同一个演示项目里单独运行：

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/investigate-then-fix/fix.json"
```

第二轮两个任务独立修复和验收，都用 `gpt-6.1-sol` / `high`。完整的先后与关口规则见前面的拆分判据。

## 隔离候选

这个场景要求名称模块同时产出两个完整候选：一个用集合保存去重键，一个用数组保存。两者满足相同契约，互相不依赖，但都要修改同一份实现和测试，因此计划设置 `isolation: "worktree"`。这是比较候选的特殊需求；前面的独立模块场景按文件划分即可。

两项都是按确定要求实现，使用 `gpt-6.1-sol` / `high`，在各自的 worktree 中运行相同测试。

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/isolated-edits.json"
```

有改动的候选留在成果分支，主工作区仍是练习起点。Claude 查看汇总给出的分支差异，比较两份实现后选择一个，使用汇总中的「合进主工作区」命令取回成果，再运行名称测试；此例的两个候选是替代关系，只合入选中的一个。具体查看、合并和清理方法见 [隔离说明](../docs/isolation.md)。

## 模拟验证

在 codex-flow 仓库根目录运行：

```bash
node --test flow/tests/examples.test.mjs
```

[示例测试](../flow/tests/examples.test.mjs) 自动发现示例目录中的计划，在临时 Git 仓库里用假 Codex 原样运行每份计划，核对任务完成和全部验收命令通过。假 Codex 不实现修复，测试为需要验收的计划准备满足契约的实现，保留 starter 的测试；它验证计划与执行器的连接，不验证真实模型的交付质量。运行记录、Codex 数据和 worktree 都在临时目录，不读写真实的 Codex 数据目录或 flow 运行记录目录。
