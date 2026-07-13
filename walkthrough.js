// Paper Trail — Guided Walkthrough Player: load a saved recording and coach
// the user through it live. The content script highlights the next step's
// element and reports back when the user actually performs it; steps without
// web anchors (desktop/UIA/manual) fall back to instruction cards.
// Orchestration lives here in the side panel, which outlives the worker.

let walk = null;

function walkWebArmable(s) {
  return !!(s.url && (s.selector || s.label) &&
    ["click", "input", "select", "key"].includes(s.type));
}

async function startWalkthrough(recId) {
  if (walk) return;
  if (typeof verifyRun !== "undefined" && verifyRun) {
    alert("A Verify run is in progress — let it finish first.");
    return;
  }
  if (typeof ap !== "undefined" && ap) {
    alert("Autopilot is running — stop it first.");
    return;
  }
  if (currentSession.recording) {
    alert("Stop recording before starting a walkthrough.");
    return;
  }
  const rec = await PTDB.getRecording(recId);
  if (!rec || !rec.steps.length) return;

  const shots = await PTDB.getShotsByRec(recId);
  const shotUrls = new Map(shots.map(s => [s.stepId, URL.createObjectURL(s.blob)]));

  walk = {
    rec,
    steps: rec.steps,
    idx: 0,
    tabId: null,
    states: rec.steps.map(() => "pending"), // pending | done | skipped
    shotUrls,
    pingTimer: setInterval(walkPingFrames, 8000)
  };
  chrome.tabs.onUpdated.addListener(walkOnTabUpdated);
  chrome.tabs.onRemoved.addListener(walkOnTabRemoved);
  await walkShowStep();
}

async function endWalkthrough(message) {
  if (!walk) return;
  clearInterval(walk.pingTimer);
  chrome.tabs.onUpdated.removeListener(walkOnTabUpdated);
  chrome.tabs.onRemoved.removeListener(walkOnTabRemoved);
  if (walk.tabId) await walkSendFrames({ cmd: "walkDisarm" });
  for (const u of walk.shotUrls.values()) URL.revokeObjectURL(u);
  walk = null;
  const detail = $("libDetail");
  if (message) {
    detail.hidden = false;
    detail.innerHTML = `<div class="status" style="padding:10px">${esc(message)}</div>`;
  } else {
    detail.hidden = true;
    detail.innerHTML = "";
  }
}

// ── Step flow ───────────────────────────────────────────────────────────────

async function walkShowStep() {
  if (!walk) return;
  if (walk.idx >= walk.steps.length) {
    const done = walk.states.filter(s => s === "done").length;
    const skipped = walk.states.filter(s => s === "skipped").length;
    await endWalkthrough(`Walkthrough complete ✓ — ${done} done, ${skipped} skipped.`);
    renderLibrary();
    return;
  }

  const step = walk.steps[walk.idx];
  renderWalkPanel("preparing…");

  if (step.type === "nav" && step.url) {
    const tab = walk.tabId && await chrome.tabs.get(walk.tabId).catch(() => null);
    if (tab && PTCommon.samePage(tab.url, step.url)) { walkMarkDone("nav"); return; }
    renderWalkPanel("nav");
    if (!walk.tabId) await walkOpenTab(step.url);
    return; // arrival detected by walkOnTabUpdated
  }

  if (!walkWebArmable(step)) {
    renderWalkPanel("manual");
    return;
  }

  // Web step: make sure the walkthrough tab is on the right page, then arm.
  if (!walk.tabId) {
    await walkOpenTab(step.url);
    return; // onUpdated → re-enters walkShowStep after load
  }
  const tab = await chrome.tabs.get(walk.tabId).catch(() => null);
  if (!tab) { await endWalkthrough("Walkthrough tab was closed."); return; }
  if (!PTCommon.samePage(tab.url, step.url)) {
    renderWalkPanel("offpage");
    return;
  }
  await walkArmCurrent();
}

async function walkOpenTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  if (walk) walk.tabId = tab.id;
}

async function walkArmCurrent() {
  if (!walk) return;
  const step = walk.steps[walk.idx];
  const payload = {
    cmd: "walkArm",
    step: {
      id: step.id, n: step.n, text: step.text, type: step.type,
      label: step.label, kind: step.kind, selector: step.selector, anchors: step.anchors
    }
  };
  const frames = await walkFrames();
  for (const f of frames) {
    const r = await walkSendFrame(f.frameId, payload);
    if (r && r.armed) {
      renderWalkPanel("armed", r.via);
      return;
    }
  }
  renderWalkPanel("stale");
}

function walkMarkDone(via) {
  if (!walk) return;
  walk.states[walk.idx] = "done";
  walk.idx++;
  walkShowStep();
}

// ── Tab / frame plumbing ────────────────────────────────────────────────────

function walkOnTabUpdated(id, info, tab) {
  if (!walk || id !== walk.tabId || info.status !== "complete") return;
  const step = walk.steps[walk.idx];
  if (!step) return;
  if (step.type === "nav" && step.url && PTCommon.samePage(tab.url, step.url)) {
    walkMarkDone("nav");
    return;
  }
  // Navigation reloaded the content script — re-arm the current step.
  setTimeout(() => { if (walk) walkShowStep(); }, 600);
}

function walkOnTabRemoved(id) {
  if (walk && id === walk.tabId) endWalkthrough("Walkthrough tab was closed.");
}

async function walkFrames() {
  if (!walk || !walk.tabId) return [];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: walk.tabId });
    return frames && frames.length ? frames : [{ frameId: 0 }];
  } catch (e) {
    return [{ frameId: 0 }];
  }
}

