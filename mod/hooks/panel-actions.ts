// 面板层级、窗口与自动显示的状态变更；atom、队列和实际焦点仍由入口持有。
import type { FlowRun, FlowTask, Nav, PanelRecord, WindowColumn, WindowStarts } from '../types'
import { tasksOf } from './format'
import { RECENT, TOP, listedRuns, entry, defaultPhase, up, columnKeys, windowStart, runKey, phaseKey, taskKey, detailKey, isItem, canSteer, steerKey } from './navigation'

export type ActionContext = {
  readSteerRound: () => Promise<number>
  readRuns: () => Promise<FlowRun[]>
  readNav: () => Promise<Nav>
  updateNav: (change: (value: Nav) => Nav) => Promise<Nav>
  readFocused: () => Promise<string | null>
  updateFocused: (change: (value: string | null) => string | null) => Promise<string | null>
  readWindows: () => Promise<WindowStarts>
  updateWindows: (change: (value: WindowStarts) => WindowStarts) => Promise<WindowStarts>
  readKept: () => Promise<string[]>
  updateKept: (change: (value: string[]) => string[]) => Promise<string[]>
  readShown: () => Promise<boolean>
  updateShown: (change: (value: boolean) => boolean) => Promise<boolean>
  readAuto: () => Promise<boolean>
  updateAuto: (change: (value: boolean) => boolean) => Promise<boolean>
  readOpened: () => Promise<string[]>
  updateOpened: (change: (value: string[]) => string[]) => Promise<string[]>
  emptyWindows: WindowStarts
  windowSize: number
  focusOn: (key: string | null) => Promise<void>
  loadResult: (run: FlowRun, task: FlowTask) => Promise<string | null>
  clearRing: () => void
  setLatestPanel: (value: Pick<PanelRecord, 'shown' | 'auto' | 'by'>) => void
  changePanel: (decide: () => Promise<boolean>) => Promise<void>
}

async function listed(ctx: ActionContext) {
  return listedRuns(await ctx.readRuns(), await ctx.readKept(), (await ctx.readNav()).runId)
}

// 只在 panelChanges 内调用；完整记下这次 shown/auto 的来源。
export async function applyShown(ctx: ActionContext, value: boolean, by: PanelRecord['by'], isAuto = false) {
  if (!value) {
    ctx.clearRing()
    await ctx.updateKept(() => [])
  }
  await ctx.updateShown(() => value)
  await ctx.updateAuto(() => value && isAuto)
  ctx.setLatestPanel({ shown: value, auto: value && isAuto, by })
  return true
}

// 自动打开/收起也排队，排到时重新读用户已更新的 shown/auto。
export async function autoShow(ctx: ActionContext, list: FlowRun[]) {
  await ctx.changePanel(async () => {
    const running = list.filter(r => r.status === 'running')
    const seen = await ctx.readOpened()
    const fresh = running.filter(r => !seen.includes(r.runId))
    if (fresh.length) {
      await ctx.updateOpened(old => [...old, ...fresh.map(r => r.runId)].slice(-100))
      const at = await ctx.readNav()
      const watching = list.some(r => r.runId === at.runId)
      const visible = await ctx.readShown()
      if (!visible || !watching) await moveTo(ctx, entry(listedRuns(list, visible ? await ctx.readKept() : [], null)).to)
      if (!visible) return applyShown(ctx, true, 'auto-open', true)
      return false
    }
    const recent = list.some(r => r.status === 'running' || (r.endedSeconds !== null && r.endedSeconds < RECENT))
    if (!recent && (await ctx.readShown()) && (await ctx.readAuto())) return applyShown(ctx, false, 'auto-close')
    return false
  })
}

export async function moveTo(ctx: ActionContext, to: Nav) {
  const before = await ctx.readNav()
  if (before.runId !== to.runId) {
    await ctx.updateWindows(() => ({ ...ctx.emptyWindows }))
    await ctx.updateFocused(() => null)
  } else if (before.phase !== to.phase) {
    // 同一个 flow 换阶段只清 agent 窗口；阶段窗口由 syncWindows 最小幅度校正。
    await ctx.updateWindows(old => ({ ...old, agents: 0, detailAgents: 0 }))
    await ctx.updateFocused(() => null)
  }
  await ctx.updateNav(() => to)
  await syncWindows(ctx)
}

// 渲染必须纯读；刷新/导航事件持久化只读列起点，尺寸变化在下一事件校正。
export async function syncWindows(ctx: ActionContext) {
  const list = await ctx.readRuns()
  const at = await ctx.readNav()
  const run = list.find(r => r.runId === at.runId)
  const hot = await ctx.readFocused()
  const phase = run ? at.phase ?? defaultPhase(run) : null
  const agents = run ? tasksOf(run, phase) : []
  const phaseIndex = run?.phases.findIndex(p => p.title === phase) ?? -1
  const runningIndex = agents.findIndex(t => t.status === 'running')
  const hotIndex = run ? agents.findIndex(t => taskKey(run.runId, t.label) === hot) : -1
  const listedCount = listedRuns(list, await ctx.readKept(), at.runId).length
  await ctx.updateWindows(old => ({
    runs: windowStart(old.runs, listedCount, ctx.windowSize),
    phases: windowStart(old.phases, run?.phases.length ?? 0, ctx.windowSize, phaseIndex),
    agents: windowStart(old.agents, agents.length, ctx.windowSize, at.level === 'agents' ? hotIndex : runningIndex),
    detailAgents: windowStart(old.detailAgents, agents.length, ctx.windowSize, agents.findIndex(t => t.label === at.label)),
  }))
}

