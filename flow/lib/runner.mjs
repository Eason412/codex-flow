// 编排 flow 的准备、续跑复用、依赖调度与结束汇总，并处理整个 flow 的停止信号。
// 调度时写入范围重叠的任务按租约排队；续跑时按工作区快照判断复用的结果是否过期
import fs from "node:fs";
import path from "node:path";
import { briefOf, isAlive, newRunId, nowIso, promptHash, pruneOldRuns, readJson, runDir, statePath, serviceTierOf, writeJson } from "./state.mjs";
import { ALERT_AFTER, checkProcs, current, die, fileSafe, markStopping, save, servers, SESSION, setCurrent, stopping } from "./runtime.mjs";
import { literal, loadPlan, loadSchema, renderPrompt, validatePlan, withContract } from "./plan.mjs";
import { inScope, realPath } from "./scope.mjs";
import { killGroup, recheckTask } from "./checks.mjs";
import { leaseOf, leases, overlapNotes } from "./leases.mjs";
import { changedSources, changesSince, flowCwds, snapshotWorkspace, staleFiles } from "./freshness.mjs";
import { measureInput, meterReport } from "./meter.mjs";
import { recordCollisions } from "./collisions.mjs";
import { runTask } from "./task.mjs";
import { cleanRunArchives, closeActive, isolationFields, isolationNotes } from "./isolation.mjs";
import { archiveLeftovers } from "./threads.mjs";
import { overallStatus, phaseStatus, renderSummary } from "./summary.mjs";
import { appendHistory } from "./history.mjs";

export async function onStop(signal) {
  if (!current) process.exit(143);
  if (stopping) return;
  markStopping();
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
  try {
    state.workspace = snapshotWorkspace(flowCwds(state.cwd, state.tasks));
  } catch {
    // 快照失败只影响下次续跑的过期判断
  }
  save();
  // 等 app-server 子进程真正退出（不理会 SIGTERM 的会被强制结束），最多等 3 秒
  await Promise.race([Promise.all([...servers].map((server) => server.close())), new Promise((r) => setTimeout(r, 3000))]);
  // 到时还没退出的直接强制结束，父进程退出后就没人再管它们了
  for (const server of servers) server.proc?.kill("SIGKILL");
  // 被停掉的任务的 Codex 对话没来得及归档，另起一个 app-server 补上，最多等 4 秒
  await archiveLeftovers(state, 3000);
  save();
  // Codex 都停了再收尾隔离任务（存成果、删目录），汇总写的是收尾后的实际去留
  closeActive();
  const summary = renderSummary(current.dir, state);
  fs.writeFileSync(path.join(current.dir, "summary.txt"), summary);
  process.stdout.write(summary);
  appendHistory(current.dir, state);
  process.exit(143);
}

