#!/usr/bin/env node
// codex-flow：像 Claude Workflow 一样分阶段派 Codex。
// 用法:
//   codex-flow.mjs run <plan.json> [--resume <runId>]   用后台 Bash 启动，flow 结束才退出
//   codex-flow.mjs run --resume <runId>                 用原计划续跑，已完成且没改过的任务直接复用
//   codex-flow.mjs status [runId] [--all]               本会话的运行记录
//   codex-flow.mjs cancel <runId> [任务名]              停整个 flow 或其中一个任务
//   codex-flow.mjs steer <runId> <任务名> "<补充指示>"   给运行中的任务插话
//   codex-flow.mjs watch <runId> [--alert-after 秒]     有任务跑满时长或 flow 结束时打印一行并退出
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

const expandHome = (p) => String(p).replace(/^~(?=$|[\/\\])/, os.homedir());

// 读计划并展开：promptFile 和 {{file:路径}} 相对计划文件所在目录读进 prompt，plan.cwd 相对当前目录、任务 cwd 相对 plan.cwd 换成绝对路径。
// 展开后的计划存进运行目录，续跑不再依赖这些文件；要读其他任务写出的文件，用 {{task:}} 或让 Codex 自己读
function loadPlan(planFile) {
  const plan = readJson(planFile);
  if (!plan) die(`读不到计划: ${planFile}`);
  const base = path.dirname(path.resolve(planFile));
  const read = (p, what) => {
    const file = path.resolve(base, expandHome(p));
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      die(`${what}读不到: ${file}`);
    }
  };
  plan.cwd = path.resolve(expandHome(plan.cwd ?? process.cwd()));
  for (const phase of Array.isArray(plan.phases) ? plan.phases : []) {
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      if (task.promptFile !== undefined) {
        if (task.prompt !== undefined) die(`任务「${task.label}」的 prompt 和 promptFile 只能写一个`);
        task.prompt = read(task.promptFile, `任务「${task.label}」的 promptFile `);
        delete task.promptFile;
      }
      if (typeof task.prompt === "string") {
        // {{file:}} 引入的是资料，其中的 {{task:}} {{phase:}} 等原样保留：先换成占位，发给 Codex 前再换回
        task.prompt = task.prompt.replace(/\{\{file:([^}]+)\}\}/g, (_, p) => read(p.trim(), `任务「${task.label}」引用的文件 `).trimEnd().replaceAll("{{", LITERAL_BRACES));
      }
      if (task.cwd !== undefined) task.cwd = path.resolve(plan.cwd, expandHome(task.cwd));
    }
  }
  return plan;
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
      if (task.cwd !== undefined && !fs.statSync(task.cwd, { throwIfNoEntry: false })?.isDirectory()) die(`任务「${task.label}」的 cwd 不是目录: ${task.cwd}`);
      if (task.after !== undefined && !(Array.isArray(task.after) && task.after.every((n) => typeof n === "string" && n.trim()))) {
        die(`任务「${task.label}」的 after 要写成任务名或阶段标题的数组`);
      }
      for (const key of ["writes", "checks"]) {
        if (task[key] !== undefined && !(Array.isArray(task[key]) && task[key].every((n) => typeof n === "string" && n.trim()))) {
          die(`任务「${task.label}」的 ${key} 要写成字符串数组`);
        }
      }
    }
  }
  return dependencies(plan);
}

