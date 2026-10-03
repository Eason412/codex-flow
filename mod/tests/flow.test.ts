import { expect, mock, test } from 'claude-code/testing'
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

type World = { writes: string[]; prompts: string[]; toasts: string[]; logs: { text: string; to: string }[]; killed: string[][]; alive: number[]; files: Record<string, string>; mtimes: Record<string, number>; dirs: string[]; failList: boolean; rootExists: boolean; failReads: string[]; windowStarts: WindowStarts; focuses: string[]; beforeManualAutoSet?: () => Promise<void>; beforePanelWrite?: (text: string) => Promise<void> }

function world(on: On): World {
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
    windowStarts: { runs: 0, phases: 0, agents: 0, detailAgents: 0 },
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
  mock.env(on, { HOME: '/home/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.focus', () => ({}))
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
    w.writes.push(e.path)
    if (e.path === PANEL) await w.beforePanelWrite?.(e.text)
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'ps') return { value: { exitCode: 0, stdout: w.alive.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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

test('任务开始时面板自动出现在输入框上方：flow 紫色、agent 蓝色一行一个，flow 照 Workflow 详情面板逐层进入，单个 agent 直接看详情', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  // 自动打开，并告诉状态行让出 codex 那一行
  expectPanel(w, true, 'auto-open', T0 + 252_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'codex-flow', surface, component: 'AbovePrompt', props: PROPS })

    // 一个 flow、一个 agent 在跑：一行一个，类型标在名称前；早先跑完的、别的会话的都不显示，调试信息不给用户看
    expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^flow$/ }))?.props.color).toBe('#BB9AF7')
    expect((await ui.find({ type: 'Text', text: /^agent$/ }))?.props.color).toBe('#7AA2F7')
    expect(await ui.find({ text: /1 个 flow · 1 个 agent · 2 个运行中/ })).toBeDefined()
    expect(await ui.find({ text: '审查 1/2 · 15.3k tok' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'r:r-0' })).toBeUndefined()
    expect(await ui.find({ text: 'someone-else' })).toBeUndefined()
    expect(await ui.find({ text: /jsonl|4242/ })).toBeUndefined()

    // 进入 flow：名称紫色；左栏阶段可选，右栏是选中阶段的 agent，每行写模型、effort、token
    await ui.press({ key: 'r:r-1' })
    expect((await ui.find({ type: 'Text', text: /^review-api$/ }))?.props.color).toBe('#BB9AF7')
    expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()
    expect(await ui.find({ text: ' 审查 · 2 个 agent ' })).toBeDefined()
    expect(await ui.find({ text: '6.1-sol high · 12.3k tok' })).toBeDefined()
    expect(await ui.find({ text: '6.1-sol high · 3k tok' })).toBeDefined()
    expect(await ui.find({ text: '复用' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 't:r-1:性能' })).toBeUndefined()

    // Enter 阶段进入右栏选 agent；返回回到阶段栏
    await ui.press({ key: 'p:复核' })
    expect(await ui.find({ type: 'Button', key: 't:r-1:汇总复核' })).toBeDefined()
    expect(await ui.find({ text: '6-astra high · 等「审查」' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'p:审查' })).toBeDefined()

    // Enter agent 进详情：右栏是结果，左栏可以换 agent
    await ui.press({ key: 'p:审查' })
    await ui.press({ key: 't:r-1:安全' })
    expect(await ui.find({ text: ' 安全 · 1/2 ' })).toBeDefined()
    expect(await ui.find({ text: '没有发现注入问题。' })).toBeDefined()
    // 已完成的 agent 没有停止键
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
    await ui.press({ key: 't:r-1:性能' })
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    expect(await ui.find({ text: '运行中，结果出来后显示在这里。' })).toBeDefined()
    await ui.press({ key: 'stop' })
    expect(controlWrites(w).at(-1)).toBe(`${ROOT}/r-1/control/性能.stop`)

    // 退到阶段栏，x 停整个 flow
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'stop' })
    expect(w.killed.at(-1)).toEqual(['kill', '-TERM', '4242'])

    // 退到列表；单个 agent 直接进详情：名称蓝色，标题行写模型、effort、状态
    await ui.press({ key: 'back' })
    await ui.press({ key: 'r:s-1' })
    expect((await ui.find({ type: 'Text', text: /^单发测试$/ }))?.props.color).toBe('#7AA2F7')
    expect(await ui.find({ text: /6\.1-sol high · 运行中/ })).toBeDefined()
    expect(await ui.find({ text: '单个任务' })).toBeDefined()
    expect(await ui.find({ text: '运行中，结果出来后显示在这里。' })).toBeDefined()
    // 停止时先写停止标记再结束 run.sh 下面的 codex
    await ui.press({ key: 'stop' })
    expect(controlWrites(w).at(-1)).toBe(`${ROOT}/s-1/control/stop`)
    expect(w.killed.at(-1)).toEqual(['pkill', '-TERM', '-P', '5151'])
    // 返回直接回列表
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()

    // 在跑时不能彻底关闭；两种 surface 均保持面板显示。
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
    expect(panel(w).shown).toBe(true)
    await ui.unmount()
  }

  // 同一批任务继续显示；新任务开始也显示在列表中
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
  expect(await ui.find({ text: /全部结束/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeUndefined()
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

test('任务每跑满 15 分钟在对话里提醒一次，不重复、不停任务', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(w.prompts).toHaveLength(0)

  await clock.set(T0 + 905_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('Codex 任务「性能」（review-api，gpt-6.1-sol high）已运行 15m')
  expect(w.prompts[0]).toContain('不要自动停止')
  expect(w.prompts[0]).toContain(`${ROOT}/r-1/logs/性能.jsonl`)

  await clock.advance(60_000)
  expect(w.prompts).toHaveLength(1)
  expect(controlWrites(w)).toHaveLength(0)
  expect(w.killed).toHaveLength(0)

  // 主对话在忙时不提醒；空闲后按当时的时长提醒
  await $.turn.start({ text: '', turnId: 't-1' })
  await clock.set(T0 + 1_805_000)
  expect(w.prompts).toHaveLength(1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't-1', reason: 'answer' } as never)
  await clock.advance(2_000)
  // 空闲后一次补上：性能满 30 分钟，单发任务（第 600 秒开始）满 15 分钟
  expect(w.prompts).toHaveLength(3)
  expect(w.prompts.some(p => p.includes('「性能」') && p.includes('已运行 30m'))).toBe(true)
  expect(w.prompts.some(p => p.includes('「单发测试」') && p.includes('已运行 20m'))).toBe(true)

  // 进程已经不在：记为已退出，不再提醒
  w.alive = []
  await clock.set(T0 + 2_710_000)
  expect(w.prompts).toHaveLength(3)
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
  expect(await ui.find({ type: 'Button', key: 'r:s-new' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:s-1', text: '更新的 agent' })).toBeDefined()
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

test('保留最新十条之外的所有在跑运行，历史只取十条，不误收起且仍发 15 分钟提醒', async ($, on) => {
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
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('「性能」')
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.advance(32_000)
  expect(panel(w).shown).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'r:r-1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'r:s-1' })).toBeDefined()
  expect(await ui.find({ text: /2 个运行中/ })).toBeDefined()
  expect(await ui.find({ text: /全部结束/ })).toBeUndefined()
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

for (const maxRows of [24, 10]) {
  test(`20 个 agent 按 maxRows=${maxRows} 分窗口，焦点翻一项、详情左栏也可翻页`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 252_000 })
    const w = world(on)
    w.dirs = ['r-1']
    w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(agentsState())
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)
    const requestId = `agents-${maxRows}`
    const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: { ...(PROPS as object), maxRows } as never })
    await ui.press({ key: 'p:审查' })
    const size = Math.min(12, maxRows - 6)
    expect(await ui.findAll({ type: 'Button', key: undefined, text: /^agent-\d+$/ })).toHaveLength(size)
    expect((await ui.find({ key: 'more:agents:down' }))?.text).toBe(`↓ 还有 ${20 - size} 个`)
    expect(await ui.find({ key: `t:r-1:agent-${size}` })).toBeUndefined()
    expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:agents:down', origin: { kind: 'person' } })
    expect(await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).toHaveLength(size)
    expect(await ui.find({ key: 't:r-1:agent-0' })).toBeUndefined()
    expect(await ui.find({ key: `t:r-1:agent-${size}` })).toBeDefined()
    expect((await ui.find({ key: 'more:agents:up' }))?.text).toBe('↑ 还有 1 个')
    expect(w.windowStarts.agents).toBe(1)
    expect(w.focuses.at(-1)).toBe(`t:r-1:agent-${size}`)
    expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:agents:up', origin: { kind: 'person' } })
    expect(await ui.find({ key: 't:r-1:agent-0' })).toBeDefined()
    expect(w.focuses.at(-1)).toBe('t:r-1:agent-0')
    await ui.press({ key: 't:r-1:agent-0' })
    expect(await ui.find({ key: 'more:detailAgents:down' })).toBeDefined()
    await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:detailAgents:down', origin: { kind: 'person' } })
    expect(await ui.find({ key: `t:r-1:agent-${size}` })).toBeDefined()
    expect(w.focuses.at(-1)).toBe(`t:r-1:agent-${size}`)
    expect(w.windowStarts.detailAgents).toBe(1)
    expect(await ui.find({ text: ` agent-${size} · ${size + 1}/20 ` })).toBeDefined()
    await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: `t:r-1:agent-${size}`, origin: { kind: 'plugin', name: 'codex-flow' } })
    expect(await ui.findAll({ type: 'Button', text: /^agent-\d+$/ })).toHaveLength(size)
    expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await ui.unmount()
  })
}

test('阶段栏右侧只画暗色「还有」，运行项在窗口内；切换阶段重置起点', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  const state = agentsState(18)
  state.tasks.push(...agentsState().tasks.map(t => ({ ...t, phase: '复核' })))
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify(state)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'passive-agents'
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: PROPS })
  expect(await ui.findAll({ type: 'Button', text: /还有/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Text', text: /^agent-\d+$/ })).toHaveLength(12)
  expect((await ui.find({ type: 'Text', text: /^agent-18$/ }))?.props.dimColor).toBe(false)
  const more = await ui.findAll({ type: 'Text', text: /还有 \d+ 个/ })
  expect(more).toHaveLength(2)
  expect(more.every(row => row.props.dimColor === true)).toBe(true)
  expect(w.windowStarts.agents).toBe(7)
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'p:复核', origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: /^agent-0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↑ 还有/ })).toBeUndefined()
  expect(w.windowStarts.agents).toBe(0)
  await ui.unmount()
})

