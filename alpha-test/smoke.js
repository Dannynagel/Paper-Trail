// Paper Trail — end-to-end smoke test.
// Loads the unpacked extension in real Chromium, drives it through the side
// panel page (chrome.runtime.sendMessage + panel globals via evaluate), and
// asserts each feature end-to-end against a local form page and a stub
// OpenAI-compatible chat endpoint (which records every request body).
//
// Run: cd test && node smoke.js
// (if playwright is not installed locally, point NODE_PATH at a global
//  install, e.g. NODE_PATH=/opt/node22/lib/node_modules)
// PT_CHROMIUM overrides the Chromium binary; without it, a known default is
// tried and otherwise Playwright resolves its own bundled full Chromium.
// NOTE: extensions need REAL Chromium — the headless-shell build won't do.

const path = require("path");
const http = require("http");
const fs = require("fs");
const { chromium } = require("playwright");

const REPO = path.resolve(__dirname, "..");
const CHROMIUM_DEFAULT = "/opt/pw-browsers/chromium";
const CHROMIUM = process.env.PT_CHROMIUM ||
  (fs.existsSync(CHROMIUM_DEFAULT) ? CHROMIUM_DEFAULT : null);
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;

// ── Tiny check framework ────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else {
    failed++;
    const line = name + (extra !== undefined ? " — got: " + JSON.stringify(extra) : "");
    failures.push(line);
    console.log("  ✗ " + line);
  }
}
function section(name) { console.log("\n▶ " + name); }
async function waitFor(fn, { timeout = 20000, interval = 150, desc = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for " + desc);
    await new Promise(r => setTimeout(r, interval));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Local server: form page + stub chat endpoint ────────────────────────────
const llmRequests = [];       // every body POSTed to the OpenAI-shaped stub
const anthropicRequests = []; // {headers, body} POSTed to the Anthropic-shaped stub
const tokenRequests = [];     // bodies POSTed to the stub OAuth token endpoint
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/messages") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { anthropicRequests.push({ headers: req.headers, body: JSON.parse(body) }); }
      catch (e) { anthropicRequests.push({ headers: req.headers, parseError: String(e) }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "# Claude Stub\n\nSubscription-auth completion." }] }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/oauth/token") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { tokenRequests.push(JSON.parse(body)); } catch (e) { tokenRequests.push({ parseError: String(e) }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "tok-fresh", refresh_token: "r-fresh", expires_in: 3600 }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { llmRequests.push(JSON.parse(body)); } catch (e) { llmRequests.push({ parseError: String(e), raw: body.slice(0, 500) }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "# Stub Output\n\nCanned completion for smoke test." } }] }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/submit") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Submitted</title>OK");
    return;
  }
  const file = { "/form.html": "form.html", "/page2.html": "page2.html" }[req.url.split("?")[0]];
  if (file) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, file)));
    return;
  }
  res.writeHead(404); res.end("not found");
});