// 每个任务等哪些任务：没写 after 就等上一阶段全部任务（阶段间顺序执行）；写了 after 就只等列出的任务或阶段，前置完成即开跑。
// prompt 里 {{task:}} {{phase:}} 引用的任务自动加进来，保证引用到的结果已经出来
function dependencies(plan) {
  const byPhase = new Map(plan.phases.map((p) => [p.title, p.tasks.map((t) => t.label)]));
  const labels = new Set(plan.phases.flatMap((p) => p.tasks.map((t) => t.label)));
  const deps = new Map();
  plan.phases.forEach((phase, index) => {
    for (const task of phase.tasks) {
      const set = new Set();
      const add = (name, kind, how) => {
        if (kind !== "phase" && labels.has(name)) set.add(name);
        else if (kind !== "task" && byPhase.has(name)) for (const label of byPhase.get(name)) set.add(label);
        else die(`任务「${task.label}」的 ${how} 指向不存在的${kind === "phase" ? "阶段" : kind === "task" ? "任务" : "任务或阶段"}: ${name}`);
      };
      if (task.after === undefined) for (const label of index > 0 ? byPhase.get(plan.phases[index - 1].title) : []) set.add(label);
      else for (const name of task.after) add(name.trim(), null, "after");
      for (const [, kind, name] of task.prompt.matchAll(/\{\{(task|phase):([^}]+)\}\}/g)) add(name.trim(), kind, `{{${kind}:}}`);
      if (set.has(task.label)) die(`任务「${task.label}」不能等待自己（after 或引用指向了自己或所在阶段）`);
      deps.set(task.label, [...set]);
    }
  });
  // 依赖不能成环
  const mark = new Map();
  const visit = (label, trail) => {
    if (mark.get(label) === "done") return;
    if (mark.get(label) === "open") die(`任务依赖成环: ${[...trail, label].join(" → ")}`);
    mark.set(label, "open");
    for (const dep of deps.get(label)) visit(dep, [...trail, label]);
    mark.set(label, "done");
  };
  for (const label of deps.keys()) visit(label, []);
  return deps;
}

// {{file:}} 引入内容里的 "{{" 在计划里存成这个占位，不参与依赖和结果替换
const LITERAL_BRACES = "\u0001";
const literal = (text) => text.replaceAll(LITERAL_BRACES, "{{");

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
    })
    .replaceAll(LITERAL_BRACES, "{{");
}

// ---------- 执行 ----------

const servers = new Set();
let current = null; // { dir, state }

function save() {
  if (current) writeJson(statePath(current.dir), current.state);
}

// ---------- 过程记录（面板 agent 详情用） ----------

const RECENT_LIMIT = 8;
const oneLine = (text, limit = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

// Codex 的命令都包在 shell -lc "…" 里，显示时去掉外壳
export function shortCommand(command) {
  const m = /^\S*sh -lc (['"])([\s\S]*)\1$/.exec(String(command ?? "").trim());
  const inner = m ? (m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, "$1") : m[2]) : command;
  return oneLine(inner);
}

// 一条 app-server 通知对应的过程条目；推理、用户消息等不记
export function activityOf(method, item, cwd) {
  const id = typeof item.id === "string" ? item.id : undefined;
  if (item.type === "commandExecution" && (method === "item/started" || method === "item/completed")) {
    const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
    return { id, kind: "cmd", text: shortCommand(item.command), status: method === "item/started" ? "running" : failed ? "failed" : "done" };
  }
  if (method !== "item/completed") return null;
  if (item.type === "fileChange" && item.status === "completed") {
    const files = (Array.isArray(item.changes) ? item.changes : []).map((c) => c?.path).filter((f) => typeof f === "string" && f);
    // 两边都取真实路径再求相对路径：macOS 的 /var 与 /private/var 这类符号链接不会算成范围外
    const base = realPath(cwd);
    const shown = files.map((f) => {
      const rel = path.relative(base, realPath(path.resolve(cwd, f)));
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : f;
    });
    return { id, kind: "edit", text: oneLine(shown.join(", ")) };
  }
  if (item.type === "agentMessage") return { id, kind: "msg", text: oneLine(String(item.text ?? "").split("\n").find((l) => l.trim())) };
  if (item.type === "webSearch") return { id, kind: "search", text: oneLine(item.query) };
  return null;
}

// ---------- 写入范围与验收 ----------

const CHECK_TIMEOUT = (Number(process.env.CODEX_FLOW_CHECK_TIMEOUT) > 0 ? Number(process.env.CODEX_FLOW_CHECK_TIMEOUT) : 600) * 1000;
const CHECK_LOG_LIMIT = 1 << 20; // 每条验收命令最多记 1MB 输出
const HASH_LIMIT = 8 << 20; // 超过 8MB 的文件用大小和修改时间代替内容摘要
const SCOPE_SETTLE_MS = 300; // 拍结束快照前等其他任务的改文件记录到齐
const checkProcs = new Set();
const touchedBy = new Map(); // 任务名 → Codex 改文件记录里的路径，判断范围外变动来自哪个任务
const checkWindows = []; // 验收命令运行的时段，验收产物可能被同时段的其他任务看成范围外变动

// 删除的文件没法 realpath，就解析它所在的目录；macOS 的 /var 与 /private/var、符号链接目录靠这里对齐
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? path.resolve(file) : path.join(realPath(parent), path.basename(file));
  }
}

