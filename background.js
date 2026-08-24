importScripts("usage-model.js");

const { storageKeys, refreshAlarmName, refreshPeriodMinutes } = ChatGPTUsageConfig;
const CODEX_ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";
const ANALYTICS_LOAD_TIMEOUT_MS = 8000;
const ANALYTICS_READ_ATTEMPTS = 25;
const ANALYTICS_READ_INTERVAL_MS = 400;
const ANALYTICS_STABLE_READS_REQUIRED = 5;
const ANALYTICS_MIN_READS_AFTER_FIRST_DATA = 13;
const REFRESH_TIMEOUT_MS = 45000;
let analyticsRefreshPromise = null;
let analyticsRefreshContext = null;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRefreshAlarm();
  const existing = await chrome.storage.local.get([storageKeys.counters]);
  await chrome.storage.local.set({
    [storageKeys.counters]: existing[storageKeys.counters]
      ? ChatGPTUsageModel.normalizeCounters(existing[storageKeys.counters])
      : ChatGPTUsageModel.defaultCounters()
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === refreshAlarmName) {
    refreshOnce("alarm").catch(() => {});
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo && Number.isInteger(activeInfo.tabId)) {
    forgetRetainedSignInTab(activeInfo.tabId).catch(() => {});
  }
});

ensureRefreshAlarm().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "usage:messageSent") {
    recordLocalMessage(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "usage:contentSnapshot") {
    saveContentSnapshot(message.payload, sender.tab).then(sendResponse);
    return true;
  }

  if (message.type === "usage:getState") {
    getPopupState().then(sendResponse);
    return true;
  }

  if (message.type === "usage:refresh") {
    withTimeout(refreshForPopup(), REFRESH_TIMEOUT_MS, "Refresh timed out.").then(sendResponse);
    return true;
  }

  if (message.type === "usage:openCodexAnalytics") {
    openCodexAnalyticsPage().then(sendResponse);
    return true;
  }

  return false;
});

async function recordLocalMessage(payload) {
  const data = await chrome.storage.local.get([storageKeys.counters]);
  const counters = ChatGPTUsageModel.addLocalMessage(data[storageKeys.counters], payload);
  await chrome.storage.local.set({ [storageKeys.counters]: counters });
  return { ok: true };
}

async function saveSnapshot(snapshot, tab, source) {
  const existing = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const currentState = existing[storageKeys.state] || {};
  const counters = ChatGPTUsageModel.normalizeCounters(existing[storageKeys.counters]);
  const hasVisibleUsage = ChatGPTUsageModel.hasVisibleUsage(snapshot);
  const collectedAt = snapshot && snapshot.collectedAt ? snapshot.collectedAt : new Date().toISOString();
  const nextState = {
    ...currentState,
    snapshot: {
      ...snapshot,
      tabId: tab && tab.id,
      source
    },
    counters,
    status: hasVisibleUsage ? "usage-current" : "page-snapshot",
    dataCollectedAt: hasVisibleUsage ? collectedAt : currentState.dataCollectedAt,
    lastRefreshAt: hasVisibleUsage ? collectedAt : currentState.lastRefreshAt
  };
  await chrome.storage.local.set({
    [storageKeys.state]: nextState,
    [storageKeys.counters]: counters
  });
  return { ok: true, state: nextState };
}

async function saveContentSnapshot(snapshot, tab) {
  if (snapshot && snapshot.codexAnalytics && !snapshot.domUsageVisible) {
    return { ok: true, ignored: true, reason: "Codex Analytics usage not visible yet." };
  }
  if (snapshot && !snapshot.codexAnalytics) {
    const existing = await chrome.storage.local.get([storageKeys.state]);
    const currentSnapshot = existing[storageKeys.state] && existing[storageKeys.state].snapshot;
    if (ChatGPTUsageModel.hasVisibleUsage(currentSnapshot)) {
      return { ok: true, ignored: true, reason: "Preserved the last valid Codex Analytics snapshot." };
    }
  }
  return saveSnapshot(snapshot, tab, "content-script");
}

async function getPopupState() {
  const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const counters = ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]);
  const state = data[storageKeys.state] || {};
  const nextState = {
    ...state,
    counters
  };
  await chrome.storage.local.set({
    [storageKeys.state]: nextState,
    [storageKeys.counters]: counters
  });
  return { ok: true, state: nextState };
}

async function refreshForPopup() {
  return refreshOnce("popup");
}