test('15 个在跑的单个任务分窗口，maxRows=10 缩为六项，flow 切换后重置', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = Array.from({ length: 15 }, (_, i) => `single-${i}`)
  for (const [i, id] of w.dirs.entries()) w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, name: id, startedAt: iso(200 - i) })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'runs-window'
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: PROPS })
  expect(await ui.findAll({ type: 'Button', text: /^single-\d+$/ })).toHaveLength(12)
  expect((await ui.find({ key: 'more:runs:down' }))?.text).toBe('↓ 还有 3 个')
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:runs:down', origin: { kind: 'person' } })
  expect(await ui.find({ key: 'r:single-0' })).toBeUndefined()
  expect(await ui.find({ key: 'r:single-12' })).toBeDefined()
  expect(w.focuses.at(-1)).toBe('r:single-12')
  await ui.redraw({ ...(PROPS as object), maxRows: 10 } as never)
  expect(await ui.findAll({ type: 'Button', text: /^single-\d+$/ })).toHaveLength(6)
  expect(await ui.find({ key: 'r:single-12' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:runs:down', origin: { kind: 'person' } })
  expect(await ui.find({ key: 'r:single-7' })).toBeUndefined()
  expect(await ui.find({ key: 'r:single-13' })).toBeDefined()
  expect(w.focuses.at(-1)).toBe('r:single-13')
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await ui.press({ key: 'r:single-12' })
  await ui.press({ key: 'back' })
  // 返回目标必须可见；切换 run 清掉旧的窗口起点后按目标修正。
  expect(await ui.find({ key: 'r:single-12' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await ui.unmount()
})

test('20 个阶段窗口可上下移动，agent 栏阶段为只读窗口，返回仍看得到所选阶段', async ($, on) => {
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
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: { ...(PROPS as object), maxRows: 10 } as never })
  expect(await ui.findAll({ type: 'Button', text: /^phase-\d+$/ })).toHaveLength(4)
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'more:phases:down', origin: { kind: 'person' } })
  expect(await ui.find({ key: 'p:phase-0' })).toBeUndefined()
  expect(await ui.find({ key: 'p:phase-4' })).toBeDefined()
  expect(w.focuses.at(-1)).toBe('p:phase-4')
  expect(await ui.find({ text: ' phase-4 · 1 个 agent ' })).toBeDefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await ui.press({ key: 'p:phase-4' })
  expect(await ui.find({ type: 'Button', text: /还有/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^↑ 还有/ }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'p:phase-4' })).toBeDefined()
  await ui.unmount()
})

