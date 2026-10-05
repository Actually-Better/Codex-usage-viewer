"use strict";

const { readUsage } = require("../native/app-server-client.cjs");

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: npm run probe:app-server -- [--skip-activity]\nReads usage through the existing Codex ChatGPT session. No login or reset actions.\nRequires codex on PATH. Outputs metrics without account identifiers; does not persist them.");
    return;
  }
  if (args.some((arg) => arg !== "--skip-activity") || args.length > 1) {
    console.log(JSON.stringify({ ok: false, error: "invalid-arguments" }));
    process.exitCode = 1;
    return;
  }
  try {
    const result = await readUsage({ includeActivity: !args.includes("--skip-activity") });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const allowed = new Set(["chatgpt-auth-required", "invalid-limits-response", "launch-failed", "transport-closed",
      "request-timeout", "response-too-large", "invalid-json", "invalid-response", "method-unavailable", "rpc-failed", "account-changed"]);
    console.log(JSON.stringify({ ok: false, error: allowed.has(error.code || error.message) ? error.code || error.message : "probe-failed" }));
    process.exitCode = 1;
  }
}

main();
