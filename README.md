# Paper Trail — Procedure Recorder

**Record any procedure as semantic steps. Generate an illustrated SOP — or a runnable automation — with Claude, GPT, or a fully local model. Screenshots never leave your machine unless you say so.**

A standalone Chrome extension (Manifest V3) with an optional Windows companion. No server, no build step, no frameworks, no dependencies.

```
Clicks & fields (DOM / UIA)  ──►  Semantic step ledger  ──►  LLM  ──►  SOP (.md/.html)
        + annotated shots           (labels, multi-anchor              PowerShell .ps1
          kept local                 selectors, narration,             Playwright .spec.js
        + voice narration            captions = ground truth)          AA build sheet · diff report
```

## Why it's different

- **Semantic capture, not video.** The DOM and the Windows UI Automation tree already know what you clicked. Paper Trail records the element's real name, kind, and *several* replay-grade anchors (test attribute, id, name/aria, CSS path, `AutomationId`) — self-healing when the UI drifts.
- **The privacy inversion.** By default only the text action log goes to the model; it writes around `{{screenshot_N}}` tokens and the real images are spliced in locally at export. A fully illustrated document from a model that never saw your screen — and a one-click **Privacy Audit** shows the literal request payload to prove it.
- **A recording is data, not just a document source.** The same anchors that illustrate an SOP can drive automation, be **verified** against the live UI, power a **guided walkthrough**, or be **diffed** against a re-recording for change management.

## Features

| | |
|---|---|
| **Recorder** | Web (any site, all frames), desktop via UIA companion (recommended, Windows) or window-capture mode (no install, any OS) |
| **Voice narration** | 🎤 speak while recording; transcribed via any OpenAI-compatible Whisper endpoint, attached to steps by timestamp; audio never stored |
| **Caption-on-capture** | Optional: desktop frames described by your vision model the moment they're captured — generation stays text-only and fast |
| **Library** | IndexedDB-backed saved recordings: open, rename, re-generate, compare |
| **✓ Verify** | Replays anchors read-only against the live UI; traffic-light drift report with one-click selector repair |
| **▶ Walkthrough** | The SOP as a live guide: highlights each step on the real page, auto-advances when you perform it |
| **⇄ Diff** | Compare two recordings of one procedure: unchanged / relabeled / added / removed, plus an optional LLM change-management summary |
| **Generate** | SOP (Markdown/HTML), PowerShell (Selenium+UIA), Playwright script, read-only Playwright regression test, Automation Anywhere build sheet |
| **🔍 Privacy Audit** | The exact request body that would be sent — images redacted to size placeholders, credentials excluded — exportable for compliance sign-off |

**Providers:** Anthropic · OpenAI · any OpenAI-compatible URL — including fully local **Ollama / LM Studio** (default local model: `gemma4:12b-it-qat`) with a local Whisper server for narration. See [INSTALL.md — fully local setup](docs/INSTALL.md#fully-local-setup-free-models).

## Quick start

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Side panel → **⚙** → pick a provider (or point Custom at local Ollama), paste a key if needed
3. **● Start recording**, do the thing, **■ Stop**, **Generate** — then **💾 Save** to keep it in the Library

Full guides: **[Install](docs/INSTALL.md)** · **[Usage](docs/USAGE.md)** · **[Design](docs/DESIGN.md)** · **[Testing](docs/TESTING.md)**

## Repository layout

```
manifest.json            MV3 manifest
background.js            Session ledger, screenshots, LLM clients, prompts, audit, native port
content.js / content.css Semantic DOM capture, anchor resolution, walkthrough overlay
common.js                Shared pure logic (anchors, diff, narration mapping) — tested in tests.html
db.js                    IndexedDB module (recordings + screenshot blobs)
sidepanel.*              Recorder UI, window-capture engine, mic narration, generation, export
library.js / verify.js / walkthrough.js / diff.js   Library tab features
options.* / mic.*        Settings · one-shot mic-permission helper
native-host/             Windows UIA companion (PowerShell 5.1+, embedded C#)
docs/                    DESIGN · INSTALL · USAGE · TESTING
tests.html               Browser-runnable assertions for the pure logic
```

## Security posture (summary)

Capture is inert unless recording is on. Keys live in `chrome.storage.local` and go only to the endpoint you configured. Typed values masked by default; secret-like fields always. Narration audio is transcribed once and never persisted. The UIA companion is per-user (HKCU), launched only by Chrome/Edge with your extension ID pinned, and exits on disconnect. Details: [DESIGN.md §6](docs/DESIGN.md#6-privacy--security-model).

## License

Internal use.
