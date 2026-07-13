# Paper Trail — Design Document

**Version 1.5.1 · Chrome Extension (Manifest V3) + Windows UIA companion (recommended for desktop capture)**

Paper Trail converts a live browser or desktop session into (a) an illustrated Standard Operating Procedure and (b) optionally, an RPA artifact — by capturing *semantic* actions rather than video. Since v1.5 the same recorded anchors also *execute*: a saved recording can be run back attended (Autopilot) with a local evidence trail, and watched for UI drift on a schedule.

---

## 1. Design philosophy

### 1.1 Semantic capture over pixel capture

Screen-recording documentation tools capture pixels and reconstruct intent afterward (OCR, vision models). Paper Trail inverts this: it observes the event at its source and records ground truth.

| Question | Video pipeline | Paper Trail |
|---|---|---|
| What was clicked? | Vision-model inference | The element's actual accessible name, from the DOM / UIA tree |
| When to screenshot? | Timed interval or manual hotkey | Exactly at each action, automatically |
| Where was the click? | Unknown | Recorded coordinates, ring drawn on the frame |
| Can it drive automation? | No (no anchors) | Yes (CSS selectors, UIA AutomationIds) |

### 1.2 The privacy inversion

The default data flow sends **no pixels** to any model:

1. Capture produces two artifacts per step: a semantic record (label, kind, selector, page, URL) and a screenshot (kept local).
2. Generation sends only the semantic action log. The model writes the SOP and emits `{{screenshot_N}}` placeholder tokens.
3. At export, the extension splices the local screenshots into the tokens deterministically.

Result: a fully illustrated document from a model that never saw the screen. Two rule-bound exceptions exist (§6).

### 1.3 Zero infrastructure

No server, no build step, no frameworks, no CDN. The extension is the entire product; the UIA companion is a single PowerShell file with embedded C#.

---

## 2. Component architecture

```
+------------------------- Chrome ---------------------------+
|                                                             |
|  content.js (all frames)      sidepanel.js + feature        |
|  - capture-phase listeners      modules (library, verify,   |
|  - label + selector extract     walkthrough, autopilot,     |
|  - ripple feedback              diff, redact — one global   |
|  - resolveStep + overlay        scope, optional-global      |
|  - execStep (Autopilot)         hooks)                      |
|          |                    - step ledger UI              |
|          |                    - window-capture engine       |
|          |                    - generation / export         |
|          v runtime messages          ^                      |
|  background.js (service worker) -----+                      |
|  - session state (storage.session)                          |
|  - captureVisibleTab + OffscreenCanvas annotation           |
|  - LLM clients (Anthropic / OpenAI / custom)                |
|  - drift sentinel (alarms + notifications)                  |
|  - native messaging port <--------------+                   |
+------------------------------------------|------------------+
                                           | stdio (4-byte LE + JSON)
                              PaperTrailHost.ps1 (Windows)
                              - WH_MOUSE_LL global hook
                              - UIAutomation FromPoint
                              - GDI window capture + ring
```

### 2.1 Step data model

Every capture path produces the same step shape, so the ledger, generator, and exporters are source-agnostic:

```js
{
  id, n, ts,                 // uuid + ordinal + epoch ms
  type,                      // click | input | select | key | submit | nav | manual | desktop | uia
  text,                      // humanized action; element labels wrapped in ** **
  label, kind,               // accessible name + role/control type
  value, masked,             // field value (empty when masked)
  selector, anchors,         // web: primary CSS selector + alternate anchors (testAttr/id/attr/css)
  autoId, className, app,    // desktop-uia: UIA anchors + process name
  url, pageTitle,            // provenance
  note,                      // operator annotation (authoritative for generation)
  narration, caption,        // spoken transcript (v1.2) · vision caption for desktop frames (v1.3)
  param,                     // run-time parameter name (v1.4), e.g. "EMPLOYEE_ID"
  hasShot                    // screenshot lives in IndexedDB (shots store), local-only by default
}
```

### 2.2 Session lifecycle

The service worker owns the session and persists it to `chrome.storage.session` after every mutation, so MV3 worker restarts are lossless. On quota pressure, the oldest screenshots are dropped first — the semantic log is never sacrificed. Recording state is broadcast to all tabs, so capture follows the user across tabs and windows naturally.

