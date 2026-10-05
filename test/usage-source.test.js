const test = require("node:test");
const assert = require("node:assert/strict");
const { fromAppServer } = require("../usage-source.js");

const account = { account: { type: "chatgpt", email: "private@example.test", planType: "pro" } };
const make = (limits, activity) => fromAppServer({ account, limits, activity, observedAt: "2026-09-15T12:00:00Z" });
const window = { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1790000000 };

test("maps authoritative Codex buckets without restoring Spark or assuming slot duration", () => {
  const result = make({
    rateLimits: { primary: { ...window, usedPercent: 99 } },
    rateLimitsByLimitId: {
      "codex-spark": { primary: { ...window, usedPercent: 1 } },
      codex: { primary: window, secondary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null } }
    }
  });
  assert.deepEqual(result.windows.map((w) => [w.kind, w.remainingPercent]), [["weekly", 36], ["five-hour", 100]]);
  assert.equal(result.windows[0].resetsAt, "2026-09-21T14:13:20.000Z");
  assert.equal(result.windows[1].resetsAt, null);
  assert.equal(result.identity.historyEligible, false);
  assert.ok(!JSON.stringify(result).includes("private@example.test"));
});

test("missing Codex in an explicit map never falls back to another bucket", () => {
  assert.deepEqual(make({ rateLimitsByLimitId: {}, rateLimits: { primary: window } }).windows, []);
  assert.deepEqual(make({ rateLimits: { limitId: "codex-spark", primary: window } }).windows, []);
  assert.deepEqual(make({ rateLimits: null }).windows, []);
});

test("invalid usage stays unavailable, genuine zero and unknown duration remain meaningful", () => {
  for (const usedPercent of [null, undefined, "0", NaN, Infinity, -1, 101]) {
    assert.deepEqual(make({ rateLimits: { primary: { ...window, usedPercent } } }).windows, []);
  }
  assert.deepEqual(make({ rateLimits: { primary: { usedPercent: 100 } } }).windows, [{
    slot: "primary", kind: "other", durationMinutes: null, remainingPercent: 0, resetsAt: null
  }]);
});

test("retains precise credit strings, known zero and capped reset inventory semantics", () => {
  const result = make({
    rateLimits: { credits: { balance: "0.25", hasCredits: true, unlimited: false } },
    rateLimitResetCredits: { availableCount: 5, credits: [
      { id: "secret-id", status: "available", expiresAt: null },
      { status: "consumed", expiresAt: 1790000000 }
    ] }
  });
  assert.equal(result.credits.balance, "0.25");
  assert.equal(result.resetCredits.availableCount, 5);
  assert.deepEqual(result.resetCredits.expirations, [{ expiresAt: null }]);
  assert.ok(!JSON.stringify(result).includes("secret-id"));
  assert.deepEqual(make({ rateLimitResetCredits: { availableCount: 0, credits: [] } }).resetCredits,
    { availableCount: 0, expirations: [] });
  assert.deepEqual(make({ rateLimitResetCredits: { availableCount: 2, credits: null } }).resetCredits,
    { availableCount: 2, expirations: null });
  assert.equal(make({ rateLimits: { credits: { balance: "token=secret" } } }).credits.balance, null);
});

test("daily data preserves zero and gaps without fabricating coverage", () => {
  const result = make({}, { summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [
    { startDate: "2026-09-15", tokens: 0 }, { startDate: "2026-09-13", tokens: 1234 }
  ], threadUsage: { threadId: "private-thread", estimatedUsageUsdMicros: 1234 } });
  assert.deepEqual(result.activity.daily, [{ date: "2026-09-13", tokens: 1234 }, { date: "2026-09-15", tokens: 0 }]);
  assert.equal(result.activity.peakDailyTokens, null);
  assert.ok(!JSON.stringify(result).includes("private-thread"));
  for (const dailyUsageBuckets of [null, [{ startDate: "2026-02-30", tokens: 1 }],
    [{ startDate: "2026-09-15", tokens: -1 }], [{ startDate: "2026-09-15", tokens: null }],
    [{ startDate: "2026-09-15", tokens: 1 }, { startDate: "2026-09-15", tokens: 2 }]]) {
    assert.equal(make({}, { dailyUsageBuckets }).activity.daily, null);
  }
});

test("rejects unsupported authentication and malformed top-level data", () => {
  for (const value of [null, {}, { account: { type: "apiKey" } }]) {
    assert.throws(() => fromAppServer({ account: value, limits: {} }), /chatgpt-auth-required/);
  }
  assert.throws(() => make(null), /invalid-limits-response/);
  assert.throws(() => make({ rateLimitsByLimitId: [] }), /invalid-limits-response/);
});
