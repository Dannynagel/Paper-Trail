// Paper Trail — service worker
// Owns the recording session, takes+annotates screenshots, talks to
// Anthropic / OpenAI / custom OpenAI-compatible endpoints.

importScripts("db.js", "common.js");

// ── Session state (rehydrated from storage.session on worker wake) ────────
let session = { recording: false, steps: [], startedAt: 0 };
let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  const s = await chrome.storage.session.get("session");
  if (s.session) session = s.session;
  hydrated = true;
}

async function persist() {
  try {
    await chrome.storage.session.set({ session });
  } catch (e) {
    // Quota hit: drop oldest screenshots (keep the action log — it is the truth)
    for (const st of session.steps) {
      if (st.shot) { st.shot = null; st.shotDropped = true; break; }
    }
    try { await chrome.storage.session.set({ session }); } catch (_) {}
  }
}

async function getSettings() {
  const d = await chrome.storage.local.get({
    provider: "anthropic",
    apiKey: "",
    model: "",
    customUrl: "",
    includeScreenshots: false,
    captureValues: false,
    maxSteps: 150
  });
  if (!d.model) d.model = d.provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o";
  return d;
}

// ── Badge / broadcast ──────────────────────────────────────────────────────
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#FF4757" });
}

async function broadcastState() {
  const st = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, {
      evt: "recordingState", recording: session.recording, captureValues: st.captureValues
    }).catch(() => {});
  }
  chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
}

// ── Screenshot capture + annotation ───────────────────────────────────────
let lastShotAt = 0;
const MIN_SHOT_GAP = 620; // Chrome rate-limits captureVisibleTab (~2/sec)

async function captureShot(coords) {
  const now = Date.now();
  const wait = Math.max(0, lastShotAt + MIN_SHOT_GAP - now);
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastShotAt = Date.now();

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 85 });
  } catch (e) {
    return null; // chrome:// pages, devtools, race on tab close
  }
  try {
    return await annotate(dataUrl, coords);
  } catch (e) {
    try { return await (await fetch(dataUrl)).blob(); } catch (_) { return null; }
  }
}

// Downscale to <=1200px wide and draw a marker ring at the click point.
// Returns a JPEG Blob — screenshots live in IndexedDB, never in storage.session.
async function annotate(dataUrl, coords) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);

  const maxW = 1200;
  const scale = Math.min(1, maxW / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);

  if (coords && coords.x > 0 && coords.vw > 0) {
    // captureVisibleTab renders the viewport; map CSS px -> image px
    const px = (coords.x / coords.vw) * w;
    const py = (coords.y / coords.vh) * h;
    const r = Math.max(14, w * 0.018);

    ctx.lineWidth = Math.max(3, w * 0.004);
    ctx.strokeStyle = "#FF4757";
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,71,87,0.35)";
    ctx.beginPath(); ctx.arc(px, py, r * 1.8, 0, Math.PI * 2); ctx.stroke();
  }

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
}

// Attach a screenshot Blob to a step: bytes go to IndexedDB under the live
// session, the session record only carries the hasShot flag.
async function attachShot(step, blob) {
  if (!blob) return false;
  try {
    await PTDB.putShot({ stepId: step.id, recId: PTDB.LIVE_REC_ID, blob });
    step.hasShot = true;
    return true;
  } catch (e) {
    return false;
  }
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:image/jpeg;base64," + btoa(bin);
}

// ── Step recording ─────────────────────────────────────────────────────────
function humanize(a) {
  switch (a.type) {
    case "click":  return `Click **${a.label}** (${a.kind})`;
    case "select": return a.value ? `Select "${a.value}" in **${a.label}**` : `Choose an option in **${a.label}**`;
    case "input":
      if (a.value === "checked" || a.value === "unchecked") return `Set **${a.label}** to ${a.value}`;
      return a.masked ? `Enter a value in **${a.label}**` : `Enter "${a.value}" in **${a.label}**`;
    case "key":    return `Press ${a.value} in **${a.label}**`;
    case "submit": return `Submit the **${a.label}** form`;
    case "nav":    return `Navigate to **${a.label}**`;
    case "manual": return `(Manual capture)`;
    default:       return a.label || a.type;
  }
}

