// status、cancel、steer 和 watch 命令：读取运行记录、写控制文件和输出提醒。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { effectiveStatus, elapsedSeconds, formatDuration, isAlive, listRuns, nowIso, readJson, runDir, statePath } from "./state.mjs";
import { die, fileSafe, SESSION } from "./runtime.mjs";
import { renderSummary, WORD } from "./summary.mjs";

function findRun(runId) {
  const state = readJson(statePath(runDir(runId)));
  if (!state) die(`找不到运行记录: ${runId}`);
  return { dir: runDir(runId), state };
}

export function cmdStatus({ flags, positionals }) {
  if (positionals[0]) {
    const { dir, state } = findRun(positionals[0]);
    process.stdout.write(renderSummary(dir, state));
    return;
  }
  const runs = listRuns({ session: flags.all ? null : SESSION }).slice(0, 10);
  if (!runs.length) return void process.stdout.write("[codex-flow] 没有运行记录\n");
  for (const { dir, state } of runs) process.stdout.write(`${renderSummary(dir, state)}\n`);
}

export function cmdCancel({ positionals }) {
  const [runId, label] = positionals;
  if (!runId) die("用法: cancel <runId> [任务名]");
  const { dir, state } = findRun(runId);
  if (state.kind === "single") {
    if (!isAlive(state.pid)) die(`${runId} 已经不在运行`, 1);
    fs.mkdirSync(path.join(dir, "control"), { recursive: true });
    fs.writeFileSync(path.join(dir, "control", "stop"), nowIso());
    spawnSync("pkill", ["-TERM", "-P", String(state.pid)]);
    process.stdout.write(`[codex-flow] 已请求停止 ${runId}\n`);
    return;
  }
  if (label) {
    if (!state.tasks.some((t) => t.label === label)) die(`没有名为「${label}」的任务`);
    fs.writeFileSync(path.join(dir, "control", `${fileSafe(label)}.stop`), nowIso());
    process.stdout.write(`[codex-flow] 已请求停止「${label}」\n`);
    return;
  }
  if (!isAlive(state.pid)) die(`${runId} 已经不在运行`, 1);
  process.kill(state.pid, "SIGTERM");
  process.stdout.write(`[codex-flow] 已请求停止 ${runId}\n`);
}

export function cmdSteer({ positionals }) {
  const [runId, label, ...rest] = positionals;
  const text = rest.join(" ").trim();
  if (!runId || !label || !text) die('用法: steer <runId> <任务名> "<补充指示>"');
  const { dir, state } = findRun(runId);
  const task = state.tasks.find((t) => t.label === label);
  if (!task) die(`没有名为「${label}」的任务`);
  if (task.status !== "running") die(`任务「${label}」不在运行（${task.status}）`, 1);
  fs.writeFileSync(path.join(dir, "control", `${fileSafe(label)}.steer.${Date.now()}.txt`), text);
  process.stdout.write(`[codex-flow] 已发给「${label}」\n`);
}

// 后台 Bash 重新接上运行：默认等到结束并回传汇总；显式阈值才提前提醒。
export async function cmdWatch({ flags, positionals }) {
  const runId = positionals[0];
  if (!runId) die("用法: watch <runId> [--alert-after 秒]");
  const alertAfter = Object.hasOwn(flags, "alert-after") ? Number(flags["alert-after"]) : null;
  if (alertAfter !== null && (!Number.isFinite(alertAfter) || alertAfter < 0)) die("--alert-after 必须是非负秒数");
  for (;;) {
    const { dir, state } = findRun(runId);
    const status = effectiveStatus(state);
    if (status !== "running") {
      const summary = path.join(dir, "summary.txt");
      if (fs.existsSync(summary)) process.stdout.write(fs.readFileSync(summary, "utf8"));
      else process.stdout.write(`[codex-flow] ${state.name} 已结束：${WORD[status] ?? status}，汇总见 ${summary}\n`);
      return;
    }
    const slow = alertAfter === null ? null : state.tasks.find((t) => t.status === "running" && elapsedSeconds(t.startedAt) >= alertAfter);
    if (slow) {
      process.stdout.write(`[codex-flow] 任务「${slow.label}」已运行 ${formatDuration(elapsedSeconds(slow.startedAt))}，请检查日志 ${path.join(dir, slow.log)} 并向用户汇报\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
