// codex-flow：输入框上方的面板看本会话派出的 Codex 任务、停任务；任务跑满阈值（默认 15 分钟）时在对话里提醒主 Agent 排查。
// 只读执行器写的 state.json，不负责跑任务：mod 重载或没加载时，任务照常跑完。
// 有新任务开始时面板自动出现，全部结束 30 秒后自动收起；全部结束后可用 q 关闭，同一批任务不再弹出。/flow 只打开。面板显示时状态行让出 codex 那一行。
// 只有一个 flow 时照 Workflow 详情面板画带边框的两栏（左栏阶段，右栏 agent：模型、effort、token、耗时）；
// 其余情况（单个 agent、多个任务）一行一个，flow 标紫色、agent 标蓝色，Enter 进入，b 逐层退回。
// 这块区域 mod 拿不到键盘，要用户按 ctrl+x tab 或点一下才能用键盘操作；只看进度不用碰键盘，内容每 2 秒刷新。
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderElement } from 'claude-code'

import type { FlowRun, FlowTask, Nav, PanelRecord, WindowColumn, WindowStarts } from '../types'

const REFRESH_MS = 2000
const DEFAULT_ALERT_AFTER = 900
const MAX_RUNS = 10
const RESULT_LIMIT = 9000
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled'])
// 结束后还显示多少秒，让用户看到 ✓/✗
const RECENT = 30
const TOP: Nav = { runId: null, level: null, phase: null, label: null, text: null }

// 配色取自用户 ccstatusline 的设置（Tokyo Night），和状态行那一行一致
const CYAN = '#7DCFFF'
const GREEN = '#9ECE6A'
const RED = '#F7768E'
const YELLOW = '#E0AF68'
const BLUE = '#7AA2F7'
const PURPLE = '#BB9AF7'
// 运行中的标记，只在有任务运行且面板显示时动：阶段和 flow 用闪烁的星形（与 Claude Code 自己的 ✻ 指示一致），
// agent 用转圈的细点阵，两层一眼能分开。星形不用「·」这一帧，免得看起来像停了。
const SPIN = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
const AGENT_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 120
// 会随运行增长的栏位按上限预留宽度，时间从 59s 长到 1h02m、token 从 999 长到 999.9k 时版面不跳
// 时长最长 6 格（59m59s、99h59m），前留一格；token 最长 6 格（999.9k）加 " tok"，前留一格
const TIME_SLOT = 7
const TOKEN_SLOT = 11
// 按类型区分：flow 紫色，单个 agent 蓝色；按钮文字上不了色，所以在名称前标类型
const KIND: Record<FlowRun['kind'], [string, string]> = { flow: ['flow', PURPLE], single: ['agent', BLUE] }

const runs = atom({ plugin: 'codex-flow', key: 'runs' } as const, [] as FlowRun[])
const nav = atom({ plugin: 'codex-flow', key: 'nav' } as const, TOP)
const focused = atom({ plugin: 'codex-flow', key: 'focused' } as const, null as string | null)
const reminded = atom({ plugin: 'codex-flow', key: 'reminded' } as const, [] as string[])
// 主对话是否正在跑一轮：插件提交的提醒要等空闲才送达，在忙时先不提交，免得送到时任务已经结束
const working = atom({ plugin: 'codex-flow', key: 'working' } as const, false)
// 输入框上方是否显示面板：/flow 打开，全部结束后 q 关闭
const shown = atom({ plugin: 'codex-flow', key: 'shown' } as const, false)
const opened = atom({ plugin: 'codex-flow', key: 'opened' } as const, [] as string[])
const auto = atom({ plugin: 'codex-flow', key: 'auto' } as const, false)
const frame = atom({ plugin: 'codex-flow', key: 'frame' } as const, 0)
const EMPTY_WINDOWS: WindowStarts = { runs: 0, phases: 0, agents: 0, detailAgents: 0 }
const windows = atom({ plugin: 'codex-flow', key: 'windows' } as const, EMPTY_WINDOWS)
// 焦点事件沿用当前绘制的容量；各列起点保存在 $.state。
let windowSize = 12

// 别的会话里已结束的运行不再每次读；记下 state.json 的修改时间，被本会话续跑（--resume）改写后重新读
const otherSession = new Map<string, number>()
// 按完整目录缓存有效状态：一次读取失败不会让这个运行消失，也不会阻断别的运行。
const goodStates = new Map<string, any>()
const reportedErrors = new Map<string, Set<string>>()
// 正在进行的刷新：再调用时等它完成，不并发、也不拿旧数据
let inflight: Promise<void> | null = null
// 输入框上方那块区域的 id，渲染时记下，移动光标要用
let bandId: string | null = null
// 进程丢了的运行没有结束时间，按第一次发现的时刻算
const lostSince = new Map<string, number>()
// 模块实例独有：同名副本的 $.state 地址相同，但来源目录、重载代次和读取快照可区分。
const instance = crypto.randomUUID()
// 状态变更保持调用顺序；文件写入另排一条队列，不让慢写入阻塞后续状态变更。
let panelChanges: Promise<void> = Promise.resolve()
// 星形动画的计时器：有任务在跑且面板显示时开，否则关
let spinTimer: ReturnType<Engine['clock']['every']> | null = null
let panelWrites: Promise<void> = Promise.resolve()
let snapshot: PanelRecord['snapshot'] = null
let latestPanel: Pick<PanelRecord, 'shown' | 'auto' | 'by'> = { shown: false, auto: false, by: 'reload' }

const fileSafe = (label: string) => label.replace(/[\/\\:*?"<>|\s]+/g, '_')
const shortModel = (model: string) => String(model || '').replace(/^gpt-/, '')
const runKey = (runId: string) => `r:${runId}`
const phaseKey = (title: string) => `p:${title}`
const taskKey = (runId: string, label: string) => `t:${runId}:${label}`

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function since(startedAt: string | null, endedAt: string | null, now: number) {
  if (!startedAt) return 0
  const end = endedAt ? Date.parse(endedAt) : now
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000))
}

// 终端里中文占两格
function cells(text: string) {
  let n = 0
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1
  return n
}

async function flowHome($: Engine) {
  return (await $.env.get('CODEX_FLOW_HOME')) || `${await $.env.get('HOME')}/.claude/codex-flow`
}

const runsRoot = async ($: Engine) => `${await flowHome($)}/runs`

async function alivePids($: Engine, pids: number[]) {
  if (!pids.length) return new Set<number>()
  try {
    const { stdout } = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')])
    return new Set(stdout.split('\n').map(s => Number(s.trim())).filter(Boolean))
  } catch {
    // 查不了进程时按都还活着处理，不误报“已退出”
    return new Set(pids)
  }
}

function toRun(dir: string, state: any, now: number, alive: Set<number>): FlowRun {
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
      (t: any): FlowTask => ({
        label: String(t.label),
        phase: String(t.phase),
        model: String(t.model),
        effort: String(t.effort),
        brief: String(t.brief ?? ''),
        status: status === 'lost' && t.status === 'running' ? 'lost' : String(t.status),
        seconds: since(t.startedAt ?? null, t.endedAt ?? null, now),
        result: t.result ?? null,
        error: t.error ?? null,
        log: t.log ?? null,
        reused: t.reused === true,
        tokens: typeof t.tokens === 'number' ? t.tokens : null,
      }),
    ),
  }
}

