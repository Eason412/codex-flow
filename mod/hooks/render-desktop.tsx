// 非终端（桌面端等）的竖排版面，照原生 Workflow 的结构：顶部一行名字与统计，下面一个 flow 的阶段竖排，
// 展开的阶段整块淡底、缩进列出它的 agent；点 agent 进详情。比例字体下字符画的框线和补空格都对不齐，
// 所以不画框、不补空格：各段放进用 ch 定宽的 Box 对齐，状态用 Svg 小方块，按钮在最下一行靠右。
// 四种页面：list（几个任务同时列出）、flow、single（单发 agent）、detail（flow 里某个 agent 的结果）。
import type { RenderElement } from 'claude-code'
import type { FlowRun, FlowTask } from '../types'
import type { VerticalView } from './navigation'
import { BOLT_SVG, CHECK_SVG, FAIL, GRID_MAX, LINE, MUTED, STEP, TIME_SLOT, WORD, cells, fit, formatDuration, formatTokens, gridSvg, modelPlain, shortError, squareSvg, statsTotal, tasksOf, tokensOf, wrap } from './format'
import { defaultPhase, faded, phaseKey, runKey, taskKey, up, verticalView } from './navigation'
import type { Pager, ViewContext } from './render-frame'
import { pagerNodes, pagerOf, text, windowed } from './render-frame'

// 颜色：暗灰（统计、模型、箭头、说明）用 subtle，次要文字（没展开的阶段名、已结束的 agent 名）用 inactive
const DIM = LINE
const SECOND = MUTED
// 展开的阶段整块的底色：半透明灰，深浅主题下都淡
const OPEN_BG = 'rgba(127,127,127,0.08)'
// 整块左右各留 1 列，淡底的块和文字之间不贴边；各行的内宽是面板宽度减去两侧
const PAD = 1
const innerWidth = (ctx: ViewContext) => ctx.width - PAD * 2
// 结果最多显示的行数
const RESULT_LINES = 4

type Sizes = { left: number; agents: number; detailAgents: number }
type Drawn = { tree: RenderElement; sizes: Sizes }

// ---- 小零件 ----

// 状态标记：完成是灰色勾，运行中是呼吸的蓝块（要 isInteractive 才播放动画），失败红块，等待空心框；放进 2 列宽的格子里居中
function mark(ctx: ViewContext, status: string) {
  const { Box } = ctx
  const Svg = ctx.Svg!
  const done = status === 'completed'
  const size = done ? 10 : 8
  const source = done ? CHECK_SVG : squareSvg(status, size, ctx.breath)
  return (
    <Box width={2} flexShrink={0} alignItems="center">
      <Svg source={source} alt={WORD[status] ?? status} width={size} height={size} isInteractive={status === 'running' ? true : undefined} />
    </Box>
  )
}

// 一组 agent 的进度格；有运行中的才需要播放动画
function grid(ctx: ViewContext, statuses: string[]) {
  const { Svg } = ctx
  if (!Svg || !statuses.length) return null
  const g = gridSvg(statuses, ctx.breath)
  return <Svg source={g.source} alt={`${statuses.filter(s => s === 'completed').length}/${statuses.length} 完成`} width={g.width} height={6} isInteractive={g.live ? true : undefined} />
}

// 模型 effort（暗灰），Fast 的后面跟一个灰色小闪电；tail 是接在后面的文字
function model(ctx: ViewContext, t: FlowTask, tail: RenderElement[] = []) {
  const { Box, Svg } = ctx
  return (
    <Box alignItems="center" minWidth={0}>
      {text(ctx, modelPlain(t), DIM)}
      {t.fast && Svg ? <Box marginLeft={0.5} flexShrink={0}><Svg source={BOLT_SVG} alt="Fast" width={7} height={10} /></Box> : null}
      {tail}
    </Box>
  )
}

