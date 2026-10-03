// 任务列表、层级、焦点键和窗口起点的计算；不读取或修改引擎状态。
import type { FlowRun, FlowTask, Nav, WindowColumn } from '../types'
import { tasksOf } from './format'

export const RECENT = 30
export const TOP: Nav = { runId: null, level: null, phase: null, label: null, text: null }
export const runKey = (runId: string) => `r:${runId}`
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
// 正在看的那个总在列表里，所以看它时总能返回列表
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

// 进入一个 flow 时先选中正在跑的阶段，没有就选第一个
export const defaultPhase = (run: FlowRun) => (run.phases.find(p => p.status === 'running') ?? run.phases[0])?.title ?? null

// 打开面板时的位置：列出的只有一个 flow 就直接进它的阶段栏；单个 agent、多个任务都先列出来
export function entry(cur: FlowRun[]): { to: Nav; key: string | null } {
  const run = cur.length === 1 && cur[0]?.kind === 'flow' ? cur[0] : undefined
  if (!run) {
    const first = cur.find(r => r.status === 'running') ?? cur[0]
    return { to: TOP, key: first ? runKey(first.runId) : null }
  }
  const phase = defaultPhase(run)
  return { to: { runId: run.runId, level: 'phases' as const, phase, label: null, text: null }, key: phase ? phaseKey(phase) : null }
}

// 退一层：agent 详情 → agent 栏 → 阶段栏 → 任务列表（列表里只有这一个 flow 时阶段栏就是最外层；单个 agent 的详情直接回列表）；null 表示已在最外层
// list 传 listedRuns 的结果
export function up(list: FlowRun[], at: Nav): { to: Nav; key: string | null } | null {
  const run = list.find(r => r.runId === at.runId)
  if (!run || !at.level) return null
  if (run.kind === 'single') return { to: TOP, key: runKey(run.runId) }
  if (at.level === 'agent') return { to: { ...at, level: 'agents' as const, text: null }, key: at.label ? taskKey(run.runId, at.label) : null }
  if (at.level === 'agents' && run.kind === 'flow') return { to: { ...at, level: 'phases' as const, label: null }, key: at.phase ? phaseKey(at.phase) : null }
  if (list.length > 1) return { to: TOP, key: runKey(run.runId) }
  return null
}

export const isItem = (key: string) => /^[rpta]:/.test(key)

// list 传 listedRuns 的结果
export function columnKeys(list: FlowRun[], at: Nav, column: WindowColumn): string[] {
  const run = list.find(r => r.runId === at.runId)
  if (column === 'runs') return !run || !at.level ? list.map(r => runKey(r.runId)) : []
  if (!run || run.kind !== 'flow') return []
  // 阶段栏和 agent 栏两栏随时可选；详情时左栏换成这个阶段的 agent
  const columnsShown = at.level === 'phases' || at.level === 'agents'
  if (column === 'phases') return columnsShown ? run.phases.map(p => phaseKey(p.title)) : []
  const shownAgents = tasksOf(run, at.phase ?? defaultPhase(run))
  if (column === 'agents' && columnsShown) return shownAgents.map(t => taskKey(run.runId, t.label))
  if (column === 'detailAgents' && at.level === 'agent') return shownAgents.map(t => detailKey(run.runId, t.label))
  return []
}

export const windowStart = (start: number, length: number, size: number, index = -1) => {
  let value = Math.max(0, Math.min(start, Math.max(0, length - size)))
  if (index >= 0 && index < value) value = index
  if (index >= value + size) value = index - size + 1
  return value
}

// 插话只给运行中、不在验收的 flow 任务：单个 agent 由 run.sh 跑，收不到插话；验收时 Codex 已经结束
export const canSteer = (run: FlowRun, task: FlowTask | undefined) => run.kind === 'flow' && task?.status === 'running' && !task.checking && !task.turnEnded
export const steerKey = (runId: string, label: string, round: number) => `steer:${runId}:${label}:${round}`

// 结束超过 RECENT 秒、排在下面一组的任务画暗
export const faded = (r: FlowRun) => r.status !== 'running' && !(r.endedSeconds !== null && r.endedSeconds < RECENT)

