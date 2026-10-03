// 任务列表和低高度的一行列表；类型、统计和可进入的名称保持原样。
import type { RenderElement } from 'claude-code'
import type { FlowRun } from '../types'
import { CYAN, BLUE, PURPLE, KIND, WORD, cells, fit, formatDuration, formatTokens, doneOf, tokensOf, livePhases, agentStats } from './format'
import { faded, runKey } from './navigation'
import type { ViewContext, Part, Foot } from './render-frame'
import { windowed, withMore, dimFast, mark, drawParts, footerCells, shell } from './render-frame'

type RunListContext = ViewContext & {
  cur: FlowRun[]
  nameWidth: number
  statsWidth: number
  listColor: string
  summaryParts: Part[]
  summary: string
  totalText: string
  foot: Foot
  win: ReturnType<typeof windowed<FlowRun>>
}

function listContext(ctx: ViewContext): RunListContext {
  const { hot, columns, shownRuns } = ctx
  const cur = shownRuns
  const win = windowed(ctx, cur, 'runs', r => runKey(r.runId), hot)
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
  const foot: Foot = { hints: ['ctrl+x tab 操作', '↑/↓ 选择', 'Enter 查看'], stop: null, canBack: false }
  // 一行：选中标记 2 + 图标 1 + 空格 1 + 类型 6 + 名称 + 说明 + 耗时 7；说明栏吃掉剩下的宽度，耗时贴右
  const statsWidth = Math.max(4, columns - 17 - nameWidth)
  const listColor = flows && singles ? CYAN : flows ? PURPLE : BLUE

  return { ...ctx, cur, nameWidth, statsWidth, listColor, summaryParts, summary, totalText, foot, win }
}

function statsOfRun(r: FlowRun) {
  const task = r.tasks[0]
  if (r.kind === 'single' && task) return agentStats(task)
  const tokens = tokensOf(r.tasks)
  const live = r.status === 'running' ? livePhases(r) : null
  const parts = live ? [live] : [WORD[r.status] ?? r.status, `${r.tasks.length} 个 agent`]
  if (tokens) parts.push(`${formatTokens(tokens)} tok`)
  return parts.join(' · ')
}

export function renderRunList(ctx: ViewContext) {
  const { Box, Text, columns, shownRuns } = ctx
  if (!shownRuns.length) {
    const message = '本会话还没有派出 Codex 任务。'
    const foot: Foot = { hints: [], stop: null, canBack: false }
    const width = Math.min(columns, Math.max(cells(message), footerCells(ctx, foot) + 2, 12))
    return shell(ctx, CYAN, width, { name: 'Codex', color: CYAN, sub: '' }, <Text dimColor>{message}</Text>, 1, foot, false)
  }
  const list = listContext(ctx)
  const { listColor, summary, summaryParts, totalText, foot } = list
  if (ctx.rows <= 1 && list.cur.length > 1) return renderCompactRuns(list)
  const lines = renderRunRows(list)
  return shell(ctx, listColor, columns, { name: 'Codex', color: CYAN, sub: summary, parts: summaryParts, right: totalText }, <Box flexDirection="column">{lines}</Box>, lines.length, foot)
}

function renderCompactRuns(ctx: RunListContext) {
  const { Box, Text, Button, spinner, agentSpinner, columns, showTitle, callbacks } = ctx
  const { cur, listColor, summaryParts, summary, totalText } = ctx
  const lineWidth = columns
  const nodes: RenderElement[] = []
  let used = 0
  const put = (node: RenderElement, w: number) => {
    nodes.push(node)
    used += w
  }
  if (!showTitle) {
    put(<Text bold color={CYAN}>Codex</Text>, 5)
    // 一行里任务名称优先：前面只写各类数量（运行中看图标），token 合计放行尾，放得下才写
    const counts = summaryParts.slice(0, -2)
    const parts: Part[] = [{ text: '  ' }, ...(counts.length ? counts : summaryParts), { text: ' │ ' }]
    for (const node of drawParts(ctx, parts)) nodes.push(node)
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
    put(mark(ctx, r.status, r.kind === 'flow' ? spinner : agentSpinner), 1)
    put(<Text> </Text>, 1)
    put(<Button plain dimColor={faded(r) || undefined} key={runKey(r.runId)} label={name} onPress={() => callbacks.openRun(r)} />, cells(name))
    if (progress) put(<Text dimColor>{progress}</Text>, cells(progress))
  }
  const tail = !showTitle && totalText ? ` · ${totalText}` : ''
  if (tail && used + cells(tail) <= lineWidth) put(<Text dimColor>{tail}</Text>, cells(tail))
  return shell(ctx, listColor, lineWidth, { name: 'Codex', color: CYAN, sub: summary, parts: summaryParts, right: totalText }, <Box width={lineWidth}>{nodes}</Box>, 1, { hints: [], stop: null, canBack: false })
}

function renderRunRows(ctx: RunListContext) {
  const { Box, Text, Button, hot, spinner, agentSpinner, callbacks } = ctx
  const { win, nameWidth, statsWidth } = ctx
  const lines = withMore(ctx, win.items.map(r => {
    const key = runKey(r.runId)
    const [kind, color] = KIND[r.kind]
    return (
      <Box>
        <Text color={BLUE}>{hot === key ? '❯ ' : '  '}</Text>
        {mark(ctx, r.status, r.kind === 'flow' ? spinner : agentSpinner)}
        <Text> </Text>
        <Box width={6}>
          <Text color={color} dimColor={faded(r) || undefined}>{kind}</Text>
        </Box>
        <Box width={nameWidth}>
          <Button plain dimColor={faded(r) || undefined} key={key} label={fit(r.name, nameWidth - 1)} onPress={() => callbacks.openRun(r)} />
        </Box>
        <Box width={statsWidth}>
          {dimFast(ctx, fit(statsOfRun(r), statsWidth - 1))}
        </Box>
        <Box width={7} justifyContent="flex-end">
          <Text dimColor>{formatDuration(r.seconds)}</Text>
        </Box>
      </Box>
    )
  }), 'runs', win, true)
  return lines
}