async function pushStep(step) {
  const st = await getSettings();
  if (session.steps.length >= st.maxSteps) return false;
  step.id = crypto.randomUUID();
  step.n = session.steps.length + 1;
  session.steps.push(step);
  await persist();
  chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
  return true;
}

async function addStep(action, withShot = true) {
  await hydrate();
  if (!session.recording && action.type !== "manual") return;

  const step = {
    ts: action.ts || Date.now(),
    type: action.type,
    text: humanize(action),
    label: action.label || "",
    kind: action.kind || "",
    value: action.masked ? "" : (action.value || ""),
    masked: !!action.masked,
    selector: action.selector || "",
    anchors: action.anchors || undefined,
    url: action.url || "",
    pageTitle: action.title || "",
    note: "",
    shot: null
  };
  if (!await pushStep(step)) return;

  if (withShot) {
    if (await attachShot(step, await captureShot(action))) {
      await persist();
      chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
    }
  }
}

// Desktop frame from the side panel's getDisplayMedia stream (window-capture mode).
// No DOM semantics here — the screenshot is the source of truth.
async function addDesktopStep({ shot, label, manual }) {
  await hydrate();
  if (!session.recording) return;
  const step = {
    ts: Date.now(),
    type: "desktop",
    text: manual ? "(Desktop frame — manual capture)" : "(Desktop frame — screen changed)",
    label: label || "",
    value: "", masked: false, url: "",
    pageTitle: label || "Desktop window",
    note: "",
    shot: null
  };
  if (!await pushStep(step)) return;
  if (shot) {
    const blob = await (await fetch(shot)).blob();
    if (await attachShot(step, blob)) {
      await persist();
      chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
    }
  }
}

// Semantic desktop step from the native UIA companion.
async function addUiaStep(m) {
  await hydrate();
  if (!session.recording) return;
  const label = m.label || "(unlabeled)";
  const kind = m.kind || "control";
  const app = m.app || "desktop app";
  const step = {
    ts: Date.now(),
    type: "uia",
    text: `Click **${label}** (${kind}) — ${app}`,
    label, kind, value: "", masked: false, url: "",
    autoId: m.autoId || "",
    className: m.className || "",
    app,
    pageTitle: m.window || app,
    note: "",
    shot: null
  };
  if (!await pushStep(step)) return;
  if (m.shot) {
    const blob = await (await fetch("data:image/jpeg;base64," + m.shot)).blob();
    if (await attachShot(step, blob)) {
      await persist();
      chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
    }
  }
}

// Navigation steps via tabs.onUpdated (recording only, http(s) only)
const recentNavs = new Map();
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await hydrate();
  if (!session.recording) return;
  if (info.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  if (!tab.active) return;
  const key = tabId + "|" + tab.url;
  const now = Date.now();
  if (recentNavs.get(key) && now - recentNavs.get(key) < 3000) return;
  recentNavs.set(key, now);
  // Skip nav step if it immediately follows a click (the click already tells the story)
  const last = session.steps[session.steps.length - 1];
  if (last && last.type === "click" && now - last.ts < 2500) return;
  await new Promise(r => setTimeout(r, 450)); // let paint settle
  await addStep({ type: "nav", label: tab.title || tab.url, url: tab.url, title: tab.title, ts: now, x: 0, y: 0 });
});

// ── Commands & action button ──────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Native UIA companion (semantic desktop capture) ────────────────────────
let nativePort = null;
let nativeConnected = false;

function nativeState(connected, error) {
  nativeConnected = connected;
  chrome.runtime.sendMessage({ evt: "nativeState", connected, error: error || "" }).catch(() => {});
}