// 写进 prompt 末尾，让 Codex 知道范围和验收命令；执行器结束后仍自己核对
function withContract(prompt, task) {
  const lines = [];
  if (task.writes) {
    lines.push(task.writes.length ? `只修改这些路径（相对工作目录）：${task.writes.join("、")}。` : "这是只读任务，不要修改任何文件。");
  }
  if (task.checks?.length) {
    lines.push("你结束后执行器会在工作目录依次运行下面的验收命令，全部退出码为 0 才算完成：", ...task.checks.map((c) => `- ${c}`));
  }
  return lines.length ? `${prompt}\n\n---\ncodex-flow 约束：\n${lines.join("\n")}` : prompt;
}

// 工作目录所在 git 仓库里未提交文件的状态和内容摘要；不在 git 里返回 null
function gitSnapshot(cwd) {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const root = realPath(top.stdout.trim());
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (status.status !== 0) return null;
  const files = new Map();
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const file = path.join(root, entry.slice(3));
    // 改名记录后面跟着原路径，原路径按删除记
    if ((entry[0] === "R" || entry[0] === "C") && parts[i + 1]) files.set(path.join(root, parts[++i]), `${entry[0]}-from`);
    let digest = "missing";
    try {
      const stat = fs.statSync(file);
      digest = stat.size > HASH_LIMIT ? `${stat.size}:${stat.mtimeMs}` : crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    } catch {
      // 删除或读不到的文件只记状态
    }
    files.set(file, `${entry.slice(0, 2)}:${digest}`);
  }
  return files;
}

function changedFiles(before, after) {
  if (!before || !after) return [];
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
}

// 范围写法：相对任务工作目录的路径或 glob，也可以写绝对路径；写目录名包含其下所有文件，「.」表示整个工作目录，glob 也匹配点开头的文件。
// 通配符之前的目录部分按 realpath 换算，符号链接目录与真实路径一致
function scopePatterns(patterns, cwd) {
  const base = realPath(cwd);
  return patterns.map((raw) => {
    const segments = path.resolve(cwd, raw).split(path.sep);
    const glob = segments.findIndex((s) => /[*?[\]{}]/.test(s));
    const literal = glob < 0 ? segments.join(path.sep) : segments.slice(0, glob).join(path.sep) || path.sep;
    const rest = glob < 0 ? [] : segments.slice(glob);
    return path.relative(base, path.join(realPath(literal), ...rest));
  });
}

export function inScope(file, patterns, cwd) {
  const rel = path.relative(realPath(cwd), file);
  const undot = (p) => p.replace(/(^|\/)\./g, "$1\u0000");
  return scopePatterns(patterns, cwd).some((p) =>
    p === "" || rel === p || rel.startsWith(`${p}/`) || path.matchesGlob(undot(rel), undot(p)));
}