---

## 3. Capture engines

Preference order for desktop work: the UIA companion (3.3) is recommended where it can run — ground-truth anchors, every click — with window-capture (3.2, ideally paired with caption-on-capture) as the no-install fallback and the only option off Windows.

### 3.1 Browser DOM (content.js)

Capture-phase listeners (`click`, `change`, `submit`, `keydown`) fire before SPAs can swallow events. Label extraction resolves in accessibility order:

`aria-label` → `aria-labelledby` → `<label for>` / wrapping `<label>` → visible text → `placeholder` / `name` / `title` / `alt`

Selector extraction (the RPA anchor) prefers stability over brevity:

`#id` → unique `[data-testid|data-test|data-qa|data-cy|name|aria-label]` (verified unique via `querySelectorAll`) → short structural path with `:nth-of-type`, capped at 6 ancestors / 240 chars

Password fields, and fields whose `name`/`autocomplete` suggests secrets or payment data, are masked unconditionally; all other values are masked unless the operator opts in.

### 3.2 Window-capture mode (sidepanel.js)

For native apps without a UIA companion. `getDisplayMedia` streams the chosen window; a 96-px grayscale sample is taken every 700 ms and compared against the previous sample. A two-state machine avoids mid-transition junk:

```
IDLE --(diff > 4.5%)--> CHANGED --(diff < 1.2%, i.e. settled)--> capture frame, cooldown 1.5 s
```

`Ctrl+Shift+9` is a `"global": true` Chrome command — it fires even while the desktop app has focus and forces a frame. These steps carry no semantics; their meaning is the frame itself.

### 3.3 UIA companion (native-host/)

The Windows UI Automation tree is treated as the desktop's DOM. A `WH_MOUSE_LL` hook (message pump on the main thread, work offloaded to the thread pool so the hook callback stays instantaneous) catches each left-click; `AutomationElement.FromPoint` yields Name, ControlType, AutomationId, and ClassName, with a 3-level ancestor walk for unlabeled elements. The foreground window is captured via GDI, downscaled to ≤1100 px, ring-annotated at the click point, and JPEG-encoded under the 1 MB native-messaging message cap.

Native messaging protocol: 4-byte little-endian length prefix + UTF-8 JSON, host → extension messages `hello`, `click`, `error`. The host exits when Chrome closes stdin.

---

## 4. Screenshot pipeline (browser steps)

`chrome.tabs.captureVisibleTab` is rate-limited by Chrome (~2/sec), so captures are serialized with a 620 ms gate. Frames are downscaled to ≤1200 px wide on an `OffscreenCanvas`, a red ring (plus outer halo) is drawn at the click point mapped from CSS-pixel to image coordinates, and the result is encoded JPEG q0.72 — a budget of roughly 120–250 KB per step against the 10 MB `storage.session` quota.

---

## 5. Generation contract

The model receives a JSON action log and must obey a strict output discipline enforced by the system prompts:

- **SOP target** - element labels are used verbatim (never "corrected"); images are referenced only via {{screenshot_N}} tokens for steps that actually have screenshots; desktop-capture steps must be described only from what is visible.
- **PowerShell target** - captured selectors/AutomationIds are used verbatim; masked values become param() parameters (secrets as [SecureString]); anchor-less steps become explicit TODO blocks, never invented anchors.
- **Automation Anywhere target** - a build sheet (A360 bot JSON is not a hand-authoring format) quoting captured object properties verbatim, preferring AutomationId / CSS anchors and never recommending coordinate or image matching when an anchor exists.

Providers: Anthropic (/v1/messages with direct-browser-access header), OpenAI (/v1/chat/completions), or any OpenAI-compatible URL (Open WebUI, Azure OpenAI via Open WebUI, vLLM, LiteLLM). Keys live in chrome.storage.local and are sent only to the configured endpoint.

---

## 6. Privacy & security model

