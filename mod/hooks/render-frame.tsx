// 终端面板的版面：顶部两行文字，下面分左右两栏，两栏外是一层字符画的细框，栏标题嵌在上边线、按键提示与翻页提示在下边线。
// 非终端（桌面端等）用比例字体画字，字符画的框线和补空格都对不齐，另走竖排版面，见 render-desktop.tsx。
// 只用传入的组件和回调构建视图。
import type { Elements, RenderElement, RenderSurface } from 'claude-code'
import type { FlowRun, FlowTask, Nav, WindowColumn, WindowStarts } from '../types'
import { ACCENT, LINE, MUTED, cells, fit } from './format'

// 两栏视图框内最多 4 行，超出翻页；详情页的说明和结果多，最多 12 行
export const BODY_CAP = 4
export const DETAIL_CAP = 12

export type ViewContext = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & {
  surface: RenderSurface
  Input: Elements['terminal']['Input'] | null
  // 终端没有 Svg，状态画成字符；其余 surface 走竖排版面，用 Svg 画小方块，breath 是运行中小方块呼吸动画的当前进度（秒）
  Svg: Elements['desktop']['Svg'] | null
  breath: number
  // 面板列出的运行和选中的那个（nav 指向的运行不在列表里时按打开面板的规则选）
  list: FlowRun[]
  run: FlowRun | undefined
  at: Nav
  hot: string | null
  spinner: string | undefined
  agentSpinner: string | undefined
  round: number
  // 收起键的文字：有任务在跑时叫「收起」（任务照常跑，/flow 再打开），都结束了叫「关闭」
  hideLabel: string
  width: number
  maxRows: number
  starts: WindowStarts
  callbacks: {
    shiftWindow: (column: WindowColumn, direction: 'up' | 'down') => Promise<void>
    pressStop: () => Promise<void>
    goBack: () => Promise<void>
    pressHide: () => Promise<void>
    openRun: (run: FlowRun) => Promise<void>
    selectPhase: (run: FlowRun, phase: string) => Promise<void>
    selectAgent: (run: FlowRun, task: FlowTask) => Promise<void>
    selectDetail: (run: FlowRun, task: FlowTask) => Promise<void>
    clearSteerFocus: (steer: boolean) => void
    sendSteer: (runId: string, label: string, value: string) => void
    pagerVisible: (key: string) => void
  }
}

// 竖排版面：非终端且有 Svg 可用；否则（含终端）走字符画的两栏版面
export const isVertical = (ctx: Pick<ViewContext, 'surface' | 'Svg'>) => ctx.surface !== 'terminal' && !!ctx.Svg

export type Layout = { headRows: number; framed: boolean; body: number }
export type Pager = { column: WindowColumn; start: number; shown: number; total: number }
export type Column = { title: string; width: number; rows: RenderElement[]; pager: Pager | null }
export type Head = { name: string; brief: string; stats: string }
export type Foot = { hints: string[]; stop: string | null; back: boolean }

// 整块最宽 100 列，右边留 4 列给引擎的折叠按钮 [-]
export const panelWidth = (bodyColumns: number | undefined) => Math.min(100, Math.max(40, (bodyColumns || 104) - 4))

// 高度随内容：顶部两行 + 上下边线 + 框内 need 行（不超过 cap）。输入框上方放不下时依次省第二行文字、边线，
// 只剩一行时只画名字和统计
export function layout(ctx: Pick<ViewContext, 'maxRows'>, need: number, cap: number): Layout {
  const rows = Math.max(0, Math.floor(ctx.maxRows))
  const headRows = rows >= 5 ? 2 : rows >= 1 ? 1 : 0
  const framed = rows >= 4
  const body = Math.max(0, Math.min(Math.max(1, need), cap, rows - headRows - (framed ? 2 : 0)))
  return { headRows, framed: framed && body > 0, body }
}

// 窗口：放得下就全列，否则从 start 起取 size 项，保证 preferred 在里面
export function windowed<T>(items: T[], start: number, size: number, preferred: number) {
  const fitSize = Math.max(1, Math.min(items.length, size))
  let s = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, items.length - fitSize))
  if (preferred >= 0 && preferred < s) s = preferred
  if (preferred >= s + fitSize) s = preferred - fitSize + 1
  return { items: items.slice(s, s + fitSize), start: s, total: items.length, shown: Math.min(fitSize, items.length) }
}
export const pagerOf = (column: WindowColumn, win: { start: number; shown: number; total: number }): Pager | null =>
  win.total > win.shown ? { column, start: win.start, shown: win.shown, total: win.total } : null