// 一行：整块内宽，各段垂直居中
// 行宽固定为内宽、缩进算在宽度里（Box 的 padding 不额外加宽），缩进的行才不会比别的行长
function line(ctx: ViewContext, parts: RenderElement[], gap = 1, indent = 0) {
  const { Box } = ctx
  return <Box width={innerWidth(ctx)} paddingLeft={indent} alignItems="center" columnGap={gap}>{parts}</Box>
}
// 可收缩的一段：名字、说明这类放不下就在末尾截断的内容
function grow(ctx: ViewContext, node: RenderElement | RenderElement[]) {
  const { Box } = ctx
  return <Box flexGrow={1} flexShrink={1} minWidth={0}>{node}</Box>
}
// 定宽靠右的一段：耗时
function time(ctx: ViewContext, seconds: string) {
  const { Box } = ctx
  return <Box width={TIME_SLOT} flexShrink={0} justifyContent="flex-end">{seconds ? text(ctx, seconds, DIM) : null}</Box>
}
const caret = (ctx: ViewContext, open: boolean) => {
  const { Box } = ctx
  return <Box width={2} flexShrink={0} justifyContent="center">{text(ctx, open ? '▾' : '▸', DIM)}</Box>
}
// 缩进的暗灰单行（任务说明、最近一步），放不下在末尾截断
function note(ctx: ViewContext, indent: number, value: string, color: string | undefined = DIM) {
  const { Box } = ctx
  return <Box width={innerWidth(ctx)} paddingLeft={indent}>{text(ctx, value || ' ', color)}</Box>
}

const taskTime = (t: FlowTask) => (t.reused || t.status === 'pending' || t.status === 'skipped' ? '' : formatDuration(t.seconds))

// 顶部：名字（默认文字色，粗体）在左，暗灰统计在右
function header(ctx: ViewContext, name: string, stats: string) {
  const { Box, Text } = ctx
  return (
    <Box width={innerWidth(ctx)} justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1} minWidth={0}><Text bold wrap="truncate-end">{name}</Text></Box>
      <Box flexShrink={0}>{text(ctx, stats, DIM)}</Box>
    </Box>
  )
}

// 最下一行：翻页提示在左，按钮靠右。光标按树序先走完内容、再到翻页键和按钮
function footer(ctx: ViewContext, view: VerticalView, pagers: { label: string; pager: Pager }[]) {
  const { Box, Button, callbacks, list, at, run } = ctx
  const buttons: RenderElement[] = []
  if (up(list, at, true)) buttons.push(<Button plain dimColor hotkey="b" key="back" label="返回" onPress={() => callbacks.goBack()} />)
  // 几个任务的列表里没有单一的停止对象，进了某个任务再停
  if (view !== 'list' && run?.status === 'running' && (view !== 'detail' || runningTask(ctx)))
    buttons.push(<Button plain dimColor hotkey="x" key="stop" label="停止" onPress={() => callbacks.pressStop()} />)
  if (ctx.canHide) buttons.push(<Button plain dimColor hotkey="q" key="hide" label="关闭" onPress={() => callbacks.pressHide()} />)
  const pageNodes = pagers.flatMap(p => [...(p.label ? [text(ctx, p.label, DIM)] : []), ...pagerNodes(ctx, p.pager).nodes])
  if (!buttons.length && !pageNodes.length) return null
  return (
    <Box width={innerWidth(ctx)} justifyContent="space-between" columnGap={2}>
      <Box alignItems="center" columnGap={1}>{pageNodes}</Box>
      <Box alignItems="center" columnGap={1}>{buttons}</Box>
    </Box>
  )
}
// 详情页的停止键只给还在跑的那个 agent
function runningTask(ctx: ViewContext) {
  const { run, at } = ctx
  return run?.tasks.find(t => t.label === at.label)?.status === 'running'
}

