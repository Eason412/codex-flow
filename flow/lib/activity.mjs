// 将 app-server 通知整理成面板最近步骤与累计数，保留原来的命令和路径显示。
import path from "node:path";
import { realPath } from "./scope.mjs";

const RECENT_LIMIT = 8;
export const oneLine = (text, limit = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

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

export class TaskActivity {
  constructor(task) {
    this.task = task;
    this.dirty = false;
    task.recent = [];
    task.activity = { commands: 0, edits: 0, messages: 0 };
    delete task.turnEnded;
  }

  note(entry) {
    const task = this.task;
    const old = entry.id ? task.recent.find((e) => e.id === entry.id) : null;
    if (old) Object.assign(old, entry);
    else task.recent = [...task.recent, entry].slice(-RECENT_LIMIT);
    this.dirty = true;
  }

  record(method, item, cwd) {
    const step = activityOf(method, item, cwd);
    if (step) {
      if (method === "item/completed") {
        if (item.type === "commandExecution") this.task.activity.commands++;
        if (item.type === "fileChange" && item.status === "completed") this.task.activity.edits++;
        if (item.type === "agentMessage") this.task.activity.messages++;
      }
      this.note(step);
    }
  }
}
