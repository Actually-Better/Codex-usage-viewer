# Codex Usage Viewer

Local-only Chrome/Edge extension that shows usage rendered by ChatGPT/Codex in the current browser session.

It is intended for developers and power users who want a small usage popup while working with ChatGPT and Codex.

## Screenshots

No public screenshots are committed yet, because usage popups can contain private account details. Before sharing screenshots publicly, use sanitized captures that do not include account names, email addresses, workspace names, or private usage details.

Recommended screenshots:

- Popup with visible Codex usage.
- Popup when usage is unavailable.
- Collapsed and expanded diagnostics.

## Features

- Detects whether ChatGPT appears to be signed in.
- Detects the visible plan when the UI exposes it.
- Reads visible Codex usage cards when available.
- Shows 5-hour and weekly usage percentages when they are visible in the ChatGPT/Codex UI.
- Shows remaining credits when visible.
- Shows banked full-reset count and expiration when the Codex UI exposes `Banked resets`, `Full resets`, or `Restablecimiento completo`.
- Offers a persistent compact mode that pairs login/plan, 5-hour/weekly, Spark 5-hour/weekly, and credits/full resets into two-column rows.
- Highlights usage bars:
  - Green: more than 50% remaining.
  - Amber: 15% to 50% remaining.
  - Red: less than 15% remaining.
- Stores only local metadata in `chrome.storage.local`.

## Privacy

- It does not use private OpenAI APIs.
- It does not collect or store passwords.
- It does not send data to external servers.
- It does not store conversation content.
- It uses the existing browser session.
- It stores derived metadata and timestamps only in `chrome.storage.local`.
- It redacts diagnostics before copying them for issue reports.

## Limitations

This extension reads the rendered Codex Analytics UI from `chatgpt.com`.

Some values may be unavailable depending on:

- your plan
- your region
- language settings
- A/B tests
- OpenAI frontend changes
- whether the Codex analytics page exposes usage cards to your account

When exact usage is not visible, the extension will show it as unavailable rather than inventing a value.

- Usage appears only when ChatGPT/Codex exposes it in visible page text.
- It does not call private OpenAI APIs or background endpoints.
- It does not infer hidden limits, account entitlements, or exact reset behavior.
- Browser and account A/B tests can make values unavailable.
- Diagnostics are intentionally redacted and do not include raw page text.

## Compatibility

- Chrome and Edge extensions using Manifest V3.
- `https://chatgpt.com/*` and `https://chat.openai.com/*`.
- English and Spanish Codex usage text when the values are visible in the ChatGPT/Codex UI.

The extension may need parser updates when ChatGPT changes page structure, wording, model names, or the Codex usage page location.

## How extraction works

The extension reads rendered UI text and accessibility attributes only. It does not call private OpenAI APIs, hidden account endpoints, external services, or telemetry collectors.

For a manual refresh, the extension reuses Codex Analytics only when it is the currently active page. From every other page it creates an inactive temporary Analytics tab—even if another Analytics tab exists in the background—waits for its UI to render completely, and closes only the tab it created. The page you are using keeps focus throughout collection because Refresh requests an inactive tab; **Visit Analytics** is the separate action that deliberately activates Analytics. This is more reliable than embedding Analytics in a hidden frame and does not require the user to open or keep Analytics visible.

Codex usage extraction is centralized in `usage-model.js`. The parser normalizes visible text, matches language-aware usage concepts, and returns structured metrics for 5-hour limits, weekly limits, credits, banked full resets, expiration, and reset text when those values are visible.

The extraction terms currently cover English and Spanish. Instead of depending on exact labels, the parser matches concepts such as `5h`, `5-hour`, `5 hours`, `5 horas`, `weekly`, `week`, `semanal`, `remaining`, `left`, `restante`, `credits`, `credit balance`, `creditos`, `banked resets`, `full resets`, and `restablecimiento completo`.

Banked full resets are treated as a separate consumable resource used to reset counters. Their count and visible expiration text are not mixed with the normal reset time of a 5-hour or weekly usage window. When the UI omits a numeric count, each visible singular `Full reset` or `Restablecimiento completo` card counts as one.

Analytics is read through two independent DOM channels: bounded usage-card text and a page-text fallback. The structured channel also reads accessible values such as `aria-valuenow`, `aria-valuetext`, progress bars, and `<time datetime>`. The parsed fields are merged without concatenating duplicate card text.

Each detected metric includes extraction confidence:

