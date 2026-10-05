const test = require("node:test");
const assert = require("node:assert/strict");
const { AppServerClient, readUsage } = require("../native/app-server-client.cjs");

// A real child process exercises framing, lifecycle, method filtering and stderr isolation.
const server = String.raw`
const mode = process.argv[1];
const readline = require('node:readline');
let initialized = false, reads = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') { initialized = true; return; }
  if (!request.method) return;
  if (mode === 'exit') process.exit(0);
  if (mode === 'timeout') return;
  if (mode === 'malformed') { process.stdout.write('secret invalid json\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (mode === 'rpc-error') { send({ id: request.id, error: { code: 401, message: 'token=secret private@example.test' } }); return; }
  process.stderr.write('token=secret /private/path\n');
  let result;
  if (request.method === 'initialize') result = { userAgent: 'fake' };
  else if (!initialized) { send({ id: request.id, error: { code: -1 } }); return; }
  else if (request.method === 'account/read') {
    reads++;
    result = { account: { type: mode === 'api-key' ? 'apiKey' : 'chatgpt',
      email: mode === 'account-changed' && reads > 1 ? 'other@example.test' : 'private@example.test', planType: 'pro' } };
  } else if (request.method === 'account/rateLimits/read') {
    send({ method: 'account/rateLimits/updated', params: { private: 'ignored' } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'forbidden' } });
    result = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300 } } } };
  } else if (request.method === 'account/usage/read') {
    if (mode === 'old-cli') { send({ id: request.id, error: { code: -32601, message: 'secret' } }); return; }
    result = { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-09-15', tokens: 100 }] };
  }
  const output = JSON.stringify({ id: request.id, result }) + '\n';
  // Deliberately split messages across chunks.
  process.stdout.write(output.slice(0, 7));
  setTimeout(() => process.stdout.write(output.slice(7)), 2);
});
`;
const client = (mode = "ok", timeoutMs = 2000) => new AppServerClient({ command: process.execPath, args: ["-e", server, mode], timeoutMs });

test("reads account and usage over stdio, drops private fields, closes its child", async () => {
  const connection = client();
  const result = await readUsage({ client: connection });
  assert.equal(result.snapshot.windows[0].remainingPercent, 75);
  assert.equal(result.snapshot.activity.lifetimeTokens, 100);
  assert.equal(result.activityStatus, "received");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(connection.child.stdout.destroyed, true);
});

test("older CLI may omit optional activity without losing limits", async () => {
  const result = await readUsage({ client: client("old-cli") });
  assert.equal(result.activityStatus, "method-unavailable");
  assert.equal(result.snapshot.activity, null);
  assert.equal(result.snapshot.windows.length, 1);
  const skipped = await readUsage({ client: client(), includeActivity: false });
  assert.equal(skipped.activityStatus, "not-requested");
});

test("refuses account transitions and non-ChatGPT authentication", async () => {
  await assert.rejects(readUsage({ client: client("account-changed") }), { code: "account-changed" });
  await assert.rejects(readUsage({ client: client("api-key") }), { code: "chatgpt-auth-required" });
});

test("restricts outbound methods to the read-only allowlist", async () => {
  const connection = client();
  try {
    for (const method of ["account/login/start", "account/logout", "account/rateLimitResetCredit/consume", "turn/start"]) {
      await assert.rejects(connection.request(method, {}), { code: "method-not-allowed" });
    }
  } finally { await connection.close(); }
});

test("bounds malformed responses, timeouts, crashes and error output", async () => {
  for (const [mode, code] of [["malformed", "invalid-json"], ["oversized", "response-too-large"],
    ["timeout", "request-timeout"], ["exit", "transport-closed"], ["rpc-error", "rpc-failed"]]) {
    const connection = client(mode, mode === "timeout" ? 100 : 2000);
    await assert.rejects(readUsage({ client: connection }), { code });
    assert.equal(connection.pending.size, 0);
    assert.equal(connection.child.stdout.destroyed, true);
  }
});

test("missing CLI returns a safe launch error", async () => {
  await assert.rejects(readUsage({ client: new AppServerClient({ command: "/nonexistent/codex-usage-viewer-cli" }) }),
    { code: "launch-failed" });
});
