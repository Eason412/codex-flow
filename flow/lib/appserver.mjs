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

// initialize 的等待上限：真实 Codex 冷启动（读配置、起内置服务）通常几秒内回应，30 秒还没回应就是卡死；
// 取得比慢机器的冷启动长，宁可晚报也不误杀。测试用 CODEX_FLOW_INIT_TIMEOUT_MS 改小
const INIT_TIMEOUT_MS = 30000;
// SIGTERM 之后等子进程自己退出的时间，到点还在就 SIGKILL
const KILL_GRACE_MS = 2000;

export class AppServer {
  // initialize 被拒、超时或子进程提前退出时，先关掉子进程再抛错：调用方拿不到实例，不关就没人能关。
  // onSpawn 在子进程一起来就交出实例，启动中途收到停止信号时调用方也能关掉它
  static async start({ cwd, env = process.env, onNotification = () => {}, onSpawn = () => {} }) {
    const server = new AppServer(cwd, env, onNotification);
    onSpawn(server);
    const limit = Number(process.env.CODEX_FLOW_INIT_TIMEOUT_MS) || INIT_TIMEOUT_MS;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`codex app-server 的 initialize 超过 ${limit / 1000} 秒没有回应`)), limit);
      });
      const init = server.request("initialize", {
        clientInfo: { title: "codex-flow", name: "codex-flow", version: "0.4.0" },
        capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPT_OUT },
      }).catch((error) => {
        throw error.rpc ? new Error(`codex app-server 的 initialize 被拒：${error.message}`) : error;
      });
      await Promise.race([init, timeout]);
    } catch (error) {
      await server.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    // 子进程已死时再写 stdin 会报 EPIPE，由 exit / error 事件统一处理，这里不让它变成未捕获异常
    this.proc.stdin.on("error", () => {});
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", resolve);
      this.proc.on("error", resolve); // spawn 失败时不会有 exit
    });
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
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? JSON.stringify(message.error)), { rpc: true }));
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

  rejectPending(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  // 子进程退出或 spawn 失败：挂起的请求都 reject，免得一直等一个不会来的回应
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    this.onNotification({ method: "connection/closed", params: { message: error.message } });
  }

  // 关闭子进程并等它真的退出：先 SIGTERM，宽限期后还在就 SIGKILL；可重复调用
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.rejectPending(new Error("codex app-server 连接已关闭"));
    if (!this.proc.pid || this.proc.exitCode !== null || this.proc.signalCode !== null) return (this.closePromise = Promise.resolve());
    this.proc.stdin.end();
    this.proc.kill("SIGTERM");
    const killer = setTimeout(() => this.proc.kill("SIGKILL"), KILL_GRACE_MS);
    return (this.closePromise = this.exited.then(() => clearTimeout(killer)));
  }
}
