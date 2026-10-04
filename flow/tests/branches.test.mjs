// 隔离成果分支的安全边界与升级兼容（审查时复现过的问题）：符号引用、改过的成果、续跑换下来的旧成果和对话、
// 停止时补归档的进程、V0.3 记录的只重跑验收、汇总命令的引号、存不下成果的原因、单个任务收尾时的清理
import { root, RUNS, sol, sleep, runPlan, lastRun, taskOf, gitRepo, fakePath, background, command, readJson, writeJson, statePath } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(...parts));
const plan = (cwd, tasks) => ({ name: '分支', cwd, phases: [{ title: '一', tasks }] });
const iso = (label, prompt, more = {}) => ({ label, ...sol, isolation: 'worktree', prompt, ...more });
const gitOut = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const branches = (repo) => gitOut(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/codex-flow').stdout.split('\n').filter(Boolean).sort();
const lines = (file) => (fs.existsSync(file) ? read(file).split('\n').filter(Boolean) : []);
const archivedFile = () => path.join(process.env.CODEX_HOME, 'fake-archived');
const pidsFile = () => path.join(process.env.CODEX_HOME, 'fake-app-pids');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitState(pred) {
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    const id = fs.readdirSync(RUNS).filter((n) => n.startsWith('r-')).sort().at(-1);
    const state = id && readJson(statePath(path.join(RUNS, id)));
    if (state && pred(state)) return { dir: path.join(RUNS, id), state };
  }
  throw new Error('等不到预期的运行状态');
}

test('符号引用：clean 不会沿它删掉指向的分支；重做时同名分支是符号引用（含悬空的）就拒绝，不写到别处', () => {
  const { repo, git } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md')])).status, 0);
  const { state } = lastRun();
  const name = taskOf(state, '甲').branch.name;
  const tip = git('rev-parse', name).trim();
  git('branch', 'keep', tip);
  git('update-ref', '-d', `refs/heads/${name}`);
  git('symbolic-ref', `refs/heads/${name}`, 'refs/heads/keep');
  const r = command(['clean', state.runId]);
  assert.match(r.stdout, /删除 0 个分支、0 个 worktree；这些分支之后有新提交，没删：/);
  assert.equal(git('rev-parse', 'keep').trim(), tip, '符号引用指向的分支还在');

  git('symbolic-ref', `refs/heads/${name}`, 'refs/heads/nowhere');
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:b.md')]), ['--resume', state.runId]).status, 1);
  assert.match(taskOf(lastRun().state, '甲').error, /是指向别处的符号引用/);
  assert.equal(gitOut(repo, 'rev-parse', '--verify', '-q', 'refs/heads/nowhere').status, 1, '没有新建它指向的分支');
});

test('重做同一任务：成果提交被 amend 过（说明相同、内容不同）就不删，任务启动失败', () => {
  const { repo, git } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md')])).status, 0);
  const { state } = lastRun();
  const name = taskOf(state, '甲').branch.name;
  git('checkout', '-q', name);
  fs.writeFileSync(path.join(repo, 'human.md'), '人工\n');
  git('add', 'human.md');
  git('commit', '-q', '--amend', '--no-edit');
  git('checkout', '-q', '-');
  const amended = git('rev-parse', name).trim();
  assert.equal(runPlan(plan(repo, [iso('甲', '只看看')]), ['--resume', state.runId]).status, 1);
  assert.match(taskOf(lastRun().state, '甲').error, /已存在，且不是上次留下、之后没改过的成果/);
  assert.equal(git('rev-parse', name).trim(), amended);
});

