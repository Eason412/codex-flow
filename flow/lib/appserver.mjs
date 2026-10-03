// 精简的 Codex app-server 客户端：每个任务起一个 `codex app-server`，通过 stdio 收发 JSON-RPC。
// 协议用法参照 openai/codex-plugin-cc（Apache-2.0）的 scripts/lib/app-server.mjs。
import { spawn } from "node:child_process";
import readline from "node:readline";

// 逐字推送的增量通知对我们没用，只会把日志撑大
const OPT_OUT = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
];

export class AppServer {
  static async start({ cwd, env = process.env, onNotification = () => {} }) {
    const server = new AppServer(cwd, env, onNotification);
    await server.request("initialize", {
      clientInfo: { title: "codex-flow", name: "codex-flow", version: "0.2.0" },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPT_OUT },
    });
    server.notify("initialized", {});
    return server;
  }

  constructor(cwd, env, onNotification) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.onNotification = onNotification;
    this.proc = spawn("codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.proc.on("error", (error) => this.fail(error));
    this.proc.on("exit", (code, signal) => {
      this.fail(new Error(`codex app-server 退出了（${signal ? `signal ${signal}` : `exit ${code}`}）${this.stderr.trim() ? `：${this.stderr.trim().slice(-500)}` : ""}`));
    });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.handleLine(line));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      // 服务端发来的请求（审批、向用户提问等）一律拒绝，否则这一轮会一直挂着
      this.send({ id: message.id, error: { code: -32601, message: "codex-flow 不处理交互请求" } });
      this.onNotification({ method: `server-request:${message.method}`, params: message.params ?? {} });
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.onNotification(message);
  }

  send(message) {
    if (this.closed || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("codex app-server 连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.onNotification({ method: "connection/closed", params: { message: error.message } });
  }

  close() {
    if (this.closed) return;
    this.proc.stdin.end();
    this.proc.kill("SIGTERM");
    this.closed = true;
  }
}
