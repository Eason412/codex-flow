// 隔离、停止与续跑的边界（审查时复现过的问题）：任务名归一化后重名、writes 写 "." 越到父目录、强制暂存的被忽略文件、
// 受管链接的上级被换成链接、停止的几个时间窗口、连续续跑保留过期提示，以及 Codex 对话归档
import { root, RUNS, sol, sleep, runPlan, lastRun, taskOf, gitRepo, fakePath, background, command, readJson, writeJson, statePath } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { removeWorktree } = await import('../lib/archive.mjs');
const { settleChecks } = await import('../lib/checks.mjs');
const { markStopping } = await import('../lib/runtime.mjs');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(...parts));
const plan = (cwd, tasks) => ({ name: '边界', cwd, phases: [{ title: '一', tasks }] });
const iso = (label, prompt, more = {}) => ({ label, ...sol, isolation: 'worktree', prompt, ...more });
const paragraphs = Array.from({ length: 20 }, (_, i) => `第${i + 1}段\n`).join('');

// 后台运行时等到状态满足条件，返回 { dir, state }
async function waitState(pred, tries = 150) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    const id = fs.readdirSync(RUNS).filter((n) => n.startsWith('r-')).sort().at(-1);
    const dir = id && path.join(RUNS, id);
    const state = dir && readJson(statePath(dir));
    if (state && pred(state)) return { dir, state };
  }
  throw new Error('等不到预期的运行状态');
}

// 记下 pid 的 app-server（STUBBORN）是否都已退出
const pidsFile = () => path.join(process.env.CODEX_HOME, 'fake-app-pids');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stubborn = () => (fs.existsSync(pidsFile()) ? fs.readFileSync(pidsFile(), 'utf8').split('\n').filter(Boolean).map(Number) : []);
const killAll = () => stubborn().forEach((pid) => alive(pid) && process.kill(pid, 'SIGKILL'));

function start(tasks, repo, env) {
  const file = path.join(root, 'plan.json');
  writeJson(file, plan(repo, tasks));
  return background(['run', file], fakePath(env));
}

test('任务名归一化后重名（只差标点、空白或大小写）时拒绝启动：隔离目录和引用、结果文件都会互相覆盖', () => {
  const { repo } = gitRepo();
  for (const [a, b] of [['a.b', 'a_b'], ['A', 'a']]) {
    const r = runPlan(plan(repo, [iso(a, '甲'), iso(b, '乙')]));
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`「${a}」和「${b}」`));
  }
  const plain = runPlan(plan(repo, [{ label: 'x y', ...sol, prompt: '甲' }, { label: 'x_y', ...sol, prompt: '乙' }]));
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /「x y」和「x_y」/);
  assert.equal(runPlan(plan(repo, [{ label: 'a.b', ...sol, prompt: '甲' }, { label: 'a_b', ...sol, prompt: '乙' }])).status, 0, '不隔离时 a.b 和 a_b 的结果文件不同名');
});

test('writes 写 "." 只覆盖任务 cwd 及其下：写到父目录算越界', () => {
  const { repo } = gitRepo('repo', { 'pkg/x.md': '原\n', 'outside.md': '外\n' });
  const pkg = path.join(repo, 'pkg');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:x.md PATCH:../outside.md', { cwd: pkg, writes: ['.'] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(taskOf(lastRun().state, '甲').scope.outside, ['../outside.md']);
  runPlan(plan(repo, [{ label: '乙', ...sol, cwd: pkg, writes: ['.'], prompt: 'PATCH:../outside.md' }]));
  assert.deepEqual(taskOf(lastRun().state, '乙').scope?.outside, ['../outside.md']);
});