test('续跑时改了 prompt 并取消隔离：旧成果分支记进 leftovers，clean 照样删；上次没归档成的对话补归档', () => {
  const { repo } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md')]), [], fakePath({ FAKE_ARCHIVE: 'fail' })).status, 0);
  const { state } = lastRun();
  assert.equal(taskOf(state, '甲').threadArchived, undefined);
  const name = taskOf(state, '甲').branch.name;
  const r = runPlan(plan(repo, [{ label: '甲', ...sol, prompt: 'PATCH:b.md' }]), ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = lastRun().state;
  assert.equal(taskOf(after, '甲').branch, undefined);
  assert.deepEqual(after.leftovers.branches.map((b) => b.name), [name]);
  assert.deepEqual(after.leftovers.threads, [], '旧对话已补归档');
  assert.equal(lines(archivedFile()).length, 2, '新任务的一条和补归档的一条');
  assert.match(command(['clean', state.runId]).stdout, /删除 1 个分支/);
  assert.deepEqual(branches(repo), []);
});

test('停止时补归档的 app-server 不回应也不理 SIGTERM：到时强制结束，退出后没有残留进程', async () => {
  const { repo } = gitRepo();
  const file = path.join(root, 'plan.json');
  writeJson(file, plan(repo, [{ label: '甲', ...sol, prompt: 'SLOW' }]));
  const { done } = background(['run', file], fakePath({ FAKE_SLOW_MS: '20000', FAKE_ARCHIVE: 'hang', FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1', FAKE_RECORD_PIDS: '1' }));
  try {
    const { state } = await waitState((s) => s.tasks[0]?.threadId);
    process.kill(state.pid, 'SIGTERM');
    assert.equal((await done).code, 143);
    const pids = lines(pidsFile()).map(Number);
    assert.equal(pids.length, 2, '任务的和补归档的各一个');
    assert.deepEqual(pids.filter(alive), []);
  } finally {
    for (const pid of lines(pidsFile()).map(Number)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('V0.3 的记录只重跑验收：已合回的在主工作区验收；没合回的成果从私有引用换成分支，在 worktree 里验收', () => {
  const { repo, git } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md'), iso('乙', 'PATCH:b.md', { checks: ['false'] })])).status, 1);
  const { dir, state } = lastRun();
  const [a, b] = [taskOf(state, '甲'), taskOf(state, '乙')];
  // 甲：V0.3 合回成功的样子——改动已在主工作区，记录里是 merge.state=applied，没有分支
  fs.writeFileSync(path.join(repo, 'a.md'), '合回的\n');
  git('update-ref', '-d', `refs/heads/${a.branch.name}`);
  Object.assign(a, { merge: { repo, files: ['a.md'], state: 'applied' }, checks: ['true'] });
  delete a.branch;
  // 乙：V0.3 验收没过、成果在私有引用里
  const prefix = `refs/codex-flow/${state.runId}/乙`;
  git('update-ref', `${prefix}/base`, b.branch.base);
  git('update-ref', `${prefix}/result`, b.branch.tip);
  git('update-ref', '-d', `refs/heads/${b.branch.name}`);
  b.merge = { repo, base: { ref: `${prefix}/base`, id: b.branch.base }, result: { ref: `${prefix}/result`, id: b.branch.tip } };
  const tip = b.branch.tip;
  delete b.branch;
  writeJson(statePath(dir), state);

  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { checks: ['test -f a.md'] }), iso('乙', 'PATCH:b.md', { checks: ['test -f b.md'] })]), ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = lastRun().state;
  assert.deepEqual(after.tasks.map((t) => [t.label, t.status, t.reused]), [['甲', 'completed', true], ['乙', 'completed', true]]);
  assert.equal(taskOf(after, '乙').branch.tip, tip);
  assert.deepEqual(taskOf(after, '乙').branch.files, ['b.md']);
  assert.equal(git('rev-parse', taskOf(after, '乙').branch.name).trim(), tip);
  assert.equal(exists(repo, 'b.md'), false);
});

test('仓库路径带空格和引号：汇总里的查看、合进命令照原样运行都能成功', () => {
  const { repo } = gitRepo("it's a repo");
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const command = (label) => r.stdout.split('\n').find((l) => l.includes(`${label}：`)).replace(new RegExp(`^\\s*${label}：`), '');
  const view = spawnSync('sh', ['-c', command('查看')], { encoding: 'utf8' });
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.stdout, /a\.md/);
  assert.equal(spawnSync('sh', ['-c', command('合进主工作区')]).status, 0);
  assert.ok(exists(repo, 'a.md'));
});

test('存不下成果（同名路径被别的分支占着）：任务失败，汇总写出原因', () => {
  const { repo, git } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', '只看看')])).status, 0);
  const { state } = lastRun();
  git('branch', `codex-flow/${state.runId}/甲/占位`);
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md')]), ['--resume', state.runId]);
  assert.equal(r.status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'archive');
  assert.match(r.stdout, /\n    ✗ 存不下隔离任务的成果：/);
  assert.equal(r.stdout.match(/存不下隔离任务的成果/g).length, 1, '原因只写一次');
});

test('单个任务（run.sh）收尾时也清理过期 flow 记录里的隔离成果分支', () => {
  const { repo } = gitRepo();
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md')])).status, 0);
  const { dir, state } = lastRun();
  writeJson(statePath(dir), { ...state, endedAt: new Date(Date.now() - 31 * 86400000).toISOString() });
  const empty = path.join(root, 'single');
  fs.mkdirSync(empty);
  command(['_single-end', '--dir', empty, '--code', '0']);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(branches(repo), []);
});

test('还没有提交的仓库不能隔离，启动前拒绝', () => {
  const repo = path.join(root, 'fresh');
  fs.mkdirSync(repo);
  spawnSync('git', ['-C', repo, 'init', '-q']);
  const r = runPlan(plan(repo, [iso('甲', 'x')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /还没有提交，隔离要从一个提交建 worktree/);
});
