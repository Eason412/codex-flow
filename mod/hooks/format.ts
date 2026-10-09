// 面板的文字、颜色、宽度与统计格式；各视图共用同一套显示口径。
import type { FlowRun, FlowTask } from '../types'

// 颜色用 Claude Code 的主题键（Text 的 color 接受 ThemeKey，见 .claude-plugin/types/claude-code/index.d.ts 的 Color、ThemeKey），
// 跟着用户的深浅主题走。深色主题下 suggestion、success、inactive 的取值与原生 Workflow 面板截图一致（#B1B9F9、#4EBA65、#999999）。
// 紫色只给名字、选中标记 ❯ 和 flow 的 ◆；状态色只给状态符号和失败文字；其余是默认前景或暗灰。
export const ACCENT = 'suggestion'
export const RUNNING = 'ide'
export const OK = 'success'
export const FAIL = 'error'
export const MUTED = 'inactive'
export const LINE = 'subtle'
// 用 Fast 的模型名前面标一个闪电，和模型名一起画成暗灰
export const FAST = '⚡'
// 运行中的标记，只在有任务运行且面板显示时动：阶段和 flow 用闪烁的星形（与 Claude Code 自己的 ✻ 指示一致），
// agent 用转圈的细点阵，两层一眼能分开。星形不用「·」这一帧，免得看起来像停了。
export const SPIN = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
export const AGENT_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const SPIN_MS = 120
// 时长栏按上限预留：最长 6 格（59m59s、99h59m），前留一格，时间从 59s 长到 1h02m 时版面不跳
export const TIME_SLOT = 7
// 多个运行时左栏的类型标记：flow 紫色 ◆，单发 agent 蓝色 ●
export const KIND: Record<FlowRun['kind'], [string, string]> = { flow: ['◆', ACCENT], single: ['●', RUNNING] }

