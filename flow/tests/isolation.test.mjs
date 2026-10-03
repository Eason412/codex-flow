// 隔离任务（isolation: "worktree"）：worktree 建立与同步、环境目录链接与 .worktreeinclude、整份合回与三方合并、合回后再验收、
// 冲突与越界不合回、成果引用的保留与清理、按租约排队合回、被停止和合回中断。
import { root, RUNS, sol, sleep, runPlan, lastRun, taskOf, gitRepo, fakePath, background, command, readJson, writeJson, statePath } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { openWorktree, judgeResult, mergeBack, cleanRunArchives } = await import('../lib/isolation.mjs');
const { leases, leaseOf } = await import('../lib/leases.mjs');
const { pruneOldRuns } = await import('../lib/state.mjs');

const WT = path.join(path.dirname(RUNS), 'worktrees');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(...parts));
const plan = (cwd, tasks, extra = {}) => ({ name: '隔离', cwd, ...extra, phases: [{ title: '一', tasks }] });
const iso = (label, prompt, more = {}) => ({ label, ...sol, isolation: 'worktree', prompt, ...more });
const gitOut = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout;
const refsOf = (repo) => gitOut(repo, 'for-each-ref', '--format=%(refname)', 'refs/codex-flow').split('\n').filter(Boolean).sort();
const worktrees = (repo) => gitOut(repo, 'worktree', 'list', '--porcelain');
// 二十段的文件，段落之间隔得够远，各改一段不冲突
const paragraphs = Array.from({ length: 20 }, (_, i) => `第${i + 1}段\n`).join('');

test('范围内改动合回；未提交和未跟踪内容同步进 worktree，worktree 里 git diff 与主工作区一致；主仓库 index 不变；成功后删目录和全部引用', () => {
  const { repo, git } = gitRepo('repo', { 'a/x.md': '原\n', 'README.md': '初始\n', 's.md': 's\n' });
  fs.writeFileSync(path.join(repo, 'README.md'), '未提交\n');
  fs.writeFileSync(path.join(repo, 'u.md'), '未跟踪\n');
  fs.writeFileSync(path.join(repo, 's.md'), '暂存\n');
  git('add', 's.md');
  const staged = git('ls-files', '-s');
  const diffFile = path.join(root, 'diff.txt');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a/x.md', { writes: ['a'], checks: ['grep -q 未提交 README.md', 'test -f u.md', `git diff --name-only > ${diffFile}`] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { dir, state } = lastRun();
  const t = taskOf(state, '甲');
  assert.equal(t.status, 'completed');
  assert.equal(t.cwd, undefined, 'state 里的 cwd 仍按原计划（与计划 cwd 相同时不写）');
  assert.deepEqual(t.merge, { repo, files: ['a/x.md'], state: 'applied' });
  assert.match(read(repo, 'a/x.md'), /^写入/);
  assert.deepEqual(read(diffFile).trim().split('\n').sort(), ['README.md', 'a/x.md', 's.md'], 'worktree 的 index 是 HEAD');
  assert.equal(t.worktree, undefined);
  assert.equal(exists(WT, state.runId), false, '成功后删 worktree 目录');
  assert.deepEqual(refsOf(repo), [], '成功后删全部私有引用');
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
  assert.equal(git('ls-files', '-s'), staged, '主仓库 index 不变');
  assert.match(r.stdout, /合回 1 个文件/);
  assert.match(read(dir, 'logs', '甲.prompt.txt'), /独立 git worktree/);
});

