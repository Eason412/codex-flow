// 面板层级、窗口与自动显示的状态变更；atom、队列和实际焦点仍由入口持有。
import type { FlowRun, FlowTask, Nav, PanelRecord, WindowColumn, WindowStarts } from '../types'
import { tasksOf } from './format'
import { RECENT, listedRuns, entry, defaultPhase, up, columnKeys, windowStart, leftItems, leftKey, taskKey, detailKey, isItem, canSteer, steerKey, verticalLeft, runRound } from './navigation'

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
  // 各列当前画出的行数（竖排版面里阶段和 agent 上下叠着，各占一部分）；vertical：画的是竖排版面，没有左右栏
  windowSize: WindowStarts
  pagerKeys: Set<string>
  vertical: boolean
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
    const fresh = running.filter(r => !seen.includes(runRound(r)))
    if (fresh.length) {
      await ctx.updateOpened(old => [...old, ...fresh.map(runRound)].slice(-100))
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
    // 换运行只清右栏；左栏保留起点，syncWindows 只在目标不在窗口内时移动。
    await ctx.updateWindows(old => ({ ...ctx.emptyWindows, left: old.left }))
    await ctx.updateFocused(() => null)
  } else if (before.phase !== to.phase) {
    // 同一个运行换阶段只清 agent 窗口；左栏窗口由 syncWindows 最小幅度校正。
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
  const shown = listedRuns(list, await ctx.readKept(), at.runId)
  const left = ctx.vertical ? verticalLeft(shown, at).keys : leftItems(shown, run).map(item => item.key)
  const selected = ctx.vertical ? verticalLeft(shown, at).selected : run ? leftKey(shown, run, phase) : ''
  const leftIndex = left.indexOf(hot && left.includes(hot) ? hot : selected ?? '')
  const runningIndex = agents.findIndex(t => t.status === 'running')
  const hotIndex = run ? agents.findIndex(t => taskKey(run.runId, t.label) === hot) : -1
  await ctx.updateWindows(old => ({
    left: windowStart(old.left, left.length, ctx.windowSize.left, leftIndex),
    agents: windowStart(old.agents, agents.length, ctx.windowSize.agents, at.level === 'agents' ? hotIndex : runningIndex),
    detailAgents: windowStart(old.detailAgents, agents.length, ctx.windowSize.detailAgents, agents.findIndex(t => t.label === at.label)),
  }))
}

export async function revealFocus(ctx: ActionContext, key: string) {
  const list = await ctx.readRuns()
  const at = await ctx.readNav()
  for (const column of Object.keys(ctx.emptyWindows) as WindowColumn[]) {
    const keys = columnKeys(listedRuns(list, await ctx.readKept(), at.runId), at, column, ctx.vertical)
    const index = keys.indexOf(key)
    if (index < 0) continue
    await ctx.updateWindows(old => ({ ...old, [column]: windowStart(old[column], keys.length, ctx.windowSize[column], index) }))
  }
}

// 光标落到左栏的运行或阶段就选中它、换右栏，落到 agent 就是在右栏；落到按钮、插话框时不动，x 停的仍是上一个条目
export async function trackFocus(ctx: ActionContext, key: string) {
  if (!isItem(key)) return
  const at = await ctx.readNav()
  const columns = at.level === 'phases' || at.level === 'agents'
  const run = key.startsWith('r:') ? (await listed(ctx)).find(r => r.runId === key.slice(2)) : undefined
  if (run && columns) {
    const same = run.runId === at.runId
    await moveTo(ctx, { runId: run.runId, level: 'phases' as const, phase: same ? at.phase : defaultPhase(run), label: null, text: null })
  } else if (key.startsWith('p:') && columns) {
    // 竖排版面里几个运行时 level 为 agents 表示已进了某个运行的页面，换阶段不能退回列表
    await moveTo(ctx, { ...at, level: ctx.vertical && at.level === 'agents' ? 'agents' as const : 'phases' as const, phase: key.slice(2) })
  }
  else if (key.startsWith('t:') && at.level === 'phases') await ctx.updateNav(n => ({ ...n, level: 'agents' as const }))
  await ctx.updateFocused(() => key)
  await revealFocus(ctx, key)
  if (key.startsWith('a:') && at.level === 'agent') {
    const run = (await ctx.readRuns()).find(r => r.runId === at.runId)
    const task = run?.tasks.find(t => detailKey(run.runId, t.label) === key)
    if (run && task && task.label !== at.label) await showAgent(ctx, run, task)
  }
}

