# Equationeer

A Chrome extension that turns any highlighted math equation into a deep, intuitive explanation powered by Claude AI — without leaving the page you're reading.

## Features

- **Highlight-to-Explain** — select any equation, click the floating `Σ Explain` tooltip (or press `Alt+E`)
- **Screenshot Mode** — draw a rectangle over image-rendered math (PDFs, slides) and explain it via Claude Vision
- **Three depth levels** — Grad / Undergrad / Curious, switchable per explanation
- **Streaming output** — tokens appear as Claude generates them, no waiting for the full response
- **Follow-up chat** — ask clarifying questions scoped to the current equation
- **History** — every explanation is saved locally (IndexedDB); export as JSON or Markdown
- **Dark / Light / System theme**

## Installation

### From source

```bash
git clone <repo>
cd equationeer
npm install
npm run build       # outputs to dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `dist/` folder
4. The Equationeer icon appears in the toolbar

> **First launch:** the Settings page opens automatically. Enter your Anthropic API key and click Validate.

### Allow access to local PDFs (optional)

On `chrome://extensions`, click **Details** under Equationeer → enable **Allow access to file URLs**.

> Note: Chrome's built-in PDF viewer runs in an isolated context — content scripts cannot access the PDF DOM. Use **Screenshot Mode** for PDFs regardless.

## Getting an API key

1. Go to <https://console.anthropic.com/settings/keys>
2. Create a new key
3. Paste it into Equationeer Settings → validate → save

Your key is stored in `chrome.storage.local` (encrypted at rest by Chrome) and is only ever sent to `api.anthropic.com`.

## Usage

### Text selection

1. Select any math on a webpage
2. Click the **Σ Explain** pill that appears above the selection
   — or press **Alt+E** to explain the current selection without the tooltip

### Screenshot Mode (PDFs and rendered images)

1. Click the Equationeer icon in the toolbar → **Screenshot Mode**
2. Drag a rectangle over the equation on screen
3. The cropped image is sent to Claude with vision; explanation streams into the side panel

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+E` | Explain current text selection |
| `Alt+Shift+E` | Open the Equationeer popup |

## Architecture

```
User selects text / takes screenshot
         │
    Content Script
  (tooltip, overlay, screenshot crop)
         │  QUEUE_PENDING → chrome.storage.session
         │  OPEN_SIDE_PANEL → Background SW
         │
    Side Panel (React)
  reads chrome.storage.session on mount
         │  EXPLAIN_MATH / EXPLAIN_IMAGE
         ▼
    Background Service Worker
  (rate limiting, prompt building)
         │  fetch() SSE stream
         ▼
    Anthropic API  (claude-sonnet-4-6)
         │  STREAM_CHUNK / STREAM_DONE / STREAM_ERROR
         ▼
    Side Panel renders tokens as they arrive
```

**Why session storage?** The side panel takes a moment to mount and register its message listeners. If the background broadcast stream events before the panel was ready, they would be lost. Storing the request in `chrome.storage.session` and having the side panel read it on mount guarantees the panel is ready before the first API call starts.

## Development

```bash
npm run dev     # Vite dev server with @crxjs/vite-plugin HMR
npm run build   # Production build → dist/
```

### Debugging each context

| Context | How to open DevTools | Log prefix |
|---|---|---|
| Service worker | `chrome://extensions` → "service worker" link | `[EQ:SW]` |
| Side panel | Right-click inside panel → Inspect | `[EQ:SP]` |
| Content script | DevTools on the target page → Console | `[EQ:api]` |
| Popup / Options | Right-click the page → Inspect | — |

## Troubleshooting

**Loading spinner that never resolves**
- Open the service worker DevTools (see above) and check the console for `[EQ:SW]` errors
- Most common cause: API key not set — open Settings and add your Anthropic key
- Second cause: the extension was reloaded without rebuilding — run `npm run build` and reload

**Tooltip doesn't appear**
- Refresh the page — content scripts are injected on page load, not on extension reload
- Some pages block content scripts (Chrome internal pages, Web Store, etc.)

**PDF text selection doesn't work**
- Chrome's native PDF viewer isolates its DOM from content scripts. Use **Screenshot Mode** instead
- For `file://` PDFs, also ensure "Allow access to file URLs" is enabled in the extension details

**"API 400" error in the panel**
- Usually a wrong or revoked API key — re-validate in Settings

**Rate limit warning**
- The extension caps requests at 30 per minute with a 500 ms debounce. Wait and retry.

## Privacy

See [PRIVACY.md](PRIVACY.md). No data leaves your device except for the selected text / image sent to the Anthropic API using your own key. No telemetry, no analytics.
