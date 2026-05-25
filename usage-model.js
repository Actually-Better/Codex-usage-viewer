(function initUsageModel(globalScope) {
  "use strict";

  const CONFIG = {
    storageKeys: {
      state: "chatgptUsageMonitor.state",
      counters: "chatgptUsageMonitor.counters"
    },
    refreshAlarmName: "chatgpt-usage-monitor-refresh",
    refreshPeriodMinutes: 15,
    limits: {
      gpt55ShortWindow: {
        label: "GPT-5.5 short window",
        maxMessages: null,
        windowsHours: [3, 5]
      },
      gpt55ThinkingWeekly: {
        label: "GPT-5.5 Thinking weekly",
        maxMessages: null,
        windowDays: 7
      },
      codexCredits: {
        label: "Codex / Credits",
        maxCredits: null,
        windowsHours: [5],
        windowDays: 7
      }
    },
    counterRetentionDays: 14
  };

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  function nowIso(now = Date.now()) {
    return new Date(now).toISOString();
  }

  function formatTime(value) {
    if (!value) return "Unavailable";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function defaultCounters(now = Date.now()) {
    return normalizeCounters({
      installed_at: nowIso(now),
      tracking_started_at: null,
      localTrackingActive: false,
      events: [],
      manual_remaining: null,
      manual_remaining_source: null,
      manual_remaining_updated_at: null,
      limit_reached_at: null
    }, now);
  }

  function normalizeCounters(rawCounters, now = Date.now()) {
    const base = rawCounters && typeof rawCounters === "object" ? rawCounters : {};
    const installedAt = parseTimestamp(base.installed_at) || now;
    const minTime = Math.max(
      installedAt,
      now - CONFIG.counterRetentionDays * ONE_DAY_MS
    );
    const events = Array.isArray(base.events)
      ? base.events
          .filter((event) => event && typeof event.ts === "number" && event.ts >= minTime)
          .map((event) => ({
            ts: event.ts,
            kind: event.kind === "codex" ? "codex" : "message",
            source: "local"
          }))
          .sort((a, b) => a.ts - b.ts)
      : [];

    const messageEvents = events.filter((event) => event.kind === "message");
    const codexEvents = events.filter((event) => event.kind === "codex");
    const messages3h = rollingWindow(messageEvents, 3 * ONE_HOUR_MS, now);
    const messages5h = rollingWindow(messageEvents, 5 * ONE_HOUR_MS, now);
    const messagesWeekly = rollingWindow(messageEvents, 7 * ONE_DAY_MS, now);
    const codex5h = rollingWindow(codexEvents, 5 * ONE_HOUR_MS, now);
    const codexWeekly = rollingWindow(codexEvents, 7 * ONE_DAY_MS, now);
    const lastMessage = events.length ? events[events.length - 1].ts : null;
    const trackingStartedAt = parseTimestamp(base.tracking_started_at);
    const localTrackingActive = Boolean(base.localTrackingActive || trackingStartedAt || events.length);

    return {
      installed_at: nowIso(installedAt),
      tracking_started_at: trackingStartedAt ? nowIso(trackingStartedAt) : null,
      localTrackingActive,
      events,
      messages_3h: localTrackingActive ? messages3h.count : null,
      messages_5h: localTrackingActive ? messages5h.count : null,
      messages_weekly: localTrackingActive ? messagesWeekly.count : null,
      codex_5h: localTrackingActive ? codex5h.count : null,
      codex_weekly: localTrackingActive ? codexWeekly.count : null,
      last_message_timestamp: lastMessage ? nowIso(lastMessage) : null,
      rolling_window_reset_estimates: {
        messages_3h: messages3h.resetAt ? nowIso(messages3h.resetAt) : null,
        messages_5h: messages5h.resetAt ? nowIso(messages5h.resetAt) : null,
        messages_weekly: messagesWeekly.resetAt ? nowIso(messagesWeekly.resetAt) : null,
        codex_5h: codex5h.resetAt ? nowIso(codex5h.resetAt) : null,
        codex_weekly: codexWeekly.resetAt ? nowIso(codexWeekly.resetAt) : null
      },
      manual_remaining: normalizeManualRemaining(base.manual_remaining),
      manual_remaining_source: base.manual_remaining_source || null,
      manual_remaining_updated_at: base.manual_remaining_updated_at || null,
      limit_reached_at: base.limit_reached_at || null
    };
  }

  function addLocalMessage(counters, payload = {}, now = Date.now()) {
    const current = normalizeCounters(counters, now);
    const kind = classifyPageKind(payload.pageKind, payload.modelLabel);
    return normalizeCounters({
      ...current,
      tracking_started_at: current.tracking_started_at || nowIso(now),
      localTrackingActive: true,
      events: [
        ...current.events,
        {
          ts: now,
          kind,
          source: "local"
        }
      ]
    }, now);
  }

  function resetLocalCounters(counters, now = Date.now()) {
    const current = normalizeCounters(counters, now);
    return normalizeCounters({
      ...current,
      tracking_started_at: nowIso(now),
      localTrackingActive: true,
      events: []
    }, now);
  }

  function setManualRemaining(counters, value, now = Date.now()) {
    const current = normalizeCounters(counters, now);
    return normalizeCounters({
      ...current,
      manual_remaining: normalizeManualRemaining(value),
      manual_remaining_source: "user-entered",
      manual_remaining_updated_at: nowIso(now),
      limit_reached_at: null
    }, now);
  }

  function markLimitReached(counters, now = Date.now()) {
    const current = normalizeCounters(counters, now);
    return normalizeCounters({
      ...current,
      manual_remaining: 0,
      manual_remaining_source: "user-entered",
      manual_remaining_updated_at: nowIso(now),
      limit_reached_at: nowIso(now)
    }, now);
  }

  function buildEstimate(counters, now = Date.now()) {
    return normalizeCounters(counters, now);
  }

  function rollingWindow(items, windowMs, now = Date.now()) {
    const start = now - windowMs;
    const inWindow = (items || []).filter((item) => item.ts >= start && item.ts <= now);
    const oldest = inWindow.length > 0 ? inWindow[0].ts : null;
    return {
      count: inWindow.length,
      resetAt: oldest ? oldest + windowMs : null
    };
  }

  function classifyPageKind(pageKind, label) {
    const normalized = `${pageKind || ""} ${label || ""}`.toLowerCase();
    if (normalized.includes("codex")) return "codex";
    return "message";
  }

  function parseTimestamp(value) {
    if (!value) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function normalizeManualRemaining(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return Math.floor(number);
  }

  function hasVisibleUsage(snapshot) {
    if (!snapshot || !snapshot.usage) return false;
    return Object.values(snapshot.usage).some((field) => field && field.value);
  }

  function summarizeAvailability(snapshot) {
    if (!snapshot || snapshot.status !== "ok") return "ChatGPT tab unavailable";
    if (snapshot.loginStatus === "logged-out") return "Not logged in";
    if (snapshot.loginStatus === "unknown") return "Login status unavailable";
    return "Ready";
  }

  globalScope.ChatGPTUsageConfig = CONFIG;
  globalScope.ChatGPTUsageModel = {
    addLocalMessage,
    buildEstimate,
    defaultCounters,
    formatTime,
    hasVisibleUsage,
    markLimitReached,
    normalizeCounters,
    resetLocalCounters,
    setManualRemaining,
    summarizeAvailability
  };
})(typeof self !== "undefined" ? self : window);
