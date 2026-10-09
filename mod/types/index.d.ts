// 面板用的数据：从 ~/.claude/codex-flow/runs/*/state.json 读出、只留本会话的运行，秒数按刷新时刻算好。
export type FlowTask = {
  label: string
  phase: string
  model: string
  effort: string
  // 用 Fast（service tier 为 priority）：以 Codex 回报的为准，核实不了时按请求算
  fast: boolean
  brief: string
  status: string
  seconds: number
  result: string | null
  error: string | null
  log: string | null
  // 续跑时直接用了上次的结果
  reused: boolean
  tokens: number | null
  // 最近几步：命令、改文件、消息、搜索、插话；旧记录和单个 agent 没有，为空
  recent: { kind: string; text: string; status?: string }[]
  // 累计数；edits 是改文件操作的次数，不是文件数
  activity: { commands: number; edits: number; messages: number } | null
  // 运行中且正在跑验收命令：Codex 已结束，插话送不到
  checking: boolean
  // 这一轮 Codex 已结束（之后可能还在验收）：插话不会再被取走
  turnEnded: boolean
  // 验收命令条数（没有为 0）；通过的条数取 checkResults 里退出码为 0 的，没有记录时为 null
  checks: number
  checksPassed: number | null
  // 失败是因为验收没过（执行器的 checkFailed）
  checkFailed: boolean
}

export type FlowRun = {
  runId: string
  dir: string
  kind: 'flow' | 'single'
  name: string
  pid: number
  status: string
  seconds: number
  // 结束了多少秒；还在跑是 null。进程丢了的按发现时算
  endedSeconds: number | null
  alertAfter: number | null
  phases: { title: string; status: string }[]
  tasks: FlowTask[]
}

// 面板在哪一层：runId 是选中的运行，phase 是右栏列出的阶段；level 为 phases 时光标在左栏（运行、阶段），agents 在右栏选 agent，
// agent 是某个 agent 的详情（text 是读出来的结果）；还没有任何运行时 level 为空。
// 竖排版面（非终端）没有左右栏：几个运行时 phases 是任务列表，agents 是进了某个运行的页面，agent 是 flow 里某个 agent 的详情；
// 单发 agent 的页面 label 只用来读结果文本，level 仍是 phases（只有一个运行）或 agents
export type Nav = {
  runId: string | null
  level: 'phases' | 'agents' | 'agent' | null
  phase: string | null
  label: string | null
  text: string | null
}

// 只供排查读取，面板不渲染这些字段；状态行仍只读 shown。
export type PanelRecord = {
  shown: boolean
  auto: boolean
  by: 'auto-open' | 'auto-close' | 'user-hide' | 'command' | 'reload'
  at: string
  source: { root: string; instance: string }
  snapshot: {
    at: string
    complete: boolean
    errors: string[]
    runs: { runId: string; status: string; endedSeconds: number | null }[]
  } | null
}

// 左栏（阶段，或多个运行时的运行与选中 flow 的阶段）、右栏 agent、详情左栏的 agent
export type WindowColumn = 'left' | 'agents' | 'detailAgents'
export type WindowStarts = Record<WindowColumn, number>

declare module 'claude-code' {
  interface PluginState {
    'codex-flow': {
      runs: FlowRun[]
      nav: Nav
      focused: string | null
      windows: WindowStarts
      reminded: string[]
      working: boolean
      shown: boolean
      // 自动打开过的运行：用户收起后，同一批任务不再把面板弹出来
      opened: string[]
      // 面板这次打开后出现过的运行：结束后仍列在下方，面板关掉时清空
      kept: string[]
      // 面板是任务开始时自动打开的：全部结束 30 秒后自动收起；用户自己 /flow 打开的不自动收
      auto: boolean
      // 运行中星形动画的当前帧
      frame: number
      // 插话框的轮次：发出后换一个新框，清空已发的文字
      steerRound: number
    }
  }
}
