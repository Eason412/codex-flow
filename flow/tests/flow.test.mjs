import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skill = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(skill, 'flow/codex-flow.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-round4-test-'));
process.env.CODEX_FLOW_HOME = path.join(root, 'flow');
process.env.CODEX_HOME = path.join(root, 'codex');
delete process.env.CLAUDE_CODE_SESSION_ID;
const stateLib = await import('../lib/state.mjs');
const flow = await import('../codex-flow.mjs');
const { RUNS, HOME, readJson, writeJson, statePath, pruneOldRuns, readModelConfig } = stateLib;
const { indentJson, singleContext, singleWatchTick, watchSingle, findRollout, settleSingleTokens, readCompleteRecords, conclusionOf, inScope } = flow;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windowStart = Date.now() - 60000;
const start = new Date(windowStart).toISOString();
const inside = new Date(windowStart + 1000).toISOString();
const end = new Date(windowStart + 2000).toISOString();
const before = new Date(windowStart - 1000).toISOString();
const afterEnd = new Date(windowStart + 3000).toISOString();
const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: input / 2, reasoning_output_tokens: output / 2, total_tokens: input + output });
const token = (input, output, lastInput, lastOutput, timestamp = inside) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(input, output), last_token_usage: usage(lastInput, lastOutput) } } });
const line = (value) => JSON.stringify(value) + '\n';
const command = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env, ...options });
const rollout = (thread = 'unit-thread', date = '2020/01/01') => {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', date);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-test-${thread}.jsonl`);
};
function single({ resumed = false, forkedFrom = null, threadId = resumed ? 'unit-thread' : null, pid = process.pid } = {}) {
  const dir = path.join(RUNS, 's-unit');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(statePath(dir), { kind: 'single', name: '任务', runId: 's-unit', pid, cwd: root, startedAt: start, status: 'running', phases: [{ title: '任务', status: 'running' }], tasks: [{ label: '任务', model: 'gpt-6.1-sol', effort: 'high', startedAt: start, status: 'running', log: 'events.jsonl', resumed, forkedFrom, threadId }] });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), line({ type: 'thread.started', thread_id: 'unit-thread' }));
  fs.writeFileSync(path.join(dir, 'stderr.log'), '');
  return dir;
}
// 单轮测试把启动期快进到首次全目录查找；频率和启动期另行注入时钟验证。
const cache = () => ({ events: { offset: 0 }, cursor: { offset: 0 }, rollout: null, searchStartedAt: Date.now() - 30000 });
beforeEach(() => {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fakePath() {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(new URL('./fake-codex.mjs', import.meta.url), path.join(bin, 'codex'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  return { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
}
async function until(predicate, detail, ms = 10000) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    const value = predicate();
    if (value) return value;
    await sleep(60);
  }
  assert.fail(`等待超时: ${detail}`);
}
function background(executable, args, env) {
  const child = spawn(executable, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

for (const [name, source, expected] of [
  ['数字原文', '{"big":9007199254740993,"float":1.0,"exp":1e400}', '{\n  "big": 9007199254740993,\n  "float": 1.0,\n  "exp": 1e400\n}'],
  ['空容器', ' { "a":{}, "b": [ ], "c":[{},[]] } ', '{\n  "a": {},\n  "b": [],\n  "c": [\n    {},\n    []\n  ]\n}'],
  ['中文和转义', String.raw`{"中文":"引号\"、斜杠\\、换行\n、\u4e2d","数组":["a,b:{}"]}`, String.raw`{
  "中文": "引号\"、斜杠\\、换行\n、\u4e2d",
  "数组": [
    "a,b:{}"
  ]
}`],
  ['空对象', '{}', '{}'], ['空数组', '[]', '[]'], ['数值标量', '1.0', '1.0'],
]) test(`JSON 排版：${name}`, () => assert.equal(indentJson(source), expected));

test('_single-end 的非 JSON 回复去首尾空白，输出格式不变', () => {
  const dir = single();
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({ type: 'turn.completed', usage: usage(20, 10) }));
  fs.writeFileSync(path.join(dir, 'last.md'), ' \n 中文正文\n第二行 \n\t');
  const result = command(['_single-end', '--dir', dir, '--code', '0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith('----- Codex 最终回复 -----\n中文正文\n第二行\n'));
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, 30);
});

test('实际使用 context 只接受开始到结束的时间窗（含边界）', () => {
  const file = rollout();
  const context = (timestamp, model) => ({ timestamp, type: 'turn_context', payload: { model, effort: 'high' } });
  fs.writeFileSync(file, [context(before, 'before'), context(start, 'start'), context(inside, 'inside'), context(end, 'end'), context(afterEnd, 'after')].map(line).join(''));
  assert.deepEqual(singleContext('unit-thread', start, end), { found: true, context: { model: 'end', effort: 'high' } });
  fs.writeFileSync(file, line(context(before, 'before')) + line(context(afterEnd, 'after')));
  assert.deepEqual(singleContext('unit-thread', start, end), { found: true, context: null });
  assert.deepEqual(singleContext('missing', start, end), { found: false, context: null });
});

function record(name, state, old = false) {
  const dir = path.join(RUNS, name);
  fs.mkdirSync(dir);
  if (state !== undefined) writeJson(statePath(dir), state);
  if (old) fs.utimesSync(dir, new Date(0), new Date(0));
  return dir;
}
const oldState = { status: 'completed', pid: 2147483647, startedAt: '2000-01-01T00:00:00Z', endedAt: '2000-01-02T00:00:00Z' };
test('pruneOldRuns：结束时间、开始时间、存活进程、损坏状态、无 state 新旧目录和 panel', () => {
  const expired = record('expired', oldState);
  const lost = record('lost', { ...oldState, status: 'running', endedAt: null });
  const freshEnd = record('fresh-end', { ...oldState, endedAt: new Date().toISOString() });
  const live = record('live', { ...oldState, pid: process.pid });
  const recent = record('recent', { ...oldState, endedAt: null, startedAt: new Date().toISOString() });
  const unregisteredOld = record('unregistered-old', undefined, true);
  const unregisteredNew = record('unregistered-new');
  const broken = record('broken', undefined, true);
  fs.writeFileSync(statePath(broken), '{broken');
  fs.utimesSync(broken, new Date(0), new Date(0));
  const oldPanel = path.join(HOME, 'panel-old.json'), newPanel = path.join(HOME, 'panel-new.json');
  fs.writeFileSync(oldPanel, '{}'); fs.utimesSync(oldPanel, new Date(0), new Date(0));
  fs.writeFileSync(newPanel, '{}');
  fs.writeFileSync(path.join(RUNS, 'plain-file'), 'keep');
  pruneOldRuns();
  for (const dir of [expired, lost, unregisteredOld, oldPanel]) assert.equal(fs.existsSync(dir), false, dir);
  for (const dir of [freshEnd, live, recent, unregisteredNew, broken, newPanel, path.join(RUNS, 'plain-file')]) assert.equal(fs.existsSync(dir), true, dir);
});

for (const [name, latest] of [
  ['PID 存活', { ...oldState, pid: process.pid }],
  ['时间更新', { ...oldState, endedAt: new Date().toISOString() }],
  ['其他字段变化', { ...oldState, name: 'changed' }],
  ['状态消失', null],
]) test(`pruneOldRuns 删除前重读：${name}`, (t) => {
  const dir = record('race', oldState);
  const read = fs.readFileSync;
  let calls = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === statePath(dir) && ++calls === 2) {
      if (latest) writeJson(file, latest); else fs.unlinkSync(file);
    }
    return read.call(this, file, ...args);
  });
  pruneOldRuns();
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(dir), true);
});

test('pruneOldRuns：无 state 目录 stat 抛错时跳过，并继续清理其他目录', (t) => {
  const vanished = record('a-vanished', undefined, true);
  const expired = record('z-expired', oldState);
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', function(file, ...args) {
    if (file === vanished) {
      fs.rmSync(file, { recursive: true });
      throw Object.assign(new Error('removed concurrently'), { code: 'ENOENT' });
    }
    return stat.call(this, file, ...args);
  });
  assert.doesNotThrow(() => pruneOldRuns());
  assert.equal(fs.existsSync(expired), false);
});

