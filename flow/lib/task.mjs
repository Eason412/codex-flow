// 执行一个 Codex 任务：启动 thread/turn、记录通知、轮询控制目录，再存结果和验收。
import fs from "node:fs";
import path from "node:path";
import { AppServer } from "./appserver.mjs";
import { nowIso } from "./state.mjs";
import { fileSafe, save, servers, touchedBy } from "./runtime.mjs";
import { loadSchema } from "./plan.mjs";
import { gitSnapshot, realPath, scopeReport } from "./scope.mjs";
import { oneLine, TaskActivity } from "./activity.mjs";
import { checkTask, finishChecks, settleChecks } from "./checks.mjs";
import { closeWorktree, judgeResult, mergeBack, openWorktree } from "./isolation.mjs";

const SCOPE_SETTLE_MS = 300; // 拍结束快照前等其他任务的改文件记录到齐

function prepareTask(dir, state, task, prompt, cwd) {
  const logFile = path.join(dir, "logs", `${fileSafe(task.label)}.jsonl`);
  const t0 = Date.now();
  const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(1), ...entry })}\n`);
  const control = path.join(dir, "control");
  const stopFile = path.join(control, `${fileSafe(task.label)}.stop`);

  task.status = "running";
  task.startedAt = nowIso();
  task.log = path.relative(dir, logFile);
  fs.writeFileSync(path.join(dir, "logs", `${fileSafe(task.label)}.prompt.txt`), prompt);
  save();

  // 写入范围：开始前记下 git 工作区状态，运行中收集 Codex 的改文件记录；隔离任务改用 worktree 前后的快照核对
  const before = task.writes && task.isolation !== "worktree" ? gitSnapshot(cwd) : null;
  const touched = new Set();
  touchedBy.set(task.label, touched);
  // 面板的过程区：最近几步和累计数，随 token 一起每秒存一次
  const activity = new TaskActivity(task);
  let resolveTurn;
  const turnDone = new Promise((r) => (resolveTurn = r));
  return { dir, state, task, prompt, cwd, log, control, stopFile, before, touched, activity,
    lastMessage: null, resolveTurn, turnDone, server: undefined };
}

function pendingSteers(run) {
  const steerPrefix = `${fileSafe(run.task.label)}.steer.`;
  return (fs.existsSync(run.control) ? fs.readdirSync(run.control) : [])
    .filter((n) => n.startsWith(steerPrefix) && n.endsWith(".txt"));
}

// Codex 结束后还没取走的插话不会再发：改名为 .unsent，并在过程里写明，不让它无声消失
function dropSteers(run) {
  for (const name of pendingSteers(run)) {
    const file = path.join(run.control, name);
    fs.renameSync(file, `${file}.unsent`);
    run.activity.note({ kind: "note", text: "插话没有送达：任务已结束" });
    run.log({ method: "steer-unsent", file: name });
  }
}

function logNotification(run, message, params, item) {
  if (message.method.startsWith("mcpServer/") || message.method === "account/updated" || message.method === "remoteControl/status/changed") return;
  const entry = { method: message.method };
  if (item.type) entry.item = item.type;
  if (item.command) entry.command = String(item.command).slice(0, 300);
  if (item.status) entry.status = item.status;
  if (item.query) entry.query = String(item.query).slice(0, 200);
  if (message.method === "turn/completed") entry.turn = params.turn?.status;
  if (message.method.startsWith("server-request:") || message.method === "error") entry.params = JSON.stringify(params).slice(0, 500);
  run.log(entry);
}

function handleNotification(run, message) {
  const { task, cwd, touched, activity } = run;
  const p = message.params ?? {};
  const item = p.item ?? {};
  if (message.method === "item/completed" && item.type === "agentMessage") run.lastMessage = item.text ?? run.lastMessage;
  if (message.method === "item/completed" && item.type === "fileChange" && item.status === "completed") {
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      for (const file of [change?.path, change?.kind?.move_path]) if (typeof file === "string" && file) touched.add(realPath(path.resolve(cwd, file)));
    }
  }
  if (message.method === "thread/tokenUsage/updated") {
    const total = p.tokenUsage?.total?.totalTokens;
    if (typeof total === "number") task.tokens = total;
    // 面板照 Claude Code 的口径显示：最近一次调用的输入（当前上下文）+ 累计输出；tokens 保留累计用量供统计
    const context = p.tokenUsage?.last?.inputTokens;
    const output = p.tokenUsage?.total?.outputTokens;
    if (Number.isFinite(context) && Number.isFinite(output)) Object.assign(task, { context, output });
  }
  activity.record(message.method, item, cwd);
  if (message.method === "turn/completed") run.resolveTurn({ status: p.turn?.status, error: p.turn?.error?.message ?? null });
  if (message.method === "connection/closed") run.resolveTurn({ status: "failed", error: p.message });
  logNotification(run, message, p, item);
}

async function startTurn(run) {
  const { cwd, task, prompt } = run;
  run.server = await AppServer.start({ cwd, onNotification: (m) => handleNotification(run, m), onSpawn: (s) => servers.add(s) });
  const server = run.server;
  servers.add(server);
  const schema = loadSchema(task.schema);
  const thread = await server.request("thread/start", {
    cwd, model: task.model, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false,
    ...(task.serviceTier ? { serviceTier: task.serviceTier } : {}),
  });
  task.threadId = thread.thread?.id ?? null;
  task.actualModel = thread.model ?? null;
  // Codex 回报这个 thread 实际用的 tier（priority 即 Fast）
  task.actualServiceTier = thread.serviceTier ?? null;
  const turn = await server.request("turn/start", {
    threadId: task.threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    model: task.model,
    effort: task.effort,
    outputSchema: schema,
  });
  task.turnId = turn.turn?.id ?? null;
  save();
}

async function pollControl(run) {
  const { task, stopFile, server, log, activity, control } = run;
  try {
    if (fs.existsSync(stopFile) && !task.stopRequested) {
      task.stopRequested = true;
      log({ method: "stop-requested" });
      await server.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
    }
    for (const name of pendingSteers(run)) {
      const file = path.join(control, name);
      // 刚写的文件下一秒再取，免得读到写了一半的内容
      if (Date.now() - fs.statSync(file).mtimeMs < 500) continue;
      const text = fs.readFileSync(file, "utf8").trim();
      fs.renameSync(file, `${file}.sent`);
      if (!text) continue;
      try {
        await server.request("turn/steer", {
          threadId: task.threadId, expectedTurnId: task.turnId,
          input: [{ type: "text", text, text_elements: [] }],
        });
      } catch (error) {
        activity.note({ kind: "note", text: oneLine(`插话没有送达：${error.message}`) });
        throw error;
      }
      log({ method: "steer-sent", chars: text.length });
      activity.note({ kind: "steer", text: oneLine(text) });
    }
  } catch (error) {
    log({ method: "control-error", error: error.message });
  }
}

// 每秒看一次控制目录：停止和插话由面板或命令写进来；token 数变了也存一次
function startControlPoll(run) {
  let savedTokens = run.task.tokens;
  return setInterval(async () => {
    if (run.task.tokens !== savedTokens || run.activity.dirty) {
      savedTokens = run.task.tokens;
      run.activity.dirty = false;
      save();
    }
    await pollControl(run);
  }, 1000);
}

function writeTaskResult(run) {
  const { dir, task } = run;
  let text = run.lastMessage ?? "";
  let ext = "md";
  if (task.schema) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      ext = "json";
    } catch {
      // 没按 schema 返回就原样存成 md
    }
  }
  const resultFile = path.join(dir, "results", `${fileSafe(task.label)}.${ext}`);
  fs.writeFileSync(resultFile, `${text}\n`);
  task.result = path.relative(dir, resultFile);
}

// 隔离任务的 Codex 正常结束：存成果、核对范围，在 worktree 里验收，通过再合回；整个过程保持运行中，最终状态由验收或合回决定。
// 合并结果不是验收过的内容时，在主工作区（原 cwd）再验收
async function finishIsolated(run) {
  const { dir, task, iso, stopFile } = run;
  if (!judgeResult(task, iso)) return;
  const failure = await checkTask(dir, task, iso.wtCwd, stopFile);
  if (failure) settleChecks(task, failure);
  else await mergeBack(dir, task, iso, () => finishChecks(dir, task, iso.cwd, stopFile));
}

async function finishTurn(run, end) {
  const { dir, state, task, cwd, stopFile, touched, before } = run;
  // Codex 已结束：面板据 turnEnded 收起插话框；被中断时没收到结束的命令记为失败
  task.turnEnded = true;
  for (const step of task.recent) if (step.status === "running") step.status = "failed";
  dropSteers(run);
  save();
  // 并行任务刚写的文件，改文件记录可能还在管道里没处理；稍等再拍结束快照，免得被记成来源未定
  if (task.writes && !run.iso) await new Promise((resolve) => setTimeout(resolve, SCOPE_SETTLE_MS));

  if (end.status === "completed") {
    writeTaskResult(run);
    if (run.iso) await finishIsolated(run);
    else {
      // 写入核对在验收之前，验收命令的产物不算 Codex 写的
      if (task.writes) task.scope = scopeReport(state, task, cwd, touched, before, before ? gitSnapshot(cwd) : null);
      await finishChecks(dir, task, cwd, stopFile);
    }
  } else if (end.status === "interrupted") {
    task.status = "cancelled";
    task.error = task.stopRequested ? "已按要求停止" : "被中断";
  } else {
    task.status = "failed";
    task.error = end.error || `turn ${end.status}`;
    task.failureKind = "execution";
  }
  // 失败或被停掉的任务也可能已经写了文件；隔离任务的改动只在 worktree 里，收尾时存进引用
  if (end.status !== "completed" && task.writes && !run.iso) task.scope = scopeReport(state, task, cwd, touched, before, before ? gitSnapshot(cwd) : null);
  if (run.iso) closeWorktree(task, run.iso);
  // 面板刷新有几秒延迟，验收期间可能又写进来插话
  dropSteers(run);
  task.endedAt = nowIso();
  save();
}

export async function runTask(dir, state, task, prompt, cwd) {
  const run = prepareTask(dir, state, task, prompt, cwd);
  try {
    // 隔离任务在 worktree 里跑：Codex、改文件记录和验收都用 worktree 内对应的目录，state 里的 cwd 仍是原目录
    if (task.isolation === "worktree") {
      run.iso = openWorktree(dir, task, cwd);
      run.cwd = run.iso.wtCwd;
      save();
    }
    await startTurn(run);
  } catch (error) {
    servers.delete(run.server);
    await run.server?.close();
    task.status = "failed";
    task.error = `启动失败：${error.message}`;
    task.failureKind = "execution";
    if (run.iso) closeWorktree(task, run.iso);
    task.endedAt = nowIso();
    run.log({ method: "start-failed", error: error.message });
    dropSteers(run);
    save();
    return;
  }

  const poll = startControlPoll(run);
  const end = await run.turnDone;
  clearInterval(poll);
  servers.delete(run.server);
  await run.server.close();
  await finishTurn(run, end);
}
