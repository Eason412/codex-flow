// app-server 启动阶段失败（initialize 被拒、不回应、子进程提前退出、spawn 失败）时的清理：子进程要被关掉，任务记为失败，run 能按时结束。
import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { background, fakePath, lastRun, readJson, root, sleep, sol, taskOf, writeJson } from './helpers.mjs';

const pidFile = () => path.join(process.env.CODEX_HOME, 'fake-app-pid');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
async function waitFor(check, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return;
  assert.fail(`${ms} 毫秒内没等到：${what}`);
}

// 后台跑一个计划：bad 任务在 cwd 含 "bad" 的目录里，假 Codex 只对它发 FAKE_INIT 故障；slow 任务正常但慢
function startFlow(env, { withSlow = false } = {}) {
  fs.mkdirSync(path.join(root, 'bad'), { recursive: true });
  const task = (label, prompt, extra = {}) => ({ label, ...sol, prompt, ...extra });
  const tasks = [task('bad', '测试', { cwd: 'bad' }), ...(withSlow ? [task('slow', 'SLOW')] : [])];
  const file = path.join(root, 'plan.json');
  writeJson(file, { name: '启动失败', cwd: root, phases: [{ title: '阶段', tasks }] });
  return background(['run', file], fakePath({ FAKE_INIT_ONLY: 'bad', ...env }));
}

// run 必须在 ms 毫秒内结束；超时就杀掉并让测试失败，免得挂住整个测试进程
async function finishWithin(flow, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([flow.done, timeout]);
  clearTimeout(timer);
  if (!result) {
    flow.child.kill('SIGKILL');
    assert.fail(`run 超过 ${ms} 毫秒还没结束`);
  }
  return result;
}

// 记下的子进程无论测试成败都要清掉，不留残留
async function withCleanup(body) {
  try {
    await body();
  } finally {
    if (fs.existsSync(pidFile())) {
      const pid = Number(fs.readFileSync(pidFile(), 'utf8'));
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
}
const recordedPid = () => Number(fs.readFileSync(pidFile(), 'utf8'));

test('initialize 被拒：失败任务的子进程在其他任务还在跑时就被关掉', () => withCleanup(async () => {
  const flow = startFlow({ FAKE_INIT: 'error', FAKE_SLOW_MS: '5000' }, { withSlow: true });
  await waitFor(() => fs.existsSync(pidFile()), 8000, '假 app-server 写下 pid');
  const pid = recordedPid();
  await waitFor(() => taskOf(lastRun().state, 'bad')?.status === 'failed', 8000, 'bad 任务记为失败');
  // slow 任务还在跑（要 5 秒），此时 bad 的子进程不该继续活着
  assert.equal(taskOf(lastRun().state, 'slow').status, 'running');
  await waitFor(() => !alive(pid), 2000, '失败任务的子进程退出');
  const result = await finishWithin(flow, 15000);
  assert.equal(result.code, 1);
  const bad = taskOf(lastRun().state, 'bad');
  assert.match(bad.error, /启动失败.*假初始化被拒/);
  assert.equal(taskOf(lastRun().state, 'slow').status, 'completed');
}));

test('initialize 被拒且子进程不理会 stdin 结束和 SIGTERM：run 结束时子进程也已不在', () => withCleanup(async () => {
  const flow = startFlow({ FAKE_INIT: 'error', FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1' });
  const result = await finishWithin(flow, 15000);
  assert.equal(result.code, 1);
  assert.match(taskOf(lastRun().state, 'bad').error, /启动失败.*假初始化被拒/);
  assert.equal(alive(recordedPid()), false, '子进程应已被 SIGKILL');
}));

test('initialize 一直不回应：启动超时后任务失败，run 按时结束，子进程被关掉', () => withCleanup(async () => {
  const flow = startFlow({ FAKE_INIT: 'silent', CODEX_FLOW_INIT_TIMEOUT_MS: '600' });
  const result = await finishWithin(flow, 10000);
  assert.equal(result.code, 1);
  const bad = taskOf(lastRun().state, 'bad');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /启动失败.*initialize.*没有回应/);
  assert.equal(alive(recordedPid()), false);
}));

test('子进程在回应 initialize 前退出：挂起的请求被 reject，任务失败并写明退出', async () => {
  const flow = startFlow({ FAKE_INIT: 'exit' });
  const result = await finishWithin(flow, 10000);
  assert.equal(result.code, 1);
  const bad = taskOf(lastRun().state, 'bad');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /启动失败.*app-server 退出了.*exit 3/);
});

test('找不到 codex（spawn 失败）：任务失败并写明原因，run 正常结束', async () => {
  const flow = startFlow({ PATH: path.join(root, 'no-bin') });
  const result = await finishWithin(flow, 10000);
  assert.equal(result.code, 1);
  const bad = taskOf(lastRun().state, 'bad');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /启动失败.*ENOENT/);
  assert.ok(readJson(path.join(lastRun().dir, 'state.json')));
});

test('启动中收到停止信号：卡在 initialize、不理会 stdin 结束和 SIGTERM 的子进程也被结束', () => withCleanup(async () => {
  const flow = startFlow({ FAKE_INIT: 'silent', FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1' });
  await waitFor(() => fs.existsSync(pidFile()), 8000, '假 app-server 写下 pid');
  const pid = recordedPid();
  flow.child.kill('SIGTERM');
  const result = await finishWithin(flow, 8000);
  assert.equal(result.code, 143);
  await waitFor(() => !alive(pid), 1000, '子进程退出');
}));