export async function shiftWindow(ctx: ActionContext, column: WindowColumn, direction: 'up' | 'down', focus = true) {
  const at = await ctx.readNav()
  const keys = columnKeys(await listed(ctx), at, column, ctx.vertical)
  if (!keys.length) return
  const hot = await ctx.readFocused()
  const run = (await listed(ctx)).find(r => r.runId === at.runId)
  const left = ctx.vertical ? verticalLeft(await listed(ctx), at).selected : run ? leftKey(await listed(ctx), run, at.phase) : null
  const preferred = keys.includes(hot ?? '') ? hot : column === 'left' && left ? left : column === 'detailAgents' && at.label ? detailKey(at.runId ?? '', at.label) : null
  // resize 后 state 可能还是上次尺寸的起点，先按当前绘制窗口校正再移动一格。
  const size = ctx.windowSize[column]
  if (size <= 0) return
  const old = windowStart((await ctx.readWindows())[column], keys.length, size, keys.indexOf(preferred ?? ''))
  const start = windowStart(old + (direction === 'up' ? -1 : 1), keys.length, size)
  if (start === old) return
  const key = keys[direction === 'up' ? start : Math.min(keys.length - 1, start + size - 1)]!
  // 引擎不会重入当前 ui.focus 钩子，翻页自己同步阶段/详情，再请求实际移动光标。
  await trackFocus(ctx, key)
  await ctx.updateWindows(w => ({ ...w, [column]: start }))
  if (focus) await ctx.focusOn(key)
  return key
}

export async function goBack(ctx: ActionContext) {
  const back = up(await listed(ctx), await ctx.readNav(), ctx.vertical)
  if (!back) return
  await moveTo(ctx, back.to)
  await ctx.focusOn(back.key)
}

// 打开某个 agent 的详情，结果文本读出来放进 nav
export async function showAgent(ctx: ActionContext, run: FlowRun, task: FlowTask, level: Nav['level'] = 'agent') {
  await ctx.updateFocused(() => detailKey(run.runId, task.label))
  await ctx.updateNav(n => ({ ...n, level, label: task.label, text: null }))
  const text = await ctx.loadResult(run, task)
  await ctx.updateNav(n => (n.runId === run.runId && n.label === task.label ? { ...n, text } : n))
}

// 左栏的运行或阶段上按 Enter：选中它，光标进右栏的第一个 agent
export async function openRun(ctx: ActionContext, r: FlowRun) {
  const at = await ctx.readNav()
  await selectPhase(ctx, r, at.runId === r.runId && at.phase ? at.phase : defaultPhase(r))
}

export async function selectPhase(ctx: ActionContext, run: FlowRun, title: string | null) {
  const first = tasksOf(run, title)[0]
  await moveTo(ctx, { runId: run.runId, level: 'agents' as const, phase: title, label: null, text: null })
  // 竖排版面里单发 agent 的页面直接画它的结果：不分层，label 只用来读结果文本；页面上没有 agent 行可以聚焦，光标落到返回键
  if (ctx.vertical && run.kind === 'single' && first) {
    await showAgent(ctx, run, first, 'agents')
    await ctx.focusOn('back')
  } else if (first && ctx.windowSize.agents > 0) await ctx.focusOn(taskKey(run.runId, first.label))
}

export async function selectAgent(ctx: ActionContext, run: FlowRun, t: FlowTask) {
  await showAgent(ctx, run, t)
  // 竖排版面的详情页没有 agent 列表，光标落到返回键
  await ctx.focusOn(ctx.vertical ? 'back' : detailKey(run.runId, t.label))
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


// 翻页提示画在下边线上，按树序不在栏的上下两端；光标从一栏可见的最后一项往外走、下面还有时改成往下翻一项，
// 从可见的第一项往外走、上面还有时往上翻。只有一项可见时按落点分方向：左栏落到右栏、右栏落到左栏以外的都算往下。
export async function pageRedirect(ctx: ActionContext, from: string | null, to: string) {
  if (!from) return null
  const at = await ctx.readNav()
  const list = await listed(ctx)
  const windows = await ctx.readWindows()
  for (const column of Object.keys(ctx.emptyWindows) as WindowColumn[]) {
    if (ctx.windowSize[column] <= 0) continue
    const keys = columnKeys(list, at, column, ctx.vertical)
    const index = keys.indexOf(from)
    if (index < 0 || keys.includes(to)) continue
    // 竖排版面里展开阶段的 agent 紧接在它的阶段行下面，从阶段行往下走进 agent 不是翻页
    if (ctx.vertical && column === 'left' && columnKeys(list, at, 'agents', true).includes(to)) return null
    const start = windowStart(windows[column], keys.length, ctx.windowSize[column])
    const last = Math.min(keys.length, start + ctx.windowSize[column]) - 1
    const below = index === last && last < keys.length - 1
    const above = index === start && start > 0
    if (!below && !above) return null
    // 竖排版面：agent 之前只有它自己的阶段行（及更上面的阶段）；往这些走是往上翻，其余（后面的阶段、翻页键、按钮）是往下翻
    const left = columnKeys(list, at, 'left', ctx.vertical)
    const next = ctx.vertical && column === 'agents' ? !(left.includes(to) && left.indexOf(to) <= left.indexOf(verticalLeft(list, at).selected ?? '')) : column === 'agents' ? !left.includes(to) : column === 'left' ? columnKeys(list, at, 'agents', ctx.vertical).includes(to) || to.startsWith('more:left:') : to.startsWith('steer:') || to.startsWith(`more:${column}:`)
    const direction = below && (!above || next) ? 'down' : 'up'
    const key = `more:${column}:${direction}`
    // 提示放不下或没有边线时，直接翻页，交给引擎聚焦新画出的条目。
    return ctx.pagerKeys.has(key) ? key : await shiftWindow(ctx, column, direction, false) ?? null
  }
  return null
}
