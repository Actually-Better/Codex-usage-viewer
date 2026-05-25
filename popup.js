(function initPopup() {
  "use strict";

  const refreshButton = document.getElementById("refreshButton");
  const statusTitle = document.getElementById("statusTitle");
  const statusDetail = document.getElementById("statusDetail");
  const warningBox = document.getElementById("warningBox");

  refreshButton.addEventListener("click", () => refresh(true));

  renderLoading();
  loadCachedState().then(() => refresh(false));

  async function loadCachedState() {
    const response = await chrome.runtime.sendMessage({ type: "usage:getState" });
    renderState(response && response.state);
  }

  async function refresh(userRequested) {
    setBusy(true);
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({ type: "usage:refresh" }),
        13000,
        "Refresh timed out. Try again after opening ChatGPT once."
      );
      renderState(response && response.state);
      if (!response || !response.ok) {
        statusDetail.textContent = userRequested
          ? "Open or reload ChatGPT, then press Refresh again."
          : "Using cached local data.";
      }
    } catch (error) {
      statusTitle.textContent = "Refresh unavailable";
      statusDetail.textContent = String(error && error.message ? error.message : error);
    } finally {
      setBusy(false);
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
    renderRows("diagnosticsSection", [["DOM usage visible", "Checking..."]]);
    warningBox.textContent = "The extension can load Codex Analytics with your existing browser session and read visible page content.";
  }

  function renderState(state) {
    const snapshot = state && state.snapshot;
    const counters = state && state.counters;
    const status = ChatGPTUsageModel.summarizeAvailability(snapshot || state);
    const domUsageVisible = Boolean(snapshot && snapshot.domUsageVisible);
    statusTitle.textContent = status;

    if (!snapshot && state && state.status === "no-chatgpt-tab") {
      statusDetail.textContent = "Open ChatGPT once and sign in. Then this popup can load Codex Analytics and read visible usage.";
    } else if (snapshot && snapshot.loginStatus === "logged-out") {
      statusDetail.textContent = "Sign in using ChatGPT. This extension never asks for passwords.";
    } else if (state && state.status === "cached-visible-usage") {
      statusDetail.textContent = "Showing cached visible Codex usage. Open Codex Analytics to refresh it.";
    } else if (state && state.status === "codex-analytics-load-failed") {
      statusDetail.textContent = "Could not load Codex Analytics. Check that ChatGPT is signed in, then refresh.";
    } else if (state && state.status === "refresh-timeout") {
      statusDetail.textContent = "Refresh timed out. The popup recovered; try again or open Codex Analytics once.";
    } else if (!domUsageVisible) {
      statusDetail.textContent = "Usage was not visible in the loaded Codex Analytics page.";
    } else {
      statusDetail.textContent = "Connected. Showing available visible usage data.";
    }

    renderRows("chatgptSection", [
      ["Login", renderLogin(snapshot)],
      ["Plan", renderPlan(snapshot)]
    ]);

    renderCodexCards(snapshot);

    renderRows("diagnosticsSection", [
      ["DOM usage visible", domUsageVisible ? badge("Yes", "ok") : badge("No", "warn")],
      ["Local tracking active", counters && counters.localTrackingActive ? badge("Yes", "ok") : badge("No", "warn")],
      ["Last detected send", counters && counters.last_message_timestamp ? ChatGPTUsageModel.formatTime(counters.last_message_timestamp) : "None"],
      ["Last refresh", state && state.lastRefreshAt ? ChatGPTUsageModel.formatTime(state.lastRefreshAt) : "Unavailable"],
      ["Page", snapshot ? `${snapshot.hostname} (${snapshot.pathCategory || snapshot.pageKind || "chat"})` : "No ChatGPT tab detected"],
      ["Codex analytics", renderCodexAnalytics(snapshot)],
      ["Extractor", snapshot && snapshot.extractorVersion ? snapshot.extractorVersion : "Unavailable"],
      ["Session signals", renderSessionSignals(snapshot)],
      ["Codex source", sourceForCodex(snapshot)],
      ["Local source", counters && counters.localTrackingActive ? "local" : "unavailable"],
      ["Storage", "chrome.storage.local only"],
      ["Network", "No third-party requests"]
    ]);

    warningBox.textContent = collectWarnings(snapshot, counters, state).slice(0, 5).join(" ");
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

  function renderVisibleUsage(snapshot, key) {
    const field = snapshot && snapshot.usage && snapshot.usage[key];
    if (field && field.value) {
      return `${escapeHtml(field.value)} ${badge("Visible", "ok")}`;
    }
    return `Usage not exposed by ChatGPT UI ${badge("Unavailable", "warn")}`;
  }

  function renderCodexCards(snapshot) {
    const section = document.getElementById("codexSection");
    section.textContent = "";
    const items = [
      ["codex5h", "5h limit"],
      ["codexWeekly", "Weekly limit"],
      ["codexSpark5h", "GPT-5.3-Codex-Spark 5h"],
      ["codexSparkWeekly", "GPT-5.3-Codex-Spark weekly"],
      ["codexCredits", "Credits"]
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
    const structured = normalizeMetricField(field, fallbackTitle);
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

      if (remainingPercent < 15) {
        fill.className = "progress-fill low";
      } else if (remainingPercent < 50) {
        fill.className = "progress-fill medium";
      } else {
        fill.className = "progress-fill";
      }

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
    reset.textContent = "Usage not exposed by ChatGPT UI";
    card.append(reset);
    return card;
  }

  function normalizeMetricField(field, fallbackTitle) {
    const structured = field.structured || {};
    const value = String(field.value || "");
    const parsed = parseMetricText(value, fallbackTitle);
    const structuredLooksContaminated = structured.resetText && /l[ií]mite|cr[eé]ditos|recarga|configuraci[oó]n/i.test(structured.resetText);
    const shouldPreferParsed = parsed && (
      fallbackTitle.toLowerCase().includes("codex-spark")
      || structuredLooksContaminated
      || typeof structured.remainingPercent !== "number"
    );

    if (shouldPreferParsed) return parsed;

    if (typeof structured.remainingPercent === "number" || typeof structured.remainingCredits === "number") {
      return structured;
    }

    if (parsed) return parsed;
    return {
      label: fallbackTitle
    };
  }

  function parseMetricText(value, fallbackTitle) {
    const spark5h = value.match(/Codex-Spark.*?(?:5-hour|5 horas).*?(\d+)\s*%\s*(?:remaining|restante)/i);
    const sparkWeekly = value.match(/Codex-Spark.*?(?:weekly|semanal).*?(\d+)\s*%\s*(?:remaining|restante)/i);
    const percent = value.match(/(\d+)\s*%\s*remaining/i);
    const credits = value.match(/credits?\s+remaining:\s*(\d+)/i);
    const reset = value.match(/resets\s+(.+)$/i);
    const resetText = cleanResetText(reset && reset[1]);
    const title = fallbackTitle.toLowerCase();
    const selectedPercent = title.includes("codex-spark") && title.includes("5h")
      ? spark5h
      : title.includes("codex-spark") && title.includes("weekly")
        ? sparkWeekly
        : percent;

    if (selectedPercent) {
      return {
        label: fallbackTitle,
        remainingPercent: Number(selectedPercent[1]),
        resetText
      };
    }

    if (credits) {
      return {
        label: fallbackTitle,
        remainingCredits: Number(credits[1])
      };
    }

    return null;
  }

  function cleanResetText(value) {
    if (!value) return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    const exact = text.match(/^(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})$/);
    if (exact) return exact[1];
    const embedded = text.match(/(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})/);
    return embedded ? embedded[1] : null;
  }

  function sourceForCodex(snapshot) {
    if (!snapshot || !snapshot.usage) return "unavailable";
    const keys = ["codex5h", "codexWeekly", "codexSpark5h", "codexSparkWeekly", "codexCredits"];
    return keys.some((key) => snapshot.usage[key] && snapshot.usage[key].value) ? "visible" : "unavailable";
  }

  function renderSessionSignals(snapshot) {
    if (!snapshot || !snapshot.sessionSignals) return "Unavailable";
    const active = Object.entries(snapshot.sessionSignals)
      .filter(([, value]) => value)
      .map(([key]) => key);
    return active.length ? active.join(", ") : "None detected";
  }

  function renderCodexAnalytics(snapshot) {
    if (!snapshot || !snapshot.codexAnalytics) return "Not on Codex Analytics page";
    const data = snapshot.codexAnalytics;
    const found = data.foundKeys && data.foundKeys.length ? data.foundKeys.join(", ") : "none";
    return `detected; found ${found}; text ${data.textLength}`;
  }

  function collectWarnings(snapshot, counters, state) {
    const warnings = [];
    if (!snapshot && state && state.status === "no-chatgpt-tab") {
      warnings.push("ChatGPT is not open; open ChatGPT in a tab and sign in.");
    }
    if (state && state.status === "content-script-unavailable") {
      warnings.push("Content script is unavailable; reload the ChatGPT tab.");
    }
    if (snapshot && !snapshot.domUsageVisible) {
      warnings.push("Usage not exposed by ChatGPT UI.");
    }
    warnings.push("Visible usage is read from the Codex Analytics page loaded with your existing browser session.");
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
})();
