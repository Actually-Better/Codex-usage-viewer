const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const { ChatGPTUsageConfig, ChatGPTUsageModel } = require("../usage-model.js");
const backgroundSource = readFileSync(join(__dirname, "..", "background.js"), "utf8");

function createBackgroundHarness({ tabs = [], snapshot = null, sendError = null, initialState = {} } = {}) {
  const storage = {
    [ChatGPTUsageConfig.storageKeys.state]: initialState,
    [ChatGPTUsageConfig.storageKeys.counters]: ChatGPTUsageModel.defaultCounters(1)
  };
  const calls = { create: 0, createArgs: [], remove: 0, removedTabIds: [], update: 0, updateArgs: [], sendMessage: 0, messages: [] };
  const listeners = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    alarms: {
      async create() {},
      async get() { return { name: ChatGPTUsageConfig.refreshAlarmName }; },
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
    tabs: {
      async query() { return tabs; },
      async create(args) {
        calls.create += 1;
        calls.createArgs.push(args);
        return { id: 99, url: args.url, status: "complete" };
      },
      async remove(tabId) {
        calls.remove += 1;
        calls.removedTabIds.push(tabId);
      },
      async update(tabId, args) {
        calls.update += 1;
        calls.updateArgs.push({ tabId, ...args });
        return { id: tabId, ...args };
      },
      async sendMessage(_tabId, message) {
        calls.sendMessage += 1;
        calls.messages.push(message);
        if (sendError) throw sendError;
        return typeof snapshot === "function" ? snapshot(calls.sendMessage) : snapshot;
      },
      async get(tabId) { return { id: tabId, status: "complete" }; },
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
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

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

test("popup refresh creates an inactive temporary Analytics tab and closes it after reading", async () => {
  const harness = createBackgroundHarness({ snapshot: visibleSnapshot() });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.match(harness.calls.createArgs[0].url, /settings\/analytics/);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.remove, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
});

test("periodic refresh does not create Analytics when it is not already open", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: visibleSnapshot(),
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.sendMessage, 0);
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
  assert.equal(harness.calls.update, 1);
  assert.deepEqual(harness.calls.updateArgs, [{ tabId: 99, active: true }]);
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
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", status: "complete" }]
  });

  const result = await harness.run("openCodexAnalyticsPage()");

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(harness.calls.create, 0);
  assert.deepEqual(harness.calls.updateArgs, [{ tabId: 42, active: true }]);
});

test("concurrent popup refreshes share one Analytics collection", async () => {
  const snapshot = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", status: "complete" }],
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
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", status: "complete" }],
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
  assert.equal(harness.calls.sendMessage, 25);
});

test("refresh failure requires the Analytics content script to be unreachable", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", status: "complete" }],
    sendError: new Error("Receiving end does not exist")
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "content-script-unavailable");
  assert.match(result.error, /Receiving end does not exist/);
  assert.equal(harness.calls.sendMessage, 25);
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
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", status: "complete" }],
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
