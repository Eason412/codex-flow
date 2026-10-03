// 运行目录和状态文件：执行器、run.sh、状态行脚本和 mod 共用同一种格式。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const HOME = process.env.CODEX_FLOW_HOME || path.join(os.homedir(), ".claude", "codex-flow");
export const RUNS = path.join(HOME, "runs");
export function readModelConfig(file = fileURLToPath(new URL("../../models.json", import.meta.url))) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取模型名单 ${file}: ${error.message}`);
  }
  const valid = (values) => Array.isArray(values) && values.length > 0 &&
    values.every((value) => typeof value === "string" && value.trim() === value && value.length > 0) &&
    new Set(values).size === values.length;
  if (!config || !valid(config.models) || !valid(config.efforts)) {
    throw new Error(`模型名单格式错误: ${file}（models 和 efforts 必须是非空、不重复的字符串数组）`);
  }
  return config;
}

// 只在执行前校验时读取；查看状态和状态行不依赖模型名单。
export function checkModelEffort(model, effort, label) {
  const { models, efforts } = readModelConfig();
  if (!models.includes(model)) throw new Error(`任务「${label}」的模型 ${model} 不在允许范围: ${models.join(" / ")}`);
  if (!efforts.includes(effort)) throw new Error(`任务「${label}」的 effort ${effort} 不在允许范围: ${efforts.join(" / ")}`);
}

export const nowIso = () => new Date().toISOString();

export function newRunId(prefix = "r") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export const runDir = (runId) => path.join(RUNS, runId);
export const statePath = (dir) => path.join(dir, "state.json");

// 先写临时文件再改名，读的一方不会读到半截 JSON
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// 状态写着 running 但进程已经不在：被强杀或崩溃
export function effectiveStatus(state) {
  if (state.status === "running" && !isAlive(state.pid)) return "lost";
  return state.status;
}

// 列出运行记录，新的在前；sinceMs 用目录修改时间先粗筛，状态行每几秒调用一次，要快
export function listRuns({ session = null, sinceMs = null } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(RUNS);
  } catch {
    return [];
  }
  const now = Date.now();
  const runs = [];
  for (const name of names) {
    const dir = path.join(RUNS, name);
    if (sinceMs !== null) {
      try {
        if (now - fs.statSync(dir).mtimeMs > sinceMs) continue;
      } catch {
        continue;
      }
    }
    const state = readJson(statePath(dir));
    if (!state) continue;
    if (session && state.session !== session) continue;
    runs.push({ dir, state });
  }
  return runs.sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)));
}

export function elapsedSeconds(startedAt, endedAt = null) {
  if (!startedAt) return 0;
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export const shortModel = (model) => String(model || "").replace(/^gpt-/, "");

export function briefOf(text, limit = 80) {
  const line = String(text || "").trim().split("\n").find((l) => l.trim()) || "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export const promptHash = (task) =>
  crypto.createHash("sha256").update(JSON.stringify([task.prompt, task.model, task.effort, task.schema ?? null])).digest("hex").slice(0, 16);

// 删掉 7 天前结束的记录、开始超过 7 天且进程已不在的记录，以及超过 7 天未登记的目录
export function pruneOldRuns(days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const expired = (state) => !isAlive(state.pid) && Date.parse(state.endedAt || state.startedAt) < cutoff;
  for (const entry of fs.existsSync(RUNS) ? fs.readdirSync(RUNS, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(RUNS, entry.name);
    const file = statePath(dir);
    const state = readJson(file);
    if (state) {
      if (!expired(state)) continue;
      // 续跑可能在取得候选记录后更新状态；删除前重读并重新检查 PID 和时间。
      const latest = readJson(file);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(state) || !expired(latest)) continue;
    } else {
      // 只清理没有 state.json 的旧目录；损坏或暂时读不到的状态文件不算未登记。
      try {
        if (fs.existsSync(file) || fs.statSync(dir).mtimeMs >= cutoff) continue;
      } catch {
        continue;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // mod 给状态行写的面板记录，一个会话一个
  for (const name of fs.existsSync(HOME) ? fs.readdirSync(HOME) : []) {
    const file = path.join(HOME, name);
    if (/^panel-.+\.json$/.test(name) && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}
