# Paper Trail — Procedure Recorder (Chrome Extension)

**Record any browser procedure as semantic steps. Generate a polished SOP with Claude or GPT. Screenshots never leave your machine unless you say so.**

This is the SOP Generator reimagined as a standalone Chrome extension — no PowerShell server, no ffmpeg, no Whisper, no Ollama required.

---

## Why this beats the video pipeline

The original SOP Generator records pixels and asks a vision model to *guess* what you clicked. Paper Trail captures the truth directly from the DOM:

| | Video pipeline (v3/v4) | Paper Trail |
|---|---|---|
| "What did the user click?" | Vision model inference (can hallucinate) | The actual element label, from the DOM |
| Screenshot timing | Every N seconds, or manual F2 | Exactly at each action, automatically |
| Click location | Unknown | Marked with a ring on the screenshot |
| Narration | Required (Whisper transcription) | Optional typed notes per step |
| Infrastructure | PowerShell + ffmpeg + Whisper + Ollama/GPU | None — the extension is the whole product |
| Sensitive data egress | Full screen video processed | **Zero by default** (see Privacy) |
| Processing time | Minutes per recording | Seconds (one LLM call) |

### The privacy model (the innovative part)

By default, **only the semantic action log leaves your machine** — element labels, page titles, URLs. The LLM writes the SOP from that log and places `{{screenshot_N}}` tokens where images belong. The extension splices the actual screenshots in **locally at export time**. The model never sees a pixel of your screen, yet the final document is fully illustrated with click-point-annotated screenshots.

For regulated environments (finserv, healthcare) this inverts the usual trade-off: you get AI-authored documentation *and* a defensible data-flow story. Typed values are masked by default; password/payment fields are always masked.

---

## Install

1. Download and unzip `paper-trail-extension.zip`
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked**, select the `paper-trail` folder
4. Click the extension icon to open the side panel; click ⚙ to configure your provider

## Configure

| Provider | Endpoint | Notes |
|---|---|---|
| **Anthropic** | api.anthropic.com | Uses CORS-enabled direct browser access; key stays local |
| **OpenAI** | api.openai.com | Standard chat completions |
| **Custom** | Your URL | Any OpenAI-compatible endpoint — Open WebUI (`/api/chat/completions`), Azure OpenAI via Open WebUI, vLLM, LiteLLM |

## Use

1. **● Start recording** (or `Alt+Shift+S`) — a red scanline shows in the panel, REC badge on the icon
2. Perform the procedure in any tab — every click, field entry, dropdown, form submit, and page navigation becomes a numbered step with an annotated screenshot. A teal ripple confirms each capture.
3. Add per-step notes or delete noise steps in the ledger; `Alt+Shift+C` captures the current screen manually
4. **Stop**, add optional context (purpose/audience), **Generate SOP**
5. Review/edit the draft, then export: **Copy Markdown**, **.md**, or **.html** (print-ready → PDF via browser)

## Architecture

```
content.js        capture-phase DOM listeners → semantic action
                  (label extraction: aria → <label> → text → placeholder)
       │
background.js     session ledger (chrome.storage.session)
                  captureVisibleTab → OffscreenCanvas: downscale + click ring
                  LLM calls (Anthropic / OpenAI / custom)
       │
sidepanel.js      step ledger UI, notes, generation, token splicing,
                  Markdown render, export (.md / .html)
```

No frameworks, no build step, no external CDN. Manifest V3.

## Desktop application support

Two modes, both feeding the same step ledger and generator:

### 🖥 Window-capture mode (built in, works today)
Click **Record a window** in the panel and pick any native app in Chrome's window picker. The panel samples the stream and captures a frame whenever the screen changes and settles (pixel-diff state machine — no blind timed captures), or on **Ctrl+Shift+9**, which works globally *while the desktop app has focus*. These steps have no DOM semantics, so their frames are the one exception to the privacy default: they're attached to the generation call so the model can describe them (rule-bound to describe only what's visible).

### ⚡ UIA companion (semantic, `native-host/`)
A PowerShell native-messaging host (Windows PowerShell 5.1+, embedded C#) that treats the **Windows UI Automation tree as the desktop's DOM**: a low-level mouse hook catches each click, reads the real element name and control type under the cursor, captures the foreground window with a red ring at the click point, and streams it into the ledger — `Click **Apply** (button) — mmc`. Same guarantees as web capture: real labels, screenshots stay local by default.

**Install (one-time, no admin):**
1. Load the extension, copy its ID from `chrome://extensions`
2. `cd native-host` → `.\Install-PaperTrailHost.ps1 -ExtensionId <your-id>` (registers for Chrome + Edge, HKCU only)
3. In the side panel, click **⚡ UIA companion** — recording starts and desktop clicks appear as semantic steps

Notes: the host exits when the extension disconnects; elevated (admin) windows may deny UIA reads — those clicks fall back to window title + screenshot. Keystroke capture is deliberately excluded in v1.

---

## RPA / automation export

The same recording that produces an SOP can produce an automation artifact — the semantic anchors captured at record time (verified CSS selectors on web steps; UIA `Name`/`ControlType`/`AutomationId`/`ClassName` on desktop steps) are exactly what replay needs. Pick the output type above the Generate button:

- **PowerShell automation (.ps1)** — Selenium PowerShell module for browser steps, `System.Windows.Automation` for desktop steps. Anchors are used verbatim (the prompt forbids inventing selectors); masked field entries become `param()` parameters (secrets as `[SecureString]`), and every step gets a `Wait-ForElement` retry plus per-step try/catch. Vision-only desktop frames become explicit `# TODO` blocks, never fake anchors.
- **Automation Anywhere build sheet** — A360 bot JSON isn't a hand-authoring format, so this generates the document a CoE developer actually uses: package prerequisites, a variables table (masked values → Credential Vault), and one entry per step naming the exact A360 action with the object properties to pin (AutomationId / CSS anchor preferred, coordinates never recommended when an anchor exists).

Automation generation is always **text-only** — anchors are the payload; no screenshot ever accompanies it. Review any generated script before running it in production; recorded anchors are ground truth, but flow logic is model-authored.

---

## Limits & roadmap

- Screenshots are session-scoped (~60 steps ceiling); a saved-SOP library in IndexedDB is the natural next step
- Canvas-heavy apps (Citrix, VDI, Flutter web) expose little DOM — use `Alt+Shift+C` manual captures there
- Roadmap ideas: region redaction brush on screenshots; **verify mode** (replay recorded selectors against the live site and flag drift — *self-detecting stale SOPs*); DOCX export; team template injection
