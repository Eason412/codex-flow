#!/usr/bin/env node
// codex-flow：像 Claude Workflow 一样分阶段派 Codex。
// 用法:
//   codex-flow.mjs run <plan.json> [--resume <runId>]   用后台 Bash 启动，flow 结束才退出
//   codex-flow.mjs run --resume <runId>                 用原计划续跑，已完成且没改过的任务直接复用
//   codex-flow.mjs run [plan.json] --resume <runId> --rerun <任务名>   续跑时强制重跑该任务及等它的任务（可重复）
//   codex-flow.mjs status [runId] [--all]               本会话的运行记录
//   codex-flow.mjs cancel <runId> [任务名]              停整个 flow 或其中一个任务
//   codex-flow.mjs steer <runId> <任务名> "<补充指示>"   给运行中的任务插话
//   codex-flow.mjs watch <runId> [--alert-after 秒]     等 flow/单发结束并打印汇总；显式阈值才提前提醒
//   codex-flow.mjs verdict <runId> [任务名] <used|partial|unused> ["原因"]   验收后记下结果是否用上
//   codex-flow.mjs history --backfill                 补录现有运行到 history.jsonl，已有 runId 跳过
//   flow schema: review / opinion / result / report，或 schema 文件路径
//   run.sh -j report 回传结论和全文路径；-j review/opinion 回传全文；-r/-f 自动取消归档
//   codex-flow.mjs stats <runId> [--json]               每个任务的任务说明组成、token 用量、回报大小和验收
//   codex-flow.mjs clean <runId>                        删掉这次运行的隔离任务留下的私有引用和 worktree
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNS } from "./lib/state.mjs";
import { die } from "./lib/runtime.mjs";
import { runFlow, onStop } from "./lib/runner.mjs";
import { cmdStatus, cmdCancel, cmdSteer, cmdWatch } from "./lib/commands.mjs";
import { cmdStats } from "./lib/stats.mjs";
import { SINGLE_FLAGS, cmdCheck, cmdSingleStart, cmdSingleWatch, cmdSingleEnd } from "./lib/single.mjs";
import { cmdClean } from "./lib/isolation.mjs";
import { cmdHistory, cmdVerdict } from "./lib/history.mjs";
import { cmdUnarchive } from "./lib/threads.mjs";

export { shortCommand, activityOf } from "./lib/activity.mjs";
export { inScope } from "./lib/scope.mjs";
export { conclusionOf } from "./lib/summary.mjs";
export { findRollout, readCompleteRecords, singleContext } from "./lib/rollout.mjs";
export { usageTokens, applyTokenRecords, singleWatchTick, watchSingle, settleSingleTokens } from "./lib/tokens.mjs";
export { indentJson } from "./lib/single.mjs";

// listFlags 里的参数可以重复，收集成数组；其余带值参数重复时取最后一个。带值参数也可以写成 --名字=值
function parseArgs(argv, valueFlags = [], listFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const value = () => (eq > 0 ? arg.slice(eq + 1) : argv[++i]);
      if (listFlags.includes(key)) (flags[key] ??= []).push(value());
      else if (valueFlags.includes(key)) flags[key] = value();
      else flags[key] = true;
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

// 新命令和新参数写错时直接报错，不静默忽略
function strict({ flags, positionals }, known, maxPositionals, usage) {
  const unknown = Object.keys(flags).filter((k) => !known.includes(k));
  if (unknown.length) die(`不认识的参数: ${unknown.map((k) => `--${k}`).join(" ")}。${usage}`);
  if (positionals.length > maxPositionals) die(`多余的参数: ${positionals.slice(maxPositionals).join(" ")}。${usage}`);
  return { flags, positionals };
}

// ---------- 入口 ----------

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "--help": case "-h": case "help":
      process.stdout.write(`用法:
  run <plan.json> [--resume <runId>] [--rerun <任务名>]  分阶段运行；续跑可省略计划
  status [runId] [--all]                             查看运行记录
  cancel <runId> [任务名]                            停止运行或任务
  steer <runId> <任务名> "<补充指示>"                 给运行中的任务插话
  watch <runId> [--alert-after 秒]                    默认等 flow/单发结束，打印 summary.txt 全文；显式阈值才提前提醒
  verdict <runId> [任务名] used|partial|unused ["原因"]  验收后记下结果是否用上（partial、unused 要写原因）
  history --backfill                                补录现有目录到 history.jsonl，已有 runId 或无 state.json 的目录跳过
  stats <runId> [--json]                             查看任务计量
  clean <runId>                                     清理隔离成果
schema: review / opinion / result / report，或 schema 文件路径。
run.sh -j review/opinion 回传全文，其余回传至多三行结论和全文路径；-r/-f 自动取消归档。
`);
      break;
    case "run": {
      const usage = "用法: run <plan.json> [--resume <runId>] [--rerun <任务名>]";
      const { flags, positionals } = strict(parseArgs(rest, ["resume"], ["rerun"]), ["resume", "rerun"], 1, usage);
      if (!positionals[0] && !flags.resume) die(usage);
      if (flags.rerun?.some((label) => !label)) die("--rerun 后面要写任务名");
      fs.mkdirSync(RUNS, { recursive: true });
      process.on("SIGTERM", () => onStop("SIGTERM"));
      process.on("SIGINT", () => onStop("SIGINT"));
      process.on("SIGHUP", () => onStop("SIGHUP"));
      await runFlow(positionals[0] ? path.resolve(positionals[0]) : null, flags.resume ?? null, flags.rerun ?? []);
      break;
    }
    case "status": cmdStatus(parseArgs(rest)); break;
    case "cancel": cmdCancel(parseArgs(rest)); break;
    case "steer": cmdSteer(parseArgs(rest)); break;
    case "watch": await cmdWatch(parseArgs(rest, ["alert-after"])); break;
    case "stats": cmdStats(strict(parseArgs(rest), ["json"], 1, "用法: stats <runId> [--json]")); break;
    case "clean": cmdClean(strict(parseArgs(rest), [], 1, "用法: clean <runId>")); break;
    case "verdict": cmdVerdict(parseArgs(rest)); break;
    case "history": {
      const parsed = strict(parseArgs(rest), ["backfill"], 0, "用法: history --backfill");
      if (!parsed.flags.backfill) die("用法: history --backfill");
      cmdHistory();
      break;
    }
    case "_unarchive": cmdUnarchive(parseArgs(rest, ["thread-id"])); break;
    case "_check": cmdCheck(parseArgs(rest, ["model", "effort", "label"])); break;
    case "_single-watch": await cmdSingleWatch(parseArgs(rest, ["dir"])); break;
    case "_single-start": cmdSingleStart(parseArgs(rest, SINGLE_FLAGS)); break;
    case "_single-end": cmdSingleEnd(parseArgs(rest, [...SINGLE_FLAGS, "code"])); break;
    default:
      die("用法: run | status | cancel | steer | watch | stats | verdict | clean | history --backfill（watch 默认等结束；schema: review/opinion/result/report；见文件开头的说明）");
  }
}