for (const resumed of [false, true]) test(`watch 计算：${resumed ? '续接' : '新对话'}、空 info、半行、晚出现、上下文压缩、只在变化时写`, () => {
  const dir = single({ resumed });
  const reader = cache();
  assert.equal(singleWatchTick(dir, reader), true);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  const file = rollout('unit-thread', localDateDir());
  const base = resumed ? 1000 : 0;
  fs.writeFileSync(file, line(token(800, 200, 800, 200, before)) + line({ timestamp: inside, type: 'event_msg', payload: { type: 'token_count', info: null } }) + line({ timestamp: inside, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: null } } }));
  singleWatchTick(dir, reader);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  const first = JSON.stringify(token(base + 120, 80, 120, 80));
  fs.appendFileSync(file, first); // 合法 JSON 但没有换行，也不能参与
  singleWatchTick(dir, reader);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  fs.appendFileSync(file, '\n');
  singleWatchTick(dir, reader);
  let task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.tokenBaseline, base);
  assert.equal(task.tokens, 200);
  const mtime = fs.statSync(statePath(dir)).mtimeMs;
  singleWatchTick(dir, reader);
  assert.equal(fs.statSync(statePath(dir)).mtimeMs, mtime);
  fs.appendFileSync(file, line({ timestamp: inside, type: 'compacted', payload: {} }) + line(token(base + 200, 150, 80, 70)));
  singleWatchTick(dir, reader);
  task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.tokens, 350);
  assert.equal(task.tokenBaseline, base);
  settleSingleTokens(task, start, end, usage(base + 200, 150));
  assert.equal(task.tokens, 350);
});

test('watch：rollout 被压缩成 .zst 后不崩，保留最后实时值', () => {
  const dir = single({ resumed: true });
  const file = rollout();
  const reader = cache();
  fs.writeFileSync(file, line(token(1120, 80, 120, 80)));
  singleWatchTick(dir, reader);
  fs.renameSync(file, file + '.zst');
  assert.equal(singleWatchTick(dir, reader), true);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, 200);
  const task = readJson(statePath(dir)).tasks[0];
  settleSingleTokens(task, start, end, usage(1200, 150));
  assert.equal(task.tokens, 350);
});

test('watch：只有 .zst、缺失 state、父进程消失和任务结束时安全退出', () => {
  const dir = single({ pid: 2147483647, resumed: true });
  fs.writeFileSync(rollout() + '.zst', 'not decoded');
  assert.equal(singleWatchTick(dir, cache()), false);
  const result = command(['_single-watch', '--dir', dir]);
  assert.equal(result.status, 0);
  const state = readJson(statePath(dir)); state.pid = process.pid;
  writeJson(statePath(dir), state);
  assert.equal(singleWatchTick(dir, cache()), true);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  state.status = 'completed'; writeJson(statePath(dir), state);
  assert.equal(singleWatchTick(dir, cache()), false);
  fs.unlinkSync(statePath(dir));
  assert.equal(singleWatchTick(dir, cache()), false);
});

test('字节游标：跨中文 UTF-8 半行、损坏行、非对象、文件截断和替换', () => {
  const file = rollout(), cursor = { offset: 0 };
  const bytes = Buffer.from(line({ 中文: '中文内容' }));
  fs.writeFileSync(file, bytes.subarray(0, 12));
  assert.deepEqual(readCompleteRecords(file, cursor), []);
  fs.appendFileSync(file, bytes.subarray(12));
  assert.deepEqual(readCompleteRecords(file, cursor), [{ 中文: '中文内容' }]);
  fs.appendFileSync(file, 'broken\nnull\n[]\n1\n' + line({ ok: true }));
  assert.deepEqual(readCompleteRecords(file, cursor), [{ ok: true }]);
  fs.writeFileSync(file, line({ short: 1 }));
  assert.deepEqual(readCompleteRecords(file, cursor), [{ short: 1 }]);
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, line({ replacement: 2 }));
  assert.deepEqual(readCompleteRecords(file, cursor), [{ replacement: 2 }]);
});