test('缓存随目录消失清理，读取恢复或目录重新出现后错误可再记一次', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const path = `${ROOT}/s-1/state.json`
  const errorCount = () => w.logs.map(log => JSON.parse(log.text)).filter(log => log.event === 'refresh-incomplete').length
  w.failReads = [path]
  await clock.advance(4_000)
  expect(errorCount()).toBe(1)
  expect(await ui.find({ key: 'r:s-1' })).toBeDefined()
  w.failReads = []
  await clock.advance(2_000)
  w.failReads = [path]
  await clock.advance(4_000)
  expect(errorCount()).toBe(2)
  w.dirs = w.dirs.filter(dir => dir !== 's-1')
  await clock.advance(2_000)
  w.dirs.push('s-1')
  await clock.advance(4_000)
  expect(errorCount()).toBe(3)
  // 已移除目录的好状态不能在重现且读取失败时复活。
  expect(await ui.find({ key: 'r:s-1' })).toBeUndefined()
  w.failReads = []
  w.files[path] = JSON.stringify({ ...singleState, name: '重新读取' })
  await clock.advance(2_000)
  expect(await ui.find({ key: 'r:s-1', text: '重新读取' })).toBeDefined()
  w.failList = true
  await clock.advance(4_000)
  expect(errorCount()).toBe(4)
  w.failList = false
  await clock.advance(2_000)
  w.failList = true
  await clock.advance(4_000)
  expect(errorCount()).toBe(5)
  await ui.unmount()
})


