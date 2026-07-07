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

### Voice narration

Press **🎤 Narrate** while recording (it starts the recording if idle) and talk through what you're doing — the *why*, prerequisites, warnings. When you stop, the audio is transcribed through the OpenAI-compatible Whisper endpoint configured in options (works with local Whisper servers), and each spoken segment attaches to the step it followed as a 🎙 row. Generated SOPs use narration as authoritative intent context. Privacy: the audio is sent once for transcription and **never stored** — only the transcript text becomes part of the recording, and the audit lists exactly which steps carry it. Keep the panel open while narrating; closing it drops the audio (never the steps). If the mic prompt doesn't appear, a helper tab opens to grant the permission.

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
   - **Playwright script (.spec.js)** — a runnable Node script replaying the procedure through a fallback chain of the recorded anchors; masked values come from `PT_*` environment variables
   - **Playwright regression test (.spec.js)** — a **read-only** `@playwright/test` spec that asserts every recorded anchor still resolves: Verify Mode as a CI job
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

## 5. Library — save, re-use, keep healthy

**Save.** After stopping a recording, press **💾 Save** — the session (steps + screenshots) moves into the **Library** tab and the recorder clears. Recordings persist in this browser profile (IndexedDB), so long sessions and many recordings are fine.

Each library entry offers:

| Action | What it does |
|---|---|
| **Open** | Read-only view of the saved steps, screenshots, and narration |
| **▶ Walk** | Guided walkthrough — see below |
| **✓ Verify** | Anchor health check — see below |
| **Re-gen** | Sets the recording as the generation source (the Generate section shows `SOURCE ►`); pick a target and generate as usual |
| **⇄ Compare** | Diff against another recording: click ⇄ on the first, then on the second — see below |
| **Audit** | Privacy audit of exactly what generation would send — see §6 |
| **Rename / ✕** | Housekeeping |

**✓ Verify — catch stale SOPs before your users do.** Verify opens a tab, walks the recording's pages, and probes every anchor read-only (nothing is clicked or typed). Each step gets a traffic light: healthy · drifted (the label found the element but the selector changed — with a suggested repair you can apply in one click) · missing · unreachable. The result is stamped on the library entry, so you can see at a glance which SOPs still match the live UI.

**▶ Walk — the SOP as a live guide.** Walkthrough highlights each step's element on the real page and shows the instruction; when you actually perform the action it advances automatically. Cross-page steps offer **Take me there**; if the page has changed, **Show me by text** flashes likely candidates and you can skip or mark done manually. Desktop/UIA steps show the instruction card with its reference screenshot. Perfect for training someone through a procedure without them reading a document.

Steps recorded since v1.2 carry **multiple independent anchors** (test attribute, id, name/aria, structural path), so a single UI change rarely orphans a step: Verify repairs drift through the surviving anchors, walkthroughs keep arming, and generated automation gets fallback locator chains.

**⇄ Compare — what changed between two recordings.** Record the procedure again after a UI update, save it, then Compare the two versions: the report classifies every step as unchanged / relabeled / added / removed (a moved step reads as removed + added) and flags page, value, and anchor changes. Export it as `.md`/`.html`, or press **Generate change summary** for an LLM-written change-management document — that payload contains step text only, never anchors or values, and has its own Audit button.

Verify and Walk cover browser steps; recording, verifying, and walking are mutually exclusive.

## 6. Privacy audit — prove what leaves the machine

**🔍 Preview what will be sent** (under Generate, or **Audit** on a library entry) builds the exact request for the selected output type — locally, without sending anything — and shows: destination endpoint/model, which screenshots would be attached vs stay local, every masked field, the verbatim system prompt and user message, and the full request body with image bytes redacted to size placeholders. Export it as `.md`, `.html`, or `.json` and hand it to your compliance reviewer; it is generated by the same code that builds the real request.

---

## 7. Shortcuts

| Keys | Action | Scope |
|---|---|---|
| `Alt+Shift+S` | Start / stop recording | Chrome focused |
| `Alt+Shift+C` | Manual tab capture | Chrome focused |
| `Ctrl+Shift+9` | Desktop frame capture | **Global** (any app focused) |

Remap at `chrome://extensions/shortcuts`.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No steps while clicking a page | Recording not started, or the page predates the install — reload the tab once after installing |
| Steps appear without screenshots | `chrome:// `/ Web Store pages can't be captured |
| "screenshot removed" labels | You removed it; the semantic step is intact |
| Verify grades everything "unreachable" | The pages need a login — sign in in the verify tab's browser profile first, then re-run |
| Walkthrough overlay stuck on a page | It clears itself within ~20 s of the panel closing; reload the tab to clear immediately |
| Clicks in Citrix/VDI/canvas apps capture nothing useful | There's no DOM to read — use window-capture mode or `Ctrl+Shift+9` |
| UIA companion won't connect | Extension ID changed; rerun the installer ([INSTALL.md §3](INSTALL.md#verifying--troubleshooting)) |
| Desktop clicks show window title but no element name | The target app runs elevated and denies UIA reads — run it non-elevated, or accept the fallback |
| Generation fails instantly | No API key / custom URL configured — open **⚙** options |
| Generated script uses a selector that no longer matches | The UI changed since recording — re-record the affected step; never hand-patch guessed selectors |