test('cwd 是仓库子目录：Codex 和验收都在 worktree 里对应的子目录运行，改动合回原子目录', () => {
  const { repo } = gitRepo('repo', { 'pkg/a.md': 'a\n' });
  const pwdFile = path.join(root, 'pwd.txt');
  const r = runPlan(plan(repo, [iso('甲', 'CWD PATCH:b.md', { cwd: 'pkg', writes: ['b.md'], checks: [`pwd > ${pwdFile}`] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { dir, state } = lastRun();
  const t = taskOf(state, '甲');
  const inner = path.join(WT, state.runId, '甲', 'pkg');
  assert.equal(t.cwd, path.join(repo, 'pkg'));
  assert.equal(read(dir, t.result).trim(), `cwd=${inner}`);
  assert.equal(read(pwdFile).trim(), inner, '验收在 worktree 里跑');
  assert.ok(exists(repo, 'pkg/b.md'));
  assert.deepEqual(t.merge.files, ['b.md']);
  assert.equal(t.merge.rechecked, undefined, '主工作区没变过，不再验收');
});

test('有范围外改动：整份成果不合回、不验收，任务失败并列出越界文件；worktree 目录删掉，引用保留，可用 git diff 查看', () => {
  const { repo } = gitRepo('repo');
  const marker = path.join(root, 'checked');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a/new.md PATCH:z/out.md', { writes: ['a'], checks: [`touch ${marker}`] })]));
  assert.equal(r.status, 1);
  const { state } = lastRun();
  const t = taskOf(state, '甲');
  assert.equal(t.status, 'failed');
  assert.equal(t.failureKind, 'outside');
  assert.equal(t.error, '改动超出写入范围：z/out.md；整份成果没合回');
  assert.deepEqual(t.scope, { outside: ['z/out.md'], unclaimed: [] });
  assert.equal(exists(repo, 'a/new.md'), false, '范围内的也不合回');
  assert.equal(exists(marker), false, '越界时不再验收');
  assert.equal(t.worktree, undefined);
  assert.equal(exists(WT, state.runId), false);
  const base = `refs/codex-flow/${state.runId}/甲/base`;
  const result = `refs/codex-flow/${state.runId}/甲/result`;
  assert.deepEqual(refsOf(repo), [base, result]);
  assert.equal(t.merge.result.ref, result);
  assert.equal(gitOut(repo, 'diff', '--name-only', base, result), 'a/new.md\nz/out.md\n');
  assert.ok(r.stdout.includes(`⚠ 成果没合回（改动超出写入范围）；查看：git -C ${repo} diff ${base} ${result}；取回成目录：git -C ${repo} worktree add --detach <目录> ${result}`), r.stdout);
});

test('keepWorktree：失败时保留 worktree 目录并解锁', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks: ['false'], keepWorktree: true })]));
  assert.equal(r.status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'checks');
  assert.equal(t.keepWorktree, true);
  assert.ok(exists(t.worktree.path, 'a.md'));
  const entry = worktrees(repo).split('\n\n').find((e) => e.includes(t.worktree.path));
  assert.ok(entry && !entry.includes('locked'), '保留的 worktree 已解锁');
  assert.match(r.stdout, /⚠ 成果没合回（验收没过）；worktree 保留在 .*甲；查看：/);
});

test('环境目录：只给 node_modules、.venv、venv 建链接，其余被忽略的不放进 worktree；.worktreeinclude 列出且被忽略的文件复制进来；本地包指向主工作区时告警', () => {
  const { repo } = gitRepo('repo', {
    '.gitignore': 'node_modules/\n.venv\n*.log\ndist/\n.env\n', '.worktreeinclude': '.env\n',
    'src/a.js': 'a\n', 'packages/lib/index.js': 'lib\n', 'pkg/x.js': 'x\n',
  });
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  put('node_modules/dep/index.js', 'dep\n');
  put('node_modules/.pnpm/foo/node_modules/foo/index.js', 'foo\n');
  fs.symlinkSync('.pnpm/foo/node_modules/foo', path.join(repo, 'node_modules/foo'));
  fs.symlinkSync('../packages/lib', path.join(repo, 'node_modules/my-lib'));
  put('pkg/node_modules/z/i.js', 'z\n');
  const site = '.venv/lib/python3.12/site-packages';
  put(`${site}/__editable__.lib-0.pth`, `${repo}/packages/lib\n`);
  put(`${site}/self.pth`, `${repo}/.venv/extra\n`);
  put('build.log', 'log\n');
  put('dist/out.js', 'out\n');
  put('.env', 'SECRET=1\n');
  const checks = ['test -L node_modules', 'test -f node_modules/dep/index.js', 'test -L pkg/node_modules', 'test -L .venv',
    'test ! -e build.log', 'test ! -e dist', 'test -f .env', 'test ! -L .env'];
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:src/a.js SHELL:node_modules/dep/gen.js', { writes: ['src'], checks })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.deepEqual(t.merge.files, ['src/a.js'], '链接不进快照');
  assert.equal(t.scope, null);
  assert.equal(read(repo, 'node_modules/dep/index.js'), 'dep\n', '删 worktree 只 unlink 链接');
  assert.ok(exists(repo, 'node_modules/dep/gen.js'), '写进链接的内容落在主工作区');
  assert.ok(exists(repo, '.env') && exists(repo, 'build.log'));
  assert.deepEqual(t.envToMain, [`${site}/__editable__.lib-0.pth`, 'node_modules/my-lib']);
  assert.match(r.stdout, /⚠ 环境里的本地包指向主工作区，验收可能测的不是隔离里的代码：/);
});

