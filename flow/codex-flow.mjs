#!/usr/bin/env node
// codex-flow：像 Claude Workflow 一样分阶段派 Codex。
// 用法:
//   codex-flow.mjs run <plan.json> [--resume <runId>]   用后台 Bash 启动，flow 结束才退出
//   codex-flow.mjs run --resume <runId>                 用原计划续跑，已完成且没改过的任务直接复用
//   codex-flow.mjs status [runId] [--all]               本会话的运行记录
//   codex-flow.mjs cancel <runId> [任务名]              停整个 flow 或其中一个任务
//   codex-flow.mjs steer <runId> <任务名> "<补充指示>"   给运行中的任务插话
//   codex-flow.mjs watch <runId> [--alert-after 秒]     有任务跑满时长或 flow 结束时打印一行并退出
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "./lib/appserver.mjs";
import {
  RUNS, briefOf, effectiveStatus, elapsedSeconds, formatDuration,
  checkModelEffort, isAlive, listRuns, newRunId, nowIso, promptHash, pruneOldRuns, readJson, runDir, statePath, writeJson,
} from "./lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.resolve(here, "..", "schemas");
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || null;
// 提醒阈值写进 state，mod 按它提醒；不设时 mod 用 15 分钟
const ALERT_AFTER = Number(process.env.CODEX_FLOW_ALERT_AFTER) || null;
const fileSafe = (label) => label.replace(/[\/\\:*?"<>|\s]+/g, "_");

function die(message, code = 2) {
  process.stderr.write(`[codex-flow] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (valueFlags.includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

// ---------- 计划 ----------

function loadSchema(name) {
  if (!name) return null;
  const file = fs.existsSync(name) ? name : path.join(SCHEMAS, `${name}.json`);
  const schema = readJson(file);
  if (!schema) die(`找不到 schema: ${name}（内置: review / opinion / result）`);
  return schema;
}

function validatePlan(plan) {
  if (!plan || typeof plan.name !== "string" || !plan.name.trim()) die("计划缺少 name");
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) die("计划缺少 phases");
  const labels = new Set();
  const titles = new Set();
  for (const phase of plan.phases) {
    if (!phase.title || titles.has(phase.title)) die(`阶段标题缺失或重复: ${phase.title}`);
    titles.add(phase.title);
    if (!Array.isArray(phase.tasks) || phase.tasks.length === 0) die(`阶段「${phase.title}」没有任务`);
    for (const task of phase.tasks) {
      if (!task.label || labels.has(task.label)) die(`任务名缺失或重复: ${task.label}`);
      labels.add(task.label);
      try { checkModelEffort(task.model, task.effort, task.label); } catch (error) { die(error.message); }
      if (typeof task.prompt !== "string" || !task.prompt.trim()) die(`任务「${task.label}」缺少 prompt`);
      if (task.schema) loadSchema(task.schema);
    }
  }
}

// {{phase:标题}} 换成该阶段所有任务的结果，{{task:任务名}} 换成单个任务的结果
function renderPrompt(prompt, state, dir) {
  const resultOf = (task) => {
    if (task.status !== "completed" || !task.result) return `（任务「${task.label}」未完成：${task.status}）`;
    try {
      return fs.readFileSync(path.join(dir, task.result), "utf8").trim();
    } catch {
      return `（任务「${task.label}」的结果文件读不到）`;
    }
  };
  return prompt
    .replace(/\{\{phase:([^}]+)\}\}/g, (_, title) =>
      state.tasks.filter((t) => t.phase === title.trim()).map((t) => `### ${t.label}\n${resultOf(t)}`).join("\n\n"))
    .replace(/\{\{task:([^}]+)\}\}/g, (_, label) => {
      const task = state.tasks.find((t) => t.label === label.trim());
      return task ? resultOf(task) : `（没有名为「${label}」的任务）`;
    });
}

// ---------- 执行 ----------

const servers = new Set();
let current = null; // { dir, state }

function save() {
  if (current) writeJson(statePath(current.dir), current.state);
}

function onStop(signal) {
  if (!current) process.exit(143);
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

async function runTask(dir, state, task, prompt, cwd) {
  const logFile = path.join(dir, "logs", `${fileSafe(task.label)}.jsonl`);
  const t0 = Date.now();
  const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(1), ...entry })}\n`);
  const control = path.join(dir, "control");
  const stopFile = path.join(control, `${fileSafe(task.label)}.stop`);

  task.status = "running";
  task.startedAt = nowIso();
  task.log = path.relative(dir, logFile);
  fs.writeFileSync(path.join(dir, "logs", `${fileSafe(task.label)}.prompt.txt`), prompt);
  save();

  let lastMessage = null;
  let resolveTurn;
  const turnDone = new Promise((r) => (resolveTurn = r));
  let server;
  try {
    server = await AppServer.start({
      cwd,
      onNotification: (m) => {
        const p = m.params ?? {};
        const item = p.item ?? {};
        if (m.method === "item/completed" && item.type === "agentMessage") lastMessage = item.text ?? lastMessage;
        if (m.method === "thread/tokenUsage/updated") {
          const total = p.tokenUsage?.total?.totalTokens;
          if (typeof total === "number") task.tokens = total;
        }
        if (m.method === "turn/completed") resolveTurn({ status: p.turn?.status, error: p.turn?.error?.message ?? null });
        if (m.method === "connection/closed") resolveTurn({ status: "failed", error: p.message });
        if (m.method.startsWith("mcpServer/") || m.method === "account/updated" || m.method === "remoteControl/status/changed") return;
        const entry = { method: m.method };
        if (item.type) entry.item = item.type;
        if (item.command) entry.command = String(item.command).slice(0, 300);
        if (item.status) entry.status = item.status;
        if (item.query) entry.query = String(item.query).slice(0, 200);
        if (m.method === "turn/completed") entry.turn = p.turn?.status;
        if (m.method.startsWith("server-request:") || m.method === "error") entry.params = JSON.stringify(p).slice(0, 500);
        log(entry);
      },
    });
    servers.add(server);
    const schema = loadSchema(task.schema);
    const thread = await server.request("thread/start", {
      cwd, model: task.model, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false,
    });
    task.threadId = thread.thread?.id ?? null;
    task.actualModel = thread.model ?? null;
    const turn = await server.request("turn/start", {
      threadId: task.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: task.model,
      effort: task.effort,
      outputSchema: schema,
    });
    task.turnId = turn.turn?.id ?? null;
    save();
  } catch (error) {
    servers.delete(server);
    server?.close();
    task.status = "failed";
    task.error = `启动失败：${error.message}`;
    task.endedAt = nowIso();
    log({ method: "start-failed", error: error.message });
    save();
    return;
  }

  // 每秒看一次控制目录：停止和插话由 /flow 面板或 cancel / steer 命令写进来；token 数变了也存一次，面板据此显示
  let savedTokens = task.tokens;
  const poll = setInterval(async () => {
    if (task.tokens !== savedTokens) {
      savedTokens = task.tokens;
      save();
    }
    try {
      if (fs.existsSync(stopFile) && !task.stopRequested) {
        task.stopRequested = true;
        log({ method: "stop-requested" });
        await server.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
      }
      const prefix = `${fileSafe(task.label)}.steer.`;
      for (const name of fs.existsSync(control) ? fs.readdirSync(control) : []) {
        if (!name.startsWith(prefix) || !name.endsWith(".txt")) continue;
        const file = path.join(control, name);
        const text = fs.readFileSync(file, "utf8");
        fs.renameSync(file, `${file}.sent`);
        await server.request("turn/steer", {
          threadId: task.threadId, expectedTurnId: task.turnId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        log({ method: "steer-sent", chars: text.length });
      }
    } catch (error) {
      log({ method: "control-error", error: error.message });
    }
  }, 1000);

  const end = await turnDone;
  clearInterval(poll);
  servers.delete(server);
  server.close();

  task.endedAt = nowIso();
  if (end.status === "completed") {
    task.status = "completed";
    let text = lastMessage ?? "";
    let ext = "md";
    if (task.schema) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
        ext = "json";
      } catch {
        // 没按 schema 返回就原样存成 md
      }
    }
    const resultFile = path.join(dir, "results", `${fileSafe(task.label)}.${ext}`);
    fs.writeFileSync(resultFile, `${text}\n`);
    task.result = path.relative(dir, resultFile);
  } else if (end.status === "interrupted") {
    task.status = "cancelled";
    task.error = task.stopRequested ? "已按要求停止" : "被中断";
  } else {
    task.status = "failed";
    task.error = end.error || `turn ${end.status}`;
  }
  save();
}

async function runFlow(planFile, resumeId) {
  let dir;
  let previous = null;
  let plan;
  if (resumeId) {
    dir = runDir(resumeId);
    previous = readJson(statePath(dir));
    if (!previous) die(`找不到运行记录: ${resumeId}`);
    if (previous.status === "running" && isAlive(previous.pid)) die(`${resumeId} 还在运行`);
    plan = planFile ? readJson(planFile) : readJson(path.join(dir, "plan.json"));
  } else {
    plan = readJson(planFile);
    dir = runDir(newRunId("r"));
  }
  if (!plan) die(`读不到计划: ${planFile}`);
  validatePlan(plan);
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "control"), { recursive: true });
  for (const name of fs.readdirSync(path.join(dir, "control"))) fs.rmSync(path.join(dir, "control", name), { force: true });
  writeJson(path.join(dir, "plan.json"), plan);

  const cwd = plan.cwd ? path.resolve(plan.cwd) : process.cwd();
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
  // 续跑：已完成且没改过的任务复用结果；某个阶段有任务要重跑，后面阶段的任务都重跑，因为它们可能引用了前面的结果
  let dirty = false;
  for (const p of plan.phases) {
    let phaseDirty = false;
    for (const t of p.tasks) {
      const old = previous?.tasks?.find((o) => o.label === t.label);
      const reuse = !dirty && old && old.status === "completed" && old.hash === promptHash(t) && old.result && fs.existsSync(path.join(dir, old.result));
      if (!reuse) phaseDirty = true;
      state.tasks.push(reuse
        ? { ...old, phase: p.title, reused: true }
        : { label: t.label, phase: p.title, model: t.model, effort: t.effort, brief: t.brief || briefOf(t.prompt), hash: promptHash(t), status: "pending" });
    }
    dirty = dirty || phaseDirty;
  }
  current = { dir, state };
  save();
  process.stdout.write(`[codex-flow] ${plan.name} 开始 · ${state.runId}\n`);

  for (const [index, phasePlan] of plan.phases.entries()) {
    const phase = state.phases[index];
    phase.status = "running";
    save();
    const tasks = phasePlan.tasks.map((t) => [t, state.tasks.find((s) => s.label === t.label)]);
    await Promise.all(tasks.map(([t, task]) =>
      task.status === "completed" ? null : runTask(dir, state, task, renderPrompt(t.prompt, state, dir), cwd)));
    const statuses = tasks.map(([, task]) => task.status);
    phase.status = statuses.every((s) => s === "completed") ? "completed" : statuses.some((s) => s === "completed") ? "partial" : "failed";
    save();
    if (phase.status === "failed") {
      // 一个阶段全军覆没就不往下跑了，后面的任务记为跳过
      for (const later of state.phases.slice(index + 1)) later.status = "skipped";
      for (const task of state.tasks) if (task.status === "pending") task.status = "skipped";
      break;
    }
  }

  state.status = overallStatus(state.tasks);
  state.endedAt = nowIso();
  save();
  const summary = renderSummary(dir, state);
  fs.writeFileSync(path.join(dir, "summary.txt"), summary);
  process.stdout.write(summary);
  try {
    pruneOldRuns();
  } catch {
    // 清理失败不影响结果
  }
  process.exit(state.status === "completed" ? 0 : 1);
}

// 全部完成为 completed；有失败为 failed；其余（有任务被主动停掉）为 partial
function overallStatus(tasks) {
  if (tasks.every((t) => t.status === "completed")) return "completed";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  // 一个任务都没完成、只是被停掉：算已停止，不算部分完成
  if (!tasks.some((t) => t.status === "completed")) return "cancelled";
  return "partial";
}

const GLYPH = { completed: "✓", failed: "✗", cancelled: "■", skipped: "○", pending: "○", running: "●", lost: "✗" };
const WORD = { completed: "完成", partial: "部分完成", failed: "失败", cancelled: "已停止", running: "运行中", lost: "进程已消失" };

function renderSummary(dir, state) {
  const status = effectiveStatus(state);
  const lines = [
    `[codex-flow] ${state.name} ${WORD[status] ?? status} · ${state.phases.length} 个阶段 · ${state.tasks.length} 个任务 · ${formatDuration(elapsedSeconds(state.startedAt, state.endedAt))}`,
  ];
  const width = Math.max(...state.tasks.map((t) => t.label.length));
  for (const t of state.tasks) {
    const time = t.startedAt ? formatDuration(elapsedSeconds(t.startedAt, t.endedAt)) : "-";
    let tail = t.result ? path.join(dir, t.result) : t.error ? t.error : t.status;
    if (t.reused) tail += "（复用上次结果）";
    if (t.actualModel && t.actualModel !== t.model) tail += `  ⚠ 实际模型 ${t.actualModel}`;
    lines.push(`${GLYPH[t.status] ?? "?"} ${t.label.padEnd(width)}  ${t.model} ${t.effort}  ${time.padStart(6)}  ${tail}`);
  }
  lines.push(`运行目录: ${dir}`);
  if (state.kind === "flow" && status !== "completed") lines.push(`续跑: node ${path.join(here, "codex-flow.mjs")} run --resume ${state.runId}`);
  return `${lines.join("\n")}\n`;
}

// ---------- 其他命令 ----------

function findRun(runId) {
  const state = readJson(statePath(runDir(runId)));
  if (!state) die(`找不到运行记录: ${runId}`);
  return { dir: runDir(runId), state };
}

function cmdStatus(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (positionals[0]) {
    const { dir, state } = findRun(positionals[0]);
    process.stdout.write(renderSummary(dir, state));
    return;
  }
  const runs = listRuns({ session: flags.all ? null : SESSION }).slice(0, 10);
  if (!runs.length) return void process.stdout.write("[codex-flow] 没有运行记录\n");
  for (const { dir, state } of runs) process.stdout.write(`${renderSummary(dir, state)}\n`);
}

function cmdCancel(argv) {
  const { positionals } = parseArgs(argv);
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

function cmdSteer(argv) {
  const { positionals } = parseArgs(argv);
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

// 后台 Bash 跑它：第一个任务跑满时长或整个 flow 结束时打印一行并退出，退出即通知主代理
async function cmdWatch(argv) {
  const { flags, positionals } = parseArgs(argv, ["alert-after"]);
  const runId = positionals[0];
  if (!runId) die("用法: watch <runId> [--alert-after 秒]");
  const alertAfter = Number(flags["alert-after"] ?? process.env.CODEX_FLOW_ALERT_AFTER ?? 900);
  for (;;) {
    const { dir, state } = findRun(runId);
    const status = effectiveStatus(state);
    if (status !== "running") {
      process.stdout.write(`[codex-flow] ${state.name} 已结束：${WORD[status] ?? status}，汇总见 ${path.join(dir, "summary.txt")}\n`);
      return;
    }
    const slow = state.tasks.find((t) => t.status === "running" && elapsedSeconds(t.startedAt) >= alertAfter);
    if (slow) {
      process.stdout.write(`[codex-flow] 任务「${slow.label}」已运行 ${formatDuration(elapsedSeconds(slow.startedAt))}，请检查日志 ${path.join(dir, slow.log)} 并向用户汇报\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- run.sh 用的单发登记 ----------

const SINGLE_FLAGS = ["dir", "model", "effort", "label", "pid", "cwd", "thread-id", "forked-from", "task-file"];

function cmdSingleStart(argv) {
  const { flags } = parseArgs(argv, SINGLE_FLAGS);
  const task = fs.readFileSync(flags["task-file"], "utf8");
  try { checkModelEffort(flags.model, flags.effort, flags.label || briefOf(task, 16)); } catch (error) { die(error.message); }
  fs.mkdirSync(path.join(flags.dir, "control"), { recursive: true });
  writeJson(statePath(flags.dir), singleState(flags, task, nowIso()));
}

// 单发任务的登记内容；_single-start 写，登记失败时 _single-end 用同样的参数补登
function singleState(flags, task, startedAt) {
  const label = flags.label || briefOf(task, 16);
  return {
    version: 1, kind: "single", runId: path.basename(flags.dir), name: label, session: SESSION,
    pid: Number(flags.pid), cwd: path.resolve(flags.cwd), alertAfter: ALERT_AFTER, status: "running", startedAt, endedAt: null,
    phases: [{ title: "任务", status: "running" }],
    tasks: [{ label, phase: "任务", model: flags.model, effort: flags.effort, threadId: flags["thread-id"] || null, resumed: Boolean(flags["thread-id"]), forkedFrom: flags["forked-from"] || null,
      brief: briefOf(task), status: "running", startedAt, log: "events.jsonl" }],
  };
}

// JSONL 中损坏的行和非对象值都不参与事件或会话解析。
function jsonlObjects(text) {
  const records = [];
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
      // Codex 被中断时可能留下未写完的一行。
    }
  }
  return records;
}

const sessionRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");

const matchesRollout = (name, threadId) => name.startsWith("rollout-") &&
  (name.endsWith(`-${threadId}.jsonl`) || name.endsWith(`_${threadId}.jsonl`));

// 先查本地日期的最近 3 天；watcher 启动前 30 秒只查这些目录。
export function findRollout(threadId, { recentOnly = false, now = Date.now() } = {}) {
  if (!threadId) return null;
  const root = sessionRoot();
  const visited = new Set();
  function visit(dir) {
    if (visited.has(dir)) return null;
    visited.add(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && matchesRollout(entry.name, threadId)) return file;
      if (entry.isDirectory()) {
        const found = visit(file);
        if (found) return found;
      }
    }
    return null;
  }
  for (let ago = 0; ago < 3; ago++) {
    const date = new Date(now);
    date.setDate(date.getDate() - ago);
    const found = visit(path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
    if (found) return found;
  }
  return recentOnly ? null : visit(root);
}

// 游标按字节计，只推进到最后一个换行；半行在下次追加后重新读取。
export function readCompleteRecords(file, cursor) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    const identity = `${stat.dev}:${stat.ino}`;
    if (cursor.identity !== identity || stat.size < cursor.offset) cursor.offset = 0;
    cursor.identity = identity;
    const chunks = [];
    let position = cursor.offset;
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - position));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      chunks.push(buffer.subarray(0, read));
      position += read;
    }
    const bytes = Buffer.concat(chunks);
    const end = bytes.lastIndexOf(10);
    if (end < 0) return [];
    cursor.offset += end + 1;
    return jsonlObjects(bytes.subarray(0, end + 1).toString("utf8"));
  } catch {
    // 尚未生成、已压缩/移走或暂时不可读，下一次再查。
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function usageTokens(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens) ||
      usage.input_tokens < 0 || usage.output_tokens < 0) return null;
  return usage.input_tokens + usage.output_tokens;
}

