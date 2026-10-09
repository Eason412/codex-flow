import { root, RUNS, skill, cli, sol, command, fakePath, runPlan, lastRun, sleep, background, writeJson, readJson, statePath } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, pruneOldRuns } from '../lib/state.mjs';
import { appendHistory, historyRecord } from '../lib/history.mjs';
import { conclusionOf, renderSummary } from '../lib/summary.mjs';
import { loadSchema } from '../lib/plan.mjs';

const history = () => fs.readFileSync(path.join(HOME, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const report = { status: 'done', summary: '完成修复\n验证通过\n主代理可接收', files: [{ path: 'a.mjs', note: '修复实现' }], deviations: ['更换实现方式'], open_issues: [] };
const at = new Date(Date.now() - 1000).toISOString();
function fixture(kind = 'flow', status = 'completed', id = 'r-unit') {
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const state = { runId: id, kind, name: '测试', cwd: root, pid: process.pid, status, startedAt: at,
    endedAt: status === 'running' ? null : new Date().toISOString(),
    phases: [{ title: '任务', status }], tasks: [{ label: '任务', phase: '任务', ...sol, status, startedAt: at, log: 'events.jsonl' }] };
  writeJson(statePath(dir), state);
  return { dir, state };
}

test('report schema 的全部属性 required，flow 结果按 report 给出结论', () => {
  const schema = loadSchema('report');
  for (const object of [schema, schema.properties.files.items]) {
    assert.equal(object.additionalProperties, false);
    assert.deepEqual([...object.required].sort(), Object.keys(object.properties).sort());
  }
  assert.equal(schema.properties.summary.maxLength, 400);
  const result = runPlan({ name: '报告', cwd: root, phases: [{ title: '执行', tasks: [{ label: '任务', ...sol, schema: 'report', prompt: '执行' }] }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /done · 1 个文件 · 0 处偏离\n    报告结论/);
  const { dir, state } = lastRun();
  assert.equal(readJson(path.join(dir, state.tasks[0].result)).status, 'done');
  assert.equal(history().at(-1).tasks[0].schema, 'report');
});

test('结论至多三行、单行至多 160 字；unclaimed 不列名且不影响完整 state', () => {
  const { dir, state } = fixture();
  const task = state.tasks[0];
  Object.assign(task, { result: 'result.json', schema: 'report', scope: { outside: ['越界.mjs'], unclaimed: ['来源未定一.mjs', '来源未定二.mjs'] }, collisions: [{ with: '乙', files: ['冲突.mjs'] }] });
  writeJson(path.join(dir, task.result), { ...report, summary: '长'.repeat(200) + '\n第二行\n第三行' });
  assert.equal(conclusionOf(dir, task).length, 3);
  assert.ok(conclusionOf(dir, task).every((s) => s.length <= 160));
  const text = renderSummary(dir, state);
  assert.match(text, /    · 工作区另有 2 处来源未定的变动（多半是 shell 命令或其他进程写的），清单见 state.json/);
  assert.doesNotMatch(text, /来源未定一|来源未定二/);
  assert.match(text, /⚠ 越界写入：越界.mjs/);
  assert.match(text, /⚠ 和「乙」同时改了：冲突.mjs/);
  assert.equal(task.scope.unclaimed.length, 2);
  fs.writeFileSync(path.join(dir, 'fallback.md'), '# 标题\n\n普通回复\n');
  assert.deepEqual(conclusionOf(dir, { result: 'fallback.md', schema: 'report' }), ['普通回复']);
});

for (const kind of ['flow', 'single']) test(`watch 默认等待 ${kind} 结束，忽略环境阈值并打印完整 summary`, async (t) => {
  const { dir, state } = fixture(kind, 'running');
  state.tasks[0].startedAt = '2000-01-01T00:00:00Z';
  writeJson(statePath(dir), state);
  const watcher = background(['watch', state.runId], { ...process.env, CODEX_FLOW_ALERT_AFTER: '0' });
  t.after(async () => { if (watcher.child.exitCode === null) { watcher.child.kill(); await watcher.done; } });
  await sleep(300);
  assert.equal(watcher.child.exitCode, null);
  const summary = '汇总第一行\n汇总第二行\n汇总第三行\n汇总第四行\n';
  fs.writeFileSync(path.join(dir, 'summary.txt'), summary);
  state.status = 'completed';
  writeJson(statePath(dir), state);
  const result = await watcher.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, summary);
});

test('watch 显式阈值提前退出；缺 summary 或进程消失时打印已结束', () => {
  const { dir, state } = fixture('single', 'running');
  const alerted = command(['watch', state.runId, '--alert-after', '0']);
  assert.equal(alerted.status, 0);
  assert.match(alerted.stdout, /请检查日志/);
  state.pid = 2147483647;
  writeJson(statePath(dir), state);
  const ended = command(['watch', state.runId]);
  assert.equal(ended.status, 0);
  assert.match(ended.stdout, /已结束：进程已消失/);
  assert.equal(command(['watch', state.runId, '--alert-after', '-1']).status, 2);
  assert.equal(command(['watch', state.runId, '--alert-after']).status, 2);
});

function singleRun(schema, extra = {}, reply = JSON.stringify(report)) {
  for (const mark of ['advance', 'finish']) fs.writeFileSync(path.join(process.env.CODEX_HOME, mark), '');
  const args = [path.join(skill, 'run.sh'), '-m', sol.model, '-e', sol.effort, '-n', '任务名称', '-C', root];
  if (schema) args.push('-j', schema);
  if (extra.mode) args.push(extra.mode, 'parent-thread');
  args.push('任务说明秘密正文');
  return spawnSync('bash', args, { env: fakePath({ FAKE_REPLY: reply, ...extra.env }), encoding: 'utf8', timeout: 15000 });
}

for (const schema of ['report', 'result', 'review', 'opinion', null, 'custom']) test(`run.sh 输出策略和 history：${schema}`, () => {
  let name = schema;
  if (schema === 'custom') { name = path.join(root, 'custom.json'); writeJson(name, loadSchema('report')); }
  const reply = ['review', 'opinion'].includes(schema) ? '第一段\n\n意见全文标记' : schema === null ? '结论第一行\n第二行\n第三行\n正文隐藏标记' : JSON.stringify(report);
  const result = singleRun(name, {}, reply);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dir = fs.readdirSync(RUNS).map((name) => path.join(RUNS, name)).find((dir) => readJson(statePath(dir))?.kind === 'single');
  const state = readJson(statePath(dir));
  assert.match(result.stdout.split('\n')[0], /运行中，日志目录: /);
  assert.match(result.stdout, /实际使用: model=gpt-6\.1-sol effort=high/);
  assert.match(result.stdout, /thread: fake-new-thread/);
  assert.match(result.stdout, /exit: 0/);
  if (['review', 'opinion'].includes(schema)) {
    assert.match(result.stdout, /Codex 最终回复/);
    assert.match(result.stdout, /意见全文标记/);
  } else {
    assert.match(result.stdout, /Codex 结论/);
    assert.doesNotMatch(result.stdout, /Codex 最终回复|正文隐藏标记|修复实现/);
    assert.ok(result.stdout.includes(`全文: ${path.join(dir, 'last.md')}`));
    if (schema === 'report' || schema === 'custom') assert.match(result.stdout, /done · 1 个文件 · 1 处偏离/);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'last.md'), 'utf8'), reply);
  assert.ok(fs.existsSync(path.join(dir, 'summary.txt')));
  assert.equal(state.tasks[0].schema ?? null, name);
  const record = history().at(-1);
  assert.equal(record.kind, 'single');
  assert.equal(record.tasks[0].tokens, 350);
  assert.deepEqual(record.tasks[0].tokenUsage, { input: 200, cachedInput: 50, output: 150 });
  assert.equal(record.tasks[0].input.instruction, [...'任务说明秘密正文'].length);
  assert.equal(record.tasks[0].report, [...reply.trim()].length);
  assert.doesNotMatch(JSON.stringify(record), /任务说明秘密正文|修复实现|意见全文标记/);
});

for (const mode of ['-r', '-f']) test(`run.sh ${mode} 先取消归档，再 exec，成功后不再归档`, () => {
  const archived = path.join(process.env.CODEX_HOME, 'archived_sessions', '2020', 'rollout-test_parent-thread.jsonl');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.writeFileSync(archived, '');
  const result = singleRun('report', { mode });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fake-unarchived'), 'utf8'), 'parent-thread\n');
  assert.equal(fs.existsSync(archived), false);
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-archived')), false);
  assert.equal(history().at(-1).tasks[0].resumed, mode === '-r');
  assert.equal(history().at(-1).tasks[0].forkedFrom, mode === '-f' ? 'parent-thread' : null);
});

test('review 仍输出 JSON 全文，排版保留数字字面值', () => {
  const result = singleRun('review', {}, '  {"big":9007199254740993,"float":1.0}  ');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Codex 最终回复/);
  assert.match(result.stdout, /"big": 9007199254740993/);
  assert.match(result.stdout, /"float": 1\.0/);
  assert.doesNotMatch(result.stdout, /全文: /);
});

