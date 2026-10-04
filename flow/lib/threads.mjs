// Codex 对话归档，做法同 Claude Workflow 的子代理记录：全文保留（~/.codex/archived_sessions），但不出现在 Codex 桌面端的列表里。
// app-server 开的对话 Codex 记为交互会话，不归档就会出现在桌面端的「最近」和「项目」里。CODEX_FLOW_ARCHIVE_THREADS=0 时不归档
import { AppServer } from "./appserver.mjs";
import { servers } from "./runtime.mjs";

const ARCHIVE_TIMEOUT_MS = 5000;
const archiving = () => process.env.CODEX_FLOW_ARCHIVE_THREADS !== "0";

// 归档一条对话，成功返回 true；失败只影响桌面端列表
async function archiveOne(server, threadId) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("归档超时")), ARCHIVE_TIMEOUT_MS);
  });
  try {
    await Promise.race([server.request("thread/archive", { threadId }), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 任务结束、关 app-server 之前，由写入它的那个 app-server 归档；没成功的留给 archiveLeftovers
export async function archiveThread(server, task) {
  if (archiving() && task.threadId && !task.threadArchived && (await archiveOne(server, task.threadId))) task.threadArchived = true;
}

// 补归档：被停止或归档失败留下的对话，加上续跑时被换下来的旧任务没归档成的对话（state.leftovers.threads）。
// 写入它们的 app-server 已经关掉，另起一个来归档；最多等 timeoutMs，到时关掉它（不理 SIGTERM 的强制结束）再返回
export async function archiveLeftovers(state, timeoutMs) {
  const tasks = state.tasks.filter((t) => t.threadId && !t.threadArchived);
  const loose = state.leftovers?.threads ?? [];
  if (!archiving() || (!tasks.length && !loose.length)) return;
  let server = null;
  const work = (async () => {
    // 一起来就登记进 servers：补归档期间收到停止信号时 onStop 会连它一起关掉
    await AppServer.start({ cwd: state.cwd, onSpawn: (s) => { server = s; servers.add(s); } });
    for (const task of tasks) await archiveThread(server, task);
    for (const id of [...loose]) if (await archiveOne(server, id)) loose.splice(loose.indexOf(id), 1);
  })().catch(() => {});
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
  await server?.close();
  servers.delete(server);
}
