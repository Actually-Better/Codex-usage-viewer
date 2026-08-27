const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CodexCapacityMonitor } = require("../capacity-monitor.js");

function snapshot(values = {}) {
  return {
    usage: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, metric(value)]))
  };
}

function metric(value, resetText = null) {
  if (value === null) return { value: null, structured: { remainingPercent: null } };
  if (typeof value !== "number") return { value: String(value), structured: { remainingPercent: value } };
  return { value: `${value}% remaining`, structured: { remainingPercent: value, resetText } };
}

function transition(previous, current, key = "codexWeekly") {
  const initial = CodexCapacityMonitor.evaluateSnapshot(snapshot({ [key]: previous }), null, {});
  return CodexCapacityMonitor.evaluateSnapshot(snapshot({ [key]: current }), initial.state, {});
}

for (const [previous, current, expected] of [
  [100, 90, null],
  [26, 25, "preventive"],
  [11, 10, "low"],
  [10, 9, null],
  [7, 5, "critical"],
  [5, 4, null],
  [1, 0, "exhausted"],
  [8, 100, "reset"],
  [0, 100, "reset"],
  [42, 42, null],
  [26, 4, "critical"]
]) {
  test(`transition ${previous} -> ${current}`, () => {
    const result = transition(previous, current);
    assert.equal(result.events[0] ? result.events[0].type : null, expected);
  });
}

test("the first observation establishes state without alerting", () => {
  const result = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 4 }), null, {});
  assert.equal(result.events.length, 0);
  assert.equal(result.visual.state, "critical");
});

test("only available valid counters participate", () => {
  const result = CodexCapacityMonitor.evaluateSnapshot(snapshot({
    codexWeekly: 42,
    codex5h: null,
    codexSpark5h: "invalid"
  }), null, {});
  assert.deepEqual(result.available.map((counter) => counter.key), ["codexWeekly"]);
  assert.equal(result.visual.badgeText, "42");
});

test("weekly and 5-hour counters are evaluated independently", () => {
  const initial = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 50, codex5h: 40 }), null, {});
  const result = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 10, codex5h: 5 }),
    initial.state,
    {}
  );
  assert.deepEqual(result.events.map((event) => [event.key, event.type]), [
    ["codexWeekly", "low"],
    ["codex5h", "critical"]
  ]);
  assert.equal(result.visual.counter.key, "codex5h");
  assert.equal(result.visual.badgeText, "5");
});

test("temporary 5-hour disappearance retains its prior observation", () => {
  const initial = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 50, codex5h: 11 }), null, {});
  const absent = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 49 }), initial.state, {});
  assert.equal(absent.events.length, 0);
  assert.equal(absent.state.counters.codex5h.remainingPercent, 11);
  assert.deepEqual(absent.state.availableKeys, ["codexWeekly"]);
  assert.deepEqual(absent.available.map((counter) => counter.key), ["codexWeekly"]);
  assert.deepEqual(
    CodexCapacityMonitor.extractFreshStateCounters(absent.state).map((counter) => counter.key),
    ["codexWeekly"]
  );

  const returned = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 48, codex5h: 10 }), absent.state, {});
  assert.equal(returned.events[0].key, "codex5h");
  assert.equal(returned.events[0].type, "low");
});

test("stale observations rebaseline instead of creating cross-account alerts", () => {
  const initial = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 80 }),
    null,
    {},
    "2026-08-26T08:00:00.000Z"
  );
  const result = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 5 }),
    initial.state,
    {},
    "2026-08-26T08:36:00.000Z"
  );

  assert.equal(result.events.length, 0);
  assert.equal(result.state.counters.codexWeekly.remainingPercent, 5);
});

test("one missed 15-minute refresh still allows a threshold crossing", () => {
  const initial = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 11 }),
    null,
    {},
    "2026-08-26T08:00:00.000Z"
  );
  const result = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 10 }),
    initial.state,
    {},
    "2026-08-26T08:30:30.000Z"
  );

  assert.equal(result.events[0].type, "low");
});

test("a 5-hour counter can appear later without a false first alert", () => {
  const initial = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 60 }), null, {});
  const result = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 59, codex5h: 5 }),
    initial.state,
    {}
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.visual.state, "critical");
  assert.equal(result.visual.badgeText, "5");
});

