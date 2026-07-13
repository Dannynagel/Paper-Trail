# Paper Trail — automated test harness

Two runners, both headless:

| Command | What it does |
|---|---|
| `node tests-run.js` | Opens the repo's `tests.html` (pure-logic assertions for `PTCommon`) and reports the pass/fail count |
| `node smoke.js` | End-to-end suite: loads the **real unpacked extension** in Chromium, records on a local form page, and drives every feature through the side-panel page — recording, save, verify, walkthrough, generation + privacy audit (against a local stub LLM endpoint that captures request bodies), Autopilot (free-run, per-step confirm, masked-value human gate, anchors-only stop), evidence runs, CSV batch runs, drift sentinel, branch-aware SOP payloads, `.ptpack` round-trip, redaction brush |

## Prerequisites

- Node 18+.
- `playwright` resolvable from this directory — either `npm i playwright` somewhere on the resolution path or `NODE_PATH=<global node_modules>` (e.g. `NODE_PATH=/opt/node22/lib/node_modules`).
- **Real Chromium.** Extensions do not load in the `chromium_headless_shell` build Playwright uses for plain headless runs. Set `PT_CHROMIUM=/path/to/chrome` to pick the binary; without it the harness tries `/opt/pw-browsers/chromium` and otherwise lets Playwright resolve its bundled full Chromium (install with `npx playwright install chromium`).

## Running

```sh
cd test
node tests-run.js   # pure logic — fast
node smoke.js       # full end-to-end — a few minutes
```

`smoke.js` exits non-zero on any failed check and prints a failure list. It serves the fixture pages and the stub chat endpoint on `127.0.0.1:8917`, and uses a throwaway browser profile — nothing touches your real Chrome data.

When adding a feature, extend `smoke.js` with a new section (grep for
`FEATURE SECTIONS APPENDED BELOW`) and keep the whole suite green.
