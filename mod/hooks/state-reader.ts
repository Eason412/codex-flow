// 解析执行器快照并收集本会话的运行；缓存和读写能力由入口传入。
import type { FlowRun, FlowTask } from '../types'
import { since } from './format'

const MAX_RUNS = 10
const RESULT_LIMIT = 9000
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled'])

// 单个任务的状态字段和显示用统计；运行进程丢失时同步任务状态。
function toTask(t: any, status: string, now: number): FlowTask {
  return {
    label: String(t.label),
    phase: String(t.phase),
    model: String(t.model),
    effort: String(t.effort),
    // 执行器记下请求的 tier（serviceTier）和 Codex 回报的 tier（actualServiceTier）；单发新开的 exec 没有回报
    fast: (t.actualServiceTier ?? t.serviceTier) === 'priority',
    brief: String(t.brief ?? ''),
    status: status === 'lost' && t.status === 'running' ? 'lost' : String(t.status),
    seconds: since(t.startedAt ?? null, t.endedAt ?? null, now),
    result: t.result ?? null,
    error: t.error ?? null,
    log: t.log ?? null,
    reused: t.reused === true,
    // 照 Claude Code 的口径显示：当前上下文 + 本次运行的输出；旧记录没有这两项时退回累计用量
    tokens: typeof t.context === 'number' && typeof t.output === 'number' ? t.context + t.output : typeof t.tokens === 'number' ? t.tokens : null,
    recent: Array.isArray(t.recent)
      ? t.recent.filter((s: any) => s && typeof s.kind === 'string' && typeof s.text === 'string')
        .map((s: any) => ({ kind: s.kind, text: s.text, ...(typeof s.status === 'string' ? { status: s.status } : {}) }))
      : [],
    activity: t.activity && typeof t.activity === 'object'
      ? { commands: Number(t.activity.commands) || 0, edits: Number(t.activity.edits) || 0, messages: Number(t.activity.messages) || 0 }
      : null,
    // 执行器在验收中被杀时 checking 会留下；只在任务仍运行时算数
    checking: t.checking === true && t.status === 'running' && status !== 'lost',
    turnEnded: t.turnEnded === true,
  }
}

function toRun(dir: string, state: any, now: number, alive: Set<number>, lostSince: Map<string, number>): FlowRun {
  const status = state.status === 'running' && !alive.has(state.pid) ? 'lost' : String(state.status)
  if (status !== 'lost') lostSince.delete(state.runId)
  let endedSeconds: number | null = null
  // 保留小数：显示耗时可以四舍五入，RECENT 的截止时间不能提前半秒。
  if (state.endedAt) endedSeconds = Math.max(0, (now - Date.parse(state.endedAt)) / 1000)
  else if (status === 'lost') {
    if (!lostSince.has(state.runId)) lostSince.set(state.runId, now)
    endedSeconds = Math.max(0, (now - (lostSince.get(state.runId) ?? now)) / 1000)
  }
  return {
    runId: String(state.runId),
    dir,
    kind: state.kind === 'single' ? 'single' : 'flow',
    name: String(state.name),
    pid: Number(state.pid),
    status,
    seconds: since(state.startedAt, state.endedAt, now),
    endedSeconds,
    alertAfter: typeof state.alertAfter === 'number' ? state.alertAfter : null,
    phases: (state.phases ?? []).map((p: any) => ({ title: String(p.title), status: String(p.status) })),
    tasks: (state.tasks ?? []).map(
      (t: any) => toTask(t, status, now),
    ),
  }
}

// 拒绝能解析但字段缺失的快照；pending 任务允许没有开始/结束时间。
function validState(state: any) {
  const text = (value: any) => typeof value === 'string'
  const date = (value: any) => text(value) && Number.isFinite(Date.parse(value))
  const optionalDate = (value: any) => value == null || date(value)
  return state != null && text(state.runId) && state.runId.length > 0 && text(state.name) &&
    (text(state.session) || state.session === null) && text(state.status) &&
    (state.kind === 'flow' || state.kind === 'single') && Number.isFinite(state.pid) &&
    date(state.startedAt) && optionalDate(state.endedAt) &&
    Array.isArray(state.phases) && state.phases.every((p: any) => p && text(p.title) && text(p.status)) &&
    Array.isArray(state.tasks) && state.tasks.every((t: any) => t &&
      ['label', 'phase', 'model', 'effort', 'status'].every(key => text(t[key])) &&
      optionalDate(t.startedAt) && optionalDate(t.endedAt))
}

