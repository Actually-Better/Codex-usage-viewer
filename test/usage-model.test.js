const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const { ChatGPTUsageModel } = require("../usage-model.js");

function readFixture(name) {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

const CASES = [
  {
    name: "Spanish standard wording",
    fixture: "es-standard.txt",
    expected: { codex5h: 72, codexWeekly: 18, codexSpark5h: 44, codexSparkWeekly: 8, credits: 123 }
  },
  {
    name: "Spanish alternative wording",
    fixture: "es-variant.txt",
    expected: { codex5h: 71, codexWeekly: 17, codexSpark5h: 44, codexSparkWeekly: 7, credits: 124 }
  },
  {
    name: "English standard wording",
    fixture: "en-standard.txt",
    expected: { codex5h: 64, codexWeekly: 12, codexSpark5h: 50, codexSparkWeekly: 7, credits: 91 }
  },
  {
    name: "English alternative wording",
    fixture: "en-variant.txt",
    expected: { codex5h: 63, codexWeekly: 11, codexSpark5h: 49, codexSparkWeekly: 6, credits: 92 }
  }
];

for (const { name, fixture, expected } of CASES) {
  test(`parseCodexUsageText parses ${name}`, () => {
    const usage = ChatGPTUsageModel.parseCodexUsageText(readFixture(fixture));

    assertPercentMetric(usage.codex5h, expected.codex5h);
    assertPercentMetric(usage.codexWeekly, expected.codexWeekly);
    assertPercentMetric(usage.codexSpark5h, expected.codexSpark5h);
    assertPercentMetric(usage.codexSparkWeekly, expected.codexSparkWeekly);
    assert.equal(usage.codexCredits.structured.remainingCredits, expected.credits);
    assert.equal(usage.remainingCredits.structured.remainingCredits, expected.credits);
    assert.match(usage.codex5h.structured.resetText, /\d{1,2}:\d{2}/);
    assert.match(usage.codexWeekly.structured.resetText, /\d{1,2}:\d{2}/);
  });
}

test("parseCodexUsageText handles compact visible text", () => {
  const compactText = readFixture("en-standard.txt").replace(/\s+/g, " ");
  const usage = ChatGPTUsageModel.parseCodexUsageText(compactText);

  assert.equal(usage.codex5h.structured.remainingPercent, 64);
  assert.equal(usage.codexWeekly.structured.remainingPercent, 12);
  assert.equal(usage.codexSpark5h.structured.remainingPercent, 50);
  assert.equal(usage.codexSparkWeekly.structured.remainingPercent, 7);
  assert.equal(usage.codexCredits.structured.remainingCredits, 91);
});

test("parseCodexUsageText exposes extraction confidence", () => {
  const standard = ChatGPTUsageModel.parseCodexUsageText(readFixture("en-standard.txt"));
  const variant = ChatGPTUsageModel.parseCodexUsageText(readFixture("es-variant.txt"));

  assert.equal(standard.codex5h.confidence, "high");
  assert.equal(standard.codex5h.structured.confidence, "high");
  assert.equal(standard.codexCredits.confidence, "high");
  assert.equal(variant.codexSpark5h.confidence, "high");
  assert.equal(variant.codexCredits.confidence, "low");
});

test("TERMS groups English and Spanish extraction concepts", () => {
  assert.ok(ChatGPTUsageModel.TERMS.remaining.includes("remaining"));
  assert.ok(ChatGPTUsageModel.TERMS.remaining.includes("restante"));
  assert.ok(ChatGPTUsageModel.TERMS.weekly.includes("weekly"));
  assert.ok(ChatGPTUsageModel.TERMS.weekly.includes("semanal"));
  assert.ok(ChatGPTUsageModel.TERMS.hours5.includes("5 hours"));
  assert.ok(ChatGPTUsageModel.TERMS.hours5.includes("5 horas"));
});

test("getUsageLevel classifies thresholds", () => {
  assert.equal(ChatGPTUsageModel.getUsageLevel(51), "green");
  assert.equal(ChatGPTUsageModel.getUsageLevel(50), "amber");
  assert.equal(ChatGPTUsageModel.getUsageLevel(15), "amber");
  assert.equal(ChatGPTUsageModel.getUsageLevel(14), "red");
  assert.equal(ChatGPTUsageModel.getUsageLevel(null), null);
});

test("normalizeMetricField prefers structured values", () => {
  const field = {
    value: "5h limit: 40% remaining; resets 14:30",
    structured: {
      label: "5h limit",
      remainingPercent: 40,
      resetText: "14:30"
    }
  };

  assert.deepEqual(ChatGPTUsageModel.normalizeMetricField(field, "5h limit"), field.structured);
});

function assertPercentMetric(field, expectedPercent) {
  assert.equal(field.structured.remainingPercent, expectedPercent);
  assert.ok(["high", "medium", "low"].includes(field.confidence));
  assert.equal(field.structured.confidence, field.confidence);
}
