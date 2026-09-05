const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CodexCapacityMonitor: monitor } = require("../capacity-monitor.js");

const start = Date.parse("2026-09-05T08:00:00Z");
const minute = 60000;

function refresh(state, minutes, values, sessionId = null) {
  const usage = Object.fromEntries(Object.entries(values).map(([key, remainingPercent]) => [
    key, { structured: { remainingPercent } }
  ]));
  return monitor.evaluateSnapshot({ usage }, state, {}, new Date(start + minutes * minute).toISOString(), sessionId).state;
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

test("first and near-simultaneous readings use a proportional initial estimate", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  assert.equal(estimate(state, 0).status, "nominal");
  state = refresh(state, 0, { codex5h: 79 });
  assert.equal(state.pace.codex5h.length, 1);
  state = refresh(state, 0.5, { codex5h: 78 });
  assert.equal(estimate(state, 0.5).status, "nominal");
});

test("half a window initially shows 2.5 hours or 3.5 days, then uses measured pace", () => {
  let state = refresh(null, 0, { codex5h: 50, codexWeekly: 50 }, "new-session");
  assert.equal(estimate(state, 0).durationMs, 150 * minute);
  assert.equal(monitor.formatPaceEstimate(estimate(state, 0)), "≈ 2 h 30 min left · initial estimate");
  assert.equal(estimate(state, 0, "codexWeekly").durationMs, 3.5 * 24 * 60 * minute);
  assert.equal(monitor.formatPaceEstimate(estimate(state, 0, "codexWeekly")), "≈ 3 d 12 h left · initial estimate");
  state = refresh(state, 15, { codex5h: 40, codexWeekly: 45 }, "new-session");
  assert.equal(estimate(state, 15).durationMs, 60 * minute);
  assert.equal(estimate(state, 15, "codexWeekly").durationMs, 135 * minute);
});

test("cached data from a previous browser session uses the proportional estimate before refresh", () => {
  let state = refresh(null, 0, { codex5h: 60 }, "old");
  state = refresh(state, 15, { codex5h: 50 }, "old");
  const result = monitor.estimateTimeRemaining(state.pace, "codex5h", 50, start + 20 * minute, false);
  assert.equal(result.status, "nominal");
  assert.equal(result.durationMs, 150 * minute);
});

test("a fresh weekly balance has a proportional estimate even without stored pace", () => {
  const now = start + 8 * minute;
  for (const pace of [null, {}, { codexWeekly: [] }]) {
    const result = monitor.estimateDisplayedTimeRemaining(pace, "codexWeekly", 7, start, now);
    assert.equal(result.status, "nominal");
    assert.equal(monitor.formatPaceEstimate(result), "≈ 11 h 45 min left · initial estimate");
  }
});

test("fresh displayed values use a proportional fallback until confirmed history catches up", () => {
  let state = refresh(null, 0, { codex5h: 60 });
  state = refresh(state, 15, { codex5h: 50 });
  const result = monitor.estimateDisplayedTimeRemaining(state.pace, "codex5h", 40, start + 20 * minute, start + 20 * minute);
  assert.equal(result.status, "nominal");
  assert.equal(result.durationMs, 120 * minute);
  state = refresh(state, 30, { codex5h: 40 });
  const measured = monitor.estimateDisplayedTimeRemaining(state.pace, "codex5h", 40, start + 30 * minute, start + 30 * minute);
  assert.equal(measured.status, "estimated");
  assert.equal(measured.durationMs, 60 * minute);
});

test("display fallbacks reject stale, invalid and future observations", () => {
  for (const observedAt of [NaN, start - 36 * minute, start + minute]) {
    assert.equal(monitor.estimateDisplayedTimeRemaining(null, "codex5h", 50, observedAt, start).status, "unavailable");
  }
  for (const percent of [null, NaN, -1, 101]) {
    assert.equal(monitor.estimateDisplayedTimeRemaining(null, "codex5h", percent, start, start).status, "unavailable");
  }
  assert.equal(monitor.estimateDisplayedTimeRemaining(null, "codexCredits", 50, start, start).status, "unavailable");
  assert.equal(monitor.estimateDisplayedTimeRemaining(null, "codex5h", 0, start, start).status, "exhausted");
});

test("flat usage is idle and exhaustion needs no calculated rate", () => {
  let state = refresh(null, 0, { codex5h: 50 });
  state = refresh(state, 15, { codex5h: 50 });
  assert.equal(estimate(state, 15).status, "idle");
  state = refresh(state, 30, { codex5h: 0 });
  assert.equal(estimate(state, 30).status, "exhausted");
  assert.equal(monitor.formatPaceEstimate(estimate(state, 30)), "Limit reached");
});