// 在跑时一行最近一步；结束后结果前几行加提示；失败写错误（最多几行，超出截断）
function progress(ctx: ViewContext, t: FlowTask, resultText: string | null, indent: number): RenderElement[] {
  const { Box } = ctx
  const inner = innerWidth(ctx) - indent
  // 每行包进自己的 Box：连续的 Text 里只要有一行像字符画，桌面会把整串换成等宽字体
  const lines = (value: string, color?: string) => {
    const all = wrap(value.trim(), inner).filter(l => l.trim())
    const cut = all.length > RESULT_LINES ? [...all.slice(0, RESULT_LINES - 1), `${fit(all[RESULT_LINES - 1]!, inner - 1)}…`] : all
    return cut.map(l => <Box width={innerWidth(ctx)} paddingLeft={indent}>{text(ctx, l, color)}</Box>)
  }
  if (t.status === 'running') {
    const last = t.recent.at(-1)
    if (t.checking) return [note(ctx, indent, '验收中：Codex 已结束，正在跑验收命令')]
    return last ? [note(ctx, indent, `${STEP[last.kind] ?? '·'} ${last.text.replace(/\s+/g, ' ')}`, last.status === 'failed' ? FAIL : DIM)] : []
  }
  if (t.error && t.status !== 'completed') return lines(t.error, FAIL)
  if (resultText) return [...lines(resultText), note(ctx, indent, '完整结果由 Claude 在对话里汇报')]
  return t.status === 'completed' ? [note(ctx, indent, '没有结果。')] : []
}

// 失败等结束状态写在模型后面：失败：原因（原因里已有「失败」就不重复）；已停止、已退出同样用红字
function endNote(t: FlowTask) {
  if (t.status === 'failed') {
    const checks = t.checks && t.checksPassed !== null ? `验收 ${t.checksPassed}/${t.checks} 未过` : ''
    const reason = (t.checkFailed && checks) || shortError(t.error) || '原因不明'
    return `· ${reason.includes('失败') ? reason : `失败：${reason}`}`
  }
  if (t.status === 'cancelled' || t.status === 'lost' || t.status === 'partial') return `· ${WORD[t.status]}`
  return ''
}

// 整块：每个页面各画自己的内容行（已按 maxRows 分好窗口、截好行），这里统一套上外层，左右各留 PAD 列
function shell(ctx: ViewContext, rows: (RenderElement | null)[], sizes: Sizes): Drawn {
  const { Box, width } = ctx
  return { tree: <Box flexDirection="column" width={width} paddingX={PAD}>{rows.filter((r): r is RenderElement => !!r)}</Box>, sizes }
}

// ---- 几个任务同时列出 ----

// 每个任务一行：类型小字、名字、agent 的模型、进度方块、耗时、箭头；按下进入该任务的页面
function drawList(ctx: ViewContext): Drawn {
  const { Box, Button, callbacks, list, run, starts, maxRows } = ctx
  const body = Math.max(1, maxRows - 2)
  const win = windowed(list, starts.left, body, list.findIndex(r => r === run))
  const modelWidth = Math.min(16, Math.max(0, ...list.filter(r => r.kind === 'single').map(r => cells(modelPlain(r.tasks[0]!)) + 2)))
  // 进度格按像素画，换算成列宽留出对齐用的格子（1 列约 7px）
  const gridWidth = Math.ceil(Math.max(...list.map(r => Math.min(r.tasks.length, GRID_MAX) * 8 - 2)) / 7) + 1
  const rows = win.items.map(r => {
    const t = r.tasks[0]
    const dim = faded(r) || (r.status !== 'running' && r !== run)
    return line(ctx, [
      <Box width={5} flexShrink={0}>{text(ctx, r.kind === 'flow' ? 'flow' : 'agent', DIM)}</Box>,
      grow(ctx, <Button plain key={runKey(r.runId)} label={fit(r.name, Math.max(4, ctx.width - 30))} dimColor={dim ? true : undefined} onPress={() => callbacks.openRun(r)} />),
      <Box width={modelWidth} flexShrink={0}>{r.kind === 'single' && t ? model(ctx, t) : null}</Box>,
      <Box width={gridWidth} flexShrink={0}>{grid(ctx, r.kind === 'flow' ? r.tasks.map(x => x.status) : [r.status])}</Box>,
      time(ctx, formatDuration(r.seconds)),
      caret(ctx, false),
    ])
  })
  const pager = pagerOf('left', win)
  return shell(ctx, [
    header(ctx, `Codex · ${list.length} 个任务`, statsTotal(list)),
    ...(maxRows >= 3 ? rows : []),
    maxRows >= 2 ? footer(ctx, 'list', pager ? [{ label: '', pager }] : []) : null,
  ], { left: body, agents: 1, detailAgents: 1 })
}

