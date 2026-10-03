// 运行任务验收命令并登记结果，处理超时、停止和只重跑验收的续跑。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./state.mjs";
import { checkProcs, checkWindows, fileSafe, save, stopping } from "./runtime.mjs";
import { closeWorktree, mergeBack, reopenWorktree, scopeOk } from "./isolation.mjs";

const CHECK_TIMEOUT = (Number(process.env.CODEX_FLOW_CHECK_TIMEOUT) > 0 ? Number(process.env.CODEX_FLOW_CHECK_TIMEOUT) : 600) * 1000;
const CHECK_LOG_LIMIT = 1 << 20; // 每条验收命令最多记 1MB 输出

export function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // 已经退出
  }
}

// 单条命令的进程、日志和停止生命周期；整组退出后不留后台进程。
async function runCheckCommand(cmd, cwd, stopFile, append) {
  const t0 = Date.now();
  append(`$ ${cmd}\n`);
  const child = spawn("sh", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  checkProcs.add(child);
  let reason = null;
  let logged = 0;
  const record = (data) => {
    if (logged < CHECK_LOG_LIMIT) append(data.subarray(0, CHECK_LOG_LIMIT - logged));
    logged += data.length;
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const stop = (why) => {
    if (reason) return;
    reason = why;
    killGroup(child, "SIGTERM");
    setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref();
  };
  const timer = setTimeout(() => stop("超时"), CHECK_TIMEOUT);
  const poll = setInterval(() => fs.existsSync(stopFile) && stop("stop"), 500);
  let code;
  try {
    code = await new Promise((resolve) => {
      child.on("error", () => resolve(127));
      // 等 exit 而不是 close：命令留下的后台进程会占着输出管道
      child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1)));
    });
    await new Promise((r) => setTimeout(r, 200)); // 让管道里剩下的输出写完
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    killGroup(child, "SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    checkProcs.delete(child);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  if (logged > CHECK_LOG_LIMIT) append(`\n[输出共 ${logged} 字节，只记前 ${CHECK_LOG_LIMIT} 字节]\n`);
  append(`[exit ${code}${reason ? `，${reason}` : ""} · ${seconds}s]\n\n`);
  return { cmd, code, seconds, ...(reason ? { reason } : {}) };
}

// 依次运行验收命令，输出写进 logs/<任务>.checks.log；有一条失败就停。
// 超时或收到停止时先 SIGTERM，3 秒后 SIGKILL；命令退出后整组结束，不留后台进程。返回失败说明、"stop" 或 null（全部通过）
async function runChecks(dir, task, cwd, stopFile) {
  const logFile = path.join(dir, "logs", `${fileSafe(task.label)}.checks.log`);
  const append = (text) => {
    try {
      fs.appendFileSync(logFile, text);
    } catch {
      // 日志写不进不影响验收结果
    }
  };
  fs.writeFileSync(logFile, "");
  task.checkResults = [];
  const window = { label: task.label, start: Date.now(), end: null };
  checkWindows.push(window);
  try {
    for (const cmd of task.checks ?? []) {
      // 整个 flow 已在停止：不再启动下一条命令
      if (stopping) return "stop";
      const result = await runCheckCommand(cmd, cwd, stopFile, append);
      const { code, reason } = result;
      task.checkResults.push(result);
      save();
      if (reason === "stop") return "stop";
      if (reason || code !== 0) return `验收未通过：${cmd}（${reason ?? `exit ${code}`}）`;
    }
    return null;
  } finally {
    window.end = Date.now();
  }
}

// 运行验收命令，只返回结果、不改任务状态：null 通过（没有验收命令也算），"stop" 被停止，其余为失败说明。
// 隔离任务在验收和合回期间保持运行中，用它；其余用 finishChecks
export async function checkTask(dir, task, cwd, stopFile) {
  if (!task.checks?.length) return null;
  if (stopping) return "stop";
  // 面板据此写「验收中」、收起插话框：Codex 已经结束，插话送不到
  task.checking = true;
  save();
  try {
    return await runChecks(dir, task, cwd, stopFile);
  } finally {
    delete task.checking;
  }
}

// 按验收结果定任务状态：验收失败保留结果，任务记为失败，续跑时只重跑验收
export function settleChecks(task, failure) {
  // 整个 flow 已在停止：onStop 已把运行中的任务记为已停止，验收通过、失败或被强制结束都不改它
  if (stopping) {
    task.checkFailed = false;
    task.status = "cancelled";
    return;
  }
  task.checkFailed = !!failure && failure !== "stop";
  if (failure === "stop") {
    task.status = "cancelled";
    task.error = "已按要求停止（验收中）";
  } else if (failure) {
    task.status = "failed";
    task.error = failure;
    task.failureKind = "checks";
  } else {
    task.status = "completed";
    delete task.error;
    delete task.failureKind;
  }
}

// 验收期间任务仍算运行中。没有验收命令就直接完成
export async function finishChecks(dir, task, cwd, stopFile) {
  settleChecks(task, await checkTask(dir, task, cwd, stopFile));
}

// 续跑时只改了验收命令：复用 Codex 结果，只重跑验收。
// 隔离任务的成果还没合回：按 result 引用重建 worktree，按这次计划的 writes 重查范围，在里面验收，通过再合回；引用不在或越界就记为失败
export async function recheckTask(dir, task, cwd) {
  const stopFile = path.join(dir, "control", `${fileSafe(task.label)}.stop`);
  task.status = "running";
  task.startedAt = nowIso();
  delete task.error;
  save();
  let iso = null;
  try {
    if (task.isolation === "worktree" && task.merge?.state !== "applied") {
      iso = reopenWorktree(dir, task, cwd);
      scopeOk(task, iso);
    }
  } catch (error) {
    Object.assign(task, { status: "failed", failureKind: "archive", error: error.message });
  }
  if (task.status === "running") {
    const failure = await checkTask(dir, task, iso?.wtCwd ?? cwd, stopFile);
    if (iso && !failure) await mergeBack(dir, task, iso, () => finishChecks(dir, task, cwd, stopFile));
    else settleChecks(task, failure);
  }
  if (iso) closeWorktree(task, iso);
  delete task.recheck;
  task.endedAt = nowIso();
  save();
}
