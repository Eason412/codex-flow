// 计划解析、引用展开和写入范围的审查复现；环境与假 codex 都由 helpers 放在临时目录。
import { root, skill, sol, runPlan, lastRun, taskOf, gitRepo, fakePath, command, writeJson } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { phaseNotes, validatePlan, renderPrompt, loadSchema } = await import('../lib/plan.mjs');
const { leaseOf, overlapOf } = await import('../lib/leases.mjs');
const { inScope, realPath } = await import('../lib/scope.mjs');

const task = (label, more = {}) => ({ label, ...sol, prompt: '任务说明', ...more });
const plan = (phases, cwd = root) => ({ name: '计划解析', cwd, phases });

test('1 阶段名只提示独立模型词，中文紧挨模型名也提示', () => {
  for (const title of ['修复 console 报错', '实现 isolation 开关', '定位 resolver 超时', '补 solution 文档']) {
    assert.deepEqual(phaseNotes({ phases: [{ title }] }), [], title);
  }
  for (const title of ['sol 润色', 'astra审查', 'gpt-6.1 实现', 'Sol', '用luna核对']) {
    assert.match(phaseNotes({ phases: [{ title }] })[0], /写了模型名/, title);
  }
  assert.match(phaseNotes({ phases: [{ title: '实现' }] })[0], /只有动作/);
});

test('2 引用一次扫描：上游结果中的三类引用原样保留，计量只记实际注入', () => {
  fs.mkdirSync(path.join(root, 'results'));
  const text = '示例 {{phase:源阶段}} {{task:其他}} {{path:源}} {{task:不存在}} {{path:不存在}}';
  fs.writeFileSync(path.join(root, 'results/源.md'), text + '\n');
  fs.writeFileSync(path.join(root, 'results/其他.md'), '其他结果');
  const state = { tasks: [
    { label: '源', phase: '源阶段', status: 'completed', result: 'results/源.md' },
    { label: '其他', phase: '其他阶段', status: 'completed', result: 'results/其他.md' },
    { label: '未完', phase: '后续阶段', status: 'pending' },
  ] };
  const injected = [];
  const result = renderPrompt('路径 {{path:源}}\n阶段 {{phase:源阶段}}\n任务 {{task:源}}', state, root, injected);
  assert.equal(result, `路径 ${path.join(root, 'results/源.md')}\n阶段 ### 源\n${text}\n任务 ${text}`);
  assert.deepEqual(injected, [`### 源\n${text}`, text]);
  assert.equal(renderPrompt('{{task:未完}} {{path:未完}} {{task:缺失}} {{path:缺失}}', state, root),
    '（任务「未完」未完成：pending） （任务「未完」未完成：pending） （没有名为「缺失」的任务） （没有名为「缺失」的任务）');
});

test('2 三类直接引用都计算依赖，file 引入的示例仍原样保留', () => {
  const p = plan([
    { title: '源阶段', tasks: [task('源'), task('其他')] },
    { title: '后续阶段', tasks: [task('下游', { after: [], prompt: '{{phase:源阶段}} {{task:源}} {{path:其他}}' })] },
  ]);
  assert.deepEqual(validatePlan(p).get('下游'), ['源', '其他']);
  assert.equal(renderPrompt('\u0001task:缺失}} \u0001phase:缺失}} \u0001path:缺失}}', { tasks: [] }, root),
    '{{task:缺失}} {{phase:缺失}} {{path:缺失}}');
});

test('3 after 同时命中任务名和阶段名时取并集，明确引用仍只取对应种类', () => {
  for (const separate of [false, true]) {
    const p = plan([
      ...(separate ? [{ title: '准备材料', tasks: [task('导出')] }] : []),
      { title: '导出', tasks: [task(separate ? '源码' : '导出'), task('文档')] },
      { title: '验证导出', tasks: [
        task('验证', { after: ['导出', '导出'] }),
        task('任务引用', { after: [], prompt: '{{task:导出}} {{path:导出}}' }),
        task('阶段引用', { after: [], prompt: '{{phase:导出}}' }),
      ] },
    ]);
    const deps = validatePlan(p);
    assert.deepEqual(deps.get('验证'), separate ? ['导出', '源码', '文档'] : ['导出', '文档']);
    assert.deepEqual(deps.get('任务引用'), ['导出']);
    assert.deepEqual(deps.get('阶段引用'), separate ? ['源码', '文档'] : ['导出', '文档']);
  }
});