// 一行：按顺序放各段，宽度固定，不随内容跳
export function row(ctx: ViewContext, width: number, parts: RenderElement[]) {
  const { Box } = ctx
  return <Box width={width}>{parts}</Box>
}
export const text = (ctx: ViewContext, value: string, color?: string) => {
  const { Text } = ctx
  return <Text color={color} wrap="truncate-end">{value}</Text>
}
// 定宽的一段：各列靠固定宽度对齐，不靠补空格（比例字体下空格和字宽不等）；end 时内容靠右
export function cell(ctx: ViewContext, width: number, node: RenderElement | RenderElement[], end?: boolean) {
  const { Box } = ctx
  return <Box width={Math.max(0, width)} flexShrink={0} justifyContent={end ? 'flex-end' : undefined}>{node}</Box>
}
export const space = (ctx: ViewContext, n: number) => text(ctx, ' '.repeat(Math.max(0, n)))

export function pagerNodes(ctx: ViewContext, pager: Pager) {
  const { Button, callbacks } = ctx
  const label = `${pager.start + 1}–${pager.start + pager.shown} of ${pager.total} `
  const up = pager.start > 0
  const down = pager.start + pager.shown < pager.total
  const nodes: RenderElement[] = [text(ctx, label, MUTED)]
  if (up) {
    callbacks.pagerVisible(`more:${pager.column}:up`)
    nodes.push(<Button plain dimColor key={`more:${pager.column}:up`} label="↑" onPress={() => callbacks.shiftWindow(pager.column, 'up')} />)
  }
  if (down) {
    callbacks.pagerVisible(`more:${pager.column}:down`)
    nodes.push(<Button plain dimColor key={`more:${pager.column}:down`} label="↓" onPress={() => callbacks.shiftWindow(pager.column, 'down')} />)
  }
  return { nodes, width: cells(label) + Number(up) + Number(down) }
}

const pagerCells = (pager: Pager) => cells(`${pager.start + 1}–${pager.start + pager.shown} of ${pager.total} `) + Number(pager.start > 0) + Number(pager.start + pager.shown < pager.total)

// 按钮画成「x: 停止」：hotkey、冒号、空格，再是文字
const buttonCells = (label: string) => 3 + cells(label)
// 下边线上的按键提示：提示文字在前（放不下就截短或省掉），停止、返回、关闭按钮在后，都是暗灰
function footer(ctx: ViewContext, foot: Foot, room: number) {
  const { Button, callbacks } = ctx
  let stop = foot.stop
  let hide = true
  const labelsOf = () => [stop, foot.back ? '返回' : null, hide ? ctx.hideLabel : null].filter((b): b is string => !!b)
  const widthOf = () => labelsOf().reduce((sum, b) => sum + buttonCells(b), 0) + Math.max(0, labelsOf().length - 1) * 3
  // 窄栏先缩短停止标签，再省收起键；返回与停止优先保留。
  if (widthOf() > room && stop) stop = '停止'
  if (widthOf() > room && hide) hide = false
  const labels = labelsOf()
  const buttonsWidth = widthOf()
  if (buttonsWidth > room) return { nodes: [] as RenderElement[], width: 0 }
  let hint = foot.hints.join(' · ')
  const sep = labels.length ? 3 : 0
  if (cells(hint) + sep > room - buttonsWidth) hint = room - buttonsWidth - sep >= 6 ? fit(hint, room - buttonsWidth - sep) : ''
  const nodes: RenderElement[] = []
  if (hint) nodes.push(text(ctx, `${hint}${labels.length ? ' · ' : ''}`, MUTED))
  const buttons: RenderElement[] = []
  if (stop) buttons.push(<Button plain dimColor hotkey="x" key="stop" label={stop} onPress={() => callbacks.pressStop()} />)
  if (foot.back) buttons.push(<Button plain dimColor hotkey="b" key="back" label="返回" onPress={() => callbacks.goBack()} />)
  if (hide) buttons.push(<Button plain dimColor hotkey="q" key="hide" label={ctx.hideLabel} onPress={() => callbacks.pressHide()} />)
  buttons.forEach((node, i) => {
    if (i) nodes.push(text(ctx, ' · ', MUTED))
    nodes.push(node)
  })
  return { nodes, width: (hint ? cells(hint) + sep : 0) + buttonsWidth }
}

// 顶部：第一行名字（紫色粗体）；第二行左边暗灰说明、右边暗灰统计。只有一行时名字和统计同一行
function header(ctx: ViewContext, head: Head, lay: Layout) {
  const { Box, Text, width } = ctx
  if (!lay.headRows) return []
  const stats = cells(head.stats) + 2 <= width ? head.stats : ''
  if (lay.headRows === 1) {
    const name = fit(head.name, Math.max(1, width - (stats ? cells(stats) + 2 : 0)))
    return [<Box width={width} justifyContent="space-between"><Text bold color={ACCENT} wrap="truncate-end">{name}</Text>{text(ctx, stats, MUTED)}</Box>]
  }
  const brief = fit(head.brief, Math.max(0, width - (stats ? cells(stats) + 2 : 0)))
  return [
    <Box width={width}><Text bold color={ACCENT} wrap="truncate-end">{fit(head.name, width)}</Text></Box>,
    <Box width={width} justifyContent="space-between">{text(ctx, brief, MUTED)}{text(ctx, stats, MUTED)}</Box>,
  ]
}

