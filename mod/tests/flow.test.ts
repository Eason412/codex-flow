import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { PanelRecord, WindowStarts } from '../types'

const ROOT = '/home/me/.claude/codex-flow/runs'
const T0 = Date.parse('2026-10-03T00:00:00.000Z')
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const flowState = {
  version: 1,
  kind: 'flow',
  runId: 'r-1',
  name: 'review-api',
  session: 'sess-1',
  pid: 4242,
  alertAfter: null,
  status: 'running',
  startedAt: iso(0),
  endedAt: null,
  phases: [
    { title: '审查', status: 'running' },
    { title: '复核', status: 'pending' },
  ],
  tasks: [
    { label: '安全', phase: '审查', model: 'gpt-6.1-sol', effort: 'high', brief: '查安全问题', status: 'completed', startedAt: iso(0), endedAt: iso(190), result: 'results/安全.md', log: 'logs/安全.jsonl', reused: true, tokens: 3000 },
    { label: '性能', phase: '审查', model: 'gpt-6.1-sol', effort: 'high', brief: '查性能问题', status: 'running', startedAt: iso(0), log: 'logs/性能.jsonl', tokens: 12345 },
    { label: '汇总复核', phase: '复核', model: 'gpt-6-astra', effort: 'high', brief: '汇总', status: 'pending' },
  ],
}
const singleState = {
  version: 1,
  kind: 'single',
  runId: 's-1',
  name: '单发测试',
  session: 'sess-1',
  pid: 5151,
  alertAfter: null,
  status: 'running',
  startedAt: iso(600),
  endedAt: null,
  phases: [{ title: '任务', status: 'running' }],
  tasks: [{ label: '单发测试', phase: '任务', model: 'gpt-6.1-sol', effort: 'high', brief: '单个任务', status: 'running', startedAt: iso(600), log: 'events.jsonl' }],
}
// 本会话早先跑完的 flow：有在跑的时候不显示
const oldState = { ...flowState, runId: 'r-0', name: '旧的 flow', status: 'completed', startedAt: iso(-3600), endedAt: iso(-3000), phases: [{ title: '审查', status: 'completed' }], tasks: [] }
// 别的会话的运行不该出现
const otherState = { ...flowState, runId: 'r-2', name: 'someone-else', session: 'sess-2' }

const PANEL = '/home/me/.claude/codex-flow/panel-sess-1.json'
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 100, scroll: { top: 0, bodyRows: 24, contentRows: 0 }, view: {} } as never
const FLOW_CMD = { command: 'flow', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

type World = { writes: string[]; prompts: string[]; toasts: string[]; logs: { text: string; to: string }[]; killed: string[][]; alive: number[]; files: Record<string, string>; mtimes: Record<string, number>; dirs: string[]; failList: boolean; rootExists: boolean; failReads: string[]; windowStarts: WindowStarts; focuses: string[]; landed: string[]; sessionId: string; failSessionId?: boolean; psError?: boolean; failWrites?: RegExp; beforeManualAutoSet?: () => Promise<void>; beforePanelWrite?: (text: string) => Promise<void> }

function world(on: On, env: Record<string, string> = { HOME: '/home/me' }): World {
  const w: World = {
    writes: [],
    prompts: [],
    toasts: [],
    logs: [],
    killed: [],
    alive: [4242, 5151],
    failList: false,
    rootExists: true,
    failReads: [],
    focuses: [],
    landed: [],
    sessionId: 'sess-1',
    windowStarts: { left: 0, agents: 0, detailAgents: 0 },
    dirs: ['r-0', 'r-1', 'r-2', 's-1'],
    mtimes: {},
    files: {
      [`${ROOT}/r-1/state.json`]: JSON.stringify(flowState),
      [`${ROOT}/r-2/state.json`]: JSON.stringify(otherState),
      [`${ROOT}/s-1/state.json`]: JSON.stringify(singleState),
      [`${ROOT}/r-0/state.json`]: JSON.stringify(oldState),
      [`${ROOT}/r-1/results/安全.md`]: '## 结论\n没有发现注入问题。',
    },
  }
  mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (w.failSessionId) throw new Error('session id unavailable')
    return { value: w.sessionId }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.focus', ($, e) => { if (e.element) w.landed.push(e.element); return {} })
  on('state.set', { plugin: 'codex-flow', key: 'windows' }, async ($, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) w.windowStarts = e.value
    return result
  })
  on('state.set', { plugin: 'codex-flow', key: 'auto' }, async ($, e, next) => {
    if (e.value === false && e.previous === true) await w.beforeManualAutoSet?.()
    return next(e)
  })
  // 面板收起后交给下面的（这里是测试自己）画
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push({ text: e.text, to: e.to })
    const record = JSON.parse(e.text)
    // 2.1.288 kit 没有插件 $.ui.focus API 底层（引擎 ui.focus 事件可模拟）。
    // 记录实际调用目标；测试另派对应事件模拟引擎完成聚焦。
    if (record.event === 'focus-error' && record.error.includes('no implementation for ui.focus')) w.focuses.push(record.key)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    if (w.failList) throw new Error('temporary read failure')
    if (!w.rootExists) throw new Error('ENOENT')
    if (e.path !== ROOT) throw new Error('ENOENT')
    return { value: w.dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path === ROOT ? w.rootExists : w.files[e.path] !== undefined }))
  on('fs.stat', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: w.mtimes[e.path] ?? 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (w.failReads.includes(e.path)) throw new Error('temporary read failure')
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async ($, e) => {
    if (w.failWrites?.test(e.path)) throw new Error('EACCES')
    w.writes.push(e.path)
    if (e.path === PANEL) await w.beforePanelWrite?.(e.text)
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'ps') return { value: { exitCode: w.psError || !w.alive.length ? 1 : 0, stdout: w.psError ? '' : w.alive.join('\n'), stderr: w.psError ? 'ps: Operation not permitted' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    w.killed.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  return w
}

const controlWrites = (w: World) => w.writes.filter(p => p.includes('/control/'))
const panel = (w: World): PanelRecord => JSON.parse(w.files[PANEL]!)
function expectPanel(w: World, shown: boolean, by: PanelRecord['by'], now: number) {
  const record = panel(w)
  expect(record.shown).toBe(shown)
  expect(record.by).toBe(by)
  expect(record.at).toBe(new Date(now).toISOString())
  expect(record.source.root.startsWith('/')).toBe(true)
  expect(record.source.instance).toMatch(/^[0-9a-f-]{36}$/)
  expect(record.source).toEqual({ root: record.source.root, instance: record.source.instance })
  expect(typeof record.auto).toBe('boolean')
}

const STAR = /^[✢✳✶✻✽]$/
const DOTS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/

test('终端：任务开始时面板自动出现在输入框上方：几个运行时左栏列运行（flow 紫色 ◆、单发蓝色 ●），右栏是选中运行的 agent，Enter 进详情，返回回到两栏', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  // 自动打开，并告诉状态行让出 codex 那一行
  expectPanel(w, true, 'auto-open', T0 + 252_000)

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'codex-flow', surface, component: 'AbovePrompt', props: PROPS })
    // 第二轮从上一轮停下的位置开始：先回到 flow
    await ui.press({ key: 'r:r-1' })
    await ui.press({ key: 'back' })

    // 一个 flow、一个 agent 在跑：顶部写运行数和全部运行的合计；早先跑完的、别的会话的都不显示，调试信息不给用户看
    expect((await ui.find({ type: 'Text', text: 'Codex · 2 个运行' }))?.props.color).toBe('suggestion')
    expect(await ui.find({ type: 'Text', text: /^1\/4 agents · 15\.3k tok · 4m1\ds$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '运行' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
    // 运行中的 flow 用紫色星形、单发 agent 用蓝色细点阵
    expect((await ui.findAll({ type: 'Text', text: STAR })).some(t => t.props.color === 'suggestion')).toBe(true)
    expect((await ui.findAll({ type: 'Text', text: DOTS })).every(t => t.props.color === 'ide')).toBe(true)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'r:r-0' })).toBeUndefined()
    expect(await ui.find({ text: 'someone-else' })).toBeUndefined()
    expect(await ui.find({ text: /jsonl|4242/ })).toBeUndefined()

    // 选中的 flow 有两个阶段，缩进列在它下面；右栏是当前阶段的 agent：模型 effort、状态、时间，不写每行的 token
    expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'p:复核' })).toBeDefined()
    // 右栏首行是嵌在边线里的标题
    expect(await ui.find({ type: 'Text', text: '审查 · 2 agents' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '6.1-sol high' }))?.props.color).toBe('inactive')
    expect(await ui.find({ type: 'Text', text: /^完成 *$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ *复用$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /12\.3k tok/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 't:r-1:性能' })).toBeDefined()

    // Enter 阶段：右栏换成它，光标进右栏；返回回到左栏
    await ui.press({ key: 'p:复核' })
    expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6-astra high' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^等待 *$/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()

    // Enter agent 进详情：右栏是结果，左栏可以换 agent
    await ui.press({ key: 'p:审查' })
    await ui.press({ key: 't:r-1:安全' })
    expect(await ui.find({ type: 'Text', text: '安全 · 1/2' })).toBeDefined()
    expect(await ui.find({ text: '没有发现注入问题。' })).toBeDefined()
    // 已完成的 agent 没有停止键
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
    await ui.press({ key: 'a:r-1:性能' })
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    expect(await ui.find({ text: '运行中，结果出来后显示在这里。' })).toBeDefined()
    await ui.press({ key: 'stop' })
    expect(controlWrites(w).at(-1)).toBe(`${ROOT}/r-1/control/性能.stop`)

    // 退到左栏，x 停整个 flow
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })
    expect((await ui.find({ type: 'Button', key: 'stop' }))?.props.label).toBe('停止整个 flow')
    await ui.press({ key: 'stop' })
    expect(w.killed.at(-1)).toEqual(['kill', '-TERM', '4242'])

    // 单个 agent：选中后右栏就是它这一行，Enter 进详情
    await ui.press({ key: 'r:s-1' })
    expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '任务 · 1 agent' })).toBeDefined()
    await ui.press({ key: 't:s-1:单发测试' })
    expect(await ui.find({ type: 'Text', text: /^6\.1-sol high · .* · 运行中$/ })).toBeDefined()
    expect(await ui.find({ text: '单个任务' })).toBeDefined()
    expect(await ui.find({ text: '运行中，结果出来后显示在这里。' })).toBeDefined()
    // 停止时先写停止标记再结束 run.sh 下面的 codex
    await ui.press({ key: 'stop' })
    expect(controlWrites(w).at(-1)).toBe(`${ROOT}/s-1/control/stop`)
    expect(w.killed.at(-1)).toEqual(['pkill', '-TERM', '-P', '5151'])
    // 返回两次回到左栏
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()

    // 在跑时不能彻底关闭，面板保持显示
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
    expect(panel(w).shown).toBe(true)
    await ui.unmount()
  }

  // 同一批任务继续显示；新任务开始也显示在左栏
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()

  // 新任务开始：更新面板
  w.dirs.push('s-2')
  w.alive.push(5252)
  w.files[`${ROOT}/s-2/state.json`] = JSON.stringify({ ...singleState, runId: 's-2', name: '第二个', pid: 5252, startedAt: iso(250) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'r:s-2' })).toBeDefined()
  expect(panel(w).shown).toBe(true)

  // 全部结束：先留着显示 ✓，30 秒后自动收起
  const finish = (id: string, state: typeof singleState | typeof flowState) => {
    const endedAt = iso(258)
    w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({
      ...state,
      runId: id,
      status: 'completed',
      endedAt,
      phases: state.phases.map(p => ({ ...p, status: 'completed' })),
      tasks: state.tasks.map(t => ({ ...t, status: 'completed', endedAt })),
    })
  }
  finish('r-1', flowState)
  finish('s-1', singleState)
  finish('s-2', { ...singleState, name: '第二个', startedAt: iso(250) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /^5\/5 agents/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('关闭')
  expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.hotkey).toBe('q')
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:s-2' })).toBeDefined()
  await clock.advance(30_000)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  expectPanel(w, false, 'auto-close', T0 + 288_000)

  // 用户自己 /flow 打开的不自动收起
  expect((await $.command.run(FLOW_CMD)).text).toContain('已在输入框上方打开')
  expectPanel(w, true, 'command', clock.now())
  expect(panel(w).auto).toBe(false)
  expect((await $.command.run(FLOW_CMD)).text).toContain('Codex 任务面板已经在输入框上方')
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  // 用户关闭后同一批任务不弹出；新运行开始才自动打开。
  await ui.press({ key: 'hide' })
  expectPanel(w, false, 'user-hide', clock.now())
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  expect(panel(w).shown).toBe(false)
  // 同一个 runId 恢复运行也仍属于用户已关闭的这一批。
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(flowState)
  await clock.advance(2_000)
  expect(panel(w).shown).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
  w.dirs.push('s-3')
  w.alive.push(5353)
  w.files[`${ROOT}/s-3/state.json`] = JSON.stringify({ ...singleState, runId: 's-3', name: '第三个', pid: 5353, startedAt: new Date(clock.now()).toISOString() })
  await clock.advance(2_000)
  expectPanel(w, true, 'auto-open', clock.now())
  expect(await ui.find({ type: 'Button', key: 'r:s-3' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  await ui.unmount()
})

test('只有一个 flow 在跑时直接进它的阶段栏，最外层没有返回键；再输 /flow 保持显示并提示引擎折叠', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = w.dirs.filter(d => d !== 's-1')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  expect((await $.command.run(FLOW_CMD)).text).toBe('Codex 任务面板已经在输入框上方。如果那里只剩一行「▸ plugin panel hidden」，那是 Claude Code 自带的折叠：点一下那一行，或按 ctrl+x ctrl+a，就能展开。')
  expectPanel(w, true, 'command', clock.now())
  expect(panel(w).shown).toBe(true)
  expect(panel(w).auto).toBe(false)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(254) })
  await clock.advance(60_000)
  expect(panel(w).shown).toBe(true)
  expect(panel(w).auto).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  await ui.unmount()
})

