// 计算单发任务的实时 token、上下文和结束用量；续接与分叉按原有基线结算。
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, statePath, isAlive } from "./state.mjs";
import { findRollout, findArchivedRollout, readCompleteRecords } from "./rollout.mjs";

const USAGE_FIELDS = { input: "input_tokens", cachedInput: "cached_input_tokens", output: "output_tokens" };
function usageParts(usage) {
  return Object.fromEntries(Object.entries(USAGE_FIELDS).filter(([, key]) => Number.isFinite(usage?.[key]) && usage[key] >= 0).map(([name, key]) => [name, usage[key]]));
}

function applyUsageParts(task, total, last = null) {
  const values = usageParts(total);
  const previous = usageParts(last);
  task.usageBaseline ??= {};
  const own = {};
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(task.usageBaseline[key]) && Number.isFinite(previous[key]) && value >= previous[key]) task.usageBaseline[key] = value - previous[key];
    const baseline = task.usageBaseline[key];
    if (Number.isFinite(baseline) && value >= baseline) own[key] = value - baseline;
  }
  if (Object.keys(own).length) task.tokenUsage = own;
}

// 历史补录读原始累计值；缺字段或缺基线时留空，不按当前上下文猜累计输入。
export function tokenBreakdown(task, startedAt, endedAt, kind) {
  if (task.tokenUsage) return task.tokenUsage;
  const copy = structuredClone(task);
  const file = findRollout(task.threadId) ?? findArchivedRollout(task.threadId);
  if (!file) return null;
  const records = readCompleteRecords(file, { offset: 0 });
  if (kind === "flow" || (!task.resumed && !task.forkedFrom)) copy.usageBaseline = { input: 0, cachedInput: 0, output: 0 };
  else {
    let latest = -Infinity;
    for (const event of records) {
      const timestamp = Date.parse(event.timestamp), info = tokenInfo(event);
      if (info && timestamp < Date.parse(startedAt) && timestamp >= latest) {
        latest = timestamp;
        copy.usageBaseline = usageParts(info.total_token_usage);
      }
    }
  }
  applyTokenRecords(copy, records, startedAt, endedAt);
  return copy.tokenUsage ?? null;
}

export function usageTokens(usage) {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens) ||
      usage.input_tokens < 0 || usage.output_tokens < 0) return null;
  return usage.input_tokens + usage.output_tokens;
}

// 当前上下文和本次运行的输出（Claude Code 的显示口径）。续接、分叉时输出从本次开始计：
// 基线取开始前最后一条累计值，没有就用窗口内第一条的累计减去它自己那一次。
function contextOf(task, info) {
  const output = info.total_token_usage?.output_tokens;
  const context = info.last_token_usage?.input_tokens;
  const lastOutput = info.last_token_usage?.output_tokens;
  if (!Number.isFinite(output) || !Number.isFinite(context)) return false;
  if (!Number.isFinite(task.outputBaseline)) {
    if (!Number.isFinite(lastOutput) || lastOutput > output) return false;
    task.outputBaseline = output - lastOutput;
  }
  const own = output - task.outputBaseline;
  if (own < 0 || (task.context === context && task.output === own)) return false;
  Object.assign(task, { context, output: own });
  return true;
}

function tokenInfo(event) {
  if (event.type !== "event_msg" || event.payload?.type !== "token_count") return null;
  const info = event.payload.info;
  return info && usageTokens(info.total_token_usage) !== null ? info : null;
}

export function applyTokenRecords(task, records, startedAt, endedAt = null) {
  let changed = false;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Infinity;
  for (const event of records) {
    const timestamp = Date.parse(event.timestamp);
    if (!(timestamp >= start && timestamp <= end)) continue;
    const info = tokenInfo(event);
    if (!info) continue;
    const total = usageTokens(info.total_token_usage);
    const beforeParts = JSON.stringify([task.usageBaseline, task.tokenUsage]);
    if (!task.resumed && !task.forkedFrom) task.usageBaseline ??= { input: 0, cachedInput: 0, output: 0 };
    applyUsageParts(task, info.total_token_usage, info.last_token_usage);
    if (JSON.stringify([task.usageBaseline, task.tokenUsage]) !== beforeParts) changed = true;
    if (!Number.isFinite(task.tokenBaseline)) {
      const last = usageTokens(info.last_token_usage);
      if (last === null || last > total) continue;
      task.tokenBaseline = total - last;
      changed = true;
    }
    const tokens = total - task.tokenBaseline;
    if (tokens >= 0 && task.tokens !== tokens) {
      task.tokens = tokens;
      changed = true;
    }
    if (contextOf(task, info)) changed = true;
  }
  return changed;
}

