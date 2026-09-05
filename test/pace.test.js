const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CodexCapacityMonitor: monitor } = require("../capacity-monitor.js");

const start = Date.parse("2026-09-05T08:00:00Z");
const minute = 60000;

function refresh(state, minutes, values) {
  const usage = Object.fromEntries(Object.entries(values).map(([key, remainingPercent]) => [
    key, { structured: { remainingPercent } }
  ]));
  return monitor.evaluateSnapshot({ usage }, state, {}, new Date(start + minutes * minute).toISOString()).state;
}

function estimate(state, minutes, key = "codex5h", percent = state.counters[key]?.remainingPercent) {
  return monitor.estimateTimeRemaining(state.pace, key, percent, start + minutes * minute);
}

test("each limit estimates exhaustion from its own confirmed refreshes", () => {
  let state = refresh(null, 0, { codex5h: 80, codexWeekly: 90 });
  state = refresh(state, 15, { codex5h: 70, codexWeekly: 85 });
  assert.equal(estimate(state, 15).durationMs, 105 * minute);
  assert.equal(estimate(state, 15, "codexWeekly").durationMs, 255 * minute);
  assert.equal(monitor.formatPaceEstimate(estimate(state, 15)), "≈ 1 h 45 min left at this pace");
});

test("first and near-simultaneous readings cannot invent a pace", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  assert.equal(estimate(state, 0).status, "learning");
  state = refresh(state, 0, { codex5h: 79 });
  assert.equal(state.pace.codex5h.length, 1);
  state = refresh(state, 0.5, { codex5h: 78 });
  assert.equal(estimate(state, 0.5).status, "learning");
});

test("flat usage is idle and exhaustion needs no calculated rate", () => {
  let state = refresh(null, 0, { codex5h: 50 });
  state = refresh(state, 15, { codex5h: 50 });
  assert.equal(estimate(state, 15).status, "idle");
  state = refresh(state, 30, { codex5h: 0 });
  assert.equal(estimate(state, 30).status, "exhausted");
  assert.equal(monitor.formatPaceEstimate(estimate(state, 30)), "Limit reached");
});

test("capacity recovery restarts only the affected limit", () => {
  let state = refresh(null, 0, { codex5h: 20, codexWeekly: 80 });
  state = refresh(state, 15, { codex5h: 10, codexWeekly: 70 });
  state = refresh(state, 30, { codex5h: 100, codexWeekly: 60 });
  assert.equal(estimate(state, 30).status, "learning");
  assert.equal(estimate(state, 30, "codexWeekly").durationMs, 90 * minute);
});

test("missing counters restart history and do not fabricate estimates", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  state = refresh(state, 15, {});
  assert.equal(estimate(state, 15).status, "unavailable");
  state = refresh(state, 30, { codex5h: 60 });
  assert.equal(estimate(state, 30).status, "learning");
});

test("stale or mismatched displayed values never reuse a confirmed estimate", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  state = refresh(state, 15, { codex5h: 70 });
  assert.equal(estimate(state, 51).status, "unavailable");
  assert.equal(estimate(state, 15, "codex5h", 69).status, "unavailable");
  assert.equal(estimate(state, 14).status, "unavailable");
});

test("one-hour refresh intervals retain pace independently of alert expiration", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  state = refresh(state, 60, { codex5h: 60 });
  assert.equal(estimate(state, 60).durationMs, 180 * minute);
  state = refresh(state, 151, { codex5h: 40 });
  assert.equal(estimate(state, 151).status, "learning");
});

test("recent pace includes idle intervals and drops old consumption", () => {
  let state = refresh(null, 0, { codex5h: 100 });
  state = refresh(state, 30, { codex5h: 60 });
  for (const minutes of [60, 90, 120, 150]) state = refresh(state, minutes, { codex5h: 60 });
  assert.equal(estimate(state, 150).status, "idle");
  assert.equal(state.pace.codex5h[0].at, start + 30 * minute);
});

test("an estimate stays tied to the last refresh until new data or expiration", () => {
  let state = refresh(null, 0, { codex5h: 100 });
  for (const minutes of [30, 60, 90, 120]) state = refresh(state, minutes, { codex5h: 60 });
  assert.equal(estimate(state, 120).durationMs, 180 * minute);
  assert.equal(estimate(state, 140).durationMs, 180 * minute);
});

test("pace survives storage serialization and keeps bounded local metadata", () => {
  let state = refresh(null, 0, { codex5h: 100 });
  state = monitor.normalizeMonitorState(JSON.parse(JSON.stringify(state)));
  state = refresh(state, 15, { codex5h: 90 });
  assert.equal(estimate(state, 15).durationMs, 135 * minute);
  for (let i = 1; i <= 200; i++) state = refresh(state, 15 + i / 10, { codex5h: 90 });
  assert.equal(state.pace.codex5h.length, 121);
  assert.deepEqual(Object.keys(state.pace.codex5h[0]), ["at", "remainingPercent"]);
});

test("clock reversal restarts collection instead of deriving a negative rate", () => {
  let state = refresh(null, 30, { codex5h: 80 });
  state = refresh(state, 15, { codex5h: 70 });
  assert.equal(estimate(state, 15).status, "learning");
});

test("formatting covers short durations, hour/day boundaries and missing history", () => {
  for (const [minutes, expected] of [[0.1, "<1 min"], [10, "10 min"], [60, "1 h"], [1440, "1 d"], [1500, "1 d 1 h"]]) {
    assert.equal(monitor.formatPaceEstimate({ status: "estimated", durationMs: minutes * minute }), `≈ ${expected} left at this pace`);
  }
  assert.equal(monitor.estimateTimeRemaining(null, "codex5h", 30).status, "unavailable");
  assert.equal(monitor.estimateTimeRemaining({ codex5h: [null, { at: NaN, remainingPercent: 40 }] }, "codex5h", 30).status, "unavailable");
});
