// 并行写入的排队与碰撞检测，任务说明计量、{{path:}} 引用和 stats 命令。
import { root, sol, runPlan, lastRun, taskOf, gitRepo, command, writeJson, statePath, RUNS } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const at = (state, label, key) => Date.parse(taskOf(state, label)[key]);

test('写入范围重叠的任务依次运行并提示；不重叠的同时运行；有前后依赖的不提示', () => {
  const { repo } = gitRepo();
  const result = runPlan({ name: '排队', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '甲', ...sol, writes: ['a/**'], prompt: 'SLOW PATCH:a/x.md' },
    { label: '乙', ...sol, writes: ['a/y.md'], prompt: 'SLOW PATCH:a/y.md' },
    { label: '丙', ...sol, writes: ['c'], prompt: 'SLOW PATCH:c/z.md' },
    { label: '丁', ...sol, writes: ['a'], after: ['乙'], prompt: '丁' },
  ] }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { state } = lastRun();
  assert.ok(at(state, '乙', 'startedAt') >= at(state, '甲', 'endedAt'), '乙 等 甲 结束');
  assert.ok(at(state, '丙', 'startedAt') < at(state, '甲', 'endedAt'), '丙 和 甲 同时运行');
  assert.match(result.stderr, /「甲」「乙」写入范围重叠（a\/y\.md），将依次运行；要同时运行就给它们加 isolation/);
  assert.doesNotMatch(result.stderr, /「乙」「丁」/);
  assert.ok(state.tasks.every((t) => t.status === 'completed' && t.waiting === undefined));
});

test('没写 writes 的任务照常并行，和有写入范围的任务在同一目录时提示', () => {
  const { repo } = gitRepo();
  const result = runPlan({ name: '提示', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '写', ...sol, writes: ['a'], prompt: 'SLOW' },
    { label: '散', ...sol, prompt: '散' },
    { label: '读', ...sol, writes: [], prompt: '读' },
  ] }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { state } = lastRun();
  assert.ok(at(state, '散', 'startedAt') < at(state, '写', 'endedAt'));
  assert.match(result.stderr, /「散」没写 writes，可能和「写」改到同一处；写明 writes（只读写 \[\]），或加 isolation/);
  assert.doesNotMatch(result.stderr, /「读」/);
});

test('同时运行的任务改了同一个文件：两边记下碰撞，先结束的在主工作区重新验收', () => {
  const { repo } = gitRepo();
  const result = runPlan({ name: '碰撞', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '快', ...sol, writes: ['e'], checks: ['test ! -f late.flag'], prompt: 'PATCH:shared.md' },
    { label: '慢', ...sol, writes: ['l'], prompt: 'SLOW PATCH:shared.md PATCH:late.flag' },
  ] }] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { state } = lastRun();
  assert.deepEqual(taskOf(state, '快').collisions, [{ with: '慢', files: ['shared.md'], rechecked: true }]);
  assert.deepEqual(taskOf(state, '慢').collisions, [{ with: '快', files: ['shared.md'] }]);
  assert.equal(taskOf(state, '快').status, 'failed');
  assert.match(taskOf(state, '快').error, /^和「慢」改了同一批文件后重新验收失败：验收未通过：test ! -f late\.flag/);
  assert.match(result.stdout, /⚠ 和「慢」同时改了：shared\.md（已重新验收）/);
});

test('任务说明按五部分计量，{{path:}} 给结果文件路径并算作依赖，回报记字数；stats 文本与 JSON', () => {
  const { repo } = gitRepo();
  fs.writeFileSync(path.join(root, 'ref.md'), '参考资料 abcd\n\n');
  const result = runPlan({ name: '计量', cwd: repo, phases: [{ title: '一', tasks: [
    { label: '源', ...sol, schema: 'review', prompt: '指令 JSON {{file:ref.md}}' },
    { label: '用', ...sol, writes: ['x'], checks: ['true'], prompt: '看 {{task:源}} 再读 {{path:源}}' },
  ] }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { state, dir } = lastRun();
  const src = taskOf(state, '源');
  const use = taskOf(state, '用');
  assert.ok(Date.parse(use.startedAt) >= Date.parse(src.endedAt), '{{path:}} 让 用 等 源');
  assert.deepEqual(src.input.files, { chars: 9, estTokens: 5 }, '「参考资料 abcd」去掉结尾空白：4 个中文 + 5 个其他字符');
  assert.equal(src.input.upstream.chars, 0);
  assert.ok(src.input.schema.chars > 0 && src.input.contract.chars === 0);
  const resultText = fs.readFileSync(path.join(dir, src.result), 'utf8').trim();
  assert.equal(use.input.upstream.chars, [...resultText].length);
  assert.ok(use.input.contract.chars > 0);
  const parts = ['instruction', 'files', 'upstream', 'contract', 'schema'];
  assert.equal(use.input.total.chars, parts.reduce((n, k) => n + use.input[k].chars, 0));
  const prompt = fs.readFileSync(path.join(dir, 'logs/用.prompt.txt'), 'utf8');
  assert.ok(prompt.includes(`再读 ${path.join(dir, src.result)}`));
  assert.equal([...prompt].length, use.input.total.chars - use.input.schema.chars, '计量总数等于实际发出的字数（schema 另发）');
  assert.equal(src.report.chars, [...resultText].length);
  assert.ok(src.report.fields >= 1);

  const text = command(['stats', state.runId]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^\[codex-flow\] 统计 · 计量 · r-/);
  assert.match(text.stdout, /✓ 用 .*说明 .*上游 \d+%.*约束 \d+%.*用量 987（上下文 900 输出 87）.*回报 .*验收 1\/1/);
  assert.match(text.stdout, /合计 2 个任务 · 说明 /);
  const json = JSON.parse(command(['stats', state.runId, '--json']).stdout);
  assert.equal(json.tasks.length, 2);
  assert.equal(json.total.tokens, 987 * 2);
  assert.equal(json.total.input.chars, src.input.total.chars + use.input.total.chars);
  assert.deepEqual(json.tasks[1].checks, { passed: 1, total: 1 });
});

test('注入的上游结果超过 8000 字时汇总提示改用 {{path:}}；旧记录没有计量也能 status 和 stats', () => {
  const dir = path.join(RUNS, 'r-old');
  fs.mkdirSync(dir, { recursive: true });
  const base = { phase: '一', model: 'gpt-6.1-sol', effort: 'high', status: 'completed', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' };
  writeJson(statePath(dir), { kind: 'flow', runId: 'r-old', name: '旧', pid: 2147483647, cwd: root, status: 'completed', startedAt: base.startedAt, endedAt: base.endedAt,
    phases: [{ title: '一', status: 'completed' }],
    tasks: [{ label: '旧任务', ...base }, { label: '大', ...base, input: { upstream: { chars: 9000, estTokens: 9000 }, total: { chars: 9100, estTokens: 9050 } } }] });
  const status = command(['status', 'r-old']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /注入上游结果 9000 字，可改用 \{\{path:任务名\}\} 让 Codex 自己读/);
  assert.equal(status.stdout.match(/注入上游结果/g).length, 1);
  const stats = command(['stats', 'r-old']);
  assert.equal(stats.status, 0, stats.stderr);
  assert.match(stats.stdout, /旧任务 .*说明 -/);
});