function connectNative() {
  if (nativePort) return true;
  try {
    nativePort = chrome.runtime.connectNative("com.papertrail.uia");
  } catch (e) {
    nativeState(false, String(e.message || e));
    return false;
  }
  nativePort.onMessage.addListener((m) => {
    if (m && m.type === "hello") { nativeState(true); return; }
    if (m && m.type === "click") addUiaStep(m);
  });
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
    nativePort = null;
    nativeState(false, err);
  });
  return true;
}

function disconnectNative() {
  if (nativePort) { try { nativePort.disconnect(); } catch (_) {} }
  nativePort = null;
  nativeState(false);
}

chrome.commands.onCommand.addListener(async (cmd) => {
  await hydrate();
  if (cmd === "toggle-recording") {
    session.recording ? await stopRecording() : await startRecording();
  } else if (cmd === "manual-capture") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await addStep({ type: "manual", label: tab ? tab.title : "", url: tab ? tab.url : "", title: tab ? tab.title : "", ts: Date.now(), x: 0, y: 0 });
  } else if (cmd === "global-capture") {
    // Fires even when another app has focus; the side panel grabs a frame
    // from its window-capture stream if one is active.
    chrome.runtime.sendMessage({ evt: "desktopFrameRequest" }).catch(() => {});
  }
});

async function startRecording() {
  await hydrate();
  session = { recording: true, steps: [], startedAt: Date.now() };
  await PTDB.deleteShotsByRec(PTDB.LIVE_REC_ID).catch(() => {});
  await persist();
  setBadge(true);
  await broadcastState();
}

async function stopRecording() {
  await hydrate();
  session.recording = false;
  await persist();
  setBadge(false);
  await broadcastState();
}

// ── Message router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrate();
    switch (msg.cmd || msg.evt) {
      case "isRecording": {
        const st = await getSettings();
        sendResponse({ recording: session.recording, captureValues: st.captureValues });
        break;
      }
      case "action":
        await addStep(msg.data);
        sendResponse({ ok: true });
        break;
      case "start": await startRecording(); sendResponse({ ok: true }); break;
      case "stop":  await stopRecording();  sendResponse({ ok: true }); break;
      case "getState": sendResponse({ session }); break;
      case "clear":
        session = { recording: false, steps: [], startedAt: 0 };
        await PTDB.deleteShotsByRec(PTDB.LIVE_REC_ID).catch(() => {});
        await persist(); setBadge(false); await broadcastState();
        sendResponse({ ok: true });
        break;
      case "deleteStep": {
        const victim = session.steps.find(s => s.id === msg.id);
        if (victim && victim.hasShot) await PTDB.deleteShot(msg.id).catch(() => {});
        session.steps = session.steps.filter(s => s.id !== msg.id);
        session.steps.forEach((s, i) => s.n = i + 1);
        await persist();
        sendResponse({ ok: true });
        break;
      }
      case "updateNote": {
        const s = session.steps.find(s => s.id === msg.id);
        if (s) s.note = msg.note;
        await persist();
        sendResponse({ ok: true });
        break;
      }
      case "dropShot": {
        const s = session.steps.find(s => s.id === msg.id);
        if (s) {
          if (s.hasShot) await PTDB.deleteShot(msg.id).catch(() => {});
          s.shot = null; s.hasShot = false; s.shotDropped = true;
        }
        await persist();
        sendResponse({ ok: true });
        break;
      }
      case "manualCapture": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await addStep({ type: "manual", label: tab ? tab.title : "", url: tab ? tab.url : "", title: tab ? tab.title : "", ts: Date.now(), x: 0, y: 0 });
        sendResponse({ ok: true });
        break;
      }
      case "addDesktopStep":
        await addDesktopStep(msg);
        sendResponse({ ok: true });
        break;
      case "nativeConnect":
        sendResponse({ ok: connectNative() });
        break;
      case "nativeDisconnect":
        disconnectNative();
        sendResponse({ ok: true });
        break;
      case "nativeStatus":
        sendResponse({ connected: nativeConnected });
        break;
      case "generate": {
        try {
          const target = msg.target || "sop";
          const steps = await resolveSteps(msg.recordingId);
          const md = target === "sop"
            ? await generateSOP(steps, msg.context || "")
            : await generateAutomation(steps, msg.context || "", target);
          sendResponse({ ok: true, markdown: md });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "auditPayload": {
        try {
          const audit = await buildAudit(msg.target || "sop", msg.context || "", msg.recordingId);
          sendResponse({ ok: true, audit });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      default: sendResponse({ ok: false });
    }
  })();
  return true; // async
});

