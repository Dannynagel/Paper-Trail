# Paper Trail — Alpha Test Harness

Headless, automated, and self-contained: everything here loads the **real
unpacked extension** in full Chromium (or the repo's `tests.html`) and drives
it the way a user would. Nothing in the extension is mocked — the only fakes
are local stub network endpoints and the fake microphone/media devices.

## The three runners

| Command | What it does |
|---|---|
| `node tests-run.js` | Opens the repo's `tests.html` (pure-logic assertions for `PTCommon`: label matching, anchors, URL identity, diff, narration mapping, audit stats, CSV parsing, run summaries) and reports the pass/fail count |
| `node smoke.js` | **v1.5/1.6-era end-to-end suite (103 checks, port 8917)**: recording, save, verify, walkthrough, SOP generation + privacy audit against a stub LLM endpoint, and the full v1.5 surface — Autopilot (free-run, per-step confirm, masked-value human gate, anchors-only stop, new-tab follow), evidence runs and cascade-delete, CSV runs table + Run-all-rows, drift sentinel (`sentinelRunNow`, alarm, badge, notify-once), branch-aware SOP payloads, `.ptpack` export→delete→import round-trip, redaction brush, the 🤖 AI-optional mode (toggle gating, worker refusal, local no-AI draft, caption gating), plus the 1.5.1 regression checks (import id-reminting, wrong-tab evidence refusal, walkthrough-evidence ordering, sentinel guards, durable drift badge) |
| `node smoke-features-1x.js` | **v1.1–v1.4 feature suite (39 checks, port 8907)**: multi-anchor capture + drift repair via the test attribute, masked-by-default typed values, run-time parameters in payloads, HTTP capture with masked secrets + the psweb HTTP-LOG target, Playwright targets with `alt_selectors`, Delinea Secret Server prompt rules + audit flag, recording diff + text-only diff audit, voice narration against a stub Whisper endpoint (per-step timestamp attribution), caption-on-capture, Ollama-friendly options defaults |

The two smoke suites are complementary (different fixtures and ports) — run
both before any commit that touches extension code. Together they are the
regression gate.

## Prerequisites

- Node 18+.
- `playwright` resolvable from this directory — either `npm i playwright`
  somewhere on the resolution path or `NODE_PATH=<global node_modules>`
  (e.g. `NODE_PATH=/opt/node22/lib/node_modules`).
- **Real Chromium.** Extensions do not load in the `chromium_headless_shell`
  build Playwright uses for plain headless runs. Set
  `PT_CHROMIUM=/path/to/chrome` to pick the binary; without it the harness
  tries `/opt/pw-browsers/chromium`, otherwise Playwright resolves its own
  bundled full Chromium (`npx playwright install chromium`).

## Running

```sh
cd alpha-test
node tests-run.js            # pure logic — fast
node smoke.js                # v1.5 end-to-end — a few minutes
node smoke-features-1x.js    # v1.1–v1.4 end-to-end — a few minutes
```

Each suite exits non-zero on any failed check and prints per-check
`PASS`/`FAIL` lines with diagnostics. Fixture pages and stub endpoints
(OpenAI-compatible chat that records request bodies; Whisper with
`verbose_json` segments) are served on localhost; browser state goes to a
throwaway profile under `/tmp` — your real Chrome data is never touched.

**Alpha status:** suites are green against v1.5.0 but coverage is still
uneven (e.g. desktop/UIA paths are simulated, not driven against real native
apps; real-site paths live in `../docs/TESTING.md` as manual walks). Treat a
red run as a hard stop; treat a green run as necessary, not sufficient, for
release.
