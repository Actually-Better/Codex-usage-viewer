(function initCapacityMonitor(globalScope) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enableNotifications: true,
    notifyOnReset: true,
    showRemainingPercentage: true,
    lowThreshold: 10,
    criticalThreshold: 5,
    enableSounds: false
  });
  const PREVENTIVE_THRESHOLD = 25;
  const COUNTER_STALE_AFTER_MS = 35 * 60 * 1000;
  const COUNTERS = Object.freeze([
    { key: "codexWeekly", label: "Weekly usage" },
    { key: "codex5h", label: "5-hour usage" },
    { key: "codexSparkWeekly", label: "GPT-5.3-Codex-Spark weekly usage" },
    { key: "codexSpark5h", label: "GPT-5.3-Codex-Spark 5-hour usage" }
  ]);
  const SEVERITY = Object.freeze({ normal: 0, preventive: 1, warning: 2, critical: 3, exhausted: 4 });
  const BADGE_COLORS = Object.freeze({
    green: "#15803d",
    amber: "#f59e0b",
    red: "#dc2626"
  });

  function normalizeSettings(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const lowThreshold = clampInteger(value.lowThreshold, 1, PREVENTIVE_THRESHOLD, DEFAULT_SETTINGS.lowThreshold);
    const criticalThreshold = clampInteger(value.criticalThreshold, 1, lowThreshold, Math.min(DEFAULT_SETTINGS.criticalThreshold, lowThreshold));
    return {
      enableNotifications: booleanSetting(value.enableNotifications, DEFAULT_SETTINGS.enableNotifications),
      notifyOnReset: booleanSetting(value.notifyOnReset, DEFAULT_SETTINGS.notifyOnReset),
      showRemainingPercentage: booleanSetting(value.showRemainingPercentage, DEFAULT_SETTINGS.showRemainingPercentage),
      lowThreshold,
      criticalThreshold,
      enableSounds: booleanSetting(value.enableSounds, DEFAULT_SETTINGS.enableSounds)
    };
  }

  function normalizeMonitorState(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const counters = {};
    for (const definition of COUNTERS) {
      const stored = value.counters && value.counters[definition.key];
      const remainingPercent = normalizePercent(stored && stored.remainingPercent);
      if (remainingPercent === null) continue;
      counters[definition.key] = {
        remainingPercent,
        resetText: cleanResetText(stored.resetText),
        lastSeenAt: typeof stored.lastSeenAt === "string" ? stored.lastSeenAt : null
      };
    }
    const availableKeys = Array.isArray(value.availableKeys)
      ? COUNTERS.map((definition) => definition.key)
        .filter((key) => value.availableKeys.includes(key) && counters[key])
      : [];
    return {
      version: 2,
      counters,
      availableKeys,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
    };
  }

  function extractAvailableCounters(snapshot) {
    const usage = snapshot && snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : {};
    return COUNTERS.flatMap((definition) => {
      const field = usage[definition.key];
      const remainingPercent = readRemainingPercent(field);
      if (remainingPercent === null) return [];
      return [{
        ...definition,
        remainingPercent,
        resetText: cleanResetText(field && field.structured && field.structured.resetText)
      }];
    });
  }

  function evaluateSnapshot(snapshot, previousState, rawSettings, now = new Date().toISOString()) {
    const settings = normalizeSettings(rawSettings);
    const previous = normalizeMonitorState(previousState);
    const available = extractAvailableCounters(snapshot);
    const counters = Object.fromEntries(
      Object.entries(previous.counters).filter(([, stored]) => isFreshObservation(stored, now))
    );
    const events = [];
    for (const counter of available) {
      const stored = counters[counter.key];
      if (stored) {
        const eventType = detectTransition(stored.remainingPercent, counter.remainingPercent, settings);
        if (eventType) events.push({ ...counter, type: eventType });
      }
      counters[counter.key] = {
        remainingPercent: counter.remainingPercent,
        resetText: counter.resetText,
        lastSeenAt: now
      };
    }
    const state = {
      version: 2,
      counters,
      availableKeys: available.map((counter) => counter.key),
      updatedAt: now
    };
    return { available, events, settings, state, visual: deriveVisualState(available, settings) };
  }

  function extractFreshStateCounters(rawState, now = new Date().toISOString()) {
    const state = normalizeMonitorState(rawState);
    return COUNTERS.flatMap((definition) => {
      const stored = state.counters[definition.key];
      if (!state.availableKeys.includes(definition.key) || !stored || !isFreshObservation(stored, now)) return [];
      return [{ ...definition, ...stored }];
    });
  }

  function isFreshObservation(stored, now) {
    const lastSeenAt = Date.parse(stored && stored.lastSeenAt);
    const currentTime = Date.parse(now);
    return Number.isFinite(lastSeenAt)
      && Number.isFinite(currentTime)
      && currentTime >= lastSeenAt
      && currentTime - lastSeenAt <= COUNTER_STALE_AFTER_MS;
  }

  function detectTransition(previous, current, settings) {
    if (current === 100 && previous < 100) return "reset";
    if (current >= previous) return null;
    if (current === 0 && previous > 0) return "exhausted";
    if (current <= settings.criticalThreshold && previous > settings.criticalThreshold) return "critical";
    if (current <= settings.lowThreshold && previous > settings.lowThreshold) return "low";
    if (current <= PREVENTIVE_THRESHOLD && previous > PREVENTIVE_THRESHOLD) return "preventive";
    return null;
  }

  function deriveVisualState(availableCounters, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const available = Array.isArray(availableCounters)
      ? availableCounters.filter((counter) => normalizePercent(counter && counter.remainingPercent) !== null)
      : [];
    if (!available.length) {
      const badgeColor = BADGE_COLORS.green;
      return {
        badgeText: "",
        badgeColor,
        badgeTextColor: getContrastingTextColor(badgeColor),
        counter: null,
        state: "normal",
        title: "Codex Usage Viewer — usage unavailable"
      };
    }
    const worst = available.reduce((selected, candidate) => (
      candidate.remainingPercent < selected.remainingPercent ? candidate : selected
    ));
    const state = classifyRemaining(worst.remainingPercent, settings);
    const badgeLevel = classifyUsageLevel(worst.remainingPercent);
    const badgeColor = BADGE_COLORS[badgeLevel];
    const showTemporaryWarning = SEVERITY[state] >= SEVERITY.warning;
    return {
      badgeText: settings.showRemainingPercentage || showTemporaryWarning
        ? String(Math.round(worst.remainingPercent))
        : "",
      badgeColor,
      badgeTextColor: getContrastingTextColor(badgeColor),
      counter: worst,
      state,
      title: `Codex Usage Viewer — ${worst.label}: ${worst.remainingPercent}% remaining`
    };
  }

  function classifyRemaining(remainingPercent, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const value = normalizePercent(remainingPercent);
    if (value === null) return "normal";
    if (value === 0) return "exhausted";
    if (value <= settings.criticalThreshold) return "critical";
    if (value <= settings.lowThreshold) return "warning";
    if (value <= PREVENTIVE_THRESHOLD) return "preventive";
    return "normal";
  }

  function classifyUsageLevel(remainingPercent) {
    const value = normalizePercent(remainingPercent);
    if (value === null) return "green";
    if (value < 15) return "red";
    if (value <= 50) return "amber";
    return "green";
  }

  function getContrastingTextColor(backgroundColor) {
    const backgroundLuminance = relativeLuminance(backgroundColor);
    const whiteContrast = contrastRatio(backgroundLuminance, 1);
    const blackContrast = contrastRatio(backgroundLuminance, 0);
    return whiteContrast >= blackContrast ? "#ffffff" : "#000000";
  }

  function relativeLuminance(color) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color));
    if (!match) return 0;
    const channels = match[1].match(/.{2}/g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(firstLuminance, secondLuminance) {
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function buildNotification(event) {
    const resetSuffix = event.resetText ? ` Reset: ${event.resetText}.` : "";
    if (event.type === "reset") {
      return {
        title: `${event.label} reset`,
        message: `${event.label} reset to 100% remaining.${resetSuffix}`
      };
    }
    if (event.type === "exhausted") {
      return { title: `${event.label} exhausted`, message: `0% remaining.${resetSuffix}` };
    }
    if (event.type === "critical") {
      return {
        title: `${event.label} is critically low`,
        message: `${event.remainingPercent}% remaining.${resetSuffix}`
      };
    }
    return { title: `${event.label} is low`, message: `${event.remainingPercent}% remaining.${resetSuffix}` };
  }

  function shouldNotify(event, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    if (!settings.enableNotifications || !event) return false;
    if (event.type === "reset") return settings.notifyOnReset;
    return event.type === "low" || event.type === "critical" || event.type === "exhausted";
  }

  function shouldPlaySound(event, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    return Boolean(settings.enableSounds && event && (
      event.type === "low" || event.type === "critical" || event.type === "exhausted"
    ));
  }

  function readRemainingPercent(field) {
    const structuredValue = field && field.structured && field.structured.remainingPercent;
    const structuredPercent = normalizePercent(structuredValue);
    if (structuredPercent !== null) return structuredPercent;
    const match = String(field && field.value ? field.value : "").match(/(\d{1,3})\s*%/);
    return match ? normalizePercent(Number(match[1])) : null;
  }

  function normalizePercent(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : null;
  }

  function cleanResetText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 100) : null;
  }

  function clampInteger(value, min, max, fallback) {
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      return fallback;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function booleanSetting(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  const api = {
    BADGE_COLORS,
    COUNTER_STALE_AFTER_MS,
    COUNTERS,
    DEFAULT_SETTINGS,
    PREVENTIVE_THRESHOLD,
    buildNotification,
    classifyRemaining,
    classifyUsageLevel,
    deriveVisualState,
    detectTransition,
    evaluateSnapshot,
    extractAvailableCounters,
    extractFreshStateCounters,
    normalizeMonitorState,
    normalizeSettings,
    shouldNotify,
    shouldPlaySound
  };

  globalScope.CodexCapacityMonitor = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { CodexCapacityMonitor: api };
  }
})(typeof self !== "undefined" ? self : globalThis);
