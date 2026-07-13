# Paper Trail — Alpha Test Harness

End-to-end smoke suite that loads the unpacked extension in **real Chromium**
(headless) and drives it the way a user would — recording on a served fixture
page, generating against stub endpoints, and asserting on actual extension
state. Nothing in the extension itself is mocked; the only fakes are the
network endpoints and the microphone.

## What it covers (39 checks)

- **Recording**: click/input capture with real labels, primary selector +
  multi-anchor capture, default masking of typed values
- **Run-time parameters**: marking a step, the parameter riding into payloads
- **HTTP capture**: the page's own POST logged with masked secrets; the
  extension's own calls excluded
- **Library**: save/archive and persistence
- **Privacy audit**: builds without credentials, lists masked fields, never
  contains typed secrets
- **Verify**: all-healthy grading; deliberate selector break → drift repair
  via the test-attribute anchor; repair replaces the whole anchor set
- **Generation** (stub OpenAI-compatible endpoint): Playwright target with
  `alt_selectors`, read-only pwtest audit, psweb target with the HTTP LOG,
  Delinea Secret Server prompt rules + audit flag
- **Recording diff**: relabel/add classification and the text-only diff audit
- **Walkthrough**: tab open, overlay drawn, auto-advance on a real click,
  overlay cleanup
- **Voice narration** (stub Whisper endpoint, fake mic): multipart request
  shape, per-step transcript attribution, 🎙 ledger row, audit note, removal
- **Caption-on-capture**: desktop frame captioned via the stub; frame not
  attached at generation
- **Options**: Ollama-friendly custom-provider defaults

**Alpha status:** v1.5 features (Autopilot, evidence packs, batch CSV,
sentinel, branches, packs, redaction) are currently exercised only at load
time (service worker + panel boot with zero console errors); dedicated checks
for them are the next addition. The suite doubles as the regression gate —
run it before any commit that touches extension code. Pure-logic assertions
for `PTCommon` live separately in `../tests.html` (open in any browser).

## Running it

Requirements: Node 18+, the `playwright` npm package resolvable (a global
install via `NODE_PATH` works), and a **full Chromium** binary — Playwright's
headless-shell build cannot load extensions.

```bash
cd alpha-test
NODE_PATH=$(npm root -g) node smoke.js
# If Playwright's default browser is the headless shell:
PT_CHROMIUM=/path/to/full/chromium NODE_PATH=$(npm root -g) node smoke.js
```

Exit code 0 with `N/N checks passed` means green. Each check prints
`PASS`/`FAIL` with a diagnostic detail on failure.

## How it works

- `smoke.js` starts one local HTTP server (port 8907) serving: `/` → the
  `form.html` fixture (ids + `data-testid`, a password field, and a JSON
  `fetch` POST on click); `/chat` → stub OpenAI-compatible chat completions
  (captures each request body for assertions; answers captioning prompts
  differently); `/transcribe` → stub Whisper returning `verbose_json`
  segments; `/submit` → sink for the fixture's POST.
- Chromium launches with `--load-extension=<repo root>` plus fake-media flags
  so `getUserMedia` needs no prompt.
- The side panel and options pages are opened as ordinary tabs; tests drive
  the extension through its real message API (`chrome.runtime.sendMessage`)
  and DOM, and read state back the same way.
- Everything writes to a throwaway profile under `/tmp`; your real browser
  profile is never touched.
