#!/usr/bin/env node
// ccstatusline 的 custom-command：读 Claude Code 传入的 JSON，输出本会话 Codex 任务的一行进度；没有任务时什么都不输出，这一行就不显示。
// 输入框上方的 Codex 面板显示时也不输出，免得同一件事显示两遍（面板由 mod 写 panel-<会话>.json）。
import fs from "node:fs";
import path from "node:path";
import { HOME, effectiveStatus, elapsedSeconds, formatDuration, listRuns, shortModel } from "./lib/state.mjs";

// 配色取自用户 ccstatusline 的设置（Tokyo Night）
const rgb = (hex) => {
  const n = parseInt(hex, 16);
  return (s) => `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}\x1b[39m`;
};
const dim = rgb("565F89");
const fg = rgb("A9B1D6");
const blue = rgb("7AA2F7");
const purple = rgb("BB9AF7");
const cyan = rgb("7DCFFF");
const green = rgb("9ECE6A");
const red = rgb("F7768E");
const RECENT_SECONDS = 30;

let session = null;
try {
  session = JSON.parse(fs.readFileSync(0, "utf8")).session_id ?? null;
} catch {
  // 没有输入时按无会话处理
}
if (!session) process.exit(0);
try {
  if (JSON.parse(fs.readFileSync(path.join(HOME, `panel-${session}.json`), "utf8")).shown) process.exit(0);
} catch {
  // 没有面板记录时照常显示
}

// 和面板一致：flow 紫色，单个 agent 蓝色
const nameOf = (state) => (state.kind === "single" ? blue : purple)(state.name);

// 和面板一致：flow 排在单个 agent 前面，同类里新的在前
const rank = (state) => (state.kind === "single" ? 1 : 0);
const items = [];
for (const { state } of listRuns({ session, sinceMs: 2 * 86400000 }).sort((a, b) => rank(a.state) - rank(b.state))) {
  const status = effectiveStatus(state);
  const sinceEnd = state.endedAt ? elapsedSeconds(state.endedAt) : 0;
  if (status !== "running" && sinceEnd > RECENT_SECONDS) continue;
  const elapsed = formatDuration(elapsedSeconds(state.startedAt, state.endedAt));
  if (status === "running") {
    if (state.kind === "single") {
      const t = state.tasks[0];
      items.push({ running: true, seconds: elapsedSeconds(state.startedAt), text: `${cyan("●")} ${nameOf(state)} ${dim(`${shortModel(t.model)} ${elapsed}`)}` });
    } else {
      const phase = state.phases.find((p) => p.status === "running") ?? state.phases.at(-1);
      const inPhase = state.tasks.filter((t) => t.phase === phase.title);
      const done = inPhase.filter((t) => t.status === "completed").length;
      items.push({ running: true, seconds: elapsedSeconds(state.startedAt), text: `${cyan("●")} ${nameOf(state)} ${dim("·")} ${fg(`${phase.title} ${done}/${inPhase.length}`)} ${dim(`· ${elapsed}`)}` });
    }
  } else if (status === "completed" || status === "partial") {
    items.push({ running: false, text: `${green("✓")} ${nameOf(state)} ${dim(status === "partial" ? `部分完成 · ${elapsed}` : elapsed)}` });
  } else {
    const word = status === "cancelled" ? "已停止" : status === "lost" ? "已退出" : "失败";
    items.push({ running: false, text: `${red("✗")} ${nameOf(state)} ${red(word)}` });
  }
}
if (!items.length) process.exit(0);

const running = items.filter((i) => i.running);
let shown = items;
if (items.length > 2 && running.length) {
  // 多于两项时收成一句，刚结束的不再单列
  const longest = formatDuration(Math.max(...running.map((i) => i.seconds)));
  shown = [{ text: `${cyan("●")} ${fg(`${running.length} 个运行中`)} ${dim(`· 最长 ${longest}`)}` }];
}
process.stdout.write(`${dim("codex")}  ${shown.map((i) => i.text).join(` ${dim("│")} `)}`);
