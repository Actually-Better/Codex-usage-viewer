const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const popupHtml = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
const popupSource = readFileSync(join(__dirname, "..", "popup.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));
const offscreenSource = readFileSync(join(__dirname, "..", "offscreen.js"), "utf8");

test("the popup uses the compact layout without a mode toggle", () => {
  assert.doesNotMatch(popupHtml, /compactModeToggle|compact-toggle|toggle-track|body\.compact/);
  assert.doesNotMatch(popupSource, /storageKeys\.compactMode|applyCompactMode|saveCompactMode/);
  assert.match(popupHtml, /\.other-limits-list\s*{[^}]*grid-template-columns:\s*1fr/s);
  assert.doesNotMatch(popupHtml, /\.other-limits-list\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupHtml, /#chatgptSection\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupSource, /CodexCapacityMonitor\.classifyUsageLevel\(remainingPercent\)/);
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

test("an unavailable 5-hour limit moves below Other limits and leaves Weekly full width", () => {
  const renderer = popupSource.slice(
    popupSource.indexOf("function renderCodexCards"),
    popupSource.indexOf("function renderMetricCard")
  );

  assert.match(renderer, /const has5hData = hasMetricData\(snapshot, "codex5h"\)/);
  assert.match(renderer, /if \(has5hData\)\s*{\s*appendMetric\(primaryLimits, snapshot, "codex5h"/s);
  assert.match(renderer, /appendMetric\(primaryLimits, snapshot, "codexWeekly"/);
  assert.match(renderer, /if \(!has5hData\)\s*{\s*appendMetric\(otherLimits, snapshot, "codex5h"/s);
  assert.match(renderer, /field\.value !== undefined && field\.value !== null/);
  assert.match(renderer, /Number\.isFinite\(field\.structured\.remainingPercent\)/);
  assert.match(popupHtml, /\.primary-limits > \.metric-card:only-child\s*{[^}]*grid-column:\s*1 \/ -1/s);
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

test("percentage metrics explicitly describe remaining capacity", () => {
  assert.match(popupSource, /setAttribute\("aria-label", `\$\{structured\.remainingPercent\}% remaining`\)/);
  assert.match(popupSource, /remaining\.textContent = "Remaining"/);
});

test("unavailable metrics render one dash without redundant copy", () => {
  const unavailableRenderer = popupSource.slice(
    popupSource.indexOf("function renderUnavailableCard"),
    popupSource.indexOf("function renderVisibleFields")
  );
  assert.match(unavailableRenderer, /value\.textContent = "-"/);
  assert.doesNotMatch(unavailableRenderer, /Usage unavailable/);
});

test("capacity settings expose accessible persisted controls", () => {
  for (const id of [
    "enableNotifications",
    "notifyOnReset",
    "showRemainingPercentage",
    "lowThreshold",
    "criticalThreshold",
    "enableSounds"
  ]) {
    assert.match(popupHtml, new RegExp(`for="${id}"`));
    assert.match(popupHtml, new RegExp(`id="${id}"`));
  }
  assert.match(popupHtml, /Show remaining percentage on icon/);
  assert.match(popupHtml, /<script src="capacity-monitor\.js"><\/script>\s*<script src="popup\.js"><\/script>/s);
  assert.match(popupSource, /storageKeys\.capacitySettings/);
  assert.match(popupSource, /CodexCapacityMonitor\.normalizeSettings/);
});

test("settings expose a progressive automatic refresh slider with a 15-minute default", () => {
  assert.match(popupHtml, /<label for="refreshPeriodMinutes">Automatic refresh<\/label>/);
  assert.match(popupHtml, /<output id="refreshPeriodValue" for="refreshPeriodMinutes">15 minutes<\/output>/);
  assert.match(popupHtml, /<input id="refreshPeriodMinutes" type="range" min="1" max="60" step="1" value="15"/);
  assert.doesNotMatch(popupHtml, /<select id="refreshPeriodMinutes">/);
  assert.match(popupSource, /storageKeys\.refreshPeriodMinutes/);
  assert.match(popupSource, /normalizeRefreshPeriodMinutes/);
  assert.match(popupSource, /addEventListener\("input", previewRefreshPeriod\)/);
  assert.match(popupSource, /setAttribute\(\s*"aria-valuetext"/s);
});

test("manifest requests only the APIs required by capacity alerts", () => {
  assert.deepEqual(manifest.permissions, ["alarms", "notifications", "offscreen", "storage"]);
  assert.match(offscreenSource, /message\.type !== "capacity:playSound"/);
  assert.match(offscreenSource, /createOscillator\(\)/);
});
