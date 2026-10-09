// 终端两栏的行：左栏的运行与阶段、右栏的 agent。各段放进定宽的格子：左栏标记、名称、进度对齐，右栏名字、模型、状态、时间四列对齐。
import type { FlowRun, FlowTask } from '../types'
import { ACCENT, FAIL, KIND, MUTED, RUNNING, TIME_SLOT, agentState, agentTime, cells, doneOf, fit, glyph, modelText, tasksOf } from './format'
import type { LeftItem } from './navigation'
import { faded, taskKey } from './navigation'
import type { ViewContext } from './render-frame'
import { cell, row, text } from './render-frame'

const countOf = (tasks: FlowTask[]) => `${doneOf(tasks)}/${tasks.length}`

// 左栏各段的宽度按列出的全部运行算，选中别的运行、阶段展开收起时宽度不变；进度按「总数/总数」预留，完成数进位时不跳
export function leftSizes(list: FlowRun[]) {
  const multi = list.length > 1
  const phased = list.filter(r => !multi || (r.kind === 'flow' && r.phases.length > 1))
  const counts = [
    ...phased.flatMap(r => r.phases.map(p => tasksOf(r, p.title).length)),
    ...(multi ? list.filter(r => r.kind === 'flow').map(r => r.tasks.length) : []),
  ]
  const countWidth = Math.max(3, ...counts.map(n => `${n}/${n}`.length))
  const symWidth = Math.max(1, ...phased.map(r => String(r.phases.length).length))
  // 一行：缩进 + 标记 2 + 符号 + 空格 + 名称 + 空格 + 进度
  const fixed = 2 + symWidth + 2 + countWidth
  const want = Math.max(
    ...phased.flatMap(r => r.phases.map(p => (multi ? 2 : 0) + fixed + cells(p.title))),
    ...(multi ? list.map(r => fixed + cells(r.name)) : []),
  )
  return { countWidth, symWidth, want }
}

// 左栏需要的行数：取各种选法里最多的，光标换运行时高度不跳
export function leftNeed(list: FlowRun[]) {
  if (list.length === 1) return list[0]!.phases.length
  return list.length + Math.max(0, ...list.filter(r => r.kind === 'flow' && r.phases.length > 1).map(r => r.phases.length))
}
export const rightNeed = (list: FlowRun[]) => Math.max(1, ...list.flatMap(r => r.phases.map(p => tasksOf(r, p.title).length)))

type LeftContext = ViewContext & { run: FlowRun; width: number; countWidth: number; symWidth: number; selected: string }

// 左栏一行：选中项前是紫色 ❯（按钮本身上不了色）；状态符号用状态色，没开始的阶段写序号
export function leftRow(ctx: LeftContext, item: LeftItem) {
  const { Button, callbacks, spinner, agentSpinner, width, countWidth, symWidth, selected } = ctx
  const indent = item.phase && ctx.list.length > 1 ? 2 : 0
  const me = item.key === selected
  const nameWidth = Math.max(1, width - indent - 2 - symWidth - 2 - countWidth)
  let sym: [string, string]
  let name: string
  let count: string
  let dim: boolean
  let press: () => Promise<void>
  if (item.phase) {
    const p = item.phase
    const [g, color] = glyph(p.status)
    sym = p.status === 'running' ? [spinner ?? g, RUNNING] : p.status === 'pending' ? [String(item.index + 1), MUTED] : [g, color]
    name = p.title
    count = countOf(tasksOf(item.run, p.title))
    dim = !me && p.status !== 'running'
    press = () => callbacks.selectPhase(item.run, p.title)
  } else {
    const r = item.run
    const [kind, color] = KIND[r.kind]
    const broken = r.status === 'failed' || r.status === 'cancelled' || r.status === 'lost' || r.status === 'partial'
    sym = r.status === 'running' ? [(r.kind === 'flow' ? spinner : agentSpinner) ?? kind, color] : broken ? glyph(r.status) : [kind, color]
    name = r.name
    count = r.kind === 'flow' ? countOf(r.tasks) : ''
    dim = faded(r) || (r.runId !== ctx.run.runId && r.status !== 'running')
    press = () => callbacks.openRun(r)
  }
  const label = fit(name, nameWidth)
  return row(ctx, width, [
    cell(ctx, indent, []),
    cell(ctx, 2, text(ctx, me ? '❯' : ' ', ACCENT)),
    cell(ctx, symWidth, text(ctx, sym[0], sym[1]), true),
    cell(ctx, 1, []),
    cell(ctx, nameWidth + 1, <Button plain key={item.key} label={label} dimColor={dim ? true : undefined} onPress={press} />),
    cell(ctx, countWidth, text(ctx, count, MUTED), true),
  ])
}

// 右栏各列的宽度：名字和模型按列出的全部 agent 定宽，状态列吃掉剩下的，时间贴右；太窄时先收名字再收模型
export function agentSizes(list: FlowRun[], width: number) {
  const tasks = list.flatMap(r => r.tasks)
  let nameWidth = Math.min(24, Math.max(4, ...tasks.map(t => cells(t.label))))
  let modelWidth = Math.min(20, Math.max(4, ...tasks.map(t => cells(modelText(t)))))
  const statusOf = () => width - 4 - nameWidth - 2 - modelWidth - 2 - TIME_SLOT
  if (statusOf() < 10) nameWidth = Math.max(6, nameWidth - (10 - statusOf()))
  if (statusOf() < 10) modelWidth = Math.max(6, modelWidth - (10 - statusOf()))
  return { nameWidth, modelWidth, statusWidth: Math.max(0, statusOf()) }
}

type AgentContext = ViewContext & { run: FlowRun; width: number; nameWidth: number; modelWidth: number; statusWidth: number }

// agent 一行：状态符号、名字、模型 effort（暗灰）、状态文字、时间（右对齐）。已结束和没开始的行名字与文字略暗，运行中正常亮度，失败文字红色
export function agentRow(ctx: AgentContext, t: FlowTask) {
  const { Button, callbacks, agentSpinner, at, hot, run, width, nameWidth, modelWidth, statusWidth } = ctx
  const key = taskKey(run.runId, t.label)
  const [g, color] = glyph(t.status)
  const live = t.status === 'running'
  const state = agentState(t)
  const bright = live || state.fail
  const label = fit(t.label, nameWidth)
  return row(ctx, width, [
    cell(ctx, 2, text(ctx, at.level === 'agents' && hot === key ? '❯' : ' ', ACCENT)),
    cell(ctx, 2, text(ctx, live ? agentSpinner ?? g : g, color)),
    cell(ctx, nameWidth + 2, <Button plain key={key} label={label} dimColor={bright ? undefined : true} onPress={() => callbacks.selectAgent(run, t)} />),
    cell(ctx, modelWidth + 2, text(ctx, fit(modelText(t), modelWidth), MUTED)),
    cell(ctx, statusWidth, text(ctx, fit(state.text, statusWidth), state.fail ? FAIL : live ? undefined : MUTED)),
    cell(ctx, TIME_SLOT, text(ctx, agentTime(t), MUTED), true),
  ])
}