export const fileSafe = (label: string) => label.replace(/[\/\\:*?"<>|\s]+/g, '_')
const shortModel = (model: string) => String(model || '').replace(/^gpt-/, '')
export const modelText = (t: FlowTask) => `${t.fast ? FAST : ''}${shortModel(t.model)} ${t.effort}`
// 桌面端的模型名不带 ⚡ 字符，Fast 时后面另画一个 Svg 小闪电
export const modelPlain = (t: FlowTask) => `${shortModel(t.model)} ${t.effort}`
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

// 状态符号和颜色；运行中由调用方画转圈帧
export function glyph(status: string): [string, string] {
  if (status === 'running') return ['●', RUNNING]
  if (status === 'completed') return ['✓', OK]
  if (status === 'partial') return ['◐', FAIL]
  if (status === 'failed' || status === 'cancelled' || status === 'lost') return ['✗', FAIL]
  if (status === 'skipped') return ['–', MUTED]
  return ['○', MUTED]
}

// 桌面端的状态小方块，样式照原生 Workflow：完成灰、运行中蓝色呼吸（2.8 秒一次）、失败红、没开始只有描边。
// 灰色用 currentColor（桌面会把当前文字色写进 svg 根节点），跟着深浅主题走；蓝和红两种模式下都看得清。
// 桌面每次重画都会新建整块 DOM，动画随之从头播放；phase 是按时钟算出的当前进度（秒），动画从这一点接着播，
// 每 2 秒的刷新就不会让呼吸断掉
const SQUARE_RUN = '#3d7ff0'
const SQUARE_FAIL = '#e5484d'
export const BREATH_S = 2.8
export const breathPhase = (now: number) => (now / 1000) % BREATH_S
export function squareRect(status: string, size: number, phase: number, x = 0) {
  const r = (size / 5).toFixed(1)
  const box = `x="${x + 0.5}" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}"`
  if (status === 'running') return `<rect ${box} fill="${SQUARE_RUN}"><animate attributeName="opacity" values="1;0.35;1" dur="${BREATH_S}s" begin="-${phase.toFixed(2)}s" repeatCount="indefinite"/></rect>`
  if (status === 'failed' || status === 'cancelled' || status === 'lost' || status === 'partial') return `<rect ${box} fill="${SQUARE_FAIL}"/>`
  if (status === 'completed') return `<rect ${box} fill="currentColor" fill-opacity="0.4"/>`
  if (status === 'skipped') return `<rect ${box} fill="currentColor" fill-opacity="0.15"/>`
  return `<rect ${box} fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1"/>`
}
export const squareSvg = (status: string, size: number, phase: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${squareRect(status, size, phase)}</svg>`

// 进度格：每个 agent 一个 6px 小方块，间隔 2px，和原生 Workflow 卡片一样；最多画 GRID_MAX 个，超出的不画
export const GRID_MAX = 48
export function gridSvg(statuses: string[], phase: number) {
  const shown = statuses.slice(0, GRID_MAX)
  const width = Math.max(1, shown.length * 8 - 2)
  const rects = shown.map((s, i) => squareRect(s, 6, phase, i * 8)).join('')
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">${rects}</svg>`, width, live: shown.includes('running') }
}
// 已完成的 agent 标灰色勾，比方块更不抢眼；颜色同样跟文字色走。运行中、失败、等待仍是方块
export const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2 4.2 7.4 8.2 2.8" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// 用 Fast 的模型名后面的灰色小闪电（桌面端用它代替终端的 ⚡ 字符）
export const BOLT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="10" viewBox="0 0 7 10"><path d="M4.2 0 0.4 5.6h2.6L2.4 10 6.6 4H3.9z" fill="currentColor" fill-opacity="0.55"/></svg>'

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
export const tokensOf = (tasks: FlowTask[]) => tasks.reduce((sum, t) => sum + (t.tokens ?? 0), 0)

// 和原生一样写成 12.3k / 1.2M
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export const agentsWord = (n: number) => `${n} agent${n === 1 ? '' : 's'}`

// 桌面端顶部右侧统计：agent 总数 · 合计 token · 耗时（几个运行时取最长的那个），不写完成数
export function statsTotal(runs: FlowRun[]) {
  const tasks = runs.flatMap(r => r.tasks)
  const tokens = tokensOf(tasks)
  const seconds = Math.max(0, ...runs.map(r => r.seconds))
  return [agentsWord(tasks.length), tokens ? `${formatTokens(tokens)} tok` : '', formatDuration(seconds)].filter(Boolean).join(' · ')
}

// 顶部右侧统计：完成/总数 agents · 合计 token · 耗时（几个运行时取最长的那个）
export function statsOf(runs: FlowRun[]) {
  const tasks = runs.flatMap(r => r.tasks)
  const tokens = tokensOf(tasks)
  const seconds = Math.max(0, ...runs.map(r => r.seconds))
  return [`${doneOf(tasks)}/${agentsWord(tasks.length)}`, tokens ? `${formatTokens(tokens)} tok` : '', formatDuration(seconds)].filter(Boolean).join(' · ')
}

// 按终端格数截断
export function fit(text: string, width: number) {
  if (cells(text) <= width) return text
  if (width <= 0) return ''
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

// 详情第一行：模型 effort · token · 状态（运行中和完成不写，图标已经表示）
export function agentStats(t: FlowTask) {
  const parts = [modelText(t)]
  if (t.tokens) parts.push(`${formatTokens(t.tokens)} tok`)
  if (t.status !== 'running' && t.status !== 'completed') parts.push(WORD[t.status] ?? t.status)
  return parts.join(' · ')
}

// 续跑时复用的 agent 耗时栏写“复用”，时长是上次的，不算这次；没开始的不写
export const agentTime = (t: FlowTask) => (t.reused ? '复用' : t.status === 'pending' || t.status === 'skipped' ? '' : formatDuration(t.seconds))

// 过程里每一步的标记：命令、改文件、消息、搜索、插话、执行器的说明
export const STEP: Record<string, string> = { cmd: '$', edit: '✎', msg: '›', search: '⌕', steer: '↪', note: '!' }

// 失败原因的短写：「启动失败：…」「验收未通过：…」只取冒号前
export const shortError = (error: string | null) => (error ?? '').split('\n')[0]!.split('：')[0]!.trim()

// agent 行的状态文字，只用 state.json 里有的字段：
// 运行中按 activity 写「查看中」或改文件次数（edits 是改文件操作的次数，不是文件数），验收时写「验收中」；
// 结束后按验收命令数和 checkResults 写「验收 x/y」，失败写「验收 x/y 未过」或错误的短写。取不到的不写。
export function agentState(t: FlowTask): { text: string; fail: boolean } {
  const checks = t.checks && t.checksPassed !== null ? `验收 ${t.checksPassed}/${t.checks}` : ''
  if (t.status === 'running') {
    if (t.checking) return { text: '验收中', fail: false }
    if (!t.activity) return { text: '', fail: false }
    return { text: t.activity.edits ? `改文件 ${t.activity.edits} 次` : '查看中', fail: false }
  }
  if (t.status === 'completed') return { text: checks || '完成', fail: false }
  if (t.status === 'failed') return { text: t.checkFailed && checks ? `${checks} 未过` : shortError(t.error) || '失败', fail: true }
  if (t.status === 'lost') return { text: '已退出', fail: true }
  return { text: WORD[t.status] ?? t.status, fail: false }
}
