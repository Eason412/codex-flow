// 工作区内容快照：把 git 工作区当前内容（含未提交、未跟踪但未被忽略的文件）写成一个 tree，
// 续跑判断结果是否过期、隔离任务同步和合回都比较这个 tree。写入的对象没有引用，会被 git gc 回收
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realPath } from "./scope.mjs";

const git = (cwd, args, env, input) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 1 << 28, input, env: env ? { ...process.env, ...env } : process.env });

// 工作目录所在 git 仓库的根目录（realpath）；不在 git 里返回 null
export function gitRoot(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.status === 0 ? realPath(top.stdout.trim()) : null;
}

// rel 的某一级上级是符号链接或不是目录（不存在的不算）：沿这条路径读写会跟着链接走出 root
export function viaLink(root, rel) {
  let dir = root;
  for (const part of path.dirname(rel).split(path.sep)) {
    if (!part || part === ".") continue;
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory()) return true;
  }
  return false;
}

// 用临时 index 记下工作区内容，不碰仓库自己的 index。先复制原 index，沿用其中的文件状态缓存，未改的文件不用重新读。
// 副本保留原 index 的修改时间：git 按 index 的时间判断哪些文件可能和 index 同一时刻写过、要重新读内容，复制不改变这个口径。
// keep 是基准快照：基准里有、磁盘上仍在、只因被忽略而没进快照的文件强制加回（主工作区强制暂存的被忽略文件，
// 同步进 worktree 后 index 重置为 HEAD，不加回就会被当成删除合回去）
export function contentTree(root, keep = null) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-flow-index-"));
  const index = path.join(tmp, "index");
  try {
    const own = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).stdout.trim();
    if (own && fs.existsSync(own)) {
      fs.copyFileSync(own, index);
      const { atime, mtime } = fs.statSync(own);
      fs.utimesSync(index, atime, mtime);
    }
    const env = { GIT_INDEX_FILE: index };
    if (git(root, ["add", "-A", "--", "."], env).status !== 0) return null;
    let tree = git(root, ["write-tree"], env);
    if (tree.status !== 0) return null;
    if (keep) {
      const gone = git(root, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--diff-filter=D", keep, tree.stdout.trim()]).stdout.split("\0").filter(Boolean)
        .filter((rel) => !viaLink(root, rel) && fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory() === false);
      if (gone.length) {
        if (git(root, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], env, `${gone.join("\0")}\0`).status !== 0) return null;
        tree = git(root, ["write-tree"], env);
        if (tree.status !== 0) return null;
      }
    }
    return tree.stdout.trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 两个快照之间改过的文件（绝对路径，含删除和改名两端）；任一快照缺失或比较失败返回 null
export function changedBetween(root, from, to) {
  if (!from || !to) return null;
  if (from === to) return [];
  const diff = git(root, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"]);
  if (diff.status !== 0) return null;
  return diff.stdout.split("\0").filter(Boolean).map((rel) => path.join(root, rel));
}