test('3 同名 after 等整个阶段的慢任务完成后才开跑', () => {
  const { repo } = gitRepo();
  const r = runPlan(plan([
    { title: '导出', tasks: [task('导出'), task('导出文档', { prompt: 'SLOW' })] },
    { title: '验证导出', tasks: [task('验证', { after: ['导出'] })] },
  ], repo), [], fakePath({ FAKE_SLOW_MS: '800' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { state } = lastRun();
  assert.ok(Date.parse(taskOf(state, '验证').startedAt) >= Date.parse(taskOf(state, '导出文档').endedAt));
});

test('4 内置 schema 不受同名文件或目录影响，显式路径仍读取自定义 schema', () => {
  const custom = { type: 'object', properties: { custom: { type: 'string' } } };
  // loadSchema 失败会退出进程，在子进程里读取，避免终止其他复现测试。
  const readSchema = (name) => {
    const code = `import { loadSchema } from ${JSON.stringify(new URL('../lib/plan.mjs', import.meta.url).href)}; console.log(JSON.stringify(loadSchema(${JSON.stringify(name)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  for (const name of ['report', 'result', 'review', 'opinion']) {
    const file = path.join(root, name);
    const builtin = JSON.parse(fs.readFileSync(path.join(skill, 'schemas', `${name}.json`), 'utf8'));
    fs.mkdirSync(file);
    assert.deepEqual(readSchema(name), builtin, `${name} 目录`);
    fs.rmdirSync(file);
    writeJson(file, custom);
    assert.deepEqual(readSchema(name), builtin, `${name} 文件`);
    assert.deepEqual(readSchema(`./${name}`), custom, `${name} 显式路径`);
  }
  writeJson(path.join(root, 'custom-schema'), custom);
  assert.deepEqual(readSchema('custom-schema'), custom);
  assert.equal(loadSchema(null), null);
});

test('4 从含同名目录的 cwd 启动 flow 仍可使用全部内置 schema', () => {
  const { repo } = gitRepo();
  const names = ['report', 'result', 'review', 'opinion'];
  for (const name of names) fs.mkdirSync(path.join(repo, name));
  const file = path.join(root, 'plan.json');
  writeJson(file, plan([{ title: '生成结果', tasks: names.map((schema) => task(schema, { schema, writes: [] })) }], repo));
  const r = command(['run', file], { cwd: repo, env: fakePath(), timeout: 15000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(lastRun().state.tasks.every((t) => t.status === 'completed'));
});

test('5 cwd 中的 glob 字符按字面处理，租约只识别 writes 自身的通配符', () => {
  for (const name of ['[work]', '{work}', '*work', '?work']) {
    const cwd = path.join(root, name, 'app');
    fs.mkdirSync(cwd, { recursive: true });
    assert.deepEqual(leaseOf(['a'], cwd), [path.join(cwd, 'a')], name);
    assert.deepEqual(leaseOf(['a/*.md'], cwd), [path.join(cwd, 'a')], name);
    assert.deepEqual(leaseOf(['*.md'], cwd), [cwd], name);
    assert.deepEqual(overlapOf(leaseOf(['a'], cwd), leaseOf(['b'], cwd)), [], name);
    assert.deepEqual(overlapOf(leaseOf(['a/*.md'], cwd), leaseOf(['a/sub/x.md'], cwd)), [path.join(cwd, 'a/sub/x.md')]);
    assert.deepEqual(leaseOf([path.join(cwd, 'a')], root), [root], '用户写的绝对路径本身仍识别 glob');
  }
});

test('5 cwd 含 glob 字符时范围内文件不越界，真正越界和单层 glob 仍能识别', () => {
  for (const name of ['[work]', '{work}', '*work', '?work']) {
    const cwd = path.join(root, name, 'app');
    fs.mkdirSync(cwd, { recursive: true });
    for (const [file, patterns, expected] of [
      ['a/x.md', ['a'], true], ['a/x.md', ['a/*.md'], true], ['a/.hidden.md', ['a/*.md'], true],
      ['a/sub/x.md', ['a/*'], false], ['a/sub/x.md', ['a/**'], true], ['b/x.md', ['a'], false],
      ['a', ['a/**'], false], ['b/x.md', ['a/**'], false],
      ['../outside.md', ['.'], false], ['a/x.md', ['.'], true],
    ]) assert.equal(inScope(path.resolve(cwd, file), patterns, cwd), expected, `${name} ${file} ${patterns}`);
  }
  const target = path.join(root, 'real-app');
  const alias = path.join(root, '[alias]');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias);
  assert.ok(inScope(path.join(target, 'a/x.md'), ['a/*.md'], alias), '带 glob 字符的 cwd 链接仍按真实目录核对');
  assert.deepEqual(leaseOf(['a/*.md'], alias), [path.join(target, 'a')]);
});

test('5 带方括号的 cwd 下不同写入范围并行，无重叠提示或误报越界', () => {
  const { repo } = gitRepo('[work]/app');
  const r = runPlan(plan([{ title: '生成文件', tasks: [
    task('甲', { writes: ['a/*.md'], prompt: 'SLOW PATCH:a/x.md' }),
    task('乙', { writes: ['b'], prompt: 'SLOW PATCH:b/x.md' }),
  ] }], repo), [], fakePath({ FAKE_SLOW_MS: '800' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /写入范围重叠/);
  const { state } = lastRun();
  const [a, b] = state.tasks;
  assert.ok(Date.parse(a.startedAt) < Date.parse(b.endedAt) && Date.parse(b.startedAt) < Date.parse(a.endedAt));
  for (const t of state.tasks) {
    assert.equal(t.status, 'completed');
    assert.deepEqual(t.scope?.outside ?? [], []);
  }
  assert.ok(inScope(path.join(realPath(repo), 'a/x.md'), ['a/*.md'], repo));
});
