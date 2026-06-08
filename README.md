# Codex Usage Viewer

Local-only Chrome/Edge extension that shows visible ChatGPT/Codex usage information from the current browser session.

It is intended for developers and power users who want a small usage popup while working with ChatGPT and Codex.

## What it does

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

## What it does not do

- It does not use private OpenAI APIs.
- It does not collect or store passwords.
- It does not send data to external servers.
- It does not store conversation content.
- It does not guarantee exact limits when ChatGPT does not expose them in the UI.

## Important limitations

This extension reads visible UI text from `chatgpt.com` / `chat.openai.com`.

Some values may be unavailable depending on:

- your plan
- your region
- language settings
- A/B tests
- OpenAI frontend changes
- whether the Codex analytics page exposes usage cards to your account

When exact usage is not visible, the extension will show it as unavailable rather than inventing a value.

## Installation for local development

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

## Screenshots

Screenshots are recommended before sharing the project publicly on GitHub:

- Popup with visible Codex usage.
- Popup when usage is unavailable.
- Collapsed and expanded diagnostics.

Do not include screenshots with account names, email addresses, workspace names, or private usage details.

## Privacy

This project is designed to be local-only:

- No external backend.
- No third-party telemetry.
- No password collection.
- No conversation-content storage.
- Uses the existing browser session.
- Stores derived metadata and timestamps in `chrome.storage.local`.

## Project files

```text
background.js
content-script.js
manifest.json
popup.html
popup.js
usage-model.js
README.md
```

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
- Confirm `chrome://extensions` shows only the expected permissions.
- Check that diagnostics do not expose conversation text or credentials.

## Disclaimer

This project is not affiliated with OpenAI.

ChatGPT and Codex are trademarks or products of their respective owners. This extension only reads information visible in the web interface through the user's existing browser session.