// ── SOP generation ─────────────────────────────────────────────────────────

// True whether the shot lives inline (legacy data URL) or in IndexedDB.
function stepHasShot(s) { return !!(s.shot || s.hasShot); }

// Base64 JPEG payload for a step's screenshot, wherever it is stored.
async function shotDataFor(step) {
  if (step.shot) return step.shot.split(",")[1];
  if (step.hasShot) {
    const rec = await PTDB.getShot(step.id);
    if (rec && rec.blob) return (await blobToDataUrl(rec.blob)).split(",")[1];
  }
  return null;
}

// Steps for generation: the live session, or a saved recording from the library.
async function resolveSteps(recordingId) {
  if (!recordingId) return session.steps;
  const rec = await PTDB.getRecording(recordingId);
  if (!rec) throw new Error("Recording not found in library.");
  return rec.steps;
}

function buildActionLog(steps) {
  return steps.map(s => ({
    step: s.n,
    action: s.type === "desktop"
      ? "(desktop frame — describe from the attached screenshot)"
      : s.text.replace(/\*\*/g, ""),
    source: s.type === "desktop" ? "desktop-capture" : (s.type === "uia" ? "desktop-uia" : "browser"),
    page: s.pageTitle,
    url: s.url || undefined,
    note: s.note || undefined,
    has_screenshot: stepHasShot(s)
  }));
}

const SYSTEM_PROMPT = `You are a technical writer producing a Standard Operating Procedure (SOP) in Markdown for a regulated enterprise environment.

You will receive a JSON action log captured from the user's session. Steps with source "browser" or "desktop-uia" carry REAL element labels read from the DOM or the Windows UI Automation tree — they are ground truth. If images are attached, they are screenshots of specific steps, each labeled with its step number; click points are marked with a red ring.

Rules:
1. Output ONLY the Markdown document. No preamble, no code fences around the whole document.
2. Structure: # Title, ## Purpose, ## Scope, ## Prerequisites, ## Procedure (numbered steps), ## Notes (omit if nothing to add).
3. Bold every UI element name exactly as given in the action log. Do not invent, rename, or "correct" element labels.
4. Where a step has "has_screenshot": true, place the token {{screenshot_N}} on its own line immediately after that step, where N is the step number. Use ONLY these tokens for images — never a URL, never a token for a step without a screenshot.
5. Merge trivially-related actions into one instruction where it improves readability (e.g. typing into a field then pressing Enter), but keep every screenshot token you use tied to its correct step number.
6. Steps with source "desktop-capture" have NO semantic label — the attached screenshot with the matching step number is the source of truth. Describe only the action or state that is clearly visible; if ambiguous, describe the visible state conservatively rather than guessing.
7. Infer Prerequisites from the pages and applications used (required system access, accounts). Be conservative — mark inferences as such.
8. Use the operator's notes (the "note" fields) as authoritative context.`;

