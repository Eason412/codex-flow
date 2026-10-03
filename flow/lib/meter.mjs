// 任务说明与回报的计量：任务说明按指令、资料、上游结果、约束、schema 五部分分别计字数和估算 token，回报记结果文件大小。
import fs from "node:fs";
import path from "node:path";

// token 粗估，只用于比较各部分占比：中日韩字符按 1 字 1 token，其余按 4 字符 1 token（英文和代码的常见比例）。
// 按字符逐个累加，所以各部分的估算可以相加相减；真实用量看 Codex 回报的 tokens
const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;
export function estimate(text) {
  const wide = String(text).match(WIDE)?.length ?? 0;
  return wide + ([...String(text)].length - wide) / 4;
}

const part = (chars, est) => ({ chars, estTokens: Math.round(est) });

// 任务说明五部分的计量。rendered 是填好引用、未加约束的文本，text 是最终发出的文本，injected 是注入的上游结果，
// 资料的字数来自加载计划时的记录（sources），指令是作者原文除去资料和上游结果后的部分
export function measureInput(rendered, text, injected, sources, schema) {
  const files = (sources ?? []).filter((s) => s.kind === "file");
  const filesChars = files.reduce((n, s) => n + s.chars, 0);
  const filesEst = files.reduce((n, s) => n + s.est, 0);
  const upstreamChars = injected.reduce((n, s) => n + [...s].length, 0);
  const upstreamEst = injected.reduce((n, s) => n + estimate(s), 0);
  const contract = text.slice(rendered.length);
  const schemaText = schema ? JSON.stringify(schema) : "";
  const input = {
    instruction: part(Math.max(0, [...rendered].length - filesChars - upstreamChars), Math.max(0, estimate(rendered) - filesEst - upstreamEst)),
    files: part(filesChars, filesEst),
    upstream: part(upstreamChars, upstreamEst),
    contract: part([...contract].length, estimate(contract)),
    schema: part([...schemaText].length, estimate(schemaText)),
  };
  const keys = Object.keys(input);
  input.total = { chars: keys.reduce((n, k) => n + input[k].chars, 0), estTokens: keys.reduce((n, k) => n + input[k].estTokens, 0) };
  return input;
}

// 回报计量：结果文件字数；JSON 结果再记顶层字段数
export function meterReport(dir, task) {
  if (!task.result) return;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, task.result), "utf8");
  } catch {
    return;
  }
  const report = { chars: [...text.trim()].length, estTokens: Math.round(estimate(text.trim())) };
  if (task.result.endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === "object" && !Array.isArray(data)) report.fields = Object.keys(data).length;
    } catch {
      // 不是合法 JSON 就只记字数
    }
  }
  task.report = report;
}
