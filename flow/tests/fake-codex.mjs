#!/usr/bin/env node
// 测试时复制到临时 bin/codex；没有任何真实 Codex 调用。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const args = process.argv.slice(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (args[0] === 'app-server') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result = {};
    if (request.method === 'thread/start') result = { thread: { id: 'fake-flow-thread' }, model: 'gpt-6.1-sol' };
    if (request.method === 'turn/start') result = { turn: { id: 'fake-flow-turn' } };
    send({ id: request.id, result });
    if (request.method === 'turn/start') {
      setTimeout(() => {
        send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 987 } } } });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '假 flow 结果' } } });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }, 30);
    }
  });
} else if (args[0] === 'exec') {
  const resumed = args[1] === 'resume';
  const forked = args[1] === 'fork';
  const thread = resumed ? 'fake-resumed-thread' : forked ? 'fake-child-thread' : 'fake-new-thread';
  const baseInput = forked ? 90000 : resumed ? 800 : 0;
  const baseOutput = forked ? 19880 : resumed ? 200 : 0;
  const firstInput = forked ? 12000 : 120;
  const firstOutput = forked ? 6965 : 80;
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  // 续接仍写进旧日期目录，以覆盖查找回退。
  const dir = path.join(process.env.CODEX_HOME, 'sessions', resumed ? '2020' : String(date.getFullYear()), resumed ? '01' : pad(date.getMonth() + 1), resumed ? '01' : pad(date.getDate()));
  const file = path.join(dir, `rollout-test-${thread}.jsonl`);
  const usage = (input, output) => ({ input_tokens: input, cached_input_tokens: 50, output_tokens: output, reasoning_output_tokens: 10, total_tokens: input + output });
  const record = (input, output, lastInput, lastOutput, timestamp = new Date().toISOString()) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(input, output), last_token_usage: usage(lastInput, lastOutput) } } });
  const append = (event) => fs.appendFileSync(file, JSON.stringify(event) + '\n');
  send({ type: 'thread.started', thread_id: thread });
  await sleep(250); // rollout 比 thread.started 晚出现
  fs.mkdirSync(dir, { recursive: true });
  if (resumed) append(record(800, 200, 800, 200, '2020-01-01T00:00:00Z'));
  append({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high', cwd: process.cwd(), sandbox_policy: { type: 'danger-full-access' } } });
  append({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null } });
  append(record(baseInput + firstInput, baseOutput + firstOutput, firstInput, firstOutput));
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'fake-pid'), String(process.pid));
  while (!fs.existsSync(path.join(process.env.CODEX_HOME, 'advance'))) await sleep(50);
  append({ timestamp: new Date().toISOString(), type: 'compacted', payload: {} });
  const final = JSON.stringify(record(baseInput + firstInput + 80, baseOutput + firstOutput + 70, 80, 70));
  fs.appendFileSync(file, final.slice(0, 40));
  await sleep(150);
  fs.appendFileSync(file, final.slice(40) + '\n');
  while (!fs.existsSync(path.join(process.env.CODEX_HOME, 'finish'))) await sleep(50);
  fs.writeFileSync(args[args.indexOf('-o') + 1], '  {"整数":9007199254740993,"浮点":1.0}  ');
  send({ type: 'turn.completed', usage: usage(baseInput + firstInput + 80, baseOutput + firstOutput + 70) });
} else {
  process.stderr.write('测试假 codex 不支持该命令\n');
  process.exit(91);
}
