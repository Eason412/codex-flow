// codex-flow：输入框上方的面板看本会话派出的 Codex 任务、停任务；任务跑满阈值（默认 15 分钟）时在对话里提醒主 Agent 排查。
// 只读执行器写的 state.json，不负责跑任务：mod 重载或没加载时，任务照常跑完。
// 有新任务开始时面板自动出现，全部结束 30 秒后自动收起；全部结束后可用 q 关闭，同一批任务不再弹出。/flow 只打开。面板显示时状态行让出 codex 那一行。
// 外框的上边写标题、下边放页脚，三行起就画，输入框草稿变长时也不丢。
// 只有一个 flow 时照 Workflow 详情面板画两栏（左栏阶段，右栏 agent：模型、effort、token、耗时），两栏随时都能选；
// agent 详情显示任务说明、最近几步过程和结果，运行中的 flow 任务下面有插话框，Enter 发给这个 Codex。
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
// 面板固定占的行数（含外框）：列表、flow 两栏和 agent 详情都画成同样大小，进出时只换布局、不跳，和 Claude Code 的 Workflow 面板一样。
// 输入框上方放不下这么多行时按实际可用的行数画
const PANEL_ROWS = 16
const TOP: Nav = { runId: null, level: null, phase: null, label: null, text: null }

// 配色取自用户 ccstatusline 的设置（Tokyo Night），和状态行那一行一致
const CYAN = '#7DCFFF'
const GREEN = '#9ECE6A'
const RED = '#F7768E'
const YELLOW = '#E0AF68'
const BLUE = '#7AA2F7'
const PURPLE = '#BB9AF7'
// 用 Fast 的模型名前面标一个黄色闪电
const FAST = '⚡'
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
const steerRound = atom({ plugin: 'codex-flow', key: 'steerRound' } as const, 0)
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
// 光标实际所在的元素（含按钮和插话框）；focused 只记阶段、agent、运行这几种条目
let ringAt: string | null = null
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
// 模型和 effort 一起写；用 Fast 时前面加闪电，画的时候用 dimFast 把闪电标黄
const modelText = (t: FlowTask) => `${t.fast ? FAST : ''}${shortModel(t.model)} ${t.effort}`
const runKey = (runId: string) => `r:${runId}`
const phaseKey = (title: string) => `p:${title}`
const taskKey = (runId: string, label: string) => `t:${runId}:${label}`
// 详情左栏的 agent 另用一套键：和 agent 栏同键时，切换层级后光标可能停在旧树的位置上
const detailKey = (runId: string, label: string) => `a:${runId}:${label}`

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

// 终端里中文和闪电（表情字符）占两格
function cells(text: string) {
  let n = 0
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) >= 0x2e80 || ch === FAST ? 2 : 1
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
  if (!value) ringAt = null
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
  const parts = [modelText(t)]
  if (t.tokens) parts.push(`${formatTokens(t.tokens)} tok`)
  if (t.status !== 'running' && t.status !== 'completed') parts.push(WORD[t.status] ?? t.status)
  return parts.join(' · ')
}

// 续跑时复用的 agent 耗时栏写“复用”，时长是上次的，不算这次
const agentTime = (t: FlowTask) => (t.reused ? '复用' : t.status === 'running' || t.status === 'completed' ? formatDuration(t.seconds) : '')

