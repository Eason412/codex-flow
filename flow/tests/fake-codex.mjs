#!/usr/bin/env node
// 测试时复制到临时 bin/codex；没有任何真实 Codex 调用。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const args = process.argv.slice(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const archivedFile = (id, dir = path.join(process.env.CODEX_HOME, 'archived_sessions')) => {
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && (entry.name.endsWith(`-${id}.jsonl`) || entry.name.endsWith(`_${id}.jsonl`))) return file;
    if (entry.isDirectory()) { const found = archivedFile(id, file); if (found) return found; }
  }
  return null;
};
if (args[0] === 'unarchive') {
  if (process.env.FAKE_UNARCHIVE_FAIL) { process.stderr.write('假取消归档失败\n'); process.exit(7); }
  const file = archivedFile(args[1]);
  if (!file) process.exit(8);
  const dest = path.join(process.env.CODEX_HOME, 'sessions', 'unarchived');
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(file, path.join(dest, path.basename(file)));
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-unarchived'), args[1] + '\n');
  process.exit(0);
}
if (args[0] === 'app-server') {
  // 启动阶段的开关：FAKE_INIT 让 initialize 回错误（error）、不回应（silent）或直接退出（exit），FAKE_INIT_ONLY=<子串> 只对 cwd 含该子串的进程生效；
  // error 和 silent 时进程继续活着并把 pid 写到 $CODEX_HOME/fake-app-pid；FAKE_IGNORE_EOF=1 用定时器保活、不随 stdin 结束而退出，FAKE_IGNORE_TERM=1 再忽略 SIGTERM（只有 SIGKILL 杀得掉）
  const initMode = process.env.FAKE_INIT && process.cwd().includes(process.env.FAKE_INIT_ONLY ?? '') ? process.env.FAKE_INIT : '';
  if (process.env.FAKE_IGNORE_EOF) setInterval(() => {}, 1000);
  // FAKE_RECORD_PIDS=1：每个 app-server 一起来就把 pid 追加到 $CODEX_HOME/fake-app-pids
  if (process.env.FAKE_RECORD_PIDS) fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-app-pids'), `${process.pid}\n`);
  if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === 'initialize' && initMode) {
      if (initMode === 'exit') process.exit(3);
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'fake-app-pid'), String(process.pid));
      if (initMode === 'error') send({ id: request.id, error: { code: -32600, message: '假初始化被拒' } });
      return;
    }
    // 归档请求：FAKE_ARCHIVE=fail 回错误、hang 不回应；成功的记到 $CODEX_HOME/fake-archived，测试据此核对
    if (request.method === 'thread/archive') {
      if (process.env.FAKE_ARCHIVE === 'hang') return;
      if (process.env.FAKE_ARCHIVE === 'fail') return send({ id: request.id, error: { code: -32600, message: '假归档失败' } });
      fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-archived'), `${request.params.threadId}\n`);
    }
    let result = {};
    // 插话里带 REJECT 时像 turn 已结束那样回错误
    if (request.method === 'turn/steer' && JSON.stringify(request.params).includes('REJECT')) return send({ id: request.id, error: { code: -32600, message: '假插话被拒' } });
    // 像 Codex 一样回报这个 thread 用的 service tier：请求了就是请求的值，没请求是 null
    if (request.method === 'thread/start') result = { thread: { id: 'fake-flow-thread' }, model: 'gpt-6.1-sol', serviceTier: request.params?.serviceTier ?? null };
    if (request.method === 'turn/start') result = { turn: { id: 'fake-flow-turn' } };
    send({ id: request.id, result });
    if (request.method === 'turn/start') {
      // prompt 里的标记控制假结果：SLOW 慢 1.5 秒（FAKE_SLOW_MS 可改），FAIL 失败，CWD 回报工作目录，JSON 回 review 格式，CMD 先跑一条命令，CMDHANG 只发命令开始、不发结束
      const prompt = request.params?.input?.[0]?.text ?? '';
      // STUBBORN：这个 app-server 从此不随 stdin 结束退出、不理 SIGTERM（只有 SIGKILL 杀得掉），pid 追加到 $CODEX_HOME/fake-app-pids
      if (prompt.includes('STUBBORN')) {
        setInterval(() => {}, 1000);
        process.on('SIGTERM', () => {});
        fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fake-app-pids'), `${process.pid}\n`);
      }
      let text = '假 flow 结果';
      if (prompt.includes('CWD')) text = `cwd=${process.cwd()}`;
      if (prompt.includes('JSON')) text = JSON.stringify({ verdict: 'pass_with_issues', summary: '第一行结论\n第二行结论', findings: [{ severity: 'major' }, { severity: 'minor' }, { severity: 'minor' }], open_questions: [] });
      if (request.params?.outputSchema?.properties?.deviations) text = JSON.stringify({ status: 'done', summary: '报告结论', files: [{ path: 'a.mjs', note: '修复实现' }], deviations: [], open_issues: [] });
      // PATCH:<路径> 像 apply_patch 一样写文件并发改文件记录，SHELL:<路径> 只写文件（像 shell 命令），
      // EDIT:<路径>:<原文>:<新文> 只把文件里第一处原文换成新文并发改文件记录（测同一文件的不同段落），
      // REPLACE:<路径> 把该路径（如指回主工作区的链接）删掉、换成含一个文件的真实目录；删链接只删链接本身
      const write = (rel) => {
        const file = path.resolve(process.cwd(), rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `写入 ${Date.now()}\n`);
        return file;
      };
      if (prompt.includes('CMD')) {
        const item = { type: 'commandExecution', id: 'cmd-1', command: '/bin/zsh -lc "echo \\"hi\\" && ls"' };
        send({ method: 'item/started', params: { item: { ...item, status: 'inProgress' } } });
        if (!prompt.includes('CMDHANG')) send({ method: 'item/completed', params: { item: { ...item, status: 'completed', exitCode: 0 } } });
      }
      setTimeout(() => {
        for (const [, rel] of prompt.matchAll(/(?<!BAD)PATCH:(\S+)/g)) {
          send({ method: 'item/completed', params: { item: { type: 'fileChange', id: rel, status: 'completed', changes: [{ path: write(rel), kind: { type: 'add' }, diff: '' }] } } });
        }
        for (const [, rel] of prompt.matchAll(/SHELL:(\S+)/g)) write(rel);
        for (const [, rel, from, to] of prompt.matchAll(/EDIT:([^:\s]+):([^:\s]+):([^:\s]*)/g)) {
          const file = path.resolve(process.cwd(), rel);
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
          send({ method: 'item/completed', params: { item: { type: 'fileChange', id: rel, status: 'completed', changes: [{ path: file, kind: { type: 'update' }, diff: '' }] } } });
        }
        for (const [, rel] of prompt.matchAll(/REPLACE:(\S+)/g)) {
          const file = path.resolve(process.cwd(), rel);
          if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(file);
          else fs.rmSync(file, { recursive: true, force: true });
          fs.mkdirSync(file, { recursive: true });
          fs.writeFileSync(path.join(file, 'real.txt'), '真实目录\n');
        }
        // BADPATCH:<路径> 发一条没生效的改文件记录，不写文件
        for (const [, rel] of prompt.matchAll(/BADPATCH:(\S+)/g)) {
          send({ method: 'item/completed', params: { item: { type: 'fileChange', id: rel, status: 'failed', changes: [{ path: path.resolve(process.cwd(), rel), kind: { type: 'add' }, diff: '' }] } } });
        }
        send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 987, inputTokens: 900, cachedInputTokens: 100, outputTokens: 87 }, last: { inputTokens: 900 } } } });
        if (prompt.includes('FAIL')) return send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: '假失败' } } } });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }, prompt.includes('SLOW') ? Number(process.env.FAKE_SLOW_MS) || 1500 : 30);
    }
  });
} else if (args[0] === 'exec') {
  const resumed = args[1] === 'resume';
  const forked = args[1] === 'fork';
  const parent = resumed || forked ? args.at(-2) : null;
  if (parent && archivedFile(parent)) {
    process.stderr.write(`thread/${resumed ? 'resume' : 'fork'} failed: session ${parent} is archived. Run \`codex unarchive ${parent}\`\n`);
    process.exit(1);
  }
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
  // 和真实 Codex 一样，只有续聊会把 thread 设置（含 service tier）写进会话记录
  const tier = args.map((a) => /^service_tier="(.*)"$/.exec(a)?.[1]).find(Boolean) ?? 'default';
  if (resumed) append({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: tier } } });
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
  fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_REPLY ?? '  {"整数":9007199254740993,"浮点":1.0}  ');
  send({ type: 'turn.completed', usage: usage(baseInput + firstInput + 80, baseOutput + firstOutput + 70) });
} else {
  process.stderr.write('测试假 codex 不支持该命令\n');
  process.exit(91);
}
