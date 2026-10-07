// 根据运行状态与结果文件生成终端汇总和任务结论，统一阶段及整体状态口径。
import fs from "node:fs";
import path from "node:path";
import { effectiveStatus, elapsedSeconds, formatDuration, keepDaysOf } from "./state.mjs";
import { here } from "./runtime.mjs";
import { isolationLines } from "./isolation.mjs";

// 阶段只在有任务正在跑时算运行中；部分完成、其余还在等前置任务的算等待
export function phaseStatus(tasks) {
  if (tasks.some((t) => t.status === "running")) return "running";
  if (tasks.some((t) => t.status === "pending")) return "pending";
  if (tasks.every((t) => t.status === "completed")) return "completed";
  if (tasks.some((t) => t.status === "completed")) return "partial";
  if (tasks.every((t) => t.status === "skipped")) return "skipped";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  return "cancelled";
}

// 全部完成为 completed；有失败为 failed；其余（有任务被主动停掉）为 partial
export function overallStatus(tasks) {
  if (tasks.every((t) => t.status === "completed")) return "completed";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  // 一个任务都没完成、只是被停掉：算已停止，不算部分完成
  if (!tasks.some((t) => t.status === "completed")) return "cancelled";
  return "partial";
}


// 注入的上游结果超过这个字数就提示改用 {{path:}}：大段结果塞进任务说明会挤占上下文
const INJECT_WARN = 8000;

const GLYPH = { completed: "✓", failed: "✗", cancelled: "■", skipped: "○", pending: "○", running: "●", lost: "✗" };
export const WORD = { completed: "完成", partial: "部分完成", failed: "失败", cancelled: "已停止", running: "运行中", lost: "进程已消失" };

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
  if (task.schema || task.result.endsWith(".json")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // flow schema 回复不合法时落盘为 md，仍按正文取结论。
      if (task.result.endsWith(".json")) return [];
    }
    if (data !== undefined) {
      if (!data || typeof data !== "object" || Array.isArray(data)) return [];
      const lines = (value) => (typeof value === "string" ? value.split("\n").map((l) => l.trim()).filter(Boolean) : []);
      const head = [...lines(data.verdict ?? data.status), ...lines(data.confidence).map((c) => `confidence ${c}`)];
      if (Array.isArray(data.files) && Array.isArray(data.deviations)) head.push(`${data.files.length} 个文件`, `${data.deviations.length} 处偏离`);
      if (Array.isArray(data.findings)) {
        const counts = SEVERITY.map((s) => [s, data.findings.filter((f) => f?.severity === s).length]).filter(([, n]) => n);
        const other = data.findings.length - counts.reduce((n, [, c]) => n + c, 0);
        if (other) counts.push(["其他", other]);
        head.push(data.findings.length ? counts.map(([s, n]) => `${n} ${s}`).join(", ") : "无问题");
      }
      return [head.join(" · "), ...lines(data.summary ?? data.judgment)].filter(Boolean).slice(0, 3).map(clip);
    }
  }
  // 跳过开头的标题行，取第一段；整篇只有标题时用第一个标题
  const paragraph = [];
  let heading = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (!paragraph.length && /^#{1,6}\s/.test(line)) {
      heading ??= line.replace(/^#{1,6}\s+/, "");
      continue;
    }
    paragraph.push(line);
  }
  return (paragraph.length ? paragraph : heading ? [heading] : []).slice(0, 3).map(clip);
}

// 运行记录的去留：没有定时任务，过了保留期后，下一次 codex-flow 跑完时删除
function retention(state) {
  const days = keepDaysOf(state);
  const until = new Date(Date.parse(state.endedAt ?? state.startedAt) + days * 86400000);
  const date = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")}`;
  return `保留 ${days} 天，${date} 之后下一次运行 codex-flow 时删除`;
}

export function renderSummary(dir, state) {
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
    // 有结果文件的失败任务，原因不在 tail 里，单独写一行
    const reason = t.result && t.error && t.status !== "completed" ? t.error : null;
    if (t.reused) tail += "（复用上次结果）";
    if (t.actualModel && t.actualModel !== t.model) tail += `  ⚠ 实际模型 ${t.actualModel}`;
    if (t.serviceTier && t.actualServiceTier && t.actualServiceTier !== t.serviceTier) tail += `  ⚠ 请求 Fast，实际 tier ${t.actualServiceTier}`;
    const fast = (t.actualServiceTier ?? t.serviceTier) === "priority" ? " ⚡" : "";
    lines.push(`${GLYPH[t.status] ?? "?"} ${t.label}${" ".repeat(width - cells(t.label))}  ${t.model} ${t.effort}${fast}  ${time.padStart(6)}  ${tail}`);
    const list = (files) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));
    if (reason) lines.push(`    ✗ ${reason}`);
    if (t.checkResults?.length && t.status === "completed") lines.push(`    验收 ${t.checkResults.length}/${t.checks?.length ?? t.checkResults.length} 通过`);
    if (t.scope?.outside?.length) lines.push(`    ⚠ 越界写入：${list(t.scope.outside)}`);
    if (t.scope?.unclaimed?.length) lines.push(`    · 工作区另有 ${t.scope.unclaimed.length} 处来源未定的变动（多半是 shell 命令或其他进程写的），清单见 state.json`);
    for (const line of isolationLines(t)) lines.push(`    ${line}`);
    for (const c of t.collisions ?? []) lines.push(`    ⚠ 和「${c.with}」同时改了：${list(c.files)}；先结束的那个验收时还没看到对方的改动，需要时重跑它`);
    if (t.reused && t.stale?.length) lines.push(`    ⚠ 复用的结果之后这些文件改过：${list(t.stale)}；要重跑加 --rerun ${t.label}`);
    if (t.staleRerun?.length) lines.push(`    上次结果之后这些文件改过，已重跑：${list(t.staleRerun)}`);
    if ((t.input?.upstream?.chars ?? 0) > INJECT_WARN) lines.push(`    注入上游结果 ${t.input.upstream.chars} 字，可改用 {{path:任务名}} 让 Codex 自己读`);
    let conclusion = [];
    try {
      conclusion = conclusionOf(dir, t);
    } catch {
      // 结论取不出来只少这几行，不影响汇总
    }
    for (const line of conclusion) lines.push(`    ${line}`);
  }
  for (const note of state.notes ?? []) lines.push(`⚠ ${note}`);
  lines.push(`运行目录: ${dir}（${retention(state)}）`);
  if (state.kind === "flow" && status !== "completed") lines.push(`续跑: node ${path.join(here, "codex-flow.mjs")} run --resume ${state.runId}`);
  return `${lines.join("\n")}\n`;
}
