// 写入租约：写入范围重叠的任务不同时运行，后开始的排队等前一个结束；隔离任务合回主工作区时也按改动文件取租约。
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

// 运行中的租约和排队中的合回。调度器开任务前问 blockers，没有才 hold；合回用 acquire 排队，按先来后到唤醒。
// blockers 也算上排队中的合回，免得新任务不断插队让合回一直等
export class Leases {
  constructor() {
    this.held = new Map();
    this.queue = [];
  }

  blockers(lease, self = null) {
    if (!lease) return [];
    const names = [];
    for (const [name, held] of this.held) if (name !== self && overlapOf(held, lease).length) names.push(name);
    for (const w of this.queue) if (w.name !== self && overlapOf(w.lease, lease).length) names.push(w.name);
    return names;
  }

  hold(name, lease) {
    if (lease) this.held.set(name, lease);
  }

  release(name) {
    if (this.held.delete(name)) this.wake();
  }

  acquire(name, lease) {
    if (!lease) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ name, lease, resolve });
      this.wake();
    });
  }

  wake() {
    for (let i = 0; i < this.queue.length; i++) {
      const w = this.queue[i];
      const busy = [...this.held.values()].some((held) => overlapOf(held, w.lease).length)
        || this.queue.slice(0, i).some((ahead) => overlapOf(ahead.lease, w.lease).length);
      if (busy) continue;
      this.queue.splice(i--, 1);
      this.held.set(w.name, w.lease);
      w.resolve();
    }
  }
}

export const leases = new Leases();