// Everything generateSOP would send, without sending it. The privacy audit
// renders this same object, so the audit is the real payload by construction.
async function buildSopRequest(steps, userContext, st) {
  if (!steps.length) throw new Error("No steps recorded yet.");

  const log = JSON.stringify(buildActionLog(steps), null, 1);
  let userText = `Create an SOP from this recorded session.\n\nACTION LOG:\n${log}`;
  if (userContext) userText += `\n\nOPERATOR CONTEXT (purpose/audience):\n${userContext}`;

  // Privacy rule: web/UIA screenshots stay local unless opted in.
  // Desktop-capture frames are the only meaning their steps have, so they
  // are always attached when such steps exist.
  const attach = (s) => stepHasShot(s) && (st.includeScreenshots || s.type === "desktop");
  const shots = [];
  for (const s of steps.filter(attach)) {
    const data = await shotDataFor(s);
    if (data) shots.push({ n: s.n, data });
  }

  const hasDesktop = steps.some(s => s.type === "desktop");
  if (!st.includeScreenshots) {
    userText += hasDesktop
      ? `\n\n(Only desktop-capture frames are attached; browser screenshots exist locally and will be spliced in at export — still place {{screenshot_N}} tokens for every step with has_screenshot true.)`
      : `\n\n(Screenshots exist locally for the steps marked has_screenshot but are NOT attached; still place {{screenshot_N}} tokens per the rules — they will be spliced in locally.)`;
  }

  return { system: SYSTEM_PROMPT, userText, shots };
}

function requireEndpoint(st) {
  if (!st.apiKey && st.provider !== "custom") throw new Error("No API key configured. Open extension options.");
  if (st.provider === "custom" && !st.customUrl) throw new Error("No custom endpoint URL configured. Open extension options.");
}

async function generateSOP(steps, userContext) {
  const st = await getSettings();
  requireEndpoint(st);
  const req = await buildSopRequest(steps, userContext, st);
  if (st.provider === "anthropic") return callAnthropic(st, req.system, req.userText, req.shots);
  return callOpenAI(st, req.system, req.userText, req.shots);
}

// ── RPA / automation generation (text-only: no pixels ever leave) ──────────
// Alternate verified anchors for a step, primary excluded (automation payload).
function altSelectors(s) {
  const alts = PTCommon.anchorList(s).filter(x => x !== s.selector);
  return alts.length ? alts : undefined;
}

function buildAutomationLog(steps) {
  return steps.map(s => ({
    step: s.n,
    type: s.type,                                    // click | input | select | key | submit | nav | uia | desktop | manual
    source: s.type === "uia" ? "desktop-uia" : (s.type === "desktop" ? "desktop-capture" : "browser"),
    label: s.label || undefined,
    kind: s.kind || undefined,
    value: s.masked ? undefined : (s.value || undefined),
    value_masked: s.masked || undefined,             // masked entries become script parameters
    selector: s.selector || undefined,               // web: verified CSS selector (primary)
    alt_selectors: altSelectors(s),                  // web: alternate verified anchors, trust-ordered
    automation_id: s.autoId || undefined,            // desktop: UIA AutomationId
    class_name: s.className || undefined,            // desktop: UIA ClassName
    app: s.app || undefined,
    window: (s.type === "uia" || s.type === "desktop") ? s.pageTitle : undefined,
    url: s.url || undefined,
    note: s.note || undefined
  }));
}

