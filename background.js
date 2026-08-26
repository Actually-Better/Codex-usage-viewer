importScripts("usage-model.js", "capacity-monitor.js");

const { storageKeys, refreshAlarmName, refreshPeriodMinutes } = ChatGPTUsageConfig;
const CODEX_ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";
const ANALYTICS_LOAD_TIMEOUT_MS = 8000;
const ANALYTICS_READ_ATTEMPTS = 25;
const ANALYTICS_READ_INTERVAL_MS = 400;
const ANALYTICS_STABLE_READS_REQUIRED = 5;
const ANALYTICS_MIN_READS_AFTER_FIRST_DATA = 13;
const REFRESH_TIMEOUT_MS = 45000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const CAPACITY_NOTIFICATION_TYPES = Object.freeze(["low", "critical", "exhausted", "reset"]);
const ACTION_ICON_PATHS = Object.freeze({
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png"
});
let analyticsRefreshPromise = null;
let analyticsRefreshContext = null;
let retainedSignInTabUpdate = Promise.resolve();
let capacityUpdate = Promise.resolve();
let capacityGeneration = 0;
const actionIconBitmapPromises = new Map();
const adoptedAnalyticsTabIds = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRefreshAlarm();
  const existing = await chrome.storage.local.get([storageKeys.counters]);
  await chrome.storage.local.set({
    [storageKeys.counters]: existing[storageKeys.counters]
      ? ChatGPTUsageModel.normalizeCounters(existing[storageKeys.counters])
      : ChatGPTUsageModel.defaultCounters()
  });
  await initializeCapacityUi();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm().catch(() => {});
  initializeCapacityUi().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === refreshAlarmName) {
    refreshOnce("alarm").catch(() => {});
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo && Number.isInteger(activeInfo.tabId)) {
    adoptedAnalyticsTabIds.add(activeInfo.tabId);
    forgetRetainedSignInTab(activeInfo.tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  adoptedAnalyticsTabIds.delete(tabId);
  forgetRetainedSignInTab(tabId).catch(() => {});
});

ensureRefreshAlarm().catch(() => {});
initializeCapacityUi().catch(() => {});

if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[storageKeys.capacitySettings]) return;
    handleCapacitySettingsChanged(changes[storageKeys.capacitySettings].newValue).catch(() => {});
  });
}

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

async function saveSnapshot(snapshot, tab, source, expectedCapacityGeneration = capacityGeneration) {
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
  if (hasVisibleUsage && (source === "requested-stable" || source === "requested-best-effort")) {
    await processCapacitySnapshot(nextState.snapshot, expectedCapacityGeneration).catch(() => {});
  }
  return { ok: true, state: nextState, pageLoginStatus: snapshot && snapshot.loginStatus };
}

async function saveContentSnapshot(snapshot, tab) {
  if (snapshot && snapshot.loginStatus === "logged-out") {
    await clearCapacityMonitorState();
  }
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
        if (!isCodexAnalyticsUrl(analyticsTab.url)) {
          analyticsTab = await chrome.tabs.update(analyticsTab.id, {
            url: CODEX_ANALYTICS_URL,
            active: false
          });
        }
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

    if (result.pageLoginStatus === "logged-in") {
      await removeRetainedSignInTabIfOwned(analyticsTab.id);
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
        const retainedTabId = await retainOnlySignInTab(analyticsTab.id);
        keepTemporaryTab = retainedTabId === analyticsTab.id && !temporaryTabWasActivated;
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
    try {
      if (temporaryTab && analyticsTab && !keepTemporaryTab) {
        await forgetRetainedSignInTab(analyticsTab.id);
        const currentTab = await chrome.tabs.get(analyticsTab.id).catch(() => null);
        const extensionStillOwnsTab = currentTab
          && !temporaryTabWasActivated
          && !currentTab.active;
        if (extensionStillOwnsTab) {
          await chrome.tabs.remove(analyticsTab.id).catch(() => {});
        }
      }
    } finally {
      if (chrome.tabs.onActivated && chrome.tabs.onActivated.removeListener) {
        chrome.tabs.onActivated.removeListener(trackTemporaryTabActivation);
      }
    }
  }
}

