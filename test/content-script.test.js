const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { ChatGPTUsageModel } = require("../usage-model.js");

function createReader(url) {
  let listener;
  let mutation;
  let scheduled;
  const deliveries = [];
  const location = new URL(url);
  const main = {
    innerText: readFileSync(join(__dirname, "fixtures/settings-usage-overview-en.txt"), "utf8"),
    querySelectorAll: () => []
  };
  const context = vm.createContext({
    ChatGPTUsageModel, location,
    document: {
      body: main, readyState: "complete",
      querySelector: (selector) => selector === "main" ? main : null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { deliveries.push(message); }
    } },
    MutationObserver: class {
      constructor(fn) { mutation = fn; }
      observe() {}
    },
    setTimeout(fn) { scheduled = fn; return 1; }
  });
  vm.runInContext(readFileSync(join(__dirname, "../content-script.js"), "utf8"), context);
  return {
    main, location, deliveries,
    collect() {
      let snapshot;
      listener({ type: "usage:collectSnapshot" }, {}, (value) => { snapshot = value; });
      return snapshot;
    },
    mutate() { mutation(); },
    deliver() { const fn = scheduled; scheduled = null; if (fn) fn(); }
  };
}

test("the new Usage URL returns an accepted snapshot with the screenshot balances", () => {
  const snapshot = createReader("https://chatgpt.com/settings/usage?tab=overview").collect();
  assert.equal(snapshot.codexAnalytics.pageDetected, true);
  assert.equal(snapshot.pathCategory, "usage");
  assert.equal(snapshot.loginStatus, "logged-in");
  assert.equal(snapshot.usage.codex5h.value, null);
  assert.equal(snapshot.usage.codexWeekly.structured.remainingPercent, 0);
  assert.equal(snapshot.usage.codexWeekly.structured.resetText, "in 4d 11h");
  assert.equal(snapshot.usage.codexCredits.structured.remainingCredits, 1925);
  assert.equal(snapshot.usage.bankedResets.structured.bankedResetCount, 0);
});

test("late content and SPA navigation to settings usage trigger fresh readings", () => {
  const reader = createReader("https://chatgpt.com/");
  reader.deliver();
  assert.equal(reader.deliveries[0].payload.codexAnalytics, null);
  reader.location.href = "https://chatgpt.com/settings/usage?tab=overview";
  reader.mutate();
  reader.deliver();
  assert.equal(reader.deliveries[1].payload.usage.codexWeekly.structured.remainingPercent, 0);
  reader.main.innerText = reader.main.innerText.replace("0% left", "60% left");
  reader.mutate();
  reader.deliver();
  assert.equal(reader.deliveries[2].payload.usage.codexWeekly.structured.remainingPercent, 60);
});