const AUTOMATION_PROMPTS = {
  powershell: `You are an automation engineer converting a recorded procedure into a production-quality PowerShell script for a regulated enterprise (PowerShell 5.1+ compatible).

You will receive a JSON action log with GROUND-TRUTH element anchors captured at record time:
- Browser steps carry a verified CSS "selector".
- Desktop steps (source "desktop-uia") carry UIA "label" (Name), "kind" (ControlType), "automation_id", "class_name", "app", and "window".

Rules:
1. Output ONLY the PowerShell script. No markdown fences, no prose outside the script.
2. Browser steps: use the Selenium PowerShell module (Start-SeChrome / Find-SeElement -By CssSelector / Invoke-SeClick / Send-SeKeys). Use the captured "selector" strings VERBATIM — never invent or "improve" selectors. Navigate using the captured "url" values on nav steps.
3. Desktop steps: use System.Windows.Automation (Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes). Locate elements by AutomationId when present, otherwise by Name + ControlType, scoped to the window title. Invoke via InvokePattern / ValuePattern / SelectionItemPattern as appropriate for the "kind".
4. Steps with "value_masked": true become script param() parameters with descriptive names derived from the label; secrets use [SecureString] and a comment pointing to the org's vault.
5. Steps with source "desktop-capture" have no anchors: emit a clearly-marked "# TODO: manual anchor required" block describing the step from its note, never a fake anchor.
6. Include: a param() block, a Write-StepLog helper, a Wait-ForElement helper with timeout + retry for both web and UIA lookups, try/catch per step with the step number in the error, and a summary at the end.
7. Comment each step with its original step number and human description.
8. Be conservative: replay exactly what was recorded; no speculative branches.
9. Some steps carry "alt_selectors" — alternate verified anchors for the SAME element, in decreasing trust order. Try the primary "selector" first and fall back through alt_selectors in the element-lookup helper. Never invent anchors that are not in the log.`,

  aa: `You are an RPA consultant converting a recorded procedure into an Automation Anywhere A360 bot build sheet. Bot JSON is not a supported hand-authoring format, so produce the document a CoE developer would use to assemble the bot quickly and correctly in the A360 editor.

You will receive a JSON action log with GROUND-TRUTH element anchors captured at record time:
- Browser steps carry a verified CSS "selector" plus label and URL.
- Desktop steps (source "desktop-uia") carry UIA Name ("label"), ControlType ("kind"), "automation_id", "class_name", "app", and "window" — these map directly to A360 Recorder object properties.

Rules:
1. Output ONLY the Markdown build sheet.
2. Structure: # <Bot name>, ## Overview, ## Prerequisites (packages: Recorder, Browser, plus any inferred), ## Variables (a table: name, type, source — masked values become vault/prompt credential variables), ## Bot Actions (one numbered entry per logical step), ## Error Handling (Try/Catch wrapper guidance), ## Validation.
3. Each Bot Action entry must name the exact A360 action (e.g. "Recorder: Capture", "Browser: Launch website", "Recorder: Capture — action Set text") and list the object properties to pin, quoting the captured anchors VERBATIM: window title, ControlType, Name, AutomationId / DOMXPath or CSS selector. Recommend which properties to enable for matching (prefer AutomationId / CSS anchor over coordinates; never recommend image or coordinate matching when an anchor exists).
4. Steps with "value_masked": true reference the credential/prompt variable from the Variables table.
5. Steps with source "desktop-capture" have no anchors: flag them as "manual capture required in Recorder" with the step's description.
6. Be conservative and exact — a developer should be able to build the bot without re-recording.
7. Some steps carry "alt_selectors" — alternate verified anchors for the SAME element, in decreasing trust order. List them in the entry's object properties as secondary match criteria the developer can pin if the primary anchor proves unstable. Never invent anchors that are not in the log.`
};

// Build-only counterpart for automation targets. Text-only by design:
// anchors are the payload, never pixels.
function buildAutomationRequest(steps, userContext, target) {
  if (!steps.length) throw new Error("No steps recorded yet.");
  const sys = AUTOMATION_PROMPTS[target];
  if (!sys) throw new Error("Unknown automation target: " + target);

  const log = JSON.stringify(buildAutomationLog(steps), null, 1);
  let userText = `Convert this recorded session into ${target === "powershell" ? "a PowerShell automation script" : "an Automation Anywhere A360 build sheet"}.\n\nACTION LOG:\n${log}`;
  if (userContext) userText += `\n\nOPERATOR CONTEXT:\n${userContext}`;

  return { system: sys, userText, shots: [] };
}