| Data | Default | Exception |
|---|---|---|
| Semantic action log | Sent to configured model at generation | - |
| Browser/UIA screenshots | Local only; spliced at export | Operator enables "Send screenshots" |
| Window-capture frames | Attached at generation | By design: the frame is the step's only meaning. With caption-on-capture (opt-in) each frame is sent once at capture time instead; its caption travels as text at generation |
| Typed values | Masked | Operator opt-in; secret-like fields stay masked regardless |
| RPA generation | Always text-only | None - anchors are the payload, never pixels |
| HTTP log (recording only) | Form/JSON values masked; secret-like query params scrubbed; sent only with the psweb target | Operator enables "Record typed values" (secret-like keys stay masked) |
| Evidence runs (statuses + screenshots) | Local only — never sent, never exported in packs | - |
| CSV runs-table values | Local only; generated batch scripts read the file at run time | - (only parameter *names* appear in prompts) |
| Autopilot parameter values / masked entries | Parameters live in the panel for the run; masked values are typed by the human and never touch the extension | - |

Additional properties: no external CDN or third-party scripts; capture is inert unless recording is on; the UIA companion is per-user (HKCU), launched only by Chrome/Edge native messaging with the extension's ID pinned in allowed_origins, and exits when the extension disconnects.

---

## 7. Library, Verify, Walkthrough, Audit (v1.1)

Four features added after 1.0, all built on the same premise: every recorded step carries machine-readable anchors, so a recording is data you can re-use — not just a document source.

**SOP Library (`db.js`, `library.js`).** Saved recordings live in IndexedDB (`paper-trail` DB): a `recordings` store for step metadata and a `shots` store holding screenshots as Blobs keyed by step UUID. The shared `PTDB` module is loaded by both the service worker (`importScripts`) and the panel; long-running flows run only in the panel so MV3 worker eviction can never strand them. Live-session screenshots also live in the `shots` store (reserved recId `"live"`), which removed the old ~60-step `storage.session` ceiling — saving a session just reassigns its shots to the new recording, no bytes copied.

**Verify Mode (`verify.js` + `resolveStep` in `content.js`).** Replays a saved recording's anchors read-only against the live UI in a dedicated tab and grades each step: *found* (selector resolves and the live label still agrees), *drifted* (label locates the element but the selector is stale — unique matches carry a suggested replacement selector, applied in one click), *missing*, *unreachable* (page failed to load or redirected off-origin), or *not verifiable* (desktop/UIA/manual steps). Navigation is SPA-tolerant (origin+path identity) and probes every frame.

**Guided Walkthrough (`walkthrough.js` + mode machine in `content.js`).** The inverse of recording: the content script highlights the current step's element (same `resolveStep` anchors), and the same capture-phase listeners that record in recording mode instead *detect* the user's action in walkthrough mode — matching by element identity, then selector, then label+kind — and auto-advance. Cross-page steps offer "Take me there"; stale anchors degrade to a by-text highlight plus skip; desktop steps show instruction cards with the reference screenshot. A pagehide handler and a 20-second panel-ping deadman guarantee the overlay never outlives its session.

**Privacy Audit (`buildAudit` in `background.js`).** One click renders the *literal* request that generation would send — same body builders as the real calls, so the audit is the payload by construction — with image bytes replaced by size placeholders and credentials excluded, plus a summary of masked values and which screenshots stay local. Exports as `.md`/`.html`/`.json` for compliance sign-off.

### v1.2 additions

**Multi-anchor self-healing capture.** Each web step now records every independent anchor the element offers — test attribute, id, name/aria attribute, structural path — alongside the unchanged primary `selector` (anchors equal to the primary are omitted). `PTCommon.anchorList()` defines the single trust order (testAttr > id > attr > selector > css); legacy steps degrade to `[selector]`. Resolution tries the primary first (the only path that grades *found*); an alternate-anchor hit means the primary drifted and returns a fresh full anchor set so Verify's repair replaces everything at once (overwrite, never merge). Automation logs expose the alternates as `alt_selectors` fallback locator chains.

**Playwright export.** Two new generation targets: `playwright` (runnable Node script with a `locOf()` fallback-chain helper over the recorded anchors, masked values as `PT_*` env vars) and `pwtest` (a read-only `@playwright/test` spec asserting each anchor still resolves — Verify Mode as a CI job).

**Recording diff (`diff.js`, `PTCommon.diffSteps`).** LCS alignment of two recordings' ledgers on `type|kind|label` keys; gap pairs with matching type+kind and ≥ 0.3 token overlap classify as *relabeled*; unchanged pairs flag page/value/anchor changes. The report renders and exports locally; an optional LLM change-management summary sends only step text (never anchors or values) and is covered by the privacy audit like every other target.

