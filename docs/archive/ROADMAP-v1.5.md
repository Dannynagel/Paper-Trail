> **Status: IMPLEMENTED — shipped as v1.5.0** (bug-fix follow-up in 1.5.1). All seven features below (plus the release steps) landed on `main`; see `CHANGELOG.md` for what shipped and `docs/DESIGN.md` "v1.5 additions" for how. The automated harness this brief references now lives in `alpha-test/`. Kept for historical reference only.

# Paper Trail v1.5 — Implementation Brief

**Audience: Claude Code (or any coding agent) executing this plan.** This is a self-contained execution spec. Read the "Codebase primer" and "Invariants" first — they are load-bearing and violating them will break the extension. Then implement the features in order; each is a separate commit.

---

## Codebase primer (read before touching anything)

Paper Trail is a **dependency-free Chrome MV3 extension**: vanilla ES2020 JS, no build step, no bundler, no `package.json`, no frameworks. Files load as plain `<script>` tags (panel) or `importScripts` (service worker) and communicate through **global singletons**, not modules.

**Files and their roles:**

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions, content-script registration |
| `background.js` | Service worker: session ledger in `chrome.storage.session`, screenshot pipeline, LLM clients (`callAnthropic`/`callOpenAI`), prompt builders, `AUTOMATION_PROMPTS` registry, HTTP capture, message router (`chrome.runtime.onMessage`) |
| `content.js` | Content script (all frames): mode machine `idle\|recording\|walkthrough`, capture listeners, `resolveStep()` anchor resolution, walkthrough overlay + `checkWalkMatch` |
| `common.js` | Global `PTCommon` — **pure** helpers (no DOM/chrome APIs at load): `normLabel`, `labelMatches`, `anchorList`, `samePage`/`sameOrigin`/`urlHost`, `summarizeVerify`, `diffSteps`/`summarizeDiff`, `mapNarration`, `auditStats`, `blobToDataUrl`. Loaded by content script, panel, worker, and `tests.html` |
| `db.js` | Global `PTDB` — IndexedDB (`recordings` + `shots` stores; `DB_VERSION`). Loaded by worker (`importScripts`) and panel (`<script>`) |
| `sidepanel.js` / `.html` / `.css` | Recorder/Library tabs, generation, export, mic narration, window capture |
| `library.js` / `verify.js` / `walkthrough.js` / `diff.js` | Library tab feature modules (panel-side) |
| `options.*` / `mic.*` | Settings; one-shot mic-permission helper page |
| `tests.html` | Browser-runnable assertions for `PTCommon` (open in any browser) |

**Data flow:** `content.js` → `chrome.runtime.sendMessage` → `background.js` router (owns session) ↔ `sidepanel.js`. The router is a single `switch (msg.cmd || msg.evt)` in `background.js`; add cases there.

**Unified step model:** `{ id (uuid), n, ts, type, text, label, kind, value, masked, selector, anchors, url, pageTitle, note, narration, param, caption, hasShot, autoId, className, app }`. `type` ∈ `click|input|select|key|submit|nav|uia|desktop|manual`.

**The optional-global hook pattern:** `library.js` renders action buttons *only when* the handler global exists (`typeof startVerify === "function"`). New panel modules expose a global (`startAutopilot`, `startCompare`, …) and `library.js` conditionally wires a button. Follow this exactly — it keeps modules decoupled with no import graph.

**Test harness:** an end-to-end Playwright smoke test lives in the session scratchpad (`smoke.js` + `form.html`), loads the unpacked extension in real Chromium (`executablePath: "/opt/pw-browsers/chromium"`, `--use-fake-device-for-media-stream`), and drives features through `chrome.runtime.sendMessage` from the panel page. It currently runs **39 checks**. Extend it per feature; keep it green. Run: `cd <scratchpad> && NODE_PATH=/opt/node22/lib/node_modules node smoke.js`.