test("badge follows the lowest actually available percentage", () => {
  const both = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 14, codex5h: 68 }), null, {});
  assert.equal(both.visual.badgeText, "14");
  assert.match(both.visual.title, /14% remaining$/);
  assert.equal(both.visual.counter.key, "codexWeekly");

  const weeklyOnly = CodexCapacityMonitor.evaluateSnapshot(snapshot({ codexWeekly: 73 }), null, {});
  assert.equal(weeklyOnly.visual.badgeText, "73");
  assert.equal(weeklyOnly.visual.counter.key, "codexWeekly");
});

test("badge colors follow the same percentage levels as the usage ring with accessible text", () => {
  const cases = [
    { percent: 73, level: "green", textColor: "#000000" },
    { percent: 51, level: "green", textColor: "#000000" },
    { percent: 50, level: "amber", textColor: "#000000" },
    { percent: 15, level: "amber", textColor: "#000000" },
    { percent: 14, level: "red", textColor: "#ffffff" },
    { percent: 0, level: "red", textColor: "#ffffff" }
  ];

  for (const { percent, level, textColor } of cases) {
    const visual = CodexCapacityMonitor.evaluateSnapshot(
      snapshot({ codexWeekly: percent }),
      null,
      {}
    ).visual;
    assert.equal(CodexCapacityMonitor.classifyUsageLevel(percent), level);
    assert.equal(visual.badgeColor, CodexCapacityMonitor.BADGE_COLORS[level]);
    assert.equal(visual.badgeTextColor, textColor);
    assert.ok(contrastRatio(visual.badgeColor, visual.badgeTextColor) >= 4.5);
  }
});

function contrastRatio(firstColor, secondColor) {
  const luminance = (color) => {
    const channels = color.slice(1).match(/.{2}/g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const first = luminance(firstColor);
  const second = luminance(secondColor);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("disabled permanent percentage still exposes warning and critical badges", () => {
  const normal = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 73 }),
    null,
    { showRemainingPercentage: false }
  );
  assert.equal(normal.visual.badgeText, "");

  const warning = CodexCapacityMonitor.evaluateSnapshot(
    snapshot({ codexWeekly: 10 }),
    null,
    { showRemainingPercentage: false }
  );
  assert.equal(warning.visual.badgeText, "10");
});

test("notification and sound preferences are respected", () => {
  const lowEvent = { type: "low" };
  const resetEvent = { type: "reset" };
  assert.equal(CodexCapacityMonitor.shouldNotify(lowEvent, {}), true);
  assert.equal(CodexCapacityMonitor.shouldNotify(resetEvent, {}), true);
  assert.equal(CodexCapacityMonitor.shouldNotify(resetEvent, { notifyOnReset: false }), false);
  assert.equal(CodexCapacityMonitor.shouldNotify(lowEvent, { enableNotifications: false }), false);
  assert.equal(CodexCapacityMonitor.shouldPlaySound(lowEvent, {}), false);
  assert.equal(CodexCapacityMonitor.shouldPlaySound(lowEvent, { enableSounds: true }), true);
  assert.equal(CodexCapacityMonitor.shouldPlaySound(resetEvent, { enableSounds: true }), false);
});

test("custom thresholds are normalized and applied", () => {
  const settings = CodexCapacityMonitor.normalizeSettings({ lowThreshold: 12, criticalThreshold: 7 });
  assert.equal(CodexCapacityMonitor.detectTransition(13, 12, settings), "low");
  assert.equal(CodexCapacityMonitor.detectTransition(8, 7, settings), "critical");
  assert.deepEqual(CodexCapacityMonitor.normalizeSettings({ lowThreshold: 3, criticalThreshold: 8 }), {
    ...CodexCapacityMonitor.DEFAULT_SETTINGS,
    lowThreshold: 3,
    criticalThreshold: 3
  });
  assert.deepEqual(CodexCapacityMonitor.normalizeSettings({ lowThreshold: "", criticalThreshold: "  " }), {
    ...CodexCapacityMonitor.DEFAULT_SETTINGS
  });
});