export async function revealFocus(ctx: ActionContext, key: string) {
  const list = await ctx.readRuns()
  const at = await ctx.readNav()
  for (const column of Object.keys(ctx.emptyWindows) as WindowColumn[]) {
    const keys = columnKeys(listedRuns(list, await ctx.readKept(), at.runId), at, column)
    const index = keys.indexOf(key)
    if (index < 0) continue
    await ctx.updateWindows(old => ({ ...old, [column]: windowStart(old[column], keys.length, ctx.windowSize, index) }))
  }
}

// 光标落到阶段就切到阶段栏并换右栏，落到 agent 就是 agent 栏；落到按钮、插话框时不动，x 停的仍是上一个条目
export async function trackFocus(ctx: ActionContext, key: string) {
  if (!isItem(key)) return
  const at = await ctx.readNav()
  if (key.startsWith('p:') && (at.level === 'phases' || at.level === 'agents')) await moveTo(ctx, { ...at, level: 'phases' as const, phase: key.slice(2) })
  else if (key.startsWith('t:') && at.level === 'phases') await ctx.updateNav(n => ({ ...n, level: 'agents' as const }))
  await ctx.updateFocused(() => key)
  await revealFocus(ctx, key)
  if (key.startsWith('a:') && at.level === 'agent') {
    const run = (await ctx.readRuns()).find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => detailKey(run.runId, t.label) === key)
    if (run && task && task.label !== at.label) await showAgent(ctx, run, task)
  }
}

export async function shiftWindow(ctx: ActionContext, column: WindowColumn, direction: 'up' | 'down') {
  const at = await ctx.readNav()
  const keys = columnKeys(await listed(ctx), at, column)
  if (!keys.length) return
  const hot = await ctx.readFocused()
  const preferred = keys.includes(hot ?? '') ? hot : column === 'phases' && at.phase ? phaseKey(at.phase) : column === 'detailAgents' && at.label ? detailKey(at.runId ?? '', at.label) : null
  // resize 后 state 可能还是上次尺寸的起点，先按当前绘制窗口校正再移动一格。
  const old = windowStart((await ctx.readWindows())[column], keys.length, ctx.windowSize, keys.indexOf(preferred ?? ''))
  const start = windowStart(old + (direction === 'up' ? -1 : 1), keys.length, ctx.windowSize)
  if (start === old) return
  const key = keys[direction === 'up' ? start : Math.min(keys.length - 1, start + ctx.windowSize - 1)]!
  // 引擎不会重入当前 ui.focus 钩子，翻页自己同步阶段/详情，再请求实际移动光标。
  await trackFocus(ctx, key)
  await ctx.updateWindows(w => ({ ...w, [column]: start }))
  await ctx.focusOn(key)
}

export async function goBack(ctx: ActionContext) {
  const back = up(await listed(ctx), await ctx.readNav())
  if (!back) return
  await moveTo(ctx, back.to)
  await ctx.focusOn(back.key)
}

// 一行摘要里各层画得一样，返回直接回任务列表，光标停在刚才看的那个任务上
export async function goList(ctx: ActionContext) {
  const runId = (await ctx.readNav()).runId
  await moveTo(ctx, TOP)
  await ctx.focusOn(runId ? runKey(runId) : null)
}

// 打开某个 agent 的详情，结果文本读出来放进 nav
export async function showAgent(ctx: ActionContext, run: FlowRun, task: FlowTask) {
  await ctx.updateFocused(() => detailKey(run.runId, task.label))
  await ctx.updateNav(n => ({ ...n, level: 'agent' as const, label: task.label, text: null }))
  const text = await ctx.loadResult(run, task)
  await ctx.updateNav(n => (n.runId === run.runId && n.label === task.label ? { ...n, text } : n))
}

export async function openRun(ctx: ActionContext, r: FlowRun) {
  const phase = defaultPhase(r)
  const first = tasksOf(r, phase)[0]
  // 单个 agent 直接看详情
  if (r.kind === 'single' && first) {
    await moveTo(ctx, { runId: r.runId, level: 'agent' as const, phase, label: first.label, text: null })
    return showAgent(ctx, r, first)
  }
  await moveTo(ctx, { runId: r.runId, level: 'phases' as const, phase, label: null, text: null })
  await ctx.focusOn(phase ? phaseKey(phase) : null)
}

export async function selectPhase(ctx: ActionContext, run: FlowRun, title: string) {
  const first = tasksOf(run, title)[0]
  await moveTo(ctx, { ...await ctx.readNav(), level: 'agents' as const, phase: title, label: null, text: null })
  if (first) await ctx.focusOn(taskKey(run.runId, first.label))
}

export async function selectAgent(ctx: ActionContext, run: FlowRun, t: FlowTask) {
  await showAgent(ctx, run, t)
  await ctx.focusOn(detailKey(run.runId, t.label))
}

export async function selectDetail(ctx: ActionContext, run: FlowRun, t: FlowTask) {
  // 在当前 agent 上按 Enter 跳到插话框；点别的 agent 切过去。
  if (t.label === (await ctx.readNav()).label) {
    const now = (await ctx.readRuns()).find(r => r.runId === run.runId)
    const cur = now?.tasks.find(x => x.label === t.label)
    if (now && cur && canSteer(now, cur)) await ctx.focusOn(steerKey(run.runId, t.label, await ctx.readSteerRound()))
    return
  }
  await selectAgent(ctx, run, t)
}

