# Changelog

All notable user-facing changes are documented here.

## Unreleased

- Add persisted remaining-capacity states for preventive (25%), configurable low/critical thresholds, exhausted (0%), and reset-to-100% transitions.
- Add larger dynamically rendered toolbar percentages based on the lowest actually available limit, with a native-badge fallback and a setting to hide the permanent percentage outside warning/critical states.
- Seed upgrade baselines only from recent signed-in snapshots, expire stale observations with scheduling tolerance and clear their persistent alerts, serialize initialization, sign-out suppression, accepted reads, and notification opt-out, discard pre-logout refresh data and rebaseline after in-place authentication, require five consecutive per-counter observations for alerts, restore visuals only from confirmed limits in the last accepted read, evaluate alerts only from accepted refresh reads, and clear visible capacity notifications on recovery or opt-out.
- Add deduplicated native notifications for low, critical, exhausted, and optional reset events, plus optional offscreen audio that is disabled by default.
- Treat the 5-hour limit as optional throughout alerts and badge calculations; missing, null, or invalid counters never become a false 0%.
- Add compact Settings controls for notifications, reset notifications, toolbar percentage, low/critical thresholds, and sounds.
- Stop opening Analytics when the popup merely opens; manual refresh now creates an inactive temporary Analytics tab, reads it completely, and closes only the tab created by the extension without changing focus.
- Keep an optional **Visit Analytics** button that deliberately opens or focuses Analytics, including its existing browser window, without making it a refresh prerequisite.
- Reuse Analytics only when it is already the active page; from every other page, open a new inactive temporary page even if Analytics exists in the background.
- Give 15-minute refreshes the same background-tab fallback when Analytics is closed, fails, or returns no metrics; recreate the periodic alarm whenever the background worker starts if it is missing.
- Close scheduled sign-in tabs, preserve newer content-script snapshots during fallback failures, guide the user to manual refresh when authentication is required, and honor a manual refresh that joins at any point before cleanup.
- Make the compact paired layout the only popup layout, with login/plan, 5-hour/weekly limits, Spark limits, and credits/banked full resets.
- Use small color-coded circular gauges for percentage metrics.
- Reuse the single retained background sign-in tab across repeated manual refreshes instead of accumulating duplicate Analytics tabs.
- Release retained-tab ownership when the user activates Analytics or opens it through **Visit Analytics**, and replace stale retained tabs when a popup joins an alarm refresh.
- Recheck a temporary tab immediately before cleanup, preserve it if the user activated it, and keep inactive page-driven redirects under extension ownership.
- Track temporary-tab activation throughout the full read so a tab remains user-owned even after the user switches away again.
- Release retained-tab ownership whenever its tab is activated between refreshes, and do not reacquire ownership after activation during a read.
- Keep activation tracking installed through asynchronous cleanup so last-moment adoption cannot be missed.
- Serialize retained-tab ownership updates so a stale release cannot erase a concurrently retained replacement.
- Prefer an existing retained sign-in tab over a newly created duplicate, and preserve it if the user adopts it while its ownership is being checked.
- Scope retained-tab ownership to the browser session, reuse inactive sign-in redirects without treating them as user adoption, and remove owned sign-in tabs after any refresh confirms authentication.
- Keep the popup dimensions and cached metrics stable while refreshing in Microsoft Edge.
- Prevent concurrent refreshes and preserve valid Analytics usage when ordinary ChatGPT pages load.
- Distinguish the latest data collection time from the latest refresh attempt.
- Show the successful refresh age in friendly form, such as `Last refresh: 5 min ago`, while preserving exact timestamps in diagnostics.
- Label preserved metrics as cached usage after a failed or timed-out refresh instead of incorrectly reporting all usage as unavailable.
- Treat a responsive Analytics page with no newly detected metrics as an incomplete refresh, not a load failure, and update the open popup when delayed values arrive through local storage.
- Replace the fixed long read with adaptive 400 ms sampling for up to 10 seconds, a minimum observation window after the first metric, and five stable merged reads.
- Read bounded usage-card DOM and accessible values (`aria-valuenow`, `aria-valuetext`, progress bars, and `datetime`) independently from the page-text fallback.
- Merge fields found across different snapshots and parse structured/fallback channels separately to avoid losing late cards or double-counting full resets.
- Observe delayed Codex Analytics DOM updates instead of relying on a single initial snapshot.
- Show banked full-reset count and expiration from visible English or Spanish UI text, including singular `Restablecimiento completo` cards that imply a count of one without displaying a digit.
- Preserve the Spanish card label `Restablecimiento completo` and prevent expiry-day numbers from being mistaken for the banked-reset count.
- Add refresh-orchestration tests alongside the English and Spanish parser fixtures.

## 0.1.0 - 2026-06-08

- Initial local-only Chrome/Edge extension for visible ChatGPT/Codex usage information.
- Reads visible Codex Analytics usage cards from the user's existing browser session.
- Shows 5-hour, weekly, Codex-Spark, and credit values when ChatGPT exposes them in page text.
- Highlights remaining-usage percentages as green, amber, or red.
- Detects visible login and plan signals when available.
- Provides a manual action to open the Codex usage page.
- Includes redacted diagnostics copying for issue reports.
- Stores derived usage metadata and timestamps in `chrome.storage.local`.
- Includes parser tests for English, Spanish, and compact visible Codex Analytics text.
