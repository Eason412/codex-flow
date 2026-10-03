#!/usr/bin/env bash
# 把任务交给 Codex（无沙箱、不审批），跑完报告 Codex 实际使用的模型和 effort。
# 用法: run.sh -m <model> -e <effort> [-n <显示名>] [-C <dir>] [-r <thread_id> | -f <thread_id> | -w] [-j <schema>] "<task>"
#   -n  状态行和 /flow 面板里显示的名字，默认取任务第一行
#   -r  接着这个 Codex 对话继续        -f  从这个对话分叉出新对话
#   -w  在新的 git worktree 里运行（不能和 -r/-f 同用）
#   -j  按 JSON Schema 返回：review / opinion / result，或 schema 文件路径
set -uo pipefail

usage='用法: run.sh -m <model> -e <effort> [-n <显示名>] [-C <dir>] [-r <thread_id> | -f <thread_id> | -w] [-j <schema>] "<task>"'
here=$(cd "$(dirname "$0")" && pwd)
model="" effort="" name="" dir="$PWD" resume="" fork="" worktree="" schema=""
while getopts "m:e:n:C:r:f:wj:" opt; do
  case $opt in
    m) model=$OPTARG ;;
    e) effort=$OPTARG ;;
    n) name=$OPTARG ;;
    C) dir=$OPTARG ;;
    r) resume=$OPTARG ;;
    f) fork=$OPTARG ;;
    w) worktree=1 ;;
    j) schema=$OPTARG ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
task=${1:-}
if [[ -z $model || -z $effort || -z $task ]]; then
  echo "必须给出 -m、-e 和任务描述。$usage" >&2
  exit 2
fi
if (( ${#resume} && ${#fork} )) || [[ -n $worktree && -n $resume$fork ]]; then
  echo "-r、-f、-w 只能三选一（worktree 任务不能续聊或分叉）。" >&2
  exit 2
fi
if [[ -n $schema ]]; then
  if [[ -f $schema ]]; then
    schema="$(cd "$(dirname "$schema")" && pwd)/$(basename "$schema")"
  else
    schema="$here/schemas/$schema.json"
    [[ -f $schema ]] || { echo "找不到 schema: ${schema}（内置: review / opinion / result）" >&2; exit 2; }
  fi
fi

flow="$here/flow/codex-flow.mjs"
node "$flow" _check --model "$model" --effort "$effort" --label "${name:-任务}" || exit 2

base="${CODEX_FLOW_HOME:-$HOME/.claude/codex-flow}/runs"
mkdir -p "$base"
run=$(mktemp -d "$base/s-XXXXXX")
echo "[codex] 运行中，日志目录: $run"

# 按 codex-flow 的格式登记，状态行和 /flow 面板据此显示；被停掉时也记下结束
printf '%s' "$task" >"$run/task.txt"
# 登记参数：_single-start 用；登记失败时 _single-end 用同一组参数补登
abs_dir=$(cd "$dir" 2>/dev/null && pwd) || abs_dir=$dir
reg=(--dir "$run" --model "$model" --effort "$effort" --label "$name" --pid $$ --cwd "$abs_dir" --thread-id "$resume" --forked-from "$fork" --task-file "$run/task.txt")
# 模型已由上面的 _check 拦下；这里失败只影响面板显示，任务照常运行
if ! node "$flow" _single-start "${reg[@]}" 2>/dev/null; then
  echo "[codex] ⚠ 没能登记到 Codex 任务面板，任务照常运行"
fi
node "$flow" _single-watch --dir "$run" >/dev/null 2>&1 &
watch_pid=$!
stop_watch() {
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" 2>/dev/null || true
}
stop_single() {
  trap - TERM INT
  if [[ -n ${codex_pid:-} ]]; then
    kill "$codex_pid" 2>/dev/null || true
    wait "$codex_pid" 2>/dev/null || true
  fi
  stop_watch
  node "$flow" _single-end "${reg[@]}" --code "$1" 2>/dev/null
  exit "$1"
}
trap 'stop_single 143' TERM
trap 'stop_single 130' INT

cd "$dir" || { echo "目录不存在: $dir" >&2; stop_watch; node "$flow" _single-end "${reg[@]}" --code 2 2>/dev/null; exit 2; }
opts=(-m "$model" -c "model_reasoning_effort=$effort"
      --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
      --json -o "$run/last.md")
[[ -n $schema ]] && opts+=(--output-schema "$schema")
if [[ -n $resume ]]; then
  cmd=(codex exec resume "${opts[@]}" "$resume" "$task")
elif [[ -n $fork ]]; then
  cmd=(codex exec fork "${opts[@]}" "$fork" "$task")
else
  [[ -n $worktree ]] && opts+=(--worktree)
  cmd=(codex exec "${opts[@]}" "$task")
fi
"${cmd[@]}" </dev/null >"$run/events.jsonl" 2>"$run/stderr.log" &
codex_pid=$!
wait "$codex_pid"
code=$?
stop_watch
trap - TERM INT
node "$flow" _single-end "${reg[@]}" --code "$code" 2>/dev/null
report_code=$?
[[ $code -ne 0 ]] || code=$report_code
exit "$code"