test('受管链接被任务换成真实目录：整份不合回，任务失败', () => {
  const { repo } = gitRepo('repo', { '.gitignore': 'node_modules/\n' });
  fs.mkdirSync(path.join(repo, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/dep/i.js'), 'dep\n');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:src/a.js REPLACE:node_modules', { writes: ['src'] })]));
  assert.equal(r.status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'anomaly');
  assert.deepEqual(t.merge.anomalies, ['node_modules']);
  assert.equal(exists(repo, 'src/a.js'), false);
  assert.equal(read(repo, 'node_modules/dep/i.js'), 'dep\n', '换掉的只是 worktree 里的链接');
  assert.match(r.stdout, /⚠ 成果没合回（环境目录链接被任务换掉：node_modules）/);
});

test('两个隔离任务各改同一文件的不同段落：都合回；后合回的合并结果不同于验收过的内容，在主工作区再验收', () => {
  const { repo } = gitRepo('repo', { 'f.txt': paragraphs });
  const log = path.join(root, 'checks.log');
  const r = runPlan(plan(repo, [
    iso('甲', 'EDIT:f.txt:第2段:甲改', { writes: ['f.txt'], checks: [`pwd >> ${log}`] }),
    iso('乙', 'SLOW EDIT:f.txt:第18段:乙改', { writes: ['f.txt'], checks: [`pwd >> ${log}`] }),
  ]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { state } = lastRun();
  const text = read(repo, 'f.txt');
  assert.match(text, /^甲改$/m);
  assert.match(text, /^乙改$/m);
  assert.equal(taskOf(state, '甲').merge.rechecked, undefined, '先合回的：主工作区没变过');
  assert.equal(taskOf(state, '乙').merge.rechecked, true);
  assert.deepEqual(read(log).trim().split('\n').sort(),
    [repo, path.join(WT, state.runId, '甲'), path.join(WT, state.runId, '乙')].sort(), '乙在 worktree 和主工作区各验收一次');
  assert.match(r.stdout, /合回 1 个文件，已在主工作区重新验收\n/);
});

test('合回后在主工作区再验收失败：任务记失败并写明，改动已合回', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan(plan(repo, [
    iso('甲', 'PATCH:a.md', { writes: ['a.md'] }),
    iso('乙', 'SLOW PATCH:b.md', { writes: ['b.md'], checks: ['test ! -e a.md'] }),
  ]));
  assert.equal(r.status, 1);
  const t = taskOf(lastRun().state, '乙');
  assert.equal(t.status, 'failed');
  assert.equal(t.failureKind, 'checks');
  assert.equal(t.checkFailed, true);
  assert.match(t.error, /^合回后在主工作区验收未通过：test ! -e a\.md/);
  assert.equal(t.merge.state, 'applied');
  assert.ok(exists(repo, 'b.md'));
  assert.deepEqual(refsOf(repo), []);
  assert.match(r.stdout, /合回 1 个文件，已在主工作区重新验收（未通过）/);
});

test('同一处冲突：后合回的整份不合回、任务失败，写明冲突文件和同期改过的任务，引用保留；续跑从最新的主工作区重做', () => {
  const { repo, git } = gitRepo('repo', { 'f.txt': paragraphs });
  const tasks = [
    iso('甲', 'EDIT:f.txt:第2段:甲改', { writes: ['f.txt'] }),
    iso('乙', 'SLOW EDIT:f.txt:第2段:乙改 PATCH:g.txt', { writes: ['f.txt', 'g.txt'] }),
  ];
  const r = runPlan(plan(repo, tasks));
  assert.equal(r.status, 1);
  const { state } = lastRun();
  const t = taskOf(state, '乙');
  const prefix = `refs/codex-flow/${state.runId}/乙`;
  assert.equal(t.status, 'failed');
  assert.equal(t.failureKind, 'conflict');
  assert.deepEqual(t.merge.conflict, ['f.txt']);
  assert.ok(t.error.startsWith(`合回冲突：f.txt（同期改过：甲）；整份成果没合回。查看：git -C ${repo} diff ${prefix}/base ${prefix}/result；`), t.error);
  assert.ok(t.error.endsWith(`；在最新状态上重做：run --resume ${state.runId} --rerun 乙`), t.error);
  assert.match(read(repo, 'f.txt'), /^甲改$/m);
  assert.equal(exists(repo, 'g.txt'), false, '整份不合回');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.deepEqual(refsOf(repo), [`${prefix}/base`, `${prefix}/before`, `${prefix}/result`]);
  assert.match(git('show', `${prefix}/result:f.txt`), /^乙改$/m);
  assert.equal(exists(WT, state.runId, '乙'), false, '没写 keepWorktree：目录删掉，成果在引用里');
  assert.ok(r.stdout.includes(`    ⚠ ${t.error}\n`));

  // 续跑：甲复用，乙从最新的主工作区重建 worktree 重做；第 2 段已是甲改，乙这次只写出 g.txt
  const again = runPlan(plan(repo, tasks), ['--resume', state.runId]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const redo = taskOf(lastRun().state, '乙');
  assert.equal(redo.status, 'completed');
  assert.deepEqual(redo.merge, { repo, files: ['g.txt'], state: 'applied' });
  assert.match(read(repo, 'f.txt'), /^甲改$/m);
  assert.deepEqual(refsOf(repo), []);
});

test('验收没过：worktree 目录删掉、成果留在引用里；改好验收续跑时按引用重建 worktree 验收，通过再合回', () => {
  const { repo } = gitRepo('repo');
  const pwdFile = path.join(root, 'pwd.txt');
  const make = (checks) => plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks })]);
  let r = runPlan(make(['false']));
  assert.equal(r.status, 1);
  let { state } = lastRun();
  let t = taskOf(state, '甲');
  assert.equal(t.checkFailed, true);
  assert.equal(t.worktree, undefined);
  assert.equal(exists(repo, 'a.md'), false);
  assert.equal(refsOf(repo).length, 2);

  r = runPlan(make([`pwd > ${pwdFile}`, 'test -f a.md']), ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  ({ state } = lastRun());
  t = taskOf(state, '甲');
  assert.equal(t.status, 'completed');
  assert.equal(t.reused, true);
  assert.equal(read(pwdFile).trim(), path.join(WT, state.runId, '甲'), '在重建的 worktree 里验收');
  assert.ok(exists(repo, 'a.md'));
  assert.equal(t.merge.state, 'applied');
  assert.deepEqual(refsOf(repo), []);
  assert.equal(exists(WT, state.runId), false);
});