async function readText($: Engine, path: string) {
  return String(await $.fs.read(path))
}

async function stateMtime($: Engine, dir: string) {
  try {
    return (await $.fs.stat(`${dir}/state.json`)).mtimeMs
  } catch {
    return null
  }
}

async function loadResult($: Engine, run: FlowRun, task: FlowTask) {
  if (!task.result) return null
  try {
    const text = await readText($, `${run.dir}/${task.result}`)
    if (text.length <= RESULT_LIMIT) return text
    return `${text.slice(0, RESULT_LIMIT)}\n\n…（完整结果见 ${run.dir}/${task.result}）`
  } catch {
    return null
  }
}

// fresh：/flow 打开时要自己读一遍，不用别的调用发起、可能已经过时的那次
async function syncSpinner($: Engine) {
  const active = (await read($, shown)) && (await read($, runs)).some(r => r.status === 'running')
  if (active && !spinTimer) spinTimer = $.clock.every(SPIN_MS, () => void update($, frame, n => (n + 1) % (SPIN.length * AGENT_SPIN.length)))
  if (!active && spinTimer) {
    spinTimer.cancel()
    spinTimer = null
  }
}

async function refresh($: Engine, fresh = false) {
  if (inflight && !fresh) return inflight
  if (inflight) await inflight.catch(() => undefined)
  const mine = readRuns($).finally(() => {
    if (inflight === mine) inflight = null
  })
  inflight = mine
  return mine
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

async function readRuns($: Engine) {
  const root = await runsRoot($)
  const session = await $.session.id()
  const now = await $.clock.now()
  const errors: string[] = []
  const newErrors: string[] = []
  const failure = (dir: string, kind: string, error: unknown) => {
    const message = `${dir}${['read', 'json', 'state'].includes(kind) ? '/state.json' : ''}: ${String(error)}`
    errors.push(message)
    const reported = reportedErrors.get(dir) ?? new Set<string>()
    if (!reported.has(kind)) {
      reported.add(kind)
      reportedErrors.set(dir, reported)
      newErrors.push(message)
    }
  }
  const logErrors = () => {
    if (newErrors.length) $.ui.log(JSON.stringify({ event: 'refresh-incomplete', source: { root: $.plugin.root, instance }, snapshot: { ...snapshot, errors: newErrors } }), { to: 'debug' })
  }
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(root)
  } catch (error) {
    // 不存在是尚未派过任务；存在但读不了时保留整个当前面板。
    let exists = true
    try {
      exists = await $.fs.exists(root)
    } catch (existsError) {
      failure(root, 'exists', existsError)
    }
    if (exists) {
      failure(root, 'list', error)
      snapshot = {
        at: new Date(now).toISOString(), complete: false, errors,
        runs: (await read($, runs)).map(({ runId, status, endedSeconds }) => ({ runId, status, endedSeconds })),
      }
      logErrors()
      return
    }
  }
  // list 成功（或根目录已消失）才清理，临时 list 失败不能丢掉缓存。
  const present = new Set(entries.filter(e => e.kind === 'dir').map(e => `${root}/${e.name}`))
  reportedErrors.delete(root)
  for (const dir of goodStates.keys()) if (!present.has(dir)) goodStates.delete(dir)
  for (const dir of reportedErrors.keys()) if (!present.has(dir)) reportedErrors.delete(dir)
  for (const dir of otherSession.keys()) if (!present.has(dir)) otherSession.delete(dir)
  const found: { dir: string; state: any }[] = []
  for (const entry of entries) {
    const dir = `${root}/${entry.name}`
    if (entry.kind !== 'dir') continue
    const seen = otherSession.get(dir)
    if (seen !== undefined) {
      if (await stateMtime($, dir) === seen) continue
      otherSession.delete(dir)
    }
    let state: any
    let kind = 'read'
    try {
      const text = await readText($, `${dir}/state.json`)
      kind = 'json'
      state = JSON.parse(text)
      kind = 'state'
      if (!validState(state)) throw new Error('incomplete state')
      goodStates.set(dir, state)
      reportedErrors.delete(dir)
    } catch (error) {
      failure(dir, kind, error)
      state = goodStates.get(dir)
      if (!state) continue
    }
    if (state.session !== session) {
      if (TERMINAL.has(state.status)) {
        const mtime = await stateMtime($, dir)
        if (mtime !== null) otherSession.set(dir, mtime)
      }
      continue
    }
    found.push({ dir, state })
  }
  found.sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)))
  const alive = await alivePids(
    $,
    found.filter(r => r.state.status === 'running').map(r => Number(r.state.pid)),
  )
  // 先检查所有进程再限历史条数，失联的运行也按非运行计数。
  let history = 0
  const list = found.map(r => toRun(r.dir, r.state, now, alive))
    .filter(r => r.status === 'running' || history++ < MAX_RUNS)
  snapshot = {
    at: new Date(now).toISOString(),
    complete: errors.length === 0,
    errors,
    runs: list.map(({ runId, status, endedSeconds }) => ({ runId, status, endedSeconds })),
  }
  logErrors()
  await update($, runs, () => list)
  await autoShow($, list)
  await syncWindows($)
  await remind($, list)
  // 结果页打开时任务刚好出了结果，补读一次
  const at = await read($, nav)
  if (at.label && at.text === null) {
    const run = list.find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => t.label === at.label)
    if (run && task?.result) {
      const text = await loadResult($, run, task)
      await update($, nav, n => (n.runId === at.runId && n.label === at.label ? { ...n, text } : n))
    }
  }
}

// 状态决定和变更共用一条队列；慢文件写入不阻塞用户操作。
async function changePanel($: Engine, decide: () => Promise<boolean>) {
  let write: Promise<void> | undefined
  const change = panelChanges.then(async () => {
    if (await decide()) write = writePanel($)
  })
  panelChanges = change.catch(() => undefined)
  await change
  await write
}

// 只在 panelChanges 内调用；完整记下这次 shown/auto 的来源。
async function applyShown($: Engine, value: boolean, by: PanelRecord['by'], isAuto = false) {
  await update($, shown, () => value)
  await update($, auto, () => value && isAuto)
  latestPanel = { shown: value, auto: value && isAuto, by }
  return true
}

function writePanel($: Engine) {
  const write = panelWrites.then(async () => {
    // 取最近一次完整变更，不能让旧排队写入的 by 配上新 shown/auto。
    const current = latestPanel
    try {
      const record: PanelRecord = {
        ...current,
        at: new Date(await $.clock.now()).toISOString(),
        source: { root: $.plugin.root, instance },
        snapshot,
      }
      await $.fs.write(`${await flowHome($)}/panel-${await $.session.id()}.json`, JSON.stringify(record))
      $.ui.log(JSON.stringify({ event: 'panel-write', ...record }), { to: 'debug' })
    } catch (error) {
      $.ui.log(JSON.stringify({ event: 'panel-write-failed', ...current, source: { root: $.plugin.root, instance }, error: String(error) }), { to: 'debug' })
    }
  })
  panelWrites = write.catch(() => undefined)
  return write
}

