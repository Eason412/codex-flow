// 实际碰撞：声明的写入范围可能不准。两个运行时段重叠的非隔离任务，Codex 改文件记录里出现同一个文件，就在两边都记下，
// 先结束的那个当时的验收没看到后者的改动，需要在主工作区重新验收。shell 命令写的文件没有归属记录，这里查不到
import path from "node:path";
import { touchedBy } from "./runtime.mjs";
import { realPath } from "./scope.mjs";

function note(state, task, other, files) {
  const base = realPath(task.cwd ?? state.cwd);
  const rel = files.map((file) => path.relative(base, file) || ".");
  task.collisions ??= [];
  const entry = task.collisions.find((c) => c.with === other);
  if (entry) entry.files = [...new Set([...entry.files, ...rel])].sort();
  else task.collisions.push({ with: other, files: rel.sort() });
}

// 任务结束时调用，返回需要重新验收的任务：已经先结束、完成了、有验收命令的碰撞对象
export function recordCollisions(state, task) {
  const mine = touchedBy.get(task.label);
  // 隔离任务的组合由三方合回和合回后再验收负责，不在这里算
  if (!mine?.size || task.isolation === "worktree" || !task.startedAt) return [];
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : Date.now();
  const recheck = [];
  for (const other of state.tasks) {
    if (other === task || other.isolation === "worktree" || !other.startedAt) continue;
    const otherEnd = other.endedAt ? Date.parse(other.endedAt) : Infinity;
    if (Date.parse(other.startedAt) > end || otherEnd < start) continue;
    const theirs = touchedBy.get(other.label);
    const files = theirs ? [...mine].filter((file) => theirs.has(file)) : [];
    if (!files.length) continue;
    note(state, task, other.label, files);
    note(state, other, task.label, files);
    if (other.endedAt && other.status === "completed" && other.checks?.length) recheck.push(other);
  }
  return recheck;
}