export function singleWatchTick(dir, cache, { now = Date.now, find = findRollout } = {}) {
  const state = readJson(statePath(dir));
  if (!state || state.status !== "running" || !isAlive(state.pid)) return false;
  const task = state.tasks[0];
  let changed = false;
  if (!task.threadId) {
    for (const event of readCompleteRecords(path.join(dir, "events.jsonl"), cache.events)) {
      if (event.type === "thread.started" && event.thread_id) {
        task.threadId = event.thread_id;
        changed = true;
        break;
      }
    }
  }
  if (cache.rollout && !fs.existsSync(cache.rollout)) cache.rollout = null;
  if (!cache.rollout && task.threadId) {
    const at = now();
    cache.searchStartedAt ??= at;
    const fullSearch = at - cache.searchStartedAt >= 30000 &&
      (cache.lastFullSearchAt === undefined || at - cache.lastFullSearchAt >= 10000);
    // 查找失败或抛错也算一次，避免下一轮立刻重扫全目录。
    if (fullSearch) cache.lastFullSearchAt = at;
    cache.rollout = find(task.threadId, { recentOnly: !fullSearch, now: at });
  }
  if (cache.rollout) changed = applyTokenRecords(task, readCompleteRecords(cache.rollout, cache.cursor), state.startedAt) || changed;
  if (changed) writeJson(statePath(dir), state);
  return true;
}

export async function watchSingle(dir, {
  tick = singleWatchTick, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const cache = { events: { offset: 0 }, cursor: { offset: 0 }, rollout: null, searchStartedAt: now() };
  for (;;) {
    try {
      if (!tick(dir, cache, { now })) return;
    } catch {
      // 本轮可能已推进游标却未成功保存，重读以免丢失未登记的事件。
      cache.events = { offset: 0 };
      cache.cursor = { offset: 0 };
      // 文件和状态可能临时变化；只跳过这一轮，父进程消失时仍退出。
      const state = readJson(statePath(dir));
      if (!state || state.status !== "running" || !isAlive(state.pid)) return;
    }
    await wait(2000);
  }
}

export function settleSingleTokens(task, startedAt, endedAt, usage) {
  const file = findRollout(task.threadId);
  const records = file ? readCompleteRecords(file, { offset: 0 }) : [];
  if (!Number.isFinite(task.tokenBaseline)) {
    if (!task.resumed && !task.forkedFrom) {
      task.tokenBaseline = 0;
      task.outputBaseline ??= 0;
      task.usageBaseline ??= { input: 0, cachedInput: 0, output: 0 };
    } else {
      let latest = -Infinity;
      for (const event of records) {
        const timestamp = Date.parse(event.timestamp);
        const info = tokenInfo(event);
        if (timestamp < Date.parse(startedAt) && timestamp >= latest && info) {
          latest = timestamp;
          task.tokenBaseline = usageTokens(info.total_token_usage);
          task.usageBaseline = usageParts(info.total_token_usage);
          if (Number.isFinite(info.total_token_usage.output_tokens)) task.outputBaseline = info.total_token_usage.output_tokens;
        }
      }
    }
  }
  // 结束时没有实时基线，续接和分叉只能用开始前的累计值；不能凭空按零结算。
  if (Number.isFinite(task.tokenBaseline)) applyTokenRecords(task, records, startedAt, endedAt);
  const total = usageTokens(usage);
  if (total !== null && Number.isFinite(task.tokenBaseline) && total >= task.tokenBaseline) {
    task.tokens = total - task.tokenBaseline;
    applyUsageParts(task, usage);
  }
}
