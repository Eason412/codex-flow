// 隔离任务（isolation: "worktree"）的生命周期：在 $CODEX_FLOW_HOME/worktrees/<runId>/<任务名> 建 worktree 运行，开始、结束时的快照包成提交
// 存进私有引用 refs/codex-flow/<runId>/<任务名>/…；验收通过且没有越界、链接异常时与主工作区三方合并，整份成果要么全部合回、要么不合回。
// 合回成功或没有改动就删 worktree 和引用；失败、冲突、越界、被停止时引用保留成果，worktree 目录默认删掉
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, isAlive, readJson, runDir, statePath, writeJson } from "./state.mjs";
import { current, die, fileSafe, save, stopping, touchedBy } from "./runtime.mjs";
import { changedBetween, contentTree, gitRoot, viaLink } from "./workspace.mjs";
import { inScope, realPath } from "./scope.mjs";
import { leaseOf, leases } from "./leases.mjs";
import { cleanArchives, dropRefs, git, removeWorktree } from "./archive.mjs";
import { envToMain, materialize, must } from "./worktree.mjs";

const WORKTREES = path.join(HOME, "worktrees");
// 包快照用固定身份，不依赖仓库的 user 配置
const IDENTITY = { GIT_AUTHOR_NAME: "codex-flow", GIT_AUTHOR_EMAIL: "codex-flow@localhost", GIT_COMMITTER_NAME: "codex-flow", GIT_COMMITTER_EMAIL: "codex-flow@localhost" };
const REF_KEYS = ["base", "result", "head", "before", "merged"];
const PATHS_PER_CALL = 500; // 一次 git 命令最多带的路径数，避开命令行长度上限
const list = (files) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));
// 目录名和引用名共用：只留文字、数字、下划线和连字符，引用名里不合法的字符都换掉
export const nameOf = (label) => label.replace(/[^\p{L}\p{N}_-]+/gu, "_");
// 任务记为失败并写明原因和类别，返回 false 方便直接 return
const fail = (task, failureKind, error) => !Object.assign(task, { status: "failed", failureKind, error });

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

