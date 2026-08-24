const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const { ChatGPTUsageConfig, ChatGPTUsageModel } = require("../usage-model.js");
const backgroundSource = readFileSync(join(__dirname, "..", "background.js"), "utf8");

function createBackgroundHarness({ tabs = [], snapshot = null, sendError = null, createError = null, initialState = {}, existingAlarm = true, retainedSignInTabId = null } = {}) {
  const storage = {
    [ChatGPTUsageConfig.storageKeys.state]: initialState,
    [ChatGPTUsageConfig.storageKeys.counters]: ChatGPTUsageModel.defaultCounters(1),
    [ChatGPTUsageConfig.storageKeys.retainedSignInTab]: retainedSignInTabId
  };
  const calls = { create: 0, createArgs: [], remove: 0, removedTabIds: [], update: 0, updateArgs: [], windowUpdate: 0, windowUpdateArgs: [], sendMessage: 0, messages: [], alarmCreate: 0, alarmCreateArgs: [] };
  const listeners = {};
  let alarmExists = existingAlarm;
  let openTabs = tabs.map((tab) => ({ ...tab }));
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    alarms: {
      async create(name, options) {
        alarmExists = true;
        calls.alarmCreate += 1;
        calls.alarmCreateArgs.push({ name, ...options });
      },
      async get() { return alarmExists ? { name: ChatGPTUsageConfig.refreshAlarmName } : null; },
      onAlarm: { addListener(listener) { listeners.alarm = listener; } }
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    windows: {
      async update(windowId, args) {
        calls.windowUpdate += 1;
        calls.windowUpdateArgs.push({ windowId, ...args });
        return { id: windowId, ...args };
      }
    },
    tabs: {
      async query(queryInfo = {}) {
        return queryInfo.active ? openTabs.filter((tab) => tab.active) : openTabs;
      },
      async create(args) {
        calls.create += 1;
        calls.createArgs.push(args);
        if (createError) throw createError;
        const createdTabIsActive = Boolean(args.active);
        if (createdTabIsActive) openTabs = openTabs.map((tab) => ({ ...tab, active: false }));
        const createdTab = { id: 99, url: args.url, active: createdTabIsActive, status: "complete" };
        openTabs.push(createdTab);
        return createdTab;
      },
      async remove(tabId) {
        calls.remove += 1;
        calls.removedTabIds.push(tabId);
        openTabs = openTabs.filter((tab) => tab.id !== tabId);
      },
      async update(tabId, args) {
        calls.update += 1;
        calls.updateArgs.push({ tabId, ...args });
        if (args.active) openTabs = openTabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
        const updatedTab = openTabs.find((tab) => tab.id === tabId) || { id: tabId };
        Object.assign(updatedTab, args);
        return updatedTab;
      },
      async sendMessage(tabId, message) {
        calls.sendMessage += 1;
        calls.messages.push(message);
        if (sendError) throw sendError;
        return typeof snapshot === "function" ? snapshot(calls.sendMessage, tabId, message) : snapshot;
      },
      async get(tabId) {
        const tab = openTabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      onUpdated: {
        addListener() {},
        removeListener() {}
      }
    }
  };
  const context = vm.createContext({
    ChatGPTUsageConfig,
    ChatGPTUsageModel,
    URL,
    chrome,
    clearTimeout,
    console,
    importScripts() {},
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    }
  });
  vm.runInContext(backgroundSource, context);
  return {
    calls,
    context,
    storage,
    getOpenTabs() {
      return openTabs.map((tab) => ({ ...tab }));
    },
    setActiveTab(tabId) {
      openTabs = openTabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
    },
    setTabUrl(tabId, url) {
      const tab = openTabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.url = url;
    },
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

test("background worker startup repairs a missing periodic alarm", async () => {
  const harness = createBackgroundHarness({ existingAlarm: false });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.alarmCreate, 1);
  assert.deepEqual(harness.calls.alarmCreateArgs, [{
    name: ChatGPTUsageConfig.refreshAlarmName,
    delayInMinutes: 1,
    periodInMinutes: 15
  }]);
});

function visibleSnapshot() {
  return {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    collectedAt: "2026-08-24T10:00:00.000Z",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: true,
    usage: {
      codex5h: { value: "5h limit: 60% remaining" },
      bankedResets: {
        value: "Banked resets: 2; expires Aug 31, 2026",
        structured: { bankedResetCount: 2, expiresText: "Aug 31, 2026" }
      }
    }
  };
}

test("popup refresh opens a background Analytics tab and closes it after reading", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.match(harness.calls.createArgs[0].url, /settings\/analytics/);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.remove, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [17]);
});

