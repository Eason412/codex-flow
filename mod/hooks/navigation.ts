// 列出的运行、层级、焦点键和窗口起点的计算；不读取或修改引擎状态。
import type { FlowRun, FlowTask, Nav, WindowColumn } from '../types'
import { tasksOf } from './format'

export const RECENT = 30
export const TOP: Nav = { runId: null, level: null, phase: null, label: null, text: null }
export const runKey = (runId: string) => `r:${runId}`
export const runRound = (run: FlowRun) => `${run.runId}:${run.startedAt}`
export const phaseKey = (title: string) => `p:${title}`
export const taskKey = (runId: string, label: string) => `t:${runId}:${label}`
// 详情左栏的 agent 另用一套键：和 agent 栏同键时，切换层级后光标可能停在旧树的位置上
export const detailKey = (runId: string, label: string) => `a:${runId}:${label}`

// 当前的任务：在跑的和刚结束（RECENT 秒内）的，都没有就留最近一个；面板里实际列出的见 listedRuns，更早的记录留给主 Agent 用 codex-flow status 查
// flow 固定排在单个 agent 上面；同类里保持新的在上，任务结束也不挪位置
export function currentRuns(list: FlowRun[]) {
  const cur = list.filter(r => r.status === 'running' || (r.endedSeconds !== null && r.endedSeconds < RECENT))
  const rank = (r: FlowRun) => (r.kind === 'flow' ? 0 : 1)
  return cur.length ? cur.sort((a, b) => rank(a) - rank(b)) : list.slice(0, 1)
}

// 面板列出的任务：当前的在上；面板这次打开后出现过、已结束的排在下面（新结束的在上，最多 KEEP 个），面板关掉前不消失；
// 正在看的那个总在里面
const KEEP = 5
export function listedRuns(list: FlowRun[], keptIds: string[], viewing: string | null) {
  const cur = currentRuns(list)
  const ended = list
    .filter(r => !cur.includes(r) && (keptIds.includes(r.runId) || r.runId === viewing))
    .sort((a, b) => (a.endedSeconds ?? Infinity) - (b.endedSeconds ?? Infinity))
  const shownEnded = ended.slice(0, KEEP)
  const viewed = ended.find(r => r.runId === viewing)
  return [...cur, ...shownEnded, ...(viewed && !shownEnded.includes(viewed) ? [viewed] : [])]
}

// 选中一个运行时右栏先看正在跑的阶段，没有就看第一个
export const defaultPhase = (run: FlowRun) => (run.phases.find(p => p.status === 'running') ?? run.phases[0])?.title ?? null

// 多个运行时，选中的 flow 有几个阶段才把阶段缩进列在它下面
export const listsPhases = (run: FlowRun) => run.kind === 'flow' && run.phases.length > 1

// 左栏的条目：只有一个运行时是它的阶段；多个运行时是各运行，选中的 flow 的阶段缩进列在它下面
export type LeftItem = { key: string; run: FlowRun; phase: FlowRun['phases'][number] | null; index: number }
export function leftItems(list: FlowRun[], selected: FlowRun | undefined): LeftItem[] {
  const phasesOf = (run: FlowRun) => run.phases.map((phase, index) => ({ key: phaseKey(phase.title), run, phase, index }))
  if (list.length === 1) return phasesOf(list[0]!)
  return list.flatMap(run => [
    { key: runKey(run.runId), run, phase: null, index: 0 },
    ...(run === selected && listsPhases(run) ? phasesOf(run) : []),
  ])
}

// 左栏里代表当前选择的那一项：列出阶段时是阶段，否则是运行
export function leftKey(list: FlowRun[], run: FlowRun, phase: string | null) {
  return (list.length === 1 || listsPhases(run)) && phase ? phaseKey(phase) : runKey(run.runId)
}

