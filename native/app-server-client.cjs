"use strict";

const { spawn } = require("node:child_process");
const { fromAppServer } = require("../usage-source.js");

const READ_METHODS = new Set(["initialize", "account/read", "account/rateLimits/read", "account/usage/read"]);
const MAX_LINE_BYTES = 1024 * 1024;

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class AppServerClient {
  constructor({ command = "codex", args = ["-s", "read-only", "-a", "never", "app-server"], timeoutMs = 10000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new ProbeError("invalid-timeout");
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.closed = false;
    this.child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    // Neither stderr nor raw protocol bodies may reach probe output: they can
    // contain account identifiers, paths, or credential-related diagnostics.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail("transport-closed"));
    this.child.on("error", () => this.fail("launch-failed"));
    this.child.on("close", () => this.fail("transport-closed"));
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
  }

  fail(code) {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ProbeError(code));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_LINE_BYTES) return this.fail("response-too-large");
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail("invalid-json"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail("invalid-response");
      if (Object.hasOwn(message, "method")) {
        // Refuse server-initiated approvals, token refresh callbacks, and tools.
        if (Object.hasOwn(message, "id")) this.write({ id: message.id, error: { code: -32601, message: "Read-only monitor" } });
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (Object.hasOwn(message, "error")) {
        entry.reject(new ProbeError(message.error?.code === -32601 ? "method-unavailable" : "rpc-failed"));
      } else if (Object.hasOwn(message, "result")) entry.resolve(message.result);
      else entry.reject(new ProbeError("invalid-response"));
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.fail("response-too-large");
  }

  write(message) {
    if (this.closed) throw new ProbeError("transport-closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (!READ_METHODS.has(method)) return Promise.reject(new ProbeError("method-not-allowed"));
    if (this.closed) return Promise.reject(new ProbeError("transport-closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("request-timeout"), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch { this.fail("transport-closed"); }
    });
  }

  async close() {
    this.fail("transport-closed");
    this.child.stdin.destroy();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 300);
    await this.exited;
    clearTimeout(timer);
  }
}

async function readUsage({ client = new AppServerClient(), includeActivity = true } = {}) {
  const started = Date.now();
  try {
    await client.request("initialize", { clientInfo: { name: "codex_usage_viewer_probe", version: require("../package.json").version } });
    client.write({ method: "initialized" });
    const account = await client.request("account/read", { refreshToken: false });
    if (account?.account?.type !== "chatgpt") throw new ProbeError("chatgpt-auth-required");
    const limits = await client.request("account/rateLimits/read");
    const observedAt = new Date().toISOString();
    let activity = null;
    let activityStatus = "not-requested";
    if (includeActivity) {
      try {
        activity = await client.request("account/usage/read");
        activityStatus = "received";
      } catch (error) {
        // Only a returned RPC error is recoverable; a broken transport invalidates the read.
        if (!["method-unavailable", "rpc-failed"].includes(error.code)) throw error;
        activityStatus = error.code;
      }
    }
    const after = await client.request("account/read", { refreshToken: false });
    if (after?.account?.type !== "chatgpt" || after.account.email !== account.account.email
      || after.account.planType !== account.account.planType) throw new ProbeError("account-changed");
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      activityStatus,
      snapshot: fromAppServer({ account, limits, activity, observedAt })
    };
  } finally {
    await client.close();
  }
}

module.exports = { AppServerClient, ProbeError, readUsage };