function topBorder(ctx: ViewContext, left: Column, right: Column) {
  const { Box } = ctx
  const seg = (w: number, title: string) => {
    const t = fit(title, Math.max(0, w - 3))
    return [text(ctx, ' '), text(ctx, t), text(ctx, ` ${'─'.repeat(Math.max(0, w - 2 - cells(t)))}`, LINE)]
  }
  return <Box>{text(ctx, '╭', LINE)}{seg(left.width + 2, left.title)}{text(ctx, '┬', LINE)}{seg(right.width + 2, right.title)}{text(ctx, '╮', LINE)}</Box>
}

// 下边线：左段右侧放左栏翻页；右段左侧放按键提示，右侧放右栏翻页（1–3 of 5 ↓）
function bottomBorder(ctx: ViewContext, left: Column, right: Column, foot: Foot) {
  const { Box } = ctx
  const rw = right.width + 2
  let rp = right.pager
  let pagerWidth = rp ? pagerCells(rp) + 2 : 0
  let foot2 = footer(ctx, foot, rw - pagerWidth - 4)
  if (!foot2.width && (foot.stop || foot.back || ctx.hideLabel)) {
    // 右栏放不下按钮时先省右栏翻页提示；仍放不下就用整条下边线。
    rp = null
    pagerWidth = 0
    foot2 = footer(ctx, foot, rw - 4)
    if (!foot2.width) {
      const full = footer(ctx, foot, ctx.width - 4)
      return <Box>{text(ctx, '╰─ ', LINE)}{full.nodes}{text(ctx, `${'─'.repeat(Math.max(0, ctx.width - full.width - 4))}╯`, LINE)}</Box>
    }
  }
  const nodes: RenderElement[] = [text(ctx, '╰', LINE)]
  const lw = left.width + 2
  const lp = left.pager && pagerCells(left.pager) + 3 <= lw ? pagerNodes(ctx, left.pager) : null
  if (lp) nodes.push(text(ctx, `${'─'.repeat(lw - lp.width - 2)} `, LINE), ...lp.nodes, text(ctx, ' '))
  else nodes.push(text(ctx, '─'.repeat(lw), LINE))
  nodes.push(text(ctx, '┴', LINE))
  let used = 0
  if (foot2.width) {
    nodes.push(text(ctx, '─ ', LINE), ...foot2.nodes, text(ctx, ' '))
    used += foot2.width + 3
  }
  nodes.push(text(ctx, '─'.repeat(Math.max(1, rw - used - pagerWidth)), LINE))
  if (rp) nodes.push(text(ctx, ' '), ...pagerNodes(ctx, rp).nodes, text(ctx, ' '))
  nodes.push(text(ctx, '╯', LINE))
  return <Box>{nodes}</Box>
}

// 整块面板。两栏各是一列（竖排的 Box）：光标按树序先走完左栏再到右栏，然后是下边线上的翻页和按钮
export function panel(ctx: ViewContext, head: Head, lay: Layout, left: Column, right: Column, foot: Foot) {
  const { Box, width } = ctx
  const rows = header(ctx, head, lay)
  if (lay.body > 0) {
    const fill = (items: RenderElement[], w: number) => [...items.slice(0, lay.body), ...Array.from({ length: Math.max(0, lay.body - items.length) }, () => <Box width={w}>{space(ctx, w)}</Box>)]
    const bar = (value: string) => <Box flexDirection="column">{Array.from({ length: lay.body }, () => text(ctx, value, LINE))}</Box>
    if (lay.framed) rows.push(topBorder(ctx, left, right))
    rows.push(
      <Box>
        {lay.framed ? bar('│ ') : null}
        <Box flexDirection="column" width={left.width}>{fill(left.rows, left.width)}</Box>
        {bar(' │ ')}
        <Box flexDirection="column" width={right.width}>{fill(right.rows, right.width)}</Box>
        {lay.framed ? bar(' │') : null}
      </Box>,
    )
    if (lay.framed) rows.push(bottomBorder(ctx, left, right, foot))
  }
  return <Box flexDirection="column" width={width}>{rows}</Box>
}

// 两栏的宽度：左栏按内容定宽，右栏吃掉剩下的，整块始终占满面板
export function columnWidths(ctx: ViewContext, lay: Layout, leftWant: number) {
  const leftWidth = Math.max(8, Math.min(leftWant, 32, Math.floor(ctx.width * 0.4)))
  const chrome = lay.framed ? 7 : 3
  return { leftWidth, rightWidth: Math.max(8, ctx.width - leftWidth - chrome) }
}
