// 执行器的运行环境与共享状态；各职责模块在这里登记进程和保存当前 flow。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statePath, writeJson } from "./state.mjs";

export const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SESSION = process.env.CLAUDE_CODE_SESSION_ID || null;
// 提醒阈值写进 state，mod 按它提醒；不设时 mod 用 15 分钟
export const ALERT_AFTER = Number(process.env.CODEX_FLOW_ALERT_AFTER) || null;
export const fileSafe = (label) => label.replace(/[\/\\:*?"<>|\s]+/g, "_");

export function die(message, code = 2) {
  process.stderr.write(`[codex-flow] ${message}\n`);
  process.exit(code);
}

export const servers = new Set();
export const checkProcs = new Set();
export const touchedBy = new Map(); // 任务名 → Codex 改文件记录里的路径，判断范围外变动来自哪个任务
export const checkWindows = []; // 验收命令运行的时段，验收产物可能被同时段的其他任务看成范围外变动
export let current = null; // { dir, state }
// 整个 flow 收到停止信号后为 true：不再合回、不再重新验收，已记为停止的任务不被之后结束的验收改成失败
export let stopping = false;
export function markStopping() {
  stopping = true;
}

export function setCurrent(dir, state) {
  current = { dir, state };
}

export function save() {
  if (current) writeJson(statePath(current.dir), current.state);
}
