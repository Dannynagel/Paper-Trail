// Paper Trail — alpha end-to-end test harness.
// Loads the unpacked extension in real Chromium and drives it through
// recording, multi-anchor capture, masking, run-time parameters, HTTP
// capture, library save, privacy audit, verify (incl. anchor-based drift
// repair), Playwright/psweb/Delinea generation against a stub LLM endpoint,
// recording diff, walkthrough auto-advance, voice narration against a stub
// Whisper endpoint, caption-on-capture, and the options defaults.
// See alpha-test/README.md for how to run it.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..");   // the repo root IS the unpacked extension
const SCRATCH = __dirname;                   // form.html fixture lives next to this file
const PORT = 8907;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + (detail || "")}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Stub server: test form + OpenAI-compatible chat + Whisper endpoints ────
let lastChatBody = null;
let lastTranscribeRaw = null;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (req.url === "/chat") {
      lastChatBody = JSON.parse(raw.toString("utf8"));
      const system = String(lastChatBody.messages[0].content || "");
      const reply = system.includes("recorded desktop procedure")
        ? "Click the Save button in the demo window."   // caption-on-capture request
        : "// stub playwright output";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    } else if (req.url === "/submit") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/transcribe") {
      lastTranscribeRaw = raw.toString("latin1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        text: "do the thing carefully",
        segments: [{ start: 0, end: 9999, text: "do the thing carefully" }]
      }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end(fs.readFileSync(path.join(SCRATCH, "form.html")));
    }
  });
}).listen(PORT);