async function openCodexAnalyticsPage() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  const existing = tabs.find((tab) => isCodexAnalyticsUrl(tab.url));
  if (existing) {
    await forgetRetainedSignInTab(existing.id);
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId) && chrome.windows && chrome.windows.update) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { ok: true, tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: CODEX_ANALYTICS_URL, active: true });
  return { ok: true, tabId: tab.id, reused: false };
}

async function refreshOnce(reason) {
  if (!analyticsRefreshPromise) {
    analyticsRefreshContext = {
      popupRequested: reason === "popup",
      acceptingPopupJoin: true
    };
    analyticsRefreshPromise = refreshFromAnalyticsPage(reason, analyticsRefreshContext)
      .finally(() => {
        analyticsRefreshPromise = null;
        analyticsRefreshContext = null;
      });
  } else if (reason === "popup" && analyticsRefreshContext) {
    if (!analyticsRefreshContext.acceptingPopupJoin) {
      return analyticsRefreshPromise.then(() => refreshOnce("popup"));
    }
    analyticsRefreshContext.popupRequested = true;
  }
  return analyticsRefreshPromise;
}

async function refreshFromAnalyticsPage(reason, refreshContext = { popupRequested: reason === "popup" }) {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0] || null;
  let analyticsTab = activeTab && isCodexAnalyticsUrl(activeTab.url)
    ? activeTab
    : null;
  let temporaryTab = false;
  let keepTemporaryTab = false;
  let failureStage = analyticsTab ? "read-existing" : "create-temporary";
  let trackedTemporaryTabId = null;
  let temporaryTabWasActivated = false;
  const trackTemporaryTabActivation = (activeInfo) => {
    if (activeInfo && activeInfo.tabId === trackedTemporaryTabId) {
      temporaryTabWasActivated = true;
    }
  };
  if (chrome.tabs.onActivated && chrome.tabs.onActivated.addListener) {
    chrome.tabs.onActivated.addListener(trackTemporaryTabActivation);
  }

  try {
    if (analyticsTab) {
      await forgetRetainedSignInTab(analyticsTab.id);
    }
    if (!analyticsTab && reason === "popup") {
      analyticsTab = await getRetainedSignInTab();
      if (analyticsTab) {
        temporaryTab = true;
        trackedTemporaryTabId = analyticsTab.id;
        failureStage = "read-temporary";
      }
    }

    await markRefreshStarted(reason);
    if (!analyticsTab) {
      analyticsTab = await createBackgroundAnalyticsTab();
      temporaryTab = true;
      trackedTemporaryTabId = analyticsTab.id;
      failureStage = "read-temporary";
    }

    let result;
    try {
      result = await readAnalyticsTab(analyticsTab.id);
    } catch (error) {
      if (temporaryTab) throw error;
      await markRefreshStarted(`${reason}-temporary-fallback`);
      failureStage = "create-temporary";
      analyticsTab = await createBackgroundAnalyticsTab();
      temporaryTab = true;
      trackedTemporaryTabId = analyticsTab.id;
      failureStage = "read-temporary";
      result = await readAnalyticsTab(analyticsTab.id);
    }

    if (!temporaryTab && result.fresh === false && result.pageLoginStatus !== "logged-out") {
      const responsiveResult = result;
      failureStage = "create-temporary";
      try {
        analyticsTab = await createBackgroundAnalyticsTab();
      } catch (error) {
        return preserveResponsiveResult(responsiveResult, error, "create");
      }
      temporaryTab = true;
      trackedTemporaryTabId = analyticsTab.id;
      failureStage = "read-temporary";
      try {
        result = await readAnalyticsTab(analyticsTab.id);
      } catch (error) {
        return preserveResponsiveResult(responsiveResult, error, "read");
      }
    }

    const temporaryTabRequiresSignIn = temporaryTab && result.pageLoginStatus === "logged-out";
    const retainedSignInResult = temporaryTabRequiresSignIn ? result : null;
    if (temporaryTabRequiresSignIn && !refreshContext.popupRequested) {
      result = await markManualSignInRequired(result);
    }
    keepTemporaryTab = temporaryTabRequiresSignIn && refreshContext.popupRequested;
    refreshContext.acceptingPopupJoin = false;
    if (keepTemporaryTab && result.state.status === "sign-in-required-manual-refresh") {
      result = await restoreRetainedSignInRequired(retainedSignInResult);
    }
    if (keepTemporaryTab) {
      if (temporaryTabWasActivated) {
        await forgetRetainedSignInTab(analyticsTab.id);
      } else {
        await retainOnlySignInTab(analyticsTab.id);
      }
    }
    return { ...result, state: { ...result.state, reason } };
  } catch (error) {
    const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
    const tabCreationFailed = failureStage === "create-temporary";
    const state = {
      ...(data[storageKeys.state] || {}),
      status: tabCreationFailed ? "codex-analytics-load-failed" : "content-script-unavailable",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAttemptAt: new Date().toISOString(),
      diagnostic: tabCreationFailed
        ? "The extension could not create the temporary Codex Analytics tab."
        : failureStage === "read-temporary"
          ? "The temporary Codex Analytics page did not respond after loading."
          : "The existing Codex Analytics page did not respond after loading."
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: false, state, error: String(error && error.message ? error.message : error) };
  } finally {
    if (chrome.tabs.onActivated && chrome.tabs.onActivated.removeListener) {
      chrome.tabs.onActivated.removeListener(trackTemporaryTabActivation);
    }
    if (temporaryTab && analyticsTab && !keepTemporaryTab) {
      await forgetRetainedSignInTab(analyticsTab.id);
      const currentTab = await chrome.tabs.get(analyticsTab.id).catch(() => null);
      const extensionStillOwnsTab = currentTab
        && !temporaryTabWasActivated
        && !currentTab.active
        && isCodexAnalyticsUrl(currentTab.url);
      if (extensionStillOwnsTab) {
        await chrome.tabs.remove(analyticsTab.id).catch(() => {});
      }
    }
  }
}

