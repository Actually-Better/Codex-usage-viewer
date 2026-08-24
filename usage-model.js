(function initUsageModel(globalScope) {
  "use strict";

  const CONFIG = {
    storageKeys: {
      state: "chatgptUsageMonitor.state",
      counters: "chatgptUsageMonitor.counters",
      compactMode: "chatgptUsageMonitor.compactMode",
      retainedSignInTab: "chatgptUsageMonitor.retainedSignInTab"
    },
    refreshAlarmName: "chatgpt-usage-monitor-refresh",
    refreshPeriodMinutes: 15,
    counterRetentionDays: 14
  };

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;
  const CODEX_FIELD_KEYS = [
    "codex5h",
    "codexWeekly",
    "codexSpark5h",
    "codexSparkWeekly",
    "codexCredits",
    "remainingCredits",
    "bankedResets"
  ];
  const TERMS = {
    usage: ["usage", "use", "uso"],
    remaining: ["remaining", "left", "available", "restante", "restantes", "queda", "quedan", "disponible", "disponibles"],
    reset: ["reset", "resets", "renew", "renews", "refresh", "refreshes", "reinicia", "reinicio", "renueva", "recarga"],
    credits: ["credit", "credits", "credit balance", "credito", "creditos", "saldo"],
    weekly: ["weekly", "week", "semanal", "semana"],
    hours5: ["5h", "5 h", "5-hour", "5 hour", "5 hours", "five hour", "five-hour", "5 horas", "5 hora"],
    bankedResets: ["banked reset", "banked resets", "saved reset", "saved resets", "full reset", "full resets", "restablecimiento completo", "restablecimientos completos", "reinicio acumulado", "reinicios acumulados", "reinicio guardado", "reinicios guardados"],
    expiry: ["expires", "expire", "expiration", "expiry", "valid until", "vence", "vencen", "vencimiento", "caduca", "caducan"]
  };
  const CONCEPT_PATTERNS = buildConceptPatterns(TERMS);

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

  function formatRelativeTime(value, now = Date.now()) {
    const timestamp = parseTimestamp(value);
    if (!timestamp) return "unavailable";
    const elapsedMs = Math.max(0, now - timestamp);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
    if (elapsedMinutes < 1) return "just now";
    if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours} h ago`;
    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) return `${elapsedDays} d ago`;
    return formatTime(timestamp);
  }

  function defaultCounters(now = Date.now()) {
    return normalizeCounters({
      installed_at: nowIso(now),
      tracking_started_at: null,
      localTrackingActive: false,
      events: []
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
      }
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

  function hasVisibleUsage(snapshot) {
    if (!snapshot || !snapshot.usage) return false;
    return Object.values(snapshot.usage).some((field) => field && field.value);
  }

  function parseCodexUsageText(text) {
    const normalized = normalizeVisibleText(text);
    const fields = {};

    for (const key of CODEX_FIELD_KEYS) {
      fields[key] = unavailableField();
    }

    if (!normalized) return fields;

    for (const match of collectPercentWindows(normalized)) {
      const key = classifyCodexPercentWindow(match);
      if (!key || fields[key].value) continue;
      fields[key] = visibleField(formatPercentValue(key, match.percent, match.resetText), {
        label: labelForMetricKey(key),
        remainingPercent: match.percent,
        resetText: match.resetText,
        confidence: match.confidence,
        resetConfidence: match.resetText ? match.resetConfidence : null
      }, match.confidence);
    }

    const credits = extractCredits(normalized);
    if (credits) {
      const field = visibleField(`Credits remaining: ${credits.value}`, {
        label: "Credits",
        remainingCredits: credits.value,
        confidence: credits.confidence
      }, credits.confidence);
      fields.codexCredits = field;
      fields.remainingCredits = field;
    }

    const bankedResets = extractBankedResets(normalized);
    if (bankedResets) {
      fields.bankedResets = visibleField(formatBankedResetsValue(bankedResets), {
        label: bankedResets.label,
        bankedResetCount: bankedResets.count,
        countSource: bankedResets.countSource,
        expiresText: bankedResets.expiresText,
        confidence: bankedResets.confidence,
        expiryConfidence: bankedResets.expiresText ? bankedResets.expiryConfidence : null
      }, bankedResets.confidence);
    }

    return fields;
  }

  function normalizeMetricField(field, fallbackTitle) {
    const structured = field && field.structured ? field.structured : {};
    const value = String(field && field.value ? field.value : "");
    const parsed = parseMetricText(value, fallbackTitle);
    const resetContext = normalizeForMatch(structured.resetText || "");
    const structuredLooksContaminated = structured.resetText
      && (hasAnyConcept(resetContext, ["usage", "credits", "reset"]) || containsTerm(resetContext, "settings") || containsTerm(resetContext, "configuracion"));
    const shouldPreferParsed = parsed && (
      String(fallbackTitle || "").toLowerCase().includes("codex-spark")
      || structuredLooksContaminated
      || typeof structured.remainingPercent !== "number"
    );

    if (shouldPreferParsed) return parsed;

    if (typeof structured.remainingPercent === "number"
      || typeof structured.remainingCredits === "number"
      || typeof structured.bankedResetCount === "number") {
      return structured;
    }

    if (parsed) return parsed;
    return {
      label: fallbackTitle
    };
  }

  function getUsageLevel(remainingPercent) {
    if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) return null;
    if (remainingPercent < 15) return "red";
    if (remainingPercent <= 50) return "amber";
    return "green";
  }

  function summarizeAvailability(snapshot) {
    if (!snapshot || snapshot.status !== "ok") return "Open ChatGPT to refresh";
    if (snapshot.loginStatus === "logged-out") return "Sign in required";
    if (hasVisibleUsage(snapshot)) return "Usage visible";
    if (snapshot.loginStatus === "unknown") return "Usage unavailable";
    return "Ready";
  }

  function collectPercentWindows(text) {
    if (text.includes("\n")) {
      return collectLinePercentWindows(text);
    }

    const matches = [];
    const pattern = /(\d{1,3})\s*%|([a-záéíóúñ -]{1,28})\s+(\d{1,3})\s*%/gi;
    let match = pattern.exec(text);
    while (match) {
      const percent = Number(match[1] || match[3]);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
        const start = Math.max(0, match.index - 120);
        const end = Math.min(text.length, pattern.lastIndex);
        const resetEnd = Math.min(text.length, pattern.lastIndex + 140);
        const window = text.slice(start, end);
        matches.push({
          percent,
          window,
          confidence: scorePercentConfidence(match[0], window),
          resetText: extractResetText(text.slice(match.index, resetEnd)),
          resetConfidence: "medium"
        });
      }
      match = pattern.exec(text);
    }
    return matches;
  }

  function collectLinePercentWindows(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const percentMatch = extractPercent(lines[index]);
      const percent = percentMatch && percentMatch.percent;
      if (typeof percent !== "number") continue;
      const start = Math.max(0, index - 3);
      const end = Math.min(lines.length, index + 4);
      const window = lines.slice(start, index + 1).join("\n");
      const confidenceWindow = lines.slice(start, end).join("\n");
      const resetText = extractResetText(lines.slice(index, end).join(" "));
      matches.push({
        percent,
        line: lines[index],
        window,
        confidence: scorePercentConfidence(lines[index], confidenceWindow),
        resetText,
        resetConfidence: resetText ? "medium" : null
      });
    }
    return matches;
  }

  function extractPercent(value) {
    const match = String(value || "").match(/(\d{1,3})\s*%/);
    if (!match) return null;
    const percent = Number(match[1]);
    return Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? { percent, confidence: scorePercentConfidence(value, value) }
      : null;
  }

  function classifyCodexPercentWindow(match) {
    const normalized = normalizeForMatch(match.window);
    if (!hasAnyConcept(normalized, ["usage", "remaining"]) && !containsTerm(normalized, "codex")) return null;

    const hasSpark = containsTerm(normalized, "spark");
    const fiveHourIndex = lastConceptIndex(normalized, "hours5");
    const weeklyIndex = lastConceptIndex(normalized, "weekly");
    const hasFiveHour = fiveHourIndex >= 0;
    const hasWeekly = weeklyIndex >= 0;
    const fiveHourIsClosest = hasFiveHour && (!hasWeekly || fiveHourIndex > weeklyIndex);
    const weeklyIsClosest = hasWeekly && (!hasFiveHour || weeklyIndex > fiveHourIndex);

    if (hasSpark && fiveHourIsClosest) return "codexSpark5h";
    if (hasSpark && weeklyIsClosest) return "codexSparkWeekly";
    if (!hasSpark && fiveHourIsClosest) return "codex5h";
    if (!hasSpark && weeklyIsClosest) return "codexWeekly";
    return null;
  }

  function lastRegexIndex(value, pattern) {
    let lastIndex = -1;
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      lastIndex = match.index;
      match = pattern.exec(value);
    }
    return lastIndex;
  }

  function lastConceptIndex(value, concept) {
    return Math.max(...CONCEPT_PATTERNS[concept].map((pattern) => lastRegexIndex(value, pattern)));
  }

  function extractCredits(text) {
    const lines = text.includes("\n")
      ? text.split("\n").map((line) => line.trim()).filter(Boolean)
      : text.split(/(?=\b(?:credits?|credit balance|cr[eé]ditos?|saldo)\b)|(?<=\d)\s+/i).map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const currentLine = lines[index];
      const currentNormalized = normalizeForMatch(currentLine);
      if (!hasConcept(currentNormalized, "credits")) continue;
      const window = lines.slice(index, Math.min(lines.length, index + 2)).join(" ");
      const normalized = normalizeForMatch(window);
      const numberMatch = window.match(/\b(\d{1,9})\b/);
      if (!numberMatch) continue;
      const value = Number(numberMatch[1]);
      if (!Number.isFinite(value) || value < 0) continue;
      return {
        value: Math.floor(value),
        confidence: hasConcept(normalized, "remaining") ? "high" : "low"
      };
    }
    return null;
  }

  function extractBankedResets(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const visibleCardCount = countBankedResetCards(text);

    for (let index = 0; index < lines.length; index += 1) {
      const currentNormalized = normalizeForMatch(lines[index]);
      if (!hasConcept(currentNormalized, "bankedResets")) continue;

      const labelTail = extractBankedResetLabelTail(lines[index]);
      const countWindow = [labelTail, ...lines.slice(index + 1, Math.min(lines.length, index + 3))];
      const explicitCount = extractBankedResetCount(countWindow);
      const expiryWindow = [labelTail, ...lines.slice(index + 1, Math.min(lines.length, index + 6))];
      const expiresText = extractExpiryText(expiryWindow);
      const count = explicitCount === null && expiresText && visibleCardCount > 0
        ? visibleCardCount
        : explicitCount;

      if (count === null && !expiresText) continue;
      return {
        label: /restablecimientos? completos?/i.test(lines[index])
          ? "Restablecimiento completo"
          : "Banked resets",
        count,
        countSource: explicitCount === null && count !== null ? "visible-card-count" : "explicit-number",
        expiresText,
        confidence: explicitCount !== null ? "high" : "medium",
        expiryConfidence: expiresText ? "high" : null
      };
    }

    return null;
  }

  function countBankedResetCards(text) {
    const matches = normalizeVisibleText(text).match(/\bbanked reset\b(?!s)|\bfull reset\b(?!s)|\brestablecimiento completo\b/gi);
    return matches ? matches.length : 0;
  }

  function extractBankedResetLabelTail(value) {
    const match = String(value || "").match(/(?:banked resets?|saved resets?|full resets?|restablecimientos? completos?|reinicios? (?:acumulados?|guardados?))[\s\S]*$/i);
    return match ? match[0] : String(value || "");
  }

  function extractBankedResetCount(lines) {
    for (let index = 0; index < lines.length; index += 1) {
      const beforeExpiry = String(lines[index] || "").split(/\b(?:expires?|expiration|expiry|valid until|vence(?:n)?|vencimiento|caduca(?:n)?)\b/i)[0];
      const match = index === 0
        ? beforeExpiry.match(/\b(\d{1,3})\b/)
        : beforeExpiry.match(/^\s*(?:count|cantidad|available|disponibles?)?\s*[:\-]?\s*(\d{1,3})\s*(?:available|disponibles?)?\s*$/i);
      if (!match) continue;
      const count = Number(match[1]);
      if (Number.isFinite(count) && count >= 0) return count;
    }
    return null;
  }

  function extractExpiryText(lines) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalized = normalizeForMatch(line);
      if (!hasConcept(normalized, "expiry")) continue;

      const match = line.match(/(?:expires?|expiration|expiry|valid until|vence(?:n)?|vencimiento|caduca(?:n)?)(?:\s+(?:at|on|el|a las|en))?\s*[:\-]?\s*(.*)$/i);
      const inlineValue = match && match[1] ? match[1].trim() : "";
      const value = inlineValue || String(lines[index + 1] || "").trim();
      return cleanExpiryText(value);
    }
    return null;
  }

  function cleanExpiryText(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[;|].*$/, "")
      .trim();
    if (!text || hasConcept(normalizeForMatch(text), "bankedResets")) return null;
    return text.slice(0, 100);
  }

  function extractResetText(text) {
    const match = normalizeVisibleText(text).match(/(?:resets?|renews?|refresh(?:es)?|reset|reinicia|reinicio|renueva|recarga)(?:\s+(?:at|on|a las|el|en))?\s+(.{1,80})/i);
    if (!match) return null;
    return cleanResetText(match[1]);
  }

  function parseMetricText(value, fallbackTitle) {
    const title = normalizeForMatch(fallbackTitle || "");
    const fields = parseCodexUsageText(`${fallbackTitle || ""} ${value || ""}`);
    const key = containsTerm(title, "spark") && hasConcept(title, "hours5")
      ? "codexSpark5h"
      : containsTerm(title, "spark") && hasConcept(title, "weekly")
        ? "codexSparkWeekly"
        : hasConcept(title, "weekly")
          ? "codexWeekly"
          : hasConcept(title, "credits")
            ? "codexCredits"
            : "codex5h";
    const parsed = fields[key];
    return parsed && parsed.structured ? parsed.structured : null;
  }

  function formatPercentValue(key, percent, resetText) {
    const reset = resetText ? `; resets ${resetText}` : "";
    return `${labelForMetricKey(key)}: ${percent}% remaining${reset}`;
  }

  function formatBankedResetsValue({ count, expiresText }) {
    const countText = count === null ? "count unavailable" : String(count);
    const expiryText = expiresText ? `; expires ${expiresText}` : "";
    return `Banked resets: ${countText}${expiryText}`;
  }

  function labelForMetricKey(key) {
    const labels = {
      codex5h: "5h limit",
      codexWeekly: "Weekly limit",
      codexSpark5h: "Codex-Spark 5h",
      codexSparkWeekly: "Codex-Spark weekly",
      codexCredits: "Credits",
      remainingCredits: "Credits",
      bankedResets: "Banked resets"
    };
    return labels[key] || key;
  }

  function cleanResetText(value) {
    if (!value) return null;
    const text = String(value)
      .replace(/\s+/g, " ")
      .replace(/[.;|].*$/, "")
      .trim();
    const patterns = [
      /^(\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /^(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /^([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4},?\s+\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /(\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  function visibleField(snippet, structured, confidence = "medium") {
    const compact = String(snippet || "").replace(/\s+/g, " ").trim();
    return {
      value: compact.slice(0, 180),
      confidence,
      structured: structured || null,
      warning: "Read from public UI text; exact endpoint data was not used."
    };
  }

  function unavailableField() {
    return {
      value: null,
      confidence: "unavailable",
      warning: "Usage not exposed by ChatGPT UI"
    };
  }

  function normalizeVisibleText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function scorePercentConfidence(percentText, windowText) {
    const percentContext = normalizeForMatch(percentText);
    const window = normalizeForMatch(windowText);
    if (/\d{1,3}\s*%/.test(percentContext)) return "high";
    if (hasConcept(window, "remaining")) return "medium";
    return "low";
  }

  function hasAnyConcept(value, concepts) {
    return concepts.some((concept) => hasConcept(value, concept));
  }

  function hasConcept(value, concept) {
    return CONCEPT_PATTERNS[concept].some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }

  function containsTerm(value, term) {
    return new RegExp(`\\b${escapeRegExp(normalizeForMatch(term))}\\b`, "i").test(value);
  }

  function matchesUsageTerms(value, concepts) {
    const normalized = normalizeForMatch(value);
    return concepts.some((concept) => hasConcept(normalized, concept));
  }

  function buildConceptPatterns(terms) {
    const patterns = {};
    for (const [concept, values] of Object.entries(terms)) {
      patterns[concept] = values.map((term) => new RegExp(`\\b${escapeRegExp(normalizeForMatch(term)).replace(/\\ /g, "\\s+")}\\b`, "g"));
    }
    return patterns;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const api = {
    TERMS,
    addLocalMessage,
    defaultCounters,
    formatRelativeTime,
    formatTime,
    getUsageLevel,
    hasVisibleUsage,
    matchesUsageTerms,
    normalizeCounters,
    normalizeMetricField,
    parseCodexUsageText,
    summarizeAvailability
  };

  globalScope.ChatGPTUsageConfig = CONFIG;
  globalScope.ChatGPTUsageModel = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ChatGPTUsageConfig: CONFIG,
      ChatGPTUsageModel: api
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
