# Codex Usage Viewer

Local-only Chrome/Edge extension that shows visible ChatGPT/Codex usage information from the current browser session.

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

This extension reads visible UI text from `chatgpt.com` / `chat.openai.com`.

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

The extension reads visible UI text only. It does not call private OpenAI APIs, hidden account endpoints, external services, or telemetry collectors.

Codex usage extraction is centralized in `usage-model.js`. The parser normalizes visible text, matches language-aware usage concepts, and returns structured metrics for 5-hour limits, weekly limits, credits, and reset text when those values are visible.

The extraction terms currently cover English and Spanish. Instead of depending on exact labels, the parser matches concepts such as `5h`, `5-hour`, `5 hours`, `5 horas`, `weekly`, `week`, `semanal`, `remaining`, `left`, `restante`, `credits`, `credit balance`, and `creditos`.

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

- Click **Refresh** to let the extension load the Codex usage page in the background and read visible usage values.
- Click **Open Codex Usage Page** if automatic refresh cannot find usage values.
- Open **Diagnostics** only when troubleshooting. It shows extractor version, page detection, visible fields, and local refresh timing.
- Use **Copy diagnostics** when opening an issue. The copied payload is redacted and omits raw page text, full URLs, conversation content, and account identifiers.

## Troubleshooting

- **Open ChatGPT to refresh**: open ChatGPT in a tab and sign in, then click **Refresh**.
- **Sign in required**: sign in through ChatGPT. The extension never asks for credentials.
- **Usage unavailable**: open the Codex usage page manually and confirm usage values are visible there.
- **Visible in browser but not in popup**: copy diagnostics and include the extension version, browser, language, and whether the Codex usage page opens manually.
- **Stale values**: click **Open Codex Usage Page**, wait for it to load, then return to the popup and refresh.

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
- `npm test` runs parser tests for English, Spanish, and compact visible Codex Analytics text.
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