- `high`: an explicit percentage or direct remaining-credit wording was detected.
- `medium`: the value is tied to nearby usage context.
- `low`: the value came from a weaker heuristic such as a credit balance label without remaining wording.

When a value cannot be found from visible text, the extension leaves that metric unavailable rather than guessing.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the project folder.
6. Open ChatGPT and sign in.
7. Click the extension icon.

## Usage

- Click **Refresh** from any page. You do not need to open Analytics first.
- Click **Visit Analytics** only when you want to inspect the source page yourself; it opens or reuses Analytics and deliberately gives that tab and window focus. It is optional for refresh.
- A manual refresh reuses Analytics only when you are already viewing it. From any other page it opens a temporary Analytics tab in the background, including when Analytics exists only in the background. The temporary tab is closed after reading without changing focus, unless you activate it at any point or navigate it elsewhere during collection; adopted tabs remain preserved even if you switch away again before reading finishes. If sign-in is required, it remains open in the background so you can select it and sign in through ChatGPT. Repeated refreshes reuse that retained sign-in tab instead of accumulating duplicates.
- The 15-minute periodic check uses the same background-tab recovery path. If its scheduled tab requires sign-in, it is closed and the popup asks you to run a manual refresh. The extension also repairs the periodic alarm whenever its background worker starts.
- Toggle **Compact** to show login with plan, the 5-hour limit with the weekly limit, both Spark limits together, and credits with banked full resets. Percentage metrics use small circular gauges instead of horizontal bars so they remain legible in two columns. The preference is stored locally and restored when the popup reopens.
- Each page attempt samples Analytics every 400 ms for up to 10 seconds. A fallback can therefore extend the full refresh, whose timeout is 45 seconds. The reader observes at least 13 reads after the first metric and requires five stable merged reads before accepting the snapshot. Metrics found in different reads are accumulated instead of replacing one another.
- The main status shows a friendly age such as **Last refresh: 5 min ago**. Diagnostics retain the exact collection and attempt timestamps.
- Open **Diagnostics** only when troubleshooting. It shows extractor version, page detection, visible fields, and local refresh timing.
- Use **Copy diagnostics** when opening an issue. The copied payload is redacted and omits raw page text, full URLs, conversation content, and account identifiers.

## Troubleshooting

- **Sign in required**: the automatically created Analytics tab remains open so you can sign in through ChatGPT. The extension never asks for credentials.
- **Usage unavailable**: open the Codex usage page manually only as a diagnostic check and confirm usage values are visible there.
- **Usage page detected**: Analytics responded, but no new values were recognized during that attempt. This is not treated as a load failure; the popup updates automatically if the content script reports values afterward.
- **Refresh failed**: Analytics loaded but did not respond to the extractor after all retries, or the temporary tab could not be created. Reload the unpacked extension and retry.
- **Visible in browser but not in popup**: copy diagnostics and include the extension version, browser, language, and whether the Codex usage page opens manually.
- **Stale values**: click **Refresh**. The popup distinguishes the successful data collection time from the latest refresh attempt.

## Project files

```text
background.js
content-script.js
package.json
manifest.json
popup.html
popup.js
test/
usage-model.js
README.md
```

## Development

No dependency install is required for the current checks. The test suite uses Node's built-in test runner and sanitized fixtures in `test/fixtures/`.

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

## Testing

- `npm run check` runs `node --check` against the extension JavaScript files.
- `npm test` runs English/Spanish parser tests and refresh-orchestration tests for caching, concurrency, and tab creation.
- Manual release testing should load the unpacked extension in Chrome or Edge and verify signed-in, signed-out, unavailable-usage, and visible-usage states when possible.

## Contributing

Keep the extension small and local-only:

- Do not add private OpenAI APIs.
- Do not add telemetry, analytics, or third-party services.
- Do not request additional permissions unless the README explains the user benefit and risk.
- Prefer visible-UI extraction that fails clearly over guessed values.
- Update `CHANGELOG.md` for user-visible changes.

## Release checklist

- Load the unpacked extension in Chrome or Edge.
- Verify the popup at normal and narrow widths.
- Test signed-in, signed-out, unavailable-usage, and visible-usage states when possible.
- Run `npm run check` and `npm test`.
- Confirm `chrome://extensions` shows only the expected permissions.
- Check that diagnostics do not expose conversation text or credentials.

## License

MIT. See `LICENSE`.

## Disclaimer

This project is not affiliated with OpenAI.

ChatGPT and Codex are trademarks or products of their respective owners. This extension only reads information visible in the web interface through the user's existing browser session.
