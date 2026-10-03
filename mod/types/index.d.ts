// 面板用的数据：从 ~/.claude/codex-flow/runs/*/state.json 读出、只留本会话的运行，秒数按刷新时刻算好。
export type FlowTask = {
  label: string
  phase: string
  model: string
  effort: string
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

// 面板在哪一层：level 为空是当前任务的列表；phases 是在左栏选阶段，agents 是在右栏选 agent，agent 是某个 agent 的详情（text 是读出来的结果）
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

export type WindowColumn = 'runs' | 'phases' | 'agents' | 'detailAgents'
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
      // 面板是任务开始时自动打开的：全部结束 30 秒后自动收起；用户自己 /flow 打开的不自动收
      auto: boolean
      // 运行中星形动画的当前帧
      frame: number
      // 插话框的轮次：发出后换一个新框，清空已发的文字
      steerRound: number
    }
  }
}
