// 查找和读取 Codex 会话 JSONL，保留字节游标、日期优先顺序及实际 context 的时间窗。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// JSONL 中损坏的行和非对象值都不参与事件或会话解析。
export function jsonlObjects(text) {
  const records = [];
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
      // Codex 被中断时可能留下未写完的一行。
    }
  }
  return records;
}

const sessionRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");

export const matchesRollout = (name, threadId) => name.startsWith("rollout-") &&
  (name.endsWith(`-${threadId}.jsonl`) || name.endsWith(`_${threadId}.jsonl`));

// 先查本地日期的最近 3 天；watcher 启动前 30 秒只查这些目录。
export function findRollout(threadId, { recentOnly = false, now = Date.now() } = {}) {
  if (!threadId) return null;
  const root = sessionRoot();
  const visited = new Set();
  function visit(dir) {
    if (visited.has(dir)) return null;
    visited.add(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && matchesRollout(entry.name, threadId)) return file;
      if (entry.isDirectory()) {
        const found = visit(file);
        if (found) return found;
      }
    }
    return null;
  }
  for (let ago = 0; ago < 3; ago++) {
    const date = new Date(now);
    date.setDate(date.getDate() - ago);
    const found = visit(path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
    if (found) return found;
  }
  return recentOnly ? null : visit(root);
}

// 游标按字节计，只推进到最后一个换行；半行在下次追加后重新读取。
export function readCompleteRecords(file, cursor) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    const identity = `${stat.dev}:${stat.ino}`;
    if (cursor.identity !== identity || stat.size < cursor.offset) cursor.offset = 0;
    cursor.identity = identity;
    const chunks = [];
    let position = cursor.offset;
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - position));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      chunks.push(buffer.subarray(0, read));
      position += read;
    }
    const bytes = Buffer.concat(chunks);
    const end = bytes.lastIndexOf(10);
    if (end < 0) return [];
    cursor.offset += end + 1;
    return jsonlObjects(bytes.subarray(0, end + 1).toString("utf8"));
  } catch {
    // 尚未生成、已压缩/移走或暂时不可读，下一次再查。
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function singleContext(threadId, startedAt, endedAt) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  let found = false;
  let context = null;
  let tier = null;
  let latest = Date.parse(startedAt);
  let tierAt = latest;
  const end = Date.parse(endedAt);
  // Codex exec 事件没有 turn id；同一 thread 在时间窗内被并发续跑时，无法区分各轮 context。
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && matchesRollout(entry.name, threadId)) {
        found = true;
        for (const event of jsonlObjects(fs.readFileSync(file, "utf8"))) {
          const timestamp = Date.parse(event.timestamp);
          if (event.type === "turn_context" && timestamp >= latest && timestamp <= end &&
              event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
            latest = timestamp;
            context = event.payload;
          }
          // 续聊和分叉会写 thread_settings_applied，里面有实际的 service tier；新开的 exec 不写
          const settings = event.payload?.type === "thread_settings_applied" ? event.payload.thread_settings : null;
          if (settings && typeof settings.service_tier === "string" && timestamp >= tierAt && timestamp <= end) {
            tierAt = timestamp;
            tier = settings.service_tier;
          }
        }
      }
    }
  }
  if (threadId) visit(root);
  return { found, context, tier };
}