for (const scenario of ['cached', 'prior', 'missing', 'current-only', 'new']) test(`_single-end 基线回退：${scenario}`, () => {
  const dir = single({ resumed: scenario !== 'new' });
  if (scenario === 'cached') {
    const state = readJson(statePath(dir)); state.tasks[0].tokenBaseline = 1000;
    writeJson(statePath(dir), state);
  }
  if (scenario === 'cached' || scenario === 'current-only') fs.writeFileSync(rollout(), line(token(1120, 80, 120, 80)) + line(token(1200, 150, 80, 70)));
  if (scenario === 'prior') fs.writeFileSync(rollout(), line(token(600, 100, 600, 100, new Date(windowStart - 10000).toISOString())) + line(token(800, 200, 200, 100, before)) + line({ timestamp: before, type: 'event_msg', payload: { type: 'token_count', info: null } }) + line(token(9000, 1000, 8000, 0, '2099-01-01T00:00:00Z')));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({ type: 'turn.completed', usage: usage(1200, 150) }));
  const result = command(['_single-end', '--dir', dir, '--code', '0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.tokens, ['missing', 'current-only'].includes(scenario) ? undefined : scenario === 'new' ? 1350 : 350);
  assert.equal(task.tokenBaseline, ['missing', 'current-only'].includes(scenario) ? undefined : scenario === 'new' ? 0 : 1000);
});

test('模型名单从 skill 根目录读取，与当前工作目录无关', () => {
  assert.deepEqual(readModelConfig(), { models: ['gpt-6.1-sol', 'gpt-6-astra'], efforts: ['low', 'medium', 'high', 'xhigh'] });
  const result = command(['_check', '--model', 'gpt-6-astra', '--effort', 'xhigh'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
});

for (const value of [null, {}, { models: [], efforts: ['high'] }, { models: ['x', 'x'], efforts: ['high'] }, { models: ['x'], efforts: 'high' }, { models: ['x'], efforts: [1] }, { models: [' '], efforts: ['high'] }]) test(`模型名单格式拒绝：${JSON.stringify(value)}`, () => {
  const file = path.join(root, 'invalid.json'); fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => readModelConfig(file), /模型名单格式错误/);
});

test('模型名单缺失、无效 JSON 不阻止模块加载，校验时才报错（仅操作临时副本）', () => {
  const lib = path.join(root, 'isolated/flow/lib'); fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(skill, 'flow/lib/state.mjs'), path.join(lib, 'state.mjs'));
  const file = path.join(root, 'isolated/models.json');
  for (const content of [undefined, '{broken', '{}']) {
    if (content !== undefined) fs.writeFileSync(file, content);
    const source = `import * as state from ${JSON.stringify(path.join(lib, 'state.mjs'))};
      if ('ALLOWED_MODELS' in state || 'ALLOWED_EFFORTS' in state) process.exit(9);`;
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: process.env, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', source + `
      try { state.checkModelEffort('gpt-6.1-sol', 'high', '任务'); }
      catch (error) { console.error(error.message); process.exit(2); }`], { env: process.env, encoding: 'utf8' });
    assert.equal(checked.status, 2);
    assert.match(checked.stderr, content === '{}' ? /模型名单格式错误/ : /无法读取模型名单/);
    assert.match(checked.stderr, /isolated\/models.json/);
  }
});

for (const [model, effort] of [['outside-model', 'high'], ['gpt-6.1-sol', 'outside-effort']]) test(`run.sh 和 flow 一致拒绝名单外参数：${model}/${effort}`, () => {
  fs.rmSync(HOME, { recursive: true });
  const env = fakePath();
  const singleResult = spawnSync('bash', [path.join(skill, 'run.sh'), '-m', model, '-e', effort, '-n', '任务', '-C', root, '测试'], { env, encoding: 'utf8' });
  assert.equal(singleResult.status, 2);
  assert.equal(fs.existsSync(HOME), false, '校验失败不能创建运行目录');
  const plan = path.join(root, 'plan.json');
  writeJson(plan, { name: '拒绝', phases: [{ title: '阶段', tasks: [{ label: '任务', model, effort, prompt: '测试' }] }] });
  const flowResult = command(['run', plan], { env });
  assert.equal(flowResult.status, 2);
  assert.equal(singleResult.stderr, flowResult.stderr);
  assert.match(singleResult.stderr, /不在允许范围/);
  assert.deepEqual(fs.readdirSync(RUNS), []);
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-pid')), false);
});

for (const mode of ['new', 'resume', 'fork']) test(`假 codex 端到端 run.sh：${mode} 实时增长，最后实时值等于结束值`, { timeout: 45000 }, async (t) => {
  const resumed = mode === 'resume', forked = mode === 'fork';
  const firstTokens = forked ? 18965 : 200, finalTokens = firstTokens + 150;
  const env = fakePath();
  const args = [path.join(skill, 'run.sh'), '-m', 'gpt-6.1-sol', '-e', 'high', '-C', root];
  if (resumed) args.push('-r', 'fake-resumed-thread');
  if (forked) args.push('-f', 'fake-parent-thread');
  args.push('测试任务');
  const { child, done } = background('bash', args, env);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; } });
  const dir = await until(() => fs.readdirSync(RUNS).map((name) => path.join(RUNS, name)).find((dir) => readJson(statePath(dir))), '创建 state');
  await until(() => readJson(statePath(dir))?.tasks[0].tokens === firstTokens, `实时 tokens=${firstTokens}`, 35000);
  assert.equal(readJson(statePath(dir)).status, 'running');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'advance'), '');
  await until(() => readJson(statePath(dir))?.tasks[0].tokens === finalTokens, `实时 tokens=${finalTokens}`);
  const lastLive = readJson(statePath(dir));
  assert.equal(lastLive.status, 'running');
  assert.equal(lastLive.tasks[0].tokenBaseline, forked ? 109880 : resumed ? 1000 : 0);
  assert.equal(lastLive.tasks[0].forkedFrom, forked ? 'fake-parent-thread' : null);
  assert.equal(lastLive.tasks[0].threadId, resumed ? 'fake-resumed-thread' : forked ? 'fake-child-thread' : 'fake-new-thread');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'finish'), '');
  const result = await done;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const final = readJson(statePath(dir));
  assert.equal(final.status, 'completed');
  assert.equal(final.session, null);
  assert.equal(final.tasks[0].tokens, lastLive.tasks[0].tokens);
  assert.equal(final.tasks[0].actualModel, 'gpt-6.1-sol');
  assert.equal(final.tasks[0].actualEffort, 'high');
  assert.match(result.stdout, /"整数": 9007199254740993/);
  assert.match(result.stdout, /"浮点": 1\.0/);
  const status = command(['status'], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /完成/);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`run.sh 的 ${signal} trap 停止 codex 和 watcher，保留实时值`, { timeout: 15000 }, async (t) => {
  const { child, done } = background('bash', [path.join(skill, 'run.sh'), '-m', 'gpt-6.1-sol', '-e', 'high', '-C', root, '停止测试'], fakePath());
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; } });
  const dir = await until(() => fs.readdirSync(RUNS).map((name) => path.join(RUNS, name)).find((dir) => readJson(statePath(dir))?.tasks[0].tokens === 200), '实时 tokens');
  const pid = Number(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fake-pid'), 'utf8'));
  child.kill(signal);
  const result = await done;
  assert.equal(result.code, signal === 'SIGTERM' ? 143 : 130, result.stdout + result.stderr);
  const state = readJson(statePath(dir));
  assert.equal(state.status, 'cancelled');
  assert.equal(state.tasks[0].tokens, 200);
  assert.equal(stateLib.isAlive(pid), false);
  const saved = fs.readFileSync(statePath(dir), 'utf8');
  await sleep(2100);
  assert.equal(fs.readFileSync(statePath(dir), 'utf8'), saved);
});

test('多任务 flow 回归：假 app-server 的累计 token 口径、阶段结果引用和续跑复用', () => {
  const env = fakePath();
  const plan = path.join(root, 'plan.json');
  writeJson(plan, { name: 'flow 回归', cwd: root, phases: [
    { title: '第一阶段', tasks: [{ label: '一', model: 'gpt-6.1-sol', effort: 'high', prompt: '测试' }] },
    { title: '第二阶段', tasks: [{ label: '二', model: 'gpt-6-astra', effort: 'medium', prompt: '{{task:一}}\n{{phase:第一阶段}}' }] },
  ] });
  const result = command(['run', plan], { env, timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dir = path.join(RUNS, fs.readdirSync(RUNS)[0]);
  const state = readJson(statePath(dir));
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.tasks.map((task) => task.tokens), [987, 987]);
  assert.deepEqual(state.phases.map((phase) => phase.status), ['completed', 'completed']);
  assert.match(fs.readFileSync(path.join(dir, 'logs/二.prompt.txt'), 'utf8'), /假 flow 结果\n### 一\n假 flow 结果/);
  // PATH 中的 codex 改成遇到调用就失败，证明已完成任务被复用。
  fs.writeFileSync(path.join(root, 'bin/codex'), '#!/bin/sh\nexit 99\n');
  const resumed = command(['run', '--resume', state.runId], { env, timeout: 5000 });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.ok(readJson(statePath(dir)).tasks.every((task) => task.reused));
});

const sol = { model: 'gpt-6.1-sol', effort: 'high' };
const runPlan = (plan, args = [], env = fakePath()) => {
  const file = path.join(root, 'plan.json');
  writeJson(file, plan);
  return command(['run', file, ...args], { env, timeout: 10000 });
};
const onlyRun = () => {
  const dir = path.join(RUNS, fs.readdirSync(RUNS)[0]);
  return { dir, state: readJson(statePath(dir)) };
};
const taskOf = (state, label) => state.tasks.find((t) => t.label === label);

test('after 让任务在前置完成后立即开跑，不等同阶段的慢任务；没写 after 的仍等上一阶段', () => {
  const result = runPlan({ name: '流水线', cwd: root, phases: [
    { title: '撰写', tasks: [{ label: '快', ...sol, prompt: '快任务' }, { label: '慢', ...sol, prompt: 'SLOW' }] },
    { title: '审查', tasks: [{ label: '审快', ...sol, after: ['快'], prompt: '{{task:快}}' }, { label: '收尾', ...sol, prompt: '收尾' }] },
  ] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { state } = onlyRun();
  const at = (label, key) => Date.parse(taskOf(state, label)[key]);
  assert.ok(at('审快', 'startedAt') < at('慢', 'endedAt'), '审快 应在 慢 结束前开始');
  assert.ok(at('收尾', 'startedAt') >= at('慢', 'endedAt'), '收尾 应等整个撰写阶段');
  assert.deepEqual(state.phases.map((p) => p.status), ['completed', 'completed']);
});

test('前置任务失败时依赖它的任务跳过并逐级传递，flow 正常退出', () => {
  const result = runPlan({ name: '失败传递', cwd: root, phases: [
    { title: '一', tasks: [{ label: '坏', ...sol, prompt: 'FAIL' }, { label: '好', ...sol, prompt: '好' }] },
    { title: '二', tasks: [{ label: '等坏', ...sol, after: ['坏'], prompt: '等坏' }, { label: '等好', ...sol, after: ['好'], prompt: '等好' }] },
    { title: '三', tasks: [{ label: '等等坏', ...sol, after: ['等坏'], prompt: '等等坏' }] },
  ] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { state } = onlyRun();
  assert.deepEqual(state.tasks.map((t) => [t.label, t.status]), [['坏', 'failed'], ['好', 'completed'], ['等坏', 'skipped'], ['等好', 'completed'], ['等等坏', 'skipped']]);
  assert.deepEqual(state.phases.map((p) => p.status), ['partial', 'partial', 'skipped']);
  assert.equal(state.status, 'failed');
  assert.match(result.stdout, /○ 等坏 .*前置任务都没有完成/);
});

test('续跑只重跑改过的任务和等它的任务，其余复用', () => {
  const phases = (aPrompt) => [
    { title: '一', tasks: [{ label: 'a', ...sol, prompt: aPrompt }, { label: 'b', ...sol, prompt: 'b' }] },
    { title: '二', tasks: [{ label: 'c', ...sol, after: ['a'], prompt: 'c' }, { label: 'd', ...sol, after: ['b'], prompt: 'd' }] },
  ];
  assert.equal(runPlan({ name: '续跑', cwd: root, phases: phases('a') }).status, 0);
  const { state } = onlyRun();
  const resumed = runPlan({ name: '续跑', cwd: root, phases: phases('a 改过') }, ['--resume', state.runId]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const after = readJson(statePath(onlyRun().dir));
  assert.deepEqual(after.tasks.map((t) => [t.label, !!t.reused]), [['a', false], ['b', true], ['c', false], ['d', true]]);
});

test('续跑时前置任务或工作目录变了也重跑，并传给下游', () => {
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const plan = (bAfter, cwd = root) => ({ name: '续跑变更', cwd, phases: [{ title: '一', tasks: [
    { label: 'a', ...sol, prompt: 'a' }, { label: 'b', ...sol, after: bAfter, prompt: 'b' }, { label: 'c', ...sol, after: ['b'], prompt: 'c' },
  ] }] });
  assert.equal(runPlan(plan(['a'])).status, 0);
  const { dir, state } = onlyRun();
  const resume = (next) => {
    const result = runPlan(next, ['--resume', state.runId]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return readJson(statePath(dir)).tasks.map((t) => [t.label, !!t.reused]);
  };
  // b 不再等 a：b 和下游 c 重跑，a 复用
  assert.deepEqual(resume(plan([])), [['a', true], ['b', false], ['c', false]]);
  // 只改计划的 cwd：所有任务都在新目录重跑
  assert.deepEqual(resume(plan([], path.join(root, 'other'))), [['a', false], ['b', false], ['c', false]]);
  assert.equal(readJson(statePath(dir)).cwd, path.join(root, 'other'));
});

test('旧计划没存 cwd 时，不带计划续跑仍在上次的工作目录运行', () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(runPlan({ name: '旧计划', cwd: repo, phases: [{ title: '一', tasks: [{ label: '甲', ...sol, prompt: 'CWD' }] }] }).status, 0);
  const { dir, state } = onlyRun();
  // 模拟旧版本：plan.json 没有 cwd，任务失败待重跑
  const saved = readJson(path.join(dir, 'plan.json'));
  delete saved.cwd;
  writeJson(path.join(dir, 'plan.json'), saved);
  writeJson(statePath(dir), { ...state, status: 'failed', tasks: state.tasks.map((t) => ({ ...t, status: 'failed', result: undefined })) });
  const resumed = command(['run', '--resume', state.runId], { env: fakePath(), timeout: 10000, cwd: os.tmpdir() });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const after = readJson(statePath(dir));
  assert.equal(after.cwd, repo);
  assert.equal(fs.readFileSync(path.join(dir, after.tasks[0].result), 'utf8').trim(), `cwd=${fs.realpathSync(repo)}`);
});

test('结论提取容错：null、非对象、未知严重级别和多行判断字段', () => {
  const dir = path.join(root, 'res');
  fs.mkdirSync(dir, { recursive: true });
  const of = (value) => {
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(value));
    return conclusionOf(dir, { result: 'r.json' });
  };
  assert.deepEqual(of(null), []);
  assert.deepEqual(of([1, 2]), []);
  assert.deepEqual(of('文本'), []);
  assert.deepEqual(of({ verdict: 'fail', findings: [{ severity: 'high' }, null, { severity: 'major' }] }), ['fail · 1 major, 2 其他']);
  assert.deepEqual(of({ verdict: 'pass', findings: [] }), ['pass · 无问题']);
  assert.deepEqual(of({ verdict: 'A\nB\nC\nD', summary: 'E\nF' }), ['A · B · C · D', 'E', 'F']);
  assert.deepEqual(of({ judgment: '可以', confidence: 'high' }), ['confidence high', '可以']);
});

const gitRepo = (name = 'repo') => {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  return repo;
};

test('写入范围：越界的改文件记录标出，同时段 shell 写入只在无人认领时标为来源未定；不影响任务状态', () => {
  const repo = gitRepo();
  const result = runPlan({ name: '范围', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '甲', ...sol, writes: ['a/**'], prompt: 'SLOW PATCH:a/x.md PATCH:z/out.md' },
    { label: '乙', ...sol, writes: ['b'], prompt: 'SHELL:b/y.md' },
    { label: '丙', ...sol, writes: ['c/**'], prompt: 'SHELL:d/z.md' },
    { label: '丁', ...sol, writes: [], prompt: 'PATCH:e/r.md' },
    { label: '戊', ...sol, prompt: 'PATCH:f/free.md' },
  ] }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { dir, state } = onlyRun();
  const scope = (label) => taskOf(state, label).scope ?? null;
  // 甲跑得最久：自己写的 z/out.md 越界；乙的 b/y.md 有乙认领，丁、戊的改动有改文件记录，都不算甲的；丙用 shell 写的 d/z.md 无人认领。
  // 其余几个同时开始、同时结束，彼此窗口内的 shell 写入谁先谁后不确定，只断言确定的部分
  assert.deepEqual(scope('甲'), { outside: ['z/out.md'], unclaimed: ['d/z.md'] });
  assert.deepEqual(scope('乙')?.outside ?? [], []);
  assert.deepEqual(scope('丙').outside, []);
  assert.ok(scope('丙').unclaimed.includes('d/z.md'));
  assert.deepEqual(scope('丁').outside, ['e/r.md']);
  assert.equal(scope('戊'), null, '没写 writes 不检查');
  assert.ok(state.tasks.every((t) => t.status === 'completed'));
  assert.match(result.stdout, /✓ 甲 .*\n    ⚠ 越界写入：z\/out\.md\n    ⚠ 范围外变动，来源未定：d\/z\.md\n/);
  const prompt = fs.readFileSync(path.join(dir, 'logs/丁.prompt.txt'), 'utf8');
  assert.match(prompt, /codex-flow 约束：\n这是只读任务，不要修改任何文件。$/);
  assert.match(fs.readFileSync(path.join(dir, 'logs/甲.prompt.txt'), 'utf8'), /只修改这些路径（相对工作目录）：a\/\*\*。/);
});

test('验收命令在任务目录运行：通过记为完成，失败或超时记为失败并保留结果，下游跳过', () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const env = { ...fakePath(), CODEX_FLOW_CHECK_TIMEOUT: '1' };
  const result = runPlan({ name: '验收', cwd: repo, phases: [
    { title: '一', tasks: [
      { label: '过', ...sol, cwd: 'sub', checks: ['test -f ok.txt', 'pwd -P > where.txt'], prompt: 'SHELL:ok.txt' },
      { label: '败', ...sol, checks: ['true', 'echo 坏了 >&2; exit 3', 'touch never.txt'], prompt: '败' },
      { label: '慢', ...sol, checks: ['sleep 5'], prompt: '慢' },
    ] },
    { title: '二', tasks: [{ label: '等败', ...sol, after: ['败'], prompt: '等败' }] },
  ] }, [], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { dir, state } = onlyRun();
  assert.equal(taskOf(state, '过').status, 'completed');
  assert.equal(fs.readFileSync(path.join(repo, 'sub', 'where.txt'), 'utf8').trim(), fs.realpathSync(path.join(repo, 'sub')));
  assert.equal(taskOf(state, '败').status, 'failed');
  assert.equal(taskOf(state, '败').error, '验收未通过：echo 坏了 >&2; exit 3（exit 3）');
  assert.ok(fs.existsSync(path.join(dir, taskOf(state, '败').result)), '失败也保留结果');
  assert.equal(fs.existsSync(path.join(repo, 'never.txt')), false, '失败后不再运行后面的验收');
  assert.match(fs.readFileSync(path.join(dir, 'logs/败.checks.log'), 'utf8'), /\$ echo 坏了 >&2; exit 3\n坏了\n\[exit 3 · \d+s\]/);
  assert.match(taskOf(state, '慢').error, /验收未通过：sleep 5（超时）/);
  assert.equal(taskOf(state, '等败').status, 'skipped');
  assert.match(result.stdout, /✓ 过 .*\n    验收 2\/2 通过\n/);
});

test('验收中停止任务会结束验收进程，任务记为已停止', { timeout: 20000 }, async (t) => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const file = path.join(root, 'plan.json');
  writeJson(file, { name: '停验收', cwd: repo, phases: [{ title: '一', tasks: [{ label: '甲', ...sol, checks: ['sleep 2; touch late.txt'], prompt: '甲' }] }] });
  const { child, done } = background(process.execPath, [cli, 'run', file], fakePath());
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; } });
  const dir = await until(() => fs.readdirSync(RUNS).map((name) => path.join(RUNS, name)).find((d) => fs.existsSync(path.join(d, 'logs/甲.checks.log'))), '开始验收');
  fs.writeFileSync(path.join(dir, 'control/甲.stop'), '');
  const result = await done;
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.status, 'cancelled');
  assert.equal(task.error, '已按要求停止（验收中）');
  await sleep(2500);
  assert.equal(fs.existsSync(path.join(repo, 'late.txt')), false, '验收进程应已结束');
});

test('续跑只改了验收命令时复用 Codex 结果，只重跑验收；只改 writes 不重跑', () => {
  const plan = (checks, writes) => ({ name: '改验收', cwd: root, phases: [
    { title: '一', tasks: [{ label: '甲', ...sol, checks, writes, prompt: '甲' }] },
    { title: '二', tasks: [{ label: '乙', ...sol, prompt: '{{task:甲}}' }] },
  ] });
  assert.equal(runPlan(plan(['true'])).status, 0);
  const { dir, state } = onlyRun();
  fs.writeFileSync(path.join(root, 'bin/codex'), '#!/bin/sh\nexit 99\n');
  const sameWrites = runPlan(plan(['true'], ['docs']), ['--resume', state.runId]);
  assert.equal(sameWrites.status, 0, sameWrites.stdout + sameWrites.stderr);
  const failing = runPlan(plan(['true', 'false'], ['docs']), ['--resume', state.runId]);
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  const after = readJson(statePath(dir));
  assert.equal(taskOf(after, '甲').status, 'failed');
  assert.equal(taskOf(after, '甲').error, '验收未通过：false（exit 1）');
  assert.ok(taskOf(after, '甲').reused);
  assert.equal(taskOf(after, '乙').status, 'completed', '下游沿用原结果');
});

test('范围写法：「.」、绝对路径、点开头文件、符号链接目录和目录名', () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'real', 'deep'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'real'), path.join(repo, 'link'));
  const file = (rel) => path.join(fs.realpathSync(repo), rel);
  assert.ok(inScope(file('any/x.md'), ['.'], repo));
  assert.ok(inScope(file('any/x.md'), ['./'], repo));
  assert.ok(inScope(file('abs/x.md'), [path.join(repo, 'abs')], repo));
  assert.ok(inScope(file('src/.env'), ['src/**'], repo));
  assert.ok(inScope(file('.github/ci.yml'), ['**/*.yml'], repo));
  assert.ok(inScope(file('real/new.md'), ['link/**'], repo));
  assert.ok(inScope(file('real/deep/q.md'), ['link'], repo));
  assert.ok(!inScope(file('real/deep/q.md'), ['real/*'], repo), '单层 * 不含子目录');
  assert.ok(!inScope(file('other/x.md'), ['src/**'], repo));
  assert.ok(!inScope(file('x.md'), [], repo));
});

test('失败的任务也报告越界；没生效的改文件记录不算', () => {
  const repo = gitRepo();
  const result = runPlan({ name: '失败越界', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '败', ...sol, writes: ['a'], prompt: 'FAIL PATCH:z/out.md' },
    { label: '拒', ...sol, writes: ['a'], prompt: 'BADPATCH:z/no.md' },
  ] }] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { state } = onlyRun();
  assert.deepEqual(taskOf(state, '败').scope.outside, ['z/out.md']);
  assert.equal(taskOf(state, '拒').scope, null);
  assert.match(result.stdout, /✗ 败 .*\n    ⚠ 越界写入：z\/out\.md\n/);
});

test('验收超时即失败，忽略 SIGTERM 的命令 3 秒后被强制结束；后台进程不拖住验收', { timeout: 30000 }, () => {
  const env = { ...fakePath(), CODEX_FLOW_CHECK_TIMEOUT: '1' };
  const t0 = Date.now();
  const result = runPlan({ name: '强停', cwd: root, phases: [{ title: '一', tasks: [
    { label: '顽固', ...sol, checks: ["trap '' TERM; sleep 20; exit 0"], prompt: '顽固' },
    { label: '后台', ...sol, checks: ['(sleep 20; touch bg-late.txt) & echo started'], prompt: '后台' },
  ] }] }, [], env);
  assert.ok(Date.now() - t0 < 10000, `应在超时加强停之内结束，实际 ${Date.now() - t0}ms`);
  const { state } = onlyRun();
  assert.equal(taskOf(state, '顽固').status, 'failed');
  assert.equal(taskOf(state, '顽固').error, "验收未通过：trap '' TERM; sleep 20; exit 0（超时）");
  assert.equal(taskOf(state, '后台').status, 'completed', result.stdout);
  assert.ok(taskOf(state, '后台').checkResults[0].seconds < 2);
});

test('续跑：验收失败的任务改好验收后只重跑验收；删掉 checks 直接完成；只改 writes 时按新范围重筛越界', () => {
  const repo = gitRepo();
  const plan = (task) => ({ name: '验收续跑', cwd: repo, phases: [{ title: '一', tasks: [{ label: '甲', ...sol, prompt: 'PATCH:z/out.md', ...task }] }] });
  assert.equal(runPlan(plan({ writes: ['a'], checks: ['false'] })).status, 1);
  const { dir, state } = onlyRun();
  assert.equal(taskOf(state, '甲').checkFailed, true);
  assert.deepEqual(taskOf(state, '甲').scope.outside, ['z/out.md']);
  fs.writeFileSync(path.join(root, 'bin/codex'), '#!/bin/sh\nexit 99\n');
  const read = () => taskOf(readJson(statePath(dir)), '甲');
  // 改好验收：不调 Codex，只重跑验收
  assert.equal(runPlan(plan({ writes: ['a'], checks: ['true'] }), ['--resume', state.runId]).status, 0);
  assert.equal(read().status, 'completed');
  assert.equal(read().checkFailed, false);
  // 删掉 checks：直接完成
  assert.equal(runPlan(plan({ writes: ['a'] }), ['--resume', state.runId]).status, 0);
  assert.equal(read().status, 'completed');
  // 范围放宽到 z：原来的越界记录消失
  assert.equal(runPlan(plan({ writes: ['a', 'z'] }), ['--resume', state.runId]).status, 0);
  assert.equal(read().scope, null);
  assert.ok(read().reused);
});

test('promptFile 与 {{file:}} 按计划目录展开，任务 cwd 相对 plan.cwd；展开后的计划供续跑', () => {
  const planDir = path.join(root, 'plans');
  fs.mkdirSync(path.join(planDir, 'parts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'repo', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(planDir, 'parts', 'shared.md'), '共享背景\n');
  fs.writeFileSync(path.join(planDir, 'task.md'), 'CWD\n{{file:parts/shared.md}}');
  const file = path.join(planDir, 'plan.json');
  writeJson(file, { name: '展开', cwd: path.join(root, 'repo'), phases: [{ title: '一', tasks: [
    { label: '子目录', ...sol, cwd: 'sub', promptFile: 'task.md' },
    { label: '默认', ...sol, prompt: 'CWD' },
  ] }] });
  const env = fakePath();
  const result = command(['run', file], { env, timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { dir, state } = onlyRun();
  const real = (p) => fs.realpathSync(p);
  assert.equal(fs.readFileSync(path.join(dir, taskOf(state, '子目录').result), 'utf8').trim(), `cwd=${real(path.join(root, 'repo', 'sub'))}`);
  assert.equal(fs.readFileSync(path.join(dir, taskOf(state, '默认').result), 'utf8').trim(), `cwd=${real(path.join(root, 'repo'))}`);
  assert.equal(taskOf(state, '子目录').cwd, path.join(root, 'repo', 'sub'));
  assert.equal(taskOf(state, '默认').cwd, undefined);
  const saved = readJson(path.join(dir, 'plan.json'));
  assert.equal(saved.phases[0].tasks[0].promptFile, undefined);
  assert.equal(saved.phases[0].tasks[0].prompt, 'CWD\n共享背景');
  assert.equal(saved.phases[0].tasks[0].cwd, path.join(root, 'repo', 'sub'));
  // 引用的文件删掉后，不带计划续跑仍用存下的展开结果，全部复用
  fs.rmSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/codex'), '#!/bin/sh\nexit 99\n');
  const resumed = command(['run', '--resume', state.runId], { env, timeout: 10000 });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.ok(readJson(statePath(dir)).tasks.every((t) => t.reused));
});

for (const [name, tasks, pattern] of [
  ['引用不存在的任务', [{ label: 'x', prompt: '{{task:没有}}' }], /指向不存在的任务: 没有/],
  ['引用所在阶段', [{ label: 'x', prompt: '{{phase:一}}' }], /不能等待自己/],
  ['依赖成环', [{ label: 'x', after: ['y'], prompt: 'x' }, { label: 'y', after: ['x'], prompt: 'y' }], /依赖成环/],
  ['after 不是数组', [{ label: 'x', after: 'y', prompt: 'x' }], /after 要写成/],
  ['prompt 与 promptFile 同时写', [{ label: 'x', prompt: 'x', promptFile: 'x.md' }], /只能写一个/],
  ['promptFile 读不到', [{ label: 'x', promptFile: '没有.md' }], /promptFile 读不到/],
  ['cwd 不存在', [{ label: 'x', cwd: '没有', prompt: 'x' }], /cwd 不是目录/],
]) test(`计划校验：${name}时拒绝启动`, () => {
  const result = runPlan({ name: '校验', cwd: root, phases: [{ title: '一', tasks: tasks.map((t) => ({ ...sol, ...t })) }] });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.deepEqual(fs.readdirSync(RUNS), []);
});

test('汇总给出每个任务的结论：schema 结果带判断与问题数，md 结果取第一段', () => {
  const result = runPlan({ name: '结论', cwd: root, phases: [{ title: '一', tasks: [
    { label: '审', ...sol, schema: 'review', prompt: 'JSON' },
    { label: '写', ...sol, prompt: '写' },
  ] }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ 审 .*\n    pass_with_issues · 1 major, 2 minor\n    第一行结论\n    第二行结论\n/);
  assert.match(result.stdout, /✓ 写 .*\n    假 flow 结果\n/);
  assert.equal(fs.readFileSync(path.join(onlyRun().dir, 'summary.txt'), 'utf8'), result.stdout.slice(result.stdout.indexOf('[codex-flow] 结论 完成')));
});

test('自定义临时模型配置控制 run.sh 和 flow；缺失或损坏配置时均拒绝启动', () => {
  const isolated = path.join(root, 'isolated');
  for (const file of ['run.sh', 'flow/codex-flow.mjs', 'flow/statusline.mjs', 'flow/lib/state.mjs', 'flow/lib/appserver.mjs']) {
    fs.mkdirSync(path.dirname(path.join(isolated, file)), { recursive: true });
    fs.copyFileSync(path.join(skill, file), path.join(isolated, file));
  }
  const config = path.join(isolated, 'models.json');
  const env = fakePath();
  writeJson(config, { models: ['test-only-model'], efforts: ['test-only-effort'] });
  const check = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), '_check', '--model', 'test-only-model', '--effort', 'test-only-effort'], { env, encoding: 'utf8', cwd: root });
  assert.equal(check.status, 0, check.stderr);
  const denied = spawnSync('bash', [path.join(isolated, 'run.sh'), '-m', 'gpt-6.1-sol', '-e', 'high', '-C', root, '测试'], { env, encoding: 'utf8' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /允许范围: test-only-model/);
  for (const content of [undefined, '{broken', '{}']) {
    if (content === undefined) fs.unlinkSync(config); else fs.writeFileSync(config, content);
    fs.rmSync(HOME, { recursive: true, force: true });
    const result = spawnSync('bash', [path.join(isolated, 'run.sh'), '-m', 'gpt-6.1-sol', '-e', 'high', '-C', root, '测试'], { env, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, content === '{}' ? /模型名单格式错误/ : /无法读取模型名单/);
    assert.equal(fs.existsSync(HOME), false);
    const status = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), 'status'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '[codex-flow] 没有运行记录\n');
    const plan = path.join(root, 'plan.json');
    writeJson(plan, { name: '名单拒绝', phases: [{ title: '阶段', tasks: [{ label: '任务', model: 'gpt-6.1-sol', effort: 'high', prompt: '测试' }] }] });
    const flowResult = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), 'run', plan], { env, encoding: 'utf8' });
    assert.equal(flowResult.status, 2);
    assert.equal(flowResult.stderr, result.stderr);
    const dir = single();
    const taskFile = path.join(dir, 'task.txt'); fs.writeFileSync(taskFile, '测试');
    const registration = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), '_single-start', '--dir', dir, '--model', 'gpt-6.1-sol', '--effort', 'high', '--task-file', taskFile], { env, encoding: 'utf8' });
    assert.equal(registration.status, 2);
    assert.equal(registration.stderr, result.stderr);
    const state = readJson(statePath(dir));
    state.session = 'test-session'; writeJson(statePath(dir), state);
    const displayed = spawnSync(process.execPath, [path.join(isolated, 'flow/statusline.mjs')], { env, input: JSON.stringify({ session_id: 'test-session' }), encoding: 'utf8' });
    assert.equal(displayed.status, 0, displayed.stderr);
    assert.match(displayed.stdout, /codex.*任务/);
    const withState = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), 'status'], { env, encoding: 'utf8' });
    assert.equal(withState.status, 0, withState.stderr);
    assert.match(withState.stdout, /运行中/);
    const watched = spawnSync(process.execPath, [path.join(isolated, 'flow/codex-flow.mjs'), 'watch', state.runId, '--alert-after', '0'], { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(watched.status, 0, watched.stderr);
    assert.match(watched.stdout, /请检查日志/);
    assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-pid')), false);
  }
});

test('_single-watch 在父进程运行中消失后自行退出', { timeout: 8000 }, async (t) => {
  const parent = background(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env);
  const dir = single({ pid: parent.child.pid });
  const watcher = background(process.execPath, [cli, '_single-watch', '--dir', dir], process.env);
  t.after(async () => {
    for (const process of [parent, watcher]) {
      if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
      await process.done;
    }
  });
  await until(() => readJson(statePath(dir)).tasks[0].threadId === 'unit-thread', 'watcher 已运行');
  parent.child.kill('SIGTERM');
  await parent.done;
  const result = await watcher.done;
  assert.equal(result.code, 0, result.stderr);
});

test('结束结算忽略空 info、未完成行和无效 usage，不把未知基线当成零', () => {
  const dir = single({ resumed: true });
  const file = rollout();
  fs.writeFileSync(file, line({ timestamp: inside, type: 'event_msg', payload: { type: 'token_count', info: null } }) + JSON.stringify(token(1200, 150, 200, 150)));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({ type: 'turn.completed', usage: usage(1200, 150) }));
  const result = command(['_single-end', '--dir', dir, '--code', '0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  const task = { resumed: true, threadId: 'unit-thread', tokenBaseline: 1000, tokens: 200 };
  fs.renameSync(file, file + '.zst');
  settleSingleTokens(task, start, end, { input_tokens: null, output_tokens: 10 });
  assert.equal(task.tokens, 200);
});

test('flow CLI 通过符号链接启动时 status 仍正常', () => {
  const link = path.join(root, 'flow-cli.mjs');
  fs.symlinkSync(cli, link);
  const result = spawnSync(process.execPath, [link, 'status'], { env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '[codex-flow] 没有运行记录\n');
});

const localDateDir = (at = Date.now(), ago = 0) => {
  const date = new Date(at); date.setDate(date.getDate() - ago);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('/');
};

test('桌面分叉 _<子id>.jsonl 可供查找、watch、结算和实际 context 报告使用', () => {
  const dir = single({ forkedFrom: 'parent-thread' });
  const file = rollout('parent-thread_unit-thread', localDateDir());
  const context = { model: 'gpt-6-astra', effort: 'medium' };
  fs.writeFileSync(file, line({ timestamp: inside, type: 'turn_context', payload: context }) + line(token(102000, 26845, 12000, 6965)));
  assert.equal(findRollout('unit-thread'), file);
  assert.deepEqual(singleContext('unit-thread', start, end), { found: true, context });
  singleWatchTick(dir, cache());
  const task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.tokenBaseline, 109880);
  assert.equal(task.tokens, 18965);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({ type: 'turn.completed', usage: usage(102000, 26845) }));
  const result = command(['_single-end', '--dir', dir, '--code', '0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /实际使用: model=gpt-6-astra effort=medium/);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, 18965);
});

for (const scenario of ['cached', 'prior', 'missing', 'current-only', 'invalid-last']) test(`分叉 _single-end 基线回退：${scenario}`, () => {
  const dir = single({ forkedFrom: 'parent-thread' });
  if (scenario === 'cached') {
    const state = readJson(statePath(dir)); state.tasks[0].tokenBaseline = 109880;
    writeJson(statePath(dir), state);
  }
  if (scenario === 'cached' || scenario === 'current-only') fs.writeFileSync(rollout(), line(token(102000, 26845, 12000, 6965)));
  if (scenario === 'prior') fs.writeFileSync(rollout(), line(token(90000, 19880, 10, 10, before)));
  if (scenario === 'invalid-last') fs.writeFileSync(rollout(), line(token(102000, 26845, null, 10)));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({ type: 'turn.completed', usage: usage(102000, 26845) }));
  const result = command(['_single-end', '--dir', dir, '--code', '0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const task = readJson(statePath(dir)).tasks[0];
  const known = scenario === 'cached' || scenario === 'prior';
  assert.equal(task.tokenBaseline, known ? 109880 : undefined);
  assert.equal(task.tokens, known ? 18965 : undefined);
  assert.equal(task.forkedFrom, 'parent-thread');
});

for (const inherited of [{ resumed: true }, { forkedFrom: 'parent-thread' }]) test(`watch 遇到无效 last 时不猜基线：${JSON.stringify(inherited)}`, () => {
  const dir = single(inherited);
  fs.writeFileSync(rollout(), line(token(102000, 26845, null, 10)));
  singleWatchTick(dir, cache());
  const task = readJson(statePath(dir)).tasks[0];
  assert.equal(task.tokenBaseline, undefined);
  assert.equal(task.tokens, undefined);
  settleSingleTokens(task, start, end, usage(102000, 26845));
  assert.equal(task.tokens, undefined);
});

test('watcher 写状态抛错后继续轮询，重新读取未保存的事件与 token', async (t) => {
  const dir = single({ forkedFrom: 'parent-thread' });
  fs.writeFileSync(rollout('unit-thread', localDateDir()), line(token(102000, 26845, 12000, 6965)));
  const rename = fs.renameSync;
  let failures = 0, waits = 0, ticks = 0;
  t.mock.method(fs, 'renameSync', function(source, destination) {
    if (destination === statePath(dir) && failures++ === 0) throw new Error('临时写入失败');
    return rename.call(this, source, destination);
  });
  await watchSingle(dir, {
    tick(...args) { ticks++; return singleWatchTick(...args); },
    async wait(ms) {
      assert.equal(ms, 2000);
      waits++;
      const state = readJson(statePath(dir));
      if (waits === 1) {
        assert.equal(state.tasks[0].threadId, null);
        assert.equal(state.tasks[0].tokens, undefined);
      } else {
        assert.equal(state.tasks[0].threadId, 'unit-thread');
        assert.equal(state.tasks[0].tokens, 18965);
        state.pid = 2147483647; writeJson(statePath(dir), state);
      }
    },
  });
  assert.equal(ticks, 3);
  assert.equal(waits, 2);
  assert.equal(readJson(statePath(dir)).tasks[0].tokenBaseline, 109880);
});

test('watcher 轮询抛错且父进程消失时直接退出', async () => {
  const dir = single();
  let ticks = 0;
  await watchSingle(dir, {
    tick() {
      ticks++;
      const state = readJson(statePath(dir)); state.pid = 2147483647;
      writeJson(statePath(dir), state);
      throw new Error('本轮失败');
    },
    async wait() { assert.fail('父进程已消失，不应继续等待'); },
  });
  assert.equal(ticks, 1);
});

test('缺文件时前 30 秒每轮只查最近 3 天，之后全目录查找间隔至少 10 秒', (t) => {
  const dir = single();
  const initial = Date.now();
  const sessions = path.join(process.env.CODEX_HOME, 'sessions');
  for (let ago = 0; ago < 4; ago++) fs.mkdirSync(path.join(sessions, localDateDir(initial, ago)), { recursive: true });
  const readdir = fs.readdirSync;
  const reader = cache(); delete reader.searchStartedAt;
  let at = initial;
  const calls = [], fullAt = [];
  t.mock.method(fs, 'readdirSync', function(file, ...args) {
    calls.push(file);
    if (file === sessions) fullAt.push(at - initial);
    return readdir.call(this, file, ...args);
  });
  for (let elapsed = 0; elapsed <= 52000; elapsed += 2000) {
    at = initial + elapsed;
    calls.length = 0;
    assert.equal(singleWatchTick(dir, reader, { now: () => at }), true);
    if (elapsed < 30000) {
      assert.deepEqual(calls, [0, 1, 2].map((ago) => path.join(sessions, localDateDir(at, ago))));
    } else if (elapsed % 10000 !== 0) {
      assert.equal(calls.includes(sessions), false);
    }
  }
  assert.deepEqual(fullAt, [30000, 40000, 50000]);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
});

test('recentOnly 不查第 4 天或旧目录；延迟到 30 秒的全目录查找能找到旧 rollout', () => {
  const dir = single();
  const at = Date.now();
  const fourth = rollout('unit-thread', localDateDir(at, 3));
  fs.writeFileSync(fourth, line(token(1120, 80, 120, 80)));
  assert.equal(findRollout('unit-thread', { recentOnly: true, now: at }), null);
  assert.equal(findRollout('unit-thread', { now: at }), fourth);
  const file = rollout(); fs.renameSync(fourth, file);
  const reader = cache(); delete reader.searchStartedAt;
  singleWatchTick(dir, reader, { now: () => at });
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, undefined);
  singleWatchTick(dir, reader, { now: () => at + 29999 });
  assert.equal(reader.rollout, null);
  singleWatchTick(dir, reader, { now: () => at + 30000 });
  assert.equal(reader.rollout, file);
  assert.equal(readJson(statePath(dir)).tasks[0].tokens, 200);
});

test('全目录查找抛错也计入 10 秒限频，下一轮仍可发现近期文件', async () => {
  const dir = single();
  const initial = Date.now();
  let elapsed = 0;
  const options = [];
  await watchSingle(dir, {
    now: () => initial + elapsed,
    tick(dir, reader, { now }) {
      return singleWatchTick(dir, reader, {
        now,
        find(threadId, option) {
          options.push([elapsed, option.recentOnly]);
          if (!option.recentOnly) throw new Error('目录暂时不可读');
          return findRollout(threadId, option);
        },
      });
    },
    async wait() {
      elapsed += 2000;
      if (elapsed === 32000) fs.writeFileSync(rollout('unit-thread', localDateDir(initial)), line(token(1120, 80, 120, 80)));
      if (elapsed === 34000) {
        const state = readJson(statePath(dir));
        assert.equal(state.tasks[0].tokens, 200);
        state.status = 'completed'; writeJson(statePath(dir), state);
      }
    },
  });
  assert.deepEqual(options.filter(([, recentOnly]) => !recentOnly), [[30000, false]]);
  assert.deepEqual(options.at(-1), [32000, true]);
});

test('run.sh 登记失败（_check 通过后模型名单消失）时只提示，任务照常运行', () => {
  const isolated = path.join(root, 'isolated');
  for (const file of ['run.sh', 'flow/codex-flow.mjs', 'flow/lib/state.mjs', 'flow/lib/appserver.mjs']) {
    fs.mkdirSync(path.dirname(path.join(isolated, file)), { recursive: true });
    fs.copyFileSync(path.join(skill, file), path.join(isolated, file));
  }
  const config = path.join(isolated, 'models.json');
  writeJson(config, { models: ['gpt-6.1-sol'], efforts: ['high'] });
  const env = fakePath();
  const nodeWrapper = path.join(root, 'bin/node');
  fs.writeFileSync(nodeWrapper, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[1] === '_single-start') fs.unlinkSync(${JSON.stringify(config)});
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  fs.chmodSync(nodeWrapper, 0o755);
  // 假 codex 看到这两个文件就直接跑完
  const marks = ['advance', 'finish', 'fake-pid'].map((name) => path.join(process.env.CODEX_HOME, name));
  fs.rmSync(marks[2], { force: true });
  fs.writeFileSync(marks[0], '');
  fs.writeFileSync(marks[1], '');
  try {
    const result = spawnSync('bash', [path.join(isolated, 'run.sh'), '-m', 'gpt-6.1-sol', '-e', 'high', '-C', root, '测试'], { env, encoding: 'utf8', timeout: 30000 });
    assert.match(result.stdout, /没能登记到 Codex 任务面板，任务照常运行/, result.stdout + result.stderr);
    assert.ok(fs.existsSync(marks[2]), 'Codex 仍被调用');
    assert.match(result.stdout, /Codex 最终回复/);
    // 结束时补登：报告照常、不算出错，Codex 成功就返回 0
    assert.doesNotMatch(result.stdout, /报告出错/);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const registered = fs.readdirSync(RUNS).map((name) => readJson(statePath(path.join(RUNS, name)))).filter(Boolean);
    assert.ok(registered.some((state) => state.status === 'completed' && state.tasks[0].model === 'gpt-6.1-sol'), '结束时补登了记录');
  } finally {
    for (const mark of marks) fs.rmSync(mark, { force: true });
  }
});

test('状态行和面板一样把 flow 排在单个 agent 前面，即使单个 agent 更新', () => {
  fs.mkdirSync(RUNS, { recursive: true });
  const at = (ago) => new Date(Date.now() - ago * 1000).toISOString();
  const base = { version: 1, session: 'order-session', pid: process.pid, alertAfter: null, status: 'running', endedAt: null };
  record('r-order', { ...base, kind: 'flow', runId: 'r-order', name: '大流程', startedAt: at(300), phases: [{ title: '审查', status: 'running' }], tasks: [{ label: '甲', phase: '审查', model: 'gpt-6.1-sol', effort: 'high', status: 'running', startedAt: at(300) }] });
  record('s-order', { ...base, kind: 'single', runId: 's-order', name: '小任务', startedAt: at(60), phases: [{ title: '任务', status: 'running' }], tasks: [{ label: '小任务', phase: '任务', model: 'gpt-6.1-sol', effort: 'high', status: 'running', startedAt: at(60) }] });
  const shown = spawnSync(process.execPath, [path.join(skill, 'flow/statusline.mjs')], { input: JSON.stringify({ session_id: 'order-session' }), encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /大流程.*小任务/);
});