test("background refresh does not override a tab selected by the user during collection", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/starting-page", active: true, status: "complete" },
      { id: 18, url: "https://chatgpt.com/c/user-selected-page", active: false, status: "complete" }
    ],
    snapshot(callNumber) {
      if (callNumber === 1) harness.setActiveTab(18);
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
});

test("refresh preserves a temporary Analytics tab activated during collection", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      if (callNumber === 1) harness.setActiveTab(99);
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 99).active, true);
});

test("refresh preserves a temporary tab navigated away during collection", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      if (callNumber === 1) {
        harness.setTabUrl(99, "https://chatgpt.com/c/user-owned-conversation");
      }
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.remove, 0);
  assert.equal(
    harness.getOpenTabs().find((tab) => tab.id === 99).url,
    "https://chatgpt.com/c/user-owned-conversation"
  );
});

test("periodic refresh creates a real temporary Analytics tab when none is open", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.remove, 1);
  assert.equal(harness.calls.update, 0);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [17]);
});

test("refresh opens a fresh background tab when Analytics exists only in the background", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
});

test("periodic refresh retries an unusable existing page in a real temporary tab", async () => {
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      return tabId === 42 ? emptySnapshot : visibleSnapshot();
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.sendMessage, 38);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

test("a temporary Analytics tab remains open only when ChatGPT requires sign-in", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 99).active, false);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("repeated logged-out refreshes reuse one retained background sign-in tab", async () => {
  const loggedOutSnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: loggedOutSnapshot
  });

  const firstResult = await harness.run("refreshForPopup()");
  const secondResult = await harness.run("refreshForPopup()");

  assert.equal(firstResult.state.status, "sign-in-required");
  assert.equal(secondResult.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
  assert.equal(
    harness.getOpenTabs().filter((tab) => /settings\/analytics/.test(tab.url)).length,
    1
  );
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("a retained sign-in tab is removed after authentication succeeds", async () => {
  const loggedOutSnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      return callNumber <= 25 ? loggedOutSnapshot : visibleSnapshot();
    }
  });

  await harness.run("refreshForPopup()");
  const authenticatedResult = await harness.run("refreshForPopup()");

  assert.equal(authenticatedResult.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("an active retained Analytics tab becomes user-owned and is never removed", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: visibleSnapshot(),
    retainedSignInTabId: 42
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("a periodic logged-out refresh closes its temporary tab without stealing focus", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required-manual-refresh");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 1);
});

test("scheduled sign-in status preserves a newer stored usage snapshot", async () => {
  const newerSnapshot = visibleSnapshot();
  const harness = createBackgroundHarness({
    initialState: {
      snapshot: newerSnapshot,
      status: "usage-current",
      dataCollectedAt: "2026-08-24T10:05:00.000Z",
      lastRefreshAt: "2026-08-24T10:05:00.000Z"
    }
  });
  harness.context.staleSignInResult = {
    ok: true,
    state: {
      snapshot: { loginStatus: "logged-out", usage: {} },
      status: "sign-in-required",
      dataCollectedAt: "2026-08-24T10:00:00.000Z"
    }
  };

  const result = await harness.run("markManualSignInRequired(staleSignInResult)");

  assert.equal(result.state.status, "sign-in-required-manual-refresh");
  assert.deepEqual(result.state.snapshot, newerSnapshot);
  assert.equal(result.state.dataCollectedAt, "2026-08-24T10:05:00.000Z");
  assert.equal(result.state.lastRefreshAt, "2026-08-24T10:05:00.000Z");
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state], result.state);
});

