// 原样运行可分发的计划；假 Codex 不实现功能，所以为 checks 准备已满足契约的输入。
import { skill, root, gitRepo, fakePath, command, lastRun } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const examples = path.join(skill, 'examples');

function filesUnder(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), rel) : [rel];
  });
}

const plans = filesUnder(examples).filter((file) => file.endsWith('.json')).sort();
assert.ok(plans.length > 0, 'examples 中必须有可运行计划');

// 与真实演示共用目录布局和原有测试，只有实现换成通过测试的夹具。
// 这验证计划、promptFile、schema、cwd、checks 和 worktree 路径，不评价模型的修复能力。
const passingNames = `export function normalizeNames(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new TypeError('names');
  const seen = new Set();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
`;
const passingRanges = `export function intersectRanges(a, b) {
  for (const value of [a, b]) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || value[0] > value[1]) throw new TypeError('range');
  }
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return start < end ? [start, end] : null;
}
`;

for (const relative of plans) {
  test(`示例 ${relative} 用假 Codex 实际运行且全部任务完成`, () => {
    const planFile = path.join(examples, relative);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const tasks = plan.phases.flatMap((phase) => phase.tasks);
    assert.equal(plan.cwd, undefined, '运行目录应取调用时的当前目录');
    assert.ok(plan.why?.trim(), '计划必须说明拆分理由');
    for (const task of tasks) {
      assert.equal(task.cwd, undefined);
      assert.ok(task.pick, `${task.label} 缺少模型选择来源`);
      assert.ok(Array.isArray(task.writes), `${task.label} 缺少写入范围`);
      assert.equal(task.schema, 'report');
      if (task.writes.length) assert.ok(task.checks?.length, `${task.label} 缺少代码验收命令`);
    }

    const starter = path.join(examples, 'starter');
    const files = Object.fromEntries(filesUnder(starter).map((file) => [file, fs.readFileSync(path.join(starter, file), 'utf8')]));
    if (tasks.some((task) => task.checks?.length)) {
      files['packages/names/index.mjs'] = passingNames;
      files['packages/ranges/index.mjs'] = passingRanges;
    }
    const { repo, git } = gitRepo('example-project', files);
    const before = git('status', '--porcelain');
    const env = fakePath();
    assert.ok(env.CODEX_HOME.startsWith(root + path.sep));
    assert.ok(env.CODEX_FLOW_HOME.startsWith(root + path.sep));

    // 不复制或改写计划，直接解析仓库里的 promptFile 与 file 引用。
    const result = command(['run', planFile], { cwd: repo, env, timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { state, dir } = lastRun();
    assert.equal(state.cwd, repo);
    assert.equal(state.tasks.length, tasks.length);
    assert.deepEqual(state.tasks.map((task) => task.label), tasks.map((task) => task.label));
    for (const task of state.tasks) {
      assert.equal(task.status, 'completed', `${task.label}: ${task.error ?? ''}`);
      assert.ok(fs.statSync(path.join(dir, task.result)).size > 0);
      assert.deepEqual(task.checkResults?.map(({ cmd, code }) => ({ cmd, code })) ?? [],
        (task.checks ?? []).map((cmd) => ({ cmd, code: 0 })));
      assert.deepEqual(task.scope?.outside ?? [], []);
      if (plan.isolation === 'worktree') {
        assert.equal(task.isolation, 'worktree');
        assert.equal(task.branch.repo, repo);
        assert.equal(task.branch.base, git('rev-parse', 'HEAD').trim());
      }
    }
    assert.equal(git('status', '--porcelain'), before, '只读和无模拟改动的任务不应改变主工作区');
    assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1, '临时 worktree 已回收');
  });
}
