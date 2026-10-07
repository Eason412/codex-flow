// 读取、展开和校验计划，计算任务依赖，并在发给 Codex 前填入引用与约束。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkModelEffort, readJson } from "./state.mjs";
import { die, fileSafe, here } from "./runtime.mjs";
import { estimate } from "./meter.mjs";
import { isolationBlocker, nameOf } from "./isolation.mjs";

const SCHEMAS = path.resolve(here, "..", "schemas");

export function loadSchema(name) {
  if (!name) return null;
  const file = fs.existsSync(name) ? name : path.join(SCHEMAS, `${name}.json`);
  const schema = readJson(file);
  if (!schema) die(`找不到 schema: ${name}（内置: review / opinion / result / report）`);
  return schema;
}

const expandHome = (p) => String(p).replace(/^~(?=$|[\/\\])/, os.homedir());

export const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// 读计划并展开：promptFile 和 {{file:路径}} 相对计划文件所在目录读进 prompt，plan.cwd 相对当前目录、任务 cwd 相对 plan.cwd 换成绝对路径。
// 展开后的计划存进运行目录，续跑不再依赖这些文件；要读其他任务写出的文件，用 {{task:}} 或让 Codex 自己读。
// 每个引入的文件记进任务的 sources（路径、内容摘要、字数）：计量资料占多少，不带计划续跑时提示来源改过
export function loadPlan(planFile) {
  const plan = readJson(planFile);
  if (!plan) die(`读不到计划: ${planFile}`);
  const base = path.dirname(path.resolve(planFile));
  let sources;
  const read = (p, what, kind) => {
    const file = path.resolve(base, expandHome(p));
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      die(`${what}读不到: ${file}`);
    }
    const inlined = kind === "file" ? text.trimEnd() : text;
    sources.push({ kind, path: file, sha1: sha1(text), chars: [...inlined].length, est: +estimate(inlined).toFixed(2) });
    return text;
  };
  plan.cwd = path.resolve(expandHome(plan.cwd ?? process.cwd()));
  for (const phase of Array.isArray(plan.phases) ? plan.phases : []) {
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      sources = [];
      if (task.promptFile !== undefined) {
        if (task.prompt !== undefined) die(`任务「${task.label}」的 prompt 和 promptFile 只能写一个`);
        task.prompt = read(task.promptFile, `任务「${task.label}」的 promptFile `, "promptFile");
        delete task.promptFile;
      }
      if (typeof task.prompt === "string") {
        // {{file:}} 引入的是资料，其中的 {{task:}} {{phase:}} 等原样保留：先换成占位，发给 Codex 前再换回
        task.prompt = task.prompt.replace(/\{\{file:([^}]+)\}\}/g, (_, p) => read(p.trim(), `任务「${task.label}」引用的文件 `, "file").trimEnd().replaceAll("{{", LITERAL_BRACES));
      }
      if (task.cwd !== undefined) task.cwd = path.resolve(plan.cwd, expandHome(task.cwd));
      if (sources.length) task.sources = sources;
      else delete task.sources;
    }
  }
  return plan;
}