test('主工作区强制暂存的被忽略文件：隔离任务没碰时不算删除，改了时成果里是改后的内容；主仓库 index 不变', () => {
  const { repo, git } = gitRepo('repo', { '.gitignore': '*.secret\n', 'x.md': '原\n' });
  fs.writeFileSync(path.join(repo, 'config.secret'), '密\n');
  git('add', '-f', 'config.secret');
  let r = runPlan(plan(repo, [iso('甲', 'PATCH:x.md')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let b = taskOf(lastRun().state, '甲').branch;
  assert.deepEqual(b.files, ['x.md']);
  assert.equal(git('diff', '--name-only', b.base, b.name), 'x.md\n', '没有被当成删除');
  r = runPlan(plan(repo, [iso('乙', 'SHELL:config.secret')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  b = taskOf(lastRun().state, '乙').branch;
  assert.match(git('show', `${b.name}:config.secret`), /^写入 /);
  assert.equal(read(repo, 'config.secret'), '密\n');
  assert.equal(git('diff', '--cached', '--name-only'), 'config.secret\n');
});

test('删 worktree 时受管链接的上级被换成指回主工作区的链接：不跟着进主工作区删东西', () => {
  const main = path.join(root, 'main');
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(main, 'pkg'), { recursive: true });
  fs.mkdirSync(store);
  fs.symlinkSync(store, path.join(main, 'pkg', 'node_modules'));
  const wt = path.join(root, 'wts', 'wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.symlinkSync(path.join(main, 'pkg'), path.join(wt, 'pkg'));
  removeWorktree(main, wt, ['pkg/node_modules']);
  assert.ok(fs.lstatSync(path.join(main, 'pkg', 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink(), '主工作区的链接还在');
  assert.equal(exists(wt), false);
});

test('整个停止时：验收被杀的任务仍记为已停止，等不理 SIGTERM 的 app-server 退出后以 143 结束；隔离任务已写的部分存成分支', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const { done } = start([
    { label: '甲', ...sol, writes: ['a.md'], prompt: '甲', checks: ['sleep 5'] },
    iso('乙', 'SLOW PATCH:b.md', { writes: ['b.md'] }),
    { label: '丙', ...sol, writes: [], prompt: 'SLOW STUBBORN' },
  ], repo, { FAKE_SLOW_MS: '20000' });
  try {
    const { dir, state } = await waitState((s) => taskOf(s, '甲')?.checking && taskOf(s, '乙')?.worktree && fs.existsSync(pidsFile()));
    fs.writeFileSync(path.join(taskOf(state, '乙').worktree.path, 'b.md'), '一半\n');
    process.kill(state.pid, 'SIGTERM');
    const { code, stdout } = await done;
    assert.equal(code, 143, stdout);
    const after = readJson(statePath(dir));
    assert.deepEqual(after.tasks.map((t) => [t.label, t.status]), [['甲', 'cancelled'], ['乙', 'cancelled'], ['丙', 'cancelled']]);
    assert.deepEqual(taskOf(after, '乙').branch.files, ['b.md']);
    assert.deepEqual(stubborn().filter(alive), [], 'app-server 都已退出');
  } finally {
    killAll();
  }
});

test('Codex 已结束、app-server 还在关闭时整个停止：等它真正退出再以 143 结束', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const { done } = start([iso('甲', 'PATCH:a.md STUBBORN', { writes: ['a.md'] })], repo);
  try {
    const { dir, state } = await waitState((s) => s.tasks[0]?.log && exists(RUNS, s.runId, s.tasks[0].log) && read(RUNS, s.runId, s.tasks[0].log).includes('"turn/completed"'), 300);
    await sleep(100);
    process.kill(state.pid, 'SIGTERM');
    const { code } = await done;
    assert.equal(code, 143);
    assert.equal(stubborn().length, 1);
    assert.deepEqual(stubborn().filter(alive), [], 'app-server 已退出');
    assert.equal(readJson(statePath(dir)).tasks[0].status, 'cancelled');
  } finally {
    killAll();
  }
});

test('Codex 刚结束、验收还没开始时整个停止：不再启动验收命令，任务记为已停止', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const { done } = start([
    { label: '甲', ...sol, writes: ['a.md'], prompt: 'PATCH:a.md', checks: ['echo ran > after-stop.txt'] },
    { label: '丙', ...sol, writes: [], prompt: 'SLOW STUBBORN' },
  ], repo, { FAKE_SLOW_MS: '20000' });
  try {
    let found;
    for (let i = 0; i < 400 && !found; i++) {
      await sleep(20);
      const id = fs.readdirSync(RUNS).find((n) => n.startsWith('r-'));
      const s = id && readJson(statePath(path.join(RUNS, id)));
      if (s && taskOf(s, '甲')?.turnEnded) found = { dir: path.join(RUNS, id), state: s };
    }
    assert.ok(found, '甲的 Codex 没结束');
    process.kill(found.state.pid, 'SIGTERM');
    const { code } = await done;
    assert.equal(code, 143);
    assert.equal(exists(repo, 'after-stop.txt'), false, '停止后不再启动验收命令');
    assert.equal(taskOf(readJson(statePath(found.dir)), '甲').status, 'cancelled');
  } finally {
    killAll();
  }
});

test('连续续跑：写入任务复用的结果仍过期时保留提示，重跑后才清掉', () => {
  const { repo } = gitRepo('repo', { 'w.md': '原\n' });
  const p = plan(repo, [{ label: '写', ...sol, writes: ['w.md'], prompt: 'PATCH:w.md' }]);
  assert.equal(runPlan(p).status, 0);
  const { state } = lastRun();
  fs.writeFileSync(path.join(repo, 'w.md'), '人工\n');
  runPlan(p, ['--resume', state.runId]);
  assert.deepEqual(taskOf(lastRun().state, '写').stale, ['w.md']);
  const second = runPlan(p, ['--resume', state.runId]);
  assert.deepEqual(taskOf(lastRun().state, '写').stale, ['w.md']);
  assert.match(second.stdout, /⚠ 复用的结果之后这些文件改过：w\.md/);
  runPlan(p, ['--resume', state.runId, '--rerun', '写']);
  assert.equal(taskOf(lastRun().state, '写').stale, undefined);
});

const archived = () => (fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-archived')) ? read(process.env.CODEX_HOME, 'fake-archived').split('\n').filter(Boolean).length : 0);

test('Codex 对话默认在任务结束时归档（不进 Codex 桌面端的列表）；CODEX_FLOW_ARCHIVE_THREADS=0 时不归档', () => {
  const { repo } = gitRepo('repo');
  const p = plan(repo, [{ label: '甲', ...sol, prompt: '甲' }, iso('乙', 'PATCH:a.md'), { label: '丙', ...sol, prompt: 'FAIL' }]);
  runPlan(p);
  assert.equal(archived(), 3, '完成、隔离、失败的都归档');
  assert.ok(lastRun().state.tasks.every((t) => t.threadArchived));
  fs.rmSync(path.join(process.env.CODEX_HOME, 'fake-archived'));
  runPlan(p, [], fakePath({ CODEX_FLOW_ARCHIVE_THREADS: '0' }));
  assert.equal(archived(), 0);
});

test('整个停止时：被停掉的任务的对话在 app-server 关掉后补归档', async () => {
  const { repo } = gitRepo('repo');
  const { done } = start([{ label: '甲', ...sol, prompt: 'SLOW' }], repo, { FAKE_SLOW_MS: '20000' });
  const { dir, state } = await waitState((s) => s.tasks[0]?.threadId);
  process.kill(state.pid, 'SIGTERM');
  assert.equal((await done).code, 143);
  assert.equal(archived(), 1);
  assert.equal(readJson(statePath(dir)).tasks[0].threadArchived, true);
});

// 放在最后：标记停止会影响同一进程里之后的测试
test('整个停止后结算验收：通过、失败都保留已停止，不改成完成或验收失败', () => {
  markStopping();
  for (const failure of [null, '验收未通过：x（exit 1）']) {
    const task = { label: '甲', status: 'cancelled', error: '收到 SIGTERM，已停止' };
    settleChecks(task, failure);
    assert.equal(task.status, 'cancelled');
    assert.equal(task.error, '收到 SIGTERM，已停止');
    assert.equal(task.checkFailed, false);
  }
});