test('任务每跑满 15 分钟只 toast 一次，主对话忙时也不 submit、不停任务', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)

  await clock.set(T0 + 905_000)
  expect(w.prompts).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('Codex 任务「性能」（review-api，gpt-6.1-sol high）已运行 15m')

  await clock.advance(60_000)
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
  expect(controlWrites(w)).toHaveLength(0)
  expect(w.killed).toHaveLength(0)

  // toast 不唤醒主对话，无需等当前轮结束。
  await $.turn.start({ text: '', turnId: 't-1' })
  await clock.set(T0 + 1_805_000)
  expect(w.toasts).toHaveLength(3)
  expect(w.prompts).toHaveLength(0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't-1', reason: 'answer' } as never)
  await clock.advance(2_000)
  // 同一阈值不重复：性能满 30 分钟，单发任务（第 600 秒开始）满 15 分钟。
  expect(w.toasts).toHaveLength(3)
  expect(w.prompts).toHaveLength(0)
  expect(w.toasts.some(p => p.includes('「性能」') && p.includes('已运行 30m'))).toBe(true)
  expect(w.toasts.some(p => p.includes('「单发测试」') && p.includes('已运行 15m'))).toBe(true)

  // 进程已经不在：不再发时长 toast，各运行只发失联提醒。
  w.alive = []
  await clock.set(T0 + 2_710_000)
  expect(w.toasts).toHaveLength(3)
  expect(w.prompts).toHaveLength(2)
})

test('环境阈值控制 toast，运行记录的 alertAfter 优先；同一 flow 多个任务分别去重', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 700_000 })
  const w = world(on, { HOME: '/home/me', CODEX_FLOW_ALERT_AFTER: '100' })
  w.dirs = ['r-1', 's-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({
    ...flowState, alertAfter: 800,
    tasks: flowState.tasks.map(t => t.label === '安全' ? { ...t, status: 'running', endedAt: null } : t),
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('「单发测试」')
  await clock.advance(10_000)
  expect(w.toasts).toHaveLength(1)
  await clock.set(T0 + 802_000)
  expect(w.toasts).toHaveLength(4)
  expect(w.toasts.filter(p => p.includes('review-api'))).toHaveLength(2)
  await clock.advance(10_000)
  expect(w.toasts).toHaveLength(4)
  expect(w.prompts).toHaveLength(0)
})

test('lost 时同一运行只 submit 一条，合并仍标 running 的任务和日志，恢复后再次 lost 也不重复', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({
    ...flowState,
    tasks: flowState.tasks.map(t => t.label === '汇总复核' ? { ...t, status: 'running', startedAt: iso(200), log: 'logs/汇总复核.jsonl' } : t),
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(0)
  w.alive = []
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(1)
  const text = w.prompts[0]
  expect(text).toContain('运行「review-api」（runId：r-1）')
  expect(text).toContain(`运行目录：${ROOT}/r-1`)
  expect(text).toContain('执行器进程已退出但状态仍是 running')
  expect(text).toContain(`「性能」：${ROOT}/r-1/logs/性能.jsonl`)
  expect(text).toContain(`「汇总复核」：${ROOT}/r-1/logs/汇总复核.jsonl`)
  expect(text).not.toContain('「安全」')
  expect(text).toContain('请主 agent 读日志后向用户汇报，不要自动重跑')
  await clock.advance(40_000)
  expect(w.prompts).toHaveLength(1)
  w.alive = [4242]
  await clock.advance(2_000)
  w.alive = []
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(1)
  expect(controlWrites(w)).toHaveLength(0)
  expect(w.killed).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

test('lost 提醒等主对话空闲，按空闲时的状态发送；已完成的运行不补发', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 'busy' })
  w.alive = []
  await clock.advance(40_000)
  expect(w.prompts).toHaveLength(0)
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(290) })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'busy', reason: 'answer' } as never)
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('runId：r-1')
  expect(w.prompts[0]).not.toContain('runId：s-1')
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(1)
})

test('失联去重键不被后续超过 200 条时长提醒淘汰', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  w.alive = [5151]
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.toasts).toHaveLength(0)
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({
    ...singleState,
    tasks: Array.from({ length: 201 }, (_, i) => ({ ...singleState.tasks[0], label: `task-${i}`, startedAt: iso(0) })),
    alertAfter: 100,
  })
  await clock.advance(2_000)
  expect(w.toasts).toHaveLength(201)
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(256) })
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(1)
})

test('历史显示仍限十条，超出面板历史范围的 lost 运行也只提醒一次', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  for (let i = 0; i < 12; i++) {
    const id = `s-history-${i}`
    w.dirs.push(id)
    w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, status: 'completed', startedAt: iso(100 + i), endedAt: iso(200) })
  }
  w.alive = []
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  // 没有运行中的任务时不会自动打开；手动打开才将最新快照写入面板记录。
  await $.command.run(FLOW_CMD)
  expect(panel(w).snapshot!.runs).toHaveLength(10)
  expect(panel(w).snapshot!.runs.some(r => r.runId === 'r-1')).toBe(false)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('runId：r-1')
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(1)
})

test('最后一个任务结束不足 30 秒不收起（包括毫秒边界，主对话一直忙）', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_200 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 'busy' })
  await clock.advance(2_000)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(3.568) })
  await clock.set(T0 + 20_200)
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(18.697) })
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.set(T0 + 31_200)
  expect(JSON.parse(w.files[PANEL]!).shown).toBe(true)
  // 48.2 - 18.697 = 29.503：四舍五入不能把它当作满 30 秒。
  await clock.set(T0 + 48_200)
  expect(JSON.parse(w.files[PANEL]!).shown).toBe(true)
  await clock.advance(2_000)
  expect(JSON.parse(w.files[PANEL]!).shown).toBe(false)
  expect(w.prompts).toHaveLength(0)
  await ui.unmount()
})

test('读取 runs 失败不是全部结束，不能在最后一个任务结束 12 秒时收起', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(4) })
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(4) })
  await clock.set(T0 + 14_000)
  w.failList = true
  await clock.advance(2_000)
  expect(JSON.parse(w.files[PANEL]!).shown).toBe(true)
  w.failList = false
  expect(w.logs.every(log => log.to === 'debug')).toBe(true)
  const incomplete = w.logs.map(log => JSON.parse(log.text)).find(log => log.event === 'refresh-incomplete')
  expect(incomplete.snapshot.complete).toBe(false)
  expect(incomplete.snapshot.errors[0]).toContain(ROOT)
  await clock.set(T0 + 34_000)
  expect(JSON.parse(w.files[PANEL]!).shown).toBe(false)
})

test('最后一个任务的 state 读取失败或 JSON 不完整时保留面板，不用不完整列表收起', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(-40) })
  const singlePath = `${ROOT}/s-1/state.json`
  const completed = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(4) })
  w.files[singlePath] = completed
  await clock.set(T0 + 14_000)
  w.failReads.push(singlePath)
  await clock.advance(2_000)
  expect(panel(w).shown).toBe(true)
  w.failReads = []
  w.files[singlePath] = '{'
  await clock.advance(2_000)
  expect(panel(w).shown).toBe(true)
  w.files[singlePath] = completed
  await clock.set(T0 + 34_000)
  expectPanel(w, false, 'auto-close', clock.now())
  expect(panel(w).snapshot?.complete).toBe(true)
  expect(panel(w).snapshot?.errors).toEqual([])
  expect(panel(w).snapshot?.runs.find(r => r.runId === 's-1')?.endedSeconds).toBe(30)
})

test('reload 同步当前 shown 而不是强制收起；记录来源但不画给用户', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const source = panel(w).source
  // 测试复派 session.start，只验证初始化钩子；不冒充真正的模块热重载。
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expectPanel(w, true, 'reload', clock.now())
  expect(panel(w).source).toEqual(source)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ text: /auto-open|reload|revision/ })).toBeUndefined()
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(4) })
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(4) })
  await clock.advance(2_000)
  await ui.press({ key: 'hide' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expectPanel(w, false, 'reload', clock.now())
  await ui.unmount()
})

