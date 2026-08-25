const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const popupHtml = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
const popupSource = readFileSync(join(__dirname, "..", "popup.js"), "utf8");

test("the popup uses the compact layout without a mode toggle", () => {
  assert.doesNotMatch(popupHtml, /compactModeToggle|compact-toggle|toggle-track|body\.compact/);
  assert.doesNotMatch(popupSource, /storageKeys\.compactMode|applyCompactMode|saveCompactMode/);
  assert.match(popupHtml, /\.other-limits-list\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupHtml, /#chatgptSection\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupSource, /classList\.add\("percentage-metric", `usage-\$\{usageLevel\}`\)/);
  assert.match(popupHtml, /\.percentage-metric \.metric-value\s*{[^}]*conic-gradient/s);
});

test("account metadata has no redundant ChatGPT section heading", () => {
  assert.doesNotMatch(popupHtml, /<h2>ChatGPT<\/h2>/);
  assert.match(popupHtml, /<section class="account-section">\s*<dl id="chatgptSection"><\/dl>/s);
});

test("metrics are grouped into primary limits, other limits, and totals", () => {
  const orderedKeys = [
    "codex5h",
    "codexWeekly",
    "codexSpark5h",
    "codexSparkWeekly",
    "codexCredits",
    "bankedResets"
  ];
  let previousIndex = -1;

  for (const key of orderedKeys) {
    const index = popupSource.indexOf(`, "${key}",`, previousIndex + 1);
    assert.ok(index > previousIndex, `${key} should follow the previous metric`);
    previousIndex = index;
  }

  assert.match(popupHtml, /id="primaryLimits" class="primary-limits"/);
  assert.match(popupHtml, /<details id="otherLimits" class="inline-disclosure">\s*<summary>Other limits<\/summary>/s);
  assert.match(popupHtml, /id="totalsSection" class="totals-list"/);
});

test("refresh age sits immediately before Refresh in the action cluster", () => {
  assert.match(
    popupHtml,
    /class="refresh-cluster">\s*<span id="statusAge">[^<]+<\/span>\s*<button id="refreshButton"[^>]*>Refresh<\/button>/s
  );
});

test("visible usage is presented as one concise status message", () => {
  assert.match(popupHtml, /class="status-copy">\s*<strong id="statusTitle">/s);
  assert.doesNotMatch(popupHtml, /status-divider/);
  assert.match(popupSource, /statusTitle\.textContent = "Usage visible in ChatGPT"/);
  assert.match(popupSource, /statusDetail\.textContent = ""/);
});

test("unavailable metrics render one dash without redundant copy", () => {
  const unavailableRenderer = popupSource.slice(
    popupSource.indexOf("function renderUnavailableCard"),
    popupSource.indexOf("function renderVisibleFields")
  );
  assert.match(unavailableRenderer, /value\.textContent = "-"/);
  assert.doesNotMatch(unavailableRenderer, /Usage unavailable/);
});