test('clean：删掉这次运行的私有引用和带标记的 worktree；之后只重跑验收会因引用不在而失败', () => {
  const { repo } = gitRepo('repo');
  const make = (checks) => plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks, keepWorktree: true })]);
  assert.equal(runPlan(make(['false'])).status, 1);
  const { dir, state } = lastRun();
  fs.mkdirSync(path.join(WT, state.runId, '别人的'), { recursive: true });
  const r = command(['clean', state.runId]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `[codex-flow] 已清理 ${state.runId}：删除 2 个私有引用、1 个 worktree\n`);
  assert.deepEqual(refsOf(repo), []);
  assert.equal(exists(WT, state.runId, '甲'), false);
  assert.ok(exists(WT, state.runId, '别人的'), '没有标记的目录不删');
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
  const cleaned = taskOf(readJson(statePath(dir)), '甲');
  assert.equal(cleaned.worktree, undefined);
  assert.equal(cleaned.merge.result, undefined);

  assert.equal(runPlan(make(['true']), ['--resume', state.runId]).status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'archive');
  assert.match(t.error, /成果引用已不在.*--rerun 甲/);
  assert.equal(exists(repo, 'a.md'), false, '不退回主工作区验收');
});

test('续跑遇到上次合回中断（applying）的任务：不复用、不重跑，记失败等人工核对并给出 M、R 查看命令', () => {
  const { repo } = gitRepo('repo');
  const make = () => plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks: ['false'] })]);
  assert.equal(runPlan(make()).status, 1);
  const { dir, state } = lastRun();
  const t = taskOf(state, '甲');
  Object.assign(t.merge, { state: 'applying', before: { ref: 'refs/x/before', id: '1' }, merged: { ref: 'refs/x/merged', id: '2' } });
  writeJson(statePath(dir), state);
  const r = runPlan(make(), ['--resume', state.runId]);
  assert.equal(r.status, 1);
  const after = taskOf(lastRun().state, '甲');
  assert.equal(after.status, 'failed');
  assert.equal(after.failureKind, 'interrupted');
  assert.equal(after.startedAt, t.startedAt, '没有重跑');
  assert.equal(after.error, `上次合回中断，需人工核对主工作区；查看：git -C ${repo} diff refs/x/before refs/x/merged`);
  assert.match(r.stdout, /⚠ 合回中断，主工作区可能只应用了一部分，需人工核对；查看：git -C .* diff refs\/x\/before refs\/x\/merged/);
});

