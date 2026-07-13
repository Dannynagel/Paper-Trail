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
| **Library** | IndexedDB-backed saved recordings: open, rename, re-generate, compare, share as `.ptpack` |
| **⚡ Autopilot** | The extension performs a saved recording itself — anchors-only (a miss stops, never a wrong click), per-step confirm or free-run, parameter form, masked values always typed by a human |
| **🧾 Evidence** | Every autopilot run (and opted-in walkthroughs) leaves a local run record: per-step status + screenshots, exportable report — nothing sent anywhere |
| **Runs table (CSV)** | Paste rows of parameter values, ⚡ Run all rows — one evidence record per row; scripts get a `-CsvPath`/`--csv` batch wrapper built from parameter *names* only |
| **⏰ Drift sentinel** | Watched recordings re-verify daily in a background tab; new drift raises a notification + badge |
| **✓ Verify** | Replays anchors read-only against the live UI; traffic-light drift report with one-click selector repair |
| **▶ Walkthrough** | The SOP as a live guide: highlights each step on the real page, auto-advances when you perform it |
| **⇄ Diff** | Compare two recordings of one procedure: unchanged / relabeled / added / removed, plus an optional LLM change-management summary |
| **⑂ Branch-aware SOPs** | Tag variant recordings under a trunk and generate ONE SOP with decision points, branch sub-sequences, and a mermaid flowchart |
| **🖌 Redaction brush** | Black out screenshot regions permanently before exporting or sharing |
| **Generate** | SOP (Markdown/HTML), PowerShell (Selenium+UIA), pure-HTTP PowerShell (`Invoke-WebRequest`/`Invoke-RestMethod` replaying the captured request log), Playwright script, read-only Playwright regression test, Automation Anywhere build sheet |
| **Run-time parameters** | Mark per-run inputs (JML-style) on any step: `<NAME>` placeholders + Inputs list in SOPs, mandatory named parameters in scripts |
| **🔐 Delinea Secret Server** | Generated scripts source credentials from on-prem SS at runtime (windows/token auth) and follow the rotate-verify-write-back pattern for service-account password changes |
| **🔍 Privacy Audit** | The exact request body that would be sent — images redacted to size placeholders, credentials excluded — exportable for compliance sign-off |

**Providers:** Anthropic · OpenAI · any OpenAI-compatible URL — including fully local **Ollama / LM Studio** (default local model: `gemma4:12b-it-qat`) with a local Whisper server for narration. See [INSTALL.md — fully local setup](docs/INSTALL.md#fully-local-setup-free-models).

## Quick start

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Side panel → **⚙** → pick a provider (or point Custom at local Ollama), paste a key if needed
3. **● Start recording**, do the thing, **■ Stop**, **Generate** — then **💾 Save** to keep it in the Library

Full guides: **[Install](docs/INSTALL.md)** · **[Usage](docs/USAGE.md)** · **[Design](docs/DESIGN.md)** · **[Testing](docs/TESTING.md)** · [v1.5 roadmap (implemented)](docs/archive/ROADMAP-v1.5.md)

## Repository layout

```
manifest.json            MV3 manifest
background.js            Session ledger, screenshots, LLM clients, prompts, audit, native port
content.js / content.css Semantic DOM capture, anchor resolution, walkthrough overlay
common.js                Shared pure logic (anchors, diff, narration mapping) — tested in tests.html
db.js                    IndexedDB module (recordings + screenshot blobs + evidence runs)
sidepanel.*              Recorder UI, window-capture engine, mic narration, generation, export
library.js / verify.js / walkthrough.js / diff.js / autopilot.js / redact.js   Library tab features
options.* / mic.*        Settings · one-shot mic-permission helper
native-host/             Windows UIA companion (PowerShell 5.1+, embedded C#)
docs/                    DESIGN · INSTALL · USAGE · TESTING
tests.html               Browser-runnable assertions for the pure logic
alpha-test/              Alpha test harness: headless tests.html runner + two end-to-end smoke suites

```

## Security posture (summary)

Capture is inert unless recording is on. Keys live in `chrome.storage.local` and go only to the endpoint you configured. Typed values masked by default; secret-like fields always. Narration audio is transcribed once and never persisted. The UIA companion is per-user (HKCU), launched only by Chrome/Edge with your extension ID pinned, and exits on disconnect. Details: [DESIGN.md §6](docs/DESIGN.md#6-privacy--security-model).

## License

Internal use.