async function setShown($: Engine, value: boolean, by: PanelRecord['by'], isAuto = false) {
  await changePanel($, () => applyShown($, value, by, isAuto))
}

// 自动打开/收起也排队，排到时重新读用户已更新的 shown/auto。
async function autoShow($: Engine, list: FlowRun[]) {
  await changePanel($, async () => {
    const running = list.filter(r => r.status === 'running')
    const seen = await read($, opened)
    const fresh = running.filter(r => !seen.includes(r.runId))
    if (fresh.length) {
      await update($, opened, old => [...old, ...fresh.map(r => r.runId)].slice(-100))
      const at = await read($, nav)
      const watching = running.some(r => r.runId === at.runId)
      const visible = await read($, shown)
      if (!visible || !watching) await moveTo($, entry(list).to)
      if (!visible) return applyShown($, true, 'auto-open', true)
      return false
    }
    const recent = list.some(r => r.status === 'running' || (r.endedSeconds !== null && r.endedSeconds < RECENT))
    if (!recent && (await read($, shown)) && (await read($, auto))) return applyShown($, false, 'auto-close')
    return false
  })
}

// 任务每跑满一个阈值提醒一次（15m、30m…），只提醒，不停任务；主对话在忙时等它空闲后再按当时的状态提醒
async function remind($: Engine, list: FlowRun[]) {
  if (await read($, working)) return
  const done = await read($, reminded)
  const fresh: string[] = []
  for (const run of list) {
    if (run.status !== 'running') continue
    const after = run.alertAfter ?? (Number(await $.env.get('CODEX_FLOW_ALERT_AFTER')) || DEFAULT_ALERT_AFTER)
    for (const task of run.tasks) {
      if (task.status !== 'running') continue
      const n = Math.floor(task.seconds / after)
      const key = `${run.runId}:${task.label}:${n}`
      if (n < 1 || done.includes(key)) continue
      fresh.push(key)
      const log = task.log ? `${run.dir}/${task.log}` : run.dir
      void $.prompt.submit({
        text:
          `[codex-flow] Codex 任务「${task.label}」（${run.name}，${task.model} ${task.effort}）已运行 ${formatDuration(task.seconds)}。` +
          `请读日志检查进展并向用户汇报；不要自动停止它。日志：${log}  运行目录：${run.dir}`,
      })
    }
  }
  if (fresh.length) await update($, reminded, old => [...old, ...fresh].slice(-200))
}

async function stopTask($: Engine, run: FlowRun, task: FlowTask) {
  if (task.status !== 'running') {
    $.ui.toast(`「${task.label}」不在运行`)
    return
  }
  const at = new Date(await $.clock.now()).toISOString()
  if (run.kind === 'single') {
    // 单发任务：先写停止标记（codex 被停时可能以 0 退出，run.sh 靠它记为已停止），再结束 run.sh 下面的 codex
    try {
      await $.fs.write(`${run.dir}/control/stop`, at)
    } catch {
      // 旧记录没有 control 目录，照样停
    }
    await $.process.run(['pkill', '-TERM', '-P', String(run.pid)])
  } else {
    // flow 任务：写控制文件，执行器每秒检查，向这个任务发中断
    await $.fs.write(`${run.dir}/control/${fileSafe(task.label)}.stop`, at)
  }
  $.ui.toast(`已请求停止「${task.label}」`)
}

// 列表里按 x：停整个 flow（执行器收到 SIGTERM 后写下已停止再退出）；单发任务同 stopTask
async function stopRun($: Engine, run: FlowRun) {
  if (run.status !== 'running') {
    $.ui.toast(`「${run.name}」不在运行`)
    return
  }
  const task = run.tasks[0]
  if (run.kind === 'single' && task) return stopTask($, run, task)
  await $.process.run(['kill', '-TERM', String(run.pid)])
  $.ui.toast(`已请求停止「${run.name}」`)
}

function glyph(status: string): [string, string | undefined] {
  if (status === 'running') return ['●', BLUE]
  if (status === 'completed') return ['✓', GREEN]
  if (status === 'partial') return ['◐', YELLOW]
  if (status === 'failed' || status === 'cancelled' || status === 'lost') return ['✗', RED]
  if (status === 'skipped') return ['–', undefined]
  return ['○', undefined]
}

const WORD: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已停止',
  lost: '已退出',
  skipped: '跳过',
  pending: '等待',
}

const tasksOf = (run: FlowRun, phase: string | null) => run.tasks.filter(t => t.phase === phase)
const doneOf = (tasks: FlowTask[]) => tasks.filter(t => t.status === 'completed').length
// 正在跑的阶段：一个时写「标题 完成/总数」；按依赖提前开跑、几个阶段同时在跑时写「N 个阶段并行 完成/总数」
function livePhases(run: FlowRun) {
  const live = run.phases.filter(p => p.status === 'running')
  const tasks = live.flatMap(p => tasksOf(run, p.title))
  if (!live.length) return null
  return `${live.length === 1 ? live[0]!.title : `${live.length} 个阶段并行`} ${doneOf(tasks)}/${tasks.length}`
}
const tokensOf = (tasks: FlowTask[]) => tasks.reduce((sum, t) => sum + (t.tokens ?? 0), 0)

