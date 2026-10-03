// flow 的两栏尺寸、阶段行和 agent 行；按树序构建可选项与内框。
import type { RenderElement } from 'claude-code'
import type { FlowRun, FlowTask, Nav } from '../types'
import { BLUE, TIME_SLOT, TOKEN_SLOT, WORD, cells, fit, glyph, formatTokens, tasksOf, doneOf, agentTime, modelText, phaseTime } from './format'
import { defaultPhase, phaseKey, taskKey, detailKey, canSteer } from './navigation'
import type { ViewContext } from './render-frame'
import { windowed, withMore, dimFast, mark } from './render-frame'

export type FlowContext = ViewContext & {
  run: FlowRun
  phase: string | null
  agents: FlowTask[]
  level: Nav['level']
  task: FlowTask | undefined
  countWidth: number
  numWidth: number
  timeCell: number
  leftWidth: number
  labelWidth: number
  rightWidth: number
  modelCell: number
  steer: boolean
}

export function flowContext(ctx: ViewContext, run: FlowRun): FlowContext {
  const { Input, at, columns, framed } = ctx
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

  const steer = !!Input && !!task && canSteer(run, task)
  return { ...ctx, run, phase, agents, level, task, countWidth, numWidth, timeCell, leftWidth, labelWidth, rightWidth, modelCell, steer }
}

export function renderLeftColumn(ctx: FlowContext) {
  const { at, hot } = ctx
  const { run, level, agents, phase } = ctx
  const leftColumn = level === 'agent' ? 'detailAgents' : 'phases'
  const leftWin = level === 'agent'
    ? windowed(ctx, agents, 'detailAgents', t => detailKey(run.runId, t.label), hot && agents.some(t => detailKey(run.runId, t.label) === hot) ? hot : at.label ? detailKey(run.runId, at.label) : null)
    : windowed(ctx, run.phases, 'phases', p => phaseKey(p.title), hot && run.phases.some(p => phaseKey(p.title) === hot) ? hot : phase ? phaseKey(phase) : null)

  const items = level === 'agent'
    ? (leftWin.items as FlowTask[]).map(t => detailAgentRow(ctx, t))
    : (leftWin.items as FlowRun['phases']).map((p, i) => phaseRow(ctx, p, leftWin.start + i))
  return withMore(ctx, items, leftColumn, leftWin, true)
}

function detailAgentRow(ctx: FlowContext, t: FlowTask) {
  const { Box, Text, Button, at, callbacks } = ctx
  const { run, leftWidth } = ctx
  const key = detailKey(run.runId, t.label)
  const me = t.label === at.label
  return (
    <Box>
      <Text color={BLUE}>{me ? '❯ ' : '  '}</Text>
      {mark(ctx, t.status)}
      <Text> </Text>
      <Button
        plain
        key={key}
        label={fit(t.label, leftWidth - 4)}
        dimColor={me ? undefined : true}
        onPress={() => callbacks.selectDetail(run, t)}
      />
    </Box>
  )
}

function phaseRow(ctx: FlowContext, p: FlowRun['phases'][number], index: number) {
  const { Box, Text, Button, hot, spinner, callbacks } = ctx
  const { run, phase, leftWidth, numWidth, countWidth, timeCell } = ctx
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
        {String(index + 1).padStart(numWidth)}
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
          onPress={() => callbacks.selectPhase(run, p.title)}
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
}

export function renderAgentRows(ctx: FlowContext) {
  const { Box, Text, Button, hot, callbacks } = ctx
  const { run, agents, level, phase, labelWidth, modelCell } = ctx
  let rightTitle: string
  let rightCells: RenderElement[]
  // agent 栏里光标在某个 agent 上时，栏标题写它的任务说明
  const hotAgent = agents.find(t => taskKey(run.runId, t.label) === hot)
  rightTitle = level === 'agents' && hotAgent?.brief ? `${hotAgent.label}：${hotAgent.brief}` : `${phase ?? ''} · ${agents.length} 个 agent`
  const runningAgent = agents.find(t => t.status === 'running')
  const preferred = hotAgent ? hot : runningAgent ? taskKey(run.runId, runningAgent.label) : null
  const rightWin = windowed(ctx, agents, 'agents', t => taskKey(run.runId, t.label), preferred)
  rightCells = withMore(ctx, rightWin.items.map(t => {
    const key = taskKey(run.runId, t.label)
    const tokens = t.tokens ? `${formatTokens(t.tokens)} tok` : ''
    // 耗时栏：运行中和完成写时长，复用写「复用」，验收中写「验收中」，其余写状态（等待、失败等）
    const time = t.checking ? '验收中' : agentTime(t) || (WORD[t.status] ?? t.status)
    return (
      <Box>
        <Text color={BLUE}>{hot === key ? '❯ ' : '  '}</Text>
        {mark(ctx, t.status)}
        <Text> </Text>
        <Box width={labelWidth + 1}>
          <Button plain key={key} label={fit(t.label, labelWidth)} dimColor={t.status === 'running' ? undefined : true} onPress={() => callbacks.selectAgent(run, t)} />
        </Box>
        <Box width={modelCell}>
          {dimFast(ctx, fit(modelText(t), modelCell))}
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

  return { rightTitle, rightCells }
}

function columnBorder(ctx: FlowContext, left: string, right: string, top: boolean) {
  const { Box, Text } = ctx
  const { leftWidth, rightWidth } = ctx
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

export function renderColumns(ctx: FlowContext, leftCells: RenderElement[], rightCells: RenderElement[], rightTitle: string) {
  const { Box, Text, bodyRows, framed } = ctx
  const { level, phase, leftWidth, rightWidth } = ctx
  // 两栏各是一列：光标按树序先走完左栏再到右栏，不会在两栏之间来回跳
  // 两栏补到可用高度，内框和外框一样固定大小
  const height = Math.max(leftCells.length, rightCells.length, bodyRows)
  const fill = (items: RenderElement[]) => [...items, ...Array.from({ length: height - items.length }, () => <Text> </Text>)]
  const bar = (text: string) => <Box flexDirection="column">{Array.from({ length: height }, () => <Text dimColor>{text}</Text>)}</Box>
  const body = (
    <Box flexDirection="column">
      {framed && columnBorder(ctx, level === 'agent' ? `${phase ?? ''}` : '阶段', rightTitle, true)}
      <Box>
        {framed && bar('│ ')}
        <Box flexDirection="column" width={leftWidth}>{fill(leftCells)}</Box>
        {bar(' │ ')}
        <Box flexDirection="column" width={rightWidth}>{fill(rightCells)}</Box>
        {framed && bar(' │')}
      </Box>
      {framed && columnBorder(ctx, '', '', false)}
    </Box>
  )

  return { body, height }
}