// 越界：Codex 自己的改文件记录里出现了范围外的路径，确定是这个任务写的。
// 来源未定：同一时段 git 工作区里范围外的变动，没有改文件记录，也不在同时运行的其他任务的范围里（可能是 shell 命令或其他任务的验收命令写的）
function scopeReport(state, task, cwd, touched, before, after) {
  const show = (file) => path.relative(realPath(cwd), file) || ".";
  const outside = [...touched].filter((file) => !inScope(file, task.writes, cwd));
  const start = Date.parse(task.startedAt);
  const others = state.tasks.filter((t) => t !== task && t.writes && t.startedAt && (!t.endedAt || Date.parse(t.endedAt) >= start));
  const claimed = (file) => others.some((t) => inScope(file, t.writes, t.cwd ?? state.cwd))
    || state.tasks.some((t) => t !== task && touchedBy.get(t.label)?.has(file));
  const unclaimed = changedFiles(before, after).filter((file) => !touched.has(file) && !inScope(file, task.writes, cwd) && !claimed(file));
  const duringChecks = unclaimed.length > 0 && checkWindows.some((w) => w.label !== task.label && (w.end ?? Infinity) >= start);
  if (!outside.length && !unclaimed.length) return null;
  return { outside: outside.map(show).sort(), unclaimed: unclaimed.map(show).sort(), ...(duringChecks ? { duringChecks } : {}) };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // 已经退出
  }
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
      task.checkResults.push({ cmd, code, seconds, ...(reason ? { reason } : {}) });
      save();
      if (reason === "stop") return "stop";
      if (reason || code !== 0) return `验收未通过：${cmd}（${reason ?? `exit ${code}`}）`;
    }
    return null;
  } finally {
    window.end = Date.now();
  }
}

