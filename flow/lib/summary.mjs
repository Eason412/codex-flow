// 根据运行状态与结果文件生成终端汇总和任务结论，统一阶段及整体状态口径。
import fs from "node:fs";
import path from "node:path";
import { effectiveStatus, elapsedSeconds, formatDuration } from "./state.mjs";
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
    if (t.reused) tail += "（复用上次结果）";
    if (t.actualModel && t.actualModel !== t.model) tail += `  ⚠ 实际模型 ${t.actualModel}`;
    if (t.serviceTier && t.actualServiceTier && t.actualServiceTier !== t.serviceTier) tail += `  ⚠ 请求 Fast，实际 tier ${t.actualServiceTier}`;
    const fast = (t.actualServiceTier ?? t.serviceTier) === "priority" ? " ⚡" : "";
    lines.push(`${GLYPH[t.status] ?? "?"} ${t.label}${" ".repeat(width - cells(t.label))}  ${t.model} ${t.effort}${fast}  ${time.padStart(6)}  ${tail}`);
    const list = (files) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));
    if (t.checkResults?.length && t.status === "completed") lines.push(`    验收 ${t.checkResults.length}/${t.checks?.length ?? t.checkResults.length} 通过`);
    if (t.scope?.outside?.length) lines.push(`    ⚠ 越界写入：${list(t.scope.outside)}`);
    if (t.scope?.unclaimed?.length) lines.push(`    ⚠ 范围外变动，来源未定${t.scope.duringChecks ? "（期间有其他任务在跑验收）" : ""}：${list(t.scope.unclaimed)}`);
    for (const line of isolationLines(t)) lines.push(`    ${line}`);
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