test("a reset projects 100 percent at the previous pace and the next reading adjusts it", () => {
  let state = refresh(null, 0, { codex5h: 20, codexWeekly: 80 });
  state = refresh(state, 15, { codex5h: 10, codexWeekly: 70 });
  state = refresh(state, 30, { codex5h: 100, codexWeekly: 60 });
  assert.equal(estimate(state, 30).durationMs, 150 * minute);
  assert.equal(estimate(state, 30, "codexWeekly").durationMs, 90 * minute);
  state = refresh(state, 45, { codex5h: 80, codexWeekly: 50 });
  assert.equal(estimate(state, 45).durationMs, 60 * minute);
});

test("a zero-to-100 reset reuses the pace measured before exhaustion", () => {
  let state = refresh(null, 0, { codex5h: 10 });
  state = refresh(state, 15, { codex5h: 0 });
  state = refresh(state, 30, { codex5h: 100 });
  assert.equal(estimate(state, 30).durationMs, 150 * minute);
});

test("a higher balance in a new browser session starts with the nominal windows", () => {
  let state = refresh(null, 0, { codex5h: 80, codexWeekly: 90 }, "first-session");
  state = refresh(state, 15, { codex5h: 70, codexWeekly: 85 }, "first-session");
  state = refresh(state, 30, { codex5h: 95, codexWeekly: 100 }, "second-session");
  assert.equal(estimate(state, 30).status, "nominal");
  assert.equal(estimate(state, 30).durationMs, 285 * minute);
  assert.equal(estimate(state, 30, "codexWeekly").durationMs, 7 * 24 * 60 * minute);
  assert.equal(monitor.formatPaceEstimate(estimate(state, 30)), "≈ 4 h 45 min left · initial estimate");
  assert.equal(monitor.formatPaceEstimate(estimate(state, 30, "codexWeekly")), "≈ 1 week left · initial estimate");
  state = refresh(state, 45, { codex5h: 85, codexWeekly: 95 }, "second-session");
  assert.equal(estimate(state, 45).durationMs, 127.5 * minute);
  assert.equal(estimate(state, 45, "codexWeekly").durationMs, 285 * minute);
});

test("long gaps discard the old rate but still recognize a recovered balance", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  state = refresh(state, 15, { codex5h: 70 });
  state = refresh(state, 300, { codex5h: 100 });
  assert.equal(estimate(state, 300).status, "nominal");
});

test("an inherited estimate survives worker state serialization within the browser session", () => {
  let state = refresh(null, 0, { codex5h: 80 }, "session");
  state = refresh(state, 15, { codex5h: 70 }, "session");
  state = refresh(state, 30, { codex5h: 100 }, "session");
  state = monitor.normalizeMonitorState(JSON.parse(JSON.stringify(state)));
  assert.equal(estimate(state, 30).durationMs, 150 * minute);
  state = refresh(state, 45, { codex5h: 90 }, "session");
  assert.equal(estimate(state, 45).durationMs, 135 * minute);
});

test("no measured prior consumption uses a provisional window until the next reading", () => {
  let state = refresh(null, 0, { codex5h: 50 });
  state = refresh(state, 15, { codex5h: 50 });
  state = refresh(state, 30, { codex5h: 100 });
  assert.equal(estimate(state, 30).status, "nominal");
  state = refresh(state, 45, { codex5h: 100 });
  assert.equal(estimate(state, 45).status, "idle");
});

test("missing counters restart history and do not fabricate estimates", () => {
  let state = refresh(null, 0, { codex5h: 80 });
  state = refresh(state, 15, {});
  assert.equal(estimate(state, 15).status, "unavailable");
  state = refresh(state, 30, { codex5h: 60 });
  assert.equal(estimate(state, 30).status, "nominal");
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
  assert.equal(estimate(state, 151).status, "nominal");
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
  assert.equal(estimate(state, 15).status, "nominal");
});

test("formatting covers short durations, hour/day boundaries and missing history", () => {
  for (const [minutes, expected] of [[0.1, "<1 min"], [10, "10 min"], [60, "1 h"], [1440, "1 d"], [1500, "1 d 1 h"]]) {
    assert.equal(monitor.formatPaceEstimate({ status: "estimated", durationMs: minutes * minute }), `≈ ${expected} left at this pace`);
  }
  assert.equal(monitor.estimateTimeRemaining(null, "codex5h", 30).status, "unavailable");
  assert.equal(monitor.estimateTimeRemaining({ codex5h: [null, { at: NaN, remainingPercent: 40 }] }, "codex5h", 30).status, "unavailable");
});