function tokenInfo(event) {
  if (event.type !== "event_msg" || event.payload?.type !== "token_count") return null;
  const info = event.payload.info;
  return info && usageTokens(info.total_token_usage) !== null ? info : null;
}

export function applyTokenRecords(task, records, startedAt, endedAt = null) {
  let changed = false;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Infinity;
  for (const event of records) {
    const timestamp = Date.parse(event.timestamp);
    if (!(timestamp >= start && timestamp <= end)) continue;
    const info = tokenInfo(event);
    if (!info) continue;
    const total = usageTokens(info.total_token_usage);
    if (!Number.isFinite(task.tokenBaseline)) {
      const last = usageTokens(info.last_token_usage);
      if (last === null || last > total) continue;
      task.tokenBaseline = total - last;
      changed = true;
    }
    const tokens = total - task.tokenBaseline;
    if (tokens >= 0 && task.tokens !== tokens) {
      task.tokens = tokens;
      changed = true;
    }
  }
  return changed;
}

export function singleWatchTick(dir, cache, { now = Date.now, find = findRollout } = {}) {
  const state = readJson(statePath(dir));
  if (!state || state.status !== "running" || !isAlive(state.pid)) return false;
  const task = state.tasks[0];
  let changed = false;
  if (!task.threadId) {
    for (const event of readCompleteRecords(path.join(dir, "events.jsonl"), cache.events)) {
      if (event.type === "thread.started" && event.thread_id) {
        task.threadId = event.thread_id;
        changed = true;
        break;
      }
    }
  }
  if (cache.rollout && !fs.existsSync(cache.rollout)) cache.rollout = null;
  if (!cache.rollout && task.threadId) {
    const at = now();
    cache.searchStartedAt ??= at;
    const fullSearch = at - cache.searchStartedAt >= 30000 &&
      (cache.lastFullSearchAt === undefined || at - cache.lastFullSearchAt >= 10000);
    // 查找失败或抛错也算一次，避免下一轮立刻重扫全目录。
    if (fullSearch) cache.lastFullSearchAt = at;
    cache.rollout = find(task.threadId, { recentOnly: !fullSearch, now: at });
  }
  if (cache.rollout) changed = applyTokenRecords(task, readCompleteRecords(cache.rollout, cache.cursor), state.startedAt) || changed;
  if (changed) writeJson(statePath(dir), state);
  return true;
}