test('被停止：运行期间 worktree 锁住；停止后成果存进引用、worktree 删掉，不合回', async () => {
  const { repo } = gitRepo('repo');
  const file = path.join(root, 'plan.json');
  writeJson(file, plan(repo, [iso('甲', 'SLOW PATCH:a.md', { writes: ['a.md'] })]));
  const { child, done } = background(['run', file], fakePath({ FAKE_SLOW_MS: '5000' }));
  let dir;
  let wt;
  for (let i = 0; i < 100 && !wt; i++) {
    await sleep(100);
    const id = fs.readdirSync(RUNS).find((n) => n.startsWith('r-'));
    const state = id && readJson(statePath(path.join(RUNS, id)));
    if (state?.tasks?.[0]?.worktree) [dir, wt] = [path.join(RUNS, id), state.tasks[0].worktree.path];
  }
  assert.ok(wt, 'worktree 没建起来');
  assert.match(worktrees(repo), /locked "codex-flow r-/, '运行期间锁住');
  fs.writeFileSync(path.join(wt, 'partial.md'), '做了一半\n'); // 模拟 Codex 已写的部分
  child.kill('SIGTERM');
  const { code, stdout } = await done;
  assert.equal(code, 143);
  const t = readJson(statePath(dir)).tasks[0];
  assert.ok(stdout.includes(`⚠ 成果没合回（已停止）；查看：git -C ${repo} diff ${t.merge.base.ref} ${t.merge.result.ref}`), stdout);
  assert.ok(!stdout.includes('worktree 保留在'), '停止时打印的汇总与收尾后的去留一致');
  assert.equal(t.status, 'cancelled');
  assert.equal(t.worktree, undefined);
  assert.equal(exists(wt), false);
  assert.equal(exists(repo, 'partial.md'), false, '不合回');
  assert.equal(gitOut(repo, 'diff', '--name-only', t.merge.base.ref, t.merge.result.ref), 'partial.md\n');
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
});

test('合回等与改动文件重叠的运行中任务结束（写入租约）', async () => {
  const { repo } = gitRepo('repo', { 'a.md': '原\n' });
  const dir = path.join(RUNS, 'r-unit');
  fs.mkdirSync(dir, { recursive: true });
  const task = { label: '甲', writes: ['a.md'], isolation: 'worktree', status: 'running', startedAt: new Date().toISOString() };
  const work = openWorktree(dir, task, repo);
  fs.writeFileSync(path.join(work.wtCwd, 'a.md'), '改\n');
  assert.equal(judgeResult(task, work), true);
  leases.hold('乙', leaseOf(['a.md'], repo)); // 运行中的非隔离任务
  leases.hold('丙', leaseOf(['other'], repo)); // 不重叠的不挡
  let rechecked = false;
  const merging = mergeBack(dir, task, work, async () => { rechecked = true; });
  await sleep(300);
  assert.equal(task.merging, true);
  assert.equal(task.status, 'running');
  assert.equal(read(repo, 'a.md'), '原\n', '乙还在跑，合回在排队');
  leases.release('乙');
  await merging;
  leases.release('丙');
  assert.equal(read(repo, 'a.md'), '改\n');
  assert.equal(task.status, 'completed');
  assert.equal(task.merge.state, 'applied');
  assert.equal(task.merging, undefined);
  assert.equal(rechecked, false);
  assert.deepEqual(leases.blockers(leaseOf(['a.md'], repo)), [], '合回后释放租约');
});

test('计划顶层 isolation 作默认值；没写 writes 的隔离任务全部合回；非 git、有子模块、写法不对时拒绝启动', () => {
  const { repo } = gitRepo('repo');
  let r = runPlan(plan(repo, [{ label: '甲', ...sol, prompt: 'PATCH:a.md PATCH:deep/b.md' }], { isolation: 'worktree' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.isolation, 'worktree');
  assert.deepEqual(t.merge.files, ['a.md', 'deep/b.md']);
  assert.equal(t.scope, undefined, '没写 writes 不核对范围');
  assert.ok(exists(repo, 'a.md') && exists(repo, 'deep/b.md'));

  const runs = fs.readdirSync(RUNS).length;
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  r = runPlan(plan(plain, [iso('乙', 'PATCH:a.md')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /任务「乙」写了 isolation，但.*plain 不在 git 仓库里：隔离只支持 git/);
  assert.equal(fs.readdirSync(RUNS).length, runs, '拒绝时不建运行目录');

  const { repo: sub } = gitRepo('sub');
  const { repo: main, git } = gitRepo('main');
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
  git('commit', '-q', '-m', 'sub');
  r = runPlan(plan(main, [iso('丙', 'x')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /有已初始化的子模块（mod），隔离暂不支持子模块/);
  for (const [extra, message] of [[{ isolation: 'copy' }, /isolation 只能写 "worktree"/], [{ keepWorktree: 'yes' }, /keepWorktree 要写成 true 或 false/]]) {
    r = runPlan(plan(repo, [iso('丁', 'x', extra)]));
    assert.equal(r.status, 2);
    assert.match(r.stderr, message);
  }
});

test('过期清理：含没合回成果的运行记录保留 30 天，到期先删私有引用和带标记的 worktree 再删目录；没给清理函数时不删', () => {
  const { repo } = gitRepo('repo');
  assert.equal(runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks: ['false'], keepWorktree: true })])).status, 1);
  const { dir, state } = lastRun();
  const wt = taskOf(state, '甲').worktree.path;
  const age = (days) => writeJson(statePath(dir), { ...state, endedAt: new Date(Date.now() - days * 86400000).toISOString() });
  age(10);
  pruneOldRuns();
  assert.ok(fs.existsSync(dir), '10 天：还在保留期');
  assert.equal(refsOf(repo).length, 2);
  age(31);
  pruneOldRuns();
  assert.ok(fs.existsSync(dir) && refsOf(repo).length === 2, '没给清理函数的调用方（如 run.sh）跳过这类记录');
  pruneOldRuns(7, cleanRunArchives);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(refsOf(repo), []);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
});
