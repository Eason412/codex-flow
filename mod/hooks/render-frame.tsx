// 面板尺寸、翻页提示、状态标记与外框；只用传入的组件和回调构建视图。
import type { Elements, RenderElement } from 'claude-code'
import type { FlowRun, FlowTask, Nav, WindowColumn, WindowStarts } from '../types'
import { BLUE, YELLOW, FAST, cells, fit, glyph, tasksOf } from './format'
import { defaultPhase, windowStart } from './navigation'

// 列表、两栏和详情固定占同样高度；输入框上方放不下时按实际可用行数画。
const PANEL_ROWS = 16

export type Part = { text: string; color?: string }
export type Head = { name: string; color: string; sub: string; right?: string; parts?: Part[] }
export type Foot = { hints: string[]; stop: string | null; canBack: boolean; back?: string; toList?: boolean }
export type ViewContext = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  Input: Elements['terminal']['Input'] | null
  at: Nav
  hot: string | null
  spinner: string | undefined
  agentSpinner: string | undefined
  round: number
  canHide: boolean
  columns: number
  rows: number
  bodyRows: number
  framed: boolean
  shelled: boolean
  showTitle: boolean
  starts: WindowStarts
  size: number
  shownRuns: FlowRun[]
  callbacks: {
    shiftWindow: (column: WindowColumn, direction: 'up' | 'down') => Promise<void>
    pressStop: () => Promise<void>
    goBack: () => Promise<void>
    goList: () => Promise<void>
    pressHide: () => Promise<void>
    openRun: (run: FlowRun) => Promise<void>
    selectPhase: (run: FlowRun, phase: string) => Promise<void>
    selectAgent: (run: FlowRun, task: FlowTask) => Promise<void>
    selectDetail: (run: FlowRun, task: FlowTask) => Promise<void>
    clearSteerFocus: (steer: boolean) => void
    sendSteer: (runId: string, label: string, value: string) => void
  }
}

export function panelDimensions(bodyColumns: number | undefined, maxRows: number | undefined, run: FlowRun | undefined, at: Nav) {
  // 整块最宽 100 列，右边留 4 列给引擎的折叠按钮 [-]
  const bandColumns = Math.min(100, Math.max(40, (bodyColumns || 104) - 4))
  const bandRows = Math.max(0, Math.floor(maxRows ?? 20))
  // 外框的上边写标题、下边放页脚，不另占行：输入框草稿变长、这块区域变矮时外框仍在。
  // 三行起画外框；只剩两行时一行标题一行内容，一行时只有内容
  const panelRows = Math.min(bandRows, PANEL_ROWS)
  const shelled = panelRows >= 3
  const showTitle = panelRows >= 2
  // 宽度同样固定：各层都占满可用宽度（最宽 100 列）
  const columns = bandColumns - (shelled ? 4 : 0)
  const rows = panelRows - (shelled ? 2 : Number(showTitle))
  // flow 两栏的内框（栏标题和底线）占两行，放得下最多三行内容才画；高度不够时先省内框，外框保留
  const needRows = run?.kind === 'flow' && at.level
    ? (at.level === 'agent' ? 12 : Math.min(12, Math.max(run.phases.length, tasksOf(run, at.phase ?? defaultPhase(run)).length)))
    : 0
  const framed = needRows > 0 && rows >= 2 + Math.min(needRows, 3)
  const bodyRows = Math.max(1, rows - (framed ? 2 : 0))
  const windowSize = Math.min(12, Math.max(1, bodyRows - 2))
  const size = windowSize

  return { bandRows, columns, rows, bodyRows, framed, shelled, showTitle, size }
}

