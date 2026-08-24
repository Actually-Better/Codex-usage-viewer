# Changelog

All notable user-facing changes are documented here.

## Unreleased

- Stop opening Analytics when the popup merely opens; manual refresh now creates a normal inactive temporary Analytics tab, reads it completely, and closes only the tab created by the extension.
- Keep an optional **Visit Analytics** button for explicit user navigation without making it a refresh prerequisite.
- When manual refresh cannot obtain metrics from an existing Analytics page, retry automatically in a newly created temporary inactive page.
- Give 15-minute refreshes the same real temporary-tab fallback when Analytics is closed, fails, or returns no metrics.
- Close scheduled sign-in tabs without stealing focus, preserve newer content-script snapshots during fallback failures, and guide the user to manual refresh when authentication is required.
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
