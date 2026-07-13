// Paper Trail — Autopilot: execute a saved recording in the live browser,
// attended. The content script performs each step via its RECORDED ANCHORS
// ONLY (resolveStep with the label scan disabled); any miss stops the run.
// Masked steps — and steps whose value was never captured — are never
// executed: the human performs them under the guide overlay and the
// walkthrough's own action detection (walkStepDone) advances the run.
// Orchestration lives here in the side panel, which outlives MV3 worker
// eviction; run-time parameter values stay in this panel and are never
// persisted.

let ap = null;

const AP_SETTLE_MS = 500;
const AP_NAV_TIMEOUT = 20000;
const AP_NAV_SETTLE = 600;

function apExecable(s) {
  return !!(s.url && (s.selector || s.anchors) &&
    ["click", "input", "select", "key"].includes(s.type));
}

function apParamNames(rec) {
  // Params on masked steps are excluded: the human types those values under
  // the gate, so the panel never collects (or stores) them.
  return [...new Set(rec.steps.filter(s => !s.masked).map(s => s.param).filter(Boolean))];
}

async function startAutopilot(recId, presetValues, opts) {
  if (ap) return;
  if (typeof walk !== "undefined" && walk) {
    alert("A walkthrough is in progress — end it first.");
    return;
  }
  if (typeof verifyRun !== "undefined" && verifyRun) {
    alert("A Verify run is in progress — let it finish first.");
    return;
  }
  if (currentSession.recording) {
    alert("Stop recording before running Autopilot.");
    return;
  }
  const rec = await PTDB.getRecording(recId);
  if (!rec || !rec.steps.length) return;
  if (presetValues) {
    apBegin(rec, presetValues, !!(opts && opts.stepConfirm));
    return;
  }
  renderApSetup(rec);
}

