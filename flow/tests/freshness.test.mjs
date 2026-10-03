// 续跑时的结果新鲜度：工作区快照、只读任务自动重跑、写入任务只提示、--rerun、计划引用的文件改过。
import { root, sol, runPlan, lastRun, taskOf, gitRepo, fakePath, command, writeJson } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const reusedOf = (state) => Object.fromEntries(state.tasks.map((t) => [t.label, !!t.reused]));
const resume = (plan, runId, extra = []) => runPlan(plan, ['--resume', runId, ...extra]);

test('续跑：只读任务关心的文件改过就重跑，写入任务只提示；提交、改了又改回都不算改动', () => {
  const { repo, git } = gitRepo('repo', { 'a.md': '一\n', 'w.md': '原样\n' });
  const plan = { name: '新鲜度', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '审', ...sol, writes: [], prompt: '审查' },
    { label: '写', ...sol, writes: ['w.md'], prompt: 'PATCH:w.md' },
    { label: '散', ...sol, prompt: '没写范围' },
  ] }] };
  assert.equal(runPlan(plan).status, 0);
  const { state, dir } = lastRun();
  assert.ok(state.workspace && Object.values(state.workspace).every(Boolean), '结束时记下快照');

  // 改了 a.md：只读任务重跑并写明原因，写入任务和没写范围的任务复用
  fs.writeFileSync(path.join(repo, 'a.md'), '二\n');
  const first = resume(plan, state.runId);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  let after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 审: false, 写: true, 散: true });
  assert.deepEqual(taskOf(after, '审').staleRerun, ['a.md']);
  assert.match(first.stdout, /上次结果之后这些文件改过，已重跑：a\.md/);

  // 只提交、内容不变：全部复用
  git('add', '-A');
  git('commit', '-q', '-m', 'c');
  assert.equal(resume(plan, state.runId).status, 0);
  after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 审: true, 写: true, 散: true });
  assert.equal(taskOf(after, '审').staleRerun, undefined);

  // 改了又改回：不算改动
  fs.writeFileSync(path.join(repo, 'a.md'), '三\n');
  fs.writeFileSync(path.join(repo, 'a.md'), '二\n');
  assert.equal(resume(plan, state.runId).status, 0);
  assert.deepEqual(reusedOf(lastRun().state), { 审: true, 写: true, 散: true });

  // 手工改了写入任务的文件：写入任务复用但提示，只读任务（关心整个目录）重跑
  fs.writeFileSync(path.join(repo, 'w.md'), '人工修改\n');
  const third = resume(plan, state.runId);
  after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 审: false, 写: true, 散: true });
  assert.deepEqual(taskOf(after, '写').stale, ['w.md']);
  assert.match(third.stdout, /⚠ 复用的结果之后这些文件改过：w\.md；要重跑加 --rerun 写/);

  // --rerun 强制重跑，可重复
  const forced = resume(plan, state.runId, ['--rerun', '写', '--rerun', '散']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 审: true, 写: false, 散: false });
  assert.equal(taskOf(after, '写').stale, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8').length > 0, true);
});

test('续跑：reads 决定写入任务关心哪些文件；依赖重跑任务的下游随之重跑', () => {
  const { repo } = gitRepo('repo', { 'src/x.js': '1\n', 'doc.md': '文档\n' });
  const plan = { name: 'reads', cwd: repo, phases: [
    { title: '一', tasks: [{ label: '查', ...sol, writes: [], reads: ['src/**'], prompt: '查源码' }, { label: '记', ...sol, writes: ['out.md'], reads: ['doc.md'], prompt: '记' }] },
    { title: '二', tasks: [{ label: '汇总', ...sol, writes: [], reads: ['out.md'], prompt: '{{task:查}}' }] },
  ] };
  assert.equal(runPlan(plan).status, 0);
  const { state } = lastRun();
  fs.writeFileSync(path.join(repo, 'doc.md'), '新文档\n');
  assert.equal(resume(plan, state.runId).status, 0);
  let after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 查: true, 记: true, 汇总: true }, 'doc.md 不在只读任务的 reads 里');
  assert.deepEqual(taskOf(after, '记').stale, ['doc.md']);
  fs.writeFileSync(path.join(repo, 'src/x.js'), '2\n');
  assert.equal(resume(plan, state.runId).status, 0);
  after = lastRun().state;
  assert.deepEqual(reusedOf(after), { 查: false, 记: true, 汇总: false }, '查 重跑，引用它的 汇总 跟着重跑');
});

test('续跑：不在 git 里的目录无法判断，汇总说明一次；--rerun 用法错误时拒绝', () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const plan = { name: '非 git', cwd: plain, phases: [{ title: '一', tasks: [{ label: '审', ...sol, writes: [], prompt: '审' }] }] };
  assert.equal(runPlan(plan).status, 0);
  const { state } = lastRun();
  const resumed = resume(plan, state.runId);
  assert.equal(resumed.status, 0);
  assert.equal(resumed.stdout.match(/无法判断复用的结果是否过期/g)?.length, 1);
  assert.ok(lastRun().state.tasks[0].reused);

  const noResume = runPlan(plan, ['--rerun', '审']);
  assert.equal(noResume.status, 2);
  assert.match(noResume.stderr, /--rerun 只能和 --resume 一起用/);
  const unknown = resume(plan, state.runId, ['--rerun', '没有这个']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /--rerun 指向不存在的任务: 没有这个/);
});

test('只带 runId 续跑时，计划引用的文件改过会提示仍用旧内容', () => {
  const { repo } = gitRepo();
  fs.writeFileSync(path.join(root, 'ref.md'), '资料一\n');
  const planFile = path.join(root, 'plan.json');
  writeJson(planFile, { name: '来源', cwd: repo, phases: [{ title: '一', tasks: [{ label: '读', ...sol, prompt: '看 {{file:ref.md}}' }] }] });
  const env = fakePath();
  assert.equal(command(['run', planFile], { env, timeout: 15000 }).status, 0);
  const { state, dir } = lastRun();
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(stored.phases[0].tasks[0].sources[0].kind, 'file');
  fs.writeFileSync(path.join(root, 'ref.md'), '资料二\n');
  const resumed = command(['run', '--resume', state.runId], { env, timeout: 15000 });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /⚠ 计划引用的文件改过，这次仍用上次存下的内容；要用新内容就带计划文件续跑：.*ref\.md/);
  assert.match(resumed.stderr, /计划引用的文件改过/);
});