async function getRetainedSignInTab() {
  const retainedKey = storageKeys.retainedSignInTab;
  const stored = await chrome.storage.local.get([retainedKey]);
  const retainedTabId = stored[retainedKey];
  if (!Number.isInteger(retainedTabId)) return null;

  try {
    const tab = await chrome.tabs.get(retainedTabId);
    if (tab && isCodexAnalyticsUrl(tab.url)) return tab;
  } catch {
    // The retained tab was closed by the user.
  }
  await chrome.storage.local.set({ [retainedKey]: null });
  return null;
}

async function retainOnlySignInTab(tabId) {
  const retainedKey = storageKeys.retainedSignInTab;
  const stored = await chrome.storage.local.get([retainedKey]);
  const previousTabId = stored[retainedKey];
  if (Number.isInteger(previousTabId) && previousTabId !== tabId) {
    try {
      const previousTab = await chrome.tabs.get(previousTabId);
      if (previousTab && !previousTab.active && isCodexAnalyticsUrl(previousTab.url)) {
        await chrome.tabs.remove(previousTabId);
      }
    } catch {
      // The previous retained tab was already closed.
    }
  }
  await chrome.storage.local.set({ [retainedKey]: tabId });
}

async function forgetRetainedSignInTab(tabId) {
  const retainedKey = storageKeys.retainedSignInTab;
  const stored = await chrome.storage.local.get([retainedKey]);
  if (stored[retainedKey] !== tabId) return;
  await chrome.storage.local.set({ [retainedKey]: null });
}

async function createBackgroundAnalyticsTab() {
  const activeTabsBeforeCreate = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  }).catch(() => []);
  const previouslyActiveTab = activeTabsBeforeCreate[0] || null;
  const createOptions = {
    url: CODEX_ANALYTICS_URL,
    active: false
  };
  if (previouslyActiveTab && Number.isInteger(previouslyActiveTab.windowId)) {
    createOptions.windowId = previouslyActiveTab.windowId;
  }

  const temporaryTab = await chrome.tabs.create(createOptions);
  return temporaryTab;
}

async function readAnalyticsTab(tabId) {
  await waitForTabReadyOrDelay(tabId);
  return requestSnapshotWithRetry(tabId);
}

async function preserveResponsiveResult(result, fallbackError, failureStage) {
  const fallbackAction = failureStage === "read"
    ? "could not be read"
    : "could not be created";
  const stored = await chrome.storage.local.get([storageKeys.state]);
  const currentState = stored[storageKeys.state] || result.state;
  const state = {
    ...currentState,
    diagnostic: `${currentState.diagnostic || result.state.diagnostic || "Analytics responded without new metrics."} The optional temporary fallback ${fallbackAction}.`,
    fallbackDiagnostic: String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError)
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
  return { ...result, state, fallbackFailed: true };
}