// ── Setup form: parameter values (panel-local only) + run mode ─────────────
function renderApSetup(rec) {
  const params = apParamNames(rec);
  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Autopilot — ${esc(rec.title)}</span>
      <div class="result-actions"><button id="apSetupCancel" class="ghost">Cancel</button></div>
    </div>
    <div class="status">The extension will perform the recorded steps itself, using the recorded
      anchors. It stops on any miss, and masked values are always typed by you.</div>
    ${params.length ? `
      <div class="lib-actions" style="display:block;padding:8px">
        <b style="font-size:11px">Run-time parameters (kept in this panel only):</b>
        ${params.map(p => `
          <label style="display:block;margin:6px 0;font-size:11px">&lt;${esc(p)}&gt;<br>
            <input data-ap-param="${esc(p)}" style="width:100%" placeholder="value for this run">
          </label>`).join("")}
      </div>` : ""}
    <div class="lib-actions" style="padding:8px">
      <label style="font-size:11px"><input type="radio" name="apMode" value="confirm" checked> Per-step confirm (▶ runs each step)</label>
      <label style="font-size:11px"><input type="radio" name="apMode" value="free"> Free-run</label>
    </div>
    <div class="lib-actions" style="padding:8px">
      <button id="apSetupStart" class="primary">⚡ Start run</button>
    </div>
    <div id="apSetupStatus" class="status" hidden></div>`;

  $("apSetupCancel").addEventListener("click", () => {
    detail.hidden = true;
    detail.innerHTML = "";
  });
  $("apSetupStart").addEventListener("click", () => {
    const values = {};
    for (const inp of detail.querySelectorAll("input[data-ap-param]")) {
      values[inp.dataset.apParam] = inp.value;
    }
    const missing = params.filter(p => !values[p]);
    if (missing.length) {
      const st = $("apSetupStatus");
      st.hidden = false; st.className = "status err";
      st.textContent = "Fill every parameter first: " + missing.join(", ");
      return;
    }
    const mode = detail.querySelector("input[name='apMode']:checked").value;
    apBegin(rec, values, mode === "confirm");
  });
  detail.scrollIntoView({ behavior: "smooth" });
}

function apBegin(rec, values, stepConfirm) {
  const params = {};
  for (const p of apParamNames(rec)) params[p] = (values || {})[p] || "";
  ap = {
    rec,
    steps: rec.steps,
    idx: 0,
    states: rec.steps.map(() => "pending"),
    values: values || {},
    stepConfirm,
    tabId: null,
    stopped: false,
    endMessage: "",
    failReason: "",
    waiting: null,
    rearm: null,
    pingTimer: setInterval(apPing, 8000),
    // Evidence run — entirely local. params holds NON-SENSITIVE values only
    // (masked-step params never reach the panel; see apParamNames).
    run: {
      id: crypto.randomUUID(),
      recId: rec.id,
      recTitle: rec.title,
      startedAt: Date.now(),
      finishedAt: 0,
      mode: "autopilot",
      params,
      steps: []
    }
  };
  chrome.tabs.onUpdated.addListener(apOnTabUpdated);
  chrome.tabs.onRemoved.addListener(apOnTabRemoved);
  apLoop();
}

// ── Sequential driver ───────────────────────────────────────────────────────
async function apLoop() {
  while (ap && !ap.stopped && ap.idx < ap.steps.length) {
    const step = ap.steps[ap.idx];
    ap.failReason = "";
    let status = await apDoStep(step);
    if (!ap) return;
    if (status === "aborted" || ap.stopped) {
      await apEnd(ap.endMessage || "Autopilot stopped.");
      return;
    }
    if (status === "failed") {
      ap.states[ap.idx] = "failed";
      renderApPanel("failed");
      const choice = await apWait();
      if (!ap) return;
      if (choice === "aborted" || ap.stopped) {
        await apRecordStep(step, "failed");
        await apEnd(ap.endMessage || "Autopilot stopped after a missed step.");
        return;
      }
      status = choice === "manual" ? "manual" : "skipped";
    }
    ap.states[ap.idx] = status;
    await apRecordStep(step, status);
    if (!ap) return;
    ap.idx++;
    await apSleep(AP_SETTLE_MS);
  }
  if (!ap) return;
  if (ap.stopped) { await apEnd(ap.endMessage || "Autopilot stopped."); return; }
  await apFinish();
}

async function apDoStep(step) {
  renderApPanel("working");

  if (step.type === "nav" && step.url) {
    if (await apEnsureAt(step.url)) return "done";
    ap.failReason = "page did not load";
    return "failed";
  }

  // The recorded click that triggered a form submit already carries the
  // action; a synthetic re-submit would double-fire it.
  if (step.type === "submit") return "skipped";

  if (!apExecable(step)) {
    renderApPanel("manual");
    return await apWait(); // manual | skipped | aborted
  }

  if (!await apEnsureAt(step.url)) {
    ap.failReason = "page did not load";
    return "failed";
  }

  const value = step.param ? (ap.values[step.param] || "") : (step.value || "");
  const needsValue = step.type === "input" || step.type === "select";
  const gate = step.masked || (needsValue && value === "");

  if (gate) {
    const armed = await apSendExec({ cmd: "execStep", step: apStepPayload(step), gate: true });
    if (!armed || !armed.resp.humanGate) return "failed";
    renderApPanel("gate");
    ap.rearm = () => apSendExec({ cmd: "execStep", step: apStepPayload(step), gate: true });
    const r = await apWait(); // manual (user performed it) | skipped | aborted
    if (ap) ap.rearm = null;
    return r;
  }

  if (ap.stepConfirm) {
    const staged = await apSendExec({ cmd: "execStep", step: apStepPayload(step), confirm: true });
    if (!staged || !staged.resp.staged) return "failed";
    renderApPanel("staged");
    ap.rearm = () => apSendExec({ cmd: "execStep", step: apStepPayload(step), confirm: true });
    const choice = await apWait(); // exec | manual | skipped | aborted
    if (ap) ap.rearm = null;
    if (choice !== "exec") return choice;
    const r = await apSendFrame(staged.frameId,
      { cmd: "execStep", step: apStepPayload(step), value, confirm: false });
    if (r && r.done) return "confirmed";
    ap.failReason = (r && r.reason) || "no response from the page";
    return "failed";
  }

  const done = await apSendExec({ cmd: "execStep", step: apStepPayload(step), value, confirm: false });
  if (done && done.resp.done) return "done";
  return "failed";
}

function apStepPayload(step) {
  return {
    id: step.id, n: step.n, text: step.text, type: step.type, label: step.label,
    kind: step.kind, selector: step.selector, anchors: step.anchors,
    masked: step.masked, url: step.url
  };
}

// Evidence: one entry per attempted step; completed steps also get a
// screenshot of the run tab (stored locally under the run's recId).
async function apRecordStep(step, status) {
  if (!ap || !ap.run) return;
  const entry = { n: step.n, text: step.text, status, ts: Date.now() };
  if (status === "done" || status === "confirmed" || status === "manual") {
    const r = await send({ cmd: "evidenceShot", runId: ap.run.id, n: step.n });
    entry.hasShot = !!(r && r.ok);
  }
  if (ap && ap.run) ap.run.steps.push(entry);
}

async function apFinish() {
  const count = (s) => ap.states.filter(x => x === s).length;
  const parts = [`${count("done") + count("confirmed")} executed`];
  if (count("manual")) parts.push(`${count("manual")} done by you`);
  if (count("skipped")) parts.push(`${count("skipped")} skipped`);
  await apEnd(`Autopilot complete ✓ — ${parts.join(", ")}.`);
}

async function apEnd(message) {
  if (!ap) return;
  clearInterval(ap.pingTimer);
  chrome.tabs.onUpdated.removeListener(apOnTabUpdated);
  chrome.tabs.onRemoved.removeListener(apOnTabRemoved);
  if (ap.tabId) await apSendFrames({ cmd: "walkDisarm" });
  if (ap.run && ap.run.steps.length) {
    ap.run.finishedAt = Date.now();
    await PTDB.saveRun(ap.run).catch(() => {});
  }
  ap = null;
  const detail = $("libDetail");
  if (message) {
    detail.hidden = false;
    detail.innerHTML = `<div class="status" style="padding:10px">${esc(message)}</div>`;
  } else {
    detail.hidden = true;
    detail.innerHTML = "";
  }
  renderLibrary();
}

// ── Waiting on the human (panel buttons or the page action itself) ─────────
function apWait() {
  return new Promise((resolve) => {
    ap.waiting = {
      resolve: (v) => {
        if (!ap || !ap.waiting) return;
        ap.waiting = null;
        resolve(v);
      }
    };
  });
}

function apSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tab / frame plumbing (mirrors walkthrough.js, own tab state) ───────────
function apWaitLoad(ms) {
  return new Promise((res) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      res(ok);
    };
    const onUpd = (id, info) => {
      if (ap && id === ap.tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => finish(false), ms);
  });
}

async function apEnsureAt(url) {
  if (!ap.tabId) {
    const done = apWaitLoad(AP_NAV_TIMEOUT);
    const tab = await chrome.tabs.create({ url, active: true });
    ap.tabId = tab.id;
    const ok = await done;
    await apSleep(AP_NAV_SETTLE);
    return ok;
  }
  let tab = await chrome.tabs.get(ap.tabId).catch(() => null);
  if (!tab) return false;
  if (PTCommon.samePage(tab.url, url)) {
    if (tab.status !== "complete") { await apWaitLoad(AP_NAV_TIMEOUT); await apSleep(AP_NAV_SETTLE); }
    return true;
  }
  const done = apWaitLoad(AP_NAV_TIMEOUT);
  await chrome.tabs.update(ap.tabId, { url });
  const ok = await done;
  await apSleep(AP_NAV_SETTLE);
  if (!ok) return false;
  tab = await chrome.tabs.get(ap.tabId).catch(() => null);
  return !!tab && PTCommon.samePage(tab.url, url);
}

async function apFrames() {
  if (!ap || !ap.tabId) return [];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: ap.tabId });
    return frames && frames.length ? frames : [{ frameId: 0 }];
  } catch (e) {
    return [{ frameId: 0 }];
  }
}

function apSendFrame(frameId, msg) {
  return new Promise((res) => {
    if (!ap || !ap.tabId) return res(null);
    chrome.tabs.sendMessage(ap.tabId, msg, { frameId }, (resp) => {
      void chrome.runtime.lastError;
      res(resp || null);
    });
  });
}

async function apSendFrames(msg) {
  for (const f of await apFrames()) await apSendFrame(f.frameId, msg);
}

// Send an execStep to each frame until one succeeds (done/staged/humanGate).
// A frame whose anchors don't resolve answers {failed}; the first concrete
// failure reason is kept for the report. If NO frame answered at all the
// content script hasn't been injected yet (page still settling) — wait and
// retry rather than mis-grading a live page as a miss.
async function apSendExec(msg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fail = "";
    let answered = false;
    for (const f of await apFrames()) {
      if (!ap) return null;
      const r = await apSendFrame(f.frameId, msg);
      if (r && (r.done || r.staged || r.humanGate)) return { resp: r, frameId: f.frameId };
      if (r) answered = true;
      if (r && r.failed && !fail) fail = r.reason || "";
    }
    if (answered) {
      if (ap) ap.failReason = fail || "no recorded anchor resolves on this page";
      return null;
    }
    await apSleep(700);
  }
  if (ap) ap.failReason = "the page never answered (content script not loaded?)";
  return null;
}

function apPing() {
  if (ap && ap.tabId) apSendFrames({ cmd: "walkPing" });
}

function apOnTabUpdated(id, info) {
  if (!ap || id !== ap.tabId || info.status !== "complete") return;
  // Navigation reloaded the content script — re-arm a pending overlay.
  if (ap.rearm) setTimeout(() => { if (ap && ap.rearm) ap.rearm(); }, 600);
}

function apOnTabRemoved(id) {
  if (!ap || id !== ap.tabId) return;
  ap.stopped = true;
  ap.endMessage = "Autopilot tab was closed.";
  if (ap.waiting) ap.waiting.resolve("aborted");
}

// Completion of human-gated / staged steps, and bail-out on recording start.
chrome.runtime.onMessage.addListener((msg) => {
  if (!ap || !msg) return;
  if (msg.evt === "walkStepDone") {
    const step = ap.steps[ap.idx];
    if (step && step.id === msg.stepId && ap.waiting) ap.waiting.resolve("manual");
  } else if (msg.evt === "sessionChanged") {
    send({ cmd: "getState" }).then(r => {
      if (ap && r && r.session && r.session.recording) {
        ap.stopped = true;
        ap.endMessage = "Autopilot ended — recording started.";
        if (ap.waiting) ap.waiting.resolve("aborted");
      }
    });
  }
});

// ── Panel UI ────────────────────────────────────────────────────────────────
function renderApPanel(state) {
  if (!ap) return;
  const step = ap.steps[ap.idx];
  const detail = $("libDetail");
  const executed = ap.states.filter(s => s === "done" || s === "confirmed").length;

  let statusLine = "";
  let buttons = "";
  switch (state) {
    case "staged":
      statusLine = `<span class="ver-dot ver-found"></span>Highlighted on the page — ▶ runs it, or perform it yourself`;
      buttons = `<button id="apExec" class="primary">▶ Run this step</button>
                 <button id="apDone" class="ghost">✓ Mark done</button>
                 <button id="apSkip" class="ghost">Skip ⏭</button>`;
      break;
    case "gate":
      statusLine = `<span class="ver-dot ver-fallback"></span>${step.masked
        ? "Masked value — type it on the page yourself; Autopilot never receives it"
        : "No recorded value — perform this step on the page yourself"}`;
      buttons = `<button id="apSkip" class="ghost">Skip ⏭</button>`;
      break;
    case "manual":
      statusLine = `<span class="ver-dot ver-na"></span>Not an executable browser step — do it, then mark it done`;
      buttons = `<button id="apDone" class="ghost">✓ Mark done</button>
                 <button id="apSkip" class="ghost">Skip ⏭</button>`;
      break;
    case "failed":
      statusLine = `<span class="ver-dot ver-missing"></span>Stopped: ${esc(ap.failReason || "anchor miss")} — do it manually or skip`;
      buttons = `<button id="apDone" class="ghost">✓ I did it manually</button>
                 <button id="apSkip" class="ghost">Skip ⏭</button>`;
      break;
    default:
      statusLine = `<span class="ver-dot ver-pending"></span>Executing…`;
  }

  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Autopilot — ${esc(ap.rec.title)}${ap.stepConfirm ? " (per-step confirm)" : ""}</span>
      <div class="result-actions"><button id="apAbort" class="ghost">✕ Abort</button></div>
    </div>
    <div class="status">${ap.idx + 1} / ${ap.steps.length} · ${executed} executed</div>
    <div class="step">
      <div class="rail"><span class="n">${step.n}</span></div>
      <div class="body">
        <div class="action">${actionHtml(step.text)}</div>
        <div class="page" title="${esc(step.url)}">${esc(step.pageTitle || step.url || step.app || "")}</div>
        ${step.masked ? `<div class="masked">value masked — human only</div>` : ""}
        ${step.param ? `<div class="param-chip">param: &lt;${esc(step.param)}&gt;</div>` : ""}
        <div class="page walk-state">${statusLine}</div>
      </div>
    </div>
    <div class="lib-actions" style="padding:8px">${buttons}</div>`;

  $("apAbort").addEventListener("click", () => {
    if (!ap) return;
    ap.stopped = true;
    ap.endMessage = "Autopilot aborted.";
    if (ap.waiting) ap.waiting.resolve("aborted");
  });
  const on = (id, v) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => { if (ap && ap.waiting) ap.waiting.resolve(v); });
  };
  on("apExec", "exec");
  on("apDone", "manual");
  on("apSkip", "skipped");
}