export function validatePlan(plan) {
  if (!plan || typeof plan.name !== "string" || !plan.name.trim()) die("计划缺少 name");
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) die("计划缺少 phases");
  if (plan.isolation !== undefined && plan.isolation !== "worktree") die('计划的 isolation 只能写 "worktree"');
  const labels = new Set();
  const titles = new Set();
  for (const phase of plan.phases) {
    if (!phase.title || titles.has(phase.title)) die(`阶段标题缺失或重复: ${phase.title}`);
    titles.add(phase.title);
    if (!Array.isArray(phase.tasks) || phase.tasks.length === 0) die(`阶段「${phase.title}」没有任务`);
    for (const task of phase.tasks) {
      if (!task.label || labels.has(task.label)) die(`任务名缺失或重复: ${task.label}`);
      labels.add(task.label);
      try { checkModelEffort(task.model, task.effort, task.label); } catch (error) { die(error.message); }
      if (typeof task.prompt !== "string" || !task.prompt.trim()) die(`任务「${task.label}」缺少 prompt`);
      if (task.schema) loadSchema(task.schema);
      if (task.cwd !== undefined && !fs.statSync(task.cwd, { throwIfNoEntry: false })?.isDirectory()) die(`任务「${task.label}」的 cwd 不是目录: ${task.cwd}`);
      if (task.after !== undefined && !(Array.isArray(task.after) && task.after.every((n) => typeof n === "string" && n.trim()))) {
        die(`任务「${task.label}」的 after 要写成任务名或阶段标题的数组`);
      }
      for (const key of ["writes", "reads", "checks"]) {
        if (task[key] !== undefined && !(Array.isArray(task[key]) && task[key].every((n) => typeof n === "string" && n.trim()))) {
          die(`任务「${task.label}」的 ${key} 要写成字符串数组`);
        }
      }
      checkIsolation(plan, task);
    }
  }
  checkNameClashes(plan.phases.flatMap((p) => p.tasks));
  return dependencies(plan);
}

// 结果、日志和停止文件按 fileSafe 后的任务名存，隔离任务的 worktree 目录和私有引用按 nameOf 后的任务名存；
// 归一化后相同（macOS 默认文件系统不分大小写，也算上只差大小写的）会互相覆盖，拒绝启动
function checkNameClashes(tasks) {
  const key = (name) => name.normalize("NFC").toLowerCase();
  for (const [form, pick] of [[fileSafe, () => true], [nameOf, (t) => t.isolation === "worktree"]]) {
    const seen = new Map();
    for (const task of tasks.filter(pick)) {
      const k = key(form(task.label));
      if (seen.has(k)) die(`任务「${seen.get(k)}」和「${task.label}」的名字只差标点、空白或大小写，存结果或隔离目录时会重名，改其中一个`);
      seen.set(k, task.label);
    }
  }
}

// 计划顶层的 isolation 作为任务默认值展开到任务上；非 git 目录、有已初始化子模块的仓库拒绝启动
function checkIsolation(plan, task) {
  // 计划顶层写了 isolation 时，任务写 false 表示这个任务不隔离
  if (task.isolation === false) {
    delete task.isolation;
    return;
  }
  if (task.isolation === undefined && plan.isolation !== undefined) task.isolation = plan.isolation;
  if (task.isolation === undefined) return;
  if (task.isolation !== "worktree") die(`任务「${task.label}」的 isolation 只能写 "worktree" 或 false`);
  if (task.keepWorktree !== undefined && typeof task.keepWorktree !== "boolean") die(`任务「${task.label}」的 keepWorktree 要写成 true 或 false`);
  const blocker = isolationBlocker(task.cwd ?? plan.cwd);
  if (blocker) die(`任务「${task.label}」写了 isolation，但${blocker}`);
}

// 每个任务等哪些任务：没写 after 就等上一阶段全部任务（阶段间顺序执行）；写了 after 就只等列出的任务或阶段，前置完成即开跑。
// prompt 里 {{task:}} {{phase:}} {{path:}} 引用的任务自动加进来，保证引用到的结果已经出来
function dependencies(plan) {
  const byPhase = new Map(plan.phases.map((p) => [p.title, p.tasks.map((t) => t.label)]));
  const labels = new Set(plan.phases.flatMap((p) => p.tasks.map((t) => t.label)));
  const deps = new Map();
  plan.phases.forEach((phase, index) => {
    for (const task of phase.tasks) {
      const set = new Set();
      const add = (name, kind, how) => {
        if (kind !== "phase" && labels.has(name)) set.add(name);
        else if (kind !== "task" && byPhase.has(name)) for (const label of byPhase.get(name)) set.add(label);
        else die(`任务「${task.label}」的 ${how} 指向不存在的${kind === "phase" ? "阶段" : kind === "task" ? "任务" : "任务或阶段"}: ${name}`);
      };
      if (task.after === undefined) for (const label of index > 0 ? byPhase.get(plan.phases[index - 1].title) : []) set.add(label);
      else for (const name of task.after) add(name.trim(), null, "after");
      for (const [, kind, name] of task.prompt.matchAll(/\{\{(task|phase|path):([^}]+)\}\}/g)) add(name.trim(), kind === "path" ? "task" : kind, `{{${kind}:}}`);
      if (set.has(task.label)) die(`任务「${task.label}」不能等待自己（after 或引用指向了自己或所在阶段）`);
      deps.set(task.label, [...set]);
    }
  });
  // 依赖不能成环
  const mark = new Map();
  const visit = (label, trail) => {
    if (mark.get(label) === "done") return;
    if (mark.get(label) === "open") die(`任务依赖成环: ${[...trail, label].join(" → ")}`);
    mark.set(label, "open");
    for (const dep of deps.get(label)) visit(dep, [...trail, label]);
    mark.set(label, "done");
  };
  for (const label of deps.keys()) visit(label, []);
  return deps;
}

