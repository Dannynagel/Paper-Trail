# Paper Trail — Usage Guide

From a live session to an illustrated SOP (or a runnable automation) in five steps: record → review → annotate → generate → export. Saved recordings then keep working for you: verify their anchors against the live UI, walk someone through them live, diff two versions for change management (§5) — or let the extension **run the procedure itself** with evidence of every step (§7), watch it for UI drift on a schedule (§9), and share it with another profile as a `.ptpack` (§10).

---

## 1. Recording

### Web procedures

1. Open the side panel and click **● Start recording** (`Alt+Shift+S`). A red scanline appears in the panel and a **REC** badge on the icon.
2. Perform the procedure in any tab or window. Every click, field entry, dropdown selection, checkbox toggle, form submit, and page navigation becomes a numbered step with an annotated screenshot — a teal ripple confirms each capture. Recording follows you across tabs; multi-tab procedures work naturally.
3. `Alt+Shift+C` captures the current tab manually for moments that aren't events (e.g., "note this dashboard state").
4. Click **■ Stop recording** when done.

Field values are masked by default — steps read "Enter a value in **Field**" without the content. Enable *Record typed values* in options only if the values themselves belong in the document; password/payment-like fields stay masked regardless.

**🤖 AI features** (toggle under the capture buttons, on by default) controls everything that touches a model. Turn it off when no endpoint is available — or wanted: desktop-frame captions and narration are disabled, AI generation hides, and the worker refuses any generation request, so nothing can leave the machine. Recording itself, evidence runs, ✓ Verify, ▶ Walk, and ⚡ Autopilot never use AI and work identically either way. You can still produce documents — see **Draft SOP without AI** below.

### Voice narration

Press **🎤 Narrate** while recording (it starts the recording if idle) and talk through what you're doing — the *why*, prerequisites, warnings. When you stop, the audio is transcribed through the OpenAI-compatible Whisper endpoint configured in options (works with local Whisper servers), and each spoken segment attaches to the step it followed as a 🎙 row. Generated SOPs use narration as authoritative intent context. Privacy: the audio is sent once for transcription and **never stored** — only the transcript text becomes part of the recording, and the audit lists exactly which steps carry it. For a free local transcription server, see [INSTALL.md §2 — Fully local setup](INSTALL.md#fully-local-setup-free-models). Keep the panel open while narrating; closing it drops the audio (never the steps). If the mic prompt doesn't appear, a helper tab opens to grant the permission.

### Desktop apps — UIA companion (recommended, Windows)

The companion is the preferred way to record desktop procedures: every click is captured (not inferred from screen changes) as a real semantic step — `Click **Apply** (button) — mmc` — with ground-truth anchors (Name, ControlType, AutomationId) that make the recording automation-ready, plus a ring-annotated window screenshot. Same privacy rules as web steps: labels are text, pixels stay local.

