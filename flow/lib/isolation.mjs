// 隔离任务（isolation: "worktree"）的生命周期，做法同 Claude Workflow：在 $CODEX_FLOW_HOME/worktrees/<runId>/<任务名> 建 worktree 运行，
// 验收也在里面跑；结束时有改动就把成果存成分支 codex-flow/<runId>/<任务名>，不合回主工作区，由 Claude 看过后自己合。
// 没有改动就什么都不留；worktree 目录默认删掉（写了 keepWorktree 或存不下成果时保留），成果在分支上
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, isAlive, readJson, runDir, statePath, writeJson } from "./state.mjs";
import { current, die, save } from "./runtime.mjs";
import { changedBetween, contentTree, gitRoot, viaLink } from "./workspace.mjs";
import { inScope, realPath } from "./scope.mjs";
import { cleanArchives, deleteBranch, git, isSymbolic, removeWorktree } from "./archive.mjs";
import { envToMain, materialize, must } from "./worktree.mjs";

const WORKTREES = path.join(HOME, "worktrees");
// 包快照用固定身份，不依赖仓库的 user 配置
const IDENTITY = { GIT_AUTHOR_NAME: "codex-flow", GIT_AUTHOR_EMAIL: "codex-flow@localhost", GIT_COMMITTER_NAME: "codex-flow", GIT_COMMITTER_EMAIL: "codex-flow@localhost" };
const list = (files) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));
// 目录名和分支名共用：只留文字、数字、下划线和连字符，分支名里不合法的字符都换掉
export const nameOf = (label) => label.replace(/[^\p{L}\p{N}_-]+/gu, "_");
export const branchOf = (runId, label) => `codex-flow/${runId}/${nameOf(label)}`;
const tipMessage = (runId, label) => `codex-flow ${runId} ${label}`;
// 汇总里的命令整行复制就能运行：路径和分支名按 shell 规则加引号
const sh = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

// 运行中的隔离任务：被停止时（onStop 在打印汇总前调用 closeActive）和进程退出时补存成果、收尾，再存一次状态
const active = new Set();
export function closeActive() {
  if (!active.size) return;
  for (const iso of [...active]) {
    try {
      closeWorktree(iso.task, iso);
    } catch {
      // 收尾失败也不影响停止
    }
  }
  save();
}
process.on("exit", closeActive);

