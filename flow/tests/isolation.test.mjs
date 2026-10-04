// 隔离任务（isolation: "worktree"），做法同 Claude Workflow：worktree 建立与同步、环境目录链接与 .worktreeinclude、
// 成果存成分支不合回、越界和链接异常只提示、验收与只重跑验收、重做时的旧分支、被停止、下游提示、clean 与过期清理。
import { root, RUNS, sol, sleep, runPlan, lastRun, taskOf, gitRepo, fakePath, background, command, readJson, writeJson, statePath } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { cleanRunArchives } = await import('../lib/isolation.mjs');
const { pruneOldRuns } = await import('../lib/state.mjs');

const WT = path.join(path.dirname(RUNS), 'worktrees');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(...parts));
const plan = (cwd, tasks, extra = {}) => ({ name: '隔离', cwd, ...extra, phases: [{ title: '一', tasks }] });
const iso = (label, prompt, more = {}) => ({ label, ...sol, isolation: 'worktree', prompt, ...more });
const gitOut = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout;
const branches = (repo) => gitOut(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/codex-flow').split('\n').filter(Boolean).sort();
const worktrees = (repo) => gitOut(repo, 'worktree', 'list', '--porcelain');
const paragraphs = Array.from({ length: 20 }, (_, i) => `第${i + 1}段\n`).join('');

test('有改动：成果存成分支、不合回主工作区；未提交和未跟踪内容同步进 worktree；汇总给出查看和合进主工作区的命令，照着运行能合进来', () => {
  const { repo, git } = gitRepo('repo', { 'a/x.md': '原\n', 'README.md': '初始\n', 's.md': 's\n' });
  fs.writeFileSync(path.join(repo, 'README.md'), '未提交\n');
  fs.writeFileSync(path.join(repo, 'u.md'), '未跟踪\n');
  fs.writeFileSync(path.join(repo, 's.md'), '暂存\n');
  git('add', 's.md');
  const staged = git('ls-files', '-s');
  const head = git('rev-parse', 'HEAD').trim();
  const diffFile = path.join(root, 'diff.txt');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a/x.md', { writes: ['a'], checks: ['grep -q 未提交 README.md', 'test -f u.md', `git diff --name-only > ${diffFile}`] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { dir, state } = lastRun();
  const t = taskOf(state, '甲');
  const name = `codex-flow/${state.runId}/甲`;
  assert.equal(t.status, 'completed');
  assert.deepEqual(Object.keys(t.branch).sort(), ['base', 'files', 'name', 'repo', 'tip']);
  assert.equal(t.branch.name, name);
  assert.deepEqual(t.branch.files, ['a/x.md']);
  assert.deepEqual(branches(repo), [name]);
  assert.equal(read(repo, 'a/x.md'), '原\n', '不合回主工作区');
  assert.equal(git('ls-files', '-s'), staged, '主仓库 index 不变');
  assert.deepEqual(read(diffFile).trim().split('\n').sort(), ['README.md', 'a/x.md', 's.md'], 'worktree 的 index 是 HEAD');
  // 主工作区有未提交内容：基准是一个单独的提交，父提交是 HEAD；成果提交的父提交是基准
  assert.equal(git('rev-parse', `${name}~1`).trim(), t.branch.base);
  assert.equal(git('rev-parse', `${name}~2`).trim(), head);
  assert.match(git('log', '-1', '--format=%s', t.branch.base), /开始时的主工作区（含未提交）/);
  assert.equal(git('diff', '--name-only', t.branch.base, name), 'a/x.md\n');
  assert.equal(t.worktree, undefined);
  assert.equal(exists(WT, state.runId), false, 'worktree 目录删掉');
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
  const base = t.branch.base.slice(0, 12);
  const ref = `'refs/heads/${name}'`;
  const apply = `git -C ${repo} diff --binary ${base} ${ref} -- | git -C ${repo} apply`;
  assert.ok(r.stdout.includes(`    成果在分支 ${name}（1 个文件），没有合进主工作区\n    查看：git -C ${repo} diff ${base} ${ref} --\n    合进主工作区：${apply}\n`), r.stdout);
  assert.match(read(dir, 'logs', '甲.prompt.txt'), /结束后执行器把改动存成一个分支，不合回主工作区/);
  assert.equal(spawnSync('sh', ['-c', apply]).status, 0);
  assert.match(read(repo, 'a/x.md'), /^写入/);
});

test('主工作区干净时成果提交直接接在 HEAD 上；cwd 是仓库子目录时 Codex 和验收都在 worktree 里对应的子目录', () => {
  const { repo, git } = gitRepo('repo', { 'pkg/a.md': 'a\n' });
  const pwdFile = path.join(root, 'pwd.txt');
  const r = runPlan(plan(repo, [iso('甲', 'CWD PATCH:b.md', { cwd: 'pkg', writes: ['b.md'], checks: [`pwd > ${pwdFile}`] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { dir, state } = lastRun();
  const t = taskOf(state, '甲');
  const inner = path.join(WT, state.runId, '甲', 'pkg');
  assert.equal(read(dir, t.result).trim(), `cwd=${inner}`);
  assert.equal(read(pwdFile).trim(), inner, '验收在 worktree 里跑');
  assert.equal(t.branch.base, git('rev-parse', 'HEAD').trim());
  assert.deepEqual(t.branch.files, ['b.md'], '按任务 cwd 显示');
  assert.equal(git('diff', '--name-only', 'HEAD', t.branch.name), 'pkg/b.md\n');
  assert.equal(exists(repo, 'pkg/b.md'), false);
});

test('没有改动：不建分支，汇总写没有改动', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan(plan(repo, [iso('甲', '只看看')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.branch.tip, undefined);
  assert.deepEqual(branches(repo), []);
  assert.match(r.stdout, /\n    没有改动\n/);
});

test('有范围外改动：和不隔离的任务一样只提示越界，状态按验收定，成果分支含全部改动', () => {
  const { repo, git } = gitRepo('repo');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a/new.md PATCH:z/out.md', { writes: ['a'], checks: ['true'] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.status, 'completed');
  assert.deepEqual(t.scope, { outside: ['z/out.md'], unclaimed: [] });
  assert.equal(git('diff', '--name-only', t.branch.base, t.branch.name), 'a/new.md\nz/out.md\n');
  assert.match(r.stdout, /⚠ 越界写入：z\/out\.md/);
});

test('keepWorktree：保留 worktree 目录并解锁，汇总写出位置', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], keepWorktree: true })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.keepWorktree, true);
  assert.ok(exists(t.worktree.path, 'a.md'));
  const entry = worktrees(repo).split('\n\n').find((e) => e.includes(t.worktree.path));
  assert.ok(entry && !entry.includes('locked'), '保留的 worktree 已解锁');
  assert.ok(r.stdout.includes(`    worktree 保留在 ${t.worktree.path}\n`));
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
  assert.deepEqual(t.branch.files, ['src/a.js'], '链接不进快照');
  assert.equal(t.scope, null);
  assert.equal(read(repo, 'node_modules/dep/index.js'), 'dep\n', '删 worktree 只 unlink 链接');
  assert.ok(exists(repo, 'node_modules/dep/gen.js'), '写进链接的内容落在主工作区');
  assert.ok(exists(repo, '.env') && exists(repo, 'build.log'));
  assert.deepEqual(t.envToMain, [`${site}/__editable__.lib-0.pth`, 'node_modules/my-lib']);
  assert.match(r.stdout, /⚠ 环境里的本地包指向主工作区，验收可能测的不是隔离里的代码：/);
});

test('受管链接被任务换成真实目录：汇总提示，主工作区的依赖不受影响', () => {
  const { repo } = gitRepo('repo', { '.gitignore': 'node_modules/\n' });
  fs.mkdirSync(path.join(repo, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/dep/i.js'), 'dep\n');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:src/a.js REPLACE:node_modules', { writes: ['src'] })]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = taskOf(lastRun().state, '甲');
  assert.deepEqual(t.branch.anomalies, ['node_modules']);
  assert.deepEqual(t.branch.files, ['src/a.js']);
  assert.equal(read(repo, 'node_modules/dep/i.js'), 'dep\n', '换掉的只是 worktree 里的链接');
  assert.match(r.stdout, /⚠ 环境目录链接被任务换掉：node_modules/);
});

test('两个隔离任务改同一文件的同一处：各自的分支各有自己的改动，主工作区不变，由 Claude 合并', () => {
  const { repo, git } = gitRepo('repo', { 'f.txt': paragraphs });
  const r = runPlan(plan(repo, [
    iso('甲', 'EDIT:f.txt:第2段:甲改', { writes: ['f.txt'] }),
    iso('乙', 'SLOW EDIT:f.txt:第2段:乙改', { writes: ['f.txt'] }),
  ]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { state } = lastRun();
  assert.deepEqual(state.tasks.map((t) => t.status), ['completed', 'completed']);
  assert.match(git('show', `${taskOf(state, '甲').branch.name}:f.txt`), /^甲改$/m);
  assert.match(git('show', `${taskOf(state, '乙').branch.name}:f.txt`), /^乙改$/m);
  assert.equal(read(repo, 'f.txt'), paragraphs);
});

test('验收没过：任务失败，成果仍在分支上；改好验收续跑时按成果重建 worktree 验收，按这次的 writes 重查范围', () => {
  const { repo } = gitRepo('repo');
  const pwdFile = path.join(root, 'pwd.txt');
  const make = (checks, writes = ['a.md']) => plan(repo, [iso('甲', 'PATCH:a.md', { writes, checks })]);
  let r = runPlan(make(['false']));
  assert.equal(r.status, 1);
  let { state } = lastRun();
  let t = taskOf(state, '甲');
  assert.equal(t.checkFailed, true);
  assert.ok(t.branch.tip);
  assert.ok(r.stdout.includes(`    ✗ 验收未通过：false（exit 1）\n    成果在分支 ${t.branch.name}`), r.stdout);

  r = runPlan(make([`pwd > ${pwdFile}`, 'test -f a.md'], ['b.md']), ['--resume', state.runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  ({ state } = lastRun());
  t = taskOf(state, '甲');
  assert.equal(t.status, 'completed');
  assert.equal(t.reused, true);
  assert.equal(read(pwdFile).trim(), path.join(WT, state.runId, '甲'), '在重建的 worktree 里验收');
  assert.deepEqual(t.scope, { outside: ['a.md'], unclaimed: [] }, '按这次的 writes 重查');
  assert.equal(exists(repo, 'a.md'), false);
  assert.equal(exists(WT, state.runId), false);
});

test('重做同一任务：上次的分支还停在成果上就换成新的；之后有人在上面提交过就不动它、任务启动失败', () => {
  const { repo, git } = gitRepo('repo');
  const make = (prompt) => plan(repo, [iso('甲', prompt)]);
  assert.equal(runPlan(make('PATCH:a.md')).status, 0);
  const { state } = lastRun();
  const name = taskOf(state, '甲').branch.name;
  assert.equal(runPlan(make('PATCH:b.md'), ['--resume', state.runId]).status, 0);
  assert.equal(git('diff', '--name-only', `${name}~1`, name), 'b.md\n', '换成了新的成果');

  git('checkout', '-q', name);
  fs.writeFileSync(path.join(repo, 'c.md'), 'c\n');
  git('add', 'c.md');
  git('commit', '-q', '-m', '在成果上继续');
  git('checkout', '-q', '-');
  const moved = git('rev-parse', name).trim();
  const r = runPlan(make('PATCH:d.md'), ['--resume', state.runId]);
  assert.equal(r.status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.match(t.error, /分支 .* 已存在，且不是上次留下、之后没改过的成果，先合并或删掉它再重跑/);
  assert.equal(git('rev-parse', name).trim(), moved, '分支不动');
});

test('被停止：运行期间 worktree 锁住；停止后已写的部分存成分支、worktree 删掉', async () => {
  const { repo, git } = gitRepo('repo');
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
  assert.equal(t.status, 'cancelled');
  assert.ok(stdout.includes(`成果在分支 ${t.branch.name}（1 个文件）`), stdout);
  assert.equal(git('diff', '--name-only', t.branch.base, t.branch.name), 'partial.md\n');
  assert.equal(exists(wt), false);
  assert.equal(exists(repo, 'partial.md'), false);
});

test('排在隔离任务之后的任务：开始时提示它们看不到隔离任务的改动，照常运行', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan({ name: '下游', cwd: repo, phases: [
    { title: '一', tasks: [iso('甲', 'PATCH:a.md')] },
    { title: '二', tasks: [{ label: '乙', ...sol, writes: [], prompt: '{{task:甲}}' }] },
  ] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /隔离任务「甲」的改动存成分支、不进主工作区，之后的「乙」看不到/);
  assert.equal(taskOf(lastRun().state, '乙').status, 'completed');
});

test('计划顶层 isolation 作默认值，单个任务写 false 不隔离；非 git、有子模块、写法不对时拒绝启动', () => {
  const { repo } = gitRepo('repo');
  let r = runPlan(plan(repo, [{ label: '甲', ...sol, prompt: 'PATCH:a.md' }, { label: '乙', ...sol, isolation: false, prompt: 'PATCH:b.md' }], { isolation: 'worktree' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { state } = lastRun();
  assert.equal(taskOf(state, '甲').isolation, 'worktree');
  assert.equal(taskOf(state, '乙').isolation, undefined);
  assert.equal(exists(repo, 'a.md'), false);
  assert.ok(exists(repo, 'b.md'), '不隔离的直接写主工作区');

  const runs = fs.readdirSync(RUNS).length;
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  r = runPlan(plan(plain, [iso('丙', 'PATCH:a.md')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /任务「丙」写了 isolation，但.*plain 不在 git 仓库里：隔离只支持 git/);
  assert.equal(fs.readdirSync(RUNS).length, runs, '拒绝时不建运行目录');

  const { repo: sub } = gitRepo('sub');
  const { repo: main, git } = gitRepo('main');
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
  git('commit', '-q', '-m', 'sub');
  r = runPlan(plan(main, [iso('丁', 'x')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /有已初始化的子模块（mod），隔离暂不支持子模块/);
  for (const [extra, message] of [[{ isolation: 'copy' }, /isolation 只能写 "worktree"/], [{ keepWorktree: 'yes' }, /keepWorktree 要写成 true 或 false/]]) {
    r = runPlan(plan(repo, [iso('戊', 'x', extra)]));
    assert.equal(r.status, 2);
    assert.match(r.stderr, message);
  }
});

test('clean：删掉仍停在成果上的分支和带标记的 worktree，之后有新提交的分支留下；clean 后只重跑验收会因成果不在而失败', () => {
  const { repo, git } = gitRepo('repo');
  const make = (checks) => plan(repo, [
    iso('甲', 'PATCH:a.md', { writes: ['a.md'], checks, keepWorktree: true }),
    iso('乙', 'PATCH:b.md', { writes: ['b.md'] }),
  ]);
  assert.equal(runPlan(make(['false'])).status, 1);
  const { dir, state } = lastRun();
  const moved = taskOf(state, '乙').branch.name;
  git('branch', '-f', moved, `${moved}~1`);
  fs.mkdirSync(path.join(WT, state.runId, '别人的'), { recursive: true });
  const r = command(['clean', state.runId]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `[codex-flow] 已清理 ${state.runId}：删除 1 个分支、1 个 worktree；这些分支之后有新提交，没删：${moved}\n`);
  assert.deepEqual(branches(repo), [moved]);
  assert.equal(exists(WT, state.runId, '甲'), false);
  assert.ok(exists(WT, state.runId, '别人的'), '没有标记的目录不删');
  const cleaned = taskOf(readJson(statePath(dir)), '甲');
  assert.equal(cleaned.worktree, undefined);
  assert.equal(cleaned.branch.tip, undefined);

  assert.equal(runPlan(make(['true']), ['--resume', state.runId]).status, 1);
  const t = taskOf(lastRun().state, '甲');
  assert.equal(t.failureKind, 'archive');
  assert.match(t.error, /上次的成果已不在.*--rerun 甲/);
});

test('过期清理：含成果分支的运行记录保留 30 天，到期先删分支和带标记的 worktree 再删目录；没给清理函数时不删', () => {
  const { repo } = gitRepo('repo');
  const r = runPlan(plan(repo, [iso('甲', 'PATCH:a.md', { writes: ['a.md'], keepWorktree: true })]));
  assert.match(r.stdout, /运行目录: .*（保留 30 天，\d{4}-\d{2}-\d{2} 之后下一次运行 codex-flow 时删除）/);
  const { dir, state } = lastRun();
  const wt = taskOf(state, '甲').worktree.path;
  const age = (days) => writeJson(statePath(dir), { ...state, endedAt: new Date(Date.now() - days * 86400000).toISOString() });
  age(10);
  pruneOldRuns();
  assert.ok(fs.existsSync(dir), '10 天：还在保留期');
  age(31);
  pruneOldRuns();
  assert.ok(fs.existsSync(dir) && branches(repo).length === 1, '没给清理函数的调用方（如 run.sh）跳过这类记录');
  pruneOldRuns(7, cleanRunArchives);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(branches(repo), []);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(worktrees(repo).match(/^worktree /gm).length, 1);
});
