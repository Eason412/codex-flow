// 隔离任务留下的成果分支、worktree 和 V0.3 的私有引用（refs/codex-flow/<runId>/…）的删除：任务收尾、clean 命令和过期运行记录清理共用。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { viaLink } from "./workspace.mjs";

export const git = (cwd, args, { env, ...options } = {}) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...env }, ...options });

export const isLink = (file) => !!fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink();

const MARK = "codex-flow"; // worktree 私有 git 目录（<仓库>/.git/worktrees/<名字>）里的标记文件，内容是 runId

function gitDirOf(wt) {
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(wt, ".git"), "utf8"));
    return m ? path.resolve(wt, m[1].trim()) : null;
  } catch {
    return null;
  }
}

export function markWorktree(wt, runId) {
  const dir = gitDirOf(wt);
  if (dir) fs.writeFileSync(path.join(dir, MARK), runId);
}

function marked(wt, runId) {
  const dir = gitDirOf(wt);
  try {
    return !!dir && fs.readFileSync(path.join(dir, MARK), "utf8").trim() === runId;
  } catch {
    return false;
  }
}

// 删 worktree：先只 unlink 受管链接（不跟随；上级被换成链接的跳过，免得沿链接删到主工作区里），再解锁、注销、删目录；
// git 和 rmSync 本身也不跟随符号链接。
// 这次运行的最后一个 worktree 删掉后，顺手删空的上级目录
export function removeWorktree(repo, wt, links = []) {
  for (const rel of links) if (!viaLink(wt, rel) && isLink(path.join(wt, rel))) fs.unlinkSync(path.join(wt, rel));
  git(repo, ["worktree", "unlock", wt]);
  git(repo, ["worktree", "remove", "--force", wt]);
  fs.rmSync(wt, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(wt));
  } catch {
    // 还有其他保留的 worktree
  }
}

// 删掉某个前缀下的全部私有引用（前缀按整段匹配），返回删掉的个数
export function dropRefs(repo, prefix) {
  const listed = git(repo, ["for-each-ref", "--format=%(refname)", prefix]);
  const refs = listed.status === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
  if (refs.length) git(repo, ["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") });
  return refs.length;
}

// 删掉一次运行的成果分支（只删仍停在成果提交上的，之后有新提交的留下）、V0.3 的私有引用和残留 worktree（只删带本运行标记的），
// 返回 { branches, kept, worktrees }
export function cleanArchives(state, worktreesRoot) {
  const runId = state.runId;
  const tasks = state.tasks ?? [];
  let branches = 0;
  const kept = [];
  for (const t of tasks) {
    const b = t.branch;
    if (!b?.tip || !fs.existsSync(b.repo)) continue;
    const ref = `refs/heads/${b.name}`;
    const now = git(b.repo, ["rev-parse", "--verify", "-q", ref]).stdout.trim();
    if (now === b.tip) {
      // 带旧值删除：比较和删除一步完成，期间有人提交就删不掉
      if (git(b.repo, ["update-ref", "-d", ref, b.tip]).status === 0) branches++;
      else kept.push(b.name);
    } else if (now) kept.push(b.name);
  }
  for (const repo of new Set(tasks.flatMap((t) => [t.merge?.repo, t.worktree?.repo]).filter(Boolean))) {
    if (fs.existsSync(repo)) dropRefs(repo, `refs/codex-flow/${runId}`);
  }
  const links = new Map(tasks.filter((t) => t.worktree).map((t) => [t.worktree.path, t.worktree.links ?? []]));
  const base = path.join(worktreesRoot, runId);
  let worktrees = 0;
  for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const wt = path.join(base, name);
    if (!marked(wt, runId)) continue;
    const common = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
    removeWorktree(common || wt, wt, links.get(wt));
    worktrees++;
  }
  return { branches, kept, worktrees };
}
