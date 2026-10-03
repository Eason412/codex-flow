// 隔离与续跑的边界（审查时复现过的问题）：任务名归一化后重名、writes 写 "." 越到父目录、强制暂存的被忽略文件、
// 受管链接的上级被换成链接、git apply 只应用了一部分、续跑按新 writes 重查、停止与单独取消时不合回、
// 合回按实际要写的文件取租约、连续续跑保留过期提示
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
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'outside');
  assert.deepEqual(t.scope.outside, ['../outside.md']);
  assert.equal(read(repo, 'outside.md'), '外\n');
  assert.equal(read(pkg, 'x.md'), '原\n', '整份不合回');
  runPlan(plan(repo, [{ label: '乙', ...sol, cwd: pkg, writes: ['.'], prompt: 'PATCH:../outside.md' }]));
  assert.deepEqual(taskOf(lastRun().state, '乙').scope?.outside, ['../outside.md']);
});

test('主工作区强制暂存的被忽略文件：隔离任务没碰时不会被删，改了时按改后的内容合回；主仓库 index 不变', () => {
  const { repo, git } = gitRepo('repo', { '.gitignore': '*.secret\n', 'x.md': '原\n' });
  fs.writeFileSync(path.join(repo, 'config.secret'), '密\n');
  git('add', '-f', 'config.secret');
  let r = runPlan(plan(repo, [iso('甲', 'PATCH:x.md')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(repo, 'config.secret'), '密\n');
  assert.deepEqual(taskOf(lastRun().state, '甲').merge.files, ['x.md']);
  r = runPlan(plan(repo, [iso('乙', 'SHELL:config.secret')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(read(repo, 'config.secret'), /^写入 /);
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

test('git apply 只应用了一部分（主工作区子目录不可写）：记为合回中断，保留 worktree 和引用', { skip: process.getuid?.() === 0 }, () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n', 'z/f.md': '原\n' });
  const z = path.join(repo, 'z');
  try {
    const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md PATCH:z/f.md', { checks: [`chmod a-w ${z}`] })]));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const t = taskOf(lastRun().state, '甲');
    assert.equal(t.failureKind, 'interrupted');
    assert.equal(t.merge.state, 'applying');
    assert.ok(t.merge.before && t.merge.merged, '保留 M、R 引用供核对');
    assert.ok(t.worktree && exists(t.worktree.path), 'worktree 保留');
    assert.match(r.stdout, /合回中断/);
    assert.doesNotMatch(r.stdout, /整份成果没合回/);
  } finally {
    fs.chmodSync(z, 0o755);
  }
});

test('续跑只重跑验收时按新的 writes 重查隔离成果：新范围不含的改动整份不合回', () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks: ['false'] })])).status, 1);
  const { state } = lastRun();
  const again = runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: [], checks: ['true'] })]), ['--resume', state.runId]);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'outside');
  assert.deepEqual(t.scope.outside, ['a.md']);
  assert.equal(read(repo, 'a.md'), '原\n');
});

test('等合回租约时被单独取消：不合回，记为已停止，成果留在引用里', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const { done } = start([
    { label: '甲', ...sol, writes: ['a.md'], prompt: '甲', checks: ['sleep 3'] },
    iso('乙', 'PATCH:a.md', { writes: ['a.md'] }),
  ], repo);
  const { dir, state } = await waitState((s) => taskOf(s, '乙')?.merging);
  assert.equal(command(['cancel', state.runId, '乙']).status, 0);
  const { code, stdout } = await done;
  const after = readJson(statePath(dir));
  const t = taskOf(after, '乙');
  assert.equal(t.status, 'cancelled', stdout);
  assert.equal(code, 1);
  assert.equal(read(repo, 'a.md'), '原\n');
  assert.ok(t.merge.result, '成果留在引用里');
  assert.equal(taskOf(after, '甲').status, 'completed');
});

test('整个停止时：等合回的隔离任务不再合回，验收被杀的任务仍记为已停止，等 app-server 退出后以 143 结束', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const { done } = start([
    { label: '甲', ...sol, writes: ['a.md'], prompt: '甲', checks: ['sleep 5'] },
    iso('乙', 'PATCH:a.md', { writes: ['a.md'] }),
    { label: '丙', ...sol, writes: [], prompt: 'SLOW STUBBORN' },
  ], repo, { FAKE_SLOW_MS: '20000' });
  const { dir, state } = await waitState((s) => taskOf(s, '乙')?.merging && taskOf(s, '甲')?.checking);
  process.kill(state.pid, 'SIGTERM');
  const { code, stdout } = await done;
  assert.equal(code, 143, stdout);
  const after = readJson(statePath(dir));
  assert.deepEqual(after.tasks.map((t) => [t.label, t.status]), [['甲', 'cancelled'], ['乙', 'cancelled'], ['丙', 'cancelled']]);
  assert.equal(read(repo, 'a.md'), '原\n', '乙没合回');
  assert.ok(taskOf(after, '乙').merge.result);
  assert.deepEqual(stubborn().filter(alive), [], 'app-server 都已退出');
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

test('合回按三方合并后实际要写的文件取租约：主工作区把文件改了名、新名字被运行中任务占着时等它结束', async () => {
  const { repo } = gitRepo('repo', { 'a.md': paragraphs });
  const { done } = start([
    { label: '甲', ...sol, writes: ['b.md'], prompt: '甲', checks: ['sleep 4; ! grep -q 乙改 b.md'] },
    iso('乙', 'SLOW EDIT:a.md:第2段:乙改', { writes: ['a.md'] }),
  ], repo, { FAKE_SLOW_MS: '1500' });
  await waitState((s) => taskOf(s, '乙')?.worktree && taskOf(s, '甲')?.checking);
  fs.renameSync(path.join(repo, 'a.md'), path.join(repo, 'b.md'));
  const { code, stdout } = await done;
  assert.equal(code, 0, stdout);
  const after = lastRun().state;
  assert.equal(taskOf(after, '甲').status, 'completed', '甲验收期间 b.md 没被合回改动');
  assert.deepEqual(taskOf(after, '乙').merge.files, ['b.md'], '记的是实际写入的文件');
  assert.match(read(repo, 'b.md'), /^乙改$/m);
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
