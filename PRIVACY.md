# Privacy Policy — Equationeer

## Data Collection
Equationeer does **not** collect, store, or transmit any personal data to any server we control.

## What Data Leaves Your Device
The only data that leaves your device is the text or image you choose to explain, which is sent directly to the **Anthropic API** (api.anthropic.com) using your own API key. No intermediary servers are involved.

## Local Storage
- Your API key is stored in Chrome's `chrome.storage.local` (encrypted at rest by Chrome).
- Explanation history is stored in IndexedDB, entirely on your device.
- No cookies, no analytics, no tracking.

## Permissions Explained
- `storage` — Save your settings and API key locally.
- `activeTab` — Read selected text on the current page when you explicitly request an explanation.
- `scripting` — Inject the tooltip and selection UI into web pages.
- `sidePanel` — Display the explanation panel.
- `contextMenus` — Add a right-click "Explain with Equationeer" option.
- `<all_urls>` — Required to work on local PDFs (`file://`) and any academic website.

## Contact
For questions about privacy, open an issue on the project repository.