function runSubtext(run: FlowRun) {
  const task = run.tasks[0]
  if (run.kind === 'single' && task) {
    const parts = [modelText(task)]
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

const isItem = (key: string) => /^[rpta]:/.test(key)

async function focusOn($: Engine, key: string | null) {
  if (!key) return
  if (isItem(key)) {
    await update($, focused, () => key)
    await revealFocus($, key)
  }
  try {
    if (bandId) {
      const result = await $.ui.focus({ requestId: bandId, key })
      if (result.deny) $.ui.log(JSON.stringify({ event: 'focus-denied', key, reason: result.deny }), { to: 'debug' })
      // 插件自己移的光标不一定再经过本插件的 ui.focus 钩子，这里补记实际位置，改道判断要用
      else ringAt = key
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
  // 阶段栏和 agent 栏两栏随时可选；详情时左栏换成这个阶段的 agent
  const columnsShown = at.level === 'phases' || at.level === 'agents'
  if (column === 'phases') return columnsShown ? run.phases.map(p => phaseKey(p.title)) : []
  const shownAgents = tasksOf(run, at.phase ?? defaultPhase(run))
  if (column === 'agents' && columnsShown) return shownAgents.map(t => taskKey(run.runId, t.label))
  if (column === 'detailAgents' && at.level === 'agent') return shownAgents.map(t => detailKey(run.runId, t.label))
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

// 光标落到阶段就切到阶段栏并换右栏，落到 agent 就是 agent 栏；落到按钮、插话框时不动，x 停的仍是上一个条目
async function trackFocus($: Engine, key: string) {
  if (!isItem(key)) return
  const at = await read($, nav)
  if (key.startsWith('p:') && (at.level === 'phases' || at.level === 'agents')) await moveTo($, { ...at, level: 'phases' as const, phase: key.slice(2) })
  else if (key.startsWith('t:') && at.level === 'phases') await update($, nav, n => ({ ...n, level: 'agents' as const }))
  await update($, focused, () => key)
  await revealFocus($, key)
  if (key.startsWith('a:') && at.level === 'agent') {
    const run = (await read($, runs)).find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => detailKey(run.runId, t.label) === key)
    if (run && task && task.label !== at.label) await showAgent($, run, task)
  }
}

async function shiftWindow($: Engine, column: WindowColumn, direction: 'up' | 'down') {
  const at = await read($, nav)
  const keys = columnKeys(await read($, runs), at, column)
  if (!keys.length) return
  const hot = await read($, focused)
  const preferred = keys.includes(hot ?? '') ? hot : column === 'phases' && at.phase ? phaseKey(at.phase) : column === 'detailAgents' && at.label ? detailKey(at.runId ?? '', at.label) : null
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

// 一行摘要里各层画得一样，返回直接回任务列表，光标停在刚才看的那个任务上
async function goList($: Engine) {
  const runId = (await read($, nav)).runId
  await moveTo($, TOP)
  await focusOn($, runId ? runKey(runId) : null)
}

// 打开某个 agent 的详情，结果文本读出来放进 nav
async function showAgent($: Engine, run: FlowRun, task: FlowTask) {
  await update($, focused, () => detailKey(run.runId, task.label))
  await update($, nav, n => ({ ...n, level: 'agent' as const, label: task.label, text: null }))
  const text = await loadResult($, run, task)
  await update($, nav, n => (n.runId === run.runId && n.label === task.label ? { ...n, text } : n))
}

// x：阶段栏停整个 flow，agent 栏和详情停选中的 agent，列表里停选中的运行
async function pressStop($: Engine) {
  const all = await read($, runs)
  const now = await read($, nav)
  const target = all.find(r => r.runId === now.runId)
  if (now.level === 'phases' && target) return stopRun($, target)
  const key = now.level === 'agent' && now.label ? taskKey(now.runId ?? '', now.label) : await read($, focused)
  const hitRun = all.find(r => key === runKey(r.runId))
  if (hitRun) return stopRun($, hitRun)
  for (const r of all) for (const t of r.tasks) if (taskKey(r.runId, t.label) === key) return stopTask($, r, t)
  $.ui.toast('先选中一项再按 x')
}

async function pressHide($: Engine) {
  // 渲染后可能刚开始新任务，旧按钮也不能关闭运行中的面板。
  if ((await read($, runs)).some(r => r.status === 'running')) return
  await setShown($, false, 'user-hide')
}

// 插话只给运行中、不在验收的 flow 任务：单个 agent 由 run.sh 跑，收不到插话；验收时 Codex 已经结束
const canSteer = (run: FlowRun, task: FlowTask | undefined) => run.kind === 'flow' && task?.status === 'running' && !task.checking && !task.turnEnded
const steerKey = (runId: string, label: string, round: number) => `steer:${runId}:${label}:${round}`

// 写进控制目录，执行器每秒取走、用 turn/steer 发给这个 Codex；送达或被拒都会出现在详情的「过程」里
async function sendSteer($: Engine, runId: string, label: string, value: string) {
  const text = value.trim()
  if (!text) return
  const run = (await read($, runs)).find(r => r.runId === runId)
  const task = run?.tasks.find(t => t.label === label)
  if (!run || !task || !canSteer(run, task)) {
    $.ui.toast(`「${label}」已不在运行，插话没有发出`)
    return
  }
  try {
    await $.fs.write(`${run.dir}/control/${fileSafe(label)}.steer.${await $.clock.now()}.txt`, text)
  } catch (error) {
    $.ui.toast(`插话没有写入：${String(error)}`)
    return
  }
  await update($, steerRound, n => n + 1)
  $.ui.toast('已交给执行器，送达后出现在「过程」里')
  await focusOn($, steerKey(runId, label, await read($, steerRound)))
}

// 光标按树序走：从 agent 栏第一项按 ↑ 会落到阶段栏最下面一项，从插话框按 ↑ 会落到左栏最后一个 agent。
// 这两种改落到当前阶段、当前 agent。点击同时触发 onPress，点到的阶段或 agent 仍会照常打开。
async function redirectFocus($: Engine, key: string) {
  const at = await read($, nav)
  const run = (await read($, runs)).find(r => r.runId === at.runId)
  if (!run || !at.phase) return null
  if (at.level === 'agents') {
    const first = tasksOf(run, at.phase)[0]
    const left = key.startsWith('p:') || key.startsWith('more:phases:')
    if (first && ringAt === taskKey(run.runId, first.label) && left && key !== phaseKey(at.phase)) return phaseKey(at.phase)
  }
  if (at.level === 'agent' && at.label && ringAt?.startsWith('steer:')) {
    const mine = detailKey(run.runId, at.label)
    if ((key.startsWith('a:') || key.startsWith('more:detailAgents:')) && key !== mine) return mine
  }
  return null
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
    const redirect = e.element && e.origin.kind === 'person' ? await redirectFocus($, e.element) : null
    const target = redirect ? { ...e, element: redirect } : e
    const moved = await next(target)
    const key = target.element
    if (moved.deny || !key) return moved
    ringAt = key
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
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // 手机端没有输入框，那里不画插话框
    const Input = 'Input' in elements ? elements.Input : null
    const list = await read($, runs)
    const at = await read($, nav)
    const hot = await read($, focused)
    const tick = await read($, frame)
    const round = await read($, steerRound)
    const spinner = SPIN[tick % SPIN.length]
    const agentSpinner = AGENT_SPIN[tick % AGENT_SPIN.length]
    const canHide = !list.some(r => r.status === 'running')
    // 整块最宽 100 列，右边留 4 列给引擎的折叠按钮 [-]
    const bandColumns = Math.min(100, Math.max(40, (e.props.bodyColumns || 104) - 4))
    const bandRows = Math.max(0, Math.floor(e.props.maxRows ?? 20))
    if (!bandRows) return <Box flexDirection="column" />
    // 外框的上边写标题、下边放页脚，不另占行：输入框草稿变长、这块区域变矮时外框仍在。
    // 三行起画外框；只剩两行时一行标题一行内容，一行时只有内容
    const panelRows = Math.min(bandRows, PANEL_ROWS)
    const shelled = panelRows >= 3
    const showTitle = panelRows >= 2
    // 宽度同样固定：各层都占满可用宽度（最宽 100 列）
    const columns = bandColumns - (shelled ? 4 : 0)
    const rows = panelRows - (shelled ? 2 : Number(showTitle))
    const run = list.find(r => r.runId === at.runId)
    // flow 两栏的内框（栏标题和底线）占两行，放得下最多三行内容才画；高度不够时先省内框，外框保留
    const needRows = run?.kind === 'flow' && at.level
      ? (at.level === 'agent' ? 12 : Math.min(12, Math.max(run.phases.length, tasksOf(run, at.phase ?? defaultPhase(run)).length)))
      : 0
    const framed = needRows > 0 && rows >= 2 + Math.min(needRows, 3)
    const bodyRows = Math.max(1, rows - (framed ? 2 : 0))
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

    // 暗色文字里的闪电单独画成黄色
    const dimFast = (text: string) => text.split(FAST).flatMap((part, i) => [
      ...(i ? [<Text color={YELLOW}>{FAST}</Text>] : []),
      ...(part ? [<Text dimColor>{part}</Text>] : []),
    ])
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

    // parts：sub 分段上色（不带颜色的段画成暗色），整段放得下时才用，放不下退回截短的暗色 sub
    type Part = { text: string; color?: string }
    type Head = { name: string; color: string; sub: string; right?: string; parts?: Part[] }
    const drawParts = (parts: Part[]) => parts.map(p => <Text color={p.color} dimColor={!p.color}>{p.text}</Text>)
    // back：返回键的文字，默认「返回」；toList：返回直接回任务列表（一行摘要里用）
    type Foot = { hints: string[]; stop: string | null; canBack: boolean; back?: string; toList?: boolean }
    // 带快捷键的无边框按钮画成「x: 停止」，比文字多三格
    const buttonCells = (label: string) => 3 + cells(label)
    const buttonsOf = (foot: Foot) => [foot.stop, foot.canBack ? foot.back ?? '返回' : null, canHide ? '关闭' : null].filter((b): b is string => !!b)
    const buttonsWidth = (foot: Foot) => {
      const buttons = buttonsOf(foot)
      return buttons.reduce((sum, b) => sum + buttonCells(b), 0) + Math.max(0, buttons.length - 1) * 3
    }
    const footerCells = (foot: Foot) => {
      const buttons = buttonsOf(foot)
      return (foot.hints.length ? cells(foot.hints.join(' · ')) + (buttons.length ? 3 : 0) : 0) + buttonsWidth(foot)
    }
    // 页脚：提示文字在前（放不下就截短或省掉），停止、返回、关闭按钮在后
    const footer = (foot: Foot, width: number) => {
      const buttons = buttonNodes(foot)
      let sep = buttons.length && foot.hints.length ? ' · ' : ''
      const room = width - buttonsWidth(foot) - cells(sep)
      let hint = foot.hints.join(' · ')
      if (cells(hint) > room) hint = room >= 6 ? fit(hint, room) : ''
      if (!hint) sep = ''
      const nodes: RenderElement[] = []
      if (hint) nodes.push(<Text dimColor>{hint}{sep}</Text>)
      buttons.forEach((node, i) => {
        if (i) nodes.push(<Text dimColor> · </Text>)
        nodes.push(node)
      })
      return { width: cells(hint) + cells(sep) + buttonsWidth(foot), nodes }
    }
    function buttonNodes(foot: Foot) {
      const nodes: RenderElement[] = []
      if (foot.stop) nodes.push(<Button plain hotkey="x" key="stop" label={foot.stop} onPress={() => pressStop($)} />)
      if (foot.canBack) nodes.push(<Button plain hotkey="b" key="back" label={foot.back ?? '返回'} onPress={() => (foot.toList ? goList($) : goBack($))} />)
      if (canHide) nodes.push(<Button plain hotkey="q" key="hide" label="关闭" onPress={() => pressHide($)} />)
      return nodes
    }
    // 外框：╭─ 名称  状态 ──── token · 时长 ─╮ … ╰─ 提示 · 按钮 ────╯，总宽 width + 4。
    // body 有 height 行，不足 rows 的用空行补齐（fixed=false 时不补），两侧竖线按补齐后的行数画成两列。
    const shell = (color: string, width: number, head: Head, body: RenderElement, height: number, foot: Foot, fixed = true) => {
      const pad = fixed ? Math.max(0, rows - height) : 0
      const filler = Array.from({ length: pad }, () => <Text> </Text>)
      if (!shelled) {
        return (
          <Box flexDirection="column" width={width}>
            {showTitle && <Box width={width}>
              <Text bold color={head.color} wrap="truncate-end">{head.name}</Text>
              {head.parts && cells(head.name) + cells(`  ${[head.sub, head.right].filter(Boolean).join(' · ')}`) <= width
                ? drawParts([{ text: '  ' }, ...head.parts, ...(head.right ? [{ text: ` · ${head.right}` }] : [])])
                : dimFast(fit(`  ${[head.sub, head.right].filter(Boolean).join(' · ')}`, Math.max(1, width - cells(head.name))))}
            </Box>}
            {body}
            {filler}
          </Box>
        )
      }
      const name = fit(head.name, Math.max(4, width - 4))
      let right = head.right ? ` ${head.right} ` : ''
      if (width - 3 - cells(name) - cells(right) < 0) right = ''
      const subRoom = width - 3 - cells(name) - cells(right)
      const sub = head.sub && subRoom >= 6 ? `  ${fit(head.sub, subRoom - 2)}` : ''
      const topDash = Math.max(1, width - 2 - cells(name) - cells(sub) - cells(right))
      const bottom = footer(foot, width - 2)
      const side = (text: string) => <Box flexDirection="column">{Array.from({ length: height + pad }, () => <Text color={color}>{text}</Text>)}</Box>
      return (
        <Box flexDirection="column" width={width + 4}>
          <Box>
            <Text color={color}>╭─ </Text>
            <Text bold color={head.color}>{name}</Text>
            {sub && head.parts && sub === `  ${head.sub}` ? drawParts([{ text: '  ' }, ...head.parts]) : sub ? dimFast(sub) : null}
            <Text color={color}> {'─'.repeat(topDash)}</Text>
            {right ? <Text dimColor>{right}</Text> : null}
            <Text color={color}>─╮</Text>
          </Box>
          <Box>
            {side('│ ')}
            <Box flexDirection="column" width={width}>{body}{filler}</Box>
            {side(' │')}
          </Box>
          {bottom.width
            ? <Box>
                <Text color={color}>╰─ </Text>
                {bottom.nodes}
                <Text color={color}> {'─'.repeat(Math.max(0, width - 2 - bottom.width))}─╯</Text>
              </Box>
            : <Text color={color}>╰{'─'.repeat(width + 2)}╯</Text>}
        </Box>
      )
    }

    // 最外层：单个 agent、多个任务时一行一个，类型标在名称前（flow 紫色、agent 蓝色）
    if (!run || !at.level) {
      const cur = currentRuns(list)
      if (!cur.length) {
        const message = '本会话还没有派出 Codex 任务。'
        const foot: Foot = { hints: [], stop: null, canBack: false }
        const width = Math.min(columns, Math.max(cells(message), footerCells(foot) + 2, 12))
        return shell(CYAN, width, { name: 'Codex', color: CYAN, sub: '' }, <Text dimColor>{message}</Text>, 1, foot, false)
      }
      const win = windowed(cur, 'runs', r => runKey(r.runId), hot)
      const nameWidth = Math.min(24, Math.max(8, ...cur.map(r => cells(r.name) + 2)))
      const flows = cur.filter(r => r.kind === 'flow').length
      const singles = cur.length - flows
      const active = cur.filter(r => r.status === 'running').length
      // 标题按类型上色：flow 紫色、agent 蓝色，与各行的类型标记一致；右上角写全部任务的 token 合计
      const summaryParts: Part[] = [
        ...(flows ? [{ text: `${flows} 个 flow`, color: PURPLE }] : []),
        ...(singles ? [{ text: `${singles} 个 agent`, color: BLUE }] : []),
        { text: active ? `${active} 个运行中` : '全部结束' },
      ].flatMap((p, i) => (i ? [{ text: ' · ' }, p] : [p]))
      const summary = summaryParts.map(p => p.text).join('')
      const total = cur.reduce((sum, r) => sum + tokensOf(r.tasks), 0)
      const totalText = total ? `${formatTokens(total)} tok` : ''
      const statsOfRun = (r: FlowRun) => {
        const task = r.tasks[0]
        if (r.kind === 'single' && task) return agentStats(task)
        const tokens = tokensOf(r.tasks)
        const live = r.status === 'running' ? livePhases(r) : null
        const parts = live ? [live] : [WORD[r.status] ?? r.status, `${r.tasks.length} 个 agent`]
        if (tokens) parts.push(`${formatTokens(tokens)} tok`)
        return parts.join(' · ')
      }
      const foot: Foot = { hints: ['ctrl+x tab 操作', '↑/↓ 选择', 'Enter 查看'], stop: null, canBack: false }
      // 一行：选中标记 2 + 图标 1 + 空格 1 + 类型 6 + 名称 + 说明 + 耗时 7；说明栏吃掉剩下的宽度，耗时贴右
      const statsWidth = Math.max(4, columns - 17 - nameWidth)
      const listColor = flows && singles ? CYAN : flows ? PURPLE : BLUE
      const open = async (r: FlowRun) => {
        const phase = defaultPhase(r)
        const first = tasksOf(r, phase)[0]
        // 单个 agent 直接看详情
        if (r.kind === 'single' && first) {
          await moveTo($, { runId: r.runId, level: 'agent' as const, phase, label: first.label, text: null })
          return showAgent($, r, first)
        }
        await moveTo($, { runId: r.runId, level: 'phases' as const, phase, label: null, text: null })
        await focusOn($, phase ? phaseKey(phase) : null)
      }
      // 只剩一行内容时一行一个只露得出一个任务，改画一行：全部任务的图标、名称和进度，放不下的写「+N」；名称仍可进入
      if (rows <= 1 && cur.length > 1) {
        const lineWidth = columns
        const nodes: RenderElement[] = []
        let used = 0
        const put = (node: RenderElement, w: number) => { nodes.push(node); used += w }
        if (!showTitle) {
          put(<Text bold color={CYAN}>Codex</Text>, 5)
          // 一行里任务名称优先：前面只写各类数量（运行中看图标），token 合计放行尾，放得下才写
          const counts = summaryParts.slice(0, -2)
          const parts: Part[] = [{ text: '  ' }, ...(counts.length ? counts : summaryParts), { text: ' │ ' }]
          for (const node of drawParts(parts)) nodes.push(node)
          used += parts.reduce((w, p) => w + cells(p.text), 0)
        }
        for (let i = 0; i < cur.length; i++) {
          const r = cur[i]!
          const name = fit(r.name, 20)
          const progress = r.kind === 'flow' ? ` ${doneOf(r.tasks)}/${r.tasks.length}` : ''
          const piece = (i ? 2 : 0) + 2 + cells(name) + cells(progress)
          const rest = cur.length - i
          if (used + piece + (rest > 1 ? cells(` +${rest - 1}`) : 0) > lineWidth) {
            put(<Text dimColor>{` +${rest}`}</Text>, cells(` +${rest}`))
            break
          }
          if (i) put(<Text>  </Text>, 2)
          put(mark(r.status, r.kind === 'flow' ? spinner : agentSpinner), 1)
          put(<Text> </Text>, 1)
          put(<Button plain key={runKey(r.runId)} label={name} onPress={() => open(r)} />, cells(name))
          if (progress) put(<Text dimColor>{progress}</Text>, cells(progress))
        }
        const tail = !showTitle && totalText ? ` · ${totalText}` : ''
        if (tail && used + cells(tail) <= lineWidth) put(<Text dimColor>{tail}</Text>, cells(tail))
        return shell(listColor, lineWidth, { name: 'Codex', color: CYAN, sub: summary, parts: summaryParts, right: totalText }, <Box width={lineWidth}>{nodes}</Box>, 1, { hints: [], stop: null, canBack: false })
      }
      const lines = withMore(win.items.map(r => {
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
              <Button plain key={key} label={fit(r.name, nameWidth - 1)} onPress={() => open(r)} />
            </Box>
            <Box width={statsWidth}>
              {dimFast(fit(statsOfRun(r), statsWidth - 1))}
            </Box>
            <Box width={7} justifyContent="flex-end">
              <Text dimColor>{formatDuration(r.seconds)}</Text>
            </Box>
          </Box>
        )
      }), 'runs', win, true)
      return shell(listColor, columns, { name: 'Codex', color: CYAN, sub: summary, parts: summaryParts, right: totalText }, <Box flexDirection="column">{lines}</Box>, lines.length, foot)
    }

    type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }
    // 过程里每一步的标记：命令、改文件、消息、搜索、插话、执行器的说明
    const STEP: Record<string, [string, string | undefined]> = {
      cmd: ['$', undefined], edit: ['✎', undefined], msg: ['›', undefined], search: ['⌕', undefined], steer: ['↪', CYAN], note: ['!', YELLOW],
    }
    // agent 详情：任务说明；过程（累计数和最近几步，运行中多列几步）；然后是结果或错误，按宽度折行
    const card = (t: FlowTask, width: number) => {
      const lines: Line[] = []
      const live = t.status === 'running'
      if (t.brief) for (const l of wrap(t.brief, width)) lines.push({ text: l })
      if (t.activity || t.recent.length) {
        lines.push({ text: '' })
        const a = t.activity
        lines.push({ text: `过程${a ? `  命令 ${a.commands} · 改文件 ${a.edits} 次 · 消息 ${a.messages}` : ''}`, bold: true, dim: true })
        for (const step of t.recent.slice(live ? -8 : -3)) {
          const [icon, color] = STEP[step.kind] ?? ['·', undefined]
          const tone = step.status === 'running' ? BLUE : step.status === 'failed' ? RED : color
          // 每步一行：旧记录或别的写入者可能带换行
          lines.push({ text: `${icon} ${step.kind === 'steer' ? '插话：' : ''}${step.text.replace(/\s+/g, ' ')}`, color: tone, dim: !tone })
        }
      }
      lines.push({ text: '' })
      if (at.text) {
        lines.push({ text: '结果', bold: true, dim: true })
        for (const l of wrap(at.text.trim(), width)) lines.push({ text: l })
      } else if (t.error) {
        lines.push({ text: '错误', bold: true, dim: true })
        for (const l of wrap(t.error, width)) lines.push({ text: l, color: RED })
      } else {
        lines.push({ text: !live ? '没有结果。' : t.checking ? '验收中：Codex 已结束，正在跑验收命令。' : '运行中，结果出来后显示在这里。', dim: true })
      }
      return lines
    }
    // 超出高度的截掉，末行写还剩多少
    const clip = (lines: Line[], room = bodyRows) => {
      if (room <= 0) return []
      return lines.length > room ? [...lines.slice(0, room - 1), { text: `… 还有 ${lines.length - room + 1} 行`, dim: true }] : lines
    }
    // 空行画一个空格：空 Text 不占行，两侧竖线会和内容错开
    const draw = (l: Line) => l.dim && l.text.includes(FAST) ? <Box>{dimFast(l.text)}</Box> : (
      <Text color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
        {l.text || ' '}
      </Text>
    )

    // 正在看某个任务时，新任务开始面板不跳走（免得打断正在看的内容），只在标题里提一句还有别的任务，按返回回到列表
    const others = currentRuns(list).filter(r => r.runId !== run.runId).length
    const othersNote = others ? `另有 ${others} 个任务` : ''
    const withNote = (text: string) => [text, othersNote].filter(Boolean).join(' · ')

    // 单个 agent 的详情：一栏，名称蓝色，标题写模型、effort、token、状态、耗时；外框已有标题，不再套内框
    if (run.kind === 'single') {
      const single = run.tasks[0]
      // 没有标题行时（只剩一行）先写名称和状态，不只露出任务说明的第一行
      const named: Line[] = showTitle ? [] : [{ text: `${run.name}  ${withNote(runSubtext(run))}`, color: BLUE, bold: true }]
      const lines = clip([...named, ...(single ? card(single, columns) : [{ text: '没有记录。', dim: true }])])
      const foot: Foot = { hints: ['ctrl+x tab 操作'], stop: run.status === 'running' ? '停止' : null, canBack: true, back: '返回列表' }
      return shell(BLUE, columns, { name: run.name, color: BLUE, sub: withNote(runSubtext(run)) }, <Box flexDirection="column">{lines.map(draw)}</Box>, lines.length, foot)
    }

    // 一个 flow：两栏，左栏阶段，右栏 agent 或 agent 详情，照 Workflow 详情面板的样子；名称紫色
    const phase = at.phase ?? defaultPhase(run)
    const agents = tasksOf(run, phase)
    const level = at.level
    const task = level === 'agent' ? agents.find(t => t.label === at.label) : undefined
    // 左栏按内容定宽（阶段栏和详情左栏不同），右栏吃掉剩下的宽度，整块始终占满面板
    // 进度按「总数/总数」预留，完成数进位时不跳
    const countWidth = Math.max(3, ...run.phases.map(p => `${tasksOf(run, p.title).length}/${tasksOf(run, p.title).length}`.length))
    // 阶段一行：选中标记 2 + 序号 + 空格 + 图标 + 空格 + 名称 + 进度 + 耗时（固定预留）
    const numWidth = String(run.phases.length).length
    const timeCell = TIME_SLOT
    const leftWidth =
      level === 'agent'
        ? Math.min(20, Math.max(16, ...agents.map(t => cells(t.label) + 4)))
        : Math.min(32, Math.max(16, Math.max(4, ...run.phases.map(p => cells(p.title))) + 6 + numWidth + countWidth + timeCell))
    const labelWidth = Math.min(16, Math.max(4, ...run.tasks.map(t => cells(t.label))))
    // 两栏之间 3 格，有内框时左右再各 2 格
    const rightWidth = Math.max(8, columns - leftWidth - (framed ? 7 : 3))
    // agent 一行：选中标记 2 + 图标 1 + 空格 1 + 名称 labelWidth+1 + 模型 effort + token（固定预留）+ 耗时（固定预留）
    // 模型栏吃掉多余宽度，token 和时长栏始终贴右
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

    // 左栏：阶段栏和 agent 栏时是阶段，随时可选；agent 详情时是这个阶段的 agent
    const leftColumn = level === 'agent' ? 'detailAgents' : 'phases'
    const leftWin = level === 'agent'
      ? windowed(agents, 'detailAgents', t => detailKey(run.runId, t.label), hot && agents.some(t => detailKey(run.runId, t.label) === hot) ? hot : at.label ? detailKey(run.runId, at.label) : null)
      : windowed(run.phases, 'phases', p => phaseKey(p.title), hot && run.phases.some(p => phaseKey(p.title) === hot) ? hot : phase ? phaseKey(phase) : null)
    const steer = !!Input && !!task && canSteer(run, task)
    // 插话框不在了（任务结束、进入验收、换了 agent）就忘掉光标在它上面，免得下一次 ↑ 被误改道
    if (!steer && ringAt?.startsWith('steer:')) ringAt = null
    const leftCells = withMore(
      level === 'agent'
        ? (leftWin.items as FlowTask[]).map(t => {
            const key = detailKey(run.runId, t.label)
            const me = t.label === at.label
            return (
              <Box>
                <Text color={BLUE}>{me ? '❯ ' : '  '}</Text>
                {mark(t.status)}
                <Text> </Text>
                <Button
                  plain
                  key={key}
                  label={fit(t.label, leftWidth - 4)}
                  dimColor={me ? undefined : true}
                  onPress={async () => {
                    // 在当前 agent 上按 Enter 跳到插话框；点别的 agent 切过去
                    if (t.label === (await read($, nav)).label) {
                      const now = (await read($, runs)).find(r => r.runId === run.runId)
                      const cur = now?.tasks.find(x => x.label === t.label)
                      if (now && cur && canSteer(now, cur)) await focusOn($, steerKey(run.runId, t.label, await read($, steerRound)))
                      return
                    }
                    await showAgent($, run, t)
                    await focusOn($, key)
                  }}
                />
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
                <Text color={BLUE}>{hot === phaseKey(p.title) ? '❯ ' : '  '}</Text>
                <Text color={tone} dimColor={dim}>
                  {String(leftWin.start + i + 1).padStart(numWidth)}
                </Text>
                <Text> </Text>
                <Text color={live ? BLUE : color} dimColor={!live && !color}>
                  {sign}
                </Text>
                <Text> </Text>
                <Box width={titleWidth}>
                  <Button
                    plain
                    key={phaseKey(p.title)}
                    label={fit(p.title, titleWidth - 1)}
                    dimColor={dim ? true : undefined}
                    onPress={async () => {
                      const first = ts[0]
                      await moveTo($, { ...await read($, nav), level: 'agents' as const, phase: p.title, label: null, text: null })
                      if (first) await focusOn($, taskKey(run.runId, first.label))
                    }}
                  />
                </Box>
                <Box width={countWidth} justifyContent="flex-end">
                  <Text color={tone} dimColor={dim}>
                    {count}
                  </Text>
                </Box>
                <Box width={timeCell} justifyContent="flex-end">
                  <Text color={tone} dimColor={dim}>
                    {time}
                  </Text>
                </Box>
              </Box>
            )
          }), leftColumn, leftWin, true)

    // 右栏：阶段栏和 agent 栏时列出所选阶段的 agent（可选，Enter 看详情），详情时是这个 agent 的卡片和插话框
    let rightCells: RenderElement[]
    let rightTitle: string
    if (task) {
      rightTitle = `${task.label} · ${agents.indexOf(task) + 1}/${agents.length}`
      const time = task.reused ? '复用上次结果' : agentTime(task)
      const state = task.checking ? '验收中' : !task.reused && (task.status === 'running' || task.status === 'completed') ? WORD[task.status] : ''
      const stats = [agentStats(task), time, state].filter(Boolean).join(' · ')
      const lines: Line[] = [{ text: stats, dim: true }, ...card(task, rightWidth)]
      rightCells = clip(lines, bodyRows - (steer ? 1 : 0)).map(draw)
      if (steer && Input) {
        rightCells.push(
          <Box width={rightWidth}>
            <Input
              key={steerKey(run.runId, task.label, round)}
              label="插话"
              placeholder="补充指示，发给这个 agent"
              submitLabel="发送"
              onSubmit={(value: string) => void sendSteer($, run.runId, task.label, value)}
            />
          </Box>,
        )
      }
    } else {
      // agent 栏里光标在某个 agent 上时，栏标题写它的任务说明
      const hotAgent = agents.find(t => taskKey(run.runId, t.label) === hot)
      rightTitle = level === 'agents' && hotAgent?.brief ? `${hotAgent.label}：${hotAgent.brief}` : `${phase ?? ''} · ${agents.length} 个 agent`
      const runningAgent = agents.find(t => t.status === 'running')
      const preferred = hotAgent ? hot : runningAgent ? taskKey(run.runId, runningAgent.label) : null
      const rightWin = windowed(agents, 'agents', t => taskKey(run.runId, t.label), preferred)
      rightCells = withMore(rightWin.items.map(t => {
        const key = taskKey(run.runId, t.label)
        const tokens = t.tokens ? `${formatTokens(t.tokens)} tok` : ''
        // 耗时栏：运行中和完成写时长，复用写「复用」，验收中写「验收中」，其余写状态（等待、失败等）
        const time = t.checking ? '验收中' : agentTime(t) || (WORD[t.status] ?? t.status)
        return (
          <Box>
            <Text color={BLUE}>{hot === key ? '❯ ' : '  '}</Text>
            {mark(t.status)}
            <Text> </Text>
            <Box width={labelWidth + 1}>
              <Button plain key={key} label={fit(t.label, labelWidth)} dimColor={t.status === 'running' ? undefined : true} onPress={async () => {
                await showAgent($, run, t)
                await focusOn($, detailKey(run.runId, t.label))
              }} />
            </Box>
            <Box width={modelCell}>
              {dimFast(fit(modelText(t), modelCell))}
            </Box>
            <Box width={TOKEN_SLOT} justifyContent="flex-end">
              <Text dimColor>{tokens}</Text>
            </Box>
            <Box width={TIME_SLOT} justifyContent="flex-end">
              <Text dimColor>{time}</Text>
            </Box>
          </Box>
        )
      }), 'agents', rightWin, true)
      if (!agents.length) rightCells = [<Text dimColor>这个阶段没有 agent</Text>]
    }

    // 两栏各是一列：光标按树序先走完左栏再到右栏，不会在两栏之间来回跳
    // 两栏补到可用高度，内框和外框一样固定大小
    const height = Math.max(leftCells.length, rightCells.length, bodyRows)
    const fill = (items: RenderElement[]) => [...items, ...Array.from({ length: height - items.length }, () => <Text> </Text>)]
    const bar = (text: string) => <Box flexDirection="column">{Array.from({ length: height }, () => <Text dimColor>{text}</Text>)}</Box>
    const body = (
      <Box flexDirection="column">
        {framed && border(level === 'agent' ? `${phase ?? ''}` : '阶段', rightTitle, true)}
        <Box>
          {framed && bar('│ ')}
          <Box flexDirection="column" width={leftWidth}>{fill(leftCells)}</Box>
          {bar(' │ ')}
          <Box flexDirection="column" width={rightWidth}>{fill(rightCells)}</Box>
          {framed && bar(' │')}
        </Box>
        {framed && border('', '', false)}
      </Box>
    )
    const running = run.status === 'running'
    const back = up(list, at)
    const outer = !back
    const hints =
      level === 'phases' ? ['↑/↓ 选择', 'Enter 看 agent'] : level === 'agents' ? ['↑/↓ 选择', 'Enter 详情'] : steer ? ['↑/↓ 切换 agent', 'Enter 插话'] : ['↑/↓ 切换 agent']
    // 停止键只给在跑的目标：阶段栏停整个 flow，agent 栏和详情停选中的 agent
    const target = level === 'agent' ? task : agents.find(t => taskKey(run.runId, t.label) === hot)
    const stop = !running ? null : level === 'phases' ? '停止整个 flow' : target?.status === 'running' ? '停止' : null
    const foot: Foot = { hints: ['ctrl+x tab 操作', ...hints], stop, canBack: !outer, back: back?.to.runId === null ? '返回列表' : undefined }
    const totalTokens = tokensOf(run.tasks)
    const parallel = run.status === 'running' ? run.phases.filter(p => p.status === 'running').length : 0
    const head: Head = {
      name: run.name,
      color: PURPLE,
      sub: [WORD[run.status] ?? run.status, othersNote, parallel > 1 ? `${parallel} 个阶段并行` : ''].filter(Boolean).join(' · '),
      right: [totalTokens ? `${formatTokens(totalTokens)} tok` : '', formatDuration(run.seconds)].filter(Boolean).join(' · '),
    }
    // 只剩一行内容时（输入框草稿或任务清单占了高度），两栏只放得下一个阶段和一个 agent，看起来像只有一个任务。
    // 改画一行摘要：当前阶段的进度和它的全部 agent，放不下的写「+N」；没有标题行时 flow 名称放在最前
    if (rows <= 1) {
      // 一行摘要用满可用宽度，名称、模型和 token 才放得下
      const lineWidth = columns
      const p = run.phases.find(x => x.title === phase)
      const nodes: RenderElement[] = []
      let used = 0
      const put = (node: RenderElement, w: number) => { nodes.push(node); used += w }
      const putDim = (text: string) => { nodes.push(...dimFast(text)); used += cells(text) }
      if (!showTitle) {
        const name = fit(run.name, Math.max(4, Math.floor(lineWidth / 3)))
        put(<Text bold color={PURPLE}>{name}</Text>, cells(name))
        put(<Text>  </Text>, 2)
      }
      if (p) {
        const text = ` ${fit(p.title, 12)} ${doneOf(agents)}/${agents.length}`
        put(mark(p.status, spinner), 1)
        put(<Text color={p.status === 'running' ? BLUE : undefined}>{text}</Text>, cells(text))
        put(<Text dimColor> │ </Text>, 3)
      }
      // 行尾：这个阶段的 agent 用同一个模型和 effort 时写一次，不同时写在各自名称后；
      // 没有标题行时再写总 token 和总时长。放不下时依次省掉时长、模型、token，agent 名称优先
      const models = [...new Set(agents.map(modelText))]
      const shared = models.length === 1 ? models[0]! : ''
      const total = tokensOf(run.tasks)
      const tail = [shared, !showTitle && total ? `${formatTokens(total)} tok` : '', !showTitle ? formatDuration(run.seconds) : '']
      const tailText = () => tail.filter(Boolean).map(s => ` · ${s}`).join('')
      // 别的任务提示不省：一行摘要里只有它能看出还有别的任务
      const note = othersNote ? ` │ ${othersNote}` : ''
      for (const drop of [2, 0, 1]) if (used + 12 + cells(note) + cells(tailText()) > lineWidth) tail[drop] = ''
      const room = lineWidth - cells(note) - cells(tailText())
      for (let i = 0; i < agents.length; i++) {
        const t = agents[i]!
        const label = fit(t.label, 16)
        const own = shared ? '' : ` ${modelText(t)}`
        const piece = (i ? 2 : 0) + 2 + cells(label) + cells(own)
        const rest = agents.length - i
        const reserve = rest > 1 ? cells(` +${rest - 1}`) : 0
        if (used + piece + reserve > room) {
          put(<Text dimColor>{` +${rest}`}</Text>, cells(` +${rest}`))
          break
        }
        if (i) put(<Text>  </Text>, 2)
        put(mark(t.status), 1)
        put(<Text dimColor={t.status === 'running' ? undefined : true}>{` ${label}`}</Text>, 1 + cells(label))
        if (own) putDim(own)
      }
      if (tailText()) putDim(tailText())
      if (note) put(<Text color={CYAN}>{note}</Text>, cells(note))
      // 摘要里没有可选项，不写操作提示（原因写在 README）；停止键只留阶段栏的「停止整个 flow」，免得停掉看不见的 agent。
      // 有别的任务时留返回键，直接回列表（摘要里各层画得一样，逐层退看不出变化）
      const compact: Foot = { hints: [], stop: level === 'phases' ? stop : null, canBack: others > 0, back: '返回列表', toList: true }
      return shell(PURPLE, lineWidth, head, <Box width={lineWidth}>{nodes}</Box>, 1, compact)
    }
    return shell(PURPLE, columns, head, body, height + (framed ? 2 : 0), foot)
  })
}
