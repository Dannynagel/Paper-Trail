# Paper Trail — Manual Test Script

There is no build step and most of the extension is Chrome-API glue, so testing is
two-layered: **pure logic** runs in `tests.html`, and the **integration paths** below
are walked by hand against a loaded unpacked extension (`chrome://extensions` →
Developer mode → Load unpacked). Re-run the relevant section after touching the
corresponding files.

## 0. Pure logic (automated)

Open `tests.html` in any browser (no extension needed). All assertions must be green.
Covers: label normalization/matching, SPA-tolerant URL identity, the verify summary
reducer, and the audit stats used by the privacy report.

## 1. Recording & library (db.js, library.js, background.js, sidepanel.js)

1. Record ~10 steps on a form-heavy site including a password field. Confirm the
   password step reads "Enter a value in …" with a `value masked` chip.
2. Steps show screenshots in the ledger (now loaded from IndexedDB). Delete one
   step; drop one screenshot — both stick after switching tabs and back.
3. **💾 Save** → the panel switches to Library, the recorder ledger clears, the
   entry shows title/date/step count/hosts.
4. Reload the extension (chrome://extensions → ↻). The library entry and all its
   screenshots survive. **Open** shows the read-only ledger with images.
5. Rename and delete an entry; deleting removes it permanently.
6. **Re-gen** an entry: `SOURCE ►` appears above Generate; generate an SOP; exported
   `.md`/`.html` contain the recording's screenshots spliced in. `✕ back to live`
   restores live-session generation.
7. Long-session check: record 100+ steps with screenshots (maxSteps raised in
   options). No screenshots are dropped and the panel stays responsive.

## 2. Verify Mode (verify.js, content.js resolveStep)

1. Save a recording on a stable site (e.g. a demo form). Run **✓ Verify** without
   changing the site → every web step green ("anchor healthy"), desktop/manual
   steps grey ("not verifiable"), summary like `9/9 anchors healthy`.
2. Break the page with DevTools on the live site (rename a button's text for one
   control, change an element's id for another) → re-verify: the id-change grades
   amber "drifted" with a suggested selector; the renamed control grades red
   "missing".
3. **Apply suggested selectors** → the entry's `lastVerified` note updates;
   re-verify → previously-amber step is green.
4. Record across 3 URLs, then make one URL dead (edit it in DevTools application
   storage or use a site you can take down) → that group grades "unreachable",
   the rest still verify; the run never hangs (20 s timeout per navigation).
5. A recording whose pages sit behind a login you're signed out of → steps grade
   "unreachable … login wall" rather than "missing".

## 3. Guided Walkthrough (walkthrough.js, content.js mode machine)

1. **▶ Walk** a saved web recording. Step 1's element is highlighted with the
   pulsing box + instruction tip; performing the real action (click / type-then-blur /
   select / Enter) advances automatically with a ripple. Complete the whole flow.
2. Cross-page step: the card offers **Take me there →**; after navigation the next
   step re-arms automatically (content script reloads on nav).
3. Stale anchor: break the target element in DevTools → the card shows "Couldn't
   find this element" with **Show me by text** (flashes candidates amber) and
   **Skip** still advances.
4. Desktop/UIA/manual steps show the instruction card + reference screenshot with
   **✓ Mark done** only.
5. **Back** re-arms the previous step; **✕ End** removes the page overlay
   immediately; closing the side panel clears the overlay within ~20 s (deadman).
6. Guard rails: starting a walkthrough while recording is blocked; starting a
   recording mid-walkthrough ends the walkthrough; a walkthrough produces **zero**
   session steps (check the Recorder tab afterwards).

## 4. Privacy Audit (background.js buildAudit)

1. With screenshots **off**, run **🔍 Preview what will be sent** for each target
   (SOP / PowerShell / AA). The body contains no image blocks, masked steps are
   listed, and the API key appears nowhere (search the `.json` export for it).
2. With screenshots **on**, the SOP audit shows image entries as
   `[[ N KB JPEG omitted … ]]` placeholders; automation audits stay text-only.
3. Ground truth check: open the service-worker DevTools → Network, run a real
   generation, and diff the request body against the audit's body — identical
   except the image placeholders.
4. **Audit** on a library entry audits that recording (not the live session).
5. The audit works with no API key configured (it must never require credentials).

## 5. v1.2 — Multi-anchor, Playwright export, Diff, Narration

Pure logic (`tests.html`): `anchorList` ordering/dedup/legacy, `diffSteps` +
`summarizeDiff` classification cases, `mapNarration` timestamp attribution,
`auditStats.narratedSteps`.

Manual integration paths (the automated smoke harness covers the rest with
stub endpoints and fake media devices):

1. **Multi-anchor**: record on a page whose controls carry `data-testid`;
   in DevTools rename an element's id → Verify grades amber with the
   test-attribute anchor as the repair; Apply, re-verify green; confirm the
   saved step's whole `anchors` object was replaced, not merged.
2. **Playwright**: generate both targets against a real provider; run the
   script (`node`) and the test (`npx playwright test`) against the live
   site; confirm masked values are demanded as `PT_*` env vars and the
   regression spec never clicks or types.
3. **Diff**: record the same procedure before/after a real UI change;
   Compare; sanity-check relabeled vs added/removed classifications; generate
   the change summary and confirm it invents nothing beyond the entries.
4. **Caption-on-capture**: enable the option against a real vision model,
   record a desktop window for a few state changes → 🖼→📝 captions appear
   under the frames within seconds; run the SOP audit → captioned frames are
   not attached and their captions appear in the user message; break the
   endpoint mid-recording → those frames stay uncaptioned and generation
   attaches them as before.
5. **Narration**: real mic — first 🎤 press in the side panel may open the
   `mic.html` helper tab; allow, close, press again. Speak while performing
   3+ steps; verify each 🎙 transcript lands on the step it followed; test a
   wrong transcription URL → error with a working Retry button; confirm no
   audio appears anywhere in IndexedDB (Application tab) or storage.

## 6. Regressions to spot-check after any content.js change

- Recording still captures clicks/inputs/selects/Enter/submit with correct labels.
- The capture ripple still appears; masked fields stay masked.
- Recording inside an iframe-hosted form now captures (all_frames).
- No console errors on pages where the extension is idle.
