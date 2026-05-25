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
  - Green: 50% or more remaining.
  - Amber: 15% to 49% remaining.
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

## Disclaimer

This project is not affiliated with OpenAI.

ChatGPT and Codex are trademarks or products of their respective owners. This extension only reads information visible in the web interface through the user's existing browser session.
