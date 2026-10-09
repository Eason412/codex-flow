// run.sh 的单发登记、结束报告与最终回复排版；登记失败时仍按原参数补登。
import fs from "node:fs";
import path from "node:path";
import { briefOf, checkModelEffort, HOME, nowIso, pruneOldRuns, readJson, serviceTierOf, statePath, writeJson, writeText } from "./state.mjs";
import { cleanArchives } from "./archive.mjs";
import { ALERT_AFTER, die, SESSION } from "./runtime.mjs";
import { jsonlObjects, singleContext } from "./rollout.mjs";
import { settleSingleTokens, watchSingle } from "./tokens.mjs";
import { conclusionOf, renderSummary } from "./summary.mjs";
import { measureInput, meterReport } from "./meter.mjs";
import { appendHistory } from "./history.mjs";

export const SINGLE_FLAGS = ["dir", "model", "effort", "service-tier", "label", "pid", "cwd", "thread-id", "forked-from", "task-file", "schema", "schema-file"];

export function cmdSingleStart({ flags }) {
  const task = fs.readFileSync(flags["task-file"], "utf8");
  try { checkModelEffort(flags.model, flags.effort, flags.label || briefOf(task, 16)); } catch (error) { die(error.message); }
  fs.mkdirSync(path.join(flags.dir, "control"), { recursive: true });
  fs.rmSync(path.join(flags.dir, "summary.txt"), { force: true });
  writeJson(statePath(flags.dir), singleState(flags, task, nowIso()));
}

// 单发任务的登记内容；_single-start 写，登记失败时 _single-end 用同样的参数补登
function singleState(flags, task, startedAt) {
  const label = flags.label || briefOf(task, 16);
  const schema = flags["schema-file"] ? readJson(flags["schema-file"]) : null;
  return {
    version: 1, kind: "single", runId: path.basename(flags.dir), name: label, session: SESSION,
    pid: Number(flags.pid), cwd: path.resolve(flags.cwd), alertAfter: ALERT_AFTER, status: "running", startedAt, endedAt: null, resumed: Boolean(flags["thread-id"]),
    phases: [{ title: "任务", status: "running" }],
    tasks: [{ label, phase: "任务", model: flags.model, effort: flags.effort, ...(flags["service-tier"] ? { serviceTier: flags["service-tier"] } : {}), threadId: flags["thread-id"] || null, resumed: Boolean(flags["thread-id"]), forkedFrom: flags["forked-from"] || null,
      ...(flags.schema ? { schema: flags.schema } : {}), input: measureInput(task, task, [], [], schema),
      brief: briefOf(task), status: "running", startedAt, log: "events.jsonl" }],
  };
}

export async function cmdSingleWatch({ flags }) {
  await watchSingle(flags.dir);
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
  const { found, context, tier } = singleContext(task.threadId, state.startedAt, state.endedAt);
  task.actualModel = context?.model ?? null;
  task.actualEffort = context?.effort ?? null;
  task.actualServiceTier = tier;
  process.stdout.write(`[codex] thread: ${task.threadId || "未知"}\n`);
  if (context) {
    const tierText = tier ? ` service_tier=${tier}` : "";
    process.stdout.write(`[codex] 实际使用: model=${context.model ?? "None"} effort=${context.effort ?? "None"}${tierText} sandbox=${context.sandbox_policy?.type ?? "?"}（来自 Codex 会话记录）\n`);
    if (task.serviceTier && !tier) process.stdout.write(`[codex] Fast: 已请求 service_tier=${task.serviceTier}；新开的 exec 会话记录不写 tier，无法核实\n`);
    else if (task.serviceTier && tier !== task.serviceTier) process.stdout.write(`[codex] ⚠ 请求的是 Fast（service_tier=${task.serviceTier}），实际 ${tier}\n`);
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
  task.actualServiceTier = null;
  if (fs.existsSync(path.join(dir, "last.md"))) task.result = "last.md";
  meterReport(dir, task);
  const ok = code === "0" && finished;
  const status = ok ? "completed" : stopped ? "cancelled" : "failed";
  task.status = status;
  if (!ok) task.error = stopped ? "已按要求停止" : code === "0" ? "Codex 没有完成这一轮就退出了" : `exit ${code}`;
  if (!ok) process.stdout.write(`[codex] ${task.error}\n`);
  task.endedAt = at;
  state.phases[0].status = status;
  state.status = status;
  state.endedAt = at;
  try {
    if (eventsError) throw eventsError;
    reportSingle(dir, code, state, events);
  } finally {
    try {
      writeText(path.join(dir, "summary.txt"), renderSummary(dir, state));
    } finally {
      writeJson(file, state);
      appendHistory(dir, state);
    }
  }
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

export function cmdSingleEnd({ flags }) {
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
      const state = readJson(statePath(flags.dir));
      const task = state?.tasks?.[0] ?? { result: "last.md", schema: flags.schema };
      if (!["opinion", "review"].includes(task.schema)) {
        process.stdout.write(`----- Codex 结论 -----\n${conclusionOf(flags.dir, task).join("\n")}\n全文: ${path.resolve(last)}\n`);
      } else {
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
    }
  } catch (error) {
    fail(error);
  }
  try {
    // 过期的 flow 记录里有隔离成果的，先删仍停在成果上的分支和残留 worktree
    pruneOldRuns(7, (state) => cleanArchives(state, path.join(HOME, "worktrees")));
  } catch {
    // 和多任务 flow 一样，清理失败不影响结果。
  }
}

// run.sh 开跑前调用：模型或 effort 不在名单里就拦下；默认用 Fast 的模型输出要请求的 service tier
export function cmdCheck({ flags }) {
  try { checkModelEffort(flags.model, flags.effort, flags.label || "任务"); } catch (error) { die(error.message); }
  process.stdout.write(serviceTierOf(flags.model) ?? "");
}