function serializeRetainedSignInTabUpdate(operation) {
  const result = retainedSignInTabUpdate.then(operation, operation);
  retainedSignInTabUpdate = result.catch(() => {});
  return result;
}

function getRetainedSignInTab() {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = storageKeys.retainedSignInTab;
    const stored = await chrome.storage.session.get([retainedKey]);
    const retainedTabId = stored[retainedKey];
    if (!Number.isInteger(retainedTabId)) return null;

    if (adoptedAnalyticsTabIds.has(retainedTabId)) {
      await chrome.storage.session.set({ [retainedKey]: null });
      return null;
    }

    try {
      const tab = await chrome.tabs.get(retainedTabId);
      if (
        tab
        && !tab.active
        && !adoptedAnalyticsTabIds.has(retainedTabId)
      ) {
        return tab;
      }
    } catch {
      // The retained tab was closed by the user.
    }
    await chrome.storage.session.set({ [retainedKey]: null });
    return null;
  });
}

function retainOnlySignInTab(tabId) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = storageKeys.retainedSignInTab;
    if (adoptedAnalyticsTabIds.has(tabId)) return null;

    const stored = await chrome.storage.session.get([retainedKey]);
    const previousTabId = stored[retainedKey];
    if (Number.isInteger(previousTabId) && previousTabId !== tabId) {
      try {
        const previousTab = await chrome.tabs.get(previousTabId);
        if (
          previousTab
          && !previousTab.active
          && !adoptedAnalyticsTabIds.has(previousTabId)
        ) {
          return previousTabId;
        }
      } catch {
        // The previous retained tab was already closed.
      }
    }

    if (adoptedAnalyticsTabIds.has(tabId)) return null;
    await chrome.storage.session.set({ [retainedKey]: tabId });
    return tabId;
  });
}

function forgetRetainedSignInTab(tabId) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = storageKeys.retainedSignInTab;
    const stored = await chrome.storage.session.get([retainedKey]);
    if (stored[retainedKey] !== tabId) return;
    await chrome.storage.session.set({ [retainedKey]: null });
  });
}

function removeRetainedSignInTabIfOwned(exceptTabId) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = storageKeys.retainedSignInTab;
    const stored = await chrome.storage.session.get([retainedKey]);
    const retainedTabId = stored[retainedKey];
    if (!Number.isInteger(retainedTabId) || retainedTabId === exceptTabId) return;

    await chrome.storage.session.set({ [retainedKey]: null });
    if (adoptedAnalyticsTabIds.has(retainedTabId)) return;

    const retainedTab = await chrome.tabs.get(retainedTabId).catch(() => null);
    const extensionStillOwnsTab = retainedTab
      && !retainedTab.active
      && !adoptedAnalyticsTabIds.has(retainedTabId);
    if (extensionStillOwnsTab) {
      await chrome.tabs.remove(retainedTabId).catch(() => {});
    }
  });
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
  let expectedCapacityGeneration = capacityGeneration;
  let observedLogout = false;
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
        if (snapshot.loginStatus === "logged-out") {
          if (!observedLogout) {
            observedLogout = true;
            await clearCapacityMonitorState();
            expectedCapacityGeneration = capacityGeneration;
          }
          accumulatedSnapshot = null;
          lastUsageSignature = null;
          stableUsageReads = 0;
          firstVisibleAttempt = null;
          continue;
        }
        if (snapshot.codexAnalytics && ChatGPTUsageModel.hasVisibleUsage(snapshot)) {
          accumulatedSnapshot = mergeUsageSnapshot(accumulatedSnapshot, snapshot);
          const signature = JSON.stringify(accumulatedSnapshot.usage || {});
          stableUsageReads = signature === lastUsageSignature ? stableUsageReads + 1 : 1;
          lastUsageSignature = signature;
          if (firstVisibleAttempt === null) firstVisibleAttempt = attempt;

          const readsSinceFirstData = attempt - firstVisibleAttempt + 1;
          if (stableUsageReads >= ANALYTICS_STABLE_READS_REQUIRED
            && readsSinceFirstData >= ANALYTICS_MIN_READS_AFTER_FIRST_DATA) {
            return saveSnapshot(
              accumulatedSnapshot,
              { id: tabId },
              "requested-stable",
              expectedCapacityGeneration
            );
          }
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (accumulatedSnapshot) {
    return saveSnapshot(
      accumulatedSnapshot,
      { id: tabId },
      "requested-best-effort",
      expectedCapacityGeneration
    );
  }
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
  if (pageSnapshot.loginStatus === "logged-out") {
    await clearCapacityMonitorState();
  }
  return { ok: true, fresh: false, state, pageLoginStatus: pageSnapshot.loginStatus };
}