test("a periodic logged-out existing page does not create another fallback tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a popup joining a periodic logged-out refresh keeps the temporary tab for sign-in", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const results = await harness.run('Promise.all([refreshOnce("alarm"), refreshForPopup()])');

  assert.equal(results[0].state.status, "sign-in-required");
  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a popup joining an alarm replaces an older retained sign-in tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    retainedSignInTabId: 42
  });

  const results = await harness.run('Promise.all([refreshOnce("alarm"), refreshForPopup()])');

  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [42]);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
  assert.equal(
    harness.getOpenTabs().filter((tab) => /settings\/analytics/.test(tab.url)).length,
    1
  );
});

test("a popup joining during the scheduled sign-in write still keeps the temporary tab", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });
  const originalSet = harness.context.chrome.storage.local.set;
  const newerSnapshot = visibleSnapshot();
  const newerCollectedState = {
    snapshot: newerSnapshot,
    status: "usage-current",
    dataCollectedAt: "2026-08-24T10:05:00.000Z",
    lastRefreshAt: "2026-08-24T10:05:00.000Z"
  };
  let releaseManualWrite;
  let signalManualWrite;
  const manualWriteStarted = new Promise((resolve) => { signalManualWrite = resolve; });
  const manualWriteReleased = new Promise((resolve) => { releaseManualWrite = resolve; });
  harness.context.chrome.storage.local.set = async (values) => {
    const state = values[ChatGPTUsageConfig.storageKeys.state];
    if (state && state.status === "sign-in-required-manual-refresh") {
      signalManualWrite();
      await manualWriteReleased;
      await originalSet(values);
      harness.storage[ChatGPTUsageConfig.storageKeys.state] = newerCollectedState;
      return;
    }
    return originalSet(values);
  };

  const alarmResult = harness.run('refreshOnce("alarm")');
  await manualWriteStarted;
  const popupResult = harness.run("refreshForPopup()");
  releaseManualWrite();
  const results = await Promise.all([alarmResult, popupResult]);

  assert.equal(results[0].state.status, "sign-in-required");
  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.state].status, "sign-in-required");
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state].snapshot, newerSnapshot);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.state].dataCollectedAt, "2026-08-24T10:05:00.000Z");
  assert.equal(results[0].state.lastRefreshAt, "2026-08-24T10:05:00.000Z");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a non-Analytics page cannot overwrite a valid usage snapshot", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({ initialState: { snapshot: cached } });
  const ordinaryPageSnapshot = {
    status: "ok",
    codexAnalytics: null,
    domUsageVisible: false,
    usage: {}
  };
  harness.context.ordinaryPageSnapshot = ordinaryPageSnapshot;

  const result = await harness.run("saveContentSnapshot(ordinaryPageSnapshot, { id: 7 })");

  assert.equal(result.ignored, true);
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state].snapshot, cached);
});

test("Visit Analytics focuses an existing page instead of duplicating it", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, windowId: 5, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, windowId: 5, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    retainedSignInTabId: 42
  });

  const result = await harness.run("openCodexAnalyticsPage()");

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(harness.calls.create, 0);
  assert.deepEqual(harness.calls.updateArgs, [{ tabId: 42, active: true }]);
  assert.deepEqual(harness.calls.windowUpdateArgs, [{ windowId: 5, focused: true }]);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [42]);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("Visit Analytics creates a focused active page when none exists", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, windowId: 5, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }]
  });

  const result = await harness.run("openCodexAnalyticsPage()");

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, true);
  assert.match(harness.calls.createArgs[0].url, /settings\/analytics/);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [99]);
});

test("concurrent popup refreshes share one Analytics collection", async () => {
  const snapshot = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot
  });

  const results = await harness.run("Promise.all([refreshForPopup(), refreshForPopup()])");

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.create, 0);
});