test('取消归档失败保留退出码与原归档，不执行 exec', () => {
  const archived = path.join(process.env.CODEX_HOME, 'archived_sessions', 'rollout-test-parent-thread.jsonl');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.writeFileSync(archived, '');
  const result = singleRun('report', { mode: '-r', env: { FAKE_UNARCHIVE_FAIL: '1' } });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /假取消归档失败/);
  assert.equal(fs.existsSync(archived), true);
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'fake-pid')), false);
});

test('history 只保存计量与元数据、截断 error；同 runId 追加不覆写', () => {
  const { dir, state } = fixture();
  Object.assign(state.tasks[0], { prompt: '任务秘密', result: 'result.md', report: { chars: 12 }, tokens: 123, actualModel: 'actual', actualEffort: 'medium', serviceTier: 'priority', actualServiceTier: 'default', schema: 'report', checks: ['true', 'false', 'true'], checkResults: [{ code: 0 }, { code: 1 }], input: { instruction: { chars: 4 }, files: { chars: 8 } }, reused: true, scope: { outside: ['out'], unclaimed: ['one', 'two'] }, collisions: [{ with: 'x', files: ['秘密文件'] }], error: '错'.repeat(220) });
  fs.writeFileSync(path.join(dir, 'result.md'), '结果秘密');
  assert.equal(appendHistory(dir, state), true);
  const record = history()[0], task = record.tasks[0];
  assert.equal(task.error.length, 200);
  assert.equal(task.tokens, 123);
  assert.deepEqual(task.checks, { passed: 1, total: 3 });
  assert.deepEqual(task.input, { instruction: 4, files: 8 });
  assert.deepEqual(task.scope, { outside: 1, unclaimed: 2 });
  assert.equal(task.collisions, 1);
  assert.equal(task.report, 12);
  assert.equal(task.actualEffort, 'medium');
  assert.equal(task.actualServiceTier, 'default');
  assert.doesNotMatch(JSON.stringify(record), /任务秘密|结果秘密|秘密文件/);
  state.status = 'failed'; state.resumed = true;
  assert.equal(appendHistory(dir, state), true);
  assert.equal(history().length, 2);
  assert.deepEqual(history()[0], record);
  assert.equal(history().at(-1).resumed, true);
  assert.equal(history().at(-1).status, 'failed');
  assert.ok(history().at(-1).recordedAt);
});

