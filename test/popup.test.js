const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const popupHtml = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
const popupSource = readFileSync(join(__dirname, "..", "popup.js"), "utf8");

test("compact mode exposes an accessible persistent toggle", () => {
  assert.match(popupHtml, /id="compactModeToggle"[^>]+role="switch"/);
  assert.match(popupHtml, /body\.compact \.metric-list\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupHtml, /body\.compact #chatgptSection\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupSource, /storageKeys\.compactMode/);
  assert.match(popupSource, /document\.body\.classList\.toggle\("compact", enabled\)/);
  assert.match(popupSource, /classList\.add\("percentage-metric", `usage-\$\{usageLevel\}`\)/);
  assert.match(popupHtml, /body\.compact \.percentage-metric \.metric-value\s*{[^}]*conic-gradient/s);
  assert.match(popupHtml, /body\.compact \.percentage-metric \.progress\s*{[^}]*display:\s*none/s);
});

test("compact metric order produces the requested three pairs", () => {
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
    const index = popupSource.indexOf(`["${key}",`, previousIndex + 1);
    assert.ok(index > previousIndex, `${key} should follow the previous compact metric`);
    previousIndex = index;
  }
});
