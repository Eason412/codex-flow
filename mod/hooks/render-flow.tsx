// flow 视图的编排与低高度摘要；标题、停止目标和返回层级由运行数据决定。
import type { RenderElement } from 'claude-code'
import type { FlowRun } from '../types'
import { CYAN, BLUE, PURPLE, WORD, cells, fit, formatDuration, formatTokens, doneOf, tokensOf, modelText } from './format'
import { up, taskKey } from './navigation'
import type { ViewContext, Head, Foot } from './render-frame'
import { dimFast, mark, shell } from './render-frame'
import type { FlowContext } from './flow-columns'
import { flowContext, renderLeftColumn, renderAgentRows, renderColumns } from './flow-columns'
import { otherRuns, renderAgentDetail } from './render-agent'

function flowHeadAndFoot(ctx: FlowContext, othersNote: string) {
  const { at, hot, shownRuns } = ctx
  const { run, agents, level, task, steer } = ctx

  const running = run.status === 'running'
  const back = up(shownRuns, at)
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
  return { head, foot, stop }
}

export function renderFlow(view: ViewContext, run: FlowRun) {
  const ctx = flowContext(view, run)
  const { columns, framed, run: current, agents, task, rightWidth, steer } = ctx
  // 插话框不在了（任务结束、进入验收、换了 agent）就忘掉光标在它上面，免得下一次 ↑ 被误改道。
  ctx.callbacks.clearSteerFocus(steer)
  const leftCells = renderLeftColumn(ctx)
  const { rightCells, rightTitle } = task
    ? renderAgentDetail(ctx, current, agents, task, rightWidth, steer)
    : renderAgentRows(ctx)
  const { body, height } = renderColumns(ctx, leftCells, rightCells, rightTitle)
  const { others, othersNote } = otherRuns(ctx, run)
  const { head, foot, stop } = flowHeadAndFoot(ctx, othersNote)
  // 只剩一行内容时，两栏改画当前阶段与全部 agent 的摘要；没有标题行时名称放在最前。
  if (ctx.rows <= 1) return renderCompactFlow(ctx, head, stop, others, othersNote)
  return shell(ctx, PURPLE, columns, head, body, height + (framed ? 2 : 0), foot)
}

function renderCompactFlow(ctx: FlowContext, head: Head, stop: string | null, others: FlowRun[], othersNote: string) {
  const { Box, Text, spinner, columns, showTitle } = ctx
  const { run, phase, agents, level } = ctx
  // 一行摘要用满可用宽度，名称、模型和 token 才放得下
  const lineWidth = columns
  const p = run.phases.find(x => x.title === phase)
  const nodes: RenderElement[] = []
  let used = 0
  const put = (node: RenderElement, w: number) => {
    nodes.push(node)
    used += w
  }
  const putDim = (text: string) => {
    nodes.push(...dimFast(ctx, text))
    used += cells(text)
  }
  if (!showTitle) {
    const name = fit(run.name, Math.max(4, Math.floor(lineWidth / 3)))
    put(<Text bold color={PURPLE}>{name}</Text>, cells(name))
    put(<Text>  </Text>, 2)
  }
  if (p) {
    const text = ` ${fit(p.title, 12)} ${doneOf(agents)}/${agents.length}`
    put(mark(ctx, p.status, spinner), 1)
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
  used = appendCompactAgents(ctx, nodes, used, room, shared)
  if (tailText()) putDim(tailText())
  if (note) put(<Text color={CYAN}>{note}</Text>, cells(note))
  // 摘要里没有可选项，不写操作提示（原因写在 README）；停止键只留阶段栏的「停止整个 flow」，免得停掉看不见的 agent。
  // 有别的任务时留返回键，直接回列表（摘要里各层画得一样，逐层退看不出变化）
  const compact: Foot = { hints: [], stop: level === 'phases' ? stop : null, canBack: others.length > 0, back: '返回列表', toList: true }
  return shell(ctx, PURPLE, lineWidth, head, <Box width={lineWidth}>{nodes}</Box>, 1, compact)
}

function appendCompactAgents(ctx: FlowContext, nodes: RenderElement[], used: number, room: number, shared: string) {
  const { Text, agents } = ctx
  const put = (node: RenderElement, width: number) => {
    nodes.push(node)
    used += width
  }
  const putDim = (text: string) => {
    nodes.push(...dimFast(ctx, text))
    used += cells(text)
  }
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
    put(mark(ctx, t.status), 1)
    put(<Text dimColor={t.status === 'running' ? undefined : true}>{` ${label}`}</Text>, 1 + cells(label))
    if (own) putDim(own)
  }
  return used
}
