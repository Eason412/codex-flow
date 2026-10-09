// 记录 git 工作区快照并核对写入范围，区分任务越界与来源未定的变动。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { touchedBy, checkWindows } from "./runtime.mjs";

const HASH_LIMIT = 8 << 20; // 超过 8MB 的文件用大小和修改时间代替内容摘要

// 删除的文件没法 realpath，就解析它所在的目录；macOS 的 /var 与 /private/var、符号链接目录靠这里对齐
export function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? path.resolve(file) : path.join(realPath(parent), path.basename(file));
  }
}

// 工作目录所在 git 仓库里未提交文件的状态和内容摘要；不在 git 里返回 null
export function gitSnapshot(cwd) {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const root = realPath(top.stdout.trim());
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (status.status !== 0) return null;
  const files = new Map();
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const file = path.join(root, entry.slice(3));
    // 改名记录后面跟着原路径，原路径按删除记
    if ((entry[0] === "R" || entry[0] === "C") && parts[i + 1]) files.set(path.join(root, parts[++i]), `${entry[0]}-from`);
    let digest = "missing";
    try {
      const stat = fs.statSync(file);
      digest = stat.size > HASH_LIMIT ? `${stat.size}:${stat.mtimeMs}` : crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    } catch {
      // 删除或读不到的文件只记状态
    }
    files.set(file, `${entry.slice(0, 2)}:${digest}`);
  }
  return files;
}

function changedFiles(before, after) {
  if (!before || !after) return [];
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
}

// 范围写法：相对任务工作目录的路径或 glob，也可以写绝对路径；写目录名包含其下所有文件，「.」表示整个工作目录，glob 也匹配点开头的文件。
// 先从声明本身找通配符，再拼 cwd；cwd 按字面处理，固定目录按 realpath 对齐。租约也用同一前缀。
export function scopePattern(raw, cwd) {
  const segments = path.normalize(raw).split(path.sep);
  const glob = segments.findIndex((s) => /[*?[\]{}]/.test(s));
  const prefix = glob < 0 ? raw : segments.slice(0, glob).join(path.sep) || (path.isAbsolute(raw) ? path.sep : ".");
  return { literal: realPath(path.resolve(cwd, prefix)), rest: glob < 0 ? "" : path.join(...segments.slice(glob)) };
}

export function inScope(file, patterns, cwd) {
  const base = realPath(cwd);
  const rel = path.relative(base, file);
  const undot = (p) => p.replace(/(^|\/)\./g, "$1\u0000");
  return patterns.some((raw) => {
    const { literal, rest } = scopePattern(raw, cwd);
    const p = path.relative(base, path.join(literal, rest));
    return (p === "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
      || rel === p || rel.startsWith(`${p}/`) || path.matchesGlob(undot(rel), undot(p));
  });
}

// 越界：Codex 自己的改文件记录里出现了范围外的路径，确定是这个任务写的。
// 来源未定：同一时段 git 工作区里范围外的变动，没有改文件记录，也不在同时运行的其他任务的范围里（可能是 shell 命令或其他任务的验收命令写的）
export function scopeReport(state, task, cwd, touched, before, after) {
  const show = (file) => path.relative(realPath(cwd), file) || ".";
  const outside = [...touched].filter((file) => !inScope(file, task.writes, cwd));
  const start = Date.parse(task.startedAt);
  const others = state.tasks.filter((t) => t !== task && t.writes && t.startedAt && (!t.endedAt || Date.parse(t.endedAt) >= start));
  const claimed = (file) => others.some((t) => inScope(file, t.writes, t.cwd ?? state.cwd))
    || state.tasks.some((t) => t !== task && touchedBy.get(t.label)?.has(file));
  const unclaimed = changedFiles(before, after).filter((file) => !touched.has(file) && !inScope(file, task.writes, cwd) && !claimed(file));
  const duringChecks = unclaimed.length > 0 && checkWindows.some((w) => w.label !== task.label && (w.end ?? Infinity) >= start);
  if (!outside.length && !unclaimed.length) return null;
  return { outside: outside.map(show).sort(), unclaimed: unclaimed.map(show).sort(), ...(duringChecks ? { duringChecks } : {}) };
}