// {{file:}} 引入内容里的 "{{" 在计划里存成这个占位，不参与依赖和结果替换
const LITERAL_BRACES = "\u0001";
export const literal = (text) => text.replaceAll(LITERAL_BRACES, "{{");

// {{phase:标题}} 换成该阶段所有任务的结果，{{task:任务名}} 换成单个任务的结果，{{path:任务名}} 换成结果文件的绝对路径（下游自己读，不占任务说明）。
// injected 收集注入的上游结果原文，供计量
export function renderPrompt(prompt, state, dir, injected = []) {
  const resultOf = (task) => {
    if (task.status !== "completed" || !task.result) return `（任务「${task.label}」未完成：${task.status}）`;
    try {
      return fs.readFileSync(path.join(dir, task.result), "utf8").trim();
    } catch {
      return `（任务「${task.label}」的结果文件读不到）`;
    }
  };
  const inject = (text) => {
    injected.push(text);
    return text;
  };
  const find = (label) => state.tasks.find((t) => t.label === label.trim());
  return prompt
    .replace(/\{\{phase:([^}]+)\}\}/g, (_, title) =>
      inject(state.tasks.filter((t) => t.phase === title.trim()).map((t) => `### ${t.label}\n${resultOf(t)}`).join("\n\n")))
    .replace(/\{\{task:([^}]+)\}\}/g, (_, label) => {
      const task = find(label);
      return task ? inject(resultOf(task)) : `（没有名为「${label}」的任务）`;
    })
    .replace(/\{\{path:([^}]+)\}\}/g, (_, label) => {
      const task = find(label);
      if (!task) return `（没有名为「${label}」的任务）`;
      return task.status === "completed" && task.result ? path.join(dir, task.result) : `（任务「${task.label}」未完成：${task.status}）`;
    })
    .replaceAll(LITERAL_BRACES, "{{");
}

// 写进 prompt 末尾，让 Codex 知道范围和验收命令；执行器结束后仍自己核对
export function withContract(prompt, task) {
  const lines = [];
  if (task.writes) {
    lines.push(task.writes.length ? `只修改这些路径（相对工作目录）：${task.writes.join("、")}。` : "这是只读任务，不要修改任何文件。");
  }
  if (task.checks?.length) {
    lines.push("你结束后执行器会在工作目录依次运行下面的验收命令，全部退出码为 0 才算完成：", ...task.checks.map((c) => `- ${c}`));
  }
  if (task.isolation === "worktree") {
    lines.push("工作目录是执行器为本任务建的独立 git worktree，结束后执行器把改动存成一个分支，不合回主工作区；不要 commit、stash 或切换分支。node_modules、.venv、venv 是指回主工作区的链接，写进去会落到主工作区；其余被忽略的文件不在这里。");
  }
  return lines.length ? `${prompt}\n\n---\ncodex-flow 约束：\n${lines.join("\n")}` : prompt;
}