async function generateAutomation(steps, userContext, target) {
  const st = await getSettings();
  requireEndpoint(st);
  const req = buildAutomationRequest(steps, userContext, target);
  if (st.provider === "anthropic") return callAnthropic(st, req.system, req.userText, req.shots);
  return callOpenAI(st, req.system, req.userText, req.shots);
}

// ── Provider transport (bodies shared with the privacy audit) ──────────────
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function endpointFor(st) {
  if (st.provider === "anthropic") return ANTHROPIC_URL;
  return st.provider === "custom" ? st.customUrl : OPENAI_URL;
}

function anthropicBody(st, system, userText, shots) {
  const content = [{ type: "text", text: userText }];
  for (const s of shots) {
    content.push({ type: "text", text: `Screenshot for step ${s.n}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.data } });
  }
  return {
    model: st.model,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content }]
  };
}

function openaiBody(st, system, userText, shots) {
  const content = shots.length
    ? [{ type: "text", text: userText },
       ...shots.flatMap(s => ([
         { type: "text", text: `Screenshot for step ${s.n}:` },
         { type: "image_url", image_url: { url: `data:image/jpeg;base64,${s.data}` } }
       ]))]
    : userText;
  return {
    model: st.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content }
    ]
  };
}

async function callAnthropic(st, system, userText, shots) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": st.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(anthropicBody(st, system, userText, shots))
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function callOpenAI(st, system, userText, shots) {
  const headers = { "content-type": "application/json" };
  if (st.apiKey) headers["Authorization"] = `Bearer ${st.apiKey}`;

  const resp = await fetch(endpointFor(st), {
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody(st, system, userText, shots))
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const c = data.choices && data.choices[0] && data.choices[0].message.content;
  if (Array.isArray(c)) return c.map(p => p.text || "").join("");
  return c || "";
}

// ── Privacy audit: the literal request, minus pixels and credentials ───────
function redactImagesInBody(body) {
  const kb = (b64) => Math.max(1, Math.round(b64.length * 3 / 4096));
  let redacted = 0;
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const item of m.content) {
      if (item.type === "image" && item.source && item.source.data) {
        item.source = Object.assign({}, item.source,
          { data: `[[ ${kb(item.source.data)} KB JPEG omitted from this audit — never sent when screenshots are off ]]` });
        redacted++;
      } else if (item.type === "image_url" && item.image_url && item.image_url.url) {
        item.image_url = { url: `[[ ${kb(item.image_url.url)} KB JPEG omitted from this audit ]]` };
        redacted++;
      }
    }
  }
  return redacted;
}

async function buildAudit(target, userContext, recordingId) {
  const steps = await resolveSteps(recordingId);
  const st = await getSettings();
  const req = target === "sop"
    ? await buildSopRequest(steps, userContext, st)
    : buildAutomationRequest(steps, userContext, target);
  const body = st.provider === "anthropic"
    ? anthropicBody(st, req.system, req.userText, req.shots)
    : openaiBody(st, req.system, req.userText, req.shots);
  redactImagesInBody(body);
  const stats = PTCommon.auditStats(steps);
  return {
    generatedAt: Date.now(),
    target,
    provider: st.provider,
    model: st.model,
    endpoint: endpointFor(st) || "(no custom endpoint configured)",
    includeScreenshots: !!st.includeScreenshots,
    stepCount: stats.stepCount,
    shotsCaptured: stats.shotSteps,             // step numbers that have a local screenshot
    shotsAttached: req.shots.map(s => s.n),     // step numbers whose pixels would be sent
    maskedSteps: stats.maskedSteps,             // masked values: label only, value never captured
    system: req.system,
    userText: req.userText,
    body                                        // exact request body, images redacted, no credentials
  };
}

// Keep badge accurate across worker restarts
chrome.runtime.onStartup?.addListener(async () => { await hydrate(); setBadge(session.recording); });
hydrate().then(() => setBadge(session.recording));