export async function watchSingle(dir, {
  tick = singleWatchTick, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const cache = { events: { offset: 0 }, cursor: { offset: 0 }, rollout: null, searchStartedAt: now() };
  for (;;) {
    try {
      if (!tick(dir, cache, { now })) return;
    } catch {
      // 本轮可能已推进游标却未成功保存，重读以免丢失未登记的事件。
      cache.events = { offset: 0 };
      cache.cursor = { offset: 0 };
      // 文件和状态可能临时变化；只跳过这一轮，父进程消失时仍退出。
      const state = readJson(statePath(dir));
      if (!state || state.status !== "running" || !isAlive(state.pid)) return;
    }
    await wait(2000);
  }
}

async function cmdSingleWatch(argv) {
  const { flags } = parseArgs(argv, ["dir"]);
  await watchSingle(flags.dir);
}

export function settleSingleTokens(task, startedAt, endedAt, usage) {
  const file = findRollout(task.threadId);
  const records = file ? readCompleteRecords(file, { offset: 0 }) : [];
  if (!Number.isFinite(task.tokenBaseline)) {
    if (!task.resumed && !task.forkedFrom) task.tokenBaseline = 0;
    else {
      let latest = -Infinity;
      for (const event of records) {
        const timestamp = Date.parse(event.timestamp);
        const info = tokenInfo(event);
        if (timestamp < Date.parse(startedAt) && timestamp >= latest && info) {
          latest = timestamp;
          task.tokenBaseline = usageTokens(info.total_token_usage);
        }
      }
    }
  }
  // 结束时没有实时基线，续接和分叉只能用开始前的累计值；不能凭空按零结算。
  if (Number.isFinite(task.tokenBaseline)) applyTokenRecords(task, records, startedAt, endedAt);
  const total = usageTokens(usage);
  if (total !== null && Number.isFinite(task.tokenBaseline) && total >= task.tokenBaseline) {
    task.tokens = total - task.tokenBaseline;
  }
}

export function singleContext(threadId, startedAt, endedAt) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  let found = false;
  let context = null;
  let latest = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  // Codex exec 事件没有 turn id；同一 thread 在时间窗内被并发续跑时，无法区分各轮 context。
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && matchesRollout(entry.name, threadId)) {
        found = true;
        for (const event of jsonlObjects(fs.readFileSync(file, "utf8"))) {
          const timestamp = Date.parse(event.timestamp);
          if (event.type === "turn_context" && timestamp >= latest && timestamp <= end &&
              event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
            latest = timestamp;
            context = event.payload;
          }
        }
      }
    }
  }
  if (threadId) visit(root);
  return { found, context };
}

