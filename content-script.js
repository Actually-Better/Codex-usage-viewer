(function initContentScript() {
  "use strict";

  const EXTRACTOR_VERSION = "codex-analytics-v5";
  const SEND_COOLDOWN_MS = 1500;
  let lastSendAt = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "usage:collectSnapshot") {
      sendResponse(collectSnapshot());
    }
    return false;
  });

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !isComposerForm(form)) return;
    recordMessageSent();
  }, true);

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "usage:contentSnapshot", payload: collectSnapshot() }).catch(() => {});
  }, 1200);

  function recordMessageSent() {
    const now = Date.now();
    if (now - lastSendAt < SEND_COOLDOWN_MS) return;
    lastSendAt = now;
    chrome.runtime.sendMessage({
      type: "usage:messageSent",
      payload: {
        modelLabel: detectModelLabel(),
        pageKind: detectPageKind()
      }
    }).catch(() => {});
  }

  function collectSnapshot() {
    const safeText = collectSafeUiText();
    const sessionSignals = collectSessionSignals(safeText);
    const loginStatus = detectLoginStatus(safeText, sessionSignals);
    const plan = detectPlan(safeText);
    const usage = extractUsage(safeText);
    const codexAnalytics = isCodexAnalyticsUsagePage()
      ? collectCodexAnalyticsDiagnostics(safeText, usage)
      : null;

    return {
      status: "ok",
      hostname: location.hostname,
      pathCategory: classifyPath(location.pathname),
      pageKind: detectPageKind(),
      loginStatus,
      sessionSignals,
      plan,
      modelLabel: detectModelLabel(),
      usage,
      extractorVersion: EXTRACTOR_VERSION,
      domUsageVisible: Object.values(usage).some((field) => field && field.value),
      codexAnalytics,
      collectedAt: new Date().toISOString(),
      warnings: buildWarnings(loginStatus, plan, usage)
    };
  }

  function collectSafeUiText() {
    const selectors = [
      "header",
      '[role="menu"]',
      '[role="menubar"]',
      '[role="dialog"]',
      '[data-testid*="account"]',
      '[data-testid*="profile"]',
      '[data-testid*="plan"]',
      '[data-testid*="billing"]',
      '[data-testid*="usage"]',
      '[aria-label*="account" i]',
      '[aria-label*="profile" i]',
      '[aria-label*="plan" i]',
      '[aria-label*="usage" i]',
      "button",
      "a"
    ];

    const parts = new Set();
    if (isCodexAnalyticsUsagePage()) {
      const mainText = getElementText(document.querySelector("main") || document.body);
      if (mainText) parts.add(mainText.slice(0, 12000));
    }

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isInsideConversation(element)) continue;
        const text = getElementText(element);
        if (!text) continue;
        if (isLikelyUsageText(text) || isLikelyUiChrome(element, text)) {
          parts.add(text.slice(0, 500));
        }
      }
    }

    return Array.from(parts).join("\n").slice(0, 8000);
  }

  function isInsideConversation(element) {
    return Boolean(element.closest([
      '[data-message-author-role]',
      '[data-testid*="conversation"]',
      '[class*="conversation"]',
      "main article",
      "article"
    ].join(",")));
  }

  function isLikelyUiChrome(element, text) {
    const tag = element.tagName.toLowerCase();
    if (tag === "header") return text.length < 800;
    if (tag === "button" || tag === "a") return text.length < 160;
    return text.length < 500 && /(account|profile|plan|billing|usage|limit|credit|codex|plus|pro|team|enterprise|free|log in|sign up|upgrade)/i.test(text);
  }

  function isLikelyUsageText(text) {
    return /(usage|limit|remaining|resets?|renews?|credits?|codex|gpt-?5\.?5|thinking|plan|billing|plus|pro|team|enterprise)/i.test(text);
  }

  function collectSessionSignals(text) {
    const lower = text.toLowerCase();
    const promptInput = document.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '#prompt-textarea',
      '[data-testid*="prompt"]',
      '[data-placeholder*="Message" i]',
      '[aria-label*="Message" i]',
      '[aria-label*="Ask" i]'
    ].join(","));
    const sendButton = document.querySelector([
      '[data-testid*="send"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label*="Submit" i]'
    ].join(","));
    const accountChrome = /(account|profile|settings|log out|logout|my plan|billing|workspace)/.test(lower);
    const loginChrome = /(log in|login|sign up|get started)/.test(lower);
    const modelChrome = /(chatgpt|gpt|codex|thinking|reasoning)/.test(lower);
    const appRoute = /^\/($|c\/|g\/|codex|usage|settings|admin|projects?)/i.test(location.pathname);

    return {
      promptInput: Boolean(promptInput && !isInsideConversation(promptInput)),
      sendButton: Boolean(sendButton && !isInsideConversation(sendButton)),
      accountChrome,
      loginChrome,
      modelChrome,
      appRoute
    };
  }

  function detectLoginStatus(text, signals) {
    const lower = text.toLowerCase();
    if (signals.promptInput || signals.sendButton || signals.accountChrome) {
      return "logged-in";
    }
    if (signals.appRoute && signals.modelChrome && !signals.loginChrome) return "logged-in";
    if (/(account|profile|settings|log out|logout|my plan|billing|workspace)/.test(lower)) return "logged-in";
    if (signals.loginChrome && !signals.promptInput && !signals.sendButton && !signals.accountChrome) return "logged-out";
    return "unknown";
  }

  function detectPlan(text) {
    const lower = text.toLowerCase();
    const planPatterns = [
      ["Enterprise", /\benterprise\b/],
      ["Team", /\bteam\b/],
      ["Pro", /\bpro\b/],
      ["Plus", /\bplus\b/],
      ["Free", /\bfree\b/]
    ];
    for (const [label, pattern] of planPatterns) {
      if (pattern.test(lower)) {
        return { value: label, confidence: "detected" };
      }
    }
    return { value: null, confidence: "unavailable" };
  }

  function detectModelLabel() {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], [aria-haspopup='menu']"))
      .filter((element) => !isInsideConversation(element))
      .map(getElementText)
      .filter((text) => /(gpt|codex|thinking|reasoning)/i.test(text));
    return candidates[0] || null;
  }

  function detectPageKind() {
    const path = location.pathname.toLowerCase();
    if (path.includes("codex")) return "codex";
    if (path.includes("usage") || path.includes("billing")) return "usage";
    return "chatgpt";
  }

  function classifyPath(pathname) {
    const path = pathname.toLowerCase();
    if (path.includes("codex")) return "codex";
    if (path.includes("usage")) return "usage";
    if (path.includes("billing")) return "billing";
    return "chat";
  }

  function extractUsage(text) {
    const fields = {
      gpt55ShortWindow: unavailableField(),
      thinkingWeekly: unavailableField(),
      codexCredits: unavailableField(),
      remainingCredits: unavailableField(),
      codex5h: unavailableField(),
      codexWeekly: unavailableField(),
      codexSpark5h: unavailableField(),
      codexSparkWeekly: unavailableField()
    };

    if (isCodexAnalyticsUsagePage()) {
      Object.assign(fields, extractCodexAnalyticsUsage(text));
    }

    const normalized = text.replace(/\s+/g, " ");
    const snippets = normalized.split(/(?<=\.|\n)|(?=GPT|Codex|Thinking|Credits?|Usage|Limit|Remaining|Reset)/i);

    for (const snippet of snippets) {
      const s = snippet.trim();
      if (!s) continue;
      const lower = s.toLowerCase();
      if (/gpt-?5\.?5/.test(lower) && /(limit|usage|remaining|reset|message)/.test(lower)) {
        fields.gpt55ShortWindow = visibleField(s);
      }
      if (/(thinking|reasoning)/.test(lower) && /(weekly|week|usage|remaining|reset|message)/.test(lower)) {
        fields.thinkingWeekly = visibleField(s);
      }
      if (!fields.codexCredits.value && /codex/.test(lower) && /(credit|usage|remaining|limit|reset)/.test(lower)) {
        fields.codexCredits = visibleField(s);
      }
      if (!fields.remainingCredits.value && /(remaining|left)/.test(lower) && /credits?/.test(lower)) {
        fields.remainingCredits = visibleField(s);
      }
    }

    return fields;
  }

  function extractCodexAnalyticsUsage(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const fields = {};

    fields.codex5h = codexUsageField(normalized, /(?:^|\s)L[ií]mite de uso de 5 horas\s+(\d+)\s*%\s*restante(?:\s+Se reinicia a las\s+((?:\d{1,2}:\d{2})|(?:\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})))?/i, "5h limit");
    fields.codexWeekly = codexUsageField(normalized, /(?:^|\s)L[ií]mite de uso semanal\s+(\d+)\s*%\s*restante(?:\s+Se reinicia a las\s+((?:\d{1,2}:\d{2})|(?:\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})))?/i, "Weekly limit");
    fields.codexSpark5h = codexUsageField(normalized, /GPT-[\w.\-]+-Codex-Spark\s+L[ií]mite de uso de 5 horas\s+(\d+)\s*%\s*restante(?:\s+Se reinicia a las\s+((?:\d{1,2}:\d{2})|(?:\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})))?/i, "GPT-5.3-Codex-Spark 5h");
    fields.codexSparkWeekly = codexUsageField(normalized, /GPT-[\w.\-]+-Codex-Spark\s+L[ií]mite de uso semanal\s+(\d+)\s*%\s*restante(?:\s+Se reinicia a las\s+((?:\d{1,2}:\d{2})|(?:\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})))?/i, "GPT-5.3-Codex-Spark weekly");

    const credits = normalized.match(/Cr[eé]ditos restantes\s+(\d+)/i);
    if (credits) {
      fields.remainingCredits = visibleField(`Credits remaining: ${credits[1]}`, {
        label: "Credits",
        remainingCredits: Number(credits[1])
      });
      fields.codexCredits = visibleField(`Credits remaining: ${credits[1]}`, {
        label: "Credits",
        remainingCredits: Number(credits[1])
      });
    }

    return fields;
  }

  function collectCodexAnalyticsDiagnostics(text, usage) {
    const keys = ["codex5h", "codexWeekly", "codexSpark5h", "codexSparkWeekly", "codexCredits"];
    const foundKeys = keys.filter((key) => usage[key] && usage[key].value);
    return {
      pageDetected: true,
      foundKeys,
      textLength: text.length,
      hasSaldoText: /Saldo/i.test(text),
      hasRestanteText: /restante/i.test(text),
      hasCreditsText: /Cr[eé]ditos restantes/i.test(text)
    };
  }

  function codexUsageField(text, pattern, label) {
    const match = text.match(pattern);
    if (!match) return unavailableField();
    const resetText = cleanResetText(match[2]);
    const reset = resetText ? `; resets ${resetText}` : "";
    return visibleField(`${label}: ${match[1]}% remaining${reset}`, {
      label,
      remainingPercent: Number(match[1]),
      resetText
    });
  }

  function codexVisibleField(label, percent, resetText) {
    const cleanReset = cleanResetText(resetText);
    const reset = cleanReset ? `; resets ${cleanReset}` : "";
    return visibleField(`${label}: ${percent}% remaining${reset}`, {
      label,
      remainingPercent: Number(percent),
      resetText: cleanReset
    });
  }

  function cleanResetText(value) {
    if (!value) return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    const shortTime = text.match(/^(\d{1,2}:\d{2})$/);
    if (shortTime) return shortTime[1];
    const dateTime = text.match(/^(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})$/);
    if (dateTime) return dateTime[1];
    const embedded = text.match(/(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})/);
    return embedded ? embedded[1] : null;
  }

  function visibleField(snippet, structured) {
    const compact = snippet.replace(/\s+/g, " ").trim();
    return {
      value: compact.slice(0, 180),
      confidence: "visible",
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

  function buildWarnings(loginStatus, plan, usage) {
    const warnings = [];
    if (loginStatus !== "logged-in") warnings.push("Login status is not confirmed from visible UI.");
    if (!plan.value) warnings.push("Plan is not visible in the current ChatGPT UI.");
    for (const [key, field] of Object.entries(usage)) {
      if (!field.value) warnings.push(`${key}: Usage not exposed by ChatGPT UI.`);
    }
    return warnings;
  }

  function isComposerForm(form) {
    if (isInsideConversation(form)) return false;
    const input = form.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '#prompt-textarea',
      '[data-testid*="prompt"]',
      '[data-placeholder*="Message" i]',
      '[aria-label*="Message" i]',
      '[aria-label*="Ask" i]'
    ].join(","));
    const sendButton = form.querySelector([
      '[data-testid*="send"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label*="Submit" i]',
      'button[type="submit"]'
    ].join(","));
    return Boolean(input || sendButton);
  }

  function isCodexAnalyticsUsagePage() {
    return location.hostname === "chatgpt.com"
      && location.pathname.toLowerCase().includes("/codex/")
      && location.pathname.toLowerCase().includes("/settings/analytics");
  }

  function getElementText(element) {
    return String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }
})();
