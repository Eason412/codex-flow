// Codex 对话归档，做法同 Claude Workflow 的子代理记录：全文保留（~/.codex/archived_sessions），但不出现在 Codex 桌面端的列表里。
// app-server 开的对话 Codex 记为交互会话，不归档就会出现在桌面端的「最近」和「项目」里。CODEX_FLOW_ARCHIVE_THREADS=0 时不归档
import { AppServer } from "./appserver.mjs";

const ARCHIVE_TIMEOUT_MS = 5000;
const archiving = () => process.env.CODEX_FLOW_ARCHIVE_THREADS !== "0";

// 任务结束、关 app-server 之前，由写入它的那个 app-server 归档；失败只影响桌面端列表，结束时再补一次
export async function archiveThread(server, task) {
  if (!archiving() || !task.threadId || task.threadArchived) return;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("归档超时")), ARCHIVE_TIMEOUT_MS);
    });
    await Promise.race([server.request("thread/archive", { threadId: task.threadId }), timeout]).finally(() => clearTimeout(timer));
    task.threadArchived = true;
  } catch {
    // 留给 archiveLeftovers
  }
}

// 补归档：被停止或归档失败留下的对话。写入它们的 app-server 已经关掉，另起一个新的来归档
export async function archiveLeftovers(state) {
  const left = state.tasks.filter((t) => t.threadId && !t.threadArchived);
  if (!archiving() || !left.length) return;
  let server = null;
  try {
    server = await AppServer.start({ cwd: state.cwd });
    for (const task of left) await archiveThread(server, task);
  } catch {
    // 起不来就算了，对话只是留在桌面端列表里
  } finally {
    await server?.close();
  }
}