(async () => {
  server.listen(PORT);
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
    args: [
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream"
    ]
  });

  try {
    section("Extension boot");
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    check("service worker registered", !!extId, sw.url());

    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    check("side panel page loads", (await panel.title()) === "Paper Trail");

    // Panel-context helpers
    const send = (msg) => panel.evaluate(
      (m) => new Promise((r) => chrome.runtime.sendMessage(m, (resp) => r(resp))), msg);
    const state = async () => (await send({ cmd: "getState" })).session;

    await panel.evaluate((cfg) => new Promise((r) => chrome.storage.local.set(cfg, r)), {
      provider: "custom",
      customUrl: `${BASE}/v1/chat/completions`,
      captureValues: true,
      includeScreenshots: false
    });

    // ── Recording ───────────────────────────────────────────────────────────
    section("Recording on form.html");
    await send({ cmd: "start" });
    check("recording started", (await state()).recording === true);

    const form = await ctx.newPage();
    await form.goto(`${BASE}/form.html`);
    await waitFor(async () => (await state()).steps.some(s => s.type === "nav"),
      { desc: "nav step" });

    await form.click("#addItem");
    await waitFor(async () => (await state()).steps.some(s => s.type === "click"),
      { desc: "click step" });

    await form.locator("#fullName").pressSequentially("Ada Lovelace");
    await form.keyboard.press("Tab");
    await form.locator("#quantity").pressSequentially("3");
    await form.keyboard.press("Tab");
    await form.selectOption("#color", "Blue");
    await form.locator("#secretCode").pressSequentially("hunter2");
    await form.keyboard.press("Tab");
    await form.focus("#fullName");
    await form.keyboard.press("Enter");

    const steps = await waitFor(async () => {
      const s = (await state()).steps;
      return s.filter(x => x.type === "input").length >= 3 &&
             s.some(x => x.type === "select") &&
             s.some(x => x.type === "key") ? s : null;
    }, { desc: "all recorded steps" });

    const stepOf = (pred) => steps.find(pred);
    const clickStep = stepOf(s => s.type === "click" && /add item/i.test(s.label));
    const nameStep = stepOf(s => s.type === "input" && /full name/i.test(s.label));
    const qtyStep = stepOf(s => s.type === "input" && /quantity/i.test(s.label));
    const pwStep = stepOf(s => s.type === "input" && /password/i.test(s.label));
    const selStep = stepOf(s => s.type === "select");
    const keyStep = stepOf(s => s.type === "key");

    check("click captured with label + id selector",
      !!clickStep && clickStep.selector === "#addItem", clickStep && clickStep.selector);
    check("text input captured with value (captureValues on)",
      !!nameStep && nameStep.value === "Ada Lovelace" && nameStep.masked === false,
      nameStep && { value: nameStep.value, masked: nameStep.masked });
    check("quantity captured", !!qtyStep && qtyStep.value === "3", qtyStep && qtyStep.value);
    check("select captured by option label", !!selStep && selStep.value === "Blue", selStep && selStep.value);
    check("password captured masked with empty value",
      !!pwStep && pwStep.masked === true && pwStep.value === "", pwStep && { masked: pwStep.masked, value: pwStep.value });
    check("Enter key step captured", !!keyStep && keyStep.value === "Enter", keyStep);

    // Mark quantity as a run-time parameter
    await send({ cmd: "setParam", id: qtyStep.id, param: "QUANTITY" });
    check("param set on quantity step",
      (await state()).steps.find(s => s.id === qtyStep.id).param === "QUANTITY");

    // ── Save to library ─────────────────────────────────────────────────────
    section("Save to library");
    await send({ cmd: "stop" });
    await panel.evaluate(() => { window.prompt = () => "Smoke Rec"; window.confirm = () => true; });
    await panel.click("#btnSave");
    const recs = await waitFor(() => panel.evaluate(async () => {
      const l = await PTDB.listRecordings();
      return l.length ? l : null;
    }), { desc: "library entry" });
    check("recording saved", recs.length === 1 && recs[0].title === "Smoke Rec", recs);
    let recId = recs[0].id;
    check("recorder ledger cleared after save", (await state()).steps.length === 0);
    await form.close();

    // ── Verify ──────────────────────────────────────────────────────────────
    section("Verify mode");
    await panel.evaluate((id) => startVerify(id), recId);
    const verified = await waitFor(() => panel.evaluate(async (id) => {
      const r = await PTDB.getRecording(id);
      return (r.lastVerified && typeof verifyRun !== "undefined" && verifyRun === null) ? r : null;
    }, recId), { timeout: 45000, desc: "verify completion" });
    check("verify graded anchors healthy",
      /anchors healthy/.test(verified.lastVerified.summary) &&
      !/missing|drifted|unreachable/.test(verified.lastVerified.summary),
      verified.lastVerified.summary);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── Walkthrough ─────────────────────────────────────────────────────────
    section("Guided walkthrough");
    await panel.evaluate((id) => startWalkthrough(id), recId);
    const walkPage = await waitFor(async () => {
      for (const p of ctx.pages()) if (p !== panel && p.url().includes("form.html")) return p;
      return null;
    }, { desc: "walkthrough tab" });
    await waitFor(() => walkPage.locator(".paper-trail-guide-box").count(),
      { timeout: 30000, desc: "guide box armed" });
    const idxBefore = await panel.evaluate(() => walk.idx);
    await walkPage.click("#addItem");
    await waitFor(() => panel.evaluate((i) => walk && walk.idx > i, idxBefore),
      { desc: "walkthrough advance" });
    check("performing the real action advances the walkthrough", true);
    await panel.evaluate(() => endWalkthrough());
    check("walkthrough ends cleanly", await panel.evaluate(() => walk === null));
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── Generation + audit through the stub endpoint ────────────────────────
    section("Generation via stub endpoint");
    const gen = await send({ cmd: "generate", target: "sop", recordingId: recId, context: "smoke context" });
    check("SOP generation succeeds via stub", !!gen && gen.ok === true && /Stub Output/.test(gen.markdown), gen && (gen.error || gen.markdown));
    check("stub captured the request", llmRequests.length === 1);
    const sopReq = llmRequests[0] || {};
    const sysMsg = ((sopReq.messages || []).find(m => m.role === "system") || {}).content || "";
    const userMsg = ((sopReq.messages || []).find(m => m.role === "user") || {}).content || "";
    check("system prompt is the SOP prompt", /Standard Operating Procedure/.test(sysMsg));
    check("action log carries real labels, param name, no masked value",
      /Add item/.test(JSON.stringify(userMsg)) &&
      /QUANTITY/.test(JSON.stringify(userMsg)) &&
      !/hunter2/.test(JSON.stringify(sopReq)));

    const audit = await send({ cmd: "auditPayload", target: "powershell", recordingId: recId });
    check("automation audit builds", !!audit && audit.ok === true, audit && audit.error);
    check("audit body carries verbatim selectors and no pixels",
      audit.ok && /#addItem/.test(audit.audit.userText) && audit.audit.shotsAttached.length === 0);
    check("audit did not hit the network", llmRequests.length === 1);

    // ── Feature 1: Autopilot ────────────────────────────────────────────────
    section("Autopilot — free-run with param + masked human gate");
    await panel.evaluate((id) => startAutopilot(id, { QUANTITY: "7" }, { stepConfirm: false }), recId);
    const apPage = await waitFor(async () => {
      for (const p of ctx.pages()) if (p !== panel && p.url().includes("form.html")) return p;
      return null;
    }, { desc: "autopilot tab" });

    // Run proceeds until the masked password step gates on the human
    await waitFor(() => panel.evaluate(() =>
      ap && ap.waiting && ap.steps[ap.idx] && ap.steps[ap.idx].masked === true),
      { timeout: 30000, desc: "masked gate" });
    check("free-run pauses on the masked step", true);
    check("click step executed (page reacted)",
      (await apPage.locator("#clicks").textContent()) === "1",
      await apPage.locator("#clicks").textContent());
    check("recorded text value re-entered",
      (await apPage.inputValue("#fullName")) === "Ada Lovelace");
    check("param value filled from the run form",
      (await apPage.inputValue("#quantity")) === "7");
    check("select set by option label",
      (await apPage.inputValue("#color")) === "Blue");
    check("native setter fired framework-visible events",
      await apPage.evaluate(() =>
        window.__events.includes("quantity:input") && window.__events.includes("quantity:change") &&
        window.__events.includes("fullName:input")));
    check("masked value untouched by autopilot",
      (await apPage.inputValue("#secretCode")) === "");
    check("masked step shows the guide overlay",
      (await apPage.locator(".paper-trail-guide-box").count()) === 1);

    // The human types the secret; the change event completes the gate
    await apPage.locator("#secretCode").pressSequentially("hunter2");
    await apPage.keyboard.press("Tab");
    await waitFor(() => panel.evaluate(() => ap === null), { timeout: 30000, desc: "run completion" });
    check("run completes after human input", true);
    check("completion message rendered",
      await panel.evaluate(() => /Autopilot complete/.test($("libDetail").textContent)));
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    section("Autopilot — per-step confirm via setup form");
    await panel.evaluate((id) => startAutopilot(id), recId);
    check("setup form asks for the parameter",
      await panel.evaluate(() => !!document.querySelector("input[data-ap-param='QUANTITY']")));
    await panel.evaluate(() => {
      document.querySelector("input[data-ap-param='QUANTITY']").value = "5";
      document.getElementById("apSetupStart").click();
    });
    await waitFor(() => panel.evaluate(() =>
      ap && ap.waiting && !!document.getElementById("apExec")), { timeout: 30000, desc: "staged step" });
    const apPage2 = ctx.pages().find(p => p !== panel && p.url().includes("form.html"));
    check("staged step highlighted, not executed",
      (await apPage2.locator("#clicks").textContent()) === "0" &&
      (await apPage2.locator(".paper-trail-guide-box").count()) === 1);
    await panel.evaluate(() => document.getElementById("apExec").click());
    await waitFor(async () => (await apPage2.locator("#clicks").textContent()) === "1",
      { desc: "confirmed exec" });
    check("▶ executes the staged step", true);
    check("step graded confirmed",
      await panel.evaluate(() => ap && ap.states.includes("confirmed")));
    await panel.evaluate(() => document.getElementById("apAbort").click());
    await waitFor(() => panel.evaluate(() => ap === null), { desc: "abort" });
    check("abort ends the run", true);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    section("Autopilot — anchors only: label match never executes");
    const brokenId = await panel.evaluate(async (id) => {
      const rec = await PTDB.getRecording(id);
      const nav = rec.steps.find(s => s.type === "nav");
      const click = JSON.parse(JSON.stringify(rec.steps.find(s => s.type === "click")));
      click.selector = "#does-not-exist";
      click.anchors = { css: "#also-missing" };
      const broken = {
        id: crypto.randomUUID(), title: "Broken Rec", createdAt: Date.now(), updatedAt: Date.now(),
        stepCount: 2, urlHosts: rec.urlHosts, source: "web",
        steps: [JSON.parse(JSON.stringify(nav)), click].map((s, i) => ({ ...s, n: i + 1 }))
      };
      await PTDB.saveRecording(broken);
      return broken.id;
    }, recId);
    await panel.evaluate((id) => startAutopilot(id, {}, { stepConfirm: false }), brokenId);
    await waitFor(() => panel.evaluate(() =>
      ap && ap.waiting && ap.states.includes("failed")), { timeout: 30000, desc: "failed stop" });
    const apPage3 = ctx.pages().find(p => p !== panel && p.url().includes("form.html"));
    check("broken anchors stop the run even though the label exists",
      (await apPage3.locator("#clicks").textContent()) === "0");
    check("failure reason reported",
      await panel.evaluate(() => /anchor/.test(ap.failReason || "")),
      await panel.evaluate(() => ap.failReason));
    await panel.evaluate(() => document.getElementById("apAbort").click());
    await waitFor(() => panel.evaluate(() => ap === null), { desc: "abort broken run" });
    await panel.evaluate((id) => PTDB.deleteRecording(id), brokenId);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── Feature 2: Evidence packs ───────────────────────────────────────────
    section("Evidence runs");
    const runs = await panel.evaluate((id) => PTDB.listRunsByRec(id), recId);
    check("both autopilot runs recorded (free-run + aborted confirm run)",
      runs.length === 2, runs.length);
    const fullRun = runs.find(r => !r.steps.some(s => s.status === "failed") &&
      r.steps.some(s => s.status === "manual"));
    check("completed run exists with mode + finishedAt",
      !!fullRun && fullRun.mode === "autopilot" && fullRun.finishedAt > fullRun.startedAt);
    check("run stores non-sensitive params only",
      !!fullRun && fullRun.params.QUANTITY === "7" &&
      !JSON.stringify(fullRun).includes("hunter2"), fullRun && fullRun.params);
    const statuses = fullRun ? fullRun.steps.map(s => s.status) : [];
    check("per-step statuses recorded (done / manual / skipped)",
      statuses.includes("done") && statuses.includes("manual") && statuses.includes("skipped"),
      statuses);
    check("masked password step graded manual",
      !!fullRun && fullRun.steps.find(s => /Password/i.test(s.text || "")).status === "manual");
    const runMd = await panel.evaluate((rid) => PTDB.getRun(rid).then(r => runReportMarkdown(r)), fullRun.id);
    check("evidence report export carries statuses and outcome",
      /\*\*done\*\*/.test(runMd) && /\*\*manual\*\*/.test(runMd) && /executed/.test(runMd) &&
      /QUANTITY = 7/.test(runMd));
    const runShots = await panel.evaluate((rid) => PTDB.getShotsByRec("run:" + rid), fullRun.id);
    const claimedShots = fullRun.steps.filter(s => s.hasShot).length;
    check("evidence screenshots stored under the run (hasShot ↔ shots store)",
      runShots.length === claimedShots, { stored: runShots.length, claimed: claimedShots });
    check("deleting a recording cascades to its runs",
      (await panel.evaluate((id) => PTDB.listRunsByRec(id), brokenId)).length === 0);

    // ── Feature 3: Batch parameter sets (CSV) ───────────────────────────────
    section("Runs table (CSV) via the library UI");
    await panel.evaluate((id) => openRecording(id), recId);
    await waitFor(() => panel.evaluate(() => !!document.getElementById("csvText")),
      { desc: "runs table section" });
    await panel.evaluate(() => {
      document.getElementById("csvText").value = "WRONG\n1";
      document.getElementById("csvSave").click();
    });
    await sleep(300);
    check("CSV header mismatch rejected locally",
      await panel.evaluate(() => /Header mismatch/.test($("csvStatus").textContent)));
    await panel.evaluate(() => {
      document.getElementById("csvText").value = "QUANTITY\r\n11\r\n22\r\n";
      document.getElementById("csvSave").click();
    });
    const savedSets = await waitFor(() => panel.evaluate(async (id) => {
      const r = await PTDB.getRecording(id);
      return r.paramSets && r.paramSets.length === 2 ? r.paramSets : null;
    }, recId), { desc: "paramSets saved" });
    check("CSV rows saved to rec.paramSets",
      savedSets[0].values.QUANTITY === "11" && savedSets[1].values.QUANTITY === "22", savedSets);

    section("Run all rows — sequential runs, evidence per row");
    const runsBefore = (await panel.evaluate((id) => PTDB.listRunsByRec(id), recId)).length;
    await panel.evaluate((id) => startAutopilotBatch(id), recId);
    // Row 1 gates on the masked password
    const batchPage = await waitFor(async () => {
      for (const p of ctx.pages()) if (p !== panel && p.url().includes("form.html")) return p;
      return null;
    }, { desc: "batch tab" });
    await waitFor(() => panel.evaluate(() =>
      ap && ap.batch && ap.batch.index === 0 && ap.waiting && ap.steps[ap.idx].masked),
      { timeout: 30000, desc: "row 1 masked gate" });
    check("row 1 runs with its own param value",
      (await batchPage.inputValue("#quantity")) === "11");
    await batchPage.locator("#secretCode").pressSequentially("x");
    await batchPage.keyboard.press("Tab");
    // Row 2 starts automatically in the same tab and gates again
    await waitFor(() => panel.evaluate(() =>
      ap && ap.batch && ap.batch.index === 1 && ap.waiting && ap.steps[ap.idx].masked),
      { timeout: 40000, desc: "row 2 masked gate" });
    check("row 2 chains automatically with the next value",
      (await batchPage.inputValue("#quantity")) === "22");
    await batchPage.locator("#secretCode").pressSequentially("y");
    await batchPage.keyboard.press("Tab");
    await waitFor(() => panel.evaluate(() => ap === null), { timeout: 40000, desc: "batch completion" });
    const runsAfter = await panel.evaluate((id) => PTDB.listRunsByRec(id), recId);
    check("one evidence record per row", runsAfter.length === runsBefore + 2, runsAfter.length);
    const rowRuns = runsAfter.filter(r => r.batchRow).sort((a, b) => a.startedAt - b.startedAt);
    check("row runs carry their row name and param values",
      rowRuns.length === 2 && rowRuns[0].params.QUANTITY === "11" && rowRuns[1].params.QUANTITY === "22",
      rowRuns.map(r => r.params));
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    section("CSV batch rule in generation payload (names only)");
    const llmBefore = llmRequests.length;
    const genPs = await send({ cmd: "generate", target: "powershell", recordingId: recId });
    check("PowerShell generation succeeds", !!genPs && genPs.ok === true, genPs && genPs.error);
    const psReq = llmRequests[llmBefore] || {};
    const psSys = ((psReq.messages || []).find(m => m.role === "system") || {}).content || "";
    check("batch wrapper rule appended with param names",
      /-CsvPath/.test(psSys) && /Import-Csv/.test(psSys) && /QUANTITY/.test(psSys));
    check("CSV row values never sent",
      !JSON.stringify(psReq).includes('"11"') && !JSON.stringify(psReq).match(/=\s*22\b/) &&
      !/\b11,22\b/.test(JSON.stringify(psReq)));
    const auditPs = await send({ cmd: "auditPayload", target: "powershell", recordingId: recId });
    check("audit shows the same batch rule (payload-identical)",
      auditPs.ok && /-CsvPath/.test(auditPs.audit.system));

    // ── Feature 4: Drift sentinel ───────────────────────────────────────────
    section("Drift sentinel");
    await panel.evaluate(async (id) => {
      await renderLibrary();
      document.querySelector(`.lib-row[data-id="${id}"] button[data-act="watch"]`).click();
    }, recId);
    await waitFor(() => panel.evaluate(async (id) =>
      !!(await PTDB.getRecording(id)).watch, recId), { desc: "watch enabled" });
    check("watch toggle stores rec.watch", true);
    const alarms = await waitFor(async () => {
      const all = await panel.evaluate(() => chrome.alarms.getAll());
      return all.some(a => a.name === "pt-sentinel") ? all : null;
    }, { desc: "pt-sentinel alarm" });
    check("hourly pt-sentinel alarm scheduled",
      alarms.some(a => a.name === "pt-sentinel" && a.periodInMinutes === 60), alarms);

    // Break the click step's anchors (label still findable → grades "drifted")
    const origAnchor = await panel.evaluate(async (id) => {
      const rec = await PTDB.getRecording(id);
      const s = rec.steps.find(x => x.type === "click");
      const orig = { selector: s.selector, anchors: s.anchors };
      s.selector = "#gone-missing";
      s.anchors = { css: "#also-gone" };
      await PTDB.saveRecording(rec);
      return orig;
    }, recId);
    const sen1 = await send({ cmd: "sentinelRunNow", recId });
    check("sentinelRunNow grades the drift", sen1.ok && /drifted/.test(sen1.summary), sen1);
    const afterSen = await panel.evaluate((id) => PTDB.getRecording(id), recId);
    check("lastVerified stamped by the sentinel",
      /sentinel/.test(afterSen.lastVerified.summary) && afterSen.watch.lastRun > 0);
    check("new drift notified once (lastNotified set)", afterSen.watch.lastNotified > 0);
    check("action badge shows !",
      (await panel.evaluate(() => chrome.action.getBadgeText({}))) === "!");

    const sen2 = await send({ cmd: "sentinelRunNow", recId });
    const afterSen2 = await panel.evaluate((id) => PTDB.getRecording(id), recId);
    check("unchanged drift does not re-notify",
      sen2.ok && afterSen2.watch.lastNotified === afterSen.watch.lastNotified);

    // 1.5.1 fix: the "!" badge derives from a durable flag — REC replaces it
    // during a recording and it comes back after, instead of being wiped.
    await send({ cmd: "start" });
    await waitFor(async () =>
      (await panel.evaluate(() => chrome.action.getBadgeText({}))) === "REC", { desc: "REC badge" });
    await send({ cmd: "stop" });
    await waitFor(async () =>
      (await panel.evaluate(() => chrome.action.getBadgeText({}))) === "!",
      { desc: "badge restored after recording" });
    check("sentinel badge survives a record/stop cycle", true);

    await panel.evaluate(() => renderLibrary());
    await waitFor(async () =>
      (await panel.evaluate(() => chrome.action.getBadgeText({}))) === "", { desc: "badge cleared" });
    check("opening the Library clears the badge", true);

    // Restore anchors + disable the watch
    await panel.evaluate(async ({ id, orig }) => {
      const rec = await PTDB.getRecording(id);
      const s = rec.steps.find(x => x.type === "click");
      s.selector = orig.selector;
      s.anchors = orig.anchors;
      delete rec.watch;
      await PTDB.saveRecording(rec);
      await new Promise(r => chrome.runtime.sendMessage({ cmd: "watchChanged" }, r));
    }, { id: recId, orig: origAnchor });
    check("clearing the last watch removes the alarm",
      !(await panel.evaluate(() => chrome.alarms.getAll())).some(a => a.name === "pt-sentinel"));
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── Feature 5: Branch-aware SOPs ────────────────────────────────────────
    section("Branch-aware SOPs");
    const variantId = await panel.evaluate(async (id) => {
      const trunk = await PTDB.getRecording(id);
      const v = JSON.parse(JSON.stringify(trunk));
      v.id = crypto.randomUUID();
      v.title = "Smoke Rec — contractor";
      delete v.paramSets;
      // diverge: relabel the click step + add an extra approval step
      const click = v.steps.find(s => s.type === "click");
      click.label = "Add contractor item";
      click.text = "Click **Add contractor item** (button)";
      const last = v.steps[v.steps.length - 1];
      v.steps.push({ ...last, id: crypto.randomUUID(), n: v.steps.length + 1,
        type: "click", label: "Approve contractor", kind: "button",
        text: "Click **Approve contractor** (button)", selector: "#approve" });
      v.stepCount = v.steps.length;
      v.steps.forEach((s, i) => s.n = i + 1);
      await PTDB.saveRecording(v);
      return v.id;
    }, recId);
    // Tag via the two-click UI flow: ⑂ on the variant, then ⑂ on the trunk
    await panel.evaluate(async ({ vid, tid }) => {
      window.prompt = () => "Contractor path";
      await renderLibrary();
      document.querySelector(`.lib-row[data-id="${vid}"] button[data-act="variant"]`).click();
    }, { vid: variantId, tid: recId });
    await waitFor(() => panel.evaluate(() => /pick the TRUNK/.test($("libStatus").textContent)),
      { desc: "variant picker state" });
    await panel.evaluate((tid) =>
      document.querySelector(`.lib-row[data-id="${tid}"] button[data-act="variant"]`).click(), recId);
    const taggedVariant = await waitFor(() => panel.evaluate(async (vid) => {
      const v = await PTDB.getRecording(vid);
      return v.variantOf ? v : null;
    }, variantId), { desc: "variant tagged" });
    check("variant tagged with trunk + label",
      taggedVariant.variantOf === recId && taggedVariant.variantLabel === "Contractor path");
    await panel.evaluate(() => renderLibrary());
    await waitFor(() => panel.evaluate(() => !!document.querySelector("button[data-act='branch']")),
      { desc: "library re-render" });
    check("library groups the variant under its trunk (indented, chip, ⑂ SOP button)",
      await panel.evaluate(({ vid, tid }) => {
        const rows = [...document.querySelectorAll(".lib-row")].map(r => r.dataset.id);
        const vRow = document.querySelector(`.lib-row[data-id="${vid}"]`);
        const tRow = document.querySelector(`.lib-row[data-id="${tid}"]`);
        return rows.indexOf(vid) === rows.indexOf(tid) + 1 &&
          vRow.style.marginLeft !== "" &&
          !!tRow.querySelector("button[data-act='branch']");
      }, { vid: variantId, tid: recId }));

    const llmBeforeBranch = llmRequests.length;
    const branchGen = await send({ cmd: "generateBranch", trunkId: recId, context: "" });
    check("generateBranch succeeds via stub", !!branchGen && branchGen.ok === true, branchGen && branchGen.error);
    const brReq = llmRequests[llmBeforeBranch] || {};
    const brSys = ((brReq.messages || []).find(m => m.role === "system") || {}).content || "";
    const brUser = String(((brReq.messages || []).find(m => m.role === "user") || {}).content || "");
    check("BRANCH_PROMPT sent (decision points + mermaid)",
      /decision point/i.test(brSys) && /mermaid/.test(brSys));
    check("payload carries variant label and diff entries (text only)",
      /Contractor path/.test(brUser) && /"added"/.test(brUser) &&
      /Approve contractor/.test(brUser) && !/#approve/.test(brUser));
    const brAudit = await send({ cmd: "auditPayload", target: "branch", recordingId: recId });
    check("branch audit builds and mirrors the payload",
      brAudit.ok && brAudit.audit.system === brSys && brAudit.audit.shotsAttached.length === 0);

    // ── Feature 6: Library packs (.ptpack) ──────────────────────────────────
    section("Library packs — export → delete → import round-trip");
    // Deterministic screenshot for the round-trip (capture can be flaky headless)
    const shotSig = await panel.evaluate(async (id) => {
      const rec = await PTDB.getRecording(id);
      const step = rec.steps.find(s => s.type === "click");
      const bytes = new Uint8Array(64).map((_, i) => (i * 7 + 13) & 0xff);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      await PTDB.putShot({ stepId: step.id, recId: id, blob });
      return { stepId: step.id, size: blob.size };
    }, recId);
    const pack = await panel.evaluate((id) => buildPack(id), recId);
    check("pack format + recording + screenshot present",
      pack.format === "ptpack/1" && pack.rec.title === "Smoke Rec" &&
      pack.shots.some(s => s.stepId === shotSig.stepId && s.b64.startsWith("data:image/")));
    check("pack excludes local state (watch, paramSets, runs)",
      pack.rec.watch === undefined && pack.rec.paramSets === undefined &&
      !("runs" in pack) && JSON.stringify(pack).indexOf('"batchRow"') === -1);
    // Import WHILE the original still exists: step ids must be reminted so
    // the original's screenshots are not stolen (the shots store is keyed
    // globally by stepId — regression test for the 1.5.1 fix).
    const importedId = await panel.evaluate((p) => importPack(p), pack);
    const importedRec = await panel.evaluate((id) => PTDB.getRecording(id), importedId);
    check("import restores the recording under fresh recording AND step ids",
      importedRec.id !== recId && importedRec.title === "Smoke Rec" &&
      importedRec.steps.length === pack.rec.steps.length &&
      !importedRec.steps.some(s => s.id === shotSig.stepId));
    const origShot = await panel.evaluate((sid) => PTDB.getShot(sid).then(s =>
      s && { size: s.blob.size, recId: s.recId }), shotSig.stepId);
    check("original recording keeps its screenshot after import",
      !!origShot && origShot.recId === recId && origShot.size === shotSig.size, origShot);
    const importedClickId = importedRec.steps.find(s => s.type === "click").id;
    const importedShot = await panel.evaluate((sid) => PTDB.getShot(sid).then(s =>
      s && { size: s.blob.size, recId: s.recId }), importedClickId);
    check("screenshot bytes restored under the imported copy's reminted id",
      !!importedShot && importedShot.size === shotSig.size && importedShot.recId === importedId,
      importedShot);
    check("garbage import rejected",
      await panel.evaluate(() => importPack({ format: "nope" }).then(() => false, () => true)));
    await panel.evaluate((id) => PTDB.deleteRecording(id), importedId); // keep the original for later sections

    // ── Feature 7: Redaction brush ──────────────────────────────────────────
    section("Redaction brush");
    // Replace the synthetic shot with a real red JPEG so bitmaps decode
    const redactTarget = await panel.evaluate(async (id) => {
      const rec = await PTDB.getRecording(id);
      const step = rec.steps.find(s => s.type === "click");
      const c = new OffscreenCanvas(200, 120);
      const cx = c.getContext("2d");
      cx.fillStyle = "#c00";
      cx.fillRect(0, 0, 200, 120);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      await PTDB.putShot({ stepId: step.id, recId: id, blob });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { stepId: step.id, size: blob.size, sum: bytes.reduce((a, b) => a + b, 0) };
    }, recId);

    check("pure redactBlob changes the bytes and blacks out the region",
      await panel.evaluate(async ({ stepId }) => {
        const shot = await PTDB.getShot(stepId);
        const out = await redactBlob(shot.blob, [{ x: 20, y: 20, w: 80, h: 40 }]);
        const bmp = await createImageBitmap(out);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = c.getContext("2d");
        cx.drawImage(bmp, 0, 0);
        const inside = cx.getImageData(50, 40, 1, 1).data;
        const outside = cx.getImageData(150, 100, 1, 1).data;
        const origBytes = new Uint8Array(await shot.blob.arrayBuffer());
        const newBytes = new Uint8Array(await out.arrayBuffer());
        return inside[0] < 40 && inside[1] < 40 && inside[2] < 40 &&
               outside[0] > 150 && bmp.width === 200 &&
               (origBytes.length !== newBytes.length ||
                origBytes.some((b, i) => b !== newBytes[i]));
      }, redactTarget));

    // Drive the modal end-to-end: open → drag → Apply (confirm stubbed)
    await panel.evaluate(({ stepId }) => {
      window.confirm = () => true;
      openRedactor(stepId);
    }, redactTarget);
    const canvasBox = await waitFor(async () => {
      const el = panel.locator("#redactCanvas");
      return (await el.count()) ? await el.boundingBox() : null;
    }, { desc: "redactor modal" });
    await panel.mouse.move(canvasBox.x + 10, canvasBox.y + 10);
    await panel.mouse.down();
    await panel.mouse.move(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + canvasBox.height * 0.4, { steps: 5 });
    await panel.mouse.up();
    await panel.click("#redactApply");
    await waitFor(() => panel.evaluate(() => !document.getElementById("redactModal")),
      { desc: "modal closed" });
    const applied = await panel.evaluate(async ({ stepId }) => {
      const shot = await PTDB.getShot(stepId);
      const bytes = new Uint8Array(await shot.blob.arrayBuffer());
      const bmp = await createImageBitmap(shot.blob); // still a valid image
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = c.getContext("2d");
      cx.drawImage(bmp, 0, 0);
      const inside = cx.getImageData(30, 25, 1, 1).data;
      return { size: shot.blob.size, sum: bytes.reduce((a, b) => a + b, 0),
               w: bmp.width, dark: inside[0] < 40 && inside[1] < 40 && inside[2] < 40 };
    }, redactTarget);
    check("Apply replaces the stored blob at the same stepId",
      applied.sum !== redactTarget.sum || applied.size !== redactTarget.size, applied);
    check("stored screenshot is redacted and still decodable",
      applied.w === 200 && applied.dark, applied);

    // ── Multi-tab Autopilot: follow a click into a new tab ──────────────────
    section("Autopilot — follows a click into a new tab");
    await send({ cmd: "start" });
    const mtForm = await ctx.newPage();
    await mtForm.goto(`${BASE}/form.html`);
    await waitFor(async () => (await state()).steps.some(s => s.type === "nav"),
      { desc: "mt nav step" });
    const [mtDetails] = await Promise.all([
      ctx.waitForEvent("page"),
      mtForm.click("#openDetails")
    ]);
    await mtDetails.waitForLoadState();
    await waitFor(async () => (await state()).steps.some(s =>
      s.type === "click" && /open details/i.test(s.label)), { desc: "link click step" });
    await mtDetails.click("#confirmDetails");
    await waitFor(async () => (await state()).steps.some(s =>
      s.type === "click" && /confirm details/i.test(s.label)), { desc: "cross-tab click step" });
    check("recording captured the click in the child tab", true);
    await send({ cmd: "stop" });
    await panel.evaluate(() => { window.prompt = () => "Multi Tab Rec"; });
    await panel.click("#tabBtnRecorder"); // earlier sections left the panel on the Library tab
    await panel.click("#btnSave");
    const mtRecId = await waitFor(() => panel.evaluate(async () => {
      const l = await PTDB.listRecordings();
      const r = l.find(x => x.title === "Multi Tab Rec");
      return r ? r.id : null;
    }), { desc: "multi-tab rec saved" });
    await mtForm.close();
    await mtDetails.close();

    await panel.evaluate((id) => startAutopilot(id, {}, { stepConfirm: false }), mtRecId);
    await waitFor(() => panel.evaluate(() => ap === null),
      { timeout: 60000, desc: "multi-tab run completion" });
    const mtPages = ctx.pages().filter(p => p !== panel);
    const mtRunForm = mtPages.find(p => p.url().includes("form.html"));
    const mtRunDetails = mtPages.find(p => p.url().includes("page2.html"));
    check("child tab was opened and adopted (both pages live)",
      !!mtRunForm && !!mtRunDetails, mtPages.map(p => p.url()));
    check("step executed in the adopted tab",
      !!mtRunDetails && (await mtRunDetails.locator("#confirms").textContent()) === "1");
    check("original tab never navigated away",
      !!mtRunForm && mtRunForm.url().includes("form.html"));
    const mtRuns = await panel.evaluate((id) => PTDB.listRunsByRec(id), mtRecId);
    check("multi-tab run completed clean (no failed/skipped steps)",
      mtRuns.length === 1 && mtRuns[0].steps.every(s => s.status === "done"),
      mtRuns[0] && mtRuns[0].steps.map(s => `${s.n}:${s.status}`));
    await panel.evaluate((id) => PTDB.deleteRecording(id), mtRecId);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── 1.5.1 review fixes ──────────────────────────────────────────────────
    section("Evidence capture refuses a non-visible run tab");
    const bgTab = await ctx.newPage();
    await bgTab.goto(`${BASE}/form.html`);
    const fgTab = await ctx.newPage();
    await fgTab.goto(`${BASE}/page2.html`); // now the active tab
    const refusal = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const hidden = tabs.find(t => t.url && t.url.endsWith("/form.html") && !t.active);
      return await new Promise(r => chrome.runtime.sendMessage(
        { cmd: "evidenceShot", runId: "smoke-refusal", n: 1, tabId: hidden && hidden.id }, r));
    });
    check("evidenceShot refuses when the run tab is not visible",
      !!refusal && refusal.ok === false, refusal);
    check("no wrong-tab evidence stored",
      (await panel.evaluate(() => PTDB.getShotsByRec("run:smoke-refusal"))).length === 0);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    section("Walkthrough evidence (🧾) — ordered entries, no double-advance");
    await panel.evaluate((id) => startWalkthrough(id), recId);
    await waitFor(() => panel.evaluate(() => typeof walk !== "undefined" && !!walk),
      { desc: "walk started" });
    await panel.evaluate(() => { walk.evidence = true; });
    const wPage = await waitFor(async () => {
      for (const p of ctx.pages()) if (p !== panel && p.url().includes("form.html")) return p;
      return null;
    }, { desc: "walk tab" });
    await waitFor(() => wPage.locator(".paper-trail-guide-box").count(),
      { timeout: 30000, desc: "walk armed" });
    const wIdx = await panel.evaluate(() => walk.idx);
    await wPage.click("#addItem");
    await waitFor(() => panel.evaluate((i) => walk && walk.idx > i, wIdx), { desc: "walk advance" });
    await panel.evaluate(() => endWalkthrough());
    await waitFor(() => panel.evaluate(() => walk === null), { desc: "walk ended" });
    const wRuns = await panel.evaluate((id) => PTDB.listRunsByRec(id), recId);
    const wRun = wRuns.find(r => r.mode === "walkthrough");
    check("walkthrough evidence run saved with completed entries",
      !!wRun && wRun.steps.length >= 1 && wRun.steps.every(x => x.status === "done"),
      wRun && wRun.steps);
    check("no duplicated step entries (re-entrancy regression)",
      !!wRun && new Set(wRun.steps.map(x => x.n)).size === wRun.steps.length);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    section("sentinelRunNow guards");
    await send({ cmd: "start" });
    const senBlocked = await send({ cmd: "sentinelRunNow", recId });
    check("sentinelRunNow refused while recording",
      !!senBlocked && senBlocked.ok === false && /recording/i.test(senBlocked.error || ""), senBlocked);
    await send({ cmd: "stop" });
    const senAfter = await send({ cmd: "sentinelRunNow", recId });
    check("sentinelRunNow works again after recording stops",
      !!senAfter && senAfter.ok === true, senAfter);
    for (const p of ctx.pages()) if (p !== panel) await p.close().catch(() => {});

    // ── 1.6.0: AI features are optional ─────────────────────────────────────
    section("AI toggle — off means nothing reaches a model");
    await panel.click("#tabBtnRecorder");
    await panel.click("#useAI"); // default on → off
    await waitFor(() => panel.evaluate(async () =>
      (await chrome.storage.local.get({ aiEnabled: true })).aiEnabled === false),
      { desc: "aiEnabled persisted off" });
    check("toggle persists and gates the panel UI",
      await panel.evaluate(() =>
        $("btnMic").disabled && $("btnGenerate").hidden && $("btnAudit").hidden &&
        !$("aiOffNote").hidden && $("btnLocalSop").classList.contains("primary")));
    const llmBeforeOff = llmRequests.length;
    const genOff = await send({ cmd: "generate", target: "sop", recordingId: recId });
    check("worker refuses generation while AI is off",
      !!genOff && genOff.ok === false && /AI features are off/.test(genOff.error || ""), genOff);
    check("no request left the machine", llmRequests.length === llmBeforeOff);

    section("Local no-AI SOP draft");
    await panel.evaluate(async (id) => setGenSource(await PTDB.getRecording(id)), recId);
    await panel.click("#btnLocalSop");
    await waitFor(() => panel.evaluate(() => !$("result").hidden), { desc: "local draft rendered" });
    const localMd = await panel.evaluate(() => currentMarkdown);
    check("draft assembled from the recorded steps",
      /## Procedure/.test(localMd) && /Add item/.test(localMd) && /no AI model involved/.test(localMd));
    check("param placeholder replaces the sample value",
      /<QUANTITY>/.test(localMd) && !/Enter "3"/.test(localMd));
    check("screenshots spliced locally into the preview",
      await panel.evaluate(() => $("preview").innerHTML.includes("<img")));
    check("building the draft sent nothing", llmRequests.length === llmBeforeOff);
    await panel.evaluate(() => setGenSource(null));

    section("Caption-on-capture honors the AI toggle");
    await panel.evaluate((cfg) => chrome.storage.local.set(cfg), { captionOnCapture: true });
    await send({ cmd: "start" });
    const tinyShot = await panel.evaluate(async () => {
      const c = new OffscreenCanvas(80, 50);
      const cx = c.getContext("2d");
      cx.fillStyle = "#08a";
      cx.fillRect(0, 0, 80, 50);
      return await PTCommon.blobToDataUrl(await c.convertToBlob({ type: "image/jpeg" }));
    });
    await send({ cmd: "addDesktopStep", shot: tinyShot, label: "Test window", manual: true });
    await sleep(900);
    const deskOff = (await state()).steps.filter(x => x.type === "desktop");
    check("AI off: desktop frame stays uncaptioned, no request",
      deskOff.length === 1 && !deskOff[0].caption && llmRequests.length === llmBeforeOff,
      deskOff.map(x => x.caption));
    await panel.click("#useAI"); // back on
    await waitFor(() => panel.evaluate(async () =>
      (await chrome.storage.local.get({ aiEnabled: true })).aiEnabled === true),
      { desc: "aiEnabled back on" });
    await send({ cmd: "addDesktopStep", shot: tinyShot, label: "Test window", manual: true });
    await waitFor(async () => {
      const d = (await state()).steps.filter(x => x.type === "desktop");
      return d.length === 2 && /Stub Output/.test(d[1].caption || "");
    }, { desc: "caption arrives with AI on" });
    check("AI on: the same frame gets captioned via the endpoint", true);
    check("AI generation controls restored",
      await panel.evaluate(() => !$("btnGenerate").hidden && !$("btnMic").disabled));
    await send({ cmd: "stop" });
    await send({ cmd: "clear" });
    await panel.evaluate((cfg) => chrome.storage.local.set(cfg), { captionOnCapture: false });

    // ── 1.7.0: Claude account (OAuth) as an alternative to an API key ──────
    section("Claude account provider — Bearer auth + automatic refresh");
    await panel.evaluate((cfg) => chrome.storage.local.set(cfg), {
      provider: "claude",
      anthropicUrl: `${BASE}/v1/messages`,
      claudeTokenUrl: `${BASE}/oauth/token`,
      claudeClientId: "smoke-client",
      claudeAuth: { accessToken: "tok-old", refreshToken: "r-old", expiresAt: Date.now() - 1000 }
    });
    const genClaude = await send({ cmd: "generate", target: "sop", recordingId: recId });
    check("generation succeeds via the Claude account path",
      !!genClaude && genClaude.ok === true && /Claude Stub/.test(genClaude.markdown),
      genClaude && genClaude.error);
    check("expired token was refreshed first (grant_type/refresh_token/client_id)",
      tokenRequests.length === 1 && tokenRequests[0].grant_type === "refresh_token" &&
      tokenRequests[0].refresh_token === "r-old" && tokenRequests[0].client_id === "smoke-client",
      tokenRequests[0]);
    const aReq = anthropicRequests[0] || { headers: {} };
    check("request carries Bearer + oauth beta header, no API key",
      aReq.headers.authorization === "Bearer tok-fresh" &&
      /oauth/.test(aReq.headers["anthropic-beta"] || "") &&
      aReq.headers["x-api-key"] === undefined &&
      /Standard Operating Procedure/.test(aReq.body.system || ""),
      aReq.headers);
    check("refreshed tokens persisted",
      await panel.evaluate(async () => {
        const { claudeAuth } = await chrome.storage.local.get({ claudeAuth: null });
        return claudeAuth.accessToken === "tok-fresh" && claudeAuth.refreshToken === "r-fresh";
      }));
    await panel.evaluate(() => chrome.storage.local.set({ claudeAuth: null }));
    const genNoAuth = await send({ cmd: "generate", target: "sop", recordingId: recId });
    check("clear error when not signed in",
      !!genNoAuth && genNoAuth.ok === false && /Claude account/.test(genNoAuth.error || ""), genNoAuth);

    section("Options page — code exchange (PKCE) flow");
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await opts.selectOption("#provider", "claude");
    check("claude provider shows the sign-in block, hides the API key",
      await opts.evaluate(() => !$("claudeBlock").hidden && $("apiKeyBlock").hidden));
    await opts.evaluate(() => chrome.storage.local.set({
      claudeOauthPending: { verifier: "v-test", state: "st-1" }
    }));
    await opts.fill("#claudeCode", "abc#st-1");
    await opts.click("#claudeConnect");
    await waitFor(() => opts.evaluate(async () => {
      const { claudeAuth } = await chrome.storage.local.get({ claudeAuth: null });
      return !!(claudeAuth && claudeAuth.accessToken === "tok-fresh");
    }), { desc: "code exchange stored tokens" });
    const exch = tokenRequests[tokenRequests.length - 1];
    check("exchange sent the code + PKCE verifier + state",
      exch.grant_type === "authorization_code" && exch.code === "abc" &&
      exch.code_verifier === "v-test" && exch.state === "st-1", exch);
    check("options page reports connected",
      await opts.evaluate(() => /Connected/.test($("claudeStatus").textContent)));
    await opts.close();
    // restore the suite's default provider config
    await panel.evaluate((cfg) => chrome.storage.local.set(cfg), {
      provider: "custom", claudeAuth: null, anthropicUrl: ""
    });

    // FEATURE SECTIONS APPENDED BELOW AS THEY ARE IMPLEMENTED
  } catch (e) {
    failed++;
    failures.push("UNCAUGHT: " + (e && e.stack || e));
    console.error("\nUNCAUGHT:", e);
  } finally {
    await ctx.close().catch(() => {});
    server.close();
    console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
    if (failures.length) { console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
    process.exit(failed ? 1 : 0);
  }
})();
