importScripts("usage-model.js");

const { storageKeys, refreshAlarmName, refreshPeriodMinutes } = ChatGPTUsageConfig;
const CODEX_ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(refreshAlarmName, {
    delayInMinutes: 1,
    periodInMinutes: refreshPeriodMinutes
  });
  const existing = await chrome.storage.local.get([storageKeys.counters]);
  await chrome.storage.local.set({
    [storageKeys.counters]: existing[storageKeys.counters]
      ? ChatGPTUsageModel.normalizeCounters(existing[storageKeys.counters])
      : ChatGPTUsageModel.defaultCounters()
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === refreshAlarmName) {
    refreshFromExistingChatGptTab("alarm");
  }
});

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
    withTimeout(refreshForPopup(), 12000, "Refresh timed out.").then(sendResponse);
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
  const nextState = {
    ...currentState,
    snapshot: {
      ...snapshot,
      tabId: tab && tab.id,
      source
    },
    counters,
    lastRefreshAt: new Date().toISOString()
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
  return refreshFromCodexAnalyticsPage("popup");
}

async function openCodexAnalyticsPage() {
  const tab = await chrome.tabs.create({
    url: CODEX_ANALYTICS_URL,
    active: true
  });
  return { ok: true, tabId: tab.id };
}

async function refreshFromExistingChatGptTab(reason) {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });

  if (!tabs.length) {
    const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
    const existingState = data[storageKeys.state] || {};
    const state = {
      ...existingState,
      status: "no-chatgpt-tab",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAt: new Date().toISOString(),
      reason
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: true, state };
  }

  const codexAnalyticsTab = tabs.find((tab) => isCodexAnalyticsUrl(tab.url));
  if (codexAnalyticsTab) return requestSnapshot(codexAnalyticsTab.id);

  const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const existingState = data[storageKeys.state] || {};
  if (existingState.snapshot && ChatGPTUsageModel.hasVisibleUsage(existingState.snapshot)) {
    const state = {
      ...existingState,
      status: "cached-visible-usage",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAt: new Date().toISOString(),
      reason
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: true, state };
  }

  return requestSnapshot(tabs[0].id);
}

async function refreshFromCodexAnalyticsPage(reason) {
  let createdTab = null;
  try {
    await markRefreshStarted(reason);
    createdTab = await chrome.tabs.create({
      url: `${CODEX_ANALYTICS_URL}?usageMonitorRefresh=${Date.now()}#usage`,
      active: false
    });
    await waitForTabReadyOrDelay(createdTab.id);
    const result = await requestSnapshotWithRetry(createdTab.id);
    return {
      ...result,
      state: {
        ...result.state,
        reason
      }
    };
  } catch (error) {
    const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
    const state = {
      ...(data[storageKeys.state] || {}),
      status: "codex-analytics-load-failed",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAt: new Date().toISOString(),
      diagnostic: "Could not load Codex Analytics with the existing browser session."
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: false, state, error: String(error && error.message ? error.message : error) };
  } finally {
    if (createdTab && createdTab.id) {
      chrome.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

async function markRefreshStarted(reason) {
  const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
  const state = {
    ...(data[storageKeys.state] || {}),
    status: "refreshing-codex-analytics",
    snapshot: null,
    counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
    lastRefreshAt: new Date().toISOString(),
    reason
  };
  await chrome.storage.local.set({ [storageKeys.state]: state });
}

async function requestSnapshotWithRetry(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      await delay(600);
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: "usage:collectSnapshot" });
      if (snapshot && snapshot.status === "ok") {
        if (!snapshot.codexAnalytics || snapshot.domUsageVisible) {
          return saveSnapshot(snapshot, { id: tabId }, "requested");
        }
        lastError = new Error("Codex Analytics loaded but usage cards are not visible yet.");
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Codex Analytics content script did not respond.");
}

async function requestSnapshot(tabId) {
  try {
    const snapshot = await chrome.tabs.sendMessage(tabId, { type: "usage:collectSnapshot" });
    return saveSnapshot(snapshot, { id: tabId }, "requested");
  } catch (error) {
    const data = await chrome.storage.local.get([storageKeys.state, storageKeys.counters]);
    const state = {
      ...(data[storageKeys.state] || {}),
      status: "content-script-unavailable",
      counters: ChatGPTUsageModel.normalizeCounters(data[storageKeys.counters]),
      lastRefreshAt: new Date().toISOString(),
      diagnostic: "Open or reload ChatGPT, then try again."
    };
    await chrome.storage.local.set({ [storageKeys.state]: state });
    return { ok: false, state, error: String(error && error.message ? error.message : error) };
  }
}

async function waitForTabReadyOrDelay(tabId) {
  try {
    await withTimeout(waitForTabComplete(tabId), 7000, "Timed out loading Codex Analytics.");
  } catch {
    await delay(1500);
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out loading Codex Analytics."));
    }, 7000);

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
      lastRefreshAt: new Date().toISOString(),
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