(async () => {
  const userDir = fs.mkdtempSync("/tmp/pt-profile-");
  const context = await chromium.launchPersistentContext(userDir, {
    headless: true,
    // Extensions need full Chromium, not Playwright headless shell.
    // Point PT_CHROMIUM at a full Chromium binary if the default is wrong.
    executablePath: process.env.PT_CHROMIUM || "/opt/pw-browsers/chromium",
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream"
    ],
  });

  const errors = [];
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("service worker registered", !!sw, sw && sw.url());
  if (!sw) { await context.close(); server.close(); process.exit(1); }
  const extId = new URL(sw.url()).host;
  sw.on("console", (m) => { if (m.type() === "error") errors.push("sw: " + m.text()); });

  const form = await context.newPage();
  form.on("console", (m) => { if (m.type() === "error") errors.push("form: " + m.text()); });
  await form.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(700);

  const panel = await context.newPage();
  panel.on("console", (m) => { if (m.type() === "error") errors.push("panel: " + m.text()); });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await sleep(400);
  check("side panel loads", await panel.locator("#btnRecord").count() === 1);

  // Point the extension at the stub endpoints.
  await panel.evaluate((port) => chrome.storage.local.set({
    provider: "custom",
    customUrl: `http://127.0.0.1:${port}/chat`,
    transcribeUrl: `http://127.0.0.1:${port}/transcribe`,
    transcribeModel: "whisper-1",
    captionOnCapture: true
  }), PORT);

  // ── Record a real procedure ────────────────────────────────────────────
  await panel.click("#btnRecord");
  await sleep(600);
  await form.bringToFront();
  await form.click("#submitBtn");
  await sleep(900);
  await form.fill("#qty", "42");
  await form.press("#qty", "Tab");
  await sleep(900);
  await form.fill("#pw", "hunter2");
  await form.press("#pw", "Tab");
  await sleep(1200);

  const state = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "getState" }, res)));
  const steps = state.session.steps;
  check("recorded 3 steps", steps.length === 3, steps.map(s => s.type).join(","));
  const clickStep = steps.find(s => s.type === "click");
  check("click primary selector unchanged", !!clickStep && clickStep.selector === "#submitBtn",
    clickStep && clickStep.selector);
  // The button's id IS the primary selector, so the id/css anchors dedupe
  // away and the test attribute is the surviving independent alternate.
  check("multi-anchor: independent testAttr alternate captured",
    !!clickStep && !!clickStep.anchors &&
    clickStep.anchors.testAttr === 'button[data-testid="submit-order"]' &&
    !clickStep.anchors.id && !clickStep.anchors.css,
    clickStep && JSON.stringify(clickStep.anchors));
  const inputSteps = steps.filter(s => s.type === "input");
  check("all typed values masked by default",
    inputSteps.length === 2 && inputSteps.every(s => s.masked && s.value === ""),
    JSON.stringify(inputSteps.map(s => ({ label: s.label, masked: s.masked }))));

  // ── Run-time parameter + HTTP capture (while the session is still live) ─
  const qtyStep = steps.find(s => s.type === "input" && /quantity/i.test(s.label));
  await panel.evaluate((id) =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "setParam", id, param: "QUANTITY" }, res)), qtyStep.id);
  const paramState = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "getState" }, res)));
  const paramStep = paramState.session.steps.find(s => s.param);
  check("step marked as run-time parameter", !!paramStep && paramStep.param === "QUANTITY");
  const httpLog = paramState.session.http || [];
  const submitReq = httpLog.find(h => h.url.includes("/submit"));
  check("HTTP capture logged the page's POST with masked secrets",
    !!submitReq && submitReq.method === "POST" &&
    submitReq.json && submitReq.json.password === "[masked]" &&
    !httpLog.some(h => /\/chat|\/transcribe/.test(h.url)),
    JSON.stringify({ n: httpLog.length, submit: submitReq }));

  await panel.click("#btnRecord"); // stop
  await sleep(400);

  // ── Save to library ────────────────────────────────────────────────────
  await panel.evaluate(() => { window.prompt = () => "Smoke Recording"; });
  await panel.click("#btnSave");
  await sleep(800);
  const lib = await panel.evaluate(() => PTDB.listRecordings());
  check("library holds the saved recording", lib.length === 1 && lib[0].title === "Smoke Recording",
    JSON.stringify(lib.map(r => r.title)));
  const recId = lib[0] && lib[0].id;

  // ── Privacy audit (SOP target) ─────────────────────────────────────────
  const audit = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "auditPayload", target: "sop", context: "", recordingId: recId }, res)), recId);
  check("audit builds", !!audit && audit.ok === true, audit && audit.error);
  if (audit && audit.ok) {
    check("audit lists both masked fields", audit.audit.maskedSteps.length === 2,
      JSON.stringify(audit.audit.maskedSteps));
    check("audit contains no password value", !JSON.stringify(audit.audit).includes("hunter2"));
  }

  // ── Verify: healthy, then anchor-based drift repair ────────────────────
  await panel.evaluate((recId) => startVerify(recId), recId);
  await sleep(6000);
  let verSummary = await panel.evaluate(() => ($("verSummary") || {}).textContent || "");
  check("verify grades all anchors healthy", /3\/3 anchors healthy/.test(verSummary), verSummary);

  await panel.evaluate(async (recId) => {
    const rec = await PTDB.getRecording(recId);
    rec.steps.find(s => s.type === "click").selector = "#does-not-exist";
    await PTDB.saveRecording(rec);
  }, recId);
  await panel.evaluate((recId) => startVerify(recId), recId);
  await sleep(6000);
  const drift = await panel.evaluate(() => ({
    suggestion: (document.querySelector("#libDetail .ver-grade code") || {}).textContent || "",
    summary: ($("verSummary") || {}).textContent || ""
  }));
  check("drift repaired via the testAttr anchor",
    drift.suggestion === 'button[data-testid="submit-order"]' &&
    /2\/3 anchors healthy — 1 drifted/.test(drift.summary),
    JSON.stringify(drift));
  const repaired = await panel.evaluate(async (recId) => {
    document.getElementById("verApply").click();
    await new Promise(r => setTimeout(r, 600));
    const rec = await PTDB.getRecording(recId);
    const s = rec.steps.find(s => s.type === "click");
    return { selector: s.selector, anchors: s.anchors };
  }, recId);
  check("apply updates primary AND the full anchor set",
    repaired.selector === 'button[data-testid="submit-order"]' &&
    !!repaired.anchors && repaired.anchors.id === "#submitBtn",
    JSON.stringify(repaired));

  // ── Playwright targets against the stub chat endpoint ──────────────────
  const gen = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "generate", target: "playwright", context: "", recordingId: recId }, res)), recId);
  check("playwright generation round-trips the stub", !!gen && gen.ok === true &&
    gen.markdown.includes("stub playwright"), gen && (gen.error || gen.markdown));
  check("stub received alt_selectors + playwright prompt",
    !!lastChatBody &&
    JSON.stringify(lastChatBody).includes("alt_selectors") &&
    lastChatBody.messages[0].content.includes("Playwright"),
    lastChatBody && lastChatBody.messages[0].content.slice(0, 60));
  const pwAudit = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "auditPayload", target: "pwtest", context: "", recordingId: recId }, res)), recId);
  check("pwtest audit renders", !!pwAudit && pwAudit.ok === true &&
    pwAudit.audit.system.includes("READ-ONLY"), pwAudit && pwAudit.error);
  check("automation payload carries the run-time parameter",
    typeof lastChatBody.messages[1].content === "string" &&
    lastChatBody.messages[1].content.includes('"param_name": "QUANTITY"'));

  // ── psweb target: replay the captured HTTP log ─────────────────────────
  const genPsweb = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "generate", target: "psweb", context: "", recordingId: recId }, res)), recId);
  check("psweb generation sends the HTTP LOG + IWR/IRM prompt",
    !!genPsweb && genPsweb.ok === true &&
    lastChatBody.messages[0].content.includes("Invoke-WebRequest") &&
    lastChatBody.messages[1].content.includes("HTTP LOG") &&
    lastChatBody.messages[1].content.includes("/submit"),
    genPsweb && (genPsweb.error || "ok"));

  // ── Delinea Secret Server mode ─────────────────────────────────────────
  const genSS = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "generate", target: "powershell", secretServer: true, context: "", recordingId: recId }, res)), recId);
  check("Delinea mode appends SS rules to the system prompt",
    !!genSS && genSS.ok === true &&
    lastChatBody.messages[0].content.includes("Delinea Secret Server") &&
    lastChatBody.messages[0].content.includes("Set-SSSecretField"),
    genSS && genSS.error);
  const ssAudit = await panel.evaluate((recId) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "auditPayload", target: "powershell", secretServer: true, context: "", recordingId: recId }, res)), recId);
  check("audit reflects SS mode and lists the parameter",
    !!ssAudit && ssAudit.ok && ssAudit.audit.secretServer === true &&
    ssAudit.audit.system.includes("Delinea Secret Server") &&
    ssAudit.audit.paramSteps.length === 1 && ssAudit.audit.paramSteps[0].param === "QUANTITY",
    ssAudit && JSON.stringify(ssAudit.audit && ssAudit.audit.paramSteps));

  // ── Recording diff (clone + mutate B, then compare in the UI) ──────────
  const recBId = await panel.evaluate(async (recId) => {
    const rec = await PTDB.getRecording(recId);
    const b = JSON.parse(JSON.stringify(rec));
    b.id = crypto.randomUUID();
    b.title = "Smoke Recording v2";
    const click = b.steps.find(s => s.type === "click");
    click.label = "Submit Purchase Order";
    click.text = "Click **Submit Purchase Order** (button)";
    b.steps.push(Object.assign({}, click, {
      id: crypto.randomUUID(), n: b.steps.length + 1,
      label: "Archive", text: "Click **Archive** (button)"
    }));
    b.stepCount = b.steps.length;
    await PTDB.saveRecording(b);
    return b.id;
  }, recId);
  await panel.evaluate(([a, b]) => startCompare(a, b), [recId, recBId]);
  await sleep(800);
  const diffSummary = await panel.evaluate(() =>
    (document.querySelector("#libDetail .status") || {}).textContent || "");
  check("diff report: relabel + add detected",
    /2 unchanged, 1 relabeled, 1 added/.test(diffSummary), diffSummary);
  const diffAudit = await panel.evaluate(([a, b]) =>
    new Promise(res => chrome.runtime.sendMessage(
      { cmd: "auditPayload", target: "diff", context: "", recordingId: a, recordingIdB: b }, res)),
    [recId, recBId]);
  check("diff audit carries text-only entries", !!diffAudit && diffAudit.ok === true &&
    diffAudit.audit.userText.includes("DIFF ENTRIES") &&
    !diffAudit.audit.userText.includes("#submitBtn"),
    diffAudit && diffAudit.error);

  // ── Walkthrough: arm, act, auto-advance ────────────────────────────────
  await panel.evaluate((recId) => startWalkthrough(recId), recId);
  await sleep(4000);
  const walkPage = context.pages().find(p => p !== panel && p !== form &&
    p.url().includes(`127.0.0.1:${PORT}`));
  check("walkthrough opened its tab", !!walkPage);
  if (walkPage) {
    await sleep(1500);
    check("guide overlay drawn", await walkPage.locator(".paper-trail-guide-box").count() === 1);
    await walkPage.click("#submitBtn");
    await sleep(1500);
    const progress = await panel.evaluate(() =>
      (document.querySelector("#libDetail .status") || {}).textContent.trim());
    check("auto-advanced past step 1", /2 \/ 3|1 done/.test(progress), progress);
    await panel.evaluate(() => endWalkthrough());
    await sleep(500);
    check("overlay cleared on end", await walkPage.locator(".paper-trail-guide-box").count() === 0);
  }

  // ── Voice narration against the stub Whisper endpoint ──────────────────
  await panel.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ cmd: "clear" }, res)));
  await sleep(300);
  await panel.evaluate(() => startMic()); // fake media flags grant instantly
  await sleep(1200);
  const micOn = await panel.evaluate(() => !!micStream && currentSession.recording);
  check("mic narration started and auto-started recording", micOn);
  await form.bringToFront();
  await form.click("#submitBtn");
  await sleep(1200);
  await panel.evaluate(() => stopMic());
  await sleep(2500); // transcription round-trip + setNarration

  check("stub whisper got multipart with file/model/verbose_json",
    !!lastTranscribeRaw &&
    lastTranscribeRaw.includes('name="file"') &&
    lastTranscribeRaw.includes("whisper-1") &&
    lastTranscribeRaw.includes("verbose_json"),
    lastTranscribeRaw && lastTranscribeRaw.slice(0, 120));
  const narrState = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "getState" }, res)));
  const narrStep = narrState.session.steps.find(s => s.narration);
  check("narration attached to the recorded step",
    !!narrStep && narrStep.narration === "do the thing carefully",
    JSON.stringify(narrState.session.steps.map(s => ({ t: s.type, n: s.narration }))));
  check("ledger shows the 🎙 narration row",
    await panel.locator("#steps .narration").count() === 1);
  const narrAudit = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "auditPayload", target: "sop", context: "" }, res)));
  check("audit calls out narrated steps",
    !!narrAudit && narrAudit.ok && narrAudit.audit.narratedSteps.length === 1 &&
    narrAudit.audit.userText.includes("do the thing carefully"),
    narrAudit && JSON.stringify(narrAudit.audit && narrAudit.audit.narratedSteps));
  if (narrStep) {
    await panel.evaluate((id) =>
      new Promise(res => chrome.runtime.sendMessage({ cmd: "dropNarration", id }, res)), narrStep.id);
    const after = await panel.evaluate(() =>
      new Promise(res => chrome.runtime.sendMessage({ cmd: "getState" }, res)));
    check("dropNarration removes it", !after.session.steps.some(s => s.narration));
  }

  // ── Caption-on-capture: desktop frame → text caption, pixels stay local ─
  await panel.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ cmd: "clear" }, res)));
  await panel.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ cmd: "start" }, res)));
  await panel.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    c.getContext("2d").fillRect(0, 0, 8, 8);
    return new Promise(res => chrome.runtime.sendMessage(
      { cmd: "addDesktopStep", shot: c.toDataURL("image/jpeg", 0.7), label: "Demo App", manual: true }, res));
  });
  await sleep(2500); // capture + caption round-trip through the stub
  const capState = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "getState" }, res)));
  const capStep = capState.session.steps[0];
  check("desktop frame captioned at capture",
    !!capStep && capStep.caption === "Click the Save button in the demo window.",
    JSON.stringify(capStep && { type: capStep.type, caption: capStep.caption }));
  check("ledger shows the caption row",
    await panel.locator("#steps .caption").count() === 1);
  const capAudit = await panel.evaluate(() =>
    new Promise(res => chrome.runtime.sendMessage({ cmd: "auditPayload", target: "sop", context: "" }, res)));
  check("captioned frame NOT attached at generation; caption travels as text",
    !!capAudit && capAudit.ok &&
    capAudit.audit.shotsAttached.length === 0 &&
    capAudit.audit.captionedSteps.length === 1 &&
    capAudit.audit.userText.includes("Click the Save button in the demo window."),
    capAudit && JSON.stringify({ attached: capAudit.audit.shotsAttached, cap: capAudit.audit.captionedSteps }));
  await panel.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ cmd: "clear" }, res)));

  // ── Options page: Ollama-friendly defaults ─────────────────────────────
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await sleep(400);
  const optState = await opts.evaluate(() => {
    document.getElementById("provider").value = "custom";
    document.getElementById("model").value = ""; // force default fill
    document.getElementById("provider").dispatchEvent(new Event("change"));
    return {
      model: document.getElementById("model").value,
      urlPlaceholder: document.getElementById("customUrl").placeholder
    };
  });
  check("custom provider pre-fills the local Gemma tag",
    optState.model === "gemma4:12b-it-qat" && optState.urlPlaceholder.includes("11434"),
    JSON.stringify(optState));
  await opts.close();

  check("no console errors anywhere", errors.length === 0, errors.slice(0, 5).join(" ;; "));

  await context.close();
  server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("SMOKE CRASH:", e); server.close(); process.exit(2); });
