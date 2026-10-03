// agent 的任务说明、过程、结果与插话框；单发任务和 flow 详情共用卡片。
import type { RenderElement } from 'claude-code'
import type { FlowRun, FlowTask } from '../types'
import { CYAN, BLUE, RED, YELLOW, FAST, WORD, wrap, agentStats, agentTime, runSubtext } from './format'
import { steerKey } from './navigation'
import type { ViewContext, Foot } from './render-frame'
import { dimFast, shell } from './render-frame'

type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }
// 过程里每一步的标记：命令、改文件、消息、搜索、插话、执行器的说明
const STEP: Record<string, [string, string | undefined]> = {
  cmd: ['$', undefined], edit: ['✎', undefined], msg: ['›', undefined], search: ['⌕', undefined], steer: ['↪', CYAN], note: ['!', YELLOW],
}
// agent 详情：任务说明；过程（累计数和最近几步，运行中多列几步）；然后是结果或错误，按宽度折行
function card(ctx: ViewContext, t: FlowTask, width: number) {
  const { at } = ctx
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
function clip(ctx: ViewContext, lines: Line[], room = ctx.bodyRows) {
  if (room <= 0) return []
  return lines.length > room ? [...lines.slice(0, room - 1), { text: `… 还有 ${lines.length - room + 1} 行`, dim: true }] : lines
}
// 空行画一个空格：空 Text 不占行，两侧竖线会和内容错开
function draw(ctx: ViewContext, l: Line) {
  const { Box, Text } = ctx
  return l.dim && l.text.includes(FAST) ? <Box>{dimFast(ctx, l.text)}</Box> : (
    <Text color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
      {l.text || ' '}
    </Text>
  )
}

export function otherRuns(ctx: ViewContext, run: FlowRun) {
  const { shownRuns } = ctx
  const others = shownRuns.filter(r => r.runId !== run.runId)
  const ended = others.filter(r => r.status !== 'running').length
  const othersNote = !others.length ? '' : ended === others.length ? `另有 ${ended} 个任务已结束` : ended ? `另有 ${others.length} 个任务（${ended} 个已结束）` : `另有 ${others.length} 个任务`

  return { others, othersNote }
}

export function renderSingle(ctx: ViewContext, run: FlowRun) {
  const { Box, columns, showTitle } = ctx
  const { othersNote } = otherRuns(ctx, run)
  const withNote = (text: string) => [text, othersNote].filter(Boolean).join(' · ')
  const single = run.tasks[0]
  // 没有标题行时（只剩一行）先写名称和状态，不只露出任务说明的第一行
  const named: Line[] = showTitle ? [] : [{ text: `${run.name}  ${withNote(runSubtext(run))}`, color: BLUE, bold: true }]
  const lines = clip(ctx, [...named, ...(single ? card(ctx, single, columns) : [{ text: '没有记录。', dim: true }])])
  const foot: Foot = { hints: ['ctrl+x tab 操作'], stop: run.status === 'running' ? '停止' : null, canBack: true, back: '返回列表' }
  return shell(ctx, BLUE, columns, { name: run.name, color: BLUE, sub: withNote(runSubtext(run)) }, <Box flexDirection="column">{lines.map(l => draw(ctx, l))}</Box>, lines.length, foot)
}

export function renderAgentDetail(ctx: ViewContext, run: FlowRun, agents: FlowTask[], task: FlowTask, rightWidth: number, steer: boolean) {
  const { Box, Input, round, bodyRows, callbacks } = ctx
  let rightTitle: string
  let rightCells: RenderElement[]
  rightTitle = `${task.label} · ${agents.indexOf(task) + 1}/${agents.length}`
  const time = task.reused ? '复用上次结果' : agentTime(task)
  const state = task.checking ? '验收中' : !task.reused && (task.status === 'running' || task.status === 'completed') ? WORD[task.status] : ''
  const stats = [agentStats(task), time, state].filter(Boolean).join(' · ')
  const lines: Line[] = [{ text: stats, dim: true }, ...card(ctx, task, rightWidth)]
  rightCells = clip(ctx, lines, bodyRows - (steer ? 1 : 0)).map(l => draw(ctx, l))
  if (steer && Input) {
    rightCells.push(
      <Box width={rightWidth}>
        <Input
          key={steerKey(run.runId, task.label, round)}
          label="插话"
          placeholder="补充指示，发给这个 agent"
          submitLabel="发送"
          onSubmit={(value: string) => callbacks.sendSteer(run.runId, task.label, value)}
        />
      </Box>,
    )
  }

  return { rightTitle, rightCells }
}