With the companion installed ([INSTALL.md §3](INSTALL.md#3-install-the-uia-companion-recommended-windows)), click **⚡ UIA companion**. Toggle it off to disconnect (the host process exits).

### Desktop apps — window-capture mode (fallback, no install)

Use this when the companion isn't an option: nothing to install, works on macOS/Linux, and covers apps that deny UIA reads (elevated windows, Citrix/VDI, canvas UIs).

1. Click **🖥 Record a window** and pick the app in Chrome's picker.
2. Work in the app. A frame is captured automatically whenever the screen changes *and settles* — one clean frame per state transition. Recording starts automatically if it wasn't running.
3. **Ctrl+Shift+9** forces a capture and works globally, even while the desktop app has focus (clicks that don't change the screen are otherwise missed).
4. Click **🖥 Stop window capture** (or the browser's "Stop sharing" bar).

These steps have no semantic labels, so their frames are attached at generation time — that's the one exception to the no-pixels default. Add a note to any frame whose meaning isn't obvious, and note that generated automation gets "manual anchor required" placeholders for these steps (only the companion captures machine-readable desktop anchors).

**Pair it with "Caption desktop frames at capture"** (options, off by default): each frame is described by your vision model the moment it's captured (a 🖼→📝 caption appears under the step), and generation then sends the caption text instead of the frame. Desktop-heavy recordings generate as fast as web-only ones (the vision work is amortized across the recording session, ~1–4 s per frame in the background) and the generation request stays text-only. Requires the model endpoint to be reachable while recording; if a caption fails, that frame simply attaches at generation as before.

---

## 2. Reviewing the ledger

Each step shows its ordinal, elapsed time, action, page/app, and screenshot thumbnail. Hover a step for tools:

- **✕** delete a noise step (ordinals renumber)
- **🖼✕** remove just the screenshot (keeps the semantic step)
- **🖌** redact the screenshot: drag black rectangles over anything sensitive, **Apply** flattens them permanently — every export, pack, and report from then on carries the redacted image (also available on saved recordings in the Library)
- **⚙** (input/select steps) mark the value as a **run-time parameter** — for inputs that change every run, like the affected user in a JML process. Name it (`EMPLOYEE_ID`) and it becomes an `<EMPLOYEE_ID>` placeholder with an Inputs list in generated SOPs, and a mandatory named parameter in every generated script. Also editable later on saved recordings in the Library.
- Click a thumbnail to view it full-size

The **note field** under each step is the highest-leverage input you have: notes are passed to the model as *authoritative context*. One sentence on a cryptic step ("this approves the wire batch") beats regenerating twice.

---

## 3. Generating

1. Pick the output type above the Generate button:
   - **SOP document (Markdown)** — Purpose / Scope / Prerequisites / Procedure / Notes, with screenshots placed per step
   - **PowerShell automation (.ps1)** — Selenium for web steps, `System.Windows.Automation` for UIA steps, using the captured anchors verbatim; masked values become `param()` parameters
   - **PowerShell web — HTTP only (.ps1)** — no browser at all: replays the **HTTP log** captured while you recorded (the page's real form posts and API calls, values masked) using only `Invoke-WebRequest`/`Invoke-RestMethod`, with cookie-session continuity and CSRF-token extraction. Ideal for headless servers where Selenium/Playwright can't run
   - **Playwright script (.spec.js)** — a runnable Node script replaying the procedure through a fallback chain of the recorded anchors; masked values come from `PT_*` environment variables
   - **Playwright regression test (.spec.js)** — a **read-only** `@playwright/test` spec that asserts every recorded anchor still resolves: Verify Mode as a CI job
   - **Automation Anywhere build sheet** — an A360 assembly document quoting the captured object properties per action
2. Optionally add context (purpose, audience, system name) — it shapes the Title/Purpose/Scope sections.
3. For script targets, **🔐 Credentials via Delinea Secret Server** makes the generated script source every credential from your on-prem Secret Server at runtime (module-free REST helpers, `-AuthMethod windows|token`, one `-<Name>SecretId` per credential — nothing prompted or hard-coded). For service-account **password changes**, the script generates the new password locally, applies the recorded change, verifies it, and only then writes it back to Secret Server — failing loudly if target and vault end up out of sync.
4. Click **Generate**. One API call; typical drafts return in seconds.
5. No model, no problem: **📄 Draft SOP without AI** assembles the document locally from the recorded steps — an Inputs list from your run-time parameters (recorded sample values are swapped for `<PLACEHOLDERS>`), numbered steps with notes, narration, and captions, and screenshots spliced in as always. It's available in both modes (it becomes the primary button when 🤖 AI is off) and sends nothing anywhere. Expect a faithful transcript-style document rather than the model's editorial pass (merged steps, inferred prerequisites).

What leaves the machine per target is detailed in [DESIGN.md §6](DESIGN.md#6-privacy--security-model); automation targets are always text-only. No API key? The **Claude account** provider signs in with your Claude.ai subscription instead ([INSTALL.md §2](INSTALL.md#2-configure-a-model-provider)), and the 🤖 toggle plus the local draft cover the no-model case entirely. For a zero-cost, fully local provider setup (Ollama + Gemma 4 12B QAT), see [INSTALL.md §2 — Fully local setup](INSTALL.md#fully-local-setup-free-models).

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
| **Open** | Read-only view of the saved steps, screenshots, narration — plus the runs table and evidence runs (§7) |
| **⚡ Run** | Autopilot: the extension performs the steps itself — see §7 |
| **▶ Walk** | Guided walkthrough — see below |
| **✓ Verify** | Anchor health check — see below |
| **Re-gen** | Sets the recording as the generation source (the Generate section shows `SOURCE ►`); pick a target and generate as usual |
| **⇄ Compare** | Diff against another recording: click ⇄ on the first, then on the second — see below |
| **⑂ Variant / ⑂ SOP** | Tag as a variant of a trunk procedure / generate one branch-aware SOP — see §8 |
| **⏰** | Drift sentinel: re-verify anchors daily and alert on new problems — see §9 |
| **Audit** | Privacy audit of exactly what generation would send — see §6 |
| **⬇ / ⬆ Import .ptpack** | Share the recording (steps + screenshots) with another profile — see §10 |
| **Rename / ✕** | Housekeeping |

**✓ Verify — catch stale SOPs before your users do.** Verify opens a tab, walks the recording's pages, and probes every anchor read-only (nothing is clicked or typed). Each step gets a traffic light: healthy · drifted (the label found the element but the selector changed — with a suggested repair you can apply in one click) · missing · unreachable. The result is stamped on the library entry, so you can see at a glance which SOPs still match the live UI.

**▶ Walk — the SOP as a live guide.** Walkthrough highlights each step's element on the real page and shows the instruction; when you actually perform the action it advances automatically. Cross-page steps offer **Take me there**; if the page has changed, **Show me by text** flashes likely candidates and you can skip or mark done manually. Desktop/UIA steps show the instruction card with its reference screenshot. Perfect for training someone through a procedure without them reading a document.

Steps recorded since v1.2 carry **multiple independent anchors** (test attribute, id, name/aria, structural path), so a single UI change rarely orphans a step: Verify repairs drift through the surviving anchors, walkthroughs keep arming, and generated automation gets fallback locator chains.

**⇄ Compare — what changed between two recordings.** Record the procedure again after a UI update, save it, then Compare the two versions: the report classifies every step as unchanged / relabeled / added / removed (a moved step reads as removed + added) and flags page, value, and anchor changes. Export it as `.md`/`.html`, or press **Generate change summary** for an LLM-written change-management document — that payload contains step text only, never anchors or values, and has its own Audit button.

Verify, Walk, and Run cover browser steps; recording, verifying, walking, and autopilot are mutually exclusive.

## 6. Privacy audit — prove what leaves the machine

**🔍 Preview what will be sent** (under Generate, or **Audit** on a library entry) builds the exact request for the selected output type — locally, without sending anything — and shows: destination endpoint/model, which screenshots would be attached vs stay local, every masked field, the verbatim system prompt and user message, and the full request body with image bytes redacted to size placeholders. Export it as `.md`, `.html`, or `.json` and hand it to your compliance reviewer; it is generated by the same code that builds the real request.

---

## 7. Autopilot — the recording runs itself (v1.5)

**⚡ Run** on a library entry executes the recorded steps in a live tab, attended. Two safety rules are absolute:

- **Anchors only.** A step executes only when one of its *recorded* anchors resolves the element. If none do, the run **stops** — Autopilot never acts on a label guess, so it cannot click the wrong thing. On a miss you choose: do the step yourself and mark it done, skip it, or abort.
- **Masked values are human-only.** Password/secret steps (and any step whose value was never captured) pause with the guide overlay on the field: *you* type the value, the same action detection as the walkthrough notices, and the run advances. The extension neither stores nor injects those values.

Autopilot follows the procedure across tabs: when a recorded click opens a new tab (`target="_blank"`, `window.open`) and the next step lives on that page, the run adopts the new tab and continues there.

Before starting you fill in any **run-time parameters** (values stay in the panel, never persisted) and pick a mode: **per-step confirm** — each step is highlighted first and ▶ runs it (or perform it yourself) — or **free-run** with a short settle between steps. Text is entered through native setters so React/Vue/Angular apps see real `input`/`change` events; apps that insist on `event.isTrusted` will fail those steps *visibly*, dropping you to manual — never a silent fake success.

**Evidence.** Every run writes a local **run record**: per-step status (`done` / `confirmed` / `manual` / `skipped` / `failed`), timestamps, and a screenshot after each completed step. Screenshots are taken only while the run tab is the visible one — a step completed while you're focused elsewhere is recorded without a shot rather than photographing an unrelated page. Walkthroughs record the same evidence when the 🧾 toggle is on. Open a recording to see its **Runs** list; each run renders a status-colored report exportable as `.md`/`.html` with the screenshots spliced in. Evidence never leaves this machine.

**Runs table (CSV).** If the recording has parameters, its detail view shows a runs table: download the CSV template (columns = your parameter names), fill one row per case, paste it back — headers are validated locally. **⚡ Run all rows** chains one autopilot run + one evidence record per row, stopping on failure. When a runs table exists, generated scripts also gain a batch wrapper (`-CsvPath` in PowerShell, `--csv` in Playwright) built from the parameter **names** — the row values themselves are never sent to any model.

## 8. Branch-aware SOPs (v1.5)

Real procedures fork ("if the joiner is a contractor…"). Record the main path (the **trunk**), then record each alternate path and tag it: **⑂ Variant** on the alternate, then ⑂ on the trunk, then name the path ("Contractor path"). Variants group under their trunk in the Library. **⑂ SOP** on the trunk generates **one** document covering everything: numbered decision points ("If X: continue at step N" — inferred conditions are marked as inferences), labeled branch sub-sequences with explicit rejoin points, and a closing mermaid flowchart. The payload is the trunk's action log plus per-variant `{op, step text}` diff entries computed locally — no variant anchors or values — and it has its own Audit button.

## 9. Drift sentinel — know before your users do (v1.5)

**⏰** on a library entry re-verifies its anchors every 24 hours (hourly alarm picks up due recordings; nothing runs while you're recording). The check opens an **inactive** tab, probes read-only exactly like ✓ Verify, stamps `lastVerified`, and closes the tab. When a sweep finds **new** problems versus the previous one, you get a desktop notification and a `!` badge on the icon (cleared when you open the Library). A site that stays drifted — or a login wall that keeps grading `unreachable` — alerts once, not hourly. Report-only: the sentinel never clicks, types, or repairs.

## 10. Library packs — share a recording (v1.5)

**⬇** on a row exports a `.ptpack` file: the recording plus its screenshots (as data URLs). **⬆ Import .ptpack** in the Library header restores it in another profile under a fresh id. Local operational state — evidence runs, watch settings, runs-table values, variant links — deliberately never travels. Redact screenshots (🖌) *before* exporting: packs carry whatever the shots store holds.

---

## 11. Shortcuts

| Keys | Action | Scope |
|---|---|---|
| `Alt+Shift+S` | Start / stop recording | Chrome focused |
| `Alt+Shift+C` | Manual tab capture | Chrome focused |
| `Ctrl+Shift+9` | Desktop frame capture | **Global** (any app focused) |

Remap at `chrome://extensions/shortcuts`.

---

## 12. Troubleshooting

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
| Autopilot stops with "no recorded anchor resolves" | The UI changed since recording — run **✓ Verify**, apply the suggested repairs, then re-run; or do the step manually and continue |
| Autopilot pauses on a password/secret field | By design — masked values are typed by a human under the overlay, never injected |
| Sentinel notifies about a site you're logged out of | It grades `unreachable` and alerts once; sign in in any tab and it recovers on the next sweep |
| Generation fails instantly | No API key / custom URL configured — open **⚙** options |
| 429 with the Claude-account provider | Brief limits retry automatically. An instant, persistent 429 on a Team/Enterprise plan usually means pooled usage is exhausted or your admin hasn't enabled this app for *Sign in with Claude* — the error text includes the server's own message. Alternatives: API key, an org gateway via the custom endpoint, or 🤖-off local drafting |
| Generated script uses a selector that no longer matches | The UI changed since recording — re-record the affected step; never hand-patch guessed selectors |
