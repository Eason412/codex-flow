// 写入租约：写入范围重叠的任务不同时运行，后开始的排队等前一个结束（效果等于给它们加了 after）。
// 只有声明了非空 writes 的任务有租约；没写 writes 的任务范围不明，照常并行，只在开始时提示（见 overlapNotes）
import path from "node:path";
import { realPath } from "./scope.mjs";

// 写入范围换成绝对路径前缀：glob 取通配符之前的目录部分，宁可多算重叠也不漏
export function leaseOf(writes, cwd) {
  if (!Array.isArray(writes) || !writes.length) return null;
  return writes.map((raw) => {
    const segments = path.resolve(cwd, raw).split(path.sep);
    const glob = segments.findIndex((s) => /[*?[\]{}]/.test(s));
    return realPath(glob < 0 ? segments.join(path.sep) : segments.slice(0, glob).join(path.sep) || path.sep);
  });
}

const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

// 两个租约重叠的部分（取较深的路径）；任一方没有租约算不重叠
export function overlapOf(a, b) {
  if (!a || !b) return [];
  const out = new Set();
  for (const x of a) {
    for (const y of b) {
      if (within(x, y)) out.add(x);
      else if (within(y, x)) out.add(y);
    }
  }
  return [...out].sort();
}

// 运行中的租约。调度器开任务前问 blockers，没有才 hold，任务结束时 release 后调度器再看排队的任务
export class Leases {
  constructor() {
    this.held = new Map();
  }

  blockers(lease, self = null) {
    if (!lease) return [];
    const names = [];
    for (const [name, held] of this.held) if (name !== self && overlapOf(held, lease).length) names.push(name);
    return names;
  }

  hold(name, lease) {
    if (lease) this.held.set(name, lease);
  }

  release(name) {
    this.held.delete(name);
  }
}

export const leases = new Leases();

// 开始时的提示：可能同时运行（谁也不是谁的直接或间接前置）的两个非隔离任务，
// 范围重叠的会依次运行；一个有写入范围、另一个没写 writes 且目录相交的，可能改到同一处
export function overlapNotes(tasks, deps) {
  const ancestors = new Map();
  const above = (label) => {
    if (!ancestors.has(label)) {
      const set = new Set();
      for (const dep of deps.get(label) ?? []) {
        set.add(dep);
        for (const a of above(dep)) set.add(a);
      }
      ancestors.set(label, set);
    }
    return ancestors.get(label);
  };
  const runs = tasks.filter((t) => t.isolation !== "worktree").map((t) => ({ t, lease: leaseOf(t.writes, t.cwd), root: [realPath(t.cwd)] }));
  const notes = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const [a, b] = [runs[i], runs[j]];
      if (above(a.t.label).has(b.t.label) || above(b.t.label).has(a.t.label)) continue;
      const names = `「${a.t.label}」「${b.t.label}」`;
      const both = overlapOf(a.lease, b.lease);
      if (both.length) {
        notes.push(`${names}写入范围重叠（${both.map((p) => path.relative(realPath(a.t.cwd), p) || ".").join("、")}），将依次运行；要同时运行就给它们加 isolation`);
        continue;
      }
      const [known, unknown] = a.lease && b.t.writes === undefined ? [a, b] : b.lease && a.t.writes === undefined ? [b, a] : [];
      if (known && overlapOf(known.lease, unknown.root).length) {
        notes.push(`「${unknown.t.label}」没写 writes，可能和「${known.t.label}」改到同一处；写明 writes（只读写 []），或加 isolation`);
      }
    }
  }
  return notes;
}