function walkSendFrame(frameId, msg) {
  return new Promise((res) => {
    if (!walk || !walk.tabId) return res(null);
    chrome.tabs.sendMessage(walk.tabId, msg, { frameId }, (resp) => {
      void chrome.runtime.lastError;
      res(resp || null);
    });
  });
}

async function walkSendFrames(msg) {
  for (const f of await walkFrames()) await walkSendFrame(f.frameId, msg);
}

function walkPingFrames() {
  if (walk && walk.tabId) walkSendFrames({ cmd: "walkPing" });
}

// The content script reports completed steps here; also bail out if a
// recording starts mid-walkthrough (the broadcast tears down page overlays).
chrome.runtime.onMessage.addListener((msg) => {
  if (!walk || !msg) return;
  if (msg.evt === "walkStepDone") {
    const step = walk.steps[walk.idx];
    if (step && step.id === msg.stepId) walkMarkDone(msg.via);
  } else if (msg.evt === "sessionChanged") {
    send({ cmd: "getState" }).then(r => {
      if (walk && r && r.session && r.session.recording) {
        endWalkthrough("Walkthrough ended — recording started.");
      }
    });
  }
});

// ── Panel UI ────────────────────────────────────────────────────────────────

function renderWalkPanel(state, via) {
  if (!walk) return;
  const step = walk.steps[walk.idx];
  const detail = $("libDetail");
  const shotUrl = walk.shotUrls.get(step.id);
  const text = String(step.text || "").replace(/\*\*/g, "");

  let statusLine = "";
  let extraBtn = "";
  switch (state) {
    case "armed":
      statusLine = `<span class="ver-dot ver-found"></span>Highlighted on the page (${via === "selector" ? "anchor" : "found by label"}) — perform the action to advance`;
      break;
    case "stale":
      statusLine = `<span class="ver-dot ver-fallback"></span>Couldn't find this element — the page may have changed`;
      extraBtn = `<button id="walkShowMe" class="ghost">Show me by text</button>`;
      break;
    case "offpage":
    case "nav":
      statusLine = `<span class="ver-dot ver-fallback"></span>This step happens on <b>${esc(step.pageTitle || step.url)}</b>`;
      extraBtn = `<button id="walkGo" class="primary">Take me there →</button>`;
      break;
    case "manual":
      statusLine = `<span class="ver-dot ver-na"></span>Not a browser step — follow the instruction, then mark it done`;
      break;
    default:
      statusLine = `<span class="ver-dot ver-pending"></span>Preparing…`;
  }

  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Walkthrough — ${esc(walk.rec.title)}</span>
      <div class="result-actions"><button id="walkEnd" class="ghost">✕ End</button></div>
    </div>
    <div class="status">${walk.idx + 1} / ${walk.steps.length}
      · ${walk.states.filter(s => s === "done").length} done</div>
    <div class="step walk-card">
      <div class="rail"><span class="n">${step.n}</span></div>
      <div class="body">
        <div class="action">${actionHtml(step.text)}</div>
        <div class="page" title="${esc(step.url)}">${esc(step.pageTitle || step.url || step.app || "")}</div>
        ${step.note ? `<div class="page">📝 ${esc(step.note)}</div>` : ""}
        <div class="page walk-state">${statusLine}</div>
        ${shotUrl ? `<img src="${shotUrl}" alt="Step ${step.n} reference screenshot" loading="lazy">` : ""}
      </div>
    </div>
    <div class="lib-actions" style="padding:8px">
      ${extraBtn}
      <button id="walkBack" class="ghost" ${walk.idx === 0 ? "disabled" : ""}>⏮ Back</button>
      <button id="walkSkip" class="ghost">Skip ⏭</button>
      <button id="walkDoneBtn" class="ghost">✓ Mark done</button>
    </div>`;

  $("walkEnd").addEventListener("click", () => endWalkthrough());
  $("walkBack").addEventListener("click", async () => {
    if (!walk || walk.idx === 0) return;
    await walkSendFrames({ cmd: "walkDisarm" });
    walk.idx--;
    walk.states[walk.idx] = "pending";
    walkShowStep();
  });
  $("walkSkip").addEventListener("click", async () => {
    if (!walk) return;
    await walkSendFrames({ cmd: "walkDisarm" });
    walk.states[walk.idx] = "skipped";
    walk.idx++;
    walkShowStep();
  });
  $("walkDoneBtn").addEventListener("click", async () => {
    if (!walk) return;
    await walkSendFrames({ cmd: "walkDisarm" });
    walkMarkDone("manual");
  });
  const go = document.getElementById("walkGo");
  if (go) go.addEventListener("click", async () => {
    if (!walk) return;
    if (!walk.tabId) await walkOpenTab(step.url);
    else await chrome.tabs.update(walk.tabId, { url: step.url });
    // arrival handled by walkOnTabUpdated
  });
  const showMe = document.getElementById("walkShowMe");
  if (showMe) showMe.addEventListener("click", async () => {
    let hits = 0;
    for (const f of await walkFrames()) {
      const r = await walkSendFrame(f.frameId, { cmd: "walkFindByText", label: step.label });
      hits += (r && r.count) || 0;
    }
    const stateEl = document.querySelector(".walk-state");
    if (stateEl) stateEl.innerHTML = hits
      ? `<span class="ver-dot ver-fallback"></span>${hits} possible match${hits === 1 ? "" : "es"} flashed on the page`
      : `<span class="ver-dot ver-missing"></span>No label matches on this page — skip or do it manually`;
  });
}
