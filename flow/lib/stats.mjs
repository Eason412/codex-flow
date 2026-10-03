// stats 命令：按任务列出任务说明的组成、token 用量、回报大小和验收，末尾合计；--json 给统计脚本用。
import { effectiveStatus, elapsedSeconds, formatDuration, readJson, runDir, statePath } from "./state.mjs";
import { die } from "./runtime.mjs";
import { WORD } from "./summary.mjs";

const PARTS = [["instruction", "指令"], ["files", "资料"], ["upstream", "上游"], ["contract", "约束"], ["schema", "schema"]];
const GLYPH = { completed: "✓", failed: "✗", cancelled: "■", skipped: "○", pending: "○", running: "●" };

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const cells = (text) => [...text].reduce((n, c) => n + (c.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);

function taskStats(t) {
  const passed = (t.checkResults ?? []).filter((r) => r.code === 0 && !r.reason).length;
  return {
    label: t.label,
    phase: t.phase,
    status: t.status,
    model: t.model,
    effort: t.effort,
    reused: !!t.reused,
    durationSeconds: t.startedAt ? elapsedSeconds(t.startedAt, t.endedAt) : null,
    input: t.input ?? null,
    tokens: t.tokens ?? null,
    context: t.context ?? null,
    output: t.output ?? null,
    report: t.report ?? null,
    checks: t.checks?.length ? { passed, total: t.checks.length } : null,
  };
}

export function flowStats(state) {
  const tasks = state.tasks.map(taskStats);
  // 复用的任务这次没有调用 Codex，不计入用量合计
  const ran = tasks.filter((t) => !t.reused);
  const sum = (list, get) => list.reduce((n, t) => n + (get(t) ?? 0), 0);
  return {
    runId: state.runId,
    name: state.name,
    status: effectiveStatus(state),
    durationSeconds: elapsedSeconds(state.startedAt, state.endedAt),
    tasks,
    total: {
      tasks: tasks.length,
      reused: tasks.length - ran.length,
      input: { chars: sum(ran, (t) => t.input?.total.chars), estTokens: sum(ran, (t) => t.input?.total.estTokens) },
      tokens: sum(ran, (t) => t.tokens),
      output: sum(ran, (t) => t.output),
      reportChars: sum(tasks, (t) => t.report?.chars),
    },
  };
}

function inputLine(input) {
  if (!input) return "说明 -";
  const total = input.total.chars || 1;
  const parts = PARTS.filter(([key]) => input[key]?.chars).map(([key, name]) => `${name} ${Math.round((input[key].chars / total) * 100)}%`);
  return `说明 ${compact(input.total.chars)} 字≈${compact(input.total.estTokens)} tok（${parts.join(" ")}）`;
}

export function renderStats(stats) {
  const lines = [`[codex-flow] 统计 · ${stats.name} · ${stats.runId} · ${WORD[stats.status] ?? stats.status} · ${formatDuration(stats.durationSeconds)}`];
  const width = Math.max(...stats.tasks.map((t) => cells(t.label)));
  for (const t of stats.tasks) {
    const cols = [
      `${GLYPH[t.status] ?? "?"} ${t.label}${" ".repeat(width - cells(t.label))}`,
      (t.durationSeconds === null ? "-" : formatDuration(t.durationSeconds)).padStart(6),
      inputLine(t.input),
      t.tokens === null ? "用量 -" : `用量 ${compact(t.tokens)}（上下文 ${compact(t.context ?? 0)} 输出 ${compact(t.output ?? 0)}）`,
      t.report ? `回报 ${compact(t.report.chars)} 字${t.report.fields !== undefined ? ` ${t.report.fields} 个字段` : ""}` : "回报 -",
    ];
    if (t.checks) cols.push(`验收 ${t.checks.passed}/${t.checks.total}`);
    if (t.reused) cols.push("复用");
    lines.push(cols.join("  "));
  }
  const { total } = stats;
  lines.push(`合计 ${total.tasks} 个任务${total.reused ? `（${total.reused} 个复用，不计用量）` : ""} · 说明 ${compact(total.input.chars)} 字≈${compact(total.input.estTokens)} tok · 用量 ${compact(total.tokens)}（输出 ${compact(total.output)}） · 回报 ${compact(total.reportChars)} 字`);
  lines.push("说明的 token 是按字数估算的（中文 1 字 1 token，其余 4 字符 1 token），用量是 Codex 回报的实际值");
  return `${lines.join("\n")}\n`;
}

export function cmdStats({ flags, positionals }) {
  const runId = positionals[0];
  if (!runId) die("用法: stats <runId> [--json]");
  const state = readJson(statePath(runDir(runId)));
  if (!state) die(`找不到运行记录: ${runId}`);
  if (state.kind !== "flow") die(`${runId} 不是 flow 运行记录`);
  const stats = flowStats(state);
  process.stdout.write(flags.json ? `${JSON.stringify(stats, null, 2)}\n` : renderStats(stats));
}
