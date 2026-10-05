# App Server migration — first increment

Date: 2026-09-15. Baseline: extension 0.3.4, commit `4beb41b`.

## Implemented

- `usage-source.js`: browser-compatible, pure normalization of App Server data into a versioned source contract. It is not loaded by the popup yet.
- `native/app-server-client.cjs`: bounded JSON-lines RPC client using an owned Codex child process, with a read-method allowlist, safe errors and process cleanup.
- `npm run probe:app-server`: explicitly reads through the existing Codex ChatGPT login. Requires Node.js 18+ and `codex` on PATH. `--skip-activity` omits token activity. `--help` makes no connection.
- No new dependencies, browser permissions, credential files, login actions, or automatic startup jobs.

The probe uses `initialize`, `initialized`, `account/read` (without proactive refresh), `account/rateLimits/read`, and optionally `account/usage/read`. Codex owns authentication and may renew its own credentials as needed for service requests. The probe never opens credential files, forwards tokens, starts turns, sends email, or consumes reset credits. Server requests are refused and notifications are ignored in this first increment. Each RPC has a 10-second deadline; the finite sequence is at most five requests. Only the process started by the probe is terminated.

Run from the checkout:

```sh
npm run probe:app-server -- --help
npm run probe:app-server
npm run probe:app-server -- --skip-activity
```

The output contains usage amounts but no account email, workspace identifier, reset-credit identifier, paths, raw RPC errors, or stderr. It is not written to extension storage. Treat your usage amounts as personal data if sharing a report.

## Contract and identity boundary

The contract contains `schemaVersion`, `source`, `observedAt`, `identity`, `windows`, `credits`, `resetCredits`, and `activity`.

- Prefer `rateLimitsByLimitId.codex`. An explicit map without Codex does not fall back to a legacy or model-specific bucket. Spark is excluded.
- Window duration determines its kind; `primary` does not imply five hours. Missing/invalid percentages stay absent, not zero. Unknown deadlines stay null.
- Preserve decimal credit balances as strings. Reset count is authoritative even when the expiry detail list is capped or unavailable.
- Daily activity preserves missing coverage. Do not fill missing days with zeros, silently discard malformed days, or invent historical costs from token totals.
- `account/read` cannot prove workspace identity in the locally inspected protocol. A before/after email and plan check catches some account changes but cannot catch same-email workspace changes or a change-and-return race. The contract therefore marks **all probe results as unverified and ineligible for account history**. No persistent identity key is inferred from email.
- Account-wide activity and optional per-thread estimates are different requests: `account/usage/read` accepts `threadId` for the latter. This probe deliberately requests only account-wide activity and does not enumerate conversations.
- No production alerts, merging with Analytics, persisted history, or cost claims are enabled from this source yet.

## Remaining sequence

1. Validate a live read and parity with Analytics for the same account/workspace, including timestamps, latency, token coverage, credit semantics and recovery after suspension. Record sanitized evidence only.
2. Prove identity binding before adding account history. If the protocol cannot supply it, keep explicit source isolation and block cross-account aggregation.
3. Implement a Native Messaging host with a narrow command contract, protocol negotiation and output-size limits; validate Windows Chrome/Edge → Windows launcher → WSL Codex. Do not expose arbitrary RPC or shell commands to the extension. Test install/uninstall, missing WSL, browser shutdown and child cleanup.
4. Add an Analytics adapter, explicit source selection, migrations and source-specific caches. Retain Analytics until browser integration is verified; do not silently fall back across identities.
5. Add reserve/deficit, reset-expiry alerts, capacity history, daily token charts, adaptive refresh and provider status.
6. Verify per-thread estimate availability and coverage before implementing costs; only introduce an incremental local scanner if necessary. Then expand accounts, localization and dashboard extras.

## First validation result

On 2026-09-15, the live probe against the installed WSL `codex-cli 0.149.1` completed successfully in 3,272 ms. It returned one general weekly window with a reset timestamp, credit data, an available-reset count with expiry details, lifetime token activity, and 149 daily buckets. No five-hour window was returned; none was fabricated. This confirms remote account activity can be read without a local conversation scan.

Only capability flags and row counts were retained for this report. Account emails, credit amounts, usage percentages and token amounts were not saved. No browser comparison or Windows Native Messaging test has been performed yet. The account/workspace binding remains unverified; the snapshot remains ineligible for persistent history.

Validation: `npm run check`, `npm test` (197 passing), matching manifest/package version 0.4.0, and `git diff --check`. New tests cover RPC framing, unsolicited requests, safe errors, size/time bounds, child cleanup, authentication changes, sparse quotas, retired-model exclusion and incomplete activity data.

## Consolidation validation — 2026-10-05

The 0.4.0 implementation is now integrated into the main extension checkout at version 0.4.1 alongside the updated web reader. The popup reads `https://chatgpt.com/settings/usage?tab=overview`; the App Server probe remains an explicit command-line diagnostic.

Validation against installed `codex-cli 0.160.0` completed in 3,546 ms: a weekly window, credit data, reset inventory, and 169 daily activity buckets were returned. Only capabilities and row counts were recorded. Account/workspace identity remains unverified, so App Server snapshots are still ineligible for persistent account history or production alerts.

The combined suite passes 206 tests, `npm run check`, the probe's `--help` path, and `git diff --check`; manifest and package versions match at 0.4.1. Windows Native Messaging and parity with the signed-in browser remain unverified.

## Verification sources

- Official App Server documentation: https://learn.chatgpt.com/docs/app-server
- Official authentication documentation: https://learn.chatgpt.com/docs/auth
- Chrome Native Messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- CodexBar v0.60.2 source design: https://github.com/steipete/CodexBar/blob/v0.60.2/docs/codex.md
- Local `codex-cli 0.149.1` generated schema: `ClientRequest`, `GetAccountResponse`, `GetAccountRateLimitsResponse`, `GetAccountTokenUsageResponse`.

No claim of native-browser integration or full account parity follows from a successful command-line probe.