**Per-commit workflow:** implement one numbered feature → `node --check` every touched JS + `python3 -c "import json; json.load(open('manifest.json'))"` → extend and run the smoke test → commit with a descriptive message → push feature branch. After the last feature: bump `manifest.json` to `1.5.0`, update docs, fast-forward `main` and push.

---

## Invariants (do not violate)

1. **Panel owns long-running flows; the worker does short transactional bursts only.** Autopilot/walkthrough/verify orchestration lives in panel modules. The worker touches IndexedDB in single transactions after `hydrate()`. This survives MV3 worker eviction.
2. **Autopilot executes via anchors only.** Never label-guess to *perform* an action. An anchor miss stops the run (offer manual continue) — it must never click the wrong element.
3. **Masked values never reach Autopilot.** Secret/password steps pause and require a human to type; the extension neither receives nor injects them.
4. **The privacy audit must stay payload-identical by construction.** Any new generation path routes through the same `build*Request` + `callAnthropic`/`callOpenAI` functions so `buildAudit` reflects the real bytes. Never build a request the audit can't see.
5. **CSV/parameter *values* are never sent to the model** — only column/parameter *names*. Evidence and runs are entirely local (nothing sent anywhere).
6. **IndexedDB upgrades are additive.** New stores only; both contexts already handle `onversionchange → close()`.

---

## Feature 1 — Autopilot (attended in-browser execution)

**Goal:** the extension performs a saved recording's steps itself, using the recorded anchors, filling `param` values from a form, pausing on masked steps and on any miss.