// 竖排版面（非终端）当前画的是哪一种：
// list 几个运行同时列出（level 为 phases，光标在运行行上）；flow 一个 flow 的阶段与展开阶段的 agent；
// single 单发 agent 的页面；detail flow 里某个 agent 的详情。几个运行时，进了某个运行才是 level agents / agent
export type VerticalView = 'list' | 'flow' | 'single' | 'detail'
export function verticalView(list: FlowRun[], at: Nav): VerticalView {
  const run = list.find(r => r.runId === at.runId)
  if (!run || (list.length > 1 && at.level !== 'agents' && at.level !== 'agent')) return 'list'
  if (run.kind === 'single') return 'single'
  return at.level === 'agent' ? 'detail' : 'flow'
}
// 竖排版面里「阶段 / 运行」那一列的条目和选中项：list 是各运行，flow 是它的阶段，其余没有
export function verticalLeft(list: FlowRun[], at: Nav): { keys: string[]; selected: string | null } {
  const run = list.find(r => r.runId === at.runId)
  const view = verticalView(list, at)
  if (view === 'list') return { keys: list.map(r => runKey(r.runId)), selected: run ? runKey(run.runId) : null }
  if (view === 'flow' && run) return { keys: run.phases.map(p => phaseKey(p.title)), selected: phaseKey(at.phase ?? defaultPhase(run) ?? '') }
  return { keys: [], selected: null }
}

// 打开面板时的位置：选中第一个在跑的运行（flow 排在前面），光标在左栏
export function entry(cur: FlowRun[]): { to: Nav; key: string | null } {
  const run = cur.find(r => r.status === 'running') ?? cur[0]
  if (!run) return { to: TOP, key: null }
  const phase = defaultPhase(run)
  return { to: { runId: run.runId, level: 'phases' as const, phase, label: null, text: null }, key: leftKey(cur, run, phase) }
}

// 退一层：agent 详情 → 右栏 agent → 左栏；null 表示已在左栏
// list 传 listedRuns 的结果。竖排版面（vertical）没有左右栏：详情退回 flow 页（几个运行时是该运行的页面），
// 几个运行时从运行的页面退回列表，只有一个运行时 flow 页已是最外层
export function up(list: FlowRun[], at: Nav, vertical = false): { to: Nav; key: string | null } | null {
  const run = list.find(r => r.runId === at.runId)
  if (!run || !at.level) return null
  if (vertical) {
    const multi = list.length > 1
    if (at.level === 'agent' && !(multi && run.kind === 'single')) return { to: { ...at, level: multi ? 'agents' as const : 'phases' as const, label: null, text: null }, key: at.label ? taskKey(run.runId, at.label) : null }
    if (multi && at.level !== 'phases') return { to: { ...at, level: 'phases' as const, label: null, text: null }, key: runKey(run.runId) }
    return null
  }
  if (at.level === 'agent') return { to: { ...at, level: 'agents' as const, text: null }, key: at.label ? taskKey(run.runId, at.label) : null }
  if (at.level === 'agents') return { to: { ...at, level: 'phases' as const, label: null }, key: leftKey(list, run, at.phase) }
  return null
}

export const isItem = (key: string) => /^[rpta]:/.test(key)

// 每栏能选的条目，按显示顺序；list 传 listedRuns 的结果
export function columnKeys(list: FlowRun[], at: Nav, column: WindowColumn, vertical = false): string[] {
  const run = list.find(r => r.runId === at.runId)
  if (!run || !at.level) return []
  const shownAgents = tasksOf(run, at.phase ?? defaultPhase(run))
  if (vertical) {
    if (column === 'left') return verticalLeft(list, at).keys
    return column === 'agents' && verticalView(list, at) === 'flow' ? shownAgents.map(t => taskKey(run.runId, t.label)) : []
  }
  const columnsShown = at.level === 'phases' || at.level === 'agents'
  if (column === 'left') return columnsShown ? leftItems(list, run).map(item => item.key) : []
  if (column === 'agents') return columnsShown ? shownAgents.map(t => taskKey(run.runId, t.label)) : []
  return at.level === 'agent' ? shownAgents.map(t => detailKey(run.runId, t.label)) : []
}

// 旧版本留在 $.state 里的窗口起点可能缺这一栏，按 0 算
export const windowStart = (start: number, length: number, size: number, index = -1) => {
  if (size <= 0) return 0
  let value = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, Math.max(0, length - size)))
  if (index >= 0 && index < value) value = index
  if (index >= value + size) value = index - size + 1
  return value
}

// 插话只给运行中、不在验收的 flow 任务：单个 agent 由 run.sh 跑，收不到插话；验收时 Codex 已经结束
export const canSteer = (run: FlowRun, task: FlowTask | undefined) => run.kind === 'flow' && task?.status === 'running' && !task.checking && !task.turnEnded
export const steerKey = (runId: string, label: string, round: number) => `steer:${runId}:${label}:${round}`

// 结束超过 RECENT 秒、排在下面一组的运行画暗
export const faded = (r: FlowRun) => r.status !== 'running' && !(r.endedSeconds !== null && r.endedSeconds < RECENT)
