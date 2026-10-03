// 编排 flow 的准备、续跑复用、依赖调度与结束汇总，并处理整个 flow 的停止信号。
import fs from "node:fs";
import path from "node:path";
import { briefOf, isAlive, newRunId, nowIso, promptHash, pruneOldRuns, readJson, runDir, statePath, serviceTierOf, writeJson } from "./state.mjs";
import { ALERT_AFTER, checkProcs, current, die, save, servers, SESSION, setCurrent } from "./runtime.mjs";
import { literal, loadPlan, renderPrompt, validatePlan, withContract } from "./plan.mjs";
import { inScope, realPath } from "./scope.mjs";
import { killGroup, recheckTask } from "./checks.mjs";
import { runTask } from "./task.mjs";
import { cleanRunArchives, interruptedMerge, isolationFields } from "./isolation.mjs";
import { overallStatus, phaseStatus, renderSummary } from "./summary.mjs";

export function onStop(signal) {
  if (!current) process.exit(143);
  for (const child of checkProcs) killGroup(child, "SIGKILL");
  const { state } = current;
  const at = nowIso();
  for (const task of state.tasks) {
    if (task.status === "running" || task.status === "pending") {
      task.error = task.status === "running" ? `收到 ${signal}，已停止` : "未开始";
      task.status = "cancelled";
      task.endedAt = task.startedAt ? at : null;
    }
  }
  for (const phase of state.phases) if (phase.status === "running" || phase.status === "pending") phase.status = "cancelled";
  state.status = "cancelled";
  state.endedAt = at;
  save();
  for (const server of servers) server.close();
  const summary = renderSummary(current.dir, state);
  fs.writeFileSync(path.join(current.dir, "summary.txt"), summary);
  process.stdout.write(summary);
  process.exit(143);
}

function prepareFlow(planFile, resumeId) {
  let dir;
  let previous = null;
  let plan;
  if (resumeId) {
    dir = runDir(resumeId);
    previous = readJson(statePath(dir));
    if (!previous) die(`找不到运行记录: ${resumeId}`);
    if (previous.status === "running" && isAlive(previous.pid)) die(`${resumeId} 还在运行`);
    if (planFile) plan = loadPlan(planFile);
    else {
      // 运行目录里存的是展开后的计划，不再展开一次；旧计划的 cwd 可能缺失或是相对路径，用上次实际的工作目录
      plan = readJson(path.join(dir, "plan.json"));
      if (plan) plan.cwd = previous.cwd ?? path.resolve(plan.cwd ?? process.cwd());
    }
  } else {
    plan = loadPlan(planFile);
    dir = runDir(newRunId("r"));
  }
  if (!plan) die(`读不到计划: ${planFile ?? path.join(dir, "plan.json")}`);
  const deps = validatePlan(plan);
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "control"), { recursive: true });
  for (const name of fs.readdirSync(path.join(dir, "control"))) fs.rmSync(path.join(dir, "control", name), { force: true });
  writeJson(path.join(dir, "plan.json"), plan);

  return { dir, previous, plan, deps };
}

function createFlowState(dir, plan) {
  const cwd = plan.cwd;
  const state = {
    version: 1,
    kind: "flow",
    runId: path.basename(dir),
    name: plan.name,
    session: SESSION,
    pid: process.pid,
    cwd,
    alertAfter: ALERT_AFTER,
    status: "running",
    startedAt: nowIso(),
    endedAt: null,
    phases: plan.phases.map((p) => ({ title: p.title, status: "pending" })),
    tasks: [],
  };
  return state;
}

