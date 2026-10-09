// 终端的 agent 详情：左栏这个阶段的 agent，右栏任务说明、过程、结果与插话框；单发任务和 flow 共用。
import type { RenderElement } from 'claude-code'
import type { FlowRun, FlowTask } from '../types'
import { ACCENT, FAIL, MUTED, STEP, agentStats, agentTime, cells, fit, glyph, tasksOf, wrap, WORD } from './format'
import { canSteer, defaultPhase, detailKey, steerKey, up } from './navigation'
import type { ViewContext, Head, Foot } from './render-frame'
import { DETAIL_CAP, cell, columnWidths, layout, pagerOf, panel, row, text, windowed } from './render-frame'

type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }
// 详情正文：任务说明；过程（累计数和最近几步，运行中多列几步）；然后是结果或错误，按宽度折行。
// 正在跑的那一步和执行器的说明用默认前景，失败的一步和错误用红色，其余暗灰
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
      const icon = STEP[step.kind] ?? '·'
      const color = step.status === 'failed' ? FAIL : undefined
      const bright = step.status === 'running' || step.kind === 'note'
      // 每步一行：旧记录或别的写入者可能带换行
      lines.push({ text: `${icon} ${step.kind === 'steer' ? '插话：' : ''}${step.text.replace(/\s+/g, ' ')}`, color, dim: !color && !bright })
    }
  }
  lines.push({ text: '' })
  if (at.text) {
    lines.push({ text: '结果', bold: true, dim: true })
    for (const l of wrap(at.text.trim(), width)) lines.push({ text: l })
  } else if (t.error) {
    lines.push({ text: '错误', bold: true, dim: true })
    for (const l of wrap(t.error, width)) lines.push({ text: l, color: FAIL })
  } else {
    lines.push({ text: !live ? '没有结果。' : t.checking ? '验收中：Codex 已结束，正在跑验收命令。' : '运行中，结果出来后显示在这里。', dim: true })
  }
  return lines
}
// 超出高度的截掉，末行写还剩多少
function clip(lines: Line[], room: number) {
  if (room <= 0) return []
  return lines.length > room ? [...lines.slice(0, room - 1), { text: `… 还有 ${lines.length - room + 1} 行`, dim: true }] : lines
}
// 空行画一个空格：空 Text 不占行
function draw(ctx: ViewContext, l: Line, width: number) {
  const { Box, Text } = ctx
  return (
    <Box width={width}>
      <Text color={l.color ?? (l.dim ? MUTED : undefined)} bold={l.bold}>{fit(l.text, width) || ' '}</Text>
    </Box>
  )
}

// 详情页：顶部和两栏视图相同，框里左栏换成这个阶段的 agent，右栏是选中 agent 的详情
export function renderDetail(ctx: ViewContext, run: FlowRun, task: FlowTask, head: Head) {
  const { Box, Button, Input, at, hot, round, starts, callbacks, agentSpinner } = ctx
  const phase = at.phase ?? defaultPhase(run)
  const agents = tasksOf(run, phase)
  const steer = !!Input && canSteer(run, task)
  callbacks.clearSteerFocus(steer)
  const leftWant = Math.min(24, Math.max(14, ...agents.map(t => cells(t.label) + 4)))
  const probe = columnWidths(ctx, layout(ctx, 1, 1), leftWant)
  const time = task.reused ? '复用上次结果' : agentTime(task)
  const state = task.checking ? '验收中' : !task.reused && (task.status === 'running' || task.status === 'completed') ? WORD[task.status] : ''
  const lines: Line[] = [{ text: [agentStats(task), time, state].filter(Boolean).join(' · '), dim: true }, ...card(ctx, task, probe.rightWidth)]
  const lay = layout(ctx, Math.max(agents.length, lines.length + (steer ? 1 : 0)), DETAIL_CAP)
  const { leftWidth, rightWidth } = columnWidths(ctx, lay, leftWant)
  const size = Math.max(1, lay.body)

  const mine = detailKey(run.runId, task.label)
  const keys = agents.map(t => detailKey(run.runId, t.label))
  const win = windowed(agents, starts.detailAgents, size, keys.indexOf(hot && keys.includes(hot) ? hot : mine))
  const leftRows = win.items.map(t => {
    const key = detailKey(run.runId, t.label)
    const me = t.label === task.label
    const [g, color] = glyph(t.status)
    const label = fit(t.label, leftWidth - 4)
    return row(ctx, leftWidth, [
      cell(ctx, 2, text(ctx, me ? '❯' : ' ', ACCENT)),
      cell(ctx, 2, text(ctx, t.status === 'running' ? agentSpinner ?? g : g, color)),
      cell(ctx, leftWidth - 4, <Button plain key={key} label={label} dimColor={me ? undefined : true} onPress={() => callbacks.selectDetail(run, t)} />),
    ])
  })
  const rightRows: RenderElement[] = clip(lines, lay.body - (steer ? 1 : 0)).map(l => draw(ctx, l, rightWidth))
  if (steer && Input && lay.body > 1) {
    rightRows.push(
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
  const leftTitle = run.kind === 'single' ? run.name : ctx.list.length > 1 ? `${run.name} · ${phase ?? ''}` : phase ?? ''
  const foot: Foot = {
    hints: ['ctrl+x tab 操作', '↑↓ 切换 agent', ...(steer ? ['Enter 插话'] : [])],
    stop: task.status === 'running' ? '停止' : null,
    back: !!up(ctx.list, at),
  }
  const tree = panel(ctx, { ...head, brief: '' }, lay,
    { title: leftTitle, width: leftWidth, rows: leftRows, pager: pagerOf('detailAgents', win) },
    { title: `${task.label} · ${agents.indexOf(task) + 1}/${agents.length}`, width: rightWidth, rows: rightRows, pager: null },
    foot)
  return { tree, size }
}