function readableSingleError(message) {
  try {
    return JSON.parse(message)?.error?.message ?? message;
  } catch {
    return message;
  }
}

function reportSingle(dir, code, state, events) {
  const task = state.tasks[0];
  const { found, context } = singleContext(task.threadId, state.startedAt, state.endedAt);
  task.actualModel = context?.model ?? null;
  task.actualEffort = context?.effort ?? null;
  writeJson(statePath(dir), state);
  process.stdout.write(`[codex] thread: ${task.threadId || "未知"}\n`);
  if (context) {
    process.stdout.write(`[codex] 实际使用: model=${context.model ?? "None"} effort=${context.effort ?? "None"} sandbox=${context.sandbox_policy?.type ?? "?"}（来自 Codex 会话记录）\n`);
    // 和原报告的 os.path.realpath 一样，不要求路径的所有部分仍然存在。
    const realpath = (cwd) => {
      const absolute = path.resolve(cwd);
      try {
        return fs.realpathSync(absolute);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        const parent = path.dirname(absolute);
        return parent === absolute ? absolute : path.join(realpath(parent), path.basename(absolute));
      }
    };
    if (context.cwd && realpath(context.cwd) !== realpath(state.cwd)) {
      process.stdout.write(`[codex] 工作目录: ${context.cwd}\n`);
    }
  } else {
    const reason = found ? "这次没有开始新一轮，无法核实实际模型和 effort" : "找不到 Codex 会话记录，无法核实实际模型和 effort";
    process.stdout.write(`[codex] ⚠ ${reason}（请求的是 model=${task.model} effort=${task.effort}）\n`);
  }
  process.stdout.write(`[codex] exit: ${code}  日志: ${dir}\n`);
  const warnings = new Set();
  const errors = new Set();
  for (const event of events) {
    if (event.type === "error") errors.add(readableSingleError(event.message ?? ""));
    else if (event.type === "turn.failed") errors.add(readableSingleError(event.error?.message ?? ""));
    else if (event.type === "item.completed" && event.item?.type === "error") warnings.add(event.item.message ?? "");
  }
  for (const warning of warnings) process.stdout.write(`[codex] 提示: ${warning}\n`);
  for (const error of errors) process.stdout.write(`[codex] 错误: ${error}\n`);
  if (code !== "0") {
    const lines = fs.readFileSync(path.join(dir, "stderr.log"), "utf8").trim().split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("Reading additional input"));
    if (lines.length) process.stdout.write(`----- stderr（最后 15 行）-----\n${lines.slice(-15).join("\n")}\n`);
  }
}