function populateFlowTasks(dir, state, previous, planTasks, deps) {
  const cwd = state.cwd;
  // 续跑：已完成、prompt 与工作目录和前置任务都没变、前置任务也都复用的任务复用结果；
  // 一个任务重跑，等它的任务都重跑，因为它们可能用到它的结果。旧记录没存前置任务时不比较前置
  const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const reusable = new Map();
  const canReuse = (label) => {
    if (!reusable.has(label)) {
      const t = planTasks.get(label);
      const old = previous?.tasks?.find((o) => o.label === label);
      reusable.set(label, !!(old && (old.status === "completed" || old.checkFailed) && old.hash === promptHash(t) && old.result && fs.existsSync(path.join(dir, old.result))
        && (old.cwd ?? previous.cwd) === (t.cwd ?? cwd) && (!old.needs || sameList(old.needs, deps.get(label))))
        && deps.get(label).every(canReuse));
    }
    return reusable.get(label);
  };
  // 验收失败或改了 checks：复用 Codex 结果、只重跑验收。只改了 writes 不重跑，按新范围重新筛一遍越界记录，来源未定的无法重算就清掉
  const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const rescope = (scope, t) => {
    const taskCwd = t.cwd ?? cwd;
    const outside = t.writes ? scope.outside.filter((f) => !inScope(realPath(path.join(taskCwd, f)), t.writes, taskCwd)) : [];
    return outside.length ? { outside, unclaimed: [] } : null;
  };
  const reuse = (old, t) => {
    const entry = { ...old, phase: t.phase, reused: true, writes: t.writes, checks: t.checks };
    if (old.checkFailed || !sameJson(old.checks ?? [], t.checks ?? [])) Object.assign(entry, { status: "pending", recheck: true });
    if (old.scope && !sameJson(old.writes, t.writes)) entry.scope = rescope(old.scope, t);
    return entry;
  };
  // models.json 里默认用 Fast 的模型记下请求的 tier，开 thread 时带上
  const tierOf = (model) => (serviceTierOf(model) ? { serviceTier: serviceTierOf(model) } : {});
  for (const [label, t] of planTasks) {
    const old = previous?.tasks?.find((o) => o.label === label);
    // 上次合回写主工作区时中断的隔离任务：不复用、不重跑，记为失败等人工核对
    if (old?.merge?.state === "applying") {
      state.tasks.push(interruptedMerge(old, t.phase));
      continue;
    }
    const contract = { writes: t.writes, checks: t.checks, ...isolationFields(t) };
    state.tasks.push(canReuse(label)
      ? reuse(old, t)
      : { label, phase: t.phase, model: t.model, effort: t.effort, ...tierOf(t.model), brief: t.brief || briefOf(literal(t.prompt)), hash: promptHash(t), status: "pending",
          needs: deps.get(label), ...contract, ...(t.schema ? { schema: t.schema } : {}), ...(t.cwd && t.cwd !== cwd ? { cwd: t.cwd } : {}) });
  }
}

function scheduleTasks(dir, state, planTasks, deps) {
  const cwd = state.cwd;
  // 前置任务都结束就开跑；前置任务一个都没完成时记为跳过，等它的任务随之跳过
  const byLabel = new Map(state.tasks.map((t) => [t.label, t]));
  const settled = (t) => ["completed", "failed", "cancelled", "skipped"].includes(t.status);
  return new Promise((resolve) => {
    const step = () => {
      for (let changed = true; changed;) {
        changed = false;
        for (const task of state.tasks) {
          if (task.status !== "pending") continue;
          const before = deps.get(task.label).map((label) => byLabel.get(label));
          if (!before.every(settled)) continue;
          if (before.length && !before.some((t) => t.status === "completed")) {
            task.status = "skipped";
            task.error = "前置任务都没有完成";
            changed = true;
            continue;
          }
          const t = planTasks.get(task.label);
          (task.recheck ? recheckTask(dir, task, t.cwd ?? cwd) : runTask(dir, state, task, withContract(renderPrompt(t.prompt, state, dir), t), t.cwd ?? cwd))
            .catch((error) => {
              task.status = "failed";
              task.error = `执行出错：${error.message}`;
              task.endedAt = nowIso();
            })
            .then(step);
        }
      }
      for (const phase of state.phases) phase.status = phaseStatus(state.tasks.filter((t) => t.phase === phase.title));
      save();
      if (state.tasks.every(settled)) resolve();
    };
    step();
  });
}

export async function runFlow(planFile, resumeId) {
  const { dir, plan, previous, deps } = prepareFlow(planFile, resumeId);
  const state = createFlowState(dir, plan);
  const planTasks = new Map(plan.phases.flatMap((p) => p.tasks.map((t) => [t.label, { ...t, phase: p.title }])));
  populateFlowTasks(dir, state, previous, planTasks, deps);
  setCurrent(dir, state);
  save();
  process.stdout.write(`[codex-flow] ${plan.name} 开始 · ${state.runId}\n`);

  await scheduleTasks(dir, state, planTasks, deps);
  state.status = overallStatus(state.tasks);
  state.endedAt = nowIso();
  save();
  const summary = renderSummary(dir, state);
  fs.writeFileSync(path.join(dir, "summary.txt"), summary);
  process.stdout.write(summary);
  try {
    pruneOldRuns(7, cleanRunArchives);
  } catch {
    // 清理失败不影响结果
  }
  process.exit(state.status === "completed" ? 0 : 1);
}

