#!/usr/bin/env node
// codex-flow：像 Claude Workflow 一样分阶段派 Codex。
// 用法:
//   codex-flow.mjs run <plan.json> [--resume <runId>]   用后台 Bash 启动，flow 结束才退出
//   codex-flow.mjs run --resume <runId>                 用原计划续跑，已完成且没改过的任务直接复用
//   codex-flow.mjs status [runId] [--all]               本会话的运行记录
//   codex-flow.mjs cancel <runId> [任务名]              停整个 flow 或其中一个任务
//   codex-flow.mjs steer <runId> <任务名> "<补充指示>"   给运行中的任务插话
//   codex-flow.mjs watch <runId> [--alert-after 秒]     有任务跑满时长或 flow 结束时打印一行并退出
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNS } from "./lib/state.mjs";
import { die } from "./lib/runtime.mjs";
import { runFlow, onStop } from "./lib/runner.mjs";
import { cmdStatus, cmdCancel, cmdSteer, cmdWatch } from "./lib/commands.mjs";
import { SINGLE_FLAGS, cmdCheck, cmdSingleStart, cmdSingleWatch, cmdSingleEnd } from "./lib/single.mjs";

export { shortCommand, activityOf } from "./lib/activity.mjs";
export { inScope } from "./lib/scope.mjs";
export { conclusionOf } from "./lib/summary.mjs";
export { findRollout, readCompleteRecords, singleContext } from "./lib/rollout.mjs";
export { usageTokens, applyTokenRecords, singleWatchTick, watchSingle, settleSingleTokens } from "./lib/tokens.mjs";
export { indentJson } from "./lib/single.mjs";

function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (valueFlags.includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

// ---------- 入口 ----------

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run": {
      const { flags, positionals } = parseArgs(rest, ["resume"]);
      if (!positionals[0] && !flags.resume) die("用法: run <plan.json> [--resume <runId>]");
      fs.mkdirSync(RUNS, { recursive: true });
      process.on("SIGTERM", () => onStop("SIGTERM"));
      process.on("SIGINT", () => onStop("SIGINT"));
      process.on("SIGHUP", () => onStop("SIGHUP"));
      await runFlow(positionals[0] ? path.resolve(positionals[0]) : null, flags.resume ?? null);
      break;
    }
    case "status": cmdStatus(parseArgs(rest)); break;
    case "cancel": cmdCancel(parseArgs(rest)); break;
    case "steer": cmdSteer(parseArgs(rest)); break;
    case "watch": await cmdWatch(parseArgs(rest, ["alert-after"])); break;
    case "_check": cmdCheck(parseArgs(rest, ["model", "effort", "label"])); break;
    case "_single-watch": await cmdSingleWatch(parseArgs(rest, ["dir"])); break;
    case "_single-start": cmdSingleStart(parseArgs(rest, SINGLE_FLAGS)); break;
    case "_single-end": cmdSingleEnd(parseArgs(rest, [...SINGLE_FLAGS, "code"])); break;
    default:
      die("用法: run | status | cancel | steer | watch（见文件开头的说明）");
  }
}
