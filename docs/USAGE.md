# Paper Trail — Usage Guide

From a live session to an illustrated SOP (or a runnable automation) in five steps: record → review → annotate → generate → export.

---

## 1. Recording

### Web procedures

1. Open the side panel and click **● Start recording** (`Alt+Shift+S`). A red scanline appears in the panel and a **REC** badge on the icon.
2. Perform the procedure in any tab or window. Every click, field entry, dropdown selection, checkbox toggle, form submit, and page navigation becomes a numbered step with an annotated screenshot — a teal ripple confirms each capture. Recording follows you across tabs; multi-tab procedures work naturally.
3. `Alt+Shift+C` captures the current tab manually for moments that aren't events (e.g., "note this dashboard state").
4. Click **■ Stop recording** when done.

Field values are masked by default — steps read "Enter a value in **Field**" without the content. Enable *Record typed values* in options only if the values themselves belong in the document; password/payment-like fields stay masked regardless.

### Desktop apps — window-capture mode

1. Click **🖥 Record a window** and pick the app in Chrome's picker.
2. Work in the app. A frame is captured automatically whenever the screen changes *and settles* — one clean frame per state transition. Recording starts automatically if it wasn't running.
3. **Ctrl+Shift+9** forces a capture and works globally, even while the desktop app has focus.
4. Click **🖥 Stop window capture** (or the browser's "Stop sharing" bar).

These steps have no semantic labels, so their frames are attached at generation time — that's the one exception to the no-pixels default. Add a note to any frame whose meaning isn't obvious.

### Desktop apps — UIA companion (semantic)

With the companion installed ([INSTALL.md §3](INSTALL.md#3-install-the-uia-companion-optional-windows)), click **⚡ UIA companion**. Desktop clicks arrive as real semantic steps — `Click **Apply** (button) — mmc` — with ring-annotated window screenshots, same privacy rules as web steps. Toggle it off to disconnect (the host process exits).

---

## 2. Reviewing the ledger

Each step shows its ordinal, elapsed time, action, page/app, and screenshot thumbnail. Hover a step for tools:

- **✕** delete a noise step (ordinals renumber)
- **🖼✕** remove just the screenshot (keeps the semantic step)
- Click a thumbnail to view it full-size

The **note field** under each step is the highest-leverage input you have: notes are passed to the model as *authoritative context*. One sentence on a cryptic step ("this approves the wire batch") beats regenerating twice.

---

## 3. Generating

1. Pick the output type above the Generate button:
   - **SOP document (Markdown)** — Purpose / Scope / Prerequisites / Procedure / Notes, with screenshots placed per step
   - **PowerShell automation (.ps1)** — Selenium for web steps, `System.Windows.Automation` for UIA steps, using the captured anchors verbatim; masked values become `param()` parameters
   - **Automation Anywhere build sheet** — an A360 assembly document quoting the captured object properties per action
2. Optionally add context (purpose, audience, system name) — it shapes the Title/Purpose/Scope sections.
3. Click **Generate**. One API call; typical drafts return in seconds.

What leaves the machine per target is detailed in [DESIGN.md §6](DESIGN.md#6-privacy--security-model); automation targets are always text-only.

## 4. Editing and exporting

**Edit** toggles a raw editor over the preview (screenshot tokens like `{{screenshot_3}}` are visible there and re-splice on preview). Then:

| Button | Produces |
|---|---|
| **Copy** | Markdown (or the script) on the clipboard |
| **.md** | Portable Markdown with screenshots embedded as data URLs |
| **.html** | Styled single file, print-ready (browser Print → PDF) |
| **.ps1** | The automation script (PowerShell target only) |

**Review any generated script before it touches production** — the anchors are recorded ground truth, but the flow logic is model-authored. Treat it like a code-review candidate.

---

## 5. Shortcuts

| Keys | Action | Scope |
|---|---|---|
| `Alt+Shift+S` | Start / stop recording | Chrome focused |
| `Alt+Shift+C` | Manual tab capture | Chrome focused |
| `Ctrl+Shift+9` | Desktop frame capture | **Global** (any app focused) |

Remap at `chrome://extensions/shortcuts`.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No steps while clicking a page | Recording not started, or the page predates the install — reload the tab once after installing |
| Steps appear without screenshots | `chrome:// `/ Web Store pages can't be captured; or the session quota was hit (oldest shots drop first — export sooner or raise/lower max steps in options) |
| "screenshot removed" labels | You removed it, or quota pressure dropped it; the semantic step is intact |
| Clicks in Citrix/VDI/canvas apps capture nothing useful | There's no DOM to read — use window-capture mode or `Ctrl+Shift+9` |
| UIA companion won't connect | Extension ID changed; rerun the installer ([INSTALL.md §3](INSTALL.md#verifying--troubleshooting)) |
| Desktop clicks show window title but no element name | The target app runs elevated and denies UIA reads — run it non-elevated, or accept the fallback |
| Generation fails instantly | No API key / custom URL configured — open **⚙** options |
| Generated script uses a selector that no longer matches | The UI changed since recording — re-record the affected step; never hand-patch guessed selectors |
