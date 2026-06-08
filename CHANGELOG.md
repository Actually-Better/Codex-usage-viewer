# Changelog

All notable user-facing changes are documented here.

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