// 和原生一样写成 12.3k / 1.2M
function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// 按终端格数截断
function fit(text: string, width: number) {
  if (cells(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

// 按终端格数折行，结果页用
function wrap(text: string, width: number) {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let line = ''
    for (const ch of raw) {
      if (cells(line + ch) > width) {
        lines.push(line)
        line = ''
      }
      line += ch
    }
    lines.push(line)
  }
  return lines
}

// 只显示当前的：在跑的和刚结束（RECENT 秒内）的，都没有就留最近一个；更早的记录留给主 Agent 用 codex-flow status 查
// flow 固定排在单个 agent 上面；同类里保持新的在上，任务结束也不挪位置
function currentRuns(list: FlowRun[]) {
  const cur = list.filter(r => r.status === 'running' || (r.endedSeconds !== null && r.endedSeconds < RECENT))
  const rank = (r: FlowRun) => (r.kind === 'flow' ? 0 : 1)
  return cur.length ? cur.sort((a, b) => rank(a) - rank(b)) : list.slice(0, 1)
}

// agent 一行的说明：模型 effort · token · 状态（运行中和完成不写，图标已经表示）
function agentStats(t: FlowTask) {
  const parts = [`${shortModel(t.model)} ${t.effort}`]
  if (t.tokens) parts.push(`${formatTokens(t.tokens)} tok`)
  if (t.status !== 'running' && t.status !== 'completed') parts.push(WORD[t.status] ?? t.status)
  return parts.join(' · ')
}

// 续跑时复用的 agent 耗时栏写“复用”，时长是上次的，不算这次
const agentTime = (t: FlowTask) => (t.reused ? '复用' : t.status === 'running' || t.status === 'completed' ? formatDuration(t.seconds) : '')

function runSubtext(run: FlowRun) {
  const task = run.tasks[0]
  if (run.kind === 'single' && task) {
    const parts = [`${shortModel(task.model)} ${task.effort}`]
    if (task.tokens) parts.push(`${formatTokens(task.tokens)} tok`)
    parts.push(WORD[run.status] ?? run.status, formatDuration(run.seconds))
    return parts.join(' · ')
  }
  const parts = [WORD[run.status] ?? run.status]
  const live = run.kind === 'flow' && run.status === 'running' ? livePhases(run) : null
  if (live) parts.push(live)
  parts.push(`${run.tasks.length} 个 agent`)
  const tokens = tokensOf(run.tasks)
  if (tokens) parts.push(`${formatTokens(tokens)} tok`)
  parts.push(formatDuration(run.seconds))
  return parts.join(' · ')
}

// 阶段耗时：已开始的 agent 中最长的一个（并行 agent 按墙钟算）；没开始的阶段为空
function phaseTime(run: FlowRun, title: string) {
  const started = tasksOf(run, title).filter(t => !t.reused && t.status !== 'pending')
  return started.length ? formatDuration(Math.max(...started.map(t => t.seconds))) : ''
}

// 进入一个 flow 时先选中正在跑的阶段，没有就选第一个
const defaultPhase = (run: FlowRun) => (run.phases.find(p => p.status === 'running') ?? run.phases[0])?.title ?? null

// 打开面板时的位置：当前只有一个 flow 就直接进它的阶段栏；单个 agent、多个任务都先列出来
function entry(list: FlowRun[]): { to: Nav; key: string | null } {
  const cur = currentRuns(list)
  const run = cur.length === 1 && cur[0]?.kind === 'flow' ? cur[0] : undefined
  if (!run) {
    const first = cur.find(r => r.status === 'running') ?? cur[0]
    return { to: TOP, key: first ? runKey(first.runId) : null }
  }
  const phase = defaultPhase(run)
  return { to: { runId: run.runId, level: 'phases' as const, phase, label: null, text: null }, key: phase ? phaseKey(phase) : null }
}

// 退一层：agent 详情 → agent 栏 → 阶段栏 → 任务列表（只有一个当前 flow 时阶段栏就是最外层；单个 agent 的详情直接回列表）；null 表示已在最外层
function up(list: FlowRun[], at: Nav): { to: Nav; key: string | null } | null {
  const run = list.find(r => r.runId === at.runId)
  if (!run || !at.level) return null
  if (run.kind === 'single') return { to: TOP, key: runKey(run.runId) }
  if (at.level === 'agent') return { to: { ...at, level: 'agents' as const, text: null }, key: at.label ? taskKey(run.runId, at.label) : null }
  if (at.level === 'agents' && run.kind === 'flow') return { to: { ...at, level: 'phases' as const, label: null }, key: at.phase ? phaseKey(at.phase) : null }
  if (currentRuns(list).length > 1) return { to: TOP, key: runKey(run.runId) }
  return null
}

async function focusOn($: Engine, key: string | null) {
  if (!key) return
  await update($, focused, () => key)
  await revealFocus($, key)
  try {
    if (bandId) {
      const result = await $.ui.focus({ requestId: bandId, key })
      if (result.deny) $.ui.log(JSON.stringify({ event: 'focus-denied', key, reason: result.deny }), { to: 'debug' })
    }
  } catch (error) {
    $.ui.log(JSON.stringify({ event: 'focus-error', key, error: String(error) }), { to: 'debug' })
  }
}

async function moveTo($: Engine, to: Nav) {
  const before = await read($, nav)
  if (before.runId !== to.runId) {
    await update($, windows, () => ({ ...EMPTY_WINDOWS }))
    await update($, focused, () => null)
  } else if (before.phase !== to.phase) {
    // 同一个 flow 换阶段只清 agent 窗口；阶段窗口由 syncWindows 最小幅度校正。
    await update($, windows, old => ({ ...old, agents: 0, detailAgents: 0 }))
    await update($, focused, () => null)
  }
  await update($, nav, () => to)
  await syncWindows($)
}

function columnKeys(list: FlowRun[], at: Nav, column: WindowColumn): string[] {
  const run = list.find(r => r.runId === at.runId)
  if (column === 'runs') return !run || !at.level ? currentRuns(list).map(r => runKey(r.runId)) : []
  if (!run || run.kind !== 'flow') return []
  if (column === 'phases') return at.level === 'phases' ? run.phases.map(p => phaseKey(p.title)) : []
  if ((column === 'agents' && at.level === 'agents') || (column === 'detailAgents' && at.level === 'agent')) {
    return tasksOf(run, at.phase ?? defaultPhase(run)).map(t => taskKey(run.runId, t.label))
  }
  return []
}

const windowStart = (start: number, length: number, size: number, index = -1) => {
  let value = Math.max(0, Math.min(start, Math.max(0, length - size)))
  if (index >= 0 && index < value) value = index
  if (index >= value + size) value = index - size + 1
  return value
}

// 渲染必须纯读；刷新/导航事件持久化只读列起点，尺寸变化在下一事件校正。
async function syncWindows($: Engine) {
  const list = await read($, runs)
  const at = await read($, nav)
  const run = list.find(r => r.runId === at.runId)
  const hot = await read($, focused)
  const phase = run ? at.phase ?? defaultPhase(run) : null
  const agents = run ? tasksOf(run, phase) : []
  const phaseIndex = run?.phases.findIndex(p => p.title === phase) ?? -1
  const runningIndex = agents.findIndex(t => t.status === 'running')
  const hotIndex = run ? agents.findIndex(t => taskKey(run.runId, t.label) === hot) : -1
  await update($, windows, old => ({
    runs: windowStart(old.runs, currentRuns(list).length, windowSize),
    phases: windowStart(old.phases, run?.phases.length ?? 0, windowSize, phaseIndex),
    agents: windowStart(old.agents, agents.length, windowSize, at.level === 'agents' ? hotIndex : runningIndex),
    detailAgents: windowStart(old.detailAgents, agents.length, windowSize, agents.findIndex(t => t.label === at.label)),
  }))
}

async function revealFocus($: Engine, key: string) {
  const list = await read($, runs)
  const at = await read($, nav)
  for (const column of Object.keys(EMPTY_WINDOWS) as WindowColumn[]) {
    const keys = columnKeys(list, at, column)
    const index = keys.indexOf(key)
    if (index < 0) continue
    await update($, windows, old => ({ ...old, [column]: windowStart(old[column], keys.length, windowSize, index) }))
  }
}

async function trackFocus($: Engine, key: string) {
  const at = await read($, nav)
  if (key.startsWith('p:') && at.level === 'phases') await moveTo($, { ...at, phase: key.slice(2) })
  await update($, focused, () => key)
  await revealFocus($, key)
  if (key.startsWith('t:') && at.level === 'agent') {
    const run = (await read($, runs)).find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => taskKey(run.runId, t.label) === key)
    if (run && task && task.label !== at.label) await showAgent($, run, task)
  }
}

async function shiftWindow($: Engine, column: WindowColumn, direction: 'up' | 'down') {
  const at = await read($, nav)
  const keys = columnKeys(await read($, runs), at, column)
  if (!keys.length) return
  const hot = await read($, focused)
  const preferred = keys.includes(hot ?? '') ? hot : column === 'phases' && at.phase ? phaseKey(at.phase) : column === 'detailAgents' && at.label ? taskKey(at.runId ?? '', at.label) : null
  // resize 后 state 可能还是上次尺寸的起点，先按当前绘制窗口校正再移动一格。
  const old = windowStart((await read($, windows))[column], keys.length, windowSize, keys.indexOf(preferred ?? ''))
  const start = windowStart(old + (direction === 'up' ? -1 : 1), keys.length, windowSize)
  if (start === old) return
  const key = keys[direction === 'up' ? start : Math.min(keys.length - 1, start + windowSize - 1)]!
  // 引擎不会重入当前 ui.focus 钩子，翻页自己同步阶段/详情，再请求实际移动光标。
  await trackFocus($, key)
  await update($, windows, w => ({ ...w, [column]: start }))
  await focusOn($, key)
}

async function goBack($: Engine) {
  const back = up(await read($, runs), await read($, nav))
  if (!back) return
  await moveTo($, back.to)
  await focusOn($, back.key)
}

// 打开某个 agent 的详情，结果文本读出来放进 nav
async function showAgent($: Engine, run: FlowRun, task: FlowTask) {
  await update($, focused, () => taskKey(run.runId, task.label))
  await update($, nav, n => ({ ...n, level: 'agent' as const, label: task.label, text: null }))
  const text = await loadResult($, run, task)
  await update($, nav, n => (n.runId === run.runId && n.label === task.label ? { ...n, text } : n))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: '打开 Codex 任务面板' })
    // 重载后让状态行和面板一致
    await changePanel($, async () => applyShown($, await read($, shown), 'reload', await read($, auto)))
    const tick = () => void refresh($).catch(() => undefined).then(() => syncSpinner($))
    $.clock.every(REFRESH_MS, tick)
    tick()

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await update($, working, () => false)

    return next(e)
  })

  // /flow 只打开；引擎自己的折叠状态插件无法读取或修改。
  on('command.run', { command: 'flow' }, async $ => {
    if (await read($, shown)) {
      await setShown($, true, 'command')
      return { text: 'Codex 任务面板已经在输入框上方。如果那里只剩一行「▸ plugin panel hidden」，那是 Claude Code 自带的折叠：点一下那一行，或按 ctrl+x ctrl+a，就能展开。' }
    }
    await refresh($, true)
    const start = entry(await read($, runs))
    await moveTo($, start.to)
    await setShown($, true, 'command')

    return { text: '已在输入框上方打开 Codex 任务面板。如果只看到一行「▸ plugin panel hidden」，点一下它或按 ctrl+x ctrl+a 展开。' }
  })

  // 光标移动时：阶段栏里右栏跟着换阶段，详情页里右栏跟着换 agent；记下位置，x 停的就是它
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const moved = await next(e)
    const key = e.element
    if (moved.deny || !key) return moved
    const more = /^more:(runs|phases|agents|detailAgents):(up|down)$/.exec(key)
    if (more) {
      await shiftWindow($, more[1] as WindowColumn, more[2] as 'up' | 'down')
      return moved
    }
    await trackFocus($, key)

    return moved
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 没打开、有问卷要用这块区域，或者用户正在看某个子代理的对话时让出来（回到主对话再画）
    if (!(await read($, shown)) || e.props.hasSurvey || e.props.view?.agentId) return next(e)
    bandId = e.requestId
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const at = await read($, nav)
    const hot = await read($, focused)
    const tick = await read($, frame)
    const spinner = SPIN[tick % SPIN.length]
    const agentSpinner = AGENT_SPIN[tick % AGENT_SPIN.length]
    const canHide = !list.some(r => r.status === 'running')
    // 整块最宽 100 列，右边留 4 列给引擎的折叠按钮 [-]；高度够时外面加一圈彩色框，和上面的对话分开
    const bandColumns = Math.min(100, Math.max(40, (e.props.bodyColumns || 104) - 4))
    const bandRows = Math.max(0, Math.floor(e.props.maxRows ?? 20))
    if (!bandRows) return <Box flexDirection="column" />
    // 外框占两行；加框后 flow 每栏分窗口时仍要能看到三项（需 11 行），不够就省掉外框
    const shelled = bandRows >= 11
    const columns = bandColumns - (shelled ? 4 : 0)
    const rows = bandRows - (shelled ? 2 : 0)
    // 外框颜色跟类型走：flow 紫色，单个 agent 蓝色，两种都有时青色
    const shell = (color: string, width: number, node: RenderElement) => shelled
      ? <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} alignSelf="flex-start" width={width + 4}>{node}</Box>
      : node
    const buttonCells = (label: string) => 3 + cells(label)
    const footerCells = (hints: string[], stop: string | null, canBack: boolean) => {
      const parts = [stop && buttonCells(stop), canBack && buttonCells('返回'), canHide && buttonCells('关闭')].filter(Boolean) as number[]
      const text = hints.length ? cells(hints.join(' · ')) + (parts.length ? 3 : 0) : 0
      return text + parts.reduce((sum, n) => sum + n, 0) + Math.max(0, parts.length - 1) * 3
    }
    const run = list.find(r => r.runId === at.runId)
    // 至少留一行内容；高度不足时依次省去方框、页脚、标题。页脚有返回、停止按钮，优先于方框保留。
    // flow 两栏视图只在内容（最多三行）放得下时画方框；不画方框时左右竖线一起省，不留只剩竖线的残框。
    const needRows = run && at.level ? (at.level === 'agent' ? 12 : Math.min(12, Math.max(run.phases.length, tasksOf(run, at.phase ?? defaultPhase(run)).length))) : 0
    const showTitle = rows >= 2
    const showFooter = rows >= 3
    const framed = !!(run && at.level) && rows >= 2 + Number(showTitle) + Number(showFooter) + Math.min(needRows, 3)
    const fixedRows = Number(showTitle) + Number(showFooter) + (framed ? 2 : 0)
    const bodyRows = rows - fixedRows
    windowSize = Math.min(12, Math.max(1, bodyRows - 2))
    const size = windowSize
    const starts = await read($, windows)
    const windowed = <T,>(items: T[], column: WindowColumn, keyOf: (item: T) => string, preferred: string | null) => {
      // 放得下（且不超过 12 项）就全部显示；否则分窗口，留两行给「还有 N 个」
      const fit = items.length <= Math.min(bodyRows, 12) ? items.length : size
      const start = windowStart(starts[column], items.length, fit, preferred ? items.findIndex(item => keyOf(item) === preferred) : -1)
      return { items: items.slice(start, start + fit), start, before: start, after: Math.max(0, items.length - start - fit) }
    }
    const moreRow = (column: WindowColumn, direction: 'up' | 'down', count: number, interactive: boolean, compact = false) => {
      const arrow = direction === 'up' ? '↑' : '↓'
      const label = compact ? `${arrow} ${count}` : `${arrow} 还有 ${count} 个`
      return interactive ? <Button plain dimColor key={`more:${column}:${direction}`} label={label} onPress={() => shiftWindow($, column, direction)} /> : <Text dimColor wrap="truncate-end">{label}</Text>
    }
    const withMore = (items: RenderElement[], column: WindowColumn, win: { before: number; after: number }, interactive: boolean) => {
      const above = win.before ? moreRow(column, 'up', win.before, interactive) : null
      const below = win.after ? moreRow(column, 'down', win.after, interactive) : null
      const room = bodyRows - items.length
      if (room <= 0) return items
      // 只剩一行提示空间时，上下按钮放在同一行，仍可往两个方向翻页。
      if (room === 1 && above && below) return [...items, <Box>
        {moreRow(column, 'up', win.before, interactive, true)}<Text dimColor> · </Text>{moreRow(column, 'down', win.after, interactive, true)}
      </Box>]
      return [...(above ? [above] : []), ...items, ...(below ? [below] : [])]
    }

    // spin：运行中用的标记，默认是 agent 的细点阵
    const mark = (status: string, spin = agentSpinner) => {
      if (status === 'running') return <Text color={BLUE}>{spin}</Text>
      const [g, color] = glyph(status)
      return (
        <Text color={color} dimColor={!color}>
          {g}
        </Text>
      )
    }
    const footer = (hints: string[], stop: string | null, canBack: boolean) => showFooter ? (
      <Box>
        {hints.length > 0 && <Box flexShrink={1}><Text dimColor wrap="truncate-end">{hints.join(' · ')}{stop || canBack || canHide ? ' · ' : ''}</Text></Box>}
        {stop && (
            <Button
              plain
              hotkey="x"
              key="stop"
              label={stop}
              onPress={async () => {
                const all = await read($, runs)
                const now = await read($, nav)
                const target = all.find(r => r.runId === now.runId)
                if (now.level === 'phases' && target) return stopRun($, target)
                const key = now.level === 'agent' && now.label ? taskKey(now.runId ?? '', now.label) : await read($, focused)
                const hitRun = all.find(r => key === runKey(r.runId))
                if (hitRun) return stopRun($, hitRun)
                for (const r of all) for (const t of r.tasks) if (taskKey(r.runId, t.label) === key) return stopTask($, r, t)
                $.ui.toast('先选中一项再按 x')
              }}
            />
        )}
        {stop && (canBack || canHide) && <Text dimColor> · </Text>}
        {canBack && <Button plain hotkey="b" key="back" label="返回" onPress={() => goBack($)} />}
        {canBack && canHide && <Text dimColor> · </Text>}
        {canHide && (
          <Button plain hotkey="q" key="hide" label="关闭" onPress={async () => {
            // 渲染后可能刚开始新任务，旧按钮也不能关闭运行中的面板。
            if ((await read($, runs)).some(r => r.status === 'running')) return
            await setShown($, false, 'user-hide')
          }} />
        )}
      </Box>
    ) : <Box />

    // 最外层：单个 agent、多个任务时一行一个，类型标在名称前（flow 紫色、agent 蓝色）
    if (!run || !at.level) {
      const cur = currentRuns(list)
      if (!cur.length) return shell(CYAN, Math.min(columns, Math.max(cells('本会话还没有派出 Codex 任务。'), footerCells([], null, false))), (
        <Box flexDirection="column">
          <Text dimColor>本会话还没有派出 Codex 任务。</Text>
          {footer([], null, false)}
        </Box>
      ))
      const win = windowed(cur, 'runs', r => runKey(r.runId), hot)
      const nameWidth = Math.min(24, Math.max(8, ...cur.map(r => cells(r.name) + 2)))
      const flows = cur.filter(r => r.kind === 'flow').length
      const singles = cur.length - flows
      const active = cur.filter(r => r.status === 'running').length
      const summary = [flows && `${flows} 个 flow`, singles && `${singles} 个 agent`, active ? `${active} 个运行中` : '全部结束'].filter(Boolean).join(' · ')
      const statsOfRun = (r: FlowRun) => {
        const task = r.tasks[0]
        if (r.kind === 'single' && task) return agentStats(task)
        const tokens = tokensOf(r.tasks)
        const live = r.status === 'running' ? livePhases(r) : null
        const parts = live ? [live] : [WORD[r.status] ?? r.status, `${r.tasks.length} 个 agent`]
        if (tokens) parts.push(`${formatTokens(tokens)} tok`)
        return parts.join(' · ')
      }
      const listHints = ['ctrl+x tab 操作', '↑/↓ 选择', 'Enter 查看']
      // token 会增长：已有 token 的按 999.9k 预留，运行中还没有 token 的预留「 · 999.9k tok」
      const grow = (r: FlowRun) => { const n = tokensOf(r.tasks); return n ? 6 - formatTokens(n).length : r.status === 'running' ? cells(' · 999.9k tok') : 0 }
      const statsWidth = Math.max(4, Math.min(columns - 17 - nameWidth, Math.max(...cur.map(r => cells(statsOfRun(r)) + grow(r))) + 1))
      const listWidth = Math.min(columns, Math.max(17 + nameWidth + statsWidth, cells(`Codex  ${summary}`), footerCells(listHints, null, false)))
      const listColor = flows && singles ? CYAN : flows ? PURPLE : BLUE
      return shell(listColor, listWidth, (
        <Box flexDirection="column" width={listWidth}>
          {showTitle && <Box>
            <Text bold color={CYAN}>
              Codex
            </Text>
            <Text dimColor wrap="truncate-end">  {summary}</Text>
          </Box>}
          <Box flexDirection="column">
            {withMore(win.items.map(r => {
              const key = runKey(r.runId)
              const [kind, color] = KIND[r.kind]
              return (
                <Box>
                  <Text color={BLUE}>{hot === key ? '❯ ' : '  '}</Text>
                  {mark(r.status, r.kind === 'flow' ? spinner : agentSpinner)}
                  <Text> </Text>
                  <Box width={6}>
                    <Text color={color}>{kind}</Text>
                  </Box>
                  <Box width={nameWidth}>
                    <Button
                      plain
                      key={key}
                      label={fit(r.name, nameWidth - 1)}
                      onPress={async () => {
                        const phase = defaultPhase(r)
                        const first = tasksOf(r, phase)[0]
                        // 单个 agent 直接看详情
                        if (r.kind === 'single' && first) {
                          await moveTo($, { runId: r.runId, level: 'agent' as const, phase, label: first.label, text: null })
                          return showAgent($, r, first)
                        }
                        await moveTo($, { runId: r.runId, level: 'phases' as const, phase, label: null, text: null })
                        await focusOn($, phase ? phaseKey(phase) : null)
                      }}
                    />
                  </Box>
                  <Box width={statsWidth}>
                    <Text dimColor wrap="truncate-end">
                      {fit(statsOfRun(r), statsWidth - 1)}
                    </Text>
                  </Box>
                  <Box width={7} justifyContent="flex-end">
                    <Text dimColor>{formatDuration(r.seconds)}</Text>
                  </Box>
                </Box>
              )
            }), 'runs', win, true)}
          </Box>
          {footer(listHints, null, false)}
        </Box>
      ))
    }

    type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }
    // agent 详情：任务说明，然后是结果或错误，按宽度折行
    const card = (t: FlowTask, width: number) => {
      const lines: Line[] = []
      if (t.brief) for (const l of wrap(t.brief, width)) lines.push({ text: l })
      lines.push({ text: '' })
      if (at.text) {
        lines.push({ text: '结果', bold: true, dim: true })
        for (const l of wrap(at.text.trim(), width)) lines.push({ text: l })
      } else if (t.error) {
        lines.push({ text: '错误', bold: true, dim: true })
        for (const l of wrap(t.error, width)) lines.push({ text: l, color: RED })
      } else {
        lines.push({ text: t.status === 'running' ? '运行中，结果出来后显示在这里。' : '没有结果。', dim: true })
      }
      return lines
    }
    // 超出高度的截掉，末行写还剩多少
    const clip = (lines: Line[]) => {
      const room = bodyRows
      return lines.length > room ? [...lines.slice(0, room - 1), { text: `… 还有 ${lines.length - room + 1} 行`, dim: true }] : lines
    }
    const draw = (l: Line) => (
      <Text color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
        {l.text}
      </Text>
    )

    // 单个 agent 的详情：一栏卡片；名称蓝色，标题行写模型、effort、token、状态、耗时
    if (run.kind === 'single') {
      const single = run.tasks[0]
      const width = columns - 4
      const lines = clip(single ? card(single, width) : [{ text: '没有记录。', dim: true }])
      const title = ' 详情 '
      const inner = Math.min(width, Math.max(24, cells(title) + 2, ...lines.map(l => cells(l.text))))
      const singleStop = run.status === 'running' ? '停止' : null
      const singleWidth = Math.min(columns, Math.max(inner + 4, cells(`${run.name}  ${runSubtext(run)}`), footerCells(['ctrl+x tab 操作'], singleStop, true)))
      return shell(BLUE, singleWidth, (
        <Box flexDirection="column" width={singleWidth}>
          {showTitle && <Box>
            <Text bold color={BLUE}>
              {run.name}
            </Text>
            <Text dimColor wrap="truncate-end">  {runSubtext(run)}</Text>
          </Box>}
          <Box flexDirection="column">
            {framed && <Box>
              <Text dimColor>╭─</Text>
              <Text>{title}</Text>
              <Text dimColor>{'─'.repeat(Math.max(0, inner + 1 - cells(title)))}╮</Text>
            </Box>}
            {lines.map(l => (
              <Box>
                <Text dimColor>│ </Text>
                <Box width={inner}>{draw(l)}</Box>
                <Text dimColor> │</Text>
              </Box>
            ))}
            {framed && <Text dimColor>╰{'─'.repeat(inner + 2)}╯</Text>}
          </Box>
          {footer(['ctrl+x tab 操作'], singleStop, true)}
        </Box>
      ))
    }

    // 一个 flow：带边框的两栏，左栏阶段，右栏 agent 或 agent 详情，照 Workflow 详情面板的样子；名称紫色
    const phase = at.phase ?? defaultPhase(run)
    const agents = tasksOf(run, phase)
    const level = at.level
    const task = level === 'agent' ? agents.find(t => t.label === at.label) : undefined
    // 宽度按整个 flow 的内容算（换阶段时方框不跳），只占需要的宽度
    // 进度按「总数/总数」预留，完成数进位时不跳
    const countWidth = Math.max(3, ...run.phases.map(p => `${tasksOf(run, p.title).length}/${tasksOf(run, p.title).length}`.length))
    // 阶段一行：选中标记 2 + 序号 + 空格 + 图标 + 空格 + 名称 + 进度 + 耗时（固定预留）
    const numWidth = String(run.phases.length).length
    const timeCell = TIME_SLOT
    const leftWidth =
      level === 'agent'
        ? Math.min(20, Math.max(16, ...agents.map(t => cells(t.label) + 4)))
        : Math.min(32, Math.max(16, Math.max(4, ...run.phases.map(p => cells(p.title))) + 6 + numWidth + countWidth + timeCell))
    const available = columns - leftWidth - 7
    const labelWidth = Math.min(16, Math.max(4, ...run.tasks.map(t => cells(t.label))))
    // agent 一行：选中标记 2 + 图标 1 + 空格 1 + 名称 labelWidth+1 + 模型 effort + token（固定预留）+ 耗时（固定预留）
    const modelWidth = Math.max(4, ...run.tasks.map(t => cells(`${shortModel(t.model)} ${t.effort}`)))
    const titleWidth = Math.max(...run.phases.map(p => cells(`${p.title} · ${tasksOf(run, p.title).length} 个 agent`) + 3))
    const listWidth = Math.max(titleWidth, 4 + labelWidth + 1 + modelWidth + TOKEN_SLOT + TIME_SLOT)
    let rightWidth = Math.min(available, listWidth)
    // 模型栏吃掉多余宽度，token 和时长栏始终贴右，和标题行的总数对齐
    const modelCell = Math.max(1, rightWidth - 5 - labelWidth - TOKEN_SLOT - TIME_SLOT)

    const border = (left: string, right: string, top: boolean) => {
      const seg = (w: number, title: string) => {
        if (!top) return { title: '', dash: '─'.repeat(w) }
        const t = ` ${fit(title, w - 3)} `
        return { title: t, dash: '─'.repeat(Math.max(0, w - 1 - cells(t))) }
      }
      const l = seg(leftWidth + 2, left)
      const r = seg(rightWidth + 2, right)
      return (
        <Box>
          <Text dimColor>{top ? '╭─' : '╰'}</Text>
          {top && <Text>{l.title}</Text>}
          <Text dimColor>
            {l.dash}
            {top ? '┬─' : '┴'}
          </Text>
          {top && <Text>{r.title}</Text>}
          <Text dimColor>
            {r.dash}
            {top ? '╮' : '╯'}
          </Text>
        </Box>
      )
    }

    // 左栏：阶段栏时是阶段（可选），agent 详情时是这个阶段的 agent（可选），agent 栏时阶段只作标示
    const leftColumn = level === 'agent' ? 'detailAgents' : 'phases'
    const leftWin = level === 'agent'
      ? windowed(agents, 'detailAgents', t => taskKey(run.runId, t.label), hot && agents.some(t => taskKey(run.runId, t.label) === hot) ? hot : at.label ? taskKey(run.runId, at.label) : null)
      : windowed(run.phases, 'phases', p => phaseKey(p.title), level === 'phases' && hot && run.phases.some(p => phaseKey(p.title) === hot) ? hot : phase ? phaseKey(phase) : null)
    const leftCells = withMore(
      level === 'agent'
        ? (leftWin.items as FlowTask[]).map(t => {
            const key = taskKey(run.runId, t.label)
            const me = t.label === at.label
            return (
              <Box>
                <Text color={BLUE}>{me ? '❯ ' : '  '}</Text>
                {mark(t.status)}
                <Text> </Text>
                <Button plain key={key} label={fit(t.label, leftWidth - 4)} dimColor={me ? undefined : true} onPress={() => showAgent($, run, t)} />
              </Box>
            )
          })
        : (leftWin.items as FlowRun['phases']).map((p, i) => {
            const ts = tasksOf(run, p.title)
            const me = p.title === phase
            const live = p.status === 'running'
            const [g, color] = glyph(p.status)
            const sign = live ? spinner : g
            const count = `${doneOf(ts)}/${ts.length}`
            const time = phaseTime(run, p.title)
            const titleWidth = Math.max(1, leftWidth - 5 - numWidth - countWidth - timeCell)
            // 蓝色只表示运行中；选中的阶段不变暗，其余阶段暗色
            const tone = live ? BLUE : undefined
            const dim = !live && !me
            return (
              <Box>
                <Text color={BLUE}>{level === 'phases' && hot === phaseKey(p.title) ? '❯ ' : '  '}</Text>
                <Text color={tone} dimColor={dim}>
                  {String(leftWin.start + i + 1).padStart(numWidth)}
                </Text>
                <Text> </Text>
                <Text color={live ? BLUE : color} dimColor={!live && !color}>
                  {sign}
                </Text>
                <Text> </Text>
                <Box width={titleWidth}>
                  {level === 'phases' ? (
                    <Button
                      plain
                      key={phaseKey(p.title)}
                      label={fit(p.title, titleWidth - 1)}
                      dimColor={dim ? true : undefined}
                      onPress={async () => {
                        const first = ts[0]
                        await moveTo($, { ...await read($, nav), level: 'agents' as const, phase: p.title })
                        if (first) await focusOn($, taskKey(run.runId, first.label))
                      }}
                    />
                  ) : (
                    <Text color={tone} dimColor={dim}>
                      {fit(p.title, titleWidth - 1)}
                    </Text>
                  )}
                </Box>
                <Box width={countWidth} justifyContent="flex-end">
                  <Text color={tone} dimColor={dim}>
                    {count}
                  </Text>
                </Box>
                {timeCell > 0 && (
                  <Box width={timeCell} justifyContent="flex-end">
                    <Text color={tone} dimColor={dim}>
                      {time}
                    </Text>
                  </Box>
                )}
              </Box>
            )
          }), leftColumn, leftWin, level !== 'agents')

    // 右栏：agent 栏和阶段栏时列出这个阶段的 agent（只有 agent 栏可选），详情时是这个 agent 的卡片
    let rightCells: RenderElement[]
    let rightTitle: string
    if (task) {
      rightTitle = `${task.label} · ${agents.indexOf(task) + 1}/${agents.length}`
      const stats = [agentStats(task), task.reused ? '复用上次结果' : agentTime(task), !task.reused && (task.status === 'running' || task.status === 'completed') ? WORD[task.status] : ''].filter(Boolean).join(' · ')
      const lines: Line[] = [{ text: stats, dim: true }, ...card(task, available)]
      // 详情按可用宽度折行，再收到最长一行的宽度
      rightWidth = Math.min(available, Math.max(listWidth, cells(rightTitle) + 3, ...lines.map(l => cells(l.text))))
      rightCells = clip(lines).map(draw)
    } else {
      rightTitle = `${phase ?? ''} · ${agents.length} 个 agent`
      const runningAgent = agents.find(t => t.status === 'running')
      const preferred = level === 'agents' ? hot : runningAgent ? taskKey(run.runId, runningAgent.label) : null
      const rightWin = windowed(agents, 'agents', t => taskKey(run.runId, t.label), preferred)
      rightCells = withMore(rightWin.items.map(t => {
        const key = taskKey(run.runId, t.label)
        const tokens = t.tokens ? `${formatTokens(t.tokens)} tok` : ''
        // 耗时栏：运行中和完成写时长，复用写「复用」，其余写状态（等待、失败等）
        const time = agentTime(t) || (WORD[t.status] ?? t.status)
        return (
          <Box>
            <Text color={BLUE}>{level === 'agents' && hot === key ? '❯ ' : '  '}</Text>
            {mark(t.status)}
            <Text> </Text>
            <Box width={labelWidth + 1}>
              {level === 'agents' ? (
                <Button plain key={key} label={fit(t.label, labelWidth)} dimColor={t.status === 'running' ? undefined : true} onPress={() => showAgent($, run, t)} />
              ) : (
                <Text dimColor={t.status !== 'running'}>{fit(t.label, labelWidth)}</Text>
              )}
            </Box>
            <Box width={modelCell}>
              <Text dimColor>{fit(`${shortModel(t.model)} ${t.effort}`, modelCell)}</Text>
            </Box>
            <Box width={TOKEN_SLOT} justifyContent="flex-end">
              <Text dimColor>{tokens}</Text>
            </Box>
            <Box width={TIME_SLOT} justifyContent="flex-end">
              <Text dimColor>{time}</Text>
            </Box>
          </Box>
        )
      }), 'agents', rightWin, level === 'agents')
      if (!agents.length) rightCells = [<Text dimColor>这个阶段没有 agent</Text>]
    }

    const height = Math.max(leftCells.length, rightCells.length)
    const body = Array.from({ length: height }, (_, i) => (
      <Box>
        {framed && <Text dimColor>│ </Text>}
        <Box width={leftWidth}>{leftCells[i] ?? <Text> </Text>}</Box>
        <Text dimColor> │ </Text>
        <Box width={rightWidth}>{rightCells[i] ?? <Text> </Text>}</Box>
        {framed && <Text dimColor> │</Text>}
      </Box>
    ))
    const running = run.status === 'running'
    const outer = !up(list, at)
    const hints =
      level === 'phases' ? ['↑/↓ 选择阶段', 'Enter 进入'] : level === 'agents' ? ['↑/↓ 选择', 'Enter 详情'] : ['↑/↓ 切换 agent']
    // 停止键只给在跑的目标：阶段栏停整个 flow，agent 栏和详情停选中的 agent
    const target = level === 'agent' ? task : agents.find(t => taskKey(run.runId, t.label) === hot)
    const stop = !running ? null : level === 'phases' ? (run.kind === 'flow' ? '停止整个 flow' : '停止') : target?.status === 'running' ? '停止' : null
    const flowHints = ['ctrl+x tab 操作', ...hints]
    // 标题行：名称和状态靠左，总 token 和总时长靠右，分别对齐下方 agent 的 token 栏和时长栏
    const boxWidth = leftWidth + rightWidth + (framed ? 7 : 3)
    const totalTokens = tokensOf(run.tasks)
    const parallel = run.status === 'running' ? run.phases.filter(p => p.status === 'running').length : 0
    const flowWidth = Math.min(columns, Math.max(leftWidth + rightWidth + 7, cells(`${run.name}  ${WORD.running} · 9 个阶段并行 · 999.9k tok · 99h59m`), footerCells(flowHints, stop, !outer)))
    return shell(PURPLE, flowWidth, (
      <Box flexDirection="column" width={flowWidth}>
        {showTitle && <Box>
          <Box width={Math.max(1, boxWidth - TOKEN_SLOT - TIME_SLOT - (framed ? 2 : 0))}>
            <Text bold color={PURPLE} wrap="truncate-end">
              {run.name}
            </Text>
            <Text dimColor wrap="truncate-end">  {WORD[run.status] ?? run.status}{parallel > 1 ? ` · ${parallel} 个阶段并行` : ''}</Text>
          </Box>
          <Box width={TOKEN_SLOT} justifyContent="flex-end">
            <Text dimColor>{totalTokens ? `${formatTokens(totalTokens)} tok` : ''}</Text>
          </Box>
          <Box width={TIME_SLOT} justifyContent="flex-end">
            <Text dimColor>{formatDuration(run.seconds)}</Text>
          </Box>
        </Box>}
        <Box flexDirection="column">
          {framed && border(level === 'agent' ? `${phase ?? ''}` : '阶段', rightTitle, true)}
          {body}
          {framed && border('', '', false)}
        </Box>
        {footer(flowHints, stop, !outer)}
      </Box>
    ))
  })
}