test('用户 /flow 变更在队列中途时，自动收起等待并重新判断 auto=false', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(panel(w).auto).toBe(true)
  for (const [id, state] of [['r-1', flowState], ['s-1', singleState]] as const) {
    w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...state, status: 'completed', endedAt: iso(200) })
  }
  let release: (() => void) | undefined
  w.beforeManualAutoSet = () => new Promise<void>(resolve => { release = resolve })
  const command = $.command.run(FLOW_CMD)
  await clock.settle()
  expect(release).toBeDefined()
  // 用户命令已改 shown，但 auto=false 的写入还卡在钩子中；刷新不得在队列外做决定。
  const tick = clock.advance(2_000)
  await clock.settle()
  release!()
  await Promise.all([command, tick])
  await clock.advance(2_000)
  expectPanel(w, true, 'command', T0 + 254_000)
  expect(panel(w).auto).toBe(false)
  expect(w.logs.map(log => JSON.parse(log.text)).some(record => record.event === 'panel-write' && record.by === 'auto-close')).toBe(false)
  w.beforeManualAutoSet = undefined
})

test('20 个阶段 maxRows=10：翻到第 2–5 项后聚焦窗口内第 4 项，阶段窗口保持不跳', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1']
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState,
    phases: Array.from({ length: 20 }, (_, i) => ({ title: `phase-${i}`, status: i === 0 ? 'running' : 'pending' })),
    tasks: Array.from({ length: 20 }, (_, i) => ({ ...flowState.tasks[1], label: `agent-${i}`, phase: `phase-${i}` })),
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const requestId = 'phases-stable'
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', requestId, props: { ...(PROPS as object), maxRows: 10 } as never })
  const visible = async () => (await ui.findAll({ type: 'Button', text: /^phase-\d+$/ })).map(row => row.text)
  await ui.press({ key: 'more:phases:down' })
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  expect(w.windowStarts.phases).toBe(1)
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'p:phase-3', origin: { kind: 'person' } })
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  expect(w.windowStarts.phases).toBe(1)
  expect(await ui.find({ text: ' phase-3 · 1 个 agent ' })).toBeDefined()
  await clock.advance(2_000)
  expect(await visible()).toEqual(['phase-1', 'phase-2', 'phase-3', 'phase-4'])
  // 目标离开窗口时只移动到刚好能看到它的位置。
  await $.ui.focus({ component: 'AbovePrompt', requestId, plugin: 'codex-flow', element: 'p:phase-5', origin: { kind: 'person' } })
  expect(await visible()).toEqual(['phase-2', 'phase-3', 'phase-4', 'phase-5'])
  expect(w.windowStarts.phases).toBe(2)
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
  await ui.unmount()
})

for (const maxRows of [6, 8]) {
  test(`maxRows=${maxRows}：长列表和 flow 各层翻页后总行数仍不超限`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 252_000 })
    const w = world(on)
    w.dirs = ['r-1', ...Array.from({ length: 15 }, (_, i) => `single-${i}`)]
    w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...agentsState(),
      phases: Array.from({ length: 20 }, (_, i) => ({ title: i === 0 ? '审查' : `phase-${i}`, status: i === 0 ? 'running' : 'pending' })),
    })
    for (const [i, id] of w.dirs.slice(1).entries()) w.files[`${ROOT}/${id}/state.json`] = JSON.stringify({ ...singleState, runId: id, name: id, startedAt: iso(-i - 1) })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), maxRows } as never })
    const checkRows = async () => expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(maxRows)
    await checkRows()
    await ui.press({ key: 'more:runs:down' })
    await checkRows()
    expect(await ui.find({ key: 'more:runs:up' })).toBeDefined()
    await ui.press({ key: 'more:runs:up' })
    await ui.press({ key: 'r:r-1' })
    await checkRows()
    await ui.press({ key: 'more:phases:down' })
    await checkRows()
    expect(await ui.find({ key: 'more:phases:up' })).toBeDefined()
    expect(await ui.find({ key: 'more:phases:down' })).toBeDefined()
    await ui.press({ key: 'more:phases:up' })
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