function endSingle(dir, code, flags = {}) {
  const file = statePath(dir);
  let state = readJson(file);
  // 开头登记失败时用 run.sh 传来的同一组参数补登，开始时间取 task.txt 的写入时间；这样报告照常、退出码不受影响
  const taskFile = flags["task-file"];
  if (!state && flags.model && taskFile && fs.existsSync(taskFile)) {
    state = singleState(flags, fs.readFileSync(taskFile, "utf8"), fs.statSync(taskFile).mtime.toISOString());
  }
  if (!state) throw new Error("读不到单发任务的 state.json");
  const task = state.tasks[0];
  // 从外面停掉 codex 时它可能以 0 退出，所以完成要以事件里的 turn.completed 为准；
  // 有停止标记或被 SIGTERM/SIGINT 停掉（143/130）算有人要求停止，不算失败
  let finished = false;
  let usage = null;
  const stopped = fs.existsSync(path.join(dir, "control", "stop")) || code === "143" || code === "130";
  const at = nowIso();
  let events = [];
  let eventsError = null;
  try {
    events = jsonlObjects(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8"));
  } catch (error) {
    // 事件文件缺失时仍登记结束；其他读取错误由报告的兜底处理。
    if (error.code !== "ENOENT") eventsError = error;
  }
  for (const event of events) {
    if (event.type === "thread.started") task.threadId = event.thread_id || task.threadId;
    if (event.type === "turn.completed") {
      finished = true;
      usage = event.usage;
    }
  }
  settleSingleTokens(task, state.startedAt, at, usage);
  task.actualModel = null;
  task.actualEffort = null;
  if (fs.existsSync(path.join(dir, "last.md"))) task.result = "last.md";
  const ok = code === "0" && finished;
  const status = ok ? "completed" : stopped ? "cancelled" : "failed";
  task.status = status;
  if (!ok) task.error = stopped ? "已按要求停止" : code === "0" ? "Codex 没有完成这一轮就退出了" : `exit ${code}`;
  if (!ok) process.stdout.write(`[codex] ${task.error}\n`);
  task.endedAt = at;
  state.phases[0].status = status;
  state.status = status;
  state.endedAt = at;
  writeJson(file, state);
  if (eventsError) throw eventsError;
  reportSingle(dir, code, state, events);
}

// JSON.parse 只校验合法性；排版直接扫描原文，保留字符串转义和数字字面值。
export function indentJson(text) {
  JSON.parse(text);
  let result = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => { result += "\n" + "  ".repeat(depth); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (/\s/.test(char)) {
      continue;
    } else if (char === "{" || char === "[") {
      result += char;
      let next = i + 1;
      while (/\s/.test(text[next] ?? "")) next++;
      if (text[next] === (char === "{" ? "}" : "]")) {
        result += text[next];
        i = next;
      } else {
        depth++;
        newline();
      }
    } else if (char === "}" || char === "]") {
      depth--;
      newline();
      result += char;
    } else if (char === ",") {
      result += char;
      newline();
    } else if (char === ":") {
      result += ": ";
    } else {
      result += char;
    }
  }
  return result;
}

function cmdSingleEnd(argv) {
  const { flags } = parseArgs(argv, [...SINGLE_FLAGS, "code"]);
  let reportFailed = false;
  const fail = (error) => {
    reportFailed = true;
    process.exitCode = 1;
    process.stdout.write(`[codex] ⚠ 报告出错: ${String(error.message).replace(/[\r\n]+/g, " ")}\n`);
  };
  try {
    endSingle(flags.dir, flags.code, flags);
  } catch (error) {
    fail(error);
  }
  // 报告失败也不能吞掉 Codex 的最终回复；失败时不处理原文。
  try {
    const last = path.join(flags.dir, "last.md");
    if (fs.existsSync(last)) {
      let text = fs.readFileSync(last, "utf8");
      if (!reportFailed) {
        // 和原来的 Python 版一样先去掉首尾空白
        text = text.trim();
        try {
          text = indentJson(text);
        } catch {
          // 非 JSON 回复保留原文。
        }
      }
      process.stdout.write(`----- Codex 最终回复 -----\n${text}${text.endsWith("\n") ? "" : "\n"}`);
    }
  } catch (error) {
    fail(error);
  }
  try {
    pruneOldRuns();
  } catch {
    // 和多任务 flow 一样，清理失败不影响结果。
  }
}

function cmdCheck(argv) {
  const { flags } = parseArgs(argv, ["model", "effort", "label"]);
  try { checkModelEffort(flags.model, flags.effort, flags.label || "任务"); } catch (error) { die(error.message); }
}

// ---------- 入口 ----------

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run": {
      const { flags, positionals } = parseArgs(rest, ["resume"]);
      if (!positionals[0] && !flags.resume) die("用法: run <plan.json> [--resume <runId>]");
      fs.mkdirSync(RUNS, { recursive: true });
      process.on("SIGTERM", () => onStop("SIGTERM"));
      process.on("SIGINT", () => onStop("SIGINT"));
      process.on("SIGHUP", () => onStop("SIGHUP"));
      await runFlow(positionals[0] ? path.resolve(positionals[0]) : null, flags.resume ?? null);
      break;
    }
    case "status": cmdStatus(rest); break;
    case "cancel": cmdCancel(rest); break;
    case "steer": cmdSteer(rest); break;
    case "watch": await cmdWatch(rest); break;
    case "_check": cmdCheck(rest); break;
    case "_single-watch": await cmdSingleWatch(rest); break;
    case "_single-start": cmdSingleStart(rest); break;
    case "_single-end": cmdSingleEnd(rest); break;
    default:
      die("用法: run | status | cancel | steer | watch（见文件开头的说明）");
  }
}