// ---- 一个 flow：阶段竖排，展开的阶段列出 agent ----

// 阶段与 agent 上下叠着共用 body 行：放得下全列；放不下时 agent 至少留一半，阶段占剩下的（至少一行）
export function splitRows(phases: number, agents: number, body: number) {
  if (phases + agents <= body) return { phases, agents }
  const a = agents ? Math.min(agents, Math.max(1, Math.floor(body / 2), body - phases)) : 0
  const p = Math.min(phases, Math.max(1, body - a))
  return { phases: p, agents: Math.max(0, Math.min(a, body - p)) }
}

function drawFlow(ctx: ViewContext, run: FlowRun): Drawn {
  const { Box, Button, callbacks, at, hot, starts, maxRows } = ctx
  const phase = at.phase ?? defaultPhase(run)
  const agents = tasksOf(run, phase)
  const body = Math.max(1, maxRows - 2)
  // 展开的阶段没有 agent 时也占一行说明
  const split = splitRows(run.phases.length, Math.max(1, agents.length), body)
  const phaseWin = windowed(run.phases, starts.left, split.phases, run.phases.findIndex(p => p.title === phase))
  const keys = agents.map(t => taskKey(run.runId, t.label))
  const preferred = at.level === 'agents' && hot && keys.includes(hot) ? keys.indexOf(hot) : agents.findIndex(t => t.status === 'running')
  const agentWin = windowed(agents, starts.agents, Math.max(1, split.agents), preferred)
  const agentItems = agentWin.items.slice(0, split.agents)

  // 列宽按这个 flow 的全部 agent 定，换阶段、翻页时不跳。名字格要给按钮自带的左右内边距留出约 4 列
  const avail = innerWidth(ctx) - 2 - 2 - TIME_SLOT
  const nameWidth = Math.min(Math.floor(avail * 0.45), Math.min(18, Math.max(4, ...run.tasks.map(t => cells(t.label)))) + 4)
  const modelWidth = Math.min(Math.floor(avail * 0.3), Math.max(4, ...run.tasks.map(t => cells(modelPlain(t)))) + 2)

  const agentRow = (t: FlowTask) => {
    const end = endNote(t)
    return line(ctx, [
      mark(ctx, t.status),
      <Box width={nameWidth} flexShrink={0}><Button plain key={taskKey(run.runId, t.label)} label={fit(t.label, nameWidth - 4)} dimColor={t.status === 'running' ? undefined : true} onPress={() => callbacks.selectAgent(run, t)} /></Box>,
      <Box width={modelWidth} flexShrink={0}>{model(ctx, t)}</Box>,
      grow(ctx, end ? text(ctx, end, t.status === 'cancelled' ? DIM : FAIL) : []),
      time(ctx, taskTime(t)),
    ], 0, 2)
  }
  const phaseRow = (p: FlowRun['phases'][number]) => {
    const open = p.title === phase
    const row = line(ctx, [
      grow(ctx, <Button plain key={phaseKey(p.title)} label={fit(p.title, Math.max(4, ctx.width - 20))} dimColor={open || p.status === 'running' ? undefined : true} onPress={() => callbacks.selectPhase(run, p.title)} />),
      grid(ctx, tasksOf(run, p.title).map(t => t.status)) ?? <Box />,
      caret(ctx, open),
    ])
    if (!open) return row
    // 展开的阶段：阶段行加缩进的 agent 行，整块淡底，左右伸到 PAD 之外
    return (
      <Box flexDirection="column" width={ctx.width} marginX={-PAD} paddingX={PAD} backgroundColor={OPEN_BG}>
        {row}
        {agents.length ? agentItems.map(agentRow) : [note(ctx, 2, '这个阶段没有 agent', SECOND)]}
      </Box>
    )
  }
  const phasePager = pagerOf('left', phaseWin)
  const agentPager = pagerOf('agents', agentWin)
  return shell(ctx, [
    header(ctx, run.name, statsTotal([run])),
    ...(maxRows >= 3 ? (run.phases.length ? phaseWin.items.map(phaseRow) : [note(ctx, 0, '还没有阶段', SECOND)]) : []),
    maxRows >= 2 ? footer(ctx, 'flow', [...(phasePager ? [{ label: '阶段 ', pager: phasePager }] : []), ...(agentPager ? [{ label: 'agent ', pager: agentPager }] : [])]) : null,
  ], { left: split.phases, agents: Math.max(1, split.agents), detailAgents: 1 })
}