test('history --backfill 补现有目录、跳过无 state/已记录；只追加 history', () => {
  const one = fixture(), two = fixture('single', 'completed', 's-unit');
  fs.mkdirSync(path.join(RUNS, 'legacy'));
  const filesBefore = [fs.readFileSync(statePath(one.dir), 'utf8'), fs.readFileSync(statePath(two.dir), 'utf8')];
  assert.equal(appendHistory(one.dir, one.state), true);
  fs.appendFileSync(path.join(HOME, 'history.jsonl'), '{坏行}\n');
  const result = command(['history', '--backfill']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /补录 1 条，跳过 2 条/);
  assert.equal(command(['history', '--backfill']).stdout, '[codex-flow] history 补录 0 条，跳过 3 条\n');
  assert.deepEqual([fs.readFileSync(statePath(one.dir), 'utf8'), fs.readFileSync(statePath(two.dir), 'utf8')], filesBefore);
  assert.deepEqual(fs.readdirSync(RUNS).sort(), ['legacy', 'r-unit', 's-unit']);
  assert.equal(command(['history']).status, 2);
  assert.equal(command(['history', '--backfill', '--typo']).status, 2);
});

test('prune 删除前补 history，已记录的不会重复补；写失败保留目录', () => {
  const { dir, state } = fixture();
  state.pid = 2147483647;
  state.startedAt = state.endedAt = '2000-01-01T00:00:00Z';
  writeJson(statePath(dir), state);
  pruneOldRuns();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(history().length, 1);
  fs.mkdirSync(dir); writeJson(statePath(dir), state);
  pruneOldRuns();
  assert.equal(history().length, 1);
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(path.join(HOME, 'history.jsonl'));
  fs.mkdirSync(path.join(HOME, 'history.jsonl'));
  fs.mkdirSync(dir); writeJson(statePath(dir), state);
  pruneOldRuns();
  assert.equal(fs.existsSync(dir), true);
});