test("a responsive Analytics page without new metrics is not reported as a failure", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-in",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.fresh, false);
  assert.equal(result.state.status, "analytics-no-new-data");
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.sendMessage, 50);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

test("manual refresh retries an existing page without metrics in a temporary Analytics tab", async () => {
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      return tabId === 42 ? emptySnapshot : visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 60% remaining");
  assert.equal(harness.calls.sendMessage, 38);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

test("refresh failure requires both the existing and temporary Analytics readers to be unreachable", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    sendError: new Error("Receiving end does not exist")
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "content-script-unavailable");
  assert.match(result.error, /Receiving end does not exist/);
  assert.equal(harness.calls.sendMessage, 50);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 1);
});

test("failure to create an optional fallback preserves the responsive incomplete result", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-in",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    createError: new Error("Tabs cannot be created"),
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.fresh, false);
  assert.equal(result.fallbackFailed, true);
  assert.equal(result.state.status, "analytics-no-new-data");
  assert.match(result.state.diagnostic, /optional temporary fallback could not be created/i);
  assert.match(result.state.fallbackDiagnostic, /Tabs cannot be created/);
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
});

test("failure to read an optional fallback preserves the responsive incomplete result", async () => {
  const cached = visibleSnapshot();
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      if (tabId === 42) return emptySnapshot;
      throw new Error("Temporary reader unavailable");
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.fresh, false);
  assert.equal(result.fallbackFailed, true);
  assert.equal(result.state.status, "analytics-no-new-data");
  assert.match(result.state.diagnostic, /optional temporary fallback could not be read/i);
  assert.match(result.state.fallbackDiagnostic, /Temporary reader unavailable/);
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 1);
});

test("fallback preservation keeps a newer content snapshot stored during the retry", async () => {
  const cached = visibleSnapshot();
  const newerSnapshot = {
    ...visibleSnapshot(),
    collectedAt: "2026-08-24T10:05:00.000Z",
    usage: {
      codex5h: { value: "5h limit: 58% remaining" }
    }
  };
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  let harness;
  let newerSnapshotStored = false;
  harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      if (tabId === 42) return emptySnapshot;
      if (!newerSnapshotStored) {
        newerSnapshotStored = true;
        harness.storage[ChatGPTUsageConfig.storageKeys.state] = {
          status: "usage-current",
          snapshot: newerSnapshot,
          dataCollectedAt: newerSnapshot.collectedAt,
          lastRefreshAt: newerSnapshot.collectedAt
        };
      }
      throw new Error("Temporary reader unavailable");
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.fallbackFailed, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 58% remaining");
  assert.equal(result.state.dataCollectedAt, newerSnapshot.collectedAt);
  assert.match(result.state.diagnostic, /optional temporary fallback could not be read/i);
  assert.equal(harness.calls.remove, 1);
});

test("a recoverable tab-readiness timeout does not overwrite refresh state", async () => {
  const initialState = {
    status: "analytics-no-new-data",
    diagnostic: "Analytics responded without new metrics."
  };
  const harness = createBackgroundHarness({ initialState });
  harness.context.chrome.tabs.get = async () => new Promise(() => {});

  await harness.run("waitForTabReadyOrDelay(42)");

  assert.deepEqual(
    harness.storage[ChatGPTUsageConfig.storageKeys.state],
    initialState
  );
});

test("refresh waits for late usage cards before saving the page snapshot", async () => {
  const completeSnapshot = visibleSnapshot();
  const partialSnapshot = {
    ...completeSnapshot,
    usage: {
      codex5h: completeSnapshot.usage.codex5h
    }
  };
  const lateSnapshot = {
    ...completeSnapshot,
    usage: {
      bankedResets: completeSnapshot.usage.bankedResets
    }
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(callNumber) {
      return callNumber <= 5 ? partialSnapshot : lateSnapshot;
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 60% remaining");
  assert.equal(result.state.snapshot.usage.bankedResets.structured.bankedResetCount, 2);
  assert.equal(result.state.snapshot.source, "requested-stable");
  assert.equal(harness.calls.sendMessage, 13);
});