// ---- agent 详情与单发 agent ----

// 详情里结束状态的说明：已停止、已退出等写状态词；失败且有错误时由 progress 画错误，没有记录原因才在这里写
function stateNote(ctx: ViewContext, t: FlowTask, indent: number) {
  const bad = t.status === 'failed' ? !t.error : t.status === 'cancelled' || t.status === 'lost' || t.status === 'partial'
  return bad ? [note(ctx, indent, endNote(t).replace(/^· /, ''), t.status === 'cancelled' ? DIM : FAIL)] : []
}

// 详情：标记、阶段 ›、名字、模型 · token、耗时；缩进的任务说明；运行中一行最近一步，结束后结果前几行
function drawDetail(ctx: ViewContext, run: FlowRun, t: FlowTask): Drawn {
  const { Box, at, maxRows } = ctx
  const phase = at.phase ?? defaultPhase(run)
  const tok = t.tokens ? ` · ${formatTokens(t.tokens)} tok` : ''
  const rows = [
    line(ctx, [
      mark(ctx, t.status),
      text(ctx, `${phase ?? ''} ›`, DIM),
      <Box flexShrink={0}>{text(ctx, fit(t.label, 24))}</Box>,
      grow(ctx, model(ctx, t, tok ? [text(ctx, tok, DIM)] : [])),
      time(ctx, taskTime(t)),
    ]),
    ...(t.brief ? [note(ctx, 3, t.brief)] : []),
    ...stateNote(ctx, t, 3),
    ...progress(ctx, t, at.text, 3),
  ]
  return shell(ctx, [
    header(ctx, run.name, statsTotal([run])),
    ...(maxRows >= 3 ? rows.slice(0, maxRows - 2) : []),
    maxRows >= 2 ? footer(ctx, 'detail', []) : null,
  ], { left: 1, agents: 1, detailAgents: 1 })
}

// 单发 agent：标记、名字（粗体）、右侧 token · 耗时；下面缩进模型、任务说明、最近一步或结果
function drawSingle(ctx: ViewContext, run: FlowRun): Drawn {
  const { Box, Text, at, maxRows } = ctx
  const t = run.tasks[0]
  const sizes = { left: 1, agents: 1, detailAgents: 1 }
  if (!t) return shell(ctx, [header(ctx, run.name, statsTotal([run]))], sizes)
  const tok = tokensOf([t])
  const stats = [tok ? `${formatTokens(tok)} tok` : '', formatDuration(run.seconds)].filter(Boolean).join(' · ')
  const end = endNote(t)
  const rows = [
    line(ctx, [
      mark(ctx, t.status),
      grow(ctx, <Text bold wrap="truncate-end">{run.name}</Text>),
      <Box flexShrink={0}>{text(ctx, stats, DIM)}</Box>,
    ]),
    <Box width={innerWidth(ctx)} paddingLeft={3}>{model(ctx, t, end ? [text(ctx, ` ${end}`, t.status === 'cancelled' ? DIM : FAIL)] : [])}</Box>,
    ...(t.brief ? [note(ctx, 3, t.brief)] : []),
    ...progress(ctx, t, at.text, 3),
  ]
  return shell(ctx, [...rows.slice(0, Math.max(1, maxRows - 1)), maxRows >= 2 ? footer(ctx, 'single', []) : null], sizes)
}

// ---- 入口 ----

export function drawVertical(ctx: ViewContext): Drawn {
  const { list, run, at } = ctx
  ctx.callbacks.clearSteerFocus(false)
  const view = verticalView(list, at)
  if (view === 'list' || !run) return drawList(ctx)
  if (view === 'single') return drawSingle(ctx, run)
  const t = view === 'detail' ? run.tasks.find(x => x.label === at.label) : undefined
  return t ? drawDetail(ctx, run, t) : drawFlow(ctx, run)
}