export function windowed<T>(ctx: ViewContext, items: T[], column: WindowColumn, keyOf: (item: T) => string, preferred: string | null) {
  const { bodyRows, starts, size } = ctx
  // 放得下（且不超过 12 项）就全部显示；否则分窗口，留两行给「还有 N 个」
  const fit = items.length <= Math.min(bodyRows, 12) ? items.length : size
  const start = windowStart(starts[column], items.length, fit, preferred ? items.findIndex(item => keyOf(item) === preferred) : -1)
  return { items: items.slice(start, start + fit), start, before: start, after: Math.max(0, items.length - start - fit) }
}
function moreRow(ctx: ViewContext, column: WindowColumn, direction: 'up' | 'down', count: number, interactive: boolean, compact = false) {
  const { Text, Button, callbacks } = ctx
  const arrow = direction === 'up' ? '↑' : '↓'
  const label = compact ? `${arrow} ${count}` : `${arrow} 还有 ${count} 个`
  return interactive ? <Button plain dimColor key={`more:${column}:${direction}`} label={label} onPress={() => callbacks.shiftWindow(column, direction)} /> : <Text dimColor wrap="truncate-end">{label}</Text>
}
export function withMore(ctx: ViewContext, items: RenderElement[], column: WindowColumn, win: { before: number; after: number }, interactive: boolean) {
  const { Box, Text, bodyRows } = ctx
  const above = win.before ? moreRow(ctx, column, 'up', win.before, interactive) : null
  const below = win.after ? moreRow(ctx, column, 'down', win.after, interactive) : null
  const room = bodyRows - items.length
  if (room <= 0) return items
  // 只剩一行提示空间时，上下按钮放在同一行，仍可往两个方向翻页。
  if (room === 1 && above && below) return [...items, <Box>
    {moreRow(ctx, column, 'up', win.before, interactive, true)}<Text dimColor> · </Text>{moreRow(ctx, column, 'down', win.after, interactive, true)}
  </Box>]
  return [...(above ? [above] : []), ...items, ...(below ? [below] : [])]
}
// 暗色文字里的闪电单独画成黄色
export function dimFast(ctx: ViewContext, text: string) {
  const { Text } = ctx
  return text.split(FAST).flatMap((part, i) => [
    ...(i ? [<Text color={YELLOW}>{FAST}</Text>] : []),
    ...(part ? [<Text dimColor>{part}</Text>] : []),
  ])
}

// spin：运行中用的标记，默认是 agent 的细点阵
export function mark(ctx: ViewContext, status: string, spin = ctx.agentSpinner) {
  const { Text } = ctx
  if (status === 'running') return <Text color={BLUE}>{spin}</Text>
  const [g, color] = glyph(status)
  return (
    <Text color={color} dimColor={!color}>
      {g}
    </Text>
  )
}
export function drawParts(ctx: ViewContext, parts: Part[]) {
  const { Text } = ctx
  return parts.map(p => <Text color={p.color} dimColor={!p.color}>{p.text}</Text>)
}

const buttonCells = (label: string) => 3 + cells(label)

function buttonsOf(ctx: ViewContext, foot: Foot) {
  const { canHide } = ctx
  return [foot.stop, foot.canBack ? foot.back ?? '返回' : null, canHide ? '关闭' : null].filter((b): b is string => !!b)
}