// 能否隔离：只支持 git，仓库里有已初始化的子模块时不支持。能隔离返回 null，否则返回原因
export function isolationBlocker(cwd) {
  const root = gitRoot(cwd);
  if (!root) return `${cwd} 不在 git 仓库里：隔离只支持 git`;
  if (git(root, ["rev-parse", "--verify", "-q", "HEAD"]).status !== 0) return `仓库 ${root} 还没有提交，隔离要从一个提交建 worktree`;
  const staged = git(root, ["ls-files", "-s", "-z"]).stdout.split("\0");
  const modules = staged.filter((e) => e.startsWith("160000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
  const live = modules.filter((rel) => fs.existsSync(path.join(root, rel, ".git")));
  return live.length ? `仓库 ${root} 有已初始化的子模块（${list(live)}），隔离暂不支持子模块` : null;
}

// 计划任务里与隔离有关、要记进运行状态的字段
export const isolationFields = (t) => (t.isolation ? { isolation: t.isolation, ...(t.keepWorktree ? { keepWorktree: true } : {}) } : {});

// 开始时的提示：隔离任务的改动不进主工作区，排在它后面的任务看不到
export function isolationNotes(tasks, deps) {
  const notes = [];
  for (const iso of tasks.filter((t) => t.isolation === "worktree")) {
    const after = tasks.filter((t) => deps.get(t.label)?.includes(iso.label)).map((t) => `「${t.label}」`);
    if (after.length) notes.push(`隔离任务「${iso.label}」的改动存成分支、不进主工作区，之后的${after.join("")}看不到；要用这些改动就去掉它的隔离，或分两次运行、中间先合并`);
  }
  return notes;
}

const commitTree = (root, tree, parents, message) =>
  must(git(root, ["commit-tree", "--no-gpg-sign", ...parents.filter(Boolean).flatMap((p) => ["-p", p]), "-m", message, tree], { env: IDENTITY }), "保存快照");

function track(iso) {
  active.add(iso);
  return iso;
}

// 建 worktree 写出 tree；失败时删掉建了一半的
function enter(iso, tree) {
  try {
    Object.assign(iso, materialize(iso.root, iso.wtPath, tree, iso.runId, iso.task.label));
  } catch (error) {
    removeWorktree(iso.root, iso.wtPath);
    throw error;
  }
  // 任务 cwd 可能是仓库子目录，映射到 worktree 里同一相对位置
  iso.wtCwd = path.join(iso.wt, path.relative(iso.root, realPath(iso.cwd)));
  fs.mkdirSync(iso.wtCwd, { recursive: true });
  iso.task.worktree = { path: iso.wt, repo: iso.root, links: iso.links };
}

function prepare(dir, task, cwd, root) {
  const runId = path.basename(dir);
  return { task, runId, root, cwd, wtPath: path.join(WORKTREES, runId, nameOf(task.label)), links: [], archived: false };
}

// 同一任务重做前：同名分支只在仍停在本运行记下的旧成果提交（state.leftovers）上时删掉；
// 之后有人改过、是符号引用或不是本运行留下的，都不动它，报错让人先处理
function dropOldBranch(iso, name) {
  const ref = `refs/heads/${name}`;
  if (isSymbolic(iso.root, ref)) throw new Error(`分支 ${name} 是指向别处的符号引用，先删掉它再重跑`);
  const tip = git(iso.root, ["rev-parse", "--verify", "-q", ref]).stdout.trim();
  if (!tip) return;
  const left = current?.state.leftovers?.branches ?? [];
  const mine = left.find((b) => b.name === name && b.repo === iso.root && b.tip === tip);
  if (!mine || deleteBranch(iso.root, name, tip) !== "deleted") throw new Error(`分支 ${name} 已存在，且不是上次留下、之后没改过的成果，先合并或删掉它再重跑`);
  left.splice(left.indexOf(mine), 1);
}

// 任务开始：主工作区此刻的内容（含未提交和未跟踪的文件）B 包成基准提交（与 HEAD 相同时直接用 HEAD），建 worktree 写出 B
export function openWorktree(dir, task, cwd) {
  const root = gitRoot(cwd);
  if (!root) throw new Error(`${cwd} 不在 git 仓库里，无法隔离`);
  const iso = prepare(dir, task, cwd, root);
  const name = branchOf(iso.runId, task.label);
  if (git(root, ["check-ref-format", "--branch", name]).status !== 0) throw new Error(`任务名换成分支名 ${name} 不合法`);
  removeWorktree(root, iso.wtPath);
  dropOldBranch(iso, name);
  iso.base = contentTree(root);
  if (!iso.base) throw new Error("记不下主工作区快照");
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
  const headTree = head ? git(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]).stdout.trim() : "";
  const base = headTree === iso.base ? head : commitTree(root, iso.base, [head], `codex-flow ${iso.runId} ${task.label} 开始时的主工作区（含未提交）`);
  task.branch = { repo: root, name, base };
  enter(iso, iso.base);
  const env = envToMain(root, iso.links);
  if (env.length) task.envToMain = env;
  return track(iso);
}

// 续跑只重跑验收：按上次存下的成果（没有改动时按基准）重建 worktree 在里面验收。成果提交已不在就报错
export function reopenWorktree(dir, task, cwd) {
  const b = task.branch ?? legacyBranch(dir, task);
  const tree = (commit) => (b.repo && commit ? git(b.repo, ["rev-parse", "--verify", "-q", `${commit}^{tree}`]).stdout.trim() : "");
  const iso = prepare(dir, task, cwd, b.repo);
  // 有改动却没有成果提交（被 clean 删了）时不能退回按基准验收
  Object.assign(iso, { base: tree(b.base), end: b.files?.length && !b.tip ? "" : tree(b.tip ?? b.base), archived: true });
  if (!iso.base || !iso.end) throw new Error(`隔离任务上次的成果已不在，无法只重跑验收；要从头重做加 --rerun ${task.label}`);
  removeWorktree(iso.root, iso.wtPath, task.worktree?.links);
  enter(iso, iso.end);
  iso.changed = changedFiles(iso);
  if (task.branch && !task.branch.files?.length) task.branch.files = iso.changed.map((rel) => shown(iso, rel)).sort();
  return track(iso);
}

// V0.3 的记录：没合回的成果在私有引用 refs/codex-flow/<runId>/<任务名>/{base,result} 里。换成分支，之后照新做法处理
function legacyBranch(dir, task) {
  const m = task.merge;
  if (!m?.result || m.state === "applied") return {};
  const name = branchOf(path.basename(dir), task.label);
  const ok = git(m.repo, ["update-ref", "--no-deref", `refs/heads/${name}`, m.result.id, ""]).status === 0;
  if (!ok) return {};
  task.branch = { repo: m.repo, name, base: m.base.id, tip: m.result.id, files: m.files ?? [] };
  delete task.merge;
  return task.branch;
}

function changedFiles(iso) {
  const changed = changedBetween(iso.root, iso.base, iso.end);
  if (!changed) throw new Error("比较不了开始和结束时的快照");
  return changed.map((file) => path.relative(iso.root, file));
}

// 从快照里去掉受管链接（.gitignore 写成 node_modules/ 时链接不算被忽略，会进快照）：临时 index 读入快照，删掉这些条目再写回
function stripLinks(iso, tree) {
  const present = (changedBetween(iso.root, iso.base, tree) ?? []).map((f) => path.relative(iso.root, f)).filter((rel) => iso.links.includes(rel));
  if (!present.length) return tree;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-flow-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    must(git(iso.wt, ["read-tree", tree], { env }), "读入结束快照");
    must(git(iso.wt, ["update-index", "--force-remove", "-z", "--stdin"], { env, input: `${present.join("\0")}\0` }), "去掉链接");
    return must(git(iso.wt, ["write-tree"], { env }), "写结束快照");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 相对仓库根的路径换成相对任务 cwd 的显示形式，和 scope.outside 一致
const shown = (iso, rel) => path.relative(realPath(iso.cwd), path.join(iso.root, rel)) || ".";

// 结束快照 T 有改动时包成成果提交（父提交是基准），建分支指向它。受管链接被换成真实文件或目录、改指别处或上级被换成链接，记为异常
function archiveResult(task, iso) {
  const raw = contentTree(iso.wt, iso.base);
  if (!raw) throw new Error("记不下 worktree 结束时的快照");
  iso.end = stripLinks(iso, raw);
  iso.changed = changedFiles(iso);
  const b = task.branch;
  if (iso.changed.length) {
    const tip = commitTree(iso.root, iso.end, [b.base], tipMessage(iso.runId, task.label));
    // 不解引用、要求原来不存在：同名的符号引用或已有分支都会让这里失败，不会写到别的分支上
    must(git(iso.root, ["update-ref", "--no-deref", `refs/heads/${b.name}`, tip, ""]), `建分支 ${b.name}`);
    Object.assign(b, { tip, files: iso.changed.map((rel) => shown(iso, rel)).sort() });
  }
  const anomalies = iso.links.filter((rel) => {
    if (viaLink(iso.wt, rel)) return true;
    const file = path.join(iso.wt, rel);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat && !(stat.isSymbolicLink() && fs.readlinkSync(file) === path.join(iso.root, rel));
  });
  if (anomalies.length) b.anomalies = anomalies;
  iso.archived = true;
}

// 按当前计划的 writes 核对开始到结束的改动，越界的记进 scope（和不隔离的任务一样只提示）。续跑只重跑验收时也调用：计划里的 writes 可能改过
export function noteScope(task, iso) {
  if (!task.writes) return;
  const outside = iso.changed.filter((rel) => !inScope(path.join(iso.root, rel), task.writes, iso.cwd)).map((rel) => shown(iso, rel)).sort();
  task.scope = outside.length ? { outside, unclaimed: [] } : null;
}

// Codex 正常结束、验收之前：存成果（验收命令的产物不算任务的改动），核对写入范围。存不下成果时任务失败、不再验收；返回能否进入验收
export function judgeResult(task, iso) {
  try {
    archiveResult(task, iso);
  } catch (error) {
    return !Object.assign(task, { status: "failed", failureKind: "archive", error: `存不下隔离任务的成果：${error.message}` });
  }
  noteScope(task, iso);
  return true;
}

// 任务收尾：还没存成果的补存（失败、被中断、被停止），再决定目录去留：存不下成果或写了 keepWorktree 时保留并解锁，否则删掉
export function closeWorktree(task, iso) {
  if (!active.delete(iso)) return;
  if (!iso.archived) {
    try {
      archiveResult(task, iso);
    } catch (error) {
      task.branch.archiveError = error.message;
    }
  }
  if (!iso.archived || task.keepWorktree) {
    git(iso.root, ["worktree", "unlock", iso.wt]);
    return;
  }
  removeWorktree(iso.root, iso.wt, iso.links);
  delete task.worktree;
}

// 汇总里隔离任务的行：成果所在分支和查看、合入命令（命令各占一行，整行复制就能运行）；没有改动、存不下成果、链接异常、目录保留各一行
export function isolationLines(task) {
  if (task.isolation !== "worktree") return [];
  const lines = [];
  if (task.envToMain?.length) lines.push(`⚠ 环境里的本地包指向主工作区，验收可能测的不是隔离里的代码：${list(task.envToMain)}`);
  if (["pending", "running"].includes(task.status)) return lines;
  const b = task.branch ?? {};
  // 验收前就存不下的，原因已在通用的失败行里
  if (b.archiveError && task.failureKind !== "archive") lines.push(`⚠ 存不下隔离任务的成果：${b.archiveError}`);
  if (b.tip) {
    const [repo, base, ref] = [sh(b.repo), b.base.slice(0, 12), sh(`refs/heads/${b.name}`)];
    lines.push(`成果在分支 ${b.name}（${b.files.length} 个文件），没有合进主工作区`,
      `查看：git -C ${repo} diff ${base} ${ref} --`,
      `合进主工作区：git -C ${repo} diff --binary ${base} ${ref} -- | git -C ${repo} apply`);
  } else if (b.repo && !b.archiveError && task.status !== "failed") lines.push("没有改动");
  if (b.anomalies?.length) lines.push(`⚠ 环境目录链接被任务换掉：${list(b.anomalies)}`);
  if (task.worktree) lines.push(`worktree 保留在 ${task.worktree.path}`);
  return lines;
}

// 过期运行记录清理（pruneOldRuns）用：删掉一次运行仍停在成果上的分支和残留 worktree
export const cleanRunArchives = (state) => cleanArchives(state, WORKTREES);

// clean <runId>：进程不在运行时删掉这次运行仍停在成果上的分支和残留 worktree，运行记录里对应的字段一并去掉；之后有新提交的分支不动
export function cmdClean({ positionals }) {
  const runId = positionals[0];
  if (!runId) die("用法: clean <runId>");
  const dir = runDir(runId);
  const state = readJson(statePath(dir));
  if (!state) die(`找不到运行记录: ${runId}`);
  if (isAlive(state.pid) && state.status === "running") die(`${runId} 还在运行`, 1);
  const { branches, kept, worktrees } = cleanArchives(state, WORKTREES);
  for (const t of state.tasks ?? []) {
    delete t.worktree;
    if (t.branch && !kept.includes(t.branch.name)) delete t.branch.tip;
    delete t.merge;
  }
  if (state.leftovers) state.leftovers.branches = state.leftovers.branches.filter((b) => kept.includes(b.name));
  writeJson(statePath(dir), state);
  const note = kept.length ? `；这些分支之后有新提交，没删：${kept.join("、")}` : "";
  process.stdout.write(`[codex-flow] 已清理 ${runId}：删除 ${branches} 个分支、${worktrees} 个 worktree${note}\n`);
}