// 能否隔离：只支持 git，仓库里有已初始化的子模块时第一版不支持。能隔离返回 null，否则返回原因
export function isolationBlocker(cwd) {
  const root = gitRoot(cwd);
  if (!root) return `${cwd} 不在 git 仓库里：隔离只支持 git。非 git 目录去掉 isolation，靠写入范围排队和改文件碰撞检测保护`;
  const staged = git(root, ["ls-files", "-s", "-z"]).stdout.split("\0");
  const modules = staged.filter((e) => e.startsWith("160000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
  const live = modules.filter((rel) => fs.existsSync(path.join(root, rel, ".git")));
  return live.length ? `仓库 ${root} 有已初始化的子模块（${list(live)}），隔离暂不支持子模块` : null;
}

// 计划任务里与隔离有关、要记进运行状态的字段
export const isolationFields = (t) => (t.isolation ? { isolation: t.isolation, ...(t.keepWorktree ? { keepWorktree: true } : {}) } : {});

// 把树包成提交存进私有引用，核对引用确实指向这棵树；返回 { ref, id }
function keepTree(iso, key, tree, parents) {
  const ref = `${iso.prefix}/${key}`;
  const args = ["commit-tree", "--no-gpg-sign", ...parents.filter(Boolean).flatMap((p) => ["-p", p]), "-m", `codex-flow ${iso.runId} ${iso.task.label} ${key}`, tree];
  const id = must(git(iso.root, args, { env: IDENTITY }), `保存 ${key} 快照`);
  must(git(iso.root, ["update-ref", ref, id]), `写 ${key} 引用`);
  if (git(iso.root, ["rev-parse", "--verify", "-q", `${ref}^{tree}`]).stdout.trim() !== tree) throw new Error(`${key} 引用没有指向预期的快照`);
  return { ref, id };
}

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
  const name = nameOf(task.label);
  return { task, runId, root, cwd, prefix: `refs/codex-flow/${runId}/${name}`, wtPath: path.join(WORKTREES, runId, name), links: [], archived: false };
}

// 任务开始：主工作区快照 B 存进 base 引用，建 worktree。同一任务续跑重做时，上次留下的 worktree 和引用先删掉
export function openWorktree(dir, task, cwd) {
  const root = gitRoot(cwd);
  if (!root) throw new Error(`${cwd} 不在 git 仓库里，无法隔离`);
  const iso = prepare(dir, task, cwd, root);
  removeWorktree(root, iso.wtPath);
  dropRefs(root, iso.prefix);
  iso.base = contentTree(root);
  if (!iso.base) throw new Error("记不下主工作区快照");
  iso.head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
  task.merge = { repo: root, base: keepTree(iso, "base", iso.base, [iso.head]) };
  try {
    enter(iso, iso.base);
  } catch (error) {
    dropRefs(root, iso.prefix);
    delete task.merge;
    throw error;
  }
  const env = envToMain(root, iso.links);
  if (env.length) task.envToMain = env;
  return track(iso);
}

// 续跑只重跑验收（上次验收没过、成果还没合回）：按 result 引用重建 worktree，验收的是存下的成果。引用不在就报错，不退回主工作区验收
export function reopenWorktree(dir, task, cwd) {
  const m = task.merge ?? {};
  const tree = (key) => (m.repo && m[key] ? git(m.repo, ["rev-parse", "--verify", "-q", `${m[key].ref}^{tree}`]).stdout.trim() : "");
  const iso = prepare(dir, task, cwd, m.repo);
  Object.assign(iso, { base: tree("base"), end: tree("result"), archived: true });
  if (!iso.base || !iso.end) throw new Error(`隔离任务的成果引用已不在，无法只重跑验收；要从头重做加 --rerun ${task.label}`);
  iso.head = git(iso.root, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
  removeWorktree(iso.root, iso.wtPath, task.worktree?.links);
  enter(iso, iso.end);
  iso.changed = changedFiles(iso);
  return track(iso);
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

// 结束快照 T 存进 result 引用；任务自己做了提交就把它的 HEAD 存为 head。受管链接被换成真实文件或目录、改指别处或上级被换成链接，记为异常
function archiveResult(task, iso) {
  const raw = contentTree(iso.wt, iso.base);
  if (!raw) throw new Error("记不下 worktree 结束时的快照");
  iso.end = stripLinks(iso, raw);
  iso.changed = changedFiles(iso);
  task.merge.result = keepTree(iso, "result", iso.end, [task.merge.base.id]);
  const head = git(iso.wt, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
  if (head && head !== iso.head) {
    must(git(iso.root, ["update-ref", `${iso.prefix}/head`, head]), "写 head 引用");
    task.merge.head = { ref: `${iso.prefix}/head`, id: head };
  }
  const anomalies = iso.links.filter((rel) => {
    if (viaLink(iso.wt, rel)) return true;
    const file = path.join(iso.wt, rel);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat && !(stat.isSymbolicLink() && fs.readlinkSync(file) === path.join(iso.root, rel));
  });
  if (anomalies.length) task.merge.anomalies = anomalies;
  iso.archived = true;
}

// 相对仓库根的路径换成相对任务 cwd 的显示形式，和 scope.outside 一致
const shown = (iso, rel) => path.relative(realPath(iso.cwd), path.join(iso.root, rel)) || ".";
// 命令各占一行，整行复制就能运行
const viewOf = (m) => `查看：git -C ${m.repo} diff ${m.base.ref} ${m.result.ref}\n取回成目录：git -C ${m.repo} worktree add --detach <目录> ${m.result.ref}`;

// Codex 正常结束、验收之前：存成果，核对写入范围和受管链接。越界、链接异常或存不下成果时整份不合回、任务失败，不再验收。
// 返回能否进入验收。验收命令的产物不算任务的改动：结束快照在验收前拍
export function judgeResult(task, iso) {
  try {
    archiveResult(task, iso);
  } catch (error) {
    return fail(task, "archive", `存不下隔离任务的成果：${error.message}`);
  }
  if (!scopeOk(task, iso)) return false;
  if (task.merge.anomalies) return fail(task, "anomaly", `环境目录链接被任务换掉：${list(task.merge.anomalies)}；整份成果没合回`);
  return true;
}

// 按当前计划的 writes 核对开始到结束的改动；越界时整份不合回、任务失败。续跑只重跑验收时也调用：计划里的 writes 可能改过
export function scopeOk(task, iso) {
  if (!task.writes) return true;
  const outside = iso.changed.filter((rel) => !inScope(path.join(iso.root, rel), task.writes, iso.cwd)).map((rel) => shown(iso, rel)).sort();
  task.scope = outside.length ? { outside, unclaimed: [] } : null;
  return outside.length ? fail(task, "outside", `改动超出写入范围：${list(outside)}；整份成果没合回`) : true;
}

// 任务收尾（合回成功的已在 mergeBack 里删掉）：还没存成果的补存（失败、被中断、被停止），再决定目录去留：
// 存不下成果、合回中断（applying）或计划写了 keepWorktree 时保留并解锁，否则删掉，成果在引用里（没有改动时引用也删）
export function closeWorktree(task, iso) {
  if (!active.delete(iso)) return;
  if (!iso.archived) {
    try {
      archiveResult(task, iso);
    } catch (error) {
      task.merge.archiveError = error.message;
    }
  }
  if (!iso.archived || task.merge?.state === "applying" || task.keepWorktree) {
    git(iso.root, ["worktree", "unlock", iso.wt]);
    return;
  }
  removeWorktree(iso.root, iso.wt, iso.links);
  delete task.worktree;
  // 没有改动就没有要保留的成果，引用一并删掉
  if (!iso.changed?.length) {
    dropRefs(iso.root, iso.prefix);
    for (const key of REF_KEYS) delete task.merge[key];
  }
}

// 同期改过冲突文件的任务：运行时段与本任务重叠，改文件记录（含合回登记）里有这些文件
function relatedTasks(task, files) {
  const start = Date.parse(task.startedAt);
  return (current?.state.tasks ?? []).filter((t) => t.label !== task.label && t.startedAt && (!t.endedAt || Date.parse(t.endedAt) >= start)
    && files.some((file) => touchedBy.get(t.label)?.has(file))).map((t) => t.label);
}

function conflictOf(task, iso, files) {
  const related = relatedTasks(task, files.map((rel) => path.join(iso.root, rel)));
  task.merge.conflict = files.map((rel) => shown(iso, rel)).sort();
  return { kind: "conflict", error: `合回冲突：${list(task.merge.conflict)}${related.length ? `（同期改过：${related.join("、")}）` : ""}；整份成果没合回\n`
    + `${viewOf(task.merge)}\n在最新状态上重做：run --resume ${iso.runId} --rerun ${task.label}` };
}

const namesOf = (iso, args) => git(iso.root, ["--literal-pathspecs", "diff-tree", "-r", "--name-only", "--no-renames", "-z", ...args]).stdout.split("\0").filter(Boolean);

// 主工作区里这些文件（相对仓库根）现在与 tree 不一致的；记不下快照时算全部不一致
function differing(iso, files, tree) {
  const now = contentTree(iso.root);
  if (!now) return files;
  const off = [];
  for (let i = 0; i < files.length; i += PATHS_PER_CALL) off.push(...namesOf(iso, [now, tree, "--", ...files.slice(i, i + PATHS_PER_CALL)]));
  return off;
}

// 合并后实际要写的文件不全在已持有的租约里时：没人占着就扩大租约，被别的任务占着就返回这些文件，由 mergeBack 连同它们重新排队。
// 主工作区把文件改了名时改动会跟着合到新名字上，这是合并的正常结果，不按 writes 再查范围（任务自己的改动已在 B→T 上查过）
function claimWrites(iso, name, files) {
  const extra = files.filter((file) => !leases.covers(name, leaseOf([file], iso.root)));
  if (!extra.length) return null;
  const more = leaseOf(extra, iso.root);
  if (leases.blockers(more, name).length) return extra;
  leases.hold(name, [...(leases.held.get(name) ?? []), ...more]);
  return null;
}

// 在租约内：拍主工作区快照 M（before 引用），与 B、T 三方合并得到 R（merged 引用），持久化 applying 后在仓库根把 M→R 的差异用普通 git apply 应用
// （不带 --index / --3way / --reject，不动主仓库 index），再核对主工作区相关文件等于 R。
// 返回 { result, files }（files 是实际写入的绝对路径）、{ widen }（要连同这些文件重新排队）或 { kind, error }
function applyMerge(task, iso, name) {
  const main = contentTree(iso.root);
  if (!main) throw new Error("记不下主工作区快照");
  const m = task.merge;
  m.before = keepTree(iso, "before", main, [git(iso.root, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim()]);
  let result = iso.end;
  if (main !== iso.base) {
    const merged = git(iso.root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", `--merge-base=${iso.base}`, main, iso.end]);
    const [tree, ...names] = merged.stdout.split("\0").filter(Boolean);
    if (merged.status === 1) return conflictOf(task, iso, [...new Set(names)]);
    if (merged.status !== 0) throw new Error(`三方合并失败：${merged.stderr.trim().split("\n")[0]}`);
    result = tree;
  }
  const writes = namesOf(iso, [main, result]);
  const files = writes.map((rel) => path.join(iso.root, rel));
  const widen = claimWrites(iso, name, files);
  if (widen) return { widen };
  m.merged = keepTree(iso, "merged", result, [m.before.id, m.result.id]);
  // diff-tree 不受用户 diff 配置影响；按字节交给 git apply，二进制和非 UTF-8 文本都不走样
  const patch = git(iso.root, ["diff-tree", "-r", "-p", "--binary", "--full-index", "--no-renames", main, result], { encoding: "buffer" });
  if (patch.status !== 0) throw new Error(`生成补丁失败：${String(patch.stderr).trim().split("\n")[0]}`);
  if (!patch.stdout.length) return { result, files };
  m.state = "applying";
  save();
  const applied = git(iso.root, ["apply", "--whitespace=nowarn", "-"], { input: patch.stdout });
  if (applied.signal) {
    m.applyError = `被 ${applied.signal} 中断`;
    throw new Error(`合回被中断（${applied.signal}），主工作区可能只应用了一部分`);
  }
  // git apply 先核对整份补丁、通过才写，核对不过（如拍完 M 后主工作区又被没有租约的写入改过）时一个文件都不动；
  // 但写到一半出错（如目录不可写）时前面的文件已经改了。核对出相关文件仍与 M 一致才算没动，否则按合回中断保留现场
  if (applied.status !== 0) {
    const why = `git apply 失败：${String(applied.stderr).trim().split("\n")[0]}`;
    if (differing(iso, writes, main).length) {
      m.applyError = why;
      throw new Error(`${why}，主工作区可能只应用了一部分`);
    }
    delete m.state;
    return { kind: "merge", error: `${why}；主工作区没有改动` };
  }
  const off = differing(iso, writes, result);
  if (off.length) return { kind: "mismatch", error: `合回后主工作区与合并结果不一致：${list(off)}；需人工核对\n查看：git -C ${m.repo} diff ${m.before.ref} ${m.merged.ref}` };
  return { result, files };
}

// 等合回租约期间被要求停止（整个 flow 或单独取消这个任务）
const stopAsked = (dir, task) => stopping || fs.existsSync(path.join(dir, "control", `${fileSafe(task.label)}.stop`));

// 排队取合回租约，等待期间每 0.5 秒看一次停止；取到后再看一次（别的任务释放时可能当场把租约交过来）。被要求停止时返回 false，不持有租约
async function acquireMerge(dir, task, name, lease) {
  const poll = setInterval(() => stopAsked(dir, task) && leases.cancel(name), 500);
  try {
    if (!(await leases.acquire(name, lease))) return false;
  } finally {
    clearInterval(poll);
  }
  if (!stopAsked(dir, task)) return true;
  leases.release(name);
  return false;
}

const MERGE_ROUNDS = 3; // 合并后要写的文件被别的任务占着、重新排队的轮数，超过就直接取整个仓库的租约

// 取租约并合回，必要时连同合并后实际要写的文件重新排队；返回 applyMerge 的结果，或被要求停止时的 { stopped }
async function mergeUnderLease(dir, task, iso, name) {
  let files = iso.changed.map((rel) => path.join(iso.root, rel));
  for (let round = 1; ; round++) {
    if (!(await acquireMerge(dir, task, name, leaseOf(round > MERGE_ROUNDS ? [iso.root] : files, iso.root)))) return { stopped: true };
    let outcome;
    try {
      outcome = applyMerge(task, iso, name);
    } catch (error) {
      outcome = { kind: task.merge.state === "applying" ? "interrupted" : "merge", error: error.message };
    }
    if (!outcome.widen) return outcome;
    leases.release(name);
    files = [...new Set([...files, ...outcome.widen])];
  }
}

// 合回：先按改动文件取写入租约（等与之重叠的运行中任务和排在前面的合回），再三方合并、应用，期间任务保持运行中。
// 合并结果 R 与验收过的 T 不同（期间主工作区有别的改动）就用 recheck 在主工作区再验收，由它定最终状态。
// 合回成功或没有改动：删 worktree 和全部私有引用，merge 里只留 state、files、rechecked
export async function mergeBack(dir, task, iso, recheck) {
  const m = task.merge;
  m.files = iso.changed.map((rel) => shown(iso, rel)).sort();
  let result = null;
  // 租约从合回一直持有到主工作区再验收结束：验收看到的必须正是合回后的内容，排队的任务这期间不能开跑
  let release = () => {};
  if (iso.changed.length) {
    task.merging = true;
    save();
    const name = `${task.label}:合回`;
    const outcome = await mergeUnderLease(dir, task, iso, name);
    delete task.merging;
    // 被要求停止：不合回，成果留在引用里（整个 flow 停止时 onStop 已记为已停止）
    if (outcome.stopped) return void Object.assign(task, { status: "cancelled", ...(stopping ? {} : { error: "已按要求停止（成果没合回）" }) });
    release = () => leases.release(name);
    if (outcome.error) {
      release();
      return fail(task, outcome.kind, outcome.error);
    }
    // 实际写进主工作区的文件记为合回的文件，并登记成这个任务写的，同期其他任务核对范围外变动、找冲突来源时认得出
    m.files = outcome.files.map((file) => shown(iso, path.relative(iso.root, file))).sort();
    if (!touchedBy.has(task.label)) touchedBy.set(task.label, new Set());
    for (const file of outcome.files) touchedBy.get(task.label).add(file);
    result = outcome.result;
  }
  m.state = "applied";
  active.delete(iso);
  removeWorktree(iso.root, iso.wt, iso.links);
  dropRefs(iso.root, iso.prefix);
  for (const key of REF_KEYS) delete m[key];
  delete task.worktree;
  if (task.checks?.length && result && result !== iso.end) {
    m.rechecked = true;
    save();
    try {
      await recheck();
    } finally {
      release();
    }
    if (task.status === "failed") task.error = `合回后在主工作区${task.error}`;
    return;
  }
  release();
  task.status = "completed";
  delete task.error;
  delete task.failureKind;
}

// 续跑遇到上次合回写主工作区时中断（merge.state 仍是 applying）的任务：不复用、不自动重试、不反向应用，记为失败等人工核对
export function interruptedMerge(old, phase) {
  const m = old.merge;
  const view = m.before && m.merged ? `\n查看：git -C ${m.repo} diff ${m.before.ref} ${m.merged.ref}` : "";
  return { ...old, phase, status: "failed", failureKind: "interrupted", error: `上次合回中断，需人工核对主工作区${view}` };
}

const WHY = { outside: "改动超出写入范围", anomaly: "环境目录链接被任务换掉", checks: "验收没过", execution: "执行失败" };

// 汇总里隔离任务的行：合回结果或没合回的原因与查看、取回方式；环境指向主工作区时另起一行告警
export function isolationLines(task) {
  if (task.isolation !== "worktree") return [];
  const lines = [];
  if (task.envToMain?.length) lines.push(`⚠ 环境里的本地包指向主工作区，验收可能测的不是隔离里的代码：${list(task.envToMain)}`);
  if (["pending", "running"].includes(task.status)) return lines;
  const m = task.merge ?? {};
  const kept = task.worktree ? `worktree 保留在 ${task.worktree.path}` : "";
  // 多行的说明（命令各占一行）拆开，每行由汇总统一缩进
  const push = (text) => lines.push(...text.split("\n").filter(Boolean));
  if (m.state === "applying") push(`⚠ 合回中断${m.applyError ? `（${m.applyError}）` : ""}，主工作区可能只应用了一部分，需人工核对${kept ? `；${kept}` : ""}${m.before && m.merged ? `\n查看：git -C ${m.repo} diff ${m.before.ref} ${m.merged.ref}` : ""}`);
  else if (m.state === "applied") {
    const recheck = m.rechecked ? `，已在主工作区重新验收${task.status === "failed" && task.checkFailed ? "（未通过）" : ""}` : "";
    lines.push(m.files?.length ? `合回 ${m.files.length} 个文件${recheck}` : "没有改动，无需合回");
  } else if (["conflict", "mismatch", "interrupted"].includes(task.failureKind)) push(`⚠ ${task.error}${kept ? `\n${kept}` : ""}`);
  else if (m.result || kept) {
    const why = task.status === "cancelled" ? "已停止" : ["merge", "archive"].includes(task.failureKind) ? task.error
      : `${WHY[task.failureKind] ?? "任务没完成"}${task.failureKind === "anomaly" ? `：${list(m.anomalies)}` : ""}`;
    push(`⚠ 成果没合回（${why}）${kept ? `；${kept}` : ""}${m.result ? `\n${viewOf(m)}` : ""}`);
  }
  return lines;
}

// 过期运行记录清理（pruneOldRuns）用：删掉一次运行的私有引用和残留 worktree
export const cleanRunArchives = (state) => cleanArchives(state, WORKTREES);

// clean <runId>：进程不在运行时删掉这次运行的全部私有引用和残留 worktree，运行记录里对应的字段一并去掉
export function cmdClean({ positionals }) {
  const runId = positionals[0];
  if (!runId) die("用法: clean <runId>");
  const dir = runDir(runId);
  const state = readJson(statePath(dir));
  if (!state) die(`找不到运行记录: ${runId}`);
  if (isAlive(state.pid) && state.status === "running") die(`${runId} 还在运行`, 1);
  const { refs, worktrees } = cleanArchives(state, WORKTREES);
  for (const t of state.tasks ?? []) {
    delete t.worktree;
    if (t.merge) for (const key of REF_KEYS) delete t.merge[key];
  }
  writeJson(statePath(dir), state);
  process.stdout.write(`[codex-flow] 已清理 ${runId}：删除 ${refs} 个私有引用、${worktrees} 个 worktree\n`);
}