**Voice narration.** A 🎤 toggle records mic audio in the panel (MediaRecorder, webm/opus) and transcribes it through a user-configured OpenAI-compatible `/v1/audio/transcriptions` endpoint (`verbose_json` required). Segments attach to steps by timestamp (`PTCommon.mapNarration`: latest step whose ts ≤ segment end). **Raw audio is never persisted** — it lives in the panel until transcribed and dies with it; only transcript text becomes data (`step.narration`), flows into generation as spoken operator intent, and is called out explicitly in the audit. A `mic.html` helper tab handles the side panel's inability to show the permission prompt.

### v1.3 addition: caption-on-capture

Desktop generation was prefill-bound: N window-capture frames made an N-image request. The opt-in `captionOnCapture` setting moves that vision work off the critical path — `captionStep()` in `background.js` describes each frame with the configured model right after capture (one short vision request per frame, best-effort) and stores the sentence as `step.caption`. Captioned frames are excluded from generation attachments (`buildSopRequest`'s attach rule), the caption rides in the action log with an SOP-prompt rule marking its provenance, and the audit lists captioned steps explicitly. Failure degrades to exactly the pre-existing behavior: the frame attaches at generation. Net effect: desktop-heavy recordings generate as fast as web-only ones, and the generation request is text-only.

### v1.4 additions: parameters, HTTP capture, Delinea mode

**Run-time parameters.** Input/select steps can be marked (⚙) with a parameter name (`step.param`). SOPs render `<NAME>` placeholders plus an Inputs list (prompt rule 10); automation logs carry `param_name`, which every script prompt turns into a mandatory named parameter with recorded values demoted to sample comments. Built for JML-style procedures whose subjects change per run.

**HTTP capture + `psweb` target.** While recording, an observational `webRequest` listener logs the page's document/XHR/fetch requests — method, scrubbed URL, form/JSON key structure with values masked under the standard rules, status — capped at 300, extension-initiated calls excluded via `tabId >= 0`. The log rides with the session and saved recordings and feeds the `psweb` target: a browser-less PowerShell script using only `Invoke-WebRequest`/`Invoke-RestMethod` (session-cookie continuity, CSRF extraction from preceding GETs, logged statuses asserted).

**Delinea Secret Server mode.** A 🔐 checkbox on script targets appends per-language rules to the system prompt: module-free SS REST helpers (`-AuthMethod windows|token`), one `-<Name>SecretId` parameter per credential, credentials resolved only at runtime, and the service-account rotation pattern — generate locally, change target, verify, write back to SS, loud out-of-sync failure. The audit renders the exact modified prompt.

### v1.5 additions: execution, evidence, batches, sentinel, branches, packs, redaction

**Autopilot (`autopilot.js` + `execStep` in `content.js`).** The recorder inverted twice: the same anchors that document and verify a procedure now *perform* it. The content script's executor resolves each step with `resolveStep(step, anchorsOnly=true)` — the label scan is disabled for execution, so a step either resolves through a recorded anchor or the run stops; a guess may suggest a repair but never acts. Values enter through the native property setters (`HTMLInputElement`/`HTMLTextAreaElement` prototype descriptors) followed by bubbled `input`/`change` events so framework value-trackers observe the change; checkboxes re-use a real `.click()`. Masked steps — and steps with no captured value — are never executed: the executor arms the walkthrough overlay and the human's own action (detected by `checkWalkMatch`, reported via `walkStepDone`) advances the run. Per-step confirm stages the overlay first (`{staged}`), and a second `execStep{confirm:false}` performs it. Orchestration (sequential loop, ~500 ms settle, navigation with `samePage` tolerance, per-frame sends, ping/deadman) lives in the panel; parameter values are collected in a panel-local form and never persisted. Tabs the run tab opens are tracked (`tabs.onCreated` + `openerTabId`): when the next step's page doesn't match the current tab, a matching child tab is adopted instead of navigating away — recorded clicks that open new tabs keep the run on the recorded path. Mode machine gains `"autopilot"`, torn down by the recording broadcast like the walkthrough.

**Evidence runs (`db.js` v2).** An additive `runs` store (index `byRec`) records each Autopilot run — and each walkthrough with the 🧾 toggle — as `{id, recId, mode, params, steps:[{n, text, status, ts, hasShot}]}` with statuses `done/confirmed/manual/skipped/failed`. After every completed step the panel asks the worker for one `evidenceShot`: the existing rate-gated capture pipeline stores the JPEG under `recId "run:<runId>"` in the shots store, keyed `runId:n`. Run params hold non-sensitive values only (masked-step parameters are never collected). `deleteRecording` cascades to runs and their shots. Reports render from `.step` cards with `ver-dot` status colors and export `.md`/`.html` with screenshots as data URLs — evidence is entirely local.

**Batch parameter sets (`PTCommon.parseCsv`).** A pure RFC-4180-ish parser (quoted fields, `""` escapes, CRLF, multi-line fields) feeds the library's runs table; headers must equal the recording's parameter names (validated locally) and rows become `rec.paramSets`. "Run all rows" chains free-runs in one reused tab, one evidence record per row, stop-on-failure. Generation sees only a COUNT (`resolveSource` exposes `paramSets` as a number) plus the parameter names, which fuel a `-CsvPath`/`--csv` batch-wrapper prompt rule for the script targets — CSV values never reach a payload, and the audit shows the identical modified prompt by construction.

**Drift sentinel (worker-side).** ⏰ sets `rec.watch = {periodHours: 24, lastRun, lastNotified}`; any watch arms an hourly `pt-sentinel` alarm. Due recordings are re-verified sequentially in an **inactive** tab with the same origin+path tolerance, 20 s navigation timeout, and per-frame `probeStep` grading as Verify Mode, then stamped `lastVerified` ("… — sentinel"). Alerting compares problem counts against the previous sweep (`watch.lastCounts`): only NEW drift/missing/unreachable raises `chrome.notifications` + a `!` action badge — persistent breakage and login walls alert once. The badge is derived by a single `refreshBadge()` from durable state (REC outranks `!`; the alert flag lives in `chrome.storage.local`), so it survives record/stop cycles and MV3 worker restarts until the Library is opened. Report-only by design; runs are short and message-driven so MV3 eviction just defers to the next alarm. `sentinelRunNow` gives tests a deterministic trigger.

**Branch-aware SOPs.** Recordings tagged `variantOf`/`variantLabel` group under their trunk. `generateBranch` diffs each variant against the trunk locally (`PTCommon.diffSteps`) and sends the trunk action log plus per-variant `{op, step text}` entries — never variant anchors, values, or URLs. `BRANCH_PROMPT` demands one procedure with numbered decision points (inferred conditions marked as inferences), labeled branch sub-sequences with rejoin points, and a closing mermaid flowchart. `buildAudit("branch")` mirrors it payload-identically.

**Library packs.** `.ptpack` = `{format: "ptpack/1", rec, shots: [{stepId, b64}]}`. Export strips watch state, runs-table values, and variant links; runs never travel. Import validates the format, regenerates the recording id (step UUIDs are kept so shots re-attach), and decodes screenshots back to Blobs.

**Redaction brush (`redact.js`).** Pure core `redactBlob(blob, rects)` flattens opaque black rectangles onto the image via OffscreenCanvas; the modal editor (drag, multi-rect, undo, confirm-before-apply) replaces the blob in the shots store **at the same stepId**, so the ledger, library, exports, packs, and evidence reports all pick up the redacted bytes, and the panel's object-URL cache is invalidated. Irreversible on purpose — redaction that can be undone isn't redaction.

---

## 8. Known limits and roadmap

- Canvas-rendered apps (Citrix/VDI, Flutter web) expose little DOM - window-capture mode or manual captures cover them.
- Elevated (admin) windows may deny UIA reads; those clicks degrade to window title + screenshot.
- Keystroke capture is deliberately excluded from the UIA companion in v1.
- Verify, Walkthrough, Autopilot, and the sentinel cover web anchors only; desktop (UIA / window-capture) steps grade "not verifiable", walk through as instruction cards, and pause Autopilot for a human.
- Sandboxed iframes that block extension injection grade "missing" in Verify even when the control exists.
- Autopilot dispatches synthetic events: apps that gate on `event.isTrusted` reject them — those steps fail visibly and fall to per-step confirm/manual, never a silent fake success.
- Roadmap: DOCX export; team templates.