**`content.js`:**
- Add `"autopilot"` to the mode machine (owned by tab-targeted messages, like `walkthrough`; the `recordingState` broadcast tears it down — mirror the existing walkthrough handling).
- New message `execStep {step, value, confirm}`:
  - Resolve with the existing `resolveStep(step)`. **Only accept `status === "found"` or an alternate-anchor `"fallback"` with a concrete `el`** — a label-scan-only match (no `el`, or `matchCount > 1`) is a miss → respond `{failed, reason}`.
  - `confirm: true` → draw the existing walkthrough guide box (`walkArm`-style overlay reuse) and respond `{staged: true}`; the panel then sends `execStep {confirm: false}` to actually run it.
  - Execute by `step.type`:
    - `click` → `el.click()`
    - `input` → set via the native setter so framework listeners fire: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value)` (use `HTMLTextAreaElement` for textareas), then `el.dispatchEvent(new Event("input", {bubbles:true}))` + `Event("change", {bubbles:true})`.
    - `select` → set `el.value` (or match an option by visible label), then dispatch `change`.
    - `key` (Enter) → dispatch `keydown`/`keyup` `KeyboardEvent`s with `key:"Enter"`.
  - Respond `{done:true, via}` or `{failed, reason}`.
  - **Masked step** (`step.masked`): do NOT execute. Arm the walkthrough overlay ("type this value now") and reuse `checkWalkMatch` to detect the human's action, then signal completion via the existing `walkStepDone` broadcast. Autopilot advances on that.

**New `autopilot.js`** (panel module, mirror `walkthrough.js` structure):
- `startAutopilot(recId)`: load recording; if it has `param` steps, render a **parameter form** first (one input per distinct `step.param`; values kept panel-local, never persisted). A run-mode toggle: **per-step confirm** (▶ advances each) vs **free-run**.
- Reuse the walkthrough tab plumbing (`walkFrames`, `walkSendFrame`, per-frame send, `PTCommon.samePage` navigation, re-arm on `tabs.onUpdated`). Extract those into shared helpers if cleaner, or mirror them.
- Sequential execution with a settle wait (~500 ms) between steps. On `{failed}` → stop, show "continue manually / abort".
- Mutually exclusive with recording/verify/walkthrough (guard like `verify.js` does with `walk`/`verifyRun`).
- Expose `startAutopilot` globally; add a **⚡ Run** button in `library.js` rows behind `typeof startAutopilot === "function"`.

**Reuse:** `resolveStep`/`anchorList` (content.js), guide-box CSS (`content.css`), walkthrough frame plumbing (`walkthrough.js`), `PTCommon.samePage`.

---

## Feature 2 — Evidence packs

**`db.js`:** bump `DB_VERSION` to 2; in `onupgradeneeded` add a `runs` store (`keyPath:"id"`, index `byRec` on `recId`). Run screenshots reuse the existing `shots` store with `recId: "run:" + runId`. Extend `deleteRecording` to also delete the recording's runs and their run-shots. Add `PTDB` methods: `saveRun`, `listRunsByRec`, `getRun`, `deleteRunsByRec`.

**Run record:** `{ id, recId, recTitle, startedAt, finishedAt, mode: "autopilot"|"walkthrough", params: {NAME: value} (NON-SENSITIVE ONLY — never store masked-step values), steps: [{n, text, status: "done"|"confirmed"|"manual"|"skipped"|"failed", ts, via, hasShot}] }`.

**Capture:** after each completed step, Autopilot (and walkthrough when a new "record evidence" toggle is on) asks the worker to screenshot the tab. New router case `evidenceShot {runId, n}` → uses the existing rate-gated `captureShot` pipeline, stores the blob under `recId:"run:"+runId`, keyed by a synthetic stepId `runId+":"+n`. Return the key so the panel can reference it.

**UI/export:** `library.js` `openRecording` gains a **Runs** list (date, mode, outcome summary). Opening a run renders an evidence report (reuse `.step` cards + `ver-dot` status colors) with **⬇ .html / .md** via `download()`, screenshots spliced as data URLs. All local.

---

## Feature 3 — Batch parameter sets (CSV)

**Model:** `rec.paramSets = [{name, values: {PARAM: value}}]` on the recording.

**UI (`library.js` detail):** a "Runs table" section — paste CSV (header row must match the recording's `param` names; validate locally). Add a **pure** `PTCommon.parseCsv(text)` (RFC-ish: quoted fields, escaped quotes, CRLF) → `{headers, rows}` and unit-test it in `tests.html`. Provide a "Download CSV template" link generated from the recording's params.

**Consumption:**
- Autopilot **"Run all rows"** → sequential runs, one evidence record per row, stop-on-failure.
- Script generation: when `rec.paramSets` is non-empty, append one rule to the automation prompts to emit a `-CsvPath` batch wrapper (`Import-Csv | foreach { main @row }`; Node equivalent for Playwright) using the param **names** as columns. **Never send CSV values** — only names.

---

## Feature 4 — Drift sentinel

**`manifest.json`:** add `"alarms"`, `"notifications"`.

**Watch:** per-recording `rec.watch = {periodHours (default 24), lastRun, lastNotified}`; toggle button in `library.js`. On any watch enabled, `chrome.alarms.create("pt-sentinel", {periodInMinutes: 60})`; `chrome.alarms.onAlarm` → find due watched recordings.

**`sentinelVerify(rec)` (background.js):** open an **inactive** tab (`chrome.tabs.create({active:false})`), navigate per URL group with the same origin+path tolerance and 20 s timeout as `verify.js`, probe each step via `chrome.tabs.sendMessage(tabId, {cmd:"probeStep", …}, {frameId})` across `chrome.webNavigation.getAllFrames`, grade with `PTCommon.summarizeVerify`, stamp `rec.lastVerified`, close the tab. Sequential, one recording at a time; the message round-trips keep the worker alive. Report only — no repair UI.

**Alerting:** new drift/missing vs the previous grade → `chrome.notifications.create` ("SOP '…' drifted: N anchors") + action badge "!" until the Library tab is opened. Logged-out sites grade `unreachable`; notify at most once (`rec.watch.lastNotified`).

**Test hook:** router case `sentinelRunNow {recId}` so the smoke test can trigger a run deterministically.

---

## Feature 5 — Branch-aware SOPs

**Tagging:** `library.js` row action **⑂ Variant** → pick the trunk recording → set `rec.variantOf = trunkId`, `rec.variantLabel` (prompted, e.g. "Contractor path"). Library list groups variants under their trunk.

**Generation (background.js):** router `generateBranch {trunkId, context}` → load trunk + all its variants; run `PTCommon.diffSteps(trunk.steps, variant.steps)` per variant. Payload = trunk action log + per-variant `{label, entries}` where each entry is `{op, step text}` only. New `BRANCH_PROMPT`: produce **one** SOP for the whole procedure with explicit numbered **decision points** where variants diverge ("If <condition — infer from labels/context; mark inferences as such>: continue at step N"), each branch's steps labeled, ending with a ```mermaid flowchart. Route through `callAnthropic`/`callOpenAI` and add a `"branch"` case to `buildAudit` (mirror the diff audit — text only).