export type ReaderContext = {
  root: string
  session: string
  now: number
  otherSession: Map<string, number>
  goodStates: Map<string, any>
  reportedErrors: Map<string, Set<string>>
  lostSince: Map<string, number>
  list: () => Promise<{ name: string; kind: string }[]>
  exists: () => Promise<boolean>
  readText: (path: string) => Promise<string>
  stateMtime: (dir: string) => Promise<number | null>
  alivePids: (pids: number[]) => Promise<Set<number>>
  current: () => Promise<FlowRun[]>
  // 提醒读取全部本会话运行，不受面板历史条数限制。
  collect: (list: FlowRun[]) => void
  record: (list: FlowRun[], errors: string[], newErrors: string[]) => void
}

function reportFailure(ctx: ReaderContext, errors: string[], newErrors: string[]) {
  return (dir: string, kind: string, error: unknown) => {
    const message = `${dir}${['read', 'json', 'state'].includes(kind) ? '/state.json' : ''}: ${String(error)}`
    errors.push(message)
    const reported = ctx.reportedErrors.get(dir) ?? new Set<string>()
    if (!reported.has(kind)) {
      reported.add(kind)
      ctx.reportedErrors.set(dir, reported)
      newErrors.push(message)
    }
  }
}

type Failure = ReturnType<typeof reportFailure>
async function listEntries(ctx: ReaderContext, failure: Failure) {
  try {
    return await ctx.list()
  } catch (error) {
    // 不存在是尚未派过任务；存在但读不了时保留整个当前面板。
    let exists = true
    try {
      exists = await ctx.exists()
    } catch (existsError) {
      failure(ctx.root, 'exists', existsError)
    }
    if (exists) {
      failure(ctx.root, 'list', error)
      return null
    }
    return []
  }
}

function pruneCaches(ctx: ReaderContext, entries: { name: string; kind: string }[]) {
  // list 成功（或根目录已消失）才清理，临时 list 失败不能丢掉缓存。
  const present = new Set(entries.filter(e => e.kind === 'dir').map(e => `${ctx.root}/${e.name}`))
  ctx.reportedErrors.delete(ctx.root)
  for (const dir of ctx.goodStates.keys()) if (!present.has(dir)) ctx.goodStates.delete(dir)
  for (const dir of ctx.reportedErrors.keys()) if (!present.has(dir)) ctx.reportedErrors.delete(dir)
  for (const dir of ctx.otherSession.keys()) if (!present.has(dir)) ctx.otherSession.delete(dir)
}

async function scanStates(ctx: ReaderContext, entries: { name: string; kind: string }[], failure: Failure) {
  const found: { dir: string; state: any }[] = []
  for (const entry of entries) {
    const dir = `${ctx.root}/${entry.name}`
    if (entry.kind !== 'dir') continue
    const seen = ctx.otherSession.get(dir)
    if (seen !== undefined) {
      if (await ctx.stateMtime(dir) === seen) continue
      ctx.otherSession.delete(dir)
    }
    let state: any
    let kind = 'read'
    try {
      const text = await ctx.readText(`${dir}/state.json`)
      kind = 'json'
      state = JSON.parse(text)
      kind = 'state'
      if (!validState(state)) throw new Error('incomplete state')
      ctx.goodStates.set(dir, state)
      ctx.reportedErrors.delete(dir)
    } catch (error) {
      failure(dir, kind, error)
      state = ctx.goodStates.get(dir)
      if (!state) continue
    }
    if (state.session !== ctx.session) {
      if (TERMINAL.has(state.status)) {
        const mtime = await ctx.stateMtime(dir)
        if (mtime !== null) ctx.otherSession.set(dir, mtime)
      }
      continue
    }
    found.push({ dir, state })
  }

  return found
}

export async function readRunList(ctx: ReaderContext) {
  const errors: string[] = []
  const newErrors: string[] = []
  const failure = reportFailure(ctx, errors, newErrors)
  const entries = await listEntries(ctx, failure)
  if (!entries) {
    ctx.record(await ctx.current(), errors, newErrors)
    return null
  }
  pruneCaches(ctx, entries)
  const found = await scanStates(ctx, entries, failure)
  found.sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)))
  const alive = await ctx.alivePids(found.filter(r => r.state.status === 'running').map(r => Number(r.state.pid)))
  // 先检查所有进程再限历史条数，失联的运行也按非运行计数。
  let history = 0
  const all = found.map(r => toRun(r.dir, r.state, ctx.now, alive, ctx.lostSince))
  ctx.collect(all)
  const list = all.filter(r => r.status === 'running' || history++ < MAX_RUNS)
  ctx.record(list, errors, newErrors)
  return list
}

export async function loadResult(readText: (path: string) => Promise<string>, run: FlowRun, task: FlowTask) {
  if (!task.result) return null
  try {
    const text = await readText(`${run.dir}/${task.result}`)
    if (text.length <= RESULT_LIMIT) return text
    return `${text.slice(0, RESULT_LIMIT)}\n\n…（完整结果见 ${run.dir}/${task.result}）`
  } catch {
    return null
  }
}