test('history 写失败不改变 flow 和单发的成功退出码，只打印一行警告', () => {
  fs.mkdirSync(path.join(HOME, 'history.jsonl'));
  const plan = { name: '写失败', cwd: root, phases: [{ title: '执行', tasks: [{ label: '任务', ...sol, prompt: '执行' }] }] };
  const result = runPlan(plan);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr.split('\n').filter((s) => s.includes('history 写入失败')).length, 1);
  const single = singleRun('report');
  assert.equal(single.status, 0, single.stdout + single.stderr);
  assert.equal(single.stderr.split('\n').filter((s) => s.includes('history 写入失败')).length, 1);
});

test('flow 续跑结束追加历史，保留第一次的状态和 tokens', () => {
  const plan = { name: '续跑', cwd: root, phases: [{ title: '执行', tasks: [{ label: '任务', ...sol, prompt: '执行' }] }] };
  assert.equal(runPlan(plan).status, 0);
  const { state } = lastRun();
  const first = history()[0];
  assert.deepEqual(first.tasks[0].tokenUsage, { input: 900, cachedInput: 100, output: 87 });
  assert.equal(command(['run', '--resume', state.runId], { env: fakePath() }).status, 0);
  assert.equal(history().length, 2);
  assert.deepEqual(history()[0], first);
  assert.equal(history()[1].runId, state.runId);
  assert.equal(history()[1].resumed, true);
  assert.equal(history()[1].tasks[0].reused, true);
});

test('失败的 flow 和整次停止的 flow 都写 history', async (t) => {
  const failed = runPlan({ name: '失败', cwd: root, phases: [{ title: '执行', tasks: [{ label: '任务', ...sol, prompt: 'FAIL' }] }] });
  assert.equal(failed.status, 1);
  assert.equal(history()[0].status, 'failed');
  assert.equal(history()[0].tasks[0].error, '假失败');
  const file = path.join(root, 'stop-plan.json');
  writeJson(file, { name: '停止', cwd: root, phases: [{ title: '执行', tasks: [{ label: '任务', ...sol, prompt: 'SLOW' }] }] });
  const run = background(['run', file], fakePath({ FAKE_SLOW_MS: '10000' }));
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill('SIGTERM'); await run.done; } });
  const limit = Date.now() + 5000;
  let current;
  while (Date.now() < limit) {
    current = lastRun()?.state;
    if (current?.name === '停止' && current.tasks[0]?.threadId) break;
    await sleep(50);
  }
  assert.equal(current?.name, '停止');
  assert.ok(current.tasks[0].threadId);
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.code, 143, result.stdout + result.stderr);
  assert.equal(history().at(-1).status, 'cancelled');
  assert.equal(history().at(-1).tasks[0].status, 'cancelled');
  assert.ok(history().at(-1).endedAt);
});

test('help 显示 watch 默认等待、history 补录和 report schema', () => {
  const result = command(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /watch .*默认等 flow\/单发结束/);
  assert.match(result.stdout, /history --backfill/);
  assert.match(result.stdout, /schema: review \/ opinion \/ result \/ report/);
});