**UI:** "Generate branched SOP" button on the trunk row when variants exist; renders in the existing result pane.

---

## Feature 6 — Library packs (.ptpack)

**Export:** library row ⬇ → `{format:"ptpack/1", rec, shots:[{stepId, b64}]}` (screenshots via `PTCommon.blobToDataUrl`), `download()` as `<title>.ptpack`.

**Import:** a file input in the Library tab header → parse, validate `format`, regenerate `rec.id`, `PTDB.putShot` each blob (decode data URL → Blob), `PTDB.saveRecording`, re-render. **Do not** export runs/watch state. Step ids are UUIDs — keep them.

---

## Feature 7 — Redaction brush

Ledger + library screenshots gain a 🖌 tool → panel modal: image on a `<canvas>`, click-drag draws opaque black rectangles (multiple + undo). **Apply** flattens and replaces the blob in the `shots` store at the **same stepId** (every consumer picks it up automatically) and invalidates `objUrlCache`/`shotCache`. Irreversible — confirm first. Keep the core as a pure `redactBlob(blob, rects) → Promise<Blob>` (OffscreenCanvas) so the smoke test can drive it headlessly.

---

## Verification

**`tests.html` (pure logic):** `parseCsv` (quoted/escaped/CRLF/ragged), any run-summary or pack-validation helper.

**Smoke test additions (extend the existing harness):**
- Autopilot free-run on `form.html`: click executes (page reacts), `param`-filled quantity is set, masked password **pauses** → test types it → run completes; an evidence run is stored with per-step statuses and the export contains them.
- `sentinelRunNow` → `lastVerified` stamped + badge set.
- Branch: tag a second recording as a variant → `generateBranch` payload (captured by the stub chat endpoint) contains variant entries + `BRANCH_PROMPT`.
- Pack export → delete → import round-trip restores the recording + screenshot.
- `redactBlob` changes the stored blob bytes.

**Release:** `manifest.json` → 1.5.0; update `docs/USAGE.md` (Run/Autopilot, evidence, runs table, sentinel, variants, packs, brush), `docs/DESIGN.md` (v1.5 section + `alarms`/`notifications` in the permissions table), `docs/INSTALL.md` (permission rows), `README.md` (feature rows), `CHANGELOG.md` (1.5.0). Commit per feature, push the feature branch, then `git checkout main && git merge --ff-only <branch> && git push origin main`.

---

## Key risks

- **Synthetic events vs framework listeners:** the native-setter + dispatched-events pattern covers React/Vue/Angular. Apps that gate on `event.isTrusted` will not accept synthetic input — those steps fail visibly and fall to per-step confirm/manual. Never silently "succeed".
- **MV3 eviction mid-sentinel:** keep runs short, sequential, message-driven; the hourly alarm re-fire covers interrupted runs.
- **Autopilot safety** is the whole ballgame: anchors-only execution, masked-value human gate, stop-on-miss. Re-read invariants 2–3 before writing the executor.
