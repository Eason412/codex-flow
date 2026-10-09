// 面板的入口视图：没有运行时的一行提示；终端是两栏视图（一个运行时左栏是阶段，几个运行时左栏是运行）和 agent 详情，其余 surface 是竖排版面（render-desktop.tsx）。
import type { RenderElement } from 'claude-code'
import type { FlowRun, WindowStarts } from '../types'
import { ACCENT, MUTED, agentsWord, fit, statsOf, tasksOf } from './format'
import { defaultPhase, leftItems, leftKey, taskKey, up } from './navigation'
import type { ViewContext, Head, Foot } from './render-frame'
import { BODY_CAP, columnWidths, isVertical, layout, pagerOf, panel, row, text, windowed } from './render-frame'
import { agentRow, agentSizes, leftNeed, leftRow, leftSizes, rightNeed } from './flow-columns'
import { renderDetail } from './render-agent'
import { drawVertical } from './render-desktop'

// 终端的顶部：一个运行时写它的名字，几个时写「Codex · N 个运行」；右侧统计是列出的全部运行合计。
// 第二行左边：光标在右栏时写那个 agent 的任务说明，单发 agent 写它的说明，其余不写
function headOf(ctx: ViewContext, run: FlowRun): Head {
  const { list, at, hot } = ctx
  const multi = list.length > 1
  const hotAgent = at.level === 'agents' ? run.tasks.find(t => taskKey(run.runId, t.label) === hot) : undefined
  const brief = hotAgent?.brief ? `${hotAgent.label}：${hotAgent.brief}` : !multi && run.kind === 'single' ? run.tasks[0]?.brief ?? '' : ''
  const runs = multi ? list : [run]
  return { name: multi ? `Codex · ${list.length} 个运行` : run.name, brief, stats: statsOf(runs) }
}

// 终端的三列用同一个窗口大小
const sameSize = (size: number): WindowStarts => ({ left: size, agents: size, detailAgents: size })

function renderColumns(ctx: ViewContext, run: FlowRun, head: Head) {
  const { list, at, hot, starts } = ctx
  const multi = list.length > 1
  const phase = at.phase ?? defaultPhase(run)
  const agents = tasksOf(run, phase)
  ctx.callbacks.clearSteerFocus(false)
  const lay = layout(ctx, Math.max(leftNeed(list), rightNeed(list)), BODY_CAP)
  const size = Math.max(1, lay.body)
  const sizes = leftSizes(list)
  const { leftWidth, rightWidth } = columnWidths(ctx, lay, sizes.want)

  const items = leftItems(list, run)
  const selected = leftKey(list, run, phase)
  const leftHot = hot && items.some(i => i.key === hot) ? hot : selected
  const leftWin = windowed(items, starts.left, size, items.findIndex(i => i.key === leftHot))
  const leftCtx = { ...ctx, run, width: leftWidth, countWidth: sizes.countWidth, symWidth: sizes.symWidth, selected }
  const leftRows = leftWin.items.map(item => leftRow(leftCtx, item))

  const keys = agents.map(t => taskKey(run.runId, t.label))
  const preferred = at.level === 'agents' && hot && keys.includes(hot) ? keys.indexOf(hot) : agents.findIndex(t => t.status === 'running')
  const rightWin = windowed(agents, starts.agents, size, preferred)
  const agentCtx = { ...ctx, run, width: rightWidth, ...agentSizes(list, rightWidth) }
  const rightRows = agents.length
    ? rightWin.items.map(t => agentRow(agentCtx, t))
    : [row(ctx, rightWidth, [text(ctx, fit('这个阶段没有 agent', rightWidth), MUTED)])]

  // 停止键只给在跑的目标：左栏停选中的运行（flow 整个停），右栏停光标所在的 agent
  const hotAgent = agents.find(t => taskKey(run.runId, t.label) === hot)
  const running = run.status === 'running'
  const stop = at.level === 'agents'
    ? (hotAgent?.status === 'running' ? '停止' : null)
    : running ? (run.kind === 'flow' ? '停止整个 flow' : '停止') : null
  const foot: Foot = {
    hints: ['ctrl+x tab 操作', '↑↓ 选择', at.level === 'agents' ? 'Enter 详情' : 'Enter 看 agent'],
    stop,
    back: !!up(list, at),
  }
  const tree = panel(ctx, head, lay,
    { title: multi ? '运行' : '阶段', width: leftWidth, rows: leftRows, pager: pagerOf('left', leftWin) },
    { title: `${phase ?? ''} · ${agentsWord(agents.length)}`, width: rightWidth, rows: rightRows, pager: pagerOf('agents', rightWin) },
    foot)
  return { tree, size }
}

// 还没有派过任务（用户自己 /flow 打开）：名字一行，提示和关闭键一行
function renderEmpty(ctx: ViewContext) {
  const { Box, Text, Button, width, maxRows, callbacks } = ctx
  const rows = [<Box width={width}><Text bold color={isVertical(ctx) ? undefined : ACCENT}>Codex</Text></Box>]
  if (maxRows >= 2) rows.push(
    <Box width={width}>
      {text(ctx, '本会话还没有派出 Codex 任务。', MUTED)}
      {[text(ctx, ' · ', MUTED), <Button plain dimColor hotkey="q" key="hide" label={ctx.hideLabel} onPress={() => callbacks.pressHide()} />]}
    </Box>,
  )
  return { tree: <Box flexDirection="column" width={width}>{maxRows >= 1 ? rows : []}</Box>, sizes: sameSize(1) }
}

// 返回画好的树和各列的行数（焦点和翻页事件按它算窗口）
export function drawPanel(ctx: ViewContext): { tree: RenderElement; sizes: WindowStarts } {
  const { run, at } = ctx
  if (!run) return renderEmpty(ctx)
  if (isVertical(ctx)) return drawVertical(ctx)
  const head = headOf(ctx, run)
  const task = at.level === 'agent' ? tasksOf(run, at.phase ?? defaultPhase(run)).find(t => t.label === at.label) : undefined
  const view = task ? renderDetail(ctx, run, task, head) : renderColumns(ctx, run, head)
  return { tree: view.tree, sizes: sameSize(view.size) }
}
