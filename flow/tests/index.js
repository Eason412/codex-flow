// 支持 node --test <tests 目录> 的目录入口。
// flow.test.mjs 和用 helpers.mjs 的新测试文件各自设临时 CODEX_FLOW_HOME，同一进程里会互相覆盖：
// 新文件在子进程里跑，TAP 输出的每个顶层测试转成这里的一个子测试
import './flow.test.mjs';
import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

function runFile(file) {
  // 去掉测试运行器给子进程的标记，否则孙进程不会按普通 --test 运行
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { out += data; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

for (const name of fs.readdirSync(here).filter((n) => n.endsWith('.test.mjs') && n !== 'flow.test.mjs').sort()) {
  test(name, async (t) => {
    const { code, out } = await runFile(here + name);
    const lines = out.split('\n');
    let seen = 0;
    for (const [i, line] of lines.entries()) {
      const m = /^(not )?ok \d+ - (.*)$/.exec(line);
      if (!m) continue;
      seen++;
      const detail = [];
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) detail.push(lines[j]);
      await t.test(m[2].replace(/\\(.)/g, '$1'), () => {
        if (m[1]) throw new Error(detail.join('\n'));
      });
    }
    if (!seen) throw new Error(`没有解析出测试（退出码 ${code}）：\n${out}`);
    if (code !== 0 && !lines.some((l) => l.startsWith('not ok'))) throw new Error(`退出码 ${code}：\n${out}`);
  });
}