function buttonsWidth(ctx: ViewContext, foot: Foot) {
  const buttons = buttonsOf(ctx, foot)
  return buttons.reduce((sum, b) => sum + buttonCells(b), 0) + Math.max(0, buttons.length - 1) * 3
}
export function footerCells(ctx: ViewContext, foot: Foot) {
  const buttons = buttonsOf(ctx, foot)
  return (foot.hints.length ? cells(foot.hints.join(' · ')) + (buttons.length ? 3 : 0) : 0) + buttonsWidth(ctx, foot)
}
// 页脚：提示文字在前（放不下就截短或省掉），停止、返回、关闭按钮在后
function footer(ctx: ViewContext, foot: Foot, width: number) {
  const { Text } = ctx
  const buttons = buttonNodes(ctx, foot)
  let sep = buttons.length && foot.hints.length ? ' · ' : ''
  const room = width - buttonsWidth(ctx, foot) - cells(sep)
  let hint = foot.hints.join(' · ')
  if (cells(hint) > room) hint = room >= 6 ? fit(hint, room) : ''
  if (!hint) sep = ''
  const nodes: RenderElement[] = []
  if (hint) nodes.push(<Text dimColor>{hint}{sep}</Text>)
  buttons.forEach((node, i) => {
    if (i) nodes.push(<Text dimColor> · </Text>)
    nodes.push(node)
  })
  return { width: cells(hint) + cells(sep) + buttonsWidth(ctx, foot), nodes }
}
function buttonNodes(ctx: ViewContext, foot: Foot) {
  const { Button, canHide, callbacks } = ctx

  const nodes: RenderElement[] = []
  if (foot.stop) nodes.push(<Button plain hotkey="x" key="stop" label={foot.stop} onPress={() => callbacks.pressStop()} />)
  if (foot.canBack) nodes.push(<Button plain hotkey="b" key="back" label={foot.back ?? '返回'} onPress={() => (foot.toList ? callbacks.goList() : callbacks.goBack())} />)
  if (canHide) nodes.push(<Button plain hotkey="q" key="hide" label="关闭" onPress={() => callbacks.pressHide()} />)
  return nodes
}
// 外框：╭─ 名称  状态 ──── token · 时长 ─╮ … ╰─ 提示 · 按钮 ────╯，总宽 width + 4。
// body 有 height 行，不足 rows 的用空行补齐（fixed=false 时不补），两侧竖线按补齐后的行数画成两列。
export function shell(ctx: ViewContext, color: string, width: number, head: Head, body: RenderElement, height: number, foot: Foot, fixed = true) {
  const { Box, Text, rows, shelled } = ctx
  const pad = fixed ? Math.max(0, rows - height) : 0
  const filler = Array.from({ length: pad }, () => <Text> </Text>)
  if (!shelled) return bareShell(ctx, width, head, body, filler)
  const name = fit(head.name, Math.max(4, width - 4))
  let right = head.right ? ` ${head.right} ` : ''
  if (width - 3 - cells(name) - cells(right) < 0) right = ''
  const subRoom = width - 3 - cells(name) - cells(right)
  const sub = head.sub && subRoom >= 6 ? `  ${fit(head.sub, subRoom - 2)}` : ''
  const topDash = Math.max(1, width - 2 - cells(name) - cells(sub) - cells(right))
  const bottom = footer(ctx, foot, width - 2)
  const side = (text: string) => <Box flexDirection="column">{Array.from({ length: height + pad }, () => <Text color={color}>{text}</Text>)}</Box>
  return (
    <Box flexDirection="column" width={width + 4}>
      <Box>
        <Text color={color}>╭─ </Text>
        <Text bold color={head.color}>{name}</Text>
        {sub && head.parts && sub === `  ${head.sub}` ? drawParts(ctx, [{ text: '  ' }, ...head.parts]) : sub ? dimFast(ctx, sub) : null}
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

function bareShell(ctx: ViewContext, width: number, head: Head, body: RenderElement, filler: RenderElement[]) {
  const { Box, Text, showTitle } = ctx
  return (
    <Box flexDirection="column" width={width}>
      {showTitle && <Box width={width}>
        <Text bold color={head.color} wrap="truncate-end">{head.name}</Text>
        {head.parts && cells(head.name) + cells(`  ${[head.sub, head.right].filter(Boolean).join(' · ')}`) <= width
          ? drawParts(ctx, [{ text: '  ' }, ...head.parts, ...(head.right ? [{ text: ` · ${head.right}` }] : [])])
          : dimFast(ctx, fit(`  ${[head.sub, head.right].filter(Boolean).join(' · ')}`, Math.max(1, width - cells(head.name))))}
      </Box>}
      {body}
      {filler}
    </Box>
  )
}