async function markManualSignInRequired(result) {
  const stored = await chrome.storage.local.get([storageKeys.state]);
  const currentState = stored[storageKeys.state] || result.state;
  const state = {
    ...currentState,
    status: "sign-in-required-manual-refresh",
    diagnostic: "The scheduled background Analytics tab required sign-in and was closed."
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
  return { ...result, state };
}

async function restoreRetainedSignInRequired(result) {
  const stored = await chrome.storage.local.get([storageKeys.state]);
  const currentState = stored[storageKeys.state] || result.state;
  const state = {
    ...currentState,
    status: result.state.status,
    diagnostic: result.state.diagnostic
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
  return { ...result, state };
}

async function markRefreshStarted(reason) {
  const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const state = {
    ...(data[storageKeys.state] || {}),
    status: "refreshing-codex-analytics",
    counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
    lastRefreshAttemptAt: new Date().toISOString(),
    reason
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
}

async function requestSnapshotWithRetry(tabId) {
  let lastError = null;
  let lastSnapshot = null;
  let accumulatedSnapshot = null;
  let lastUsageSignature = null;
  let stableUsageReads = 0;
  let firstVisibleAttempt = null;

  for (let attempt = 0; attempt < ANALYTICS_READ_ATTEMPTS; attempt += 1) {
    try {
      await delay(ANALYTICS_READ_INTERVAL_MS);
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: "usage:collectSnapshot" });
      if (snapshot && snapshot.status === "ok") {
        lastSnapshot = snapshot;
        if (snapshot.codexAnalytics && ChatGPTUsageModel.hasVisibleUsage(snapshot)) {
          accumulatedSnapshot = mergeUsageSnapshot(accumulatedSnapshot, snapshot);
          const signature = JSON.stringify(accumulatedSnapshot.usage || {});
          stableUsageReads = signature === lastUsageSignature ? stableUsageReads + 1 : 1;
          lastUsageSignature = signature;
          if (firstVisibleAttempt === null) firstVisibleAttempt = attempt;

          const readsSinceFirstData = attempt - firstVisibleAttempt + 1;
          if (stableUsageReads >= ANALYTICS_STABLE_READS_REQUIRED
            && readsSinceFirstData >= ANALYTICS_MIN_READS_AFTER_FIRST_DATA) {
            return saveSnapshot(accumulatedSnapshot, { id: tabId }, "requested-stable");
          }
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (accumulatedSnapshot) return saveSnapshot(accumulatedSnapshot, { id: tabId }, "requested-best-effort");
  if (lastSnapshot) return saveIncompleteRefresh(lastSnapshot, tabId);
  throw lastError || new Error("Codex Analytics content script did not respond.");
}

function mergeUsageSnapshot(accumulated, incoming) {
  const usage = { ...((accumulated && accumulated.usage) || {}) };
  for (const [key, field] of Object.entries((incoming && incoming.usage) || {})) {
    if (field && field.value) usage[key] = field;
    else if (!(key in usage)) usage[key] = field;
  }
  return {
    ...(accumulated || {}),
    ...incoming,
    usage,
    domUsageVisible: Object.values(usage).some((field) => field && field.value)
  };
}

async function saveIncompleteRefresh(pageSnapshot, tabId, source = "requested-no-new-usage") {
  const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const existingState = data[storageKeys.state] || {};
  const existingSnapshot = existingState.snapshot;
  const state = {
    ...existingState,
    snapshot: ChatGPTUsageModel.hasVisibleUsage(existingSnapshot)
      ? existingSnapshot
      : { ...pageSnapshot, tabId, source },
    status: pageSnapshot.loginStatus === "logged-out" ? "sign-in-required" : "analytics-no-new-data",
    counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
    lastRefreshAttemptAt: new Date().toISOString(),
    diagnostic: pageSnapshot.codexAnalytics
      ? "Codex Analytics rendered, but no new visible usage values were detected yet."
      : "The temporary tab responded, but the Codex Analytics route was not detected yet."
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
  return { ok: true, fresh: false, state, pageLoginStatus: pageSnapshot.loginStatus };
}

async function waitForTabReadyOrDelay(tabId) {
  try {
    await waitForTabComplete(tabId);
  } catch {
    await delay(1000);
  }
}

async function ensureRefreshAlarm() {
  const existing = await chrome.alarms.get(refreshAlarmName);
  if (existing) return;
  await chrome.alarms.create(refreshAlarmName, {
    delayInMinutes: 1,
    periodInMinutes: refreshPeriodMinutes
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out loading Codex Analytics."));
    }, ANALYTICS_LOAD_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch((error) => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, message) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } catch (error) {
    const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
    const state = {
      ...(data[storageKeys.state] || {}),
      status: "refresh-timeout",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAttemptAt: new Date().toISOString(),
      diagnostic: String(error && error.message ? error.message : error)
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: false, state, error: state.diagnostic };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isCodexAnalyticsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "chatgpt.com"
      && parsed.pathname.toLowerCase().includes("/codex/")
      && parsed.pathname.toLowerCase().includes("/settings/analytics");
  } catch {
    return false;
  }
}
