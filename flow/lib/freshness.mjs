// 续跑时判断复用的结果是否过期：每次运行结束记下各 git 仓库的内容快照，续跑时找出这期间改过的文件，
// 再按任务关心的文件决定重跑还是只提示。比较的是内容，提交、切分支本身不算改动
import fs from "node:fs";
import path from "node:path";
import { changedBetween, contentTree, gitRoot } from "./workspace.mjs";
import { inScope, realPath } from "./scope.mjs";
import { sha1 } from "./plan.mjs";

// flow 实际用到的目录：各任务的 cwd，没写的用 flow 的 cwd（任务都写了自己的 cwd 时，flow 的 cwd 不算）
export const flowCwds = (cwd, tasks) => [...new Set(tasks.length ? tasks.map((t) => t.cwd ?? cwd) : [cwd])];

// 运行结束（含被停止）时调用：仓库根 → 快照 tree；不在 git 里的目录记 null
export function snapshotWorkspace(cwds) {
  const workspace = {};
  for (const cwd of cwds) {
    const root = gitRoot(cwd);
    if (!root) workspace[realPath(cwd)] = null;
    else if (!(root in workspace)) workspace[root] = contentTree(root);
  }
  return workspace;
}

// 上次结束以来改过的文件（绝对路径）。无法比较的目录（不在 git 里、上次没记快照、旧快照已被回收）收进 unknown
export function changesSince(previous, cwds) {
  const changed = new Set();
  const unknown = new Set();
  const seen = new Set();
  for (const cwd of cwds) {
    const root = gitRoot(cwd);
    const before = root ? previous?.workspace?.[root] : null;
    if (!before) {
      unknown.add(root ?? realPath(cwd));
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    const files = changedBetween(root, before, contentTree(root));
    if (files) for (const file of files) changed.add(file);
    else unknown.add(root);
  }
  return { changed, unknown: [...unknown] };
}

// 任务关心、且上次结束后改过的文件（相对任务 cwd）。写了 reads 按 reads；只读任务（writes: []）关心整个工作目录；
// 有写入范围的关心自己的 writes；没写 writes 的无从判断，返回空
export function staleFiles(t, cwd, changed) {
  if (!changed.size) return [];
  const base = realPath(cwd);
  const rel = (file) => path.relative(base, file);
  let hits;
  if (t.reads?.length) hits = [...changed].filter((f) => inScope(f, t.reads, cwd));
  else if (Array.isArray(t.writes) && t.writes.length) hits = [...changed].filter((f) => inScope(f, t.writes, cwd));
  else if (Array.isArray(t.writes)) hits = [...changed].filter((f) => !rel(f).startsWith(".."));
  else return [];
  return hits.map(rel).sort();
}

// 不带计划文件续跑时用运行目录里存的计划；它引入的文件之后改过，就要提醒存的仍是旧内容
export function changedSources(plan) {
  const out = new Set();
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      for (const source of task.sources ?? []) {
        let now = null;
        try {
          now = sha1(fs.readFileSync(source.path, "utf8"));
        } catch {
          // 读不到也算改过
        }
        if (now !== source.sha1) out.add(source.path);
      }
    }
  }
  return [...out];
}