test('lostSince 从第一次发现丢进程算满 30 秒才收起', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_200 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.alive = []
  await clock.advance(2_000) // 6.2 秒首次发现 lost
  await clock.set(T0 + 34_200)
  expect(panel(w).shown).toBe(true)
  await clock.set(T0 + 36_200)
  expectPanel(w, false, 'auto-close', clock.now())
  expect(panel(w).snapshot?.runs.find(r => r.runId === 's-1')?.endedSeconds).toBe(30)
})


test('没有 state.json 的目录不阻断初次打开、新任务和已有任务刷新，重复错误只记一次', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs.push('s-empty')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expectPanel(w, true, 'auto-open', T0 + 252_000)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  expect(panel(w).snapshot?.runs.some(r => r.runId === 's-empty')).toBe(false)
  w.dirs.push('s-new')
  w.alive.push(6161)
  w.files[`${ROOT}/s-new/state.json`] = JSON.stringify({ ...singleState, runId: 's-new', name: '新的 agent', pid: 6161 })
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, name: '更新的 agent' })
  await clock.advance(4_000)
  // 左栏 r-1、它的两个阶段、两个单发共 5 行，框内 4 行：新的 agent 在下一页
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '更新的 agent' })).toBeDefined()
  await ui.press({ key: 'more:left:down' })
  expect(await ui.find({ type: 'Button', key: 'r:s-new' })).toBeDefined()
  const errors = w.logs.map(log => JSON.parse(log.text)).filter(log => log.event === 'refresh-incomplete')
  expect(errors).toHaveLength(1)
  expect(errors[0].snapshot.errors[0]).toContain('s-empty')
  w.files[`${ROOT}/s-new/state.json`] = '{'
  await clock.advance(4_000)
  const nextErrors = w.logs.map(log => JSON.parse(log.text)).filter(log => log.event === 'refresh-incomplete')
  expect(nextErrors).toHaveLength(2)
  expect(nextErrors[1].snapshot.errors).toHaveLength(1)
  expect(nextErrors[1].snapshot.errors[0]).toContain('s-new')
  expect(w.logs.every(log => log.to === 'debug')).toBe(true)
  await ui.unmount()
})

test('一个运行读取失败、JSON 截断或字段不全时沿用好状态，其他运行仍刷新且每类错误只记一次', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const path = `${ROOT}/s-1/state.json`
  w.failReads.push(path)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, name: '更新的 flow' })
  await clock.advance(4_000)
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '单发测试' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:r-1', text: '更新的 flow' })).toBeDefined()
  w.failReads = []
  for (const invalid of ['{', JSON.stringify({ ...singleState, tasks: null }), 'null', JSON.stringify({ runId: 's-1', session: 'sess-1', status: 'completed' })]) {
    w.files[path] = invalid
    await clock.advance(4_000)
    expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '单发测试' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  }
  expect(w.logs.map(log => JSON.parse(log.text)).filter(log => log.event === 'refresh-incomplete')).toHaveLength(3)
  w.files[path] = JSON.stringify({ ...singleState, name: '恢复读取' })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '恢复读取' })).toBeDefined()
  await ui.unmount()
})

test('runs 不存在是尚未派任务，存在但列不出保留面板，恢复后继续刷新', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.rootExists = false
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect((await $.command.run(FLOW_CMD)).text).toBe('已在输入框上方打开 Codex 任务面板。如果只看到一行「▸ plugin panel hidden」，点一下它或按 ctrl+x ctrl+a 展开。')
  expect(panel(w).auto).toBe(false)
  expect(panel(w).snapshot?.complete).toBe(true)
  expect(panel(w).snapshot?.errors).toEqual([])
  expect(panel(w).snapshot?.runs).toEqual([])
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ text: '本会话还没有派出 Codex 任务。' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('关闭')
  await ui.press({ key: 'hide' })
  w.rootExists = true
  await clock.advance(2_000)
  expectPanel(w, true, 'auto-open', clock.now())
  w.failList = true
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, name: '恢复之后' })
  await clock.advance(4_000)
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '单发测试' })).toBeDefined()
  expect(panel(w).shown).toBe(true)
  expect(w.logs.map(log => JSON.parse(log.text)).filter(log => log.event === 'refresh-incomplete')).toHaveLength(1)
  w.failList = false
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '恢复之后' })).toBeDefined()
  await ui.unmount()
})

test('保留最新十条之外的所有在跑运行，历史只取十条，不误收起且仍发 15 分钟 toast', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 905_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  for (let i = 0; i < 12; i++) {
    const id = `s-history-${i}`
    w.dirs.push(id)
    w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, status: 'completed', startedAt: iso(700 + i), endedAt: iso(800) })
  }
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const snapshot = panel(w).snapshot!
  expect(snapshot.runs).toHaveLength(12)
  expect(snapshot.runs.filter(r => r.status === 'running')).toHaveLength(2)
  expect(snapshot.runs.some(r => r.runId === 'r-1')).toBe(true)
  expect(snapshot.runs.some(r => r.runId === 's-history-0' || r.runId === 's-history-1')).toBe(false)
  expect(w.prompts).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('「性能」')
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.advance(32_000)
  expect(panel(w).shown).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  await ui.unmount()
})

test('lost 恢复运行后再次丢进程，重新计满 30 秒才自动关闭', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2_200 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.alive = []
  await clock.advance(2_000) // 6.2 首次 lost
  w.alive = [4242, 5151]
  await clock.advance(2_000) // 8.2 恢复
  await clock.set(T0 + 68_200)
  expect(panel(w).shown).toBe(true)
  w.alive = []
  await clock.advance(2_000) // 70.2 再次 lost
  await clock.set(T0 + 98_200)
  expect(panel(w).shown).toBe(true)
  await clock.advance(2_000)
  expectPanel(w, false, 'auto-close', clock.now())
  expect(panel(w).snapshot?.runs.find(r => r.runId === 's-1')?.endedSeconds).toBe(30)
})

test('连续两次快速关闭再打开，慢的旧写入不会覆盖最新 shown/auto，文件写入串行', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-0']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  await $.command.run(FLOW_CMD)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const releases: (() => void)[] = []
  const records: PanelRecord[] = []
  w.beforePanelWrite = async text => {
    records.push(JSON.parse(text))
    await new Promise<void>(resolve => releases.push(resolve))
  }
  const close1 = ui.press({ key: 'hide' })
  await clock.settle()
  expect(records).toHaveLength(1)
  expect(records[0]!.shown).toBe(false)
  const open1 = $.command.run(FLOW_CMD)
  await clock.settle()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  expect(records).toHaveLength(1)
  const close2 = ui.press({ key: 'hide' })
  await clock.settle()
  const open2 = $.command.run(FLOW_CMD)
  await clock.settle()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  expect(records).toHaveLength(1)
  for (let i = 0; i < 4; i++) {
    expect(releases).toHaveLength(i + 1)
    releases[i]!()
    await clock.settle()
  }
  await Promise.all([close1, open1, close2, open2])
  expect(records).toHaveLength(4)
  // 后续排队写入应读当前 shown=true，而不是旧 close2 的参数 false。
  expect(records.slice(1).every(record => record.shown && !record.auto && record.by === 'command')).toBe(true)
  expectPanel(w, true, 'command', clock.now())
  expect(panel(w).auto).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  w.beforePanelWrite = undefined
  await ui.unmount()
})

// 测试 kit 返回的是树，不做终端排版；按本面板的行/列结构计算高度。
function drawnRows(node: unknown): number {
  if (typeof node === 'string') return node.split('\n').length
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.map(drawnRows).reduce((sum, n) => sum + n, 0)
  const el = node as { type: string; props?: Record<string, unknown>; children?: unknown[] }
  if (el.type !== 'Box') return 1
  const heights = (el.children ?? []).map(drawnRows)
  // 带边框的 Box 上下各多一行
  const border = el.props?.borderStyle ? 2 : 0
  return border + (el.props?.flexDirection === 'column' ? heights.reduce((sum, n) => sum + n, 0) : Math.max(0, ...heights))
}

const agentsState = (running = 0) => ({
  ...flowState,
  phases: [{ title: '审查', status: 'running' }, { title: '复核', status: 'pending' }],
  tasks: Array.from({ length: 20 }, (_, i) => ({
    ...flowState.tasks[1]!, label: `agent-${i}`, status: i === running ? 'running' : 'pending', tokens: null,
  })),
})

const mountAt = async ($: Parameters<TestBody>[0], requestId: string, maxRows = 24) =>
  $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: { ...(PROPS as object), maxRows } as never })
const personFocus = ($: Parameters<TestBody>[0], requestId: string) => (element: string) =>
  $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element, origin: { kind: 'person' } })

