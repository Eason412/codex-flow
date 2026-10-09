# Example Plans

[中文](README.md) | English

These four runnable plans cover three scenarios. The accompanying [starter](starter/) contains two independent Node.js modules whose initial implementations deliberately fail some tests, providing a small project for delegation and acceptance checks. In a real project, task boundaries depend on the files, calls, and tests involved; see the [splitting criteria](../docs/splitting.md) (Chinese).

| Scenario | Plans | When to use |
| --- | --- | --- |
| Independent modules | [parallel-modules.json](parallel-modules.json) | The fix is decided, and each module can be changed and checked independently |
| Investigation followed by repair | [investigate.json](investigate-then-fix/investigate.json), [fix.json](investigate-then-fix/fix.json) | Collect evidence for two independent failures before Claude decides on a fix |
| Isolated alternatives | [isolated-edits.json](isolated-edits.json) | Compare two complete implementations of one contract, both changing the same files |

For plan fields, path resolution, results, and resume commands, see the [plan reference](../docs/flow-plan.md) (Chinese). Prerequisites and the installation entry point are in the [repository README](../README.en.md).

## Demo Project

Run the following preparation commands from the codex-flow repository root. They copy the exercise files into a new temporary Git repository. Prepare a fresh project for each scenario, but keep the same project for the investigation and repair runs.

```bash
codex_flow_repo="$PWD"
codex_flow_demo=$(mktemp -d)
cp -R "$codex_flow_repo/examples/starter/." "$codex_flow_demo/"
cd "$codex_flow_demo"
git init -q
git add .
git -c user.name=Example -c user.email=example@example.invalid commit -qm 'Initial example'
```

Run the commands below from this demo project directory. The plans omit `cwd`, so the runner uses the current directory at invocation. `codex_flow_repo` points to the repository containing the plans and runner; `codex_flow_demo` points to the project being changed. Running a plan directly invokes the real, authenticated Codex. To check only that the plans run, use the mock test command below.

## Independent Modules

Name normalization and range intersection each have their own implementation and tests. Neither calls the other or needs its output, so the two tasks belong in one phase, each owning its module's code and tests. Their `writes` do not overlap, and each task's `checks` runs its existing tests. Both have a defined goal and contract and use `gpt-6.1-sol` / `high`.

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/parallel-modules.json"
```

After completion, Claude reviews the changes and acceptance results against the contracts. The task instructions are in the [name specification](prompts/fix-names.md) (Chinese) and [range specification](prompts/fix-ranges.md) (Chinese).

## Investigation and Repair

The first run has two tasks, each collecting evidence about one module's failing tests. They are independent, share one phase, and use `gpt-6.1-sol` / `high`. They declare `writes: []` for read-only work and return a `report`. This run deliberately omits `checks`: failing module tests are the input to the investigation, and reproducing a failure must not mark the investigation task as failed.

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/investigate-then-fix/investigate.json"
```

Claude reads the results, checks the failing cases against the implementation, decides whether the test contracts are correct and what needs fixing, and then prepares the second run. The accompanying [fix.json](investigate-then-fix/fix.json) illustrates a decision to keep the existing contracts and reuses the two task specifications above. If the decision differs, update the plan and instructions first. This judgment gate is not connected automatically with `after`, and repair does not continue within the same flow.

Once that decision is made, run the repair plan separately in the same demo project:

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/investigate-then-fix/fix.json"
```

The second run repairs and checks the two modules independently, using `gpt-6.1-sol` / `high` for both tasks. The splitting criteria linked above explain dependencies and judgment gates in full (Chinese).

## Isolated Alternatives

This scenario requests two complete implementations of name normalization at the same time: one stores deduplication keys in a set, the other in an array. They satisfy the same contract and do not depend on each other, but both change the same implementation and tests, so the plan sets `isolation: "worktree"`. Comparing alternatives is the specific reason for isolation here; file ownership suffices for the independent-module scenario above.

Both tasks implement defined requirements, use `gpt-6.1-sol` / `high`, and run the same tests in separate worktrees.

```bash
node "$codex_flow_repo/flow/codex-flow.mjs" run "$codex_flow_repo/examples/isolated-edits.json"
```

Candidates with changes are saved on result branches, leaving the main working tree at the exercise's starting point. Claude inspects the branch diffs listed in the summary, compares the implementations, chooses one, applies it using the summary's command for bringing changes into the main working tree, and reruns the name tests. These candidates are alternatives: apply only the selected one. See the [isolation guide](../docs/isolation.md) (Chinese) for inspection, integration, and cleanup commands.

## Mock Validation

From the codex-flow repository root, run:

```bash
node --test flow/tests/examples.test.mjs
```

The [example tests](../flow/tests/examples.test.mjs) discover the plans under the example directory and run each unchanged with fake Codex in a temporary Git repository, checking that every task completes and every acceptance command passes. Fake Codex does not implement fixes, so the tests provide implementations that satisfy the contracts for plans with acceptance checks, while retaining the starter tests. They verify the connection between the plans and runner, not the quality of real model output. Run records, Codex data, and worktrees stay in temporary directories without reading or writing the real Codex data or flow run directories.
