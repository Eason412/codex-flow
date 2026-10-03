// 读取、展开和校验计划，计算任务依赖，并在发给 Codex 前填入引用与约束。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkModelEffort, readJson } from "./state.mjs";
import { die, here } from "./runtime.mjs";

const SCHEMAS = path.resolve(here, "..", "schemas");

export function loadSchema(name) {
  if (!name) return null;
  const file = fs.existsSync(name) ? name : path.join(SCHEMAS, `${name}.json`);
  const schema = readJson(file);
  if (!schema) die(`找不到 schema: ${name}（内置: review / opinion / result）`);
  return schema;
}

const expandHome = (p) => String(p).replace(/^~(?=$|[\/\\])/, os.homedir());

// 读计划并展开：promptFile 和 {{file:路径}} 相对计划文件所在目录读进 prompt，plan.cwd 相对当前目录、任务 cwd 相对 plan.cwd 换成绝对路径。
// 展开后的计划存进运行目录，续跑不再依赖这些文件；要读其他任务写出的文件，用 {{task:}} 或让 Codex 自己读
export function loadPlan(planFile) {
  const plan = readJson(planFile);
  if (!plan) die(`读不到计划: ${planFile}`);
  const base = path.dirname(path.resolve(planFile));
  const read = (p, what) => {
    const file = path.resolve(base, expandHome(p));
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      die(`${what}读不到: ${file}`);
    }
  };
  plan.cwd = path.resolve(expandHome(plan.cwd ?? process.cwd()));
  for (const phase of Array.isArray(plan.phases) ? plan.phases : []) {
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      if (task.promptFile !== undefined) {
        if (task.prompt !== undefined) die(`任务「${task.label}」的 prompt 和 promptFile 只能写一个`);
        task.prompt = read(task.promptFile, `任务「${task.label}」的 promptFile `);
        delete task.promptFile;
      }
      if (typeof task.prompt === "string") {
        // {{file:}} 引入的是资料，其中的 {{task:}} {{phase:}} 等原样保留：先换成占位，发给 Codex 前再换回
        task.prompt = task.prompt.replace(/\{\{file:([^}]+)\}\}/g, (_, p) => read(p.trim(), `任务「${task.label}」引用的文件 `).trimEnd().replaceAll("{{", LITERAL_BRACES));
      }
      if (task.cwd !== undefined) task.cwd = path.resolve(plan.cwd, expandHome(task.cwd));
    }
  }
  return plan;
}

export function validatePlan(plan) {
  if (!plan || typeof plan.name !== "string" || !plan.name.trim()) die("计划缺少 name");
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) die("计划缺少 phases");
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
      for (const key of ["writes", "checks"]) {
        if (task[key] !== undefined && !(Array.isArray(task[key]) && task[key].every((n) => typeof n === "string" && n.trim()))) {
          die(`任务「${task.label}」的 ${key} 要写成字符串数组`);
        }
      }
    }
  }
  return dependencies(plan);
}

// 每个任务等哪些任务：没写 after 就等上一阶段全部任务（阶段间顺序执行）；写了 after 就只等列出的任务或阶段，前置完成即开跑。
// prompt 里 {{task:}} {{phase:}} 引用的任务自动加进来，保证引用到的结果已经出来
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
      for (const [, kind, name] of task.prompt.matchAll(/\{\{(task|phase):([^}]+)\}\}/g)) add(name.trim(), kind, `{{${kind}:}}`);
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

// {{phase:标题}} 换成该阶段所有任务的结果，{{task:任务名}} 换成单个任务的结果
export function renderPrompt(prompt, state, dir) {
  const resultOf = (task) => {
    if (task.status !== "completed" || !task.result) return `（任务「${task.label}」未完成：${task.status}）`;
    try {
      return fs.readFileSync(path.join(dir, task.result), "utf8").trim();
    } catch {
      return `（任务「${task.label}」的结果文件读不到）`;
    }
  };
  return prompt
    .replace(/\{\{phase:([^}]+)\}\}/g, (_, title) =>
      state.tasks.filter((t) => t.phase === title.trim()).map((t) => `### ${t.label}\n${resultOf(t)}`).join("\n\n"))
    .replace(/\{\{task:([^}]+)\}\}/g, (_, label) => {
      const task = state.tasks.find((t) => t.label === label.trim());
      return task ? resultOf(task) : `（没有名为「${label}」的任务）`;
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
  return lines.length ? `${prompt}\n\n---\ncodex-flow 约束：\n${lines.join("\n")}` : prompt;
}