test('旧单发 rollout 可拆累计用量，归档 flow rollout 可用于补录，缺字段不猜', () => {
  const { dir, state } = fixture('single');
  const task = state.tasks[0];
  Object.assign(task, { threadId: 'old', resumed: true, tokens: 30 });
  const file = path.join(process.env.CODEX_HOME, 'sessions', 'rollout-old.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
  const row = (timestamp, total, last) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } }) + '\n';
  fs.writeFileSync(file, row(new Date(Date.parse(at) - 1000).toISOString(), usage(100, 50, 20), usage(100, 50, 20)) + row(at, usage(120, 60, 30), usage(20, 10, 10)));
  assert.deepEqual(historyRecord(dir, state).tasks[0].tokenUsage, { input: 20, cachedInput: 10, output: 10 });
  const archived = path.join(process.env.CODEX_HOME, 'archived_sessions');
  fs.mkdirSync(archived); fs.renameSync(file, path.join(archived, 'rollout-old.jsonl'));
  state.kind = 'flow'; task.resumed = false;
  assert.deepEqual(historyRecord(dir, state).tasks[0].tokenUsage, { input: 120, cachedInput: 60, output: 30 });
  task.threadId = 'missing';
  assert.equal(historyRecord(dir, state).tasks[0].tokenUsage, undefined);
});

test('计划的 why 和任务的 pick 进 history；只有动作或写了模型名的阶段名开跑时提示；pick 写错拒绝启动', () => {
  const plan = { name: '记录', cwd: root, why: '两个模块互不调用，可以并行', phases: [
    { title: '实现', tasks: [{ label: '甲', ...sol, pick: 'claude', prompt: '执行' }] },
    { title: 'sol 润色', tasks: [{ label: '乙', ...sol, prompt: '执行' }] },
    { title: '实现分页接口', tasks: [{ label: '丙', ...sol, pick: 'user', prompt: '执行' }] }] };
  const result = runPlan(plan);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /阶段名「实现」只有动作/);
  assert.match(result.stderr, /阶段名「sol 润色」写了模型名/);
  assert.doesNotMatch(result.stderr, /阶段名「实现分页接口」/);
  const record = history().at(-1);
  assert.equal(record.why, '两个模块互不调用，可以并行');
  assert.deepEqual(record.tasks.map((t) => t.pick), ['claude', null, 'user']);
  plan.phases[0].tasks[0].pick = 'me';
  const bad = runPlan(plan);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /pick 只能写 default、user、claude/);
});

test('verdict 记下验收结论：整个运行或单个任务，partial/unused 要原因，任务名写错报错，不影响按 runId 补录', () => {
  assert.equal(runPlan({ name: '验收', cwd: root, phases: [{ title: '实现分页接口', tasks: [{ label: '甲', ...sol, prompt: '执行' }, { label: '乙', ...sol, prompt: '执行' }] }] }).status, 0);
  const { state } = lastRun();
  let r = command(['verdict', state.runId, 'used']);
  assert.equal(r.status, 0, r.stderr);
  r = command(['verdict', state.runId, '甲', 'partial']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /要写一句原因/);
  r = command(['verdict', state.runId, '甲', 'partial', '漏了边界，我补改了']);
  assert.equal(r.status, 0, r.stderr);
  r = command(['verdict', state.runId, '丁', 'used']);
  assert.match(r.stderr, /没有任务「丁」/);
  r = command(['verdict', 'r-none', 'used']);
  assert.match(r.stderr, /找不到运行/);
  const verdicts = history().filter((x) => x.type === 'verdict');
  assert.deepEqual(verdicts.map(({ label, verdict, reason }) => ({ label, verdict, reason })),
    [{ label: null, verdict: 'used', reason: null }, { label: '甲', verdict: 'partial', reason: '漏了边界，我补改了' }]);
  // 删掉运行记录行、只留结论行时，补录仍会把这次运行记进去
  fs.writeFileSync(path.join(HOME, 'history.jsonl'), verdicts.map((v) => JSON.stringify(v) + '\n').join(''));
  assert.equal(command(['history', '--backfill']).status, 0);
  assert.ok(history().some((x) => x.runId === state.runId && x.type !== 'verdict'));
});