function initializeCapacityUi() {
  const expectedCapacityGeneration = capacityGeneration;
  const result = capacityUpdate.then(
    () => initializeCapacityUiSerialized(expectedCapacityGeneration),
    () => initializeCapacityUiSerialized(expectedCapacityGeneration)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function initializeCapacityUiSerialized(expectedCapacityGeneration) {
  const data = await chrome.storage.local.get([
    storageKeys.state,
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed during initialization." };
  }
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  if (JSON.stringify(data[storageKeys.capacitySettings]) !== JSON.stringify(settings)) {
    await chrome.storage.local.set({ [storageKeys.capacitySettings]: settings });
  }
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed while initializing settings." };
  }
  const snapshot = data[storageKeys.state] && data[storageKeys.state].snapshot;
  const usageState = data[storageKeys.state];
  const rawMonitorState = data[storageKeys.capacityState];
  let available;
  if (isSignedOutUsageState(usageState)) {
    capacityGeneration += 1;
    await clearCapacityMonitorStateSerialized();
    return { suppressed: true };
  } else if (rawMonitorState === undefined || rawMonitorState === null) {
    const baseline = isFreshCapacitySnapshot(snapshot)
      ? CodexCapacityMonitor.evaluateSnapshot(snapshot, null, settings, snapshot.collectedAt)
      : CodexCapacityMonitor.evaluateSnapshot(null, null, settings);
    await chrome.storage.local.set({ [storageKeys.capacityState]: baseline.state });
    available = CodexCapacityMonitor.extractFreshStateCounters(baseline.state);
  } else if (rawMonitorState.suppressed) {
    available = [];
  } else {
    available = CodexCapacityMonitor.extractFreshStateCounters(rawMonitorState);
  }
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState(available, settings));
}

function isFreshCapacitySnapshot(snapshot, now = Date.now()) {
  const collectedAt = Date.parse(snapshot && snapshot.collectedAt);
  return Number.isFinite(collectedAt)
    && Number.isFinite(now)
    && now >= collectedAt
    && now - collectedAt <= CodexCapacityMonitor.COUNTER_STALE_AFTER_MS;
}

function processCapacitySnapshot(snapshot, expectedCapacityGeneration = capacityGeneration) {
  const result = capacityUpdate.then(
    () => processCapacitySnapshotSerialized(snapshot, expectedCapacityGeneration),
    () => processCapacitySnapshotSerialized(snapshot, expectedCapacityGeneration)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function processCapacitySnapshotSerialized(snapshot, expectedCapacityGeneration) {
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed before processing." };
  }
  const data = await chrome.storage.local.get([
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed during processing." };
  }
  const evaluation = CodexCapacityMonitor.evaluateSnapshot(
    snapshot,
    data[storageKeys.capacityState],
    data[storageKeys.capacitySettings]
  );
  const storageUpdate = { [storageKeys.capacityState]: evaluation.state };
  if (JSON.stringify(data[storageKeys.capacitySettings]) !== JSON.stringify(evaluation.settings)) {
    storageUpdate[storageKeys.capacitySettings] = evaluation.settings;
  }
  await chrome.storage.local.set(storageUpdate);
  await applyCapacityVisual(evaluation.visual);
  await clearRecoveredOrExpiredExhaustedNotifications(
    data[storageKeys.capacityState],
    evaluation
  );

  for (const event of evaluation.events) {
    if (CodexCapacityMonitor.shouldNotify(event, evaluation.settings)) {
      await showCapacityNotification(event).catch(() => {});
    }
  }
  if (evaluation.events.some((event) => CodexCapacityMonitor.shouldPlaySound(event, evaluation.settings))) {
    await playCapacitySound().catch(() => {});
  }
  return evaluation;
}

async function applyCapacityVisualFromStoredSnapshot(rawSettings) {
  const data = await chrome.storage.local.get([storageKeys.capacityState]);
  const monitorState = data[storageKeys.capacityState];
  const available = monitorState && !monitorState.suppressed
    ? CodexCapacityMonitor.extractFreshStateCounters(monitorState)
    : [];
  const visual = CodexCapacityMonitor.deriveVisualState(available, rawSettings);
  await applyCapacityVisual(visual);
}

function handleCapacitySettingsChanged(rawSettings) {
  const result = capacityUpdate.then(
    () => handleCapacitySettingsChangedSerialized(rawSettings),
    () => handleCapacitySettingsChangedSerialized(rawSettings)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function handleCapacitySettingsChangedSerialized(rawSettings) {
  const settings = CodexCapacityMonitor.normalizeSettings(rawSettings);
  if (!settings.enableNotifications) {
    await clearAllCapacityNotifications();
  }
  await applyCapacityVisualFromStoredSnapshot(settings);
}

function isSignedOutUsageState(state) {
  return Boolean(state && (
    state.status === "sign-in-required"
    || state.status === "sign-in-required-manual-refresh"
    || (state.snapshot && state.snapshot.loginStatus === "logged-out")
  ));
}

function createSuppressedCapacityState() {
  return {
    version: 2,
    counters: {},
    availableKeys: [],
    updatedAt: new Date().toISOString(),
    suppressed: true
  };
}

function clearCapacityMonitorState() {
  capacityGeneration += 1;
  const result = capacityUpdate.then(
    () => clearCapacityMonitorStateSerialized(),
    () => clearCapacityMonitorStateSerialized()
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function clearCapacityMonitorStateSerialized() {
  const data = await chrome.storage.local.get([storageKeys.capacitySettings]);
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  await chrome.storage.local.set({
    [storageKeys.capacityState]: createSuppressedCapacityState()
  });
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState([], settings));
  await clearAllCapacityNotifications();
}

async function clearRecoveredOrExpiredExhaustedNotifications(previousState, evaluation) {
  const previous = CodexCapacityMonitor.normalizeMonitorState(previousState);
  const next = CodexCapacityMonitor.normalizeMonitorState(evaluation && evaluation.state);
  const recoveredKeys = (evaluation && evaluation.available ? evaluation.available : [])
    .filter((counter) => counter.remainingPercent > 0)
    .map((counter) => counter.key);
  const expiredKeys = CodexCapacityMonitor.COUNTERS
    .map((counter) => counter.key)
    .filter((key) => (
      previous.counters[key]
      && previous.counters[key].remainingPercent === 0
      && !next.counters[key]
    ));
  await Promise.all([...new Set([...recoveredKeys, ...expiredKeys])]
    .map((key) => clearCapacityNotification(key, "exhausted")));
}

async function clearCapacityNotification(counterKey, type) {
  if (!chrome.notifications || !chrome.notifications.clear) return false;
  return chrome.notifications.clear(`codex-capacity-${counterKey}-${type}`).catch(() => false);
}

async function clearAllCapacityNotifications() {
  await Promise.all(CodexCapacityMonitor.COUNTERS.flatMap((counter) => (
    CAPACITY_NOTIFICATION_TYPES.map((type) => clearCapacityNotification(counter.key, type))
  )));
}

async function applyCapacityVisual(visual) {
  if (!chrome.action) return;
  let usesCustomIcon = false;
  if (visual.badgeText && chrome.action.setIcon) {
    const imageData = await buildCapacityActionIcon(visual.badgeText, visual.badgeColor).catch(() => null);
    if (imageData) {
      try {
        await chrome.action.setIcon({ imageData });
        usesCustomIcon = true;
      } catch (_) {
        usesCustomIcon = false;
      }
    }
  }
  if (!usesCustomIcon && chrome.action.setIcon) {
    await chrome.action.setIcon({ path: ACTION_ICON_PATHS }).catch(() => {});
  }

  const updates = [];
  if (chrome.action.setBadgeText) {
    updates.push(chrome.action.setBadgeText({ text: usesCustomIcon ? "" : visual.badgeText }));
  }
  if (chrome.action.setBadgeBackgroundColor) {
    updates.push(chrome.action.setBadgeBackgroundColor({ color: visual.badgeColor }));
  }
  if (!usesCustomIcon && chrome.action.setBadgeTextColor) {
    updates.push(chrome.action.setBadgeTextColor({ color: "#ffffff" }));
  }
  if (chrome.action.setTitle) {
    updates.push(chrome.action.setTitle({ title: visual.title }));
  }
  await Promise.all(updates);
}

async function buildCapacityActionIcon(text, color) {
  if (
    typeof OffscreenCanvas !== "function"
    || typeof createImageBitmap !== "function"
    || typeof fetch !== "function"
  ) {
    return null;
  }

  const entries = await Promise.all(Object.entries(ACTION_ICON_PATHS).map(async ([sizeKey, path]) => {
    const size = Number(sizeKey);
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable.");
    context.drawImage(await loadActionIconBitmap(size, path), 0, 0, size, size);
    drawCapacityBadge(context, size, text, color);
    return [sizeKey, context.getImageData(0, 0, size, size)];
  }));
  return Object.fromEntries(entries);
}

function loadActionIconBitmap(size, path) {
  if (!actionIconBitmapPromises.has(size)) {
    actionIconBitmapPromises.set(size, (async () => {
      const response = await fetch(chrome.runtime.getURL(path));
      if (!response.ok) throw new Error(`Could not load action icon ${size}.`);
      return createImageBitmap(await response.blob());
    })());
  }
  return actionIconBitmapPromises.get(size);
}

function drawCapacityBadge(context, size, rawText, color) {
  const text = String(rawText).slice(0, 3);
  const badgeHeight = Math.round(size * 0.6);
  const badgeTop = size - badgeHeight;
  const radius = Math.max(2, Math.round(size * 0.16));
  const fontScale = text.length >= 3 ? 0.38 : 0.5;

  context.save();
  context.beginPath();
  roundedRectangle(context, 0, badgeTop, size, badgeHeight, radius);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = "rgba(0, 0, 0, 0.42)";
  context.lineWidth = Math.max(1, Math.round(size / 32));
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = `800 ${Math.max(7, Math.round(size * fontScale))}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size / 2, badgeTop + badgeHeight / 2 + size * 0.025);
  context.restore();
}

function roundedRectangle(context, x, y, width, height, radius) {
  const right = x + width;
  const bottom = y + height;
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

async function showCapacityNotification(event) {
  if (!chrome.notifications || !chrome.notifications.create) return;
  const copy = CodexCapacityMonitor.buildNotification(event);
  await chrome.notifications.create(`codex-capacity-${event.key}-${event.type}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: copy.title,
    message: copy.message,
    priority: event.type === "exhausted" ? 2 : 1,
    requireInteraction: event.type === "exhausted",
    silent: true
  });
}

async function playCapacitySound() {
  const ready = await ensureOffscreenDocument();
  if (!ready) return;
  await chrome.runtime.sendMessage({ type: "capacity:playSound" });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    if (contexts.length) return true;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a user-enabled sound once for a newly crossed capacity alert."
    });
  } catch (error) {
    if (!/single offscreen document|already exists/i.test(String(error && error.message ? error.message : error))) {
      throw error;
    }
  }
  return true;
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
