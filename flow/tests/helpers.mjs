// 新测试文件共用的环境：临时 CODEX_FLOW_HOME / CODEX_HOME、假 codex、写计划并运行、临时 git 仓库。
// 必须在导入执行器模块之前导入本文件，环境变量才对它们生效
import { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const skill = fileURLToPath(new URL('../..', import.meta.url));
export const cli = path.join(skill, 'flow/codex-flow.mjs');
export const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-test-')));
process.env.CODEX_FLOW_HOME = path.join(root, 'flow');
process.env.CODEX_HOME = path.join(root, 'codex');
delete process.env.CLAUDE_CODE_SESSION_ID;
const stateLib = await import('../lib/state.mjs');
export const { RUNS, readJson, writeJson, statePath } = stateLib;

export const sol = { model: 'gpt-6.1-sol', effort: 'high' };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

// PATH 前面放假 codex；extra 里的变量一并加进环境
export function fakePath(extra = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(new URL('./fake-codex.mjs', import.meta.url), path.join(bin, 'codex'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  return { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...extra };
}

export const command = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env, ...options });

export function runPlan(plan, args = [], env = fakePath(), timeout = 15000) {
  const file = path.join(root, 'plan.json');
  writeJson(file, plan);
  return command(['run', file, ...args], { env, timeout });
}

// 最近一次运行（按目录名排序取最后一个）
export function lastRun() {
  const ids = fs.readdirSync(RUNS).filter((n) => n.startsWith('r-')).sort();
  const dir = path.join(RUNS, ids.at(-1));
  return { dir, state: readJson(statePath(dir)) };
}
export const taskOf = (state, label) => state.tasks.find((t) => t.label === label);

// 带一次初始提交的 git 仓库；files 是 相对路径 → 内容
export function gitRepo(name = 'repo', files = { 'README.md': '初始\n' }) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { repo, git };
}

export function background(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
