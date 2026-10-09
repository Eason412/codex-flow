import { root, RUNS, sol, command, fakePath, runPlan, lastRun, sleep, background, writeJson, readJson, statePath, gitRepo } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, busy, isAlive, pruneOldRuns, hasArchive } from '../lib/state.mjs';
import { cleanRunArchives } from '../lib/isolation.mjs';
import { appendHistory, historyRecord } from '../lib/history.mjs';

const plan = (tasks, cwd = root) => ({ name: '停止续跑', cwd, phases: [{ title: '核对结果', tasks }] });
const task = (label = '甲', extra = {}) => ({ label, ...sol, prompt: '做事', writes: [], ...extra });
const history = () => fs.readFileSync(path.join(HOME, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(30); }
  throw new Error('等待测试条件超时');
}
function start(t, value, args = [], extra = {}) {
  const file = path.join(root, 'plan.json');
  writeJson(file, value);
  const p = background(['run', file, ...args], fakePath(extra));
  t.after(async () => { if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL'); await p.done; });
  return p;
}
function fixture(kind = 'flow', status = 'running') {
  const dir = path.join(RUNS, 'r-fixture');
  fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
  const state = { runId: 'r-fixture', name: '测试', cwd: root, kind, status, pid: process.pid,
    startedAt: new Date().toISOString(), endedAt: null, phases: [{ title: '核对结果', status }],
    tasks: [task('甲', { phase: '核对结果', status, startedAt: new Date().toISOString() })] };
  writeJson(statePath(dir), state);
  return { dir, state };
}

for (const mode of ['lost', 'archive-failed', 'recheck']) test(`1 续跑保留旧 worktree 的唯一改动：${mode}`, () => {
  const { repo, git } = gitRepo();
  const value = plan([task('甲', { isolation: 'worktree', keepWorktree: true, writes: ['.'] })], repo);
  assert.equal(runPlan(value).status, 0);
  const { dir, state } = lastRun();
  const old = state.tasks[0].worktree.path;
  fs.writeFileSync(path.join(old, '唯一.txt'), '不能丢失\n');
  if (mode !== 'recheck') {
    state.status = mode === 'lost' ? 'running' : 'failed';
    state.tasks[0].status = state.status;
    state.tasks[0].branch.archiveError = '模拟归档失败';
    state.pid = 2147483647;
    writeJson(statePath(dir), state);
  } else value.phases[0].tasks[0].checks = ['true'];
  const r = runPlan(value, ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(old, '唯一.txt'), 'utf8'), '不能丢失\n');
  const after = readJson(statePath(dir));
  assert.ok(after.leftovers.worktrees.some((w) => w.path === old));
  assert.ok(r.stdout.includes(old), '汇总给出旧成果路径');
  assert.ok(git('worktree', 'list', '--porcelain').includes(old));
});

test('2 停止收尾中拒绝 resume 和 clean，watch 等本轮汇总', async (t) => {
  const value = plan([task('甲', { prompt: 'SLOW 做事' })]);
  assert.equal(runPlan(value, [], fakePath({ FAKE_SLOW_MS: '30' })).status, 0);
  const { dir, state } = lastRun();
  fs.writeFileSync(path.join(dir, 'summary.txt'), '上一轮汇总标记\n');
  const p = start(t, value, ['--resume', state.runId, '--rerun', '甲'], { FAKE_SLOW_MS: '30000', FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1' });
  await until(() => { const s = readJson(statePath(dir)); return s?.pid === p.child.pid && s.tasks[0].threadId; });
  p.child.kill('SIGTERM');
  await until(() => readJson(statePath(dir))?.status === 'cancelled');
  const resumed = command(['run', '--resume', state.runId], { env: fakePath(), timeout: 10000 });
  const cleaned = command(['clean', state.runId]);
  const watcher = background(['watch', state.runId], process.env);
  t.after(async () => { if (watcher.child.exitCode === null) watcher.child.kill(); await watcher.done; });
  const finished = await p.done;
  const watched = await watcher.done;
  assert.equal(finished.code, 143);
  assert.notEqual(resumed.status, 0, resumed.stdout);
  assert.match(resumed.stderr, /还在运行/);
  assert.notEqual(cleaned.status, 0);
  assert.match(cleaned.stderr, /还在运行/);
  assert.doesNotMatch(watched.stdout, /上一轮汇总标记/);
  assert.equal(watched.stdout, fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8'));
  assert.equal(readJson(statePath(dir)).pid, p.child.pid);
});

for (const kind of ['flow', 'single']) test(`2 watch 不读取过期汇总并等待新汇总：${kind}`, async (t) => {
  const { dir, state } = fixture(kind, 'completed');
  const summary = path.join(dir, 'summary.txt');
  fs.writeFileSync(summary, '旧汇总\n');
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(summary, old, old);
  const watcher = background(['watch', state.runId], process.env);
  t.after(async () => { if (watcher.child.exitCode === null) watcher.child.kill(); await watcher.done; });
  await sleep(300);
  const premature = watcher.child.exitCode;
  fs.writeFileSync(summary, '本轮汇总\n');
  const r = await watcher.done;
  assert.equal(premature, null);
  assert.equal(r.stdout, '本轮汇总\n');
  state.pid = 2147483647;
  writeJson(statePath(dir), state);
  fs.utimesSync(summary, old, old);
  assert.doesNotMatch(command(['watch', state.runId]).stdout, /旧汇总|本轮汇总/);
});

for (const stop of ['flow', 'task', 'pending']) test(`3 停止 recheck 后仍只重跑验收：${stop}`, async (t) => {
  const { repo } = gitRepo();
  const make = (checks) => plan([
    ...(stop === 'pending' ? [task('前置', { prompt: 'SLOW 前置', writes: [] })] : []),
    task('甲', { prompt: 'PATCH:out.txt', writes: ['out.txt'], checks, ...(stop === 'pending' ? { after: ['前置'] } : {}) }),
  ], repo);
  assert.equal(runPlan(make(['true']), [], fakePath({ FAKE_SLOW_MS: '30' })).status, 0);
  const { dir, state } = lastRun();
  const result = path.join(repo, 'out.txt');
  const original = fs.readFileSync(result, 'utf8');
  // pending 场景让前置也只重跑验收，保持下游结果的复用资格。
  const next = make(['sleep 20']);
  if (stop === 'pending') next.phases[0].tasks[0].checks = ['sleep 20'];
  const p = start(t, next, ['--resume', state.runId]);
  await until(() => { const s = readJson(statePath(dir)); return s?.pid === p.child.pid && s.tasks.some((x) => x.checking); });
  if (stop === 'task') assert.equal(command(['cancel', state.runId, '甲']).status, 0);
  else p.child.kill('SIGTERM');
  await p.done;
  const r = runPlan(make(['true']), ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = readJson(statePath(dir)).tasks.find((x) => x.label === '甲');
  assert.equal(after.reused, true);
  assert.equal(fs.readFileSync(result, 'utf8'), original, 'Codex 没有再次写文件');
});

test('4 recheck 按 writes 持租约，与重叠写入串行', () => {
  const { repo } = gitRepo();
  const make = (checks) => plan([task('甲', { writes: ['x'], checks }), task('乙', { writes: ['x'], prompt: 'SLOW PATCH:x/b' })], repo);
  assert.equal(runPlan(make(['true']), [], fakePath({ FAKE_SLOW_MS: '30' })).status, 0);
  const { dir, state } = lastRun();
  const r = runPlan(make(['sleep 1']), ['--resume', state.runId, '--rerun', '乙']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [a, b] = readJson(statePath(dir)).tasks;
  assert.equal(a.reused, true);
  assert.ok(Date.parse(a.endedAt) <= Date.parse(b.startedAt), '验收结束后才开始重叠写入');
});

test('4 隔离 recheck 建 worktree 时计入上限', () => {
  const { repo } = gitRepo();
  const make = (checks) => plan([task('甲', { isolation: 'worktree', checks }), task('乙', { isolation: 'worktree' })], repo);
  assert.equal(runPlan(make(['true'])).status, 0);
  const { dir, state } = lastRun();
  const r = runPlan(make(['sleep 1']), ['--resume', state.runId, '--rerun', '乙'], fakePath({ CODEX_FLOW_MAX_WORKTREES: '1' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [a, b] = readJson(statePath(dir)).tasks;
  assert.ok(Date.parse(a.endedAt) <= Date.parse(b.startedAt));
});

test('5 全部任务已结束，补归档中停止保留完成状态，信号退出码仍为 143', async (t) => {
  const p = start(t, plan([task()]), [], { FAKE_ARCHIVE: 'hang' });
  const run = await until(() => { const r = lastRun(); return r?.state.tasks[0]?.status === 'completed' && r; });
  p.child.kill('SIGTERM');
  const r = await p.done;
  assert.equal(r.code, 143, r.stdout + r.stderr);
  assert.equal(readJson(statePath(run.dir)).status, 'completed');
  assert.equal(readJson(statePath(run.dir)).phases[0].status, 'completed');
  assert.equal(history().at(-1).status, 'completed');
});

test('6 被删掉的 keepWorktree 任务进入 leftovers，到期清除目录和登记', () => {
  const { repo, git } = gitRepo();
  assert.equal(runPlan(plan([task('甲', { isolation: 'worktree', keepWorktree: true })], repo)).status, 0);
  const { dir, state } = lastRun();
  const wt = state.tasks[0].worktree.path;
  assert.equal(runPlan(plan([task('乙')], repo), ['--resume', state.runId]).status, 0);
  const after = readJson(statePath(dir));
  assert.ok(hasArchive(after));
  assert.equal(after.leftovers.worktrees[0].path, wt);
  after.startedAt = after.endedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  writeJson(statePath(dir), after);
  pruneOldRuns(7, cleanRunArchives);
  assert.ok(fs.existsSync(dir), '隔离成果保留 30 天');
  after.startedAt = after.endedAt = new Date(Date.now() - 31 * 86400000).toISOString();
  writeJson(statePath(dir), after);
  pruneOldRuns(7, cleanRunArchives);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(wt), false);
  assert.ok(!git('worktree', 'list', '--porcelain').includes(wt));
});

for (const kind of ['flow', 'single']) test(`7 cancel 拒绝已结束运行的复用 PID：${kind}`, async (t) => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = new Promise((resolve) => victim.on('close', resolve));
  t.after(async () => { victim.kill('SIGKILL'); await closed; });
  const { dir, state } = fixture(kind, 'completed');
  state.pid = victim.pid;
  writeJson(statePath(dir), state);
  const r = command(['cancel', state.runId]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不在运行/);
  assert.ok(isAlive(victim.pid));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'control')), []);
});

test('8 --resume 空字符串、等号空值和缺值均报错且不开新运行', () => {
  const file = path.join(root, 'plan.json');
  writeJson(file, plan([task()]));
  for (const args of [['--resume', ''], ['--resume='], ['--resume']]) {
    const r = command(['run', file, ...args], { env: fakePath() });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--resume.*runId/);
  }
  assert.deepEqual(fs.readdirSync(RUNS), []);
});

for (const kind of ['single', 'lost']) test(`9 steer 拒绝无接收方的运行：${kind}`, () => {
  const { dir, state } = fixture(kind === 'single' ? 'single' : 'flow');
  if (kind === 'lost') { state.pid = 2147483647; writeJson(statePath(dir), state); }
  const r = command(['steer', state.runId, '甲', '补充要求']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, kind === 'single' ? /run\.sh -r/ : /不在运行/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'control')), []);
});

test('10 过期清理按 startedAt 补录异常退出的续跑轮次', () => {
  const { dir, state } = fixture();
  state.pid = 2147483647;
  state.startedAt = '2020-01-01T00:00:00Z';
  appendHistory(dir, state);
  state.startedAt = '2020-01-02T00:00:00Z';
  state.resumed = true;
  writeJson(statePath(dir), state);
  pruneOldRuns();
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(history().map((r) => r.startedAt), ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z']);
});

test('10 history --backfill 按轮次补录且重复执行不重复记录', () => {
  const { dir, state } = fixture();
  appendHistory(dir, state);
  state.startedAt = '2020-01-02T00:00:00Z';
  writeJson(statePath(dir), state);
  assert.equal(command(['history', '--backfill']).status, 0);
  assert.equal(command(['history', '--backfill']).status, 0);
  assert.equal(history().length, 2);
});

test('11 意外退出的耗时取最后活动时间，无法取得则为 null', () => {
  const { dir, state } = fixture('single');
  state.pid = 2147483647;
  state.startedAt = state.tasks[0].startedAt = '2020-01-01T00:00:00Z';
  writeJson(statePath(dir), state);
  const end = new Date('2020-01-01T00:02:00Z');
  fs.utimesSync(statePath(dir), end, end);
  pruneOldRuns();
  assert.equal(history()[0].tasks[0].seconds, 120);
  assert.equal(historyRecord(dir, state).tasks[0].seconds, null);
});

test('结束已久、本轮汇总已写出的运行，进程号被复用也不拦续跑和 clean；收尾中的才拦', () => {
  const { dir, state } = fixture('flow', 'completed');
  const hour = 3600_000;
  Object.assign(state, { startedAt: new Date(Date.now() - 2 * hour).toISOString(), endedAt: new Date(Date.now() - hour).toISOString() });
  writeJson(statePath(dir), state);
  // pid 是测试进程自己，活着：模拟被复用
  assert.equal(busy(dir, state), false, '结束已超过一分钟');
  fs.writeFileSync(path.join(dir, 'summary.txt'), '汇总\n');
  assert.equal(busy(dir, state), false);
  assert.equal(command(['clean', 'r-fixture']).status, 0);
  fs.rmSync(path.join(dir, 'summary.txt'));
  state.endedAt = new Date().toISOString();
  writeJson(statePath(dir), state);
  assert.equal(busy(dir, state), true);
  assert.match(command(['clean', 'r-fixture']).stderr, /还在运行/);
});
