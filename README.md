# Paper Trail — Procedure Recorder

**Record any procedure as semantic steps. Generate an illustrated SOP — or a runnable automation — with Claude or GPT. Screenshots never leave your machine unless you say so.**

A standalone Chrome extension (Manifest V3) with an optional Windows companion. No server, no build step, no frameworks.

```
Clicks & fields (DOM / UIA)  ──►  Semantic step ledger  ──►  LLM  ──►  SOP (.md/.html)
        + annotated shots           (labels, selectors,              or PowerShell .ps1
          kept local                 anchors = ground truth)         or AA build sheet
```

## Why it's different

- **Semantic capture, not video.** The DOM and the Windows UI Automation tree already know what you clicked. Paper Trail records the element's real name, kind, and a replay-grade anchor (CSS selector / `AutomationId`) — no vision model guessing button labels from pixels.
- **The privacy inversion.** By default only the text action log goes to the model; it writes around `{{screenshot_N}}` tokens and the real images are spliced in locally at export. A fully illustrated document from a model that never saw your screen — built for regulated environments.
- **Documentation and automation from one recording.** The same anchors that illustrate an SOP can drive a Selenium/UIA PowerShell script or an Automation Anywhere build sheet. Automation export is always text-only.

## Feature matrix

| Capture | How | Semantics |
|---|---|---|
| Web (any site) | Content script, capture-phase DOM events | Full — labels + verified CSS selectors |
| Desktop, window-capture mode | `getDisplayMedia` + change-detection, global `Ctrl+Shift+9` | None — frame is the meaning |
| Desktop, UIA companion | Native messaging host: mouse hook → UI Automation tree | Full — Name, ControlType, AutomationId, ClassName |

**Providers:** Anthropic · OpenAI · any OpenAI-compatible URL (Open WebUI, Azure OpenAI via Open WebUI, vLLM, LiteLLM)

## Quick start

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Side panel → **⚙** → pick a provider, paste an API key
3. **● Start recording**, do the thing, **■ Stop**, **Generate**

Full guides: **[Install](docs/INSTALL.md)** · **[Usage](docs/USAGE.md)** · **[Design](docs/DESIGN.md)**

## Repository layout

```
manifest.json            MV3 manifest
background.js            Session ledger, screenshots, LLM clients, native port
content.js / content.css Semantic DOM capture + ripple
sidepanel.*              Recorder UI, window-capture engine, export
options.*                Provider + privacy settings
native-host/             Windows UIA companion (PowerShell 5.1+, embedded C#)
docs/                    DESIGN.md · INSTALL.md · USAGE.md
```

## Security posture (summary)

Capture is inert unless recording is on. Keys live in `chrome.storage.local` and go only to the endpoint you configured. Typed values masked by default; secret-like fields always. The UIA companion is per-user (HKCU), launched only by Chrome/Edge with your extension ID pinned, and exits on disconnect. Details: [DESIGN.md §6](docs/DESIGN.md#6-privacy--security-model).

## License

Internal use.
