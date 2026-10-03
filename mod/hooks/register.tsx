// codex-flow：读取本会话任务，编排面板事件；重载面板不影响执行器。
// 注册、atom、缓存、计时器和写入队列集中在这里，视图只接收数据与回调。
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, MatchedHook } from 'claude-code'
import type { FlowRun, FlowTask, PanelRecord, WindowColumn, WindowStarts } from '../types'
import { SPIN, AGENT_SPIN, SPIN_MS, fileSafe, formatDuration, tasksOf } from './format'
import { TOP, currentRuns, listedRuns, entry, runKey, phaseKey, taskKey, detailKey, isItem, canSteer, steerKey } from './navigation'
import type { ActionContext } from './panel-actions'
import { applyShown, autoShow, moveTo, syncWindows, revealFocus, trackFocus, shiftWindow, goBack, goList, openRun, selectPhase, selectAgent, selectDetail } from './panel-actions'
import { readRunList, loadResult } from './state-reader'
import type { ViewContext } from './render-frame'
import { panelDimensions } from './render-frame'
import { renderRunList } from './render-list'
import { renderSingle } from './render-agent'
import { renderFlow } from './render-flow'

const REFRESH_MS = 2000
const DEFAULT_ALERT_AFTER = 900

const runs = atom({ plugin: 'codex-flow', key: 'runs' } as const, [] as FlowRun[])
const nav = atom({ plugin: 'codex-flow', key: 'nav' } as const, TOP)
const focused = atom({ plugin: 'codex-flow', key: 'focused' } as const, null as string | null)
const reminded = atom({ plugin: 'codex-flow', key: 'reminded' } as const, [] as string[])
// 主对话是否正在跑一轮：插件提交的提醒要等空闲才送达，在忙时先不提交，免得送到时任务已经结束
const working = atom({ plugin: 'codex-flow', key: 'working' } as const, false)
// 输入框上方是否显示面板：/flow 打开，全部结束后 q 关闭
const shown = atom({ plugin: 'codex-flow', key: 'shown' } as const, false)
const opened = atom({ plugin: 'codex-flow', key: 'opened' } as const, [] as string[])
// 面板这次打开后出现过的任务：结束后仍留在列表下方，面板关掉时清空
const kept = atom({ plugin: 'codex-flow', key: 'kept' } as const, [] as string[])
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

