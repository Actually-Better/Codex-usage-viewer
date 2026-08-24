(function initPopup() {
  "use strict";

  const refreshButton = document.getElementById("refreshButton");
  const openUsageButton = document.getElementById("openUsageButton");
  const copyDiagnosticsButton = document.getElementById("copyDiagnosticsButton");
  const statusTitle = document.getElementById("statusTitle");
  const statusDetail = document.getElementById("statusDetail");
  const statusAge = document.getElementById("statusAge");
  const warningBox = document.getElementById("warningBox");
  let latestDiagnostics = null;
  let latestRefreshTimestamp = null;

  refreshButton.addEventListener("click", () => refresh(true));
  openUsageButton.addEventListener("click", openUsagePage);
  copyDiagnosticsButton.addEventListener("click", copyDiagnostics);

  renderLoading();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const stateChange = changes[ChatGPTUsageConfig.storageKeys.state];
    if (stateChange && stateChange.newValue) renderState(stateChange.newValue);
  });
  loadCachedState();
  setInterval(updateRefreshAge, 30000);

  async function loadCachedState() {
    const response = await chrome.runtime.sendMessage({ type: "usage:getState" });
    renderState(response && response.state);
  }

  async function refresh(userRequested) {
    setBusy(true);
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({ type: "usage:refresh" }),
        47000,
        "Refresh timed out. Reload any open ChatGPT page and try again."
      );
      renderState(response && response.state);
      if ((!response || !response.ok) && !userRequested) statusDetail.textContent = "Using cached local data.";
    } catch (error) {
      statusTitle.textContent = "Usage unavailable";
      statusDetail.textContent = friendlyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function openUsagePage() {
    openUsageButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "usage:openCodexAnalytics" });
      statusTitle.textContent = "Analytics opened";
      statusDetail.textContent = "This visit is optional; Refresh can manage its own temporary tab.";
    } catch (error) {
      statusTitle.textContent = "Could not open Analytics";
      statusDetail.textContent = friendlyError(error);
    } finally {
      openUsageButton.disabled = false;
    }
  }

  function setBusy(isBusy) {
    refreshButton.disabled = isBusy;
    refreshButton.textContent = isBusy ? "Refreshing" : "Refresh";
  }

  function renderLoading() {
    renderRows("chatgptSection", [
      ["Login", "Checking..."],
      ["Plan", "Checking..."]
    ]);
    renderCodexCards(null);
    renderRows("diagnosticsSection", [["Usage signals found", "Checking..."]]);
    warningBox.textContent = "This extension reads the rendered Codex Analytics UI with your existing browser session.";
  }

  function renderState(state) {
    const snapshot = state && state.snapshot;
    const counters = state && state.counters;
    const status = ChatGPTUsageModel.summarizeAvailability(snapshot || state);
    const hasVisibleUsage = ChatGPTUsageModel.hasVisibleUsage(snapshot);
    const domUsageVisible = Boolean(snapshot && (snapshot.domUsageVisible || hasVisibleUsage));
    statusTitle.textContent = status;
    latestRefreshTimestamp = state && (state.dataCollectedAt || state.lastRefreshAt);
    updateRefreshAge();

    if (state && state.status === "sign-in-required") {
      statusTitle.textContent = "Sign in required";
      statusDetail.textContent = "The Analytics tab was left open so you can sign in through ChatGPT, then refresh again.";
    } else if (snapshot && snapshot.loginStatus === "logged-out") {
      statusTitle.textContent = "Sign in required";
      statusDetail.textContent = "Sign in using ChatGPT. This extension never asks for passwords.";
    } else if (state && state.status === "refreshing-codex-analytics") {
      statusTitle.textContent = "Refreshing usage";
      statusDetail.textContent = hasVisibleUsage
        ? "Checking for newer values; the last collected usage remains visible."
        : "Reading Analytics and opening a temporary fallback page if needed.";
    } else if (state && state.status === "analytics-no-new-data") {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Analytics loaded";
      statusDetail.textContent = hasVisibleUsage
        ? "Analytics loaded, but no newer usage values were detected yet."
        : "Analytics loaded, but its usage values were not detected yet.";
    } else if (state && state.status === "cached-visible-usage") {
      statusTitle.textContent = "Usage visible";
      statusDetail.textContent = "Showing the last visible Codex usage found.";
    } else if (state && (state.status === "content-script-unavailable" || state.status === "codex-analytics-load-failed")) {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Refresh failed";
      statusDetail.textContent = hasVisibleUsage
        ? "The Analytics reader failed. Showing the last collected usage values."
        : "Reload the extension and try again; the failure was confirmed after Analytics loaded.";
    } else if (state && state.status === "refresh-timeout") {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Refresh timed out";
      statusDetail.textContent = hasVisibleUsage
        ? "The latest refresh timed out. Showing the last collected usage values."
        : "Refresh took too long. Try again; Analytics may still be loading.";
    } else if (!domUsageVisible) {
      statusTitle.textContent = "Usage unavailable";
      statusDetail.textContent = "ChatGPT did not show usage values on the loaded page.";
    } else {
      statusTitle.textContent = "Usage visible";
      statusDetail.textContent = "Showing usage values visible in ChatGPT.";
    }

    renderRows("chatgptSection", [
      ["Login", renderLogin(snapshot)],
      ["Plan", renderPlan(snapshot)]
    ]);

    renderCodexCards(snapshot);

    renderRows("diagnosticsSection", [
      ["Extractor version", snapshot && snapshot.extractorVersion ? escapeHtml(snapshot.extractorVersion) : "Unavailable"],
      ["Page detected", snapshot ? `${escapeHtml(snapshot.hostname)} (${escapeHtml(snapshot.pathCategory || snapshot.pageKind || "chat")})` : "No Analytics snapshot"],
      ["Usage signals found", renderUsageSignals(snapshot)],
      ["Visible fields found", renderVisibleFields(snapshot)],
      ["Data collected", state && (state.dataCollectedAt || state.lastRefreshAt) ? ChatGPTUsageModel.formatTime(state.dataCollectedAt || state.lastRefreshAt) : "Unavailable"],
      ["Last refresh attempt", state && state.lastRefreshAttemptAt ? ChatGPTUsageModel.formatTime(state.lastRefreshAttemptAt) : "Unavailable"],
      ["Local tracking", counters && counters.localTrackingActive ? badge("Active", "ok") : badge("Inactive", "warn")],
      ["Last detected send", counters && counters.last_message_timestamp ? ChatGPTUsageModel.formatTime(counters.last_message_timestamp) : "None"],
      ["Storage", "chrome.storage.local only"],
      ["Network", "No third-party requests"]
    ]);

    warningBox.textContent = collectWarnings(snapshot, counters, state).slice(0, 5).join(" ");
    latestDiagnostics = buildDiagnosticsPayload(state);
  }

  function updateRefreshAge() {
    statusAge.textContent = `Last refresh: ${ChatGPTUsageModel.formatRelativeTime(latestRefreshTimestamp)}`;
  }

  function renderLogin(snapshot) {
    if (!snapshot) return badge("Unavailable", "warn");
    if (snapshot.loginStatus === "logged-in") return badge("Detected signed in", "ok");
    if (snapshot.loginStatus === "logged-out") return badge("Not logged in", "bad");
    return badge("Unavailable", "warn");
  }

  function renderPlan(snapshot) {
    if (snapshot && snapshot.plan && snapshot.plan.value) {
      return `${escapeHtml(snapshot.plan.value)} ${badge("Visible", "ok")}`;
    }
    return `Unavailable ${badge("Unavailable", "warn")}`;
  }

  function renderCodexCards(snapshot) {
    const section = document.getElementById("codexSection");
    section.textContent = "";
    const items = [
      ["codex5h", "5h limit"],
      ["codexWeekly", "Weekly limit"],
      ["codexSpark5h", "GPT-5.3-Codex-Spark 5h"],
      ["codexSparkWeekly", "GPT-5.3-Codex-Spark weekly"],
      ["codexCredits", "Credits"],
      ["bankedResets", "Full resets banked"]
    ];

    for (const [key, fallbackTitle] of items) {
      const field = snapshot && snapshot.usage && snapshot.usage[key];
      if (!field || !field.value) {
        section.append(renderUnavailableCard(fallbackTitle));
        continue;
      }
      section.append(renderMetricCard(field, fallbackTitle));
    }
  }

  function renderMetricCard(field, fallbackTitle) {
    const structured = ChatGPTUsageModel.normalizeMetricField(field, fallbackTitle);
    const card = document.createElement("div");
    card.className = "metric-card";

    const head = document.createElement("div");
    head.className = "metric-head";

    const title = document.createElement("div");
    title.className = "metric-title";
    title.textContent = structured.label || fallbackTitle;

    const value = document.createElement("div");
    value.className = "metric-value";
    if (typeof structured.remainingPercent === "number") {
      value.textContent = `${structured.remainingPercent}%`;
    } else if (typeof structured.remainingCredits === "number") {
      value.textContent = String(structured.remainingCredits);
    } else if (typeof structured.bankedResetCount === "number") {
      value.textContent = String(structured.bankedResetCount);
    } else {
      value.textContent = "Visible";
    }

    head.append(title, value);
    card.append(head);

    if (typeof structured.remainingPercent === "number") {
      const progress = document.createElement("div");
      progress.className = "progress";
      const fill = document.createElement("div");
      const remainingPercent = Math.max(0, Math.min(100, structured.remainingPercent));
      const usageLevel = ChatGPTUsageModel.getUsageLevel(remainingPercent);
      fill.className = `progress-fill ${usageLevel || "green"}`;

      fill.style.width = `${remainingPercent}%`;
      progress.append(fill);
      card.append(progress);
    }

    if (structured.resetText) {
      const reset = document.createElement("div");
      reset.className = "metric-reset";
      reset.textContent = `Reset: ${structured.resetText}`;
      card.append(reset);
    }

    if (structured.expiresText) {
      const expiry = document.createElement("div");
      expiry.className = "metric-reset";
      expiry.textContent = `Expires: ${structured.expiresText}`;
      card.append(expiry);
    }

    return card;
  }

  function renderUnavailableCard(title) {
    const card = document.createElement("div");
    card.className = "metric-card";
    const head = document.createElement("div");
    head.className = "metric-head";
    const label = document.createElement("div");
    label.className = "metric-title";
    label.textContent = title;
    const value = document.createElement("div");
    value.className = "metric-value";
    value.textContent = "-";
    head.append(label, value);
    card.append(head);
    const reset = document.createElement("div");
    reset.className = "metric-reset";
    reset.textContent = "Usage unavailable";
    card.append(reset);
    return card;
  }

  function renderVisibleFields(snapshot) {
    if (!snapshot || !snapshot.usage) return "unavailable";
    const labels = {
      codex5h: "5h",
      codexWeekly: "weekly",
      codexSpark5h: "spark 5h",
      codexSparkWeekly: "spark weekly",
      codexCredits: "credits",
      bankedResets: "full resets banked"
    };
    const found = Object.entries(labels)
      .filter(([key]) => snapshot.usage[key] && snapshot.usage[key].value)
      .map(([, label]) => label);
    return found.length ? escapeHtml(found.join(", ")) : "None";
  }

  function renderUsageSignals(snapshot) {
    if (!snapshot || !snapshot.sessionSignals) return "Unavailable";
    const active = Object.entries(snapshot.sessionSignals)
      .filter(([, value]) => value)
      .map(([key]) => key);
    return active.length ? escapeHtml(active.join(", ")) : "None detected";
  }

  async function copyDiagnostics() {
    const diagnostics = redactDiagnostics(latestDiagnostics || buildDiagnosticsPayload(null));
    copyDiagnosticsButton.disabled = true;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      copyDiagnosticsButton.textContent = "Copied";
    } catch {
      copyDiagnosticsButton.textContent = "Copy failed";
    } finally {
      setTimeout(() => {
        copyDiagnosticsButton.disabled = false;
        copyDiagnosticsButton.textContent = "Copy diagnostics";
      }, 1600);
    }
  }

  function buildDiagnosticsPayload(state) {
    const snapshot = state && state.snapshot;
    const counters = state && state.counters;
    return {
      extension: "Codex Usage Viewer",
      diagnosticSchema: 1,
      status: state && state.status ? state.status : null,
      popupStatus: statusTitle ? statusTitle.textContent : null,
      extractorVersion: snapshot && snapshot.extractorVersion ? snapshot.extractorVersion : null,
      pageDetected: snapshot ? {
        hostname: snapshot.hostname || null,
        pathCategory: snapshot.pathCategory || snapshot.pageKind || null
      } : null,
      loginStatus: snapshot && snapshot.loginStatus ? snapshot.loginStatus : null,
      usageSignalsFound: snapshot && snapshot.sessionSignals ? truthyKeys(snapshot.sessionSignals) : [],
      visibleFieldsFound: visibleFieldKeys(snapshot),
      codexAnalytics: snapshot && snapshot.codexAnalytics ? {
        pageDetected: Boolean(snapshot.codexAnalytics.pageDetected),
        foundKeys: snapshot.codexAnalytics.foundKeys || [],
        hasResetText: Boolean(snapshot.codexAnalytics.hasResetText),
        hasRemainingText: Boolean(snapshot.codexAnalytics.hasRemainingText),
        hasCreditsText: Boolean(snapshot.codexAnalytics.hasCreditsText),
        hasBankedResetsText: Boolean(snapshot.codexAnalytics.hasBankedResetsText),
        hasExpiryText: Boolean(snapshot.codexAnalytics.hasExpiryText),
        domSignals: snapshot.codexAnalytics.domSignals ? {
          relevantContainerCount: snapshot.codexAnalytics.domSignals.relevantContainerCount || 0,
          progressbarCount: snapshot.codexAnalytics.domSignals.progressbarCount || 0,
          ariaValueCount: snapshot.codexAnalytics.domSignals.ariaValueCount || 0,
          timeElementCount: snapshot.codexAnalytics.domSignals.timeElementCount || 0,
          mainTextLength: snapshot.codexAnalytics.domSignals.mainTextLength || 0,
          readyState: snapshot.codexAnalytics.domSignals.readyState || null
        } : null
      } : null,
      localTrackingActive: Boolean(counters && counters.localTrackingActive),
      dataCollectedAt: state && (state.dataCollectedAt || state.lastRefreshAt) ? state.dataCollectedAt || state.lastRefreshAt : null,
      lastRefreshAttemptAt: state && state.lastRefreshAttemptAt ? state.lastRefreshAttemptAt : null,
      collectedAt: snapshot && snapshot.collectedAt ? snapshot.collectedAt : null,
      storage: "chrome.storage.local only",
      network: "no third-party requests"
    };
  }

  function redactDiagnostics(value) {
    return JSON.parse(JSON.stringify(value), (_key, item) => {
      if (typeof item !== "string") return item;
      return item
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/\b(?:acct|account|user|org|workspace|team)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
    });
  }

  function truthyKeys(record) {
    return Object.entries(record || {})
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
  }

  function visibleFieldKeys(snapshot) {
    if (!snapshot || !snapshot.usage) return [];
    return Object.entries(snapshot.usage)
      .filter(([, field]) => field && field.value)
      .map(([key]) => key);
  }

  function collectWarnings(snapshot, counters, state) {
    const warnings = [];
    if (state && state.status === "content-script-unavailable") {
      warnings.push("Analytics loaded but its content script did not respond after all retries.");
    }
    if (state && state.status === "analytics-no-new-data") {
      warnings.push("Analytics responded successfully, but no new usage values were detected during this attempt.");
    }
    if (state && state.status === "sign-in-required") {
      warnings.push("The temporary Analytics tab remains open only so you can sign in safely through ChatGPT.");
    }
    if (snapshot && !snapshot.domUsageVisible) {
      warnings.push("Usage not exposed by ChatGPT UI.");
    }
    warnings.push("Usage is read from the rendered Codex Analytics UI, with a temporary inactive tab as fallback.");
    return warnings;
  }

  function renderRows(sectionId, rows) {
    const section = document.getElementById(sectionId);
    section.textContent = "";
    for (const [label, value] of rows) {
      const wrapper = document.createElement("div");
      wrapper.className = "row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.innerHTML = value;
      wrapper.append(dt, dd);
      section.append(wrapper);
    }
  }

  function badge(text, className) {
    return `<span class="badge ${className}">${escapeHtml(text)}</span>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function withTimeout(promise, ms, message) {
    let timeoutId = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      })
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function friendlyError(error) {
    const message = String(error && error.message ? error.message : error);
    if (/timed out/i.test(message)) return "Refresh took too long. Try again; Analytics may still be loading.";
    return "Analytics could not be read. Reload the extension and try again.";
  }
})();
