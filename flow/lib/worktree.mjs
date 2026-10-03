// 隔离任务的 worktree 建立：写出快照内容、链接环境目录、复制 .worktreeinclude 列出的文件，并检测环境里的本地包是否指向主工作区。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { git, isLink, markWorktree } from "./archive.mjs";
import { realPath } from "./scope.mjs";

const ENV_DIRS = new Set(["node_modules", ".venv", "venv"]);
// 写时复制：macOS 用 cp -c（clonefile），Linux 用 cp --reflink=auto；Node 的 COPYFILE_FICLONE 在 macOS 上不克隆，只会退回普通复制
const COW = process.platform === "darwin" ? ["-c"] : process.platform === "linux" ? ["--reflink=auto"] : [];
const firstLine = (text) => String(text ?? "").trim().split("\n")[0];

export function must(result, what) {
  if (result.status !== 0) throw new Error(`${what}失败：${firstLine(result.stderr)}`);
  return String(result.stdout).trim();
}

// 被忽略的环境目录（任意层级的 node_modules、.venv、venv）在 worktree 同一位置建符号链接指回主工作区，只在该位置不存在时建。
// 写进这些链接会落到主工作区：它们是依赖和虚拟环境，接受这一点。其余被忽略的条目不放进 worktree。返回建了的链接（相对仓库根）
function linkEnvDirs(root, wt) {
  const listed = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  must(listed, "列出被忽略的文件");
  const links = [];
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const rel = entry.replace(/\/$/, "");
    const source = path.join(root, rel);
    const link = path.join(wt, rel);
    if (!ENV_DIRS.has(path.basename(rel)) || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (fs.existsSync(link) || isLink(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link);
    links.push(rel);
  }
  return links;
}

// 按目录成批写时复制；cp 失败（如文件系统不支持克隆）就逐个普通复制
function copyInto(root, wt, rels) {
  const byDir = new Map();
  for (const rel of rels) byDir.set(path.dirname(rel), [...(byDir.get(path.dirname(rel)) ?? []), rel]);
  for (const [dir, files] of byDir) {
    fs.mkdirSync(path.join(wt, dir), { recursive: true });
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      const copied = spawnSync("cp", [...COW, ...batch.map((rel) => path.join(root, rel)), `${path.join(wt, dir)}/`]);
      if (copied.status !== 0) for (const rel of batch) fs.copyFileSync(path.join(root, rel), path.join(wt, rel));
    }
  }
}

// 项目根 .worktreeinclude（.gitignore 语法，与 Claude Code 相同）列出、同时又被忽略的文件写时复制进 worktree，如 .env；落在环境目录链接里的不复制
function copyIncluded(root, wt, links) {
  const include = path.join(root, ".worktreeinclude");
  if (!fs.existsSync(include)) return;
  const candidates = git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include}`]).stdout;
  if (!candidates) return;
  const ignored = git(root, ["check-ignore", "-z", "--stdin"], { input: candidates }).stdout.split("\0").filter(Boolean);
  copyInto(root, wt, ignored.filter((rel) => !links.some((l) => rel === l || rel.startsWith(`${l}/`)) && !fs.existsSync(path.join(wt, rel))));
}

// 建 worktree 并写出快照内容，再把 index 重置回 HEAD（不动文件）：任务里 git status / git diff 看到的未提交改动和主工作区一致。
// 运行期间锁住，免得被 git worktree prune 清掉；私有 git 目录里放本运行的标记，清理时只删带标记的。返回 { wt, links }
export function materialize(root, wtPath, tree, runId, label) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  must(git(root, ["worktree", "add", "--force", "--lock", "--reason", `codex-flow ${runId} ${label}`, "--detach", "--no-checkout", wtPath, "HEAD"]), "建立 worktree");
  const wt = realPath(wtPath);
  markWorktree(wt, runId);
  must(git(wt, ["read-tree", "-u", "--reset", tree]), "同步 worktree 内容");
  must(git(wt, ["read-tree", "HEAD"]), "重置 worktree 的 index");
  git(wt, ["update-index", "-q", "--refresh"]);
  const links = linkEnvDirs(root, wt);
  copyIncluded(root, wt, links);
  return { wt, links };
}

// 指向主工作区里（且不在任何 node_modules 里，排除 pnpm 的 .pnpm 仓库）的路径
function intoMain(root, file) {
  try {
    const rel = path.relative(root, fs.realpathSync(file));
    return !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules");
  } catch {
    return false;
  }
}

const entries = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// 文件内容里有主工作区路径（去掉环境目录自身的路径之后）
function mentionsMain(file, root, envDir) {
  try {
    return fs.readFileSync(file, "utf8").replaceAll(envDir, "").includes(root);
  } catch {
    return false;
  }
}

// 环境里的本地包指向主工作区（只告警）：node_modules 顶层及 @scope 下解析到主工作区的符号链接（workspace 包），
// .venv / venv 的 site-packages 里内容含主工作区路径的 *.pth、__editable__*、*.dist-info/direct_url.json（可编辑安装）。
// 这类包在 worktree 里仍从主工作区导入，验收测的可能不是隔离里的代码。返回命中的条目（相对仓库根）
export function envToMain(root, links) {
  const hits = [];
  for (const rel of links) {
    const dir = path.join(root, rel);
    if (path.basename(rel) === "node_modules") {
      for (const name of entries(dir)) {
        const names = name.startsWith("@") ? entries(path.join(dir, name)).map((n) => path.join(name, n)) : [name];
        for (const n of names) if (isLink(path.join(dir, n)) && intoMain(root, path.join(dir, n))) hits.push(path.join(rel, n));
      }
      continue;
    }
    for (const lib of entries(path.join(dir, "lib")).filter((n) => n.startsWith("python"))) {
      const site = path.join(dir, "lib", lib, "site-packages");
      for (const name of entries(site)) {
        const file = name.endsWith(".dist-info") ? path.join(site, name, "direct_url.json") : path.join(site, name);
        const candidate = name.endsWith(".pth") || name.startsWith("__editable__") || name.endsWith(".dist-info");
        if (candidate && mentionsMain(file, root, dir)) hits.push(path.relative(root, file));
      }
    }
  }
  return hits.sort();
}
