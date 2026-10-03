// 支持 node --test <tests 目录> 的目录入口（Node 22 起把目录参数当成一个文件运行）：所有 *.test.mjs 在这一个进程里依次跑。
// 其余测试文件经 helpers.mjs 沿用 flow.test.mjs 已建的临时目录，执行器模块只加载一次
import fs from 'node:fs';

await import('./flow.test.mjs');
process.env.CODEX_FLOW_TEST_SHARED = '1';
const others = fs.readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.test.mjs') && name !== 'flow.test.mjs').sort();
for (const name of others) await import(`./${name}`);
