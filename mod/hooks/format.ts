// 面板的文字、颜色、宽度与统计格式；各视图共用同一套显示口径。
import type { FlowRun, FlowTask } from '../types'

// 配色取自用户 ccstatusline 的设置（Tokyo Night），和状态行那一行一致
export const CYAN = '#7DCFFF'
const GREEN = '#9ECE6A'
export const RED = '#F7768E'
export const YELLOW = '#E0AF68'
export const BLUE = '#7AA2F7'
export const PURPLE = '#BB9AF7'
// 用 Fast 的模型名前面标一个黄色闪电
export const FAST = '⚡'
// 运行中的标记，只在有任务运行且面板显示时动：阶段和 flow 用闪烁的星形（与 Claude Code 自己的 ✻ 指示一致），
// agent 用转圈的细点阵，两层一眼能分开。星形不用「·」这一帧，免得看起来像停了。
export const SPIN = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
export const AGENT_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const SPIN_MS = 120
// 会随运行增长的栏位按上限预留宽度，时间从 59s 长到 1h02m、token 从 999 长到 999.9k 时版面不跳
// 时长最长 6 格（59m59s、99h59m），前留一格；token 最长 6 格（999.9k）加 " tok"，前留一格
export const TIME_SLOT = 7
export const TOKEN_SLOT = 11
// 按类型区分：flow 紫色，单个 agent 蓝色；按钮文字上不了色，所以在名称前标类型
export const KIND: Record<FlowRun['kind'], [string, string]> = { flow: ['flow', PURPLE], single: ['agent', BLUE] }

export const fileSafe = (label: string) => label.replace(/[\/\\:*?"<>|\s]+/g, '_')
const shortModel = (model: string) => String(model || '').replace(/^gpt-/, '')
// 模型和 effort 一起写；用 Fast 时前面加闪电，画的时候用 dimFast 把闪电标黄
export const modelText = (t: FlowTask) => `${t.fast ? FAST : ''}${shortModel(t.model)} ${t.effort}`
export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function since(startedAt: string | null, endedAt: string | null, now: number) {
  if (!startedAt) return 0
  const end = endedAt ? Date.parse(endedAt) : now
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000))
}

// 终端里中文和闪电（表情字符）占两格
export function cells(text: string) {
  let n = 0
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) >= 0x2e80 || ch === FAST ? 2 : 1
  return n
}

export function glyph(status: string): [string, string | undefined] {
  if (status === 'running') return ['●', BLUE]
  if (status === 'completed') return ['✓', GREEN]
  if (status === 'partial') return ['◐', YELLOW]
  if (status === 'failed' || status === 'cancelled' || status === 'lost') return ['✗', RED]
  if (status === 'skipped') return ['–', undefined]
  return ['○', undefined]
}

export const WORD: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已停止',
  lost: '已退出',
  skipped: '跳过',
  pending: '等待',
}

export const tasksOf = (run: FlowRun, phase: string | null) => run.tasks.filter(t => t.phase === phase)
export const doneOf = (tasks: FlowTask[]) => tasks.filter(t => t.status === 'completed').length
// 正在跑的阶段：一个时写「标题 完成/总数」；按依赖提前开跑、几个阶段同时在跑时写「N 个阶段并行 完成/总数」
export function livePhases(run: FlowRun) {
  const live = run.phases.filter(p => p.status === 'running')
  const tasks = live.flatMap(p => tasksOf(run, p.title))
  if (!live.length) return null
  return `${live.length === 1 ? live[0]!.title : `${live.length} 个阶段并行`} ${doneOf(tasks)}/${tasks.length}`
}
export const tokensOf = (tasks: FlowTask[]) => tasks.reduce((sum, t) => sum + (t.tokens ?? 0), 0)

// 和原生一样写成 12.3k / 1.2M
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// 按终端格数截断
export function fit(text: string, width: number) {
  if (cells(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

// 按终端格数折行，结果页用
export function wrap(text: string, width: number) {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let line = ''
    for (const ch of raw) {
      if (cells(line + ch) > width) {
        lines.push(line)
        line = ''
      }
      line += ch
    }
    lines.push(line)
  }
  return lines
}

// agent 一行的说明：模型 effort · token · 状态（运行中和完成不写，图标已经表示）
export function agentStats(t: FlowTask) {
  const parts = [modelText(t)]
  if (t.tokens) parts.push(`${formatTokens(t.tokens)} tok`)
  if (t.status !== 'running' && t.status !== 'completed') parts.push(WORD[t.status] ?? t.status)
  return parts.join(' · ')
}

// 续跑时复用的 agent 耗时栏写“复用”，时长是上次的，不算这次
export const agentTime = (t: FlowTask) => (t.reused ? '复用' : t.status === 'running' || t.status === 'completed' ? formatDuration(t.seconds) : '')

export function runSubtext(run: FlowRun) {
  const task = run.tasks[0]
  if (run.kind === 'single' && task) {
    const parts = [modelText(task)]
    if (task.tokens) parts.push(`${formatTokens(task.tokens)} tok`)
    parts.push(WORD[run.status] ?? run.status, formatDuration(run.seconds))
    return parts.join(' · ')
  }
  const parts = [WORD[run.status] ?? run.status]
  const live = run.kind === 'flow' && run.status === 'running' ? livePhases(run) : null
  if (live) parts.push(live)
  parts.push(`${run.tasks.length} 个 agent`)
  const tokens = tokensOf(run.tasks)
  if (tokens) parts.push(`${formatTokens(tokens)} tok`)
  parts.push(formatDuration(run.seconds))
  return parts.join(' · ')
}

// 阶段耗时：已开始的 agent 中最长的一个（并行 agent 按墙钟算）；没开始的阶段为空
export function phaseTime(run: FlowRun, title: string) {
  const started = tasksOf(run, title).filter(t => !t.reused && t.status !== 'pending')
  return started.length ? formatDuration(Math.max(...started.map(t => t.seconds))) : ''
}