function prepareFlow(planFile, resumeId, rerun) {
  let dir;
  let previous = null;
  let plan;
  const notes = [];
  if (rerun.length && !resumeId) die("--rerun 只能和 --resume 一起用");
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
      const changed = plan ? changedSources(plan) : [];
      if (changed.length) notes.push(`计划引用的文件改过，这次仍用上次存下的内容；要用新内容就带计划文件续跑：${changed.join("、")}`);
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

  return { dir, previous, plan, deps, notes };
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

function populateFlowTasks(dir, state, previous, planTasks, deps, rerun, notes) {
  const cwd = state.cwd;
  // 上次结束后改过的文件：只读任务关心的文件改过就重跑，写入任务只提示（重跑可能覆盖之后的人工修改）
  const changes = previous ? changesSince(previous, flowCwds(cwd, [...planTasks.values()])) : null;
  const staleOf = new Map();
  const staleFor = (label) => {
    if (!changes) return [];
    if (!staleOf.has(label)) staleOf.set(label, staleFiles(planTasks.get(label), planTasks.get(label).cwd ?? cwd, changes.changed));
    return staleOf.get(label);
  };
  const readOnly = (t) => Array.isArray(t.writes) && !t.writes.length;
  // 续跑：已完成、prompt 与工作目录和前置任务都没变、前置任务也都复用的任务复用结果；
  // 一个任务重跑，等它的任务都重跑，因为它们可能用到它的结果。旧记录没存前置任务时不比较前置
  const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const reusable = new Map();
  const canReuse = (label) => {
    if (!reusable.has(label)) {
      const t = planTasks.get(label);
      const old = previous?.tasks?.find((o) => o.label === label);
      reusable.set(label, !!(old && (old.status === "completed" || old.checkFailed) && old.hash === promptHash(t) && old.result && fs.existsSync(path.join(dir, old.result))
        && (old.cwd ?? previous.cwd) === (t.cwd ?? cwd) && (!old.needs || sameList(old.needs, deps.get(label))) && (old.isolation ?? null) === (t.isolation ?? null))
        && !rerun.has(label) && !(readOnly(t) && staleFor(label).length)
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
    delete entry.staleRerun;
    delete entry.waiting;
    // 复用的仍是同一份旧结果：上次已提示过期的文件继续提示，只有真正重跑才清掉
    const stale = [...new Set([...(old.stale ?? []), ...staleFor(t.label)])].sort();
    if (stale.length) entry.stale = stale;
    else delete entry.stale;
    if (old.checkFailed || !sameJson(old.checks ?? [], t.checks ?? [])) Object.assign(entry, { status: "pending", recheck: true });
    if (old.scope && !sameJson(old.writes, t.writes)) entry.scope = rescope(old.scope, t);
    return entry;
  };
  // models.json 里默认用 Fast 的模型记下请求的 tier，开 thread 时带上
  const tierOf = (model) => (serviceTierOf(model) ? { serviceTier: serviceTierOf(model) } : {});
  for (const [label, t] of planTasks) {
    const old = previous?.tasks?.find((o) => o.label === label);
    const contract = { writes: t.writes, checks: t.checks, ...(t.reads ? { reads: t.reads } : {}), ...isolationFields(t) };
    const staleRerun = old?.status === "completed" && readOnly(t) && staleFor(label).length ? { staleRerun: staleFor(label) } : {};
    state.tasks.push(canReuse(label)
      ? reuse(old, t)
      : { label, phase: t.phase, model: t.model, effort: t.effort, ...tierOf(t.model), brief: t.brief || briefOf(literal(t.prompt)), hash: promptHash(t), status: "pending",
          needs: deps.get(label), ...contract, ...(t.schema ? { schema: t.schema } : {}), ...(t.cwd && t.cwd !== cwd ? { cwd: t.cwd } : {}), ...staleRerun });
  }
  carryLeftovers(state, previous);
  if (changes?.unknown.length && state.tasks.some((t) => t.reused)) {
    notes.push(`无法判断复用的结果是否过期（不在 git 里，或上次运行没有记下工作区快照）：${changes.unknown.join("、")}`);
  }
}

// 续跑时没被复用的旧任务（重跑、改了隔离方式或从计划里删掉），它的成果分支和没归档成的对话不能跟着记录一起丢：
// 记进 state.leftovers，clean、过期清理和补归档照样管，重做同一任务时据此认出可以换掉的旧分支
function carryLeftovers(state, previous) {
  if (!previous) return;
  const left = { branches: [...(previous.leftovers?.branches ?? [])], threads: [...(previous.leftovers?.threads ?? [])] };
  for (const old of previous.tasks ?? []) {
    if (state.tasks.some((t) => t.label === old.label && t.reused)) continue;
    if (old.branch?.tip) left.branches.push({ repo: old.branch.repo, name: old.branch.name, tip: old.branch.tip });
    if (old.threadId && !old.threadArchived) left.threads.push(old.threadId);
  }
  if (left.branches.length || left.threads.length) state.leftovers = left;
}

// 拼出发给 Codex 的任务说明，并按指令、资料、上游结果、约束、schema 计量
function promptFor(dir, state, task, t) {
  const injected = [];
  const rendered = renderPrompt(t.prompt, state, dir, injected);
  const text = withContract(rendered, t);
  task.input = measureInput(rendered, text, injected, t.sources, task.schema ? loadSchema(task.schema) : null);
  return text;
}

// 任务结束后：释放写入租约，记回报大小，查实际碰撞
async function afterTask(dir, state, task) {
  leases.release(task.label);
  try {
    meterReport(dir, task);
    recordCollisions(state, task);
  } catch {
    // 计量和碰撞检查出错不影响任务结果
  }
  save();
}

// 同时存在的隔离 worktree 上限：每个占一份检出的磁盘（8.5k 文件的仓库约 240MB），超出的隔离任务排队
const MAX_WORKTREES = Number(process.env.CODEX_FLOW_MAX_WORKTREES) || 4;

function scheduleTasks(dir, state, planTasks, deps) {
  const cwd = state.cwd;
  let worktrees = 0;
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
          // 排队或等前置期间被要求停止的任务不再开跑
          if (fs.existsSync(path.join(dir, "control", `${fileSafe(task.label)}.stop`))) {
            task.status = "cancelled";
            task.error = "已按要求停止（未开始）";
            changed = true;
            continue;
          }
          const t = planTasks.get(task.label);
          const taskCwd = t.cwd ?? cwd;
          // 写入范围和运行中的任务重叠就先等着，前者结束时会再走到这里
          const isolated = !task.recheck && t.isolation === "worktree";
          const lease = task.recheck || isolated ? null : leaseOf(t.writes, taskCwd);
          const blockers = leases.blockers(lease, task.label);
          if (blockers.length || (isolated && worktrees >= MAX_WORKTREES)) {
            task.waiting = blockers.length ? blockers : ["worktree 上限"];
            continue;
          }
          delete task.waiting;
          leases.hold(task.label, lease);
          if (isolated) worktrees++;
          (task.recheck ? recheckTask(dir, task, taskCwd) : runTask(dir, state, task, promptFor(dir, state, task, t), taskCwd))
            .catch((error) => {
              if (task.status === "cancelled") return;
              task.status = "failed";
              task.error = `执行出错：${error.message}`;
              task.endedAt = nowIso();
            })
            .then(() => {
              if (isolated) worktrees--;
              return afterTask(dir, state, task);
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

export async function runFlow(planFile, resumeId, rerun = []) {
  const { dir, plan, previous, deps, notes } = prepareFlow(planFile, resumeId, rerun);
  const state = createFlowState(dir, plan);
  state.resumed = Boolean(resumeId);
  // 计划顶层的 isolation 已由 validatePlan 填进各任务
  const planTasks = new Map(plan.phases.flatMap((p) => p.tasks.map((t) => [t.label, { ...t, phase: p.title }])));
  for (const label of rerun) if (!planTasks.has(label)) die(`--rerun 指向不存在的任务: ${label}`);
  populateFlowTasks(dir, state, previous, planTasks, deps, new Set(rerun), notes);
  if (notes.length) state.notes = notes;
  setCurrent(dir, state);
  save();
  process.stdout.write(`[codex-flow] ${plan.name} 开始 · ${state.runId}\n`);
  const toRun = state.tasks.filter((t) => t.status === "pending" && !t.recheck).map((t) => ({ ...planTasks.get(t.label), cwd: planTasks.get(t.label).cwd ?? state.cwd }));
  const planned = [...planTasks.values()];
  for (const line of [...overlapNotes(toRun, deps), ...isolationNotes(planned, deps), ...notes]) process.stderr.write(`[codex-flow] ${line}\n`);

  await scheduleTasks(dir, state, planTasks, deps);
  // 停止中关 app-server 会让启动中的任务提前结束，由 onStop 收尾和退出
  if (stopping) return new Promise(() => {});
  await archiveLeftovers(state, 15000);
  // 补归档期间收到停止信号：由 onStop 收尾和退出
  if (stopping) return new Promise(() => {});
  state.status = overallStatus(state.tasks);
  state.endedAt = nowIso();
  try {
    state.workspace = snapshotWorkspace(flowCwds(state.cwd, state.tasks));
  } catch {
    // 快照失败只影响下次续跑的过期判断
  }
  save();
  const summary = renderSummary(dir, state);
  fs.writeFileSync(path.join(dir, "summary.txt"), summary);
  process.stdout.write(summary);
  appendHistory(dir, state);
  try {
    pruneOldRuns(7, cleanRunArchives);
  } catch {
    // 清理失败不影响结果
  }
  process.exit(state.status === "completed" ? 0 : 1);
}