test('maxRows=0–5 放不下固定行时，列表、flow 和单发详情都能绘制且不超限', async ($, on) => {
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
    }
    await ui.redraw(PROPS)
  }
  await checkHeights()
  await ui.press({ key: 'r:r-1' })
  await checkHeights()
  await ui.press({ key: 'p:审查' })
  await checkHeights()
  await ui.press({ key: 't:r-1:agent-0' })
  await checkHeights()
  await ui.press({ key: 'back' })
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

test('flow 和单个 agent 同时在列表里时 flow 固定在上，同类里新的在上，任务结束不挪位置', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  w.dirs = ['r-1', 's-1', 'r-3', 's-2']
  w.files[`${ROOT}/r-3/state.json`] = JSON.stringify({ ...flowState, runId: 'r-3', name: '新的 flow', startedAt: iso(100) })
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

test('面板给 11 行时画彩色外框，10 行时省掉；放得下的 agent 全部显示，不出现「还有 N 个」', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 252_000 })
  const w = world(on)
  // 只有一个 flow：打开即进入阶段栏，右栏列出「审查」的四个 agent
  w.dirs = ['r-1']
  const extra = ['可读性', '兼容'].map(label => ({ ...flowState.tasks[1], label, tokens: 1000 }))
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, tasks: [...flowState.tasks.slice(0, 2), ...extra, flowState.tasks[2]] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const props = (maxRows: number) => ({ ...(PROPS as object), maxRows }) as never
  const ui = await $.ui.mount({ plugin: 'codex-flow', surface: 'terminal', component: 'AbovePrompt', props: props(11) })
  const shells = async () => (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round' && b.props.borderColor === '#BB9AF7')
  expect(await shells()).toHaveLength(1)
  for (const label of ['安全', '性能', '可读性', '兼容']) expect(await ui.find({ text: new RegExp(`^${label}$`) })).toBeDefined()
  expect(await ui.find({ text: /还有/ })).toBeUndefined()
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(11)
  await ui.redraw(props(10))
  expect(await shells()).toHaveLength(0)
  expect(drawnRows(await ui.drawn())).toBeLessThanOrEqual(10)
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

test('运行中的阶段和 agent 用蓝色点阵转动；选中的待开始阶段不变蓝，全部结束后停止转动', async ($, on) => {
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
  const SPIN = /^[⣾⣽⣻⢿⡿⣟⣯⣷]$/
  const spinners = async () => (await ui.findAll({ type: 'Text', text: SPIN })).map(t => [t.text, t.props.color])
  // 运行中的阶段「审查」和 agent「性能」各一个蓝色点阵，待开始的「复核」只显示序号
  const first = await spinners()
  expect(first.length).toBe(2)
  expect(first.every(([, color]) => color === '#7AA2F7')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^2$/ }))?.props.color).toBeUndefined()
  // 点阵随时间转动
  await clock.advance(120)
  const second = await spinners()
  expect(second.map(([c]) => c)).not.toEqual(first.map(([c]) => c))
  // 选中待开始的阶段：右栏换成它，但它不变蓝，运行中的阶段仍是蓝色点阵
  await ui.press({ key: 'p:复核' })
  expect(await ui.find({ text: ' 复核 · 1 个 agent ' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^复核$/ })).every(t => t.props.color !== '#7AA2F7')).toBe(true)
  expect((await spinners()).length).toBeGreaterThan(0)
  // 全部结束：不再有点阵，帧数不再变化
  w.files[`${ROOT}/r-1/state.json`] = JSON.stringify({ ...flowState, status: 'completed', endedAt: iso(254), phases: flowState.phases.map(p => ({ ...p, status: 'completed' })), tasks: flowState.tasks.map(t => ({ ...t, status: 'completed', endedAt: iso(254) })) })
  await clock.advance(2_000)
  expect((await spinners()).length).toBe(0)
  const framesBefore = frames
  await clock.advance(1_000)
  expect(frames).toBe(framesBefore)
  await ui.unmount()
})