function onStop(signal) {
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

  // 写入范围：开始前记下 git 工作区状态，运行中收集 Codex 的改文件记录
  const before = task.writes ? gitSnapshot(cwd) : null;
  const touched = new Set();
  touchedBy.set(task.label, touched);
  // 面板的过程区：最近几步和累计数，随 token 一起每秒存一次
  task.recent = [];
  task.activity = { commands: 0, edits: 0, messages: 0 };
  delete task.turnEnded;
  let dirty = false;
  const note = (entry) => {
    const old = entry.id ? task.recent.find((e) => e.id === entry.id) : null;
    if (old) Object.assign(old, entry);
    else task.recent = [...task.recent, entry].slice(-RECENT_LIMIT);
    dirty = true;
  };
  const steerPrefix = `${fileSafe(task.label)}.steer.`;
  const pendingSteers = () => (fs.existsSync(control) ? fs.readdirSync(control) : []).filter((n) => n.startsWith(steerPrefix) && n.endsWith(".txt"));
  // Codex 结束后还没取走的插话不会再发：改名为 .unsent，并在过程里写明，不让它无声消失
  const dropSteers = () => {
    for (const name of pendingSteers()) {
      const file = path.join(control, name);
      fs.renameSync(file, `${file}.unsent`);
      note({ kind: "note", text: "插话没有送达：任务已结束" });
      log({ method: "steer-unsent", file: name });
    }
  };
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
        if (m.method === "item/completed" && item.type === "fileChange" && item.status === "completed") {
          for (const change of Array.isArray(item.changes) ? item.changes : []) {
            for (const file of [change?.path, change?.kind?.move_path]) if (typeof file === "string" && file) touched.add(realPath(path.resolve(cwd, file)));
          }
        }
        if (m.method === "thread/tokenUsage/updated") {
          const total = p.tokenUsage?.total?.totalTokens;
          if (typeof total === "number") task.tokens = total;
          // 面板照 Claude Code 的口径显示：最近一次调用的输入（当前上下文）+ 累计输出；tokens 保留累计用量供统计
          const context = p.tokenUsage?.last?.inputTokens;
          const output = p.tokenUsage?.total?.outputTokens;
          if (Number.isFinite(context) && Number.isFinite(output)) Object.assign(task, { context, output });
        }
        const step = activityOf(m.method, item, cwd);
        if (step) {
          if (m.method === "item/completed") {
            if (item.type === "commandExecution") task.activity.commands++;
            if (item.type === "fileChange" && item.status === "completed") task.activity.edits++;
            if (item.type === "agentMessage") task.activity.messages++;
          }
          note(step);
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
    dropSteers();
    save();
    return;
  }

  // 每秒看一次控制目录：停止和插话由 /flow 面板或 cancel / steer 命令写进来；token 数变了也存一次，面板据此显示
  let savedTokens = task.tokens;
  const poll = setInterval(async () => {
    if (task.tokens !== savedTokens || dirty) {
      savedTokens = task.tokens;
      dirty = false;
      save();
    }
    try {
      if (fs.existsSync(stopFile) && !task.stopRequested) {
        task.stopRequested = true;
        log({ method: "stop-requested" });
        await server.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
      }
      for (const name of pendingSteers()) {
        const file = path.join(control, name);
        // 刚写的文件下一秒再取，免得读到写了一半的内容
        if (Date.now() - fs.statSync(file).mtimeMs < 500) continue;
        const text = fs.readFileSync(file, "utf8").trim();
        fs.renameSync(file, `${file}.sent`);
        if (!text) continue;
        try {
          await server.request("turn/steer", {
            threadId: task.threadId, expectedTurnId: task.turnId,
            input: [{ type: "text", text, text_elements: [] }],
          });
        } catch (error) {
          note({ kind: "note", text: oneLine(`插话没有送达：${error.message}`) });
          throw error;
        }
        log({ method: "steer-sent", chars: text.length });
        note({ kind: "steer", text: oneLine(text) });
      }
    } catch (error) {
      log({ method: "control-error", error: error.message });
    }
  }, 1000);

  const end = await turnDone;
  clearInterval(poll);
  servers.delete(server);
  server.close();
  // Codex 已结束：面板据 turnEnded 收起插话框；被中断时没收到结束的命令记为失败
  task.turnEnded = true;
  for (const step of task.recent) if (step.status === "running") step.status = "failed";
  dropSteers();
  save();
  // 并行任务刚写的文件，改文件记录可能还在管道里没处理；稍等再拍结束快照，免得被记成来源未定
  if (task.writes) await new Promise((resolve) => setTimeout(resolve, SCOPE_SETTLE_MS));

  if (end.status === "completed") {
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
    // 写入核对在验收之前，验收命令的产物不算 Codex 写的
    if (task.writes) task.scope = scopeReport(state, task, cwd, touched, before, before ? gitSnapshot(cwd) : null);
    await finishChecks(dir, task, cwd, stopFile);
  } else if (end.status === "interrupted") {
    task.status = "cancelled";
    task.error = task.stopRequested ? "已按要求停止" : "被中断";
  } else {
    task.status = "failed";
    task.error = end.error || `turn ${end.status}`;
  }
  // 失败或被停掉的任务也可能已经写了文件
  if (end.status !== "completed" && task.writes) task.scope = scopeReport(state, task, cwd, touched, before, before ? gitSnapshot(cwd) : null);
  // 面板刷新有几秒延迟，验收期间可能又写进来插话
  dropSteers();
  task.endedAt = nowIso();
  save();
}

// 验收期间任务仍算运行中。没有验收命令就直接完成；验收失败保留结果，任务记为失败，续跑时只重跑验收
async function finishChecks(dir, task, cwd, stopFile) {
  let failure = null;
  if (task.checks?.length) {
    // 面板据此写「验收中」、收起插话框：Codex 已经结束，插话送不到
    task.checking = true;
    save();
    failure = await runChecks(dir, task, cwd, stopFile);
    delete task.checking;
  }
  task.checkFailed = !!failure && failure !== "stop";
  if (failure === "stop") {
    task.status = "cancelled";
    task.error = "已按要求停止（验收中）";
  } else if (failure) {
    task.status = "failed";
    task.error = failure;
  } else {
    task.status = "completed";
    delete task.error;
  }
}

