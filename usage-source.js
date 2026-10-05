(function initUsageSource(scope) {
  "use strict";

  const number = (value) => typeof value === "number" && Number.isFinite(value);
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);

  function timestamp(seconds) {
    if (!number(seconds) || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function windowFromRpc(value, slot) {
    if (!record(value) || !number(value.usedPercent)
      || value.usedPercent < 0 || value.usedPercent > 100) return null;
    const durationMinutes = count(value.windowDurationMins);
    return {
      slot,
      kind: durationMinutes === 300 ? "five-hour" : durationMinutes === 10080 ? "weekly" : "other",
      durationMinutes: durationMinutes > 0 ? durationMinutes : null,
      remainingPercent: 100 - value.usedPercent,
      resetsAt: timestamp(value.resetsAt)
    };
  }

  function creditsFromRpc(value) {
    if (!record(value)) return null;
    const raw = value.balance;
    const balance = typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw)
      && Number.isFinite(Number(raw)) ? raw : null;
    return {
      balance,
      unlimited: typeof value.unlimited === "boolean" ? value.unlimited : null,
      hasCredits: typeof value.hasCredits === "boolean" ? value.hasCredits : null
    };
  }

  function resetsFromRpc(value) {
    if (!record(value)) return null;
    return {
      availableCount: count(value.availableCount),
      // Details can be capped by the server. Never derive the count from this list.
      expirations: Array.isArray(value.credits)
        ? value.credits.filter((credit) => record(credit) && credit.status === "available")
          .map((credit) => ({ expiresAt: timestamp(credit.expiresAt) }))
        : null
    };
  }

  function activityFromRpc(value) {
    if (!record(value)) return null;
    const summary = record(value.summary) ? value.summary : {};
    const buckets = value.dailyUsageBuckets;
    // A malformed or duplicate day makes coverage uncertain; do not publish partial totals.
    const validDay = (day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)
      && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
    const valid = Array.isArray(buckets) && buckets.every((row) => record(row)
      && validDay(row.startDate) && count(row.tokens) !== null)
      && new Set(buckets.map((row) => row.startDate)).size === buckets.length;
    return {
      lifetimeTokens: count(summary.lifetimeTokens),
      peakDailyTokens: count(summary.peakDailyTokens),
      daily: valid ? buckets.map((row) => ({ date: row.startDate, tokens: row.tokens }))
        .sort((a, b) => a.date.localeCompare(b.date)) : null
    };
  }

  function fromAppServer({ account, limits, activity = null, observedAt = new Date().toISOString() }) {
    if (!record(account) || account.account?.type !== "chatgpt") throw new Error("chatgpt-auth-required");
    if (!record(limits)) throw new Error("invalid-limits-response");
    if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) throw new Error("invalid-observation-time");
    const buckets = limits.rateLimitsByLimitId;
    if (buckets != null && !record(buckets)) throw new Error("invalid-limits-response");
    // An explicit multi-bucket result is authoritative, even when Codex is missing.
    // Never turn a Spark or other model bucket into the general Codex allowance.
    const selected = buckets != null
      ? (Object.hasOwn(buckets, "codex") ? buckets.codex : null)
      : limits.rateLimits;
    const bucket = record(selected) && (selected.limitId == null || selected.limitId === "codex")
      ? selected : null;
    return {
      schemaVersion: 1,
      source: "app-server",
      observedAt,
      // account/read currently cannot prove workspace identity. Do not persist this
      // snapshot as account-scoped history or feed it into cross-reading alerts yet.
      identity: { scope: "unverified", historyEligible: false },
      windows: bucket ? [windowFromRpc(bucket.primary, "primary"), windowFromRpc(bucket.secondary, "secondary")]
        .filter(Boolean) : [],
      credits: creditsFromRpc(bucket?.credits),
      resetCredits: resetsFromRpc(limits.rateLimitResetCredits),
      activity: activityFromRpc(activity)
    };
  }

  const api = Object.freeze({ fromAppServer });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else scope.CodexUsageSource = api;
})(globalThis);