for (const maxRows of [24, 6]) {
  test(`20 个 agent 按 maxRows=${maxRows} 分窗口：框内最多 4 行，翻页提示在下边线右侧，↑↓ 走出可见范围时翻一项；详情左栏也可翻页`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 252_000 })
    const w = world(on)
    w.dirs = ['r-1']
    w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)
    const requestId = `agents-${maxRows}`
    const ui = await mountAt($, requestId, maxRows)
    const focus = personFocus($, requestId)
    const size = Math.min(4, maxRows - 4)
    expect(await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).toHaveLength(size)
    expect(await ui.find({ type: 'Text', text: `1–${size} of 20 ` })).toBeDefined()
    expect(await ui.find({ key: 'more:agents:up' })).toBeUndefined()
    expect(drawnRows(await ui.drawn())).toBe(4 + size)
    // 焦点落到翻页按钮：往下翻一项，光标落到新露出的那一项
    await focus('more:agents:down')
    expect(await ui.find({ key: 't:r-1:agent-0' })).toBeUndefined()
    expect(await ui.find({ key: `t:r-1:agent-${size}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `2–${size + 1} of 20 ` })).toBeDefined()
    expect(await ui.find({ key: 'more:agents:up' })).toBeDefined()
    expect(w.windowStarts.agents).toBe(1)
    expect(w.focuses.at(-1)).toBe(`t:r-1:agent-${size}`)
    // 在可见的最后一项按 ↓（树序上落到下边线的按钮）：改成翻页
    await focus(`t:r-1:agent-${size}`)
    await focus('back')
    expect(w.windowStarts.agents).toBe(2)
    expect(w.focuses.at(-1)).toBe(`t:r-1:agent-${size + 1}`)
    // 在可见的第一项按 ↑（树序上落到左栏）：改成往上翻
    await focus('t:r-1:agent-2')
    await focus('p:复核')
    expect(w.windowStarts.agents).toBe(1)
    expect(w.focuses.at(-1)).toBe('t:r-1:agent-1')
    expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await focus('more:agents:up')
    expect(await ui.find({ key: 't:r-1:agent-0' })).toBeDefined()
    // 详情：左栏是这个阶段的 agent，同样翻页
    await ui.press({ key: 't:r-1:agent-0' })
    const detail = Math.min(12, maxRows - 4)
    expect(await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).toHaveLength(detail)
    expect(await ui.find({ key: 'more:detailAgents:down' })).toBeDefined()
    await focus('more:detailAgents:down')
    expect(await ui.find({ key: `a:r-1:agent-${detail}` })).toBeDefined()
    expect(w.focuses.at(-1)).toBe(`a:r-1:agent-${detail}`)
    expect(w.windowStarts.detailAgents).toBe(1)
    expect(await ui.find({ type: 'Text', text: `agent-${detail} · ${detail + 1}/20` })).toBeDefined()
    expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await ui.unmount()
  })
}

test('左栏 20 个阶段：窗口可上下移动，聚焦窗口内的项不跳，离开时只移到刚好看得到；Enter 进右栏后返回仍看得到所选阶段', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState,
    phases: Array.from({ length: 20 }, (_, i) => ({ title: `phase-${i}`, status: i === 0 ? 'running' : 'pending' })),
    tasks: Array.from({ length: 20 }, (_, i) => ({ ...flowState.tasks[1], label: `agent-${i}`, phase: `phase-${i}` })),
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'phases-window'
  const ui = await mountAt($, requestId, 10)
  const focus = personFocus($, requestId)
  const visible = async () => (await ui.findAll({ type: 'Button', text: /^phase-\d+$/ })).map(row => row.text)
  expect(await visible()).toEqual(['phase-0', 'phase-1', 'phase-2', 'phase-3'])
  // 左栏的翻页提示在下边线左段
  expect(await ui.find({ type: 'Text', text: '1–4 of 20 ' })).toBeDefined()
  await ui.press({ key: 'more:left:down' })
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  expect(w.windowStarts.left).toBe(1)
  expect(w.focuses.at(-1)).toBe('p:phase-4')
  expect(await ui.find({ type: 'Text', text: 'phase-4 · 1 agent' })).toBeDefined()
  await focus('p:phase-3')
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  expect(await ui.find({ type: 'Text', text: 'phase-3 · 1 agent' })).toBeDefined()
  await clock.advance(2_000)
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  await focus('p:phase-5')
  expect(await visible()).toEqual(['phase-2', 'phase-3', 'phase-4', 'phase-5'])
  expect(w.windowStarts.left).toBe(2)
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await ui.press({ key: 'p:phase-5' })
  expect(w.focuses.at(-1)).toBe('t:r-1:agent-5')
  expect(await ui.find({ type: 'Button', key: 'more:left:up' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(w.focuses.at(-1)).toBe('p:phase-5')
  expect(await ui.find({ key: 'p:phase-5' })).toBeDefined()
  await ui.unmount()
})

test('15 个在跑的单发任务：左栏按 4 行分窗口，高度变小时缩到可用行数，选中的仍可见；Enter 进右栏后返回仍在原处', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = Array.from({ length: 15 }, (_, i) => `single-${i}`)
  for (const [i, id] of w.dirs.entries()) w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, name: id, startedAt: iso(200 - i) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'runs-window'
  const ui = await mountAt($, requestId)
  const focus = personFocus($, requestId)
  expect(await ui.findAll({ type: 'Button', text: /^single-\d+$/ })).toHaveLength(4)
  expect(await ui.find({ type: 'Text', text: 'Codex · 15 个运行' })).toBeDefined()
  await focus('more:left:down')
  expect(await ui.find({ key: 'r:single-0' })).toBeUndefined()
  expect(await ui.find({ key: 'r:single-4' })).toBeDefined()
  expect(w.focuses.at(-1)).toBe('r:single-4')
  // 光标落到运行上就选中它：右栏换成它的 agent
  expect(await ui.find({ key: 't:single-4:单发测试' })).toBeDefined()
  await ui.redraw({ ...(PROPS as object), maxRows: 6 } as never)
  expect(await ui.findAll({ type: 'Button', text: /^single-\d+$/ })).toHaveLength(2)
  expect(await ui.find({ key: 'r:single-4' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(6)
  await ui.press({ key: 'r:single-4' })
  expect(w.focuses.at(-1)).toBe('t:single-4:单发测试')
  await ui.press({ key: 'back' })
  expect(w.focuses.at(-1)).toBe('r:single-4')
  expect(await ui.find({ key: 'r:single-4' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(6)
  await ui.unmount()
})

for (const maxRows of [6, 8]) {
  test(`maxRows=${maxRows}：几个运行和 flow 各层翻页后总行数仍不超限`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 252_000 })
    const w = world(on)
    w.dirs = ['r-1', ...Array.from({ length: 15 }, (_, i) => `single-${i}`)]
    w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...agentsState(),
      phases: Array.from({ length: 20 }, (_, i) => ({ title: i === 0 ? '审查' : `phase-${i}`, status: i === 0 ? 'running' : 'pending' })),
    })
    for (const [i, id] of w.dirs.slice(1).entries()) w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, name: id, startedAt: iso(-i - 1) })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)
    const ui = await mountAt($, `rows-${maxRows}`, maxRows)
    const checkRows = async () => expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await checkRows()
    await ui.press({ key: 'more:left:down' })
    await checkRows()
    expect(await ui.find({ key: 'more:left:up' })).toBeDefined()
    // 翻页时光标落到新露出的阶段上、选中了它；翻回去后在「审查」上 Enter 进右栏
    await ui.press({ key: 'more:left:up' })
    await ui.press({ key: 'p:审查' })
    await checkRows()
    await ui.press({ key: 'more:agents:down' })
    await checkRows()
    expect(await ui.find({ key: 'more:agents:up' })).toBeDefined()
    expect(await ui.find({ key: 'more:agents:down' })).toBeDefined()
    await ui.press({ key: 'more:agents:up' })
    await ui.press({ key: 't:r-1:agent-0' })
    await checkRows()
    await ui.press({ key: 'more:detailAgents:down' })
    await checkRows()
    await ui.unmount()
  })
}

test('maxRows=0–5 放不下整块时，两栏视图和详情都能绘制且不超限：先省第二行文字，再省边线，只剩一行时只有名字和统计', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const checkHeights = async () => {
    for (const maxRows of [0, 1, 2, 3, 4, 5]) {
      await ui.redraw({ ...(PROPS as object), maxRows } as never)
      expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
      expect(!!(await ui.find({ type: 'Text', text: /^╭$/ }))).toBe(maxRows >= 4)
      if (maxRows) expect(await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })).toBeDefined()
    }
    await ui.redraw(PROPS)
  }
  await checkHeights()
  await ui.press({ key: 'r:r-1' })
  await checkHeights()
  await ui.press({ key: 't:r-1:agent-0' })
  await checkHeights()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'r:s-1' })
  await checkHeights()
  await ui.unmount()
})

test('看子代理的对话时面板让出位置，回到主对话再出现，任务和状态不变', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  await ui.redraw({ ...(PROPS as object), view: { agentId: 'agent-7' } } as never)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeUndefined()
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeUndefined()
  await ui.redraw(PROPS)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  await ui.unmount()
})

test('flow 和单个 agent 同时在左栏时 flow 固定在上，同类里新的在上，任务结束不挪位置', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  // 单阶段的 flow：左栏只有四个运行，一页放得下
  const onePhase = { ...flowState, phases: [flowState.phases[0]!], tasks: flowState.tasks.slice(0, 2) }
  w.dirs = ['r-1', 's-1', 'r-3', 's-2']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(onePhase)
  w.files[`${ROOT}/r-3/state.json`] = JSON.stringify({ ...onePhase, runId: 'r-3', name: '新的 flow', startedAt: iso(100) })
  w.files[`${ROOT}/s-2/state.json`] = JSON.stringify({ ...singleState, runId: 's-2', name: '早的单发', startedAt: iso(-100) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const order = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('r:'))
  // 单发 s-1 比两个 flow 都新，仍排在 flow 下面
  expect(await order()).toEqual(['r:r-3', 'r:r-1', 'r:s-1', 'r:s-2'])
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, status: 'completed', endedAt: iso(250), tasks: [{ ...singleState.tasks[0], status: 'completed', endedAt: iso(250) }] })
  await clock.advance(2_000)
  expect(await order()).toEqual(['r:r-3', 'r:r-1', 'r:s-1', 'r:s-2'])
  await ui.unmount()
})

test('高度随内容：两个 agent 时整块 6 行，四个 agent 8 行且全部显示；换阶段、刷新时高度不跳；输入框上方变矮时先省第二行文字，再省边线和按钮', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const props = (maxRows: number) => ({ ...(PROPS as object), maxRows }) as never
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: props(24) })
  expect(drawnRows(await ui.drawn())).toBe(6)
  await ui.press({ key: 'p:复核' })
  expect(drawnRows(await ui.drawn())).toBe(6)
  await ui.press({ key: 'p:审查' })
  await ui.press({ key: 'back' })
  await clock.advance(2_000)
  expect(drawnRows(await ui.drawn())).toBe(6)
  // 审查有四个 agent：框内 4 行，没有翻页
  const extra = ['可读性', '兼容'].map(label => ({ ...flowState.tasks[1], label, tokens: 1000 }))
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: [...flowState.tasks.slice(0, 2), ...extra, flowState.tasks[2]] })
  await clock.advance(2_000)
  expect(drawnRows(await ui.drawn())).toBe(8)
  for (const label of ['安全', '性能', '可读性', '兼容']) expect(await ui.find({ type: 'Button', text: label })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / of \d+ $/ })).toBeUndefined()
  // 只有一个 flow：标题是它的名字，左栏标题是「阶段」
  expect((await ui.find({ type: 'Text', text: 'review-api' }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: '阶段' })).toBeDefined()
  for (const rows of [7, 6, 5, 4]) {
    await ui.redraw(props(rows))
    expect(drawnRows(await ui.drawn())).toBe(rows)
    expect(await ui.find({ type: 'Text', text: /^╭$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  }
  await ui.redraw(props(3))
  expect(drawnRows(await ui.drawn())).toBe(3)
  expect(await ui.find({ type: 'Text', text: /^╭$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  await ui.unmount()
})

test('token 照 Claude Code 的口径合计在顶部：当前上下文加本次输出，不是每次调用输入的累计；旧记录退回累计值；agent 行不写 token，详情第一行写', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const tasks = flowState.tasks.map(t => (t.label === '性能' ? { ...t, tokens: 3_000_000, context: 180_000, output: 25_000 } : t))
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // 性能 180k + 25k，安全没有 context/output，仍按累计的 3000
  expect(await ui.find({ type: 'Text', text: /^1\/3 agents · 208k tok · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3M tok|205k tok/ })).toBeUndefined()
  await ui.press({ key: 'p:审查' })
  await ui.press({ key: 't:r-1:性能' })
  expect(await ui.find({ type: 'Text', text: /^6\.1-sol high · 205k tok · / })).toBeDefined()
  await ui.unmount()
})

test('看一个 flow 时又开了一个：左栏换成运行列表，选中的仍是原来的 flow，左栏没有返回键，右栏的返回回到左栏', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // 只有一个 flow：左栏是阶段，没有运行，也没有返回键
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  w.dirs = ['r-1', 'r-3']
  w.files[`${ROOT}/r-3/state.json`] = JSON.stringify({ ...flowState, runId: 'r-3', name: '第二个 flow', startedAt: iso(240) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:r-3' })).toBeDefined()
  // 仍选中 r-1：它的阶段列在它下面，❯ 在当前阶段上
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.press({ key: 'p:审查' })
  expect((await ui.find({ type: 'Button', key: 'back' }))?.props.label).toBe('返回')
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('几个运行时顶部写「Codex · N 个运行」（紫色粗体），右侧统计是全部运行的合计；只剩一行文字时名字和统计同一行', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, tasks: [{ ...singleState.tasks[0], context: 4000, output: 655 }] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const title = await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })
  expect(title?.props.color).toBe('suggestion')
  expect(title?.props.bold).toBe(true)
  // flow 3000 + 12345，单发 4000 + 655
  expect((await ui.find({ type: 'Text', text: /^1\/4 agents · 20k tok · \d+m\d{2}s$/ }))?.props.color).toBe('inactive')
  await ui.redraw({ ...(PROPS as object), maxRows: 2 } as never)
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\/4 agents · 20k tok/ })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBe(2)
  await ui.unmount()
})

test('别的会话里结束的 flow 被本会话续跑后出现在面板上；没改动的仍然跳过', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  const file = `${ROOT}/r-9/state.json`
  w.dirs = ['r-9']
  w.files[file] = JSON.stringify({ ...flowState, runId: 'r-9', name: '上次的 flow', session: 'sess-0', status: 'completed', startedAt: iso(-7200), endedAt: iso(-3600) })
  w.mtimes[file] = 1
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ text: /上次的 flow/ })).toBeUndefined()
  // 续跑改写 state.json：会话换成本会话、重新开始
  w.files[file] = JSON.stringify({ ...flowState, runId: 'r-9', name: '上次的 flow', startedAt: iso(250) })
  w.mtimes[file] = 2
  await clock.advance(2_000)
  expect(await ui.find({ text: /上次的 flow/ })).toBeDefined()
  await ui.unmount()
})

test('颜色只表达意思：运行中的阶段蓝色星形、agent 蓝色细点阵，完成绿色 ✓，没开始的阶段写暗灰序号，选中标记 ❯ 紫色；全部结束后停止转动', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  let frames = 0
  on('state.set', { plugin: 'codex-flow', key: 'frame' }, async ($, e, next) => {
    frames++
    return next(e)
  })
  w.dirs = w.dirs.filter(d => d !== 's-1')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const marks = async (pattern: RegExp) => (await ui.findAll({ type: 'Text', text: pattern })).map(t => [t.text, t.props.color])
  const spinners = async () => [...(await marks(STAR)), ...(await marks(DOTS))]
  expect((await marks(STAR)).length).toBe(1)
  expect((await marks(DOTS)).length).toBe(1)
  const first = await spinners()
  expect(first.every(([, color]) => color === 'ide')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^✓$/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^2$/ }))?.props.color).toBe('inactive')
  expect((await ui.find({ type: 'Text', text: /^❯$/ }))?.props.color).toBe('suggestion')
  // 名字、模型、时间之外不再用青色、黄色等颜色
  const colors = new Set((await ui.findAll({ type: 'Text' })).map(t => t.props.color).filter(Boolean))
  expect([...colors].every(c => ['suggestion', 'ide', 'success', 'error', 'inactive', 'subtle'].includes(String(c)))).toBe(true)
  // 标记随时间变化
  await clock.advance(120)
  const second = await spinners()
  expect(second.map(([c]) => c)).not.toEqual(first.map(([c]) => c))
  // 光标进右栏第一个 agent：第二行写它的任务说明
  await ui.press({ key: 'p:复核' })
  expect(await ui.find({ type: 'Text', text: '汇总复核：汇总' })).toBeDefined()
  expect((await spinners()).length).toBeGreaterThan(0)
  // 全部结束：不再有运行标记，帧数不再变化
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(254), phases: flowState.phases.map(p => ({ ...p, status: 'completed' })), tasks: flowState.tasks.map(t => ({ ...t, status: 'completed', endedAt: iso(254) })) })
  await clock.advance(2_000)
  expect((await spinners()).length).toBe(0)
  const framesBefore = frames
  await clock.advance(1_000)
  expect(frames).toBe(framesBefore)
  await ui.unmount()
})

test('agent 行的状态文字只取 state.json 里有的字段：查看中、改文件 N 次、验收中、验收 x/y、验收 x/y 未过（红色）、失败原因短写、已停止', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const base = flowState.tasks[1]!
  const tasks = [
    { ...base, label: 'a-看', activity: { commands: 1, edits: 0, messages: 0 } },
    { ...base, label: 'b-改', activity: { commands: 1, edits: 3, messages: 0 } },
    { ...base, label: 'c-验', checking: true, activity: { commands: 1, edits: 1, messages: 0 } },
    { ...base, label: 'd-过', status: 'completed', endedAt: iso(100), checks: ['a', 'b'], checkResults: [{ code: 0 }, { code: 0 }] },
    { ...base, label: 'e-没过', status: 'failed', endedAt: iso(100), checks: ['a', 'b', 'c'], checkResults: [{ code: 0 }, { code: 1 }], checkFailed: true, error: '验收未通过：b（exit 1）' },
    { ...base, label: 'f-起不来', status: 'failed', endedAt: iso(1), error: '启动失败：spawn codex ENOENT' },
    { ...base, label: 'g-停', status: 'cancelled', endedAt: iso(50), error: '已按要求停止' },
    { ...base, label: 'h-旧', status: 'completed', endedAt: iso(100), checks: ['a'] },
  ]
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, phases: [flowState.phases[0]], tasks })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountAt($, 'states', 24)
  const states: [string, string, string | undefined][] = []
  for (let i = 0; i < tasks.length; i++) {
    for (const t of await ui.findAll({ type: 'Text', text: /^(查看中|改文件|验收|完成|启动失败|已停止)/ })) states.push([t.text!.trim(), t.text!, t.props.color as string | undefined])
    await ui.press({ key: 'more:agents:down' }).catch(() => undefined)
  }
  const seen = new Map(states.map(([text, , color]) => [text, color]))
  expect(seen.get('查看中')).toBeUndefined()
  expect(seen.has('查看中')).toBe(true)
  expect(seen.has('改文件 3 次')).toBe(true)
  expect(seen.has('验收中')).toBe(true)
  expect(seen.get('验收 2/2')).toBe('inactive')
  expect(seen.get('验收 1/3 未过')).toBe('error')
  expect(seen.get('启动失败')).toBe('error')
  expect(seen.has('已停止')).toBe(true)
  // 有验收命令但没有 checkResults 的旧记录：取不到通过数，只写「完成」
  expect(seen.has('完成')).toBe(true)
  await ui.unmount()
})

test('时长从秒长到小时、token 从千长到百万时面板宽度不变；高度不够画边线时不留边线的竖线', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = w.dirs.filter(d => d !== 's-1')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const width = async () => { const root = await ui.drawn(); return 'props' in root ? (root.props as { width?: number }).width : undefined }
  const before = await width()
  expect(before).toBe(96)
  const grown = { ...flowState, startedAt: iso(-3600), tasks: flowState.tasks.map(t => (t.status === 'running' ? { ...t, startedAt: iso(-3600), tokens: 1_234_567 } : t)) }
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(grown)
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /1\.2M tok/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ *1h\d{2}m$/ })).toBeDefined()
  expect(await width()).toBe(before)
  expect((await ui.find({ type: 'Text', text: /^│ $/ }))?.props.color).toBe('subtle')
  await ui.redraw({ ...(PROPS as object), maxRows: 3 } as never)
  expect(await ui.find({ type: 'Text', text: /^│ $/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ │$/ })).toBeUndefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(3)
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  await ui.unmount()
})

test('按依赖提前开跑时几个阶段同时在跑：都画蓝色星形，默认看第一个，切换后看另一个阶段的 agent，宽度不变', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = w.dirs.filter(d => d !== 's-1')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const width = async () => { const root = await ui.drawn(); return 'props' in root ? (root.props as { width?: number }).width : undefined }
  const before = await width()
  expect((await ui.findAll({ type: 'Text', text: STAR })).length).toBe(1)
  const both = { ...flowState, phases: flowState.phases.map(p => ({ ...p, status: 'running' })), tasks: flowState.tasks.map(t => (t.label === '汇总复核' ? { ...t, status: 'running', startedAt: iso(200), tokens: 800 } : t)) }
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(both)
  await clock.advance(2_000)
  const stars = await ui.findAll({ type: 'Text', text: STAR })
  expect(stars.length).toBe(2)
  expect(stars.every(t => t.props.color === 'ide')).toBe(true)
  expect(await width()).toBe(before)
  expect(await ui.find({ type: 'Text', text: '审查 · 2 agents' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: DOTS })).length).toBe(1)
  await ui.press({ key: 'p:复核' })
  expect(await ui.find({ type: 'Text', text: '复核 · 1 agent' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: DOTS })).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: '汇总复核：汇总' })).toBeDefined()
  await ui.unmount()
})

test('agent 详情显示过程和累计数；运行中的 flow 任务有插话框，Enter 写进控制目录并换新框；验收中、已完成和单个 agent 没有插话框', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  const recent = [
    { id: 'c1', kind: 'cmd', text: 'rg --files', status: 'done' },
    { kind: 'edit', text: 'src/a.ts' },
    { id: 'c2', kind: 'cmd', text: 'npm test', status: 'running' },
    { kind: 'steer', text: '先看 a.ts' },
    { kind: 'note', text: '插话没有送达：turn 已结束' },
    { kind: 'msg', text: '第一行\n第二行' },
  ]
  const state = { ...flowState, tasks: flowState.tasks.map(t => (t.label === '性能' ? { ...t, recent, activity: { commands: 7, edits: 2, messages: 3 } } : t)) }
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(state)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // 左栏 Enter 运行：光标进右栏第一个 agent
  await ui.press({ key: 'r:r-1' })
  expect(w.focuses.at(-1)).toBe('t:r-1:安全')
  await ui.press({ key: 't:r-1:性能' })
  // 进详情后光标移到详情左栏的同一个 agent（另一套键，等新树画出来再落）；返回时回到右栏的它
  expect(w.focuses.at(-1)).toBe('a:r-1:性能')
  await ui.press({ key: 'back' })
  expect(w.focuses.at(-1)).toBe('t:r-1:性能')
  await ui.press({ key: 't:r-1:性能' })
  expect(await ui.find({ text: '过程  命令 7 · 改文件 2 次 · 消息 3' })).toBeDefined()
  // 正在跑的一步和执行器的说明用默认前景，其余暗灰；不再用蓝、青、黄
  expect((await ui.find({ type: 'Text', text: '$ npm test' }))?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '$ rg --files' }))?.props.color).toBe('inactive')
  expect((await ui.find({ type: 'Text', text: '↪ 插话：先看 a.ts' }))?.props.color).toBe('inactive')
  expect((await ui.find({ type: 'Text', text: '! 插话没有送达：turn 已结束' }))?.props.color).toBeUndefined()
  // 带换行的步骤压成一行，不撑破行数
  expect(await ui.find({ type: 'Text', text: '› 第一行 第二行' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'steer:r-1:性能:0' })).toBeDefined()
  // Enter 发送：去掉首尾空白写进控制目录，换一个空的新框；只有空白时不发
  await ui.input({ key: 'steer:r-1:性能:0', text: '  也看看缓存  ' })
  const sent = controlWrites(w).at(-1)!
  expect(sent).toMatch(/^\/home\/me\/\.claude\/codex-flow\/runs\/r-1\/control\/性能\.steer\.\d+\.txt$/)
  expect(w.files[sent]).toBe('也看看缓存')
  expect(w.toasts.at(-1)).toContain('送达后出现在「过程」里')
  expect(await ui.find({ type: 'Input', key: 'steer:r-1:性能:1' })).toBeDefined()
  await ui.input({ key: 'steer:r-1:性能:1', text: '   ' })
  expect(controlWrites(w).at(-1)).toBe(sent)
  // 写不进控制目录时提示，输入框不换新
  w.failWrites = /\.steer\./
  await ui.input({ key: 'steer:r-1:性能:1', text: '写不进去' })
  w.failWrites = undefined
  expect(w.toasts.at(-1)).toContain('插话没有写入')
  expect(await ui.find({ type: 'Input', key: 'steer:r-1:性能:1' })).toBeDefined()
  // Codex 已结束（还没进入验收）时不再给插话框
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...state, tasks: state.tasks.map(t => (t.label === '性能' ? { ...t, turnEnded: true } : t)) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  // 已完成的 agent 没有插话框
  await ui.press({ key: 'a:r-1:安全' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  // 验收中：写明在跑验收命令，插话框收起
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...state, tasks: state.tasks.map(t => (t.label === '性能' ? { ...t, checking: true } : t)) })
  await clock.advance(2_000)
  await ui.press({ key: 'a:r-1:性能' })
  expect(await ui.find({ text: '验收中：Codex 已结束，正在跑验收命令。' })).toBeDefined()
  expect(await ui.find({ text: /验收中$/ })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  // 单个 agent 由 run.sh 跑，收不到插话
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'r:s-1' })
  await ui.press({ key: 't:s-1:单发测试' })
  expect(await ui.find({ text: '单个任务' })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()
})

test('光标按树序走时两处改道：右栏第一项按 ↑ 回到当前阶段，插话框按 ↑ 回到当前 agent；落到停止键时仍停选中的 agent', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: flowState.tasks.map(t => (t.label === '安全' ? { ...t, status: 'running', endedAt: undefined, result: undefined, reused: false } : t)) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'ring'
  const ui = await mountAt($, requestId)
  const focus = personFocus($, requestId)
  // 左栏 ↓ 到右栏第一个 agent：第二行写它的任务说明
  await focus('t:r-1:安全')
  expect(await ui.find({ type: 'Text', text: '安全：查安全问题' })).toBeDefined()
  // 再按 ↑，树序上是左栏最下面的「复核」，改落到当前阶段「审查」，右栏不换
  await focus('p:复核')
  expect(await ui.find({ type: 'Text', text: '审查 · 2 agents' })).toBeDefined()
  // 在左栏里 ↓ 照常换阶段
  await focus('p:复核')
  expect(await ui.find({ type: 'Text', text: '复核 · 1 agent' })).toBeDefined()
  // 右栏里光标移到停止键：x 停的仍是「性能」
  await focus('p:审查')
  await focus('t:r-1:性能')
  await focus('stop')
  expect((await ui.find({ type: 'Button', key: 'stop' }))?.props.label).toBe('停止')
  await ui.press({ key: 'stop' })
  expect(controlWrites(w).at(-1)).toBe(`${ROOT}/r-1/control/性能.stop`)
  // 详情：在当前 agent 上按 Enter 跳到插话框
  await ui.press({ key: 't:r-1:安全' })
  expect(await ui.find({ type: 'Text', text: '安全 · 1/2' })).toBeDefined()
  await ui.press({ key: 'a:r-1:安全' })
  expect(w.focuses.at(-1)).toBe('steer:r-1:安全:0')
  // 插话框按 ↑，树序上是左栏最后一个 agent「性能」，改回当前 agent，详情不换
  await focus('steer:r-1:安全:0')
  await focus('a:r-1:性能')
  expect(await ui.find({ type: 'Text', text: '安全 · 1/2' })).toBeDefined()
  // 从 agent 本身 ↓ 照常切换
  await focus('a:r-1:性能')
  expect(await ui.find({ type: 'Text', text: '性能 · 2/2' })).toBeDefined()
  await ui.unmount()
})

test('用 Fast 的模型名前标 ⚡，和模型名一起是暗灰：右栏、详情和单发 agent 都有，没用 Fast 的不标，面板宽度不变', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const width = async () => { const root = await ui.drawn(); return 'props' in root ? (root.props as { width?: number }).width : undefined }
  const before = await width()
  expect(await ui.find({ type: 'Text', text: /⚡/ })).toBeUndefined()
  // flow 里 sol 的 agent 由 Codex 回报用了 priority；单发只登记了请求（新开的 exec 核实不了），也算 Fast
  const sol = (t: (typeof flowState.tasks)[number]) => (t.model === 'gpt-6.1-sol' ? { ...t, serviceTier: 'priority', actualServiceTier: 'priority' } : t)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: flowState.tasks.map(sol) })
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...singleState, tasks: [{ ...singleState.tasks[0], serviceTier: 'priority' }] })
  await clock.advance(2_000)
  const bolts = async () => (await ui.findAll({ type: 'Text', text: /⚡/ }))
  // 右栏：两个 sol 的 agent 各一个闪电，都是暗灰
  expect(await bolts()).toHaveLength(2)
  expect((await bolts()).every(t => t.props.color === 'inactive' && /^⚡6\.1-sol high/.test(t.text ?? ''))).toBe(true)
  expect(await width()).toBe(before)
  // Codex 回报的 tier 不是 priority 时不标
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: flowState.tasks.map(t => ({ ...sol(t), ...(t.label === '安全' ? { actualServiceTier: 'default' } : {}) })) })
  await clock.advance(2_000)
  expect(await bolts()).toHaveLength(1)
  // astra 没用 Fast
  await ui.press({ key: 'p:复核' })
  expect(await bolts()).toHaveLength(0)
  // agent 详情的第一行
  await ui.press({ key: 'back' })
  await ui.press({ key: 'p:审查' })
  await ui.press({ key: 't:r-1:性能' })
  expect(await bolts()).toHaveLength(1)
  // 单个 agent 的行
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'r:s-1' })
  expect(await bolts()).toHaveLength(1)
  expect(await width()).toBe(before)
  await ui.unmount()
})

test('看一个 flow 时另一个结束：结束 30 秒后仍在左栏下方、画暗；面板关掉后不再列出，下一个任务自动打开时只列当前的', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  const second = { ...flowState, runId: 'r-3', name: '第二个 flow', startedAt: iso(240) }
  const finished = (state: typeof flowState, at: number) => ({
    ...state, status: 'completed', endedAt: iso(at),
    phases: state.phases.map(p => ({ ...p, status: 'completed' })),
    tasks: state.tasks.map(t => ({ ...t, status: 'completed', startedAt: t.startedAt ?? iso(at - 10), endedAt: iso(at) })),
  })
  w.dirs = ['r-1', 'r-3']
  w.files[`${ROOT}/r-3/state.json`] = JSON.stringify(second)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'r:r-1' })
  // 第二个 flow 结束：过了 30 秒仍在左栏
  w.files[`${ROOT}/r-3/state.json`] = JSON.stringify(finished(second, 255))
  await clock.advance(42_000)
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个运行' })).toBeDefined()
  const rows = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(k => k.startsWith('r:'))
  expect(rows).toEqual(['r:r-1', 'r:r-3'])
  expect((await ui.find({ type: 'Button', key: 'r:r-3' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'r:r-1' }))?.props.dimColor).toBeUndefined()
  // 看已结束的那个时又开了新任务：不跳走
  await ui.press({ key: 'back' })
  await ui.press({ key: 'r:r-3' })
  w.dirs = ['r-1', 'r-3', 'r-4']
  w.files[`${ROOT}/r-4/state.json`] = JSON.stringify({ ...flowState, runId: 'r-4', name: '第三个 flow', startedAt: iso(290) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: 'Codex · 3 个运行' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 't:r-3:安全' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'back' }))?.props.label).toBe('返回')
  // 全部结束 30 秒后面板自动收起；下一个任务自动打开时只列当前的，只有它一个就直接是它的阶段，没有返回键
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(finished(flowState, 300))
  w.files[`${ROOT}/r-4/state.json`] = JSON.stringify(finished({ ...flowState, runId: 'r-4', name: '第三个 flow', startedAt: iso(290) }, 300))
  await clock.advance(40_000)
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
  w.dirs = ['r-1', 'r-3', 'r-4', 'r-5']
  w.files[`${ROOT}/r-5/state.json`] = JSON.stringify({ ...flowState, runId: 'r-5', name: '第四个 flow', startedAt: iso(340) })
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: '第四个 flow' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Codex · / })).toBeUndefined()
  await ui.unmount()
})


// ---- 桌面端竖排版面 ----

const DESK_PROPS = { ...(PROPS as object), maxRows: 12 } as never
const mountDesk = ($: Parameters<TestBody>[0], props: never = DESK_PROPS) => $.ui.mount({ plugin: 'codex-flow', surface: 'desktop', component: 'AbovePrompt', props })
// 审查阶段三个 agent：完成、在跑（有最近几步）、失败；复核阶段一个在等
const deskFlow = (extra: Partial<typeof flowState> = {}) => ({
  ...flowState,
  tasks: [
    { ...flowState.tasks[0]!, serviceTier: 'priority', actualServiceTier: 'priority' },
    {
      ...flowState.tasks[1]!, serviceTier: 'priority', actualServiceTier: 'priority',
      recent: [{ kind: 'cmd', text: 'rg --files', status: 'completed' }, { kind: 'edit', text: 'src/a.ts' }, { kind: 'cmd', text: 'npm test', status: 'running' }],
      activity: { commands: 7, edits: 1, messages: 0 },
    },
    { label: '可读性', phase: '审查', model: 'gpt-6-astra', effort: 'xhigh', brief: '查可读性', status: 'failed', startedAt: iso(0), endedAt: iso(164), error: '超时：超过 150 秒没有输出', tokens: null },
    flowState.tasks[2]!,
  ],
  ...extra,
})
const texts = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }, q: object = { type: 'Text' }) => (await ui.findAll(q)).map(t => t.text ?? '')

test('桌面端 flow 页：名字默认色加粗、右侧统计写总数与 token；阶段竖排，展开的阶段淡底并缩进列出 agent，没有进度字样和第二行说明', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(deskFlow())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountDesk($)

  const name = await ui.find({ type: 'Text', text: 'review-api' })
  expect(name?.props.bold).toBe(true)
  expect(name?.props.color).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^4 agents · 15\.3k tok · 4m\d\ds$/ })).toBeDefined()
  // 终端的写法不出现：完成/总数、框线、栏标题、列名、「Codex · N」、状态字样、复用
  const all = await texts(ui)
  expect(all.some(t => /\d\/\d|[╭╮╰╯│─]|Codex ·|^Agent$|运行中|^完成|^等待|复用|查安全问题/.test(t))).toBe(false)

  // 阶段竖排：在跑的审查展开（正文色、▾），复核收起（次要色、▸）
  const open = await ui.find({ type: 'Button', key: 'p:审查' })
  const closed = await ui.find({ type: 'Button', key: 'p:复核' })
  expect(open?.props.dimColor).toBeUndefined()
  expect(closed?.props.dimColor).toBe(true)
  expect(all).toContain('▾')
  expect(all).toContain('▸')
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor === 'rgba(127,127,127,0.08)')).toHaveLength(1)
  // 展开的只有审查的 agent；运行中的名字正文色，其余次要色
  expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 't:r-1:性能' }))?.props.dimColor).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 't:r-1:安全' }))?.props.dimColor).toBe(true)

  // 每个阶段一个进度格（一个 Svg）：审查有在跑的，会动；复核全是等待，不需要动
  const svgs = await ui.findAll({ type: 'Svg' })
  const grids = svgs.filter(s => /^\d+\/\d+ 完成$/.test(String(s.props.alt)))
  expect(grids.map(g => String(g.props.source).match(/<rect /g)?.length)).toEqual([3, 1])
  expect(grids.map(g => g.props.isInteractive)).toEqual([true, undefined])
  // agent 标记：完成灰色勾（path）、运行中呼吸蓝块、失败红块
  const mark = (alt: string) => svgs.filter(s => s.props.alt === alt)
  expect(String(mark('完成')[0]?.props.source)).toContain('<path')
  expect(mark('运行中')[0]?.props.isInteractive).toBe(true)
  expect(String(mark('运行中')[0]?.props.source)).toContain('<animate')
  expect(String(mark('失败')[0]?.props.source)).toContain('#e5484d')

  // 模型 effort 暗灰，Fast 的后面一个灰色小闪电，astra 没用 Fast；失败写原因（error 色）；耗时靠右；没有「⚡」字符
  expect((await ui.findAll({ type: 'Text', text: '6.1-sol high' })).every(t => t.props.color === 'subtle')).toBe(true)
  expect(svgs.filter(s => s.props.alt === 'Fast')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '6-astra xhigh' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '· 失败：超时' }))?.props.color).toBe('error')
  // 复用的 agent 耗时是上次的，不写；在跑的写这次的耗时
  expect(await ui.find({ type: 'Text', text: '3m10s' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^4m\d\ds$/ })).toBeDefined()
  expect(all.some(t => /⚡/.test(t))).toBe(false)

  // 按钮在最下一行：停止统一写「停止」，没有返回；在跑时没有关闭
  expect((await ui.find({ type: 'Button', key: 'stop' }))?.props.label).toBe('停止')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
  // 切到复核：只展开它，agent 换成汇总复核，等待是空心框；在阶段层停止仍停整个 flow
  await ui.press({ key: 'p:复核' })
  expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 't:r-1:性能' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Svg' })).some(s => s.props.alt === '等待' && String(s.props.source).includes('fill="none"'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.press({ key: 'stop' })
  expect(w.killed.at(-1)).toEqual(['kill', '-TERM', '4242'])
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(12)
  await ui.unmount()
})

test('桌面端 agent 详情：一行标题、缩进的任务说明；运行中只有最近一步一行；结束后是结果前几行加提示；失败写错误；没有插话框和过程计数', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const long = Array.from({ length: 9 }, (_, i) => `第${i + 1}条结论写得比较长一些方便占满一整行`).join('\n')
  w.files[`${ROOT}/r-1/results/安全.md`] = long
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(deskFlow())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountDesk($)

  // 在跑的：标题行（阶段 ›、名字、模型与 token、耗时），说明，最近一步（只有最后一步，无计数行）
  await ui.press({ key: 't:r-1:性能' })
  expect(await ui.find({ type: 'Text', text: '审查 ›' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '性能' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 12.3k tok' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '查性能问题' }))?.props.color).toBe('subtle')
  expect(await ui.find({ type: 'Text', text: '$ npm test' })).toBeDefined()
  const all = await texts(ui)
  expect(all.some(t => /rg --files|src\/a\.ts|命令 7|过程/.test(t))).toBe(false)
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  // 详情页没有 agent 列表，也没有阶段行
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
  await ui.press({ key: 'stop' })
  expect(controlWrites(w).at(-1)).toBe(`${ROOT}/r-1/control/性能.stop`)

  // 完成的：结果最多 4 行，超出的末行加「…」，再一行提示；没有停止键
  await ui.press({ key: 'back' })
  await ui.press({ key: 't:r-1:安全' })
  const lines = (await texts(ui)).filter(t => /^第\d条结论/.test(t.replace(/…$/, '')))
  expect(lines).toHaveLength(4)
  expect(lines[3]!.endsWith('…')).toBe(true)
  expect(lines.some(l => l.startsWith('第5条'))).toBe(false)
  expect((await ui.find({ type: 'Text', text: '完整结果由 Claude 在对话里汇报' }))?.props.color).toBe('subtle')
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(12)

  // 失败的：错误用 error 色，不写结果提示
  await ui.press({ key: 'back' })
  await ui.press({ key: 't:r-1:可读性' })
  expect((await ui.find({ type: 'Text', text: '超时：超过 150 秒没有输出' }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: '完整结果由 Claude 在对话里汇报' })).toBeUndefined()
  // 返回回到 flow 页，不是列表
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('桌面端几个任务同时列出：每个一行，类型小字 flow/agent，agent 带模型，按下进入该任务的页面，返回回到列表；单发 agent 页显示模型、说明和结果', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(deskFlow())
  const single = { ...singleState, startedAt: iso(100), tasks: [{ ...singleState.tasks[0]!, startedAt: iso(100), serviceTier: 'priority', tokens: 9600, recent: [{ kind: 'cmd', text: 'npm test -- orders.spec.ts' }] }] }
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify(single)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountDesk($)

  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个任务' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5 agents · 24\.9k tok · 4m\d\ds$/ })).toBeDefined()
  expect(await texts(ui)).toEqual(expect.arrayContaining(['flow', 'agent']))
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
  // 列表里没有阶段行；停止要进了某个任务再按，关闭在跑时没有
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  // 只有 agent 行写模型与闪电；flow 行的进度格是它的全部 agent，agent 行一格
  expect((await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'Fast')).toHaveLength(1)
  const grids = (await ui.findAll({ type: 'Svg' })).filter(s => /^\d+\/\d+ 完成$/.test(String(s.props.alt)))
  expect(grids.map(g => String(g.props.source).match(/<rect /g)?.length)).toEqual([4, 1])

  // 进单发 agent：粗体名字 + 右侧 token · 耗时，缩进的模型、说明、最近一步
  await ui.press({ key: 'r:s-1' })
  expect((await ui.find({ type: 'Text', text: '单发测试' }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^9\.6k tok · \d+m\d\ds$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '6.1-sol high' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '单个任务' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$ npm test -- orders.spec.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeUndefined()
  await ui.press({ key: 'stop' })
  expect(controlWrites(w).at(-1)).toBe(`${ROOT}/s-1/control/stop`)
  expect(w.killed.at(-1)).toEqual(['pkill', '-TERM', '-P', '5151'])
  // 结束后：结果前几行加提示
  w.files[`${ROOT}/s-1/results/out.md`] = '订单分页测试已补齐。'
  w.files[`${ROOT}/s-1/state.json`] = JSON.stringify({ ...single, status: 'completed', endedAt: iso(700), tasks: [{ ...single.tasks[0]!, status: 'completed', endedAt: iso(700), result: 'results/out.md' }] })
  await clock.advance(2_000)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'r:s-1' })
  expect(await ui.find({ type: 'Text', text: '订单分页测试已补齐。' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '完整结果由 Claude 在对话里汇报' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()

  // 返回回到列表；再进 flow，返回回到列表
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
  await ui.press({ key: 'r:r-1' })
  expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'review-api' })).toBeDefined()
  // 进了某个 flow 后停止停整个 flow
  await ui.press({ key: 'stop' })
  expect(w.killed.at(-1)).toEqual(['kill', '-TERM', '4242'])
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  await ui.unmount()
})

test('桌面端阶段与 agent 多到放不下：总行数不超过 12，阶段和展开的 agent 各占一部分并可翻页，翻页后仍不超限', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const state = agentsState()
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...state, phases: Array.from({ length: 8 }, (_, i) => ({ title: i === 0 ? '审查' : `阶段${i}`, status: i === 0 ? 'running' : 'pending' })) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'desk-window'
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'desktop', component: 'AbovePrompt', requestId, props: DESK_PROPS })
  const focus = personFocus($, requestId)
  const phases = async () => (await ui.findAll({ type: 'Button', text: /^(审查|阶段\d)$/ })).length
  const agents = async () => (await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).length
  // 12 行：顶部和底部各一行，剩 10 行；agent 至少占一半
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(12)
  expect(await phases()).toBe(5)
  expect(await agents()).toBe(5)
  expect(await ui.find({ type: 'Text', text: '1–5 of 8 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1–5 of 20 ' })).toBeDefined()
  // 往下翻 agent 一项，总行数不变
  await focus('more:agents:down')
  expect(await ui.find({ key: 't:r-1:agent-0' })).toBeUndefined()
  expect(await ui.find({ key: 't:r-1:agent-5' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(12)
  // 阶段列表翻页后展开的阶段不在窗口里，agent 随之不画，总行数仍不超限
  for (let i = 0; i < 4; i++) await focus('more:left:down')
  expect(await ui.find({ key: 'p:阶段5' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(12)
  await ui.unmount()
})

test('桌面端光标走阶段行只换展开的阶段，不退回列表；agent 紧接在阶段行下面，从阶段进 agent 不被当成翻页', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(deskFlow())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'desk-focus'
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'desktop', component: 'AbovePrompt', requestId, props: DESK_PROPS })
  const focus = personFocus($, requestId)
  await ui.press({ key: 'r:r-1' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await focus('p:复核')
  expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个任务' })).toBeUndefined()
  // 汇总复核是这个阶段唯一的 agent：从它往上、往下都不被改道回阶段行
  await focus('p:审查')
  await focus('t:r-1:安全')
  expect(await ui.find({ type: 'Button', key: 't:r-1:安全' })).toBeDefined()
  await focus('p:复核')
  await focus('t:r-1:汇总复核')
  await focus('back')
  expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeDefined()
  // 返回回到列表，光标落在刚才的运行上
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'Codex · 2 个任务' })).toBeDefined()
  expect(w.focuses.at(-1)).toBe('r:r-1')
  await ui.unmount()
})

// ---- 审查回归：提醒轮次、会话延续与不可见控件 ----

test('A 运行列表翻页后，聚焦窗口内另一个运行不改变窗口', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = Array.from({ length: 15 }, (_, i) => `single-${i}`)
  for (const [i, id] of w.dirs.entries()) w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, name: id, startedAt: iso(200 - i) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountAt($, 'review-A')
  const focus = personFocus($, 'review-A')
  await focus('more:left:down')
  await focus('more:left:down')
  const visible = async () => (await ui.findAll({ type: 'Button', text: /^single-\d+$/ })).map(b => b.text)
  expect(await visible()).toEqual(['single-2', 'single-3', 'single-4', 'single-5'])
  await focus('r:single-3')
  expect(w.windowStarts.left).toBe(2)
  expect(await visible()).toEqual(['single-2', 'single-3', 'single-4', 'single-5'])
  expect(await ui.find({ key: 't:single-3:单发测试' })).toBeDefined()
  await clock.advance(2_000)
  expect(await visible()).toEqual(['single-2', 'single-3', 'single-4', 'single-5'])
  await ui.unmount()
})

for (const maxRows of [24, 3]) {
  test(`B maxRows=${maxRows} 左栏翻页按钮未画出时，越过边界直接翻页并聚焦新项`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 252_000 })
    const w = world(on)
    w.dirs = ['r-1']
    const titles = 'abcdefghijkl'.split('')
    w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState,
      phases: titles.map((title, i) => ({ title, status: i === 0 ? 'running' : 'pending' })),
      tasks: titles.map((phase, i) => ({ ...flowState.tasks[1]!, label: `agent-${i}`, phase })),
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)
    const id = `review-B-${maxRows}`
    const ui = await mountAt($, id, maxRows)
    const focus = personFocus($, id)
    const size = maxRows === 3 ? 2 : 4
    expect(await ui.find({ key: 'more:left:down' })).toBeUndefined()
    await focus(`p:${titles[size - 1]}`)
    await focus(`t:r-1:agent-${size - 1}`)
    expect(w.landed.at(-1)).toBe(`p:${titles[size]}`)
    expect(await ui.find({ key: w.landed.at(-1) })).toBeDefined()
    expect(w.windowStarts.left).toBe(1)
    // 往上跨出窗口时同样直接翻页，不请求不存在的 ↑。
    await focus('p:b')
    await focus('stop')
    expect(w.landed.at(-1)).toBe('p:a')
    expect(w.windowStarts.left).toBe(0)
    await ui.unmount()
  })
}

test('B2 没有框线时右栏越过边界也直接翻页', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountAt($, 'review-B2', 3)
  const focus = personFocus($, 'review-B2')
  expect(await ui.find({ key: 'more:agents:down' })).toBeUndefined()
  await focus('t:r-1:agent-1')
  await focus('stop')
  expect(w.landed.at(-1)).toBe('t:r-1:agent-2')
  expect(await ui.find({ key: 't:r-1:agent-2' })).toBeDefined()
  expect(w.windowStarts.agents).toBe(1)
  await focus('t:r-1:agent-1')
  await focus('p:复核')
  expect(w.landed.at(-1)).toBe('t:r-1:agent-0')
  expect(w.windowStarts.agents).toBe(0)
  await ui.unmount()
})

test('C 同一 runId 续跑后再次失联，每轮只提醒一次', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.alive = []
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(1)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, pid: 4300, startedAt: iso(300) })
  w.alive = [4300]
  await clock.advance(2_000)
  w.alive = []
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(2)
})

test('C2 同一 runId 续跑后重新自动打开面板并重新弹时长 toast', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const state = { ...flowState, alertAfter: 100 }
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(state)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(panel(w).shown).toBe(true)
  expect(w.toasts).toHaveLength(1)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...state, status: 'failed', endedAt: iso(252), tasks: state.tasks.map(t => t.status === 'running' ? { ...t, status: 'failed', endedAt: iso(252) } : t) })
  await clock.advance(40_000)
  expect(panel(w).shown).toBe(false)
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...state, startedAt: iso(42), tasks: state.tasks.map(t => t.status === 'running' ? { ...t, startedAt: iso(42) } : t) })
  await clock.advance(4_000)
  expect(panel(w).shown).toBe(true)
  expect(panel(w).by).toBe('auto-open')
  // 两轮都在第二个阈值内；轮内刷新仍不重复。
  expect(w.toasts).toHaveLength(2)
})

test('D ps 非零退出且有错误时不报失联；pid 都不存在且没有错误时才提醒', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.psError = true
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(0)
  const ui = await mountAt($, 'review-D')
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  w.psError = false
  w.alive = []
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(1)
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
})

test('E 窄终端详情保留返回和停止及其快捷键', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: flowState.tasks.map(t => t.label === '性能' ? { ...t, label: 'perf-hotpath-review' } : t) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), bodyColumns: 44 } as never })
  await ui.press({ key: 't:r-1:perf-hotpath-review' })
  expect((await ui.find({ key: 'back' }))?.props.hotkey).toBe('b')
  expect((await ui.find({ key: 'stop' }))?.props.hotkey).toBe('x')
  await ui.press({ key: 'stop' })
  expect(controlWrites(w).at(-1)).toBe(`${ROOT}/r-1/control/perf-hotpath-review.stop`)
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 't:r-1:perf-hotpath-review' })).toBeDefined()
  await ui.unmount()
})

test('E2 窄终端多个运行加翻页时保留停止整个 flow 的快捷键', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  for (const bodyColumns of [104, 80, 64, 44]) {
    const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), bodyColumns } as never })
    expect((await ui.find({ key: 'stop' }))?.props.hotkey).toBe('x')
    await ui.press({ key: 'stop' })
    expect(w.killed.at(-1)).toEqual(['kill', '-TERM', '4242'])
    await ui.unmount()
  }
})

test('F 刷新异常写入 debug 日志且下次刷新可以恢复', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.failSessionId = true
  await clock.advance(2_000)
  const errors = w.logs.filter(log => JSON.parse(log.text).event === 'refresh-failed')
  expect(errors.length).toBeGreaterThan(0)
  expect(errors.every(log => log.to === 'debug' && JSON.parse(log.text).error.length > 0)).toBe(true)
  expect(w.toasts).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
  w.failSessionId = false
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(252) })
  await clock.advance(2_000)
  const ui = await mountAt($, 'review-F')
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
})

test('F2 动画同步和帧更新的异常只写 debug 日志', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  let failRuns = false
  let failFrame = false
  on('state.get', { plugin: 'codex-flow', key: 'runs' }, async ($, e, next) => {
    // 钩子抛错会被 kit 跳过，故返回损坏数据使动画同步本身抛错。
    if (failRuns) return { value: { value: null, version: 0 } } as never
    return next(e)
  })
  on('state.set', { plugin: 'codex-flow', key: 'frame' }, async ($, e, next) => {
    // 模拟宿主拒绝写入；update 重试到上限后会 reject。
    if (failFrame) return { value: { isSet: false, version: 0 } }
    return next(e)
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  w.failSessionId = true
  failRuns = true
  await clock.advance(2_000)
  const failures = () => w.logs.filter(log => log.to === 'debug' && JSON.parse(log.text).event === 'spinner-failed')
  expect(failures().length).toBeGreaterThan(0)
  const before = failures().length
  failRuns = false
  w.failSessionId = false
  failFrame = true
  await clock.advance(240)
  expect(failures().length).toBeGreaterThan(before)
  expect(failures().every(log => JSON.parse(log.text).error.length > 0)).toBe(true)
  expect(w.toasts).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
})

test('G 会话 ID 更换后旧会话任务仍显示、不会收起，失联仍提醒且不混入其他会话', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 'r-2']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountAt($, 'review-G')
  w.sessionId = 'sess-new'
  await clock.advance(42_000)
  expect(await ui.find({ key: 'p:审查' })).toBeDefined()
  expect(await ui.find({ text: 'someone-else' })).toBeUndefined()
  // /clear 没有 session.start；状态行下次状态变更使用新的会话文件。
  w.alive = []
  await clock.advance(4_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('review-api')
  await clock.advance(32_000)
  expect(JSON.parse(w.files['/home/me/.claude/codex-flow/panel-sess-new.json']!).shown).toBe(false)
  await ui.unmount()
})

test('G2 热重载已有的会话 ID 从宿主状态读取，新会话已结束记录重新纳入', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 'r-2']
  w.sessionId = 'sess-new'
  // 预置宿主 atom 值，模拟模块变量全新时已有的历史会话。
  let ids = ['sess-1']
  on('state.get', { plugin: 'codex-flow', key: 'sessions' }, async ($, e, next) => {
    const result = await next(e)
    return result.value?.value ? result : { value: { value: ids, version: result.value?.version ?? 0 } }
  })
  on('state.set', { plugin: 'codex-flow', key: 'sessions' }, async ($, e, next) => {
    ids = e.value
    return next(e)
  })
  w.files[`${ROOT}/r-2/state.json`] = JSON.stringify({ ...otherState, status: 'completed', endedAt: iso(252) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await mountAt($, 'review-G2')
  expect(await ui.find({ key: 'p:审查' })).toBeDefined()
  expect(ids).toEqual(['sess-1', 'sess-new'])
  // 这个 ID 之前被当成别的会话缓存，但进程现在已用过它；mtime 没变也要重读。
  w.sessionId = 'sess-2'
  await clock.advance(2_000)
  expect(await ui.find({ text: 'someone-else' })).toBeDefined()
  expect(ids).toEqual(['sess-1', 'sess-new', 'sess-2'])
  await ui.unmount()
})

test('H 桌面 maxRows=3 没有 agent 行就没有 agent 窗口、翻页或不可见焦点', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'desktop', component: 'AbovePrompt', requestId: 'review-H', props: { ...(PROPS as object), maxRows: 3 } as never })
  expect(await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).toHaveLength(0)
  expect(await ui.find({ key: 'more:agents:down' })).toBeUndefined()
  expect((await texts(ui)).some(t => /^agent |of 20/.test(t))).toBe(false)
  await ui.press({ key: 'p:审查' })
  expect(w.focuses.some(key => key.startsWith('t:'))).toBe(false)
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(3)
  await ui.unmount()
})
