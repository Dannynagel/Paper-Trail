# Changelog

## 1.5.0

- **Autopilot**: ⚡ Run performs a saved recording's steps in the browser itself — anchors-only execution (a miss stops the run; a label guess never clicks), values set via native setters so framework listeners fire, per-step confirm or free-run, run-time parameter form (values panel-local). Masked steps and steps without a captured value always gate on a human under the guide overlay.
- **Evidence packs**: every Autopilot run (and walkthroughs with the 🧾 toggle) records a local run — per-step status (done/confirmed/manual/skipped/failed), timestamps, and a screenshot per completed step. Runs list on each library entry with a status-colored report and `.md`/`.html` export. Entirely local; masked-step values never stored.
- **Batch parameter sets**: paste a CSV runs table (columns = the recording's parameter names, validated locally, template download) and **⚡ Run all rows** — one run + evidence record per row, stop-on-failure. Script targets gain a `-CsvPath`/`--csv` batch-wrapper rule built from parameter *names* only; row values never leave the machine.
- **Drift sentinel**: ⏰ watches re-verify a recording's anchors every 24 h via an hourly alarm in an inactive tab (report-only). New problems raise a notification and a "!" badge that clears when the Library opens; unchanged drift and persistent login walls don't re-alert. New `alarms` + `notifications` permissions.
- **Branch-aware SOPs**: tag recordings as ⑂ variants of a trunk (grouped in the Library) and generate ONE SOP with numbered decision points, labeled branch sub-sequences, rejoin points, and a closing mermaid flowchart — variants travel as {op, step text} diff entries only, covered by the audit.
- **Library packs**: ⬇ exports a recording + screenshots as a shareable `.ptpack`; ⬆ imports it under a fresh id (step UUIDs kept). Runs, watch state, and runs-table values never travel.
- **Redaction brush**: 🖌 on any ledger or library screenshot opens a canvas editor — drag black rectangles, undo, Apply permanently replaces the stored screenshot everywhere (exports, packs, evidence).

## 1.4.0

- **Run-time parameters**: ⚙ marks input/select values as named per-run inputs (JML-style); SOPs get `<NAME>` placeholders and an Inputs list, scripts get mandatory named parameters, the audit lists them. Editable on live sessions and saved recordings.
- **HTTP capture + pure-HTTP PowerShell target**: while recording, the page's form posts and API calls are logged (values masked, secret-like query params scrubbed, extension calls excluded; new `webRequest` permission). The new "PowerShell web — HTTP only" target replays that log with `Invoke-WebRequest`/`Invoke-RestMethod` only: cookie-session continuity, CSRF extraction, status assertions — no browser required.
- **Delinea Secret Server mode**: a 🔐 checkbox on script targets makes generated scripts resolve every credential from on-prem Secret Server at runtime (module-free REST helpers, `-AuthMethod windows|token`, per-credential `-<Name>SecretId`), with the service-account password-rotation pattern: generate locally → change target → verify → write back to SS → loud out-of-sync failure.

## 1.3.0

- **Caption-on-capture** (opt-in): desktop window-capture frames are described by the configured vision model the moment they're captured; captions travel as text at generation, so desktop-heavy recordings generate as fast as web-only ones and the request stays text-only. Failures degrade to the previous attach-at-generation behavior.
- **Local-model defaults**: custom provider pre-fills `gemma4:12b-it-qat`; Ollama/LM Studio named in options; INSTALL gains a "fully local setup" guide (Ollama + local Whisper server), including the Ollama context-window gotcha.
- Desktop capture repositioned: UIA companion recommended (Windows), window-capture + captions as the no-install fallback.

## 1.2.0

- **Multi-anchor self-healing capture**: every web step records test-attribute / id / name-aria / structural anchors alongside the primary selector; Verify repairs the whole set, walkthroughs arm through any anchor, automation gets `alt_selectors` fallback chains. Legacy recordings behave unchanged.
- **Playwright export**: runnable Node script and a read-only `@playwright/test` regression spec (Verify Mode as a CI job).
- **Recording diff**: LCS-aligned comparison of two recordings (unchanged / relabeled / added / removed with sub-change flags), local `.md`/`.html` report, optional LLM change-management summary (step text only — never anchors or values), covered by the privacy audit.
- **Voice narration**: mic capture in the panel transcribed via any OpenAI-compatible Whisper endpoint (`verbose_json` segments), attributed to steps by timestamp; audio is never persisted; narration flows into generation as operator intent and is called out in the audit.

## 1.1.0

- **SOP Library**: IndexedDB-backed saved recordings (steps + screenshot Blobs) with open/rename/delete/re-generate; live-session screenshots also moved to IndexedDB, removing the ~60-step session ceiling (`maxSteps` default 150, max 500).
- **Verify Mode**: read-only anchor replay against the live UI with per-step traffic lights, SPA-tolerant navigation, per-frame probing, one-click selector repair, and a `lastVerified` stamp.
- **Guided Walkthrough**: load a saved SOP and be coached through it live — element highlighting, auto-advance on the real action, cross-page navigation, stale-anchor fallback, deadman overlay cleanup.
- **Privacy Audit**: one click renders the literal LLM request (built by the same code as the real call) with images redacted to size placeholders and credentials excluded; exportable as `.md`/`.html`/`.json`.
- Content script now runs in all frames; `webNavigation` permission added; browser-runnable pure-logic tests (`tests.html`) and a manual test script (`docs/TESTING.md`).

## 1.0.0

- Initial release: semantic web capture, window-capture mode, Windows UIA companion, privacy-inversion SOP generation with local screenshot splicing, PowerShell and Automation Anywhere targets.
