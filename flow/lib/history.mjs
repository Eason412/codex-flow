// 长期复盘只留元数据与计量，不保留任务说明、回报正文或文件清单。
import fs from "node:fs";
import path from "node:path";
import { HOME, RUNS, effectiveStatus, elapsedSeconds, nowIso, readJson, statePath } from "./state.mjs";
import { tokenBreakdown } from "./tokens.mjs";

const historyPath = () => path.join(HOME, "history.jsonl");
const warn = (error) => process.stderr.write(`[codex-flow] ⚠ history 写入失败: ${String(error.message).replace(/[\r\n]+/g, " ")}\n`);

// 只读取 runId，单行损坏不妨碍其余记录；其他读取错误不能当作空历史。
export function historyRunIds() {
  let text;
  try { text = fs.readFileSync(historyPath(), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const ids = new Set();
  for (const line of text.split("\n")) {
    try { const record = JSON.parse(line); if (record.runId) ids.add(record.runId); } catch {}
  }
  return ids;
}

export function historyRecord(dir, state) {
  return {
    runId: state.runId ?? path.basename(dir), kind: state.kind ?? "flow", name: state.name ?? null,
    cwd: state.cwd ?? null, status: effectiveStatus(state), startedAt: state.startedAt ?? null,
    endedAt: state.endedAt ?? null, resumed: state.resumed ?? (state.kind === "single" ? state.tasks?.[0]?.resumed ?? null : null), recordedAt: nowIso(),
    tasks: (state.tasks ?? []).map((task) => {
      let usage = null;
      try { usage = tokenBreakdown(task, task.startedAt ?? state.startedAt, task.endedAt ?? state.endedAt, state.kind); } catch {}
      let chars = task.report?.chars ?? null;
      if (chars === null && task.result) {
        try { chars = [...fs.readFileSync(path.resolve(dir, task.result), "utf8").trim()].length; } catch {}
      }
      return {
        label: task.label ?? null, phase: task.phase ?? null, model: task.model ?? null, effort: task.effort ?? null,
        actualModel: task.actualModel ?? null, actualEffort: task.actualEffort ?? null,
        serviceTier: task.serviceTier ?? null, actualServiceTier: task.actualServiceTier ?? null,
        status: task.status ?? null, seconds: task.startedAt ? elapsedSeconds(task.startedAt, task.endedAt ?? state.endedAt) : 0,
        tokens: task.tokens ?? null, ...(usage ? { tokenUsage: usage } : {}), schema: task.schema ?? null,
        checks: { passed: (task.checkResults ?? []).filter((c) => c.code === 0 && !c.reason).length, total: task.checks?.length ?? task.checkResults?.length ?? 0 },
        input: Object.fromEntries(Object.entries(task.input ?? {}).filter(([, v]) => Number.isFinite(v?.chars)).map(([k, v]) => [k, v.chars])),
        report: chars, reused: Boolean(task.reused), resumed: Boolean(task.resumed), threadId: task.threadId ?? null, forkedFrom: task.forkedFrom ?? null,
        scope: { outside: task.scope?.outside?.length ?? 0, unclaimed: task.scope?.unclaimed?.length ?? 0 },
        collisions: task.collisions?.length ?? 0, error: task.error ? [...String(task.error)].slice(0, 200).join("") : null,
      };
    }),
  };
}

// 一次 append 写一行，多个 flow 同时结束时也不会分多次写入。同一 runId 的续跑追加新行。
export function appendHistory(dir, state) {
  try {
    const line = JSON.stringify(historyRecord(dir, state)) + "\n";
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(historyPath(), line, "utf8");
    return true;
  } catch (error) {
    warn(error);
    return false;
  }
}

// 删除前的兜底：无法确认已记录或无法写入就保留目录，不能为了清理丢掉唯一数据。
export function ensureHistory(dir, state) {
  try {
    if (historyRunIds().has(state.runId ?? path.basename(dir))) return true;
  } catch (error) { warn(error); return false; }
  return appendHistory(dir, state);
}

export function cmdHistory() {
  let ids;
  try { ids = historyRunIds(); } catch (error) { warn(error); return; }
  let added = 0, skipped = 0;
  for (const entry of fs.existsSync(RUNS) ? fs.readdirSync(RUNS, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(RUNS, entry.name), state = readJson(statePath(dir));
    if (!state || ids.has(state.runId ?? entry.name)) { skipped++; continue; }
    if (appendHistory(dir, state)) { added++; ids.add(state.runId ?? entry.name); }
  }
  process.stdout.write(`[codex-flow] history 补录 ${added} 条，跳过 ${skipped} 条\n`);
}