// 续跑时只改了验收命令：复用 Codex 结果，只重跑验收
async function recheckTask(dir, task, cwd) {
  const stopFile = path.join(dir, "control", `${fileSafe(task.label)}.stop`);
  task.status = "running";
  task.startedAt = nowIso();
  delete task.error;
  save();
  await finishChecks(dir, task, cwd, stopFile);
  delete task.recheck;
  task.endedAt = nowIso();
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
  // 续跑：已完成、prompt 与工作目录和前置任务都没变、前置任务也都复用的任务复用结果；
  // 一个任务重跑，等它的任务都重跑，因为它们可能用到它的结果。旧记录没存前置任务时不比较前置
  const planTasks = new Map(plan.phases.flatMap((p) => p.tasks.map((t) => [t.label, { ...t, phase: p.title }])));
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
  for (const [label, t] of planTasks) {
    const old = previous?.tasks?.find((o) => o.label === label);
    const contract = { writes: t.writes, checks: t.checks };
    state.tasks.push(canReuse(label)
      ? reuse(old, t)
      : { label, phase: t.phase, model: t.model, effort: t.effort, brief: t.brief || briefOf(literal(t.prompt)), hash: promptHash(t), status: "pending",
          needs: deps.get(label), ...contract, ...(t.schema ? { schema: t.schema } : {}), ...(t.cwd && t.cwd !== cwd ? { cwd: t.cwd } : {}) });
  }
  current = { dir, state };
  save();
  process.stdout.write(`[codex-flow] ${plan.name} 开始 · ${state.runId}\n`);

  // 前置任务都结束就开跑；前置任务一个都没完成时记为跳过，等它的任务随之跳过
  const byLabel = new Map(state.tasks.map((t) => [t.label, t]));
  const settled = (t) => ["completed", "failed", "cancelled", "skipped"].includes(t.status);
  await new Promise((resolve) => {
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

// 阶段只在有任务正在跑时算运行中；部分完成、其余还在等前置任务的算等待
function phaseStatus(tasks) {
  if (tasks.some((t) => t.status === "running")) return "running";
  if (tasks.some((t) => t.status === "pending")) return "pending";
  if (tasks.every((t) => t.status === "completed")) return "completed";
  if (tasks.some((t) => t.status === "completed")) return "partial";
  if (tasks.every((t) => t.status === "skipped")) return "skipped";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  return "cancelled";
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

// 汇总里每个任务附一段结论，多数情况不用再打开结果文件：
// schema 结果取判断字段（verdict / status / confidence）、问题数和 summary / judgment，md 结果取正文第一段；最多三行
const SEVERITY = ["critical", "major", "minor"];
export function conclusionOf(dir, task) {
  if (!task.result) return [];
  let text;
  try {
    text = fs.readFileSync(path.join(dir, task.result), "utf8");
  } catch {
    return [];
  }
  const clip = (line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line);
  if (task.result.endsWith(".json")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const lines = (value) => (typeof value === "string" ? value.split("\n").map((l) => l.trim()).filter(Boolean) : []);
    const head = [...lines(data.verdict ?? data.status), ...lines(data.confidence).map((c) => `confidence ${c}`)];
    if (Array.isArray(data.findings)) {
      const counts = SEVERITY.map((s) => [s, data.findings.filter((f) => f?.severity === s).length]).filter(([, n]) => n);
      const other = data.findings.length - counts.reduce((n, [, c]) => n + c, 0);
      if (other) counts.push(["其他", other]);
      head.push(data.findings.length ? counts.map(([s, n]) => `${n} ${s}`).join(", ") : "无问题");
    }
    return [head.join(" · "), ...lines(data.summary ?? data.judgment)].filter(Boolean).slice(0, 3).map(clip);
  }
  // 跳过开头的标题行，取第一段
  const paragraph = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (!paragraph.length && /^#{1,6}\s/.test(line)) continue;
    paragraph.push(line);
  }
  return paragraph.slice(0, 3).map(clip);
}

function renderSummary(dir, state) {
  const status = effectiveStatus(state);
  const lines = [
    `[codex-flow] ${state.name} ${WORD[status] ?? status} · ${state.phases.length} 个阶段 · ${state.tasks.length} 个任务 · ${formatDuration(elapsedSeconds(state.startedAt, state.endedAt))}`,
  ];
  // 按终端显示宽度对齐，中文占两格
  const cells = (text) => [...text].reduce((n, c) => n + (c.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);
  const width = Math.max(...state.tasks.map((t) => cells(t.label)));
  for (const t of state.tasks) {
    const time = t.startedAt ? formatDuration(elapsedSeconds(t.startedAt, t.endedAt)) : "-";
    let tail = t.result ? path.join(dir, t.result) : t.error ? t.error : t.status;
    if (t.reused) tail += "（复用上次结果）";
    if (t.actualModel && t.actualModel !== t.model) tail += `  ⚠ 实际模型 ${t.actualModel}`;
    lines.push(`${GLYPH[t.status] ?? "?"} ${t.label}${" ".repeat(width - cells(t.label))}  ${t.model} ${t.effort}  ${time.padStart(6)}  ${tail}`);
    const list = (files) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));
    if (t.checkResults?.length && t.status === "completed") lines.push(`    验收 ${t.checkResults.length}/${t.checks?.length ?? t.checkResults.length} 通过`);
    if (t.scope?.outside?.length) lines.push(`    ⚠ 越界写入：${list(t.scope.outside)}`);
    if (t.scope?.unclaimed?.length) lines.push(`    ⚠ 范围外变动，来源未定${t.scope.duringChecks ? "（期间有其他任务在跑验收）" : ""}：${list(t.scope.unclaimed)}`);
    let conclusion = [];
    try {
      conclusion = conclusionOf(dir, t);
    } catch {
      // 结论取不出来只少这几行，不影响汇总
    }
    for (const line of conclusion) lines.push(`    ${line}`);
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

// 当前上下文和本次运行的输出（Claude Code 的显示口径）。续接、分叉时输出从本次开始计：
// 基线取开始前最后一条累计值，没有就用窗口内第一条的累计减去它自己那一次。
function contextOf(task, info) {
  const output = info.total_token_usage?.output_tokens;
  const context = info.last_token_usage?.input_tokens;
  const lastOutput = info.last_token_usage?.output_tokens;
  if (!Number.isFinite(output) || !Number.isFinite(context)) return false;
  if (!Number.isFinite(task.outputBaseline)) {
    if (!Number.isFinite(lastOutput) || lastOutput > output) return false;
    task.outputBaseline = output - lastOutput;
  }
  const own = output - task.outputBaseline;
  if (own < 0 || (task.context === context && task.output === own)) return false;
  Object.assign(task, { context, output: own });
  return true;
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
    if (contextOf(task, info)) changed = true;
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
    if (!task.resumed && !task.forkedFrom) {
      task.tokenBaseline = 0;
      task.outputBaseline ??= 0;
    } else {
      let latest = -Infinity;
      for (const event of records) {
        const timestamp = Date.parse(event.timestamp);
        const info = tokenInfo(event);
        if (timestamp < Date.parse(startedAt) && timestamp >= latest && info) {
          latest = timestamp;
          task.tokenBaseline = usageTokens(info.total_token_usage);
          if (Number.isFinite(info.total_token_usage.output_tokens)) task.outputBaseline = info.total_token_usage.output_tokens;
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