async function readRuns($: Engine) {
  const root = await runsRoot($)
  const session = await $.session.id()
  const now = await $.clock.now()
  const list = await readRunList({
    root, session, now, otherSession, goodStates, reportedErrors, lostSince,
    list: () => $.fs.list(root),
    exists: () => $.fs.exists(root),
    readText: path => readText($, path),
    stateMtime: dir => stateMtime($, dir),
    alivePids: pids => alivePids($, pids),
    current: () => read($, runs),
    record: (list, errors, newErrors) => {
      snapshot = {
        at: new Date(now).toISOString(), complete: errors.length === 0, errors,
        runs: list.map(({ runId, status, endedSeconds }) => ({ runId, status, endedSeconds })),
      }
      if (newErrors.length) $.ui.log(JSON.stringify({ event: 'refresh-incomplete', source: { root: $.plugin.root, instance }, snapshot: { ...snapshot, errors: newErrors } }), { to: 'debug' })
    },
  })
  if (!list) return
  await update($, runs, () => list)
  await autoShow(actionContext($), list)
  if (await read($, shown)) {
    const ids = currentRuns(list).map(r => r.runId)
    await update($, kept, old => (ids.every(id => old.includes(id)) ? old : [...old, ...ids.filter(id => !old.includes(id))].slice(-50)))
  }
  await syncWindows(actionContext($))
  await remind($, list)
  // 结果页打开时任务刚好出了结果，补读一次
  const at = await read($, nav)
  if (at.label && at.text === null) {
    const run = list.find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => t.label === at.label)
    if (run && task?.result) {
      const text = await loadResult(path => readText($, path), run, task)
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
  await changePanel($, () => applyShown(actionContext($), value, by, isAuto))
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

async function focusOn($: Engine, key: string | null) {
  if (!key) return
  if (isItem(key)) {
    await update($, focused, () => key)
    await revealFocus(actionContext($), key)
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

function actionContext($: Engine): ActionContext {
  return {
    readSteerRound: () => read($, steerRound),
    readRuns: () => read($, runs),
    readNav: () => read($, nav),
    updateNav: change => update($, nav, change),
    readFocused: () => read($, focused),
    updateFocused: change => update($, focused, change),
    readWindows: () => read($, windows),
    updateWindows: change => update($, windows, change),
    readKept: () => read($, kept),
    updateKept: change => update($, kept, change),
    readShown: () => read($, shown),
    updateShown: change => update($, shown, change),
    readAuto: () => read($, auto),
    updateAuto: change => update($, auto, change),
    readOpened: () => read($, opened),
    updateOpened: change => update($, opened, change),
    emptyWindows: EMPTY_WINDOWS,
    get windowSize() {
      return windowSize
    },
    focusOn: key => focusOn($, key),
    loadResult: (run, task) => loadResult(path => readText($, path), run, task),
    clearRing: () => {
      ringAt = null
    },
    setLatestPanel: value => {
      latestPanel = value
    },
    changePanel: decide => changePanel($, decide),
  }
}

function viewCallbacks($: Engine): ViewContext['callbacks'] {
  return {
    shiftWindow: (column, direction) => shiftWindow(actionContext($), column, direction),
    pressStop: () => pressStop($),
    goBack: () => goBack(actionContext($)),
    goList: () => goList(actionContext($)),
    pressHide: () => pressHide($),
    openRun: run => openRun(actionContext($), run),
    selectPhase: (run, title) => selectPhase(actionContext($), run, title),
    selectAgent: (run, task) => selectAgent(actionContext($), run, task),
    selectDetail: (run, task) => selectDetail(actionContext($), run, task),
    clearSteerFocus: steer => {
      if (!steer && ringAt?.startsWith('steer:')) ringAt = null
    },
    sendSteer: (runId, label, value) => void sendSteer($, runId, label, value),
  }
}

const renderPanel: MatchedHook<'ui.render', { component: 'AbovePrompt' }> = async ($, e, next) => {
  // 没打开、有问卷，或正在看子代理的对话时让出这块区域。
  if (!(await read($, shown)) || e.props.hasSurvey || e.props.view?.agentId) return next(e)
  bandId = e.requestId
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // 手机端没有输入框，那里不画插话框。
  const Input = 'Input' in elements ? elements.Input : null
  const list = await read($, runs)
  const at = await read($, nav)
  const shownRuns = listedRuns(list, await read($, kept), at.runId)
  const hot = await read($, focused)
  const tick = await read($, frame)
  const round = await read($, steerRound)
  const run = list.find(r => r.runId === at.runId)
  const dimensions = panelDimensions(e.props.bodyColumns, e.props.maxRows, run, at)
  if (!dimensions.bandRows) return <Box flexDirection="column" />
  windowSize = dimensions.size
  const starts = await read($, windows)
  const ctx: ViewContext = {
    Box, Text, Button, Input, at, hot, round, shownRuns, starts, ...dimensions,
    spinner: SPIN[tick % SPIN.length], agentSpinner: AGENT_SPIN[tick % AGENT_SPIN.length],
    canHide: !list.some(r => r.status === 'running'), callbacks: viewCallbacks($),
  }
  if (!run || !at.level) return renderRunList(ctx)
  return run.kind === 'single' ? renderSingle(ctx, run) : renderFlow(ctx, run)
}

const trackPanelFocus: MatchedHook<'ui.focus', { component: 'AbovePrompt' }> = async ($, e, next) => {
  const redirect = e.element && e.origin.kind === 'person' ? await redirectFocus($, e.element) : null
  const target = redirect ? { ...e, element: redirect } : e
  const moved = await next(target)
  const key = target.element
  if (moved.deny || !key) return moved
  ringAt = key
  const more = /^more:(runs|phases|agents|detailAgents):(up|down)$/.exec(key)
  if (more) {
    await shiftWindow(actionContext($), more[1] as WindowColumn, more[2] as 'up' | 'down')
    return moved
  }
  await trackFocus(actionContext($), key)

  return moved
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: '打开 Codex 任务面板' })
    // 重载后让状态行和面板一致
    await changePanel($, async () => applyShown(actionContext($), await read($, shown), 'reload', await read($, auto)))
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
    const start = entry(listedRuns(await read($, runs), [], null))
    await moveTo(actionContext($), start.to)
    await setShown($, true, 'command')

    return { text: '已在输入框上方打开 Codex 任务面板。如果只看到一行「▸ plugin panel hidden」，点一下它或按 ctrl+x ctrl+a 展开。' }
  })

  // 光标移动时：阶段栏里右栏跟着换阶段，详情页里右栏跟着换 agent；记下位置，x 停的就是它
  on('ui.focus', { component: 'AbovePrompt' }, trackPanelFocus)
  on('ui.render', { component: 'AbovePrompt' }, renderPanel)
}
