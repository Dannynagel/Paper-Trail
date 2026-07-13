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
    captionOnCapture: false,
    maxSteps: 150,
    transcribeUrl: "https://api.openai.com/v1/audio/transcriptions",
    transcribeModel: "whisper-1",
    transcribeKey: ""
  });
  if (!d.model) {
    d.model = d.provider === "anthropic" ? "claude-sonnet-4-6"
            : d.provider === "custom" ? "gemma4:12b-it-qat"   // Ollama-friendly local default
            : "gpt-4o";
  }
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
    narration: "",
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
    narration: "",
    shot: null
  };
  if (!await pushStep(step)) return;
  if (shot) {
    const blob = await (await fetch(shot)).blob();
    if (await attachShot(step, blob)) {
      await persist();
      chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
      captionStep(step.id); // best-effort, fire-and-forget (no-op unless enabled)
    }
  }
}

// ── Caption-on-capture ──────────────────────────────────────────────────────
// Optional: describe each desktop frame with the configured vision model the
// moment it is captured, amortizing the vision cost across the recording
// session. Captioned frames are NOT attached at generation (the caption
// travels as text instead), so generation becomes text-only and fast.
// Best-effort: any failure leaves the step uncaptioned and generation falls
// back to attaching the frame, exactly as without this option.
const CAPTION_PROMPT = `You describe one step of a recorded desktop procedure from a single screenshot. A red ring, when present, marks the click point. Output ONE concise imperative sentence (max 30 words) describing the action or state visible in the frame — e.g. "Click Save in the toolbar of the Orders window." No preamble, no quotes, no markdown.`;

async function captionStep(stepId) {
  try {
    const st = await getSettings();
    if (!st.captionOnCapture) return;
    if (!st.apiKey && st.provider !== "custom") return;   // no endpoint configured — skip silently
    if (st.provider === "custom" && !st.customUrl) return;

    await hydrate();
    let step = session.steps.find(s => s.id === stepId);
    if (!step || !step.hasShot) return;
    const data = await shotDataFor(step);
    if (!data) return;

    const shots = [{ n: step.n, data }];
    const text = st.provider === "anthropic"
      ? await callAnthropic(st, CAPTION_PROMPT, "Describe this step.", shots)
      : await callOpenAI(st, CAPTION_PROMPT, "Describe this step.", shots);
    const caption = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!caption) return;

    await hydrate();
    step = session.steps.find(s => s.id === stepId); // session may have changed during the call
    if (!step) return;
    step.caption = caption;
    await persist();
    chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
  } catch (e) { /* caption is best-effort */ }
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
    narration: "",
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

// ── HTTP capture (observational webRequest; recording only) ────────────────
// While recording, log the page's own document/XHR/fetch requests — the
// ground truth the psweb (Invoke-WebRequest/Invoke-RestMethod) target replays.
// tabId >= 0 excludes the extension's own LLM/transcription calls. Values are
// masked under the same rules as typed values; secret-like keys always.
const HTTP_CAP = 300;
const HTTP_SECRETY = /pass|secret|token|key|ssn|card|auth|pwd|credential|session/i;
const pendingHttp = new Map(); // requestId -> live entry (best-effort status fill-in)

function httpMaskForm(formData, captureValues) {
  const out = {};
  for (const [k, vals] of Object.entries(formData || {})) {
    out[k] = (captureValues && !HTTP_SECRETY.test(k))
      ? String((vals && vals[0]) || "").slice(0, 120)
      : "[masked]";
  }
  return out;
}

function httpMaskJson(value, captureValues, depth = 0) {
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 5).map(v => httpMaskJson(v, captureValues, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) {
      out[k] = (v && typeof v === "object")
        ? httpMaskJson(v, captureValues, depth + 1)
        : ((captureValues && !HTTP_SECRETY.test(k)) ? String(v).slice(0, 120) : "[masked]");
    }
    return out;
  }
  return captureValues ? String(value).slice(0, 120) : "[masked]";
}

function httpScrubUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (HTTP_SECRETY.test(k)) url.searchParams.set(k, "masked");
    }
    return url.href;
  } catch (e) { return u; }
}

chrome.webRequest.onBeforeRequest.addListener(async (d) => {
  await hydrate();
  if (!session.recording || d.tabId < 0) return;
  if (!Array.isArray(session.http)) session.http = [];
  if (session.http.length >= HTTP_CAP) return;

  const st = await getSettings();
  const entry = { ts: Date.now(), method: d.method, url: httpScrubUrl(d.url), type: d.type };
  if (d.requestBody) {
    if (d.requestBody.formData) {
      entry.form = httpMaskForm(d.requestBody.formData, st.captureValues);
    } else if (d.requestBody.raw && d.requestBody.raw[0] && d.requestBody.raw[0].bytes &&
               d.requestBody.raw[0].bytes.byteLength <= 8192) {
      try {
        entry.json = httpMaskJson(JSON.parse(new TextDecoder().decode(d.requestBody.raw[0].bytes)), st.captureValues);
      } catch (e) { entry.body = "(non-JSON body omitted)"; }
    }
  }
  pendingHttp.set(d.requestId, entry);
  session.http.push(entry);
  await persist();
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame", "xmlhttprequest"] }, ["requestBody"]);

chrome.webRequest.onCompleted.addListener(async (d) => {
  const entry = pendingHttp.get(d.requestId);
  pendingHttp.delete(d.requestId);
  if (!entry) return;
  entry.status = d.statusCode;
  const ct = (d.responseHeaders || []).find(h => h.name.toLowerCase() === "content-type");
  if (ct) entry.contentType = String(ct.value || "").split(";")[0];
  await hydrate();
  await persist();
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame", "xmlhttprequest"] }, ["responseHeaders"]);

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
  session = { recording: true, steps: [], http: [], startedAt: Date.now() };
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

// ── Drift sentinel ──────────────────────────────────────────────────────────
// Hourly alarm → re-verify watched recordings' anchors against the live site
// in an INACTIVE tab, report-only. Runs are short, sequential, and message-
// driven (each round-trip resets the MV3 idle timer); an interrupted run is
// simply retried on the next alarm.
let sentinelBusy = false;

async function ensureSentinelAlarm() {
  const metas = await PTDB.listRecordings().catch(() => []);
  if (metas.some(m => m.watch)) {
    await chrome.alarms.create("pt-sentinel", { periodInMinutes: 60 });
  } else {
    await chrome.alarms.clear("pt-sentinel");
  }
}

// The "!" badge must never clobber the REC badge.
function setSentinelBadge(on) {
  if (session.recording) return;
  chrome.action.setBadgeText({ text: on ? "!" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#E8B84B" });
}

function sentinelAlert(title, counts, summary) {
  const n = counts.fallback + counts.missing + counts.unreachable;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Paper Trail — drift sentinel",
      message: `SOP "${title}" drifted: ${n} anchor problem(s). ${summary}`
    });
  } catch (e) { /* notification is best-effort */ }
  setSentinelBadge(true);
}

function sentinelWaitLoad(tabId, ms) {
  return new Promise((res) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      res(ok);
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => finish(false), ms);
  });
}

// Same origin+path tolerance and 20 s timeout as the panel's Verify mode.
async function sentinelEnsureAt(tabId, url) {
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { reached: false, finalUrl: "" };
  if (PTCommon.samePage(tab.url, url) && tab.status === "complete") {
    return { reached: true, finalUrl: tab.url };
  }
  const done = sentinelWaitLoad(tabId, 20000);
  await chrome.tabs.update(tabId, { url });
  const ok = await done;
  if (!ok) return { reached: false, finalUrl: "" };
  await new Promise(r => setTimeout(r, 600));
  tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { reached: false, finalUrl: "" };
  return { reached: PTCommon.sameOrigin(tab.url, url), finalUrl: tab.url || "" };
}

async function sentinelProbe(tabId, step) {
  let frames = [];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch (e) {}
  if (!frames || !frames.length) frames = [{ frameId: 0 }];
  const rank = { found: 3, fallback: 2, missing: 1 };
  let best = { status: "missing" };
  for (const f of frames) {
    const r = await new Promise((res) => {
      chrome.tabs.sendMessage(tabId, {
        cmd: "probeStep",
        step: { selector: step.selector, anchors: step.anchors, label: step.label, kind: step.kind, type: step.type }
      }, { frameId: f.frameId }, (resp) => {
        void chrome.runtime.lastError;
        res(resp || null);
      });
    });
    if (!r) continue;
    if (rank[r.status] > rank[best.status]) best = r;
    if (best.status === "found") break;
  }
  return best;
}

async function sentinelVerify(rec) {
  const grades = [];
  let tabId = null;
  try {
    for (const s of rec.steps) {
      const verifiable = s.type === "nav" ? !!s.url : !!(s.selector && s.url);
      if (!verifiable) { grades.push("na"); continue; }

      let nav;
      if (tabId === null) {
        const created = await chrome.tabs.create({ url: s.url, active: false });
        tabId = created.id;
        const ok = await sentinelWaitLoad(tabId, 20000);
        await new Promise(r => setTimeout(r, 600));
        const t = ok ? await chrome.tabs.get(tabId).catch(() => null) : null;
        nav = { reached: !!(t && PTCommon.sameOrigin(t.url, s.url)), finalUrl: t ? t.url : "" };
      } else {
        nav = await sentinelEnsureAt(tabId, s.url);
      }
      if (!nav.reached) { grades.push("unreachable"); continue; }

      if (s.type === "nav") {
        grades.push(PTCommon.samePage(nav.finalUrl, s.url) ? "found" : "fallback");
        continue;
      }
      const probe = await sentinelProbe(tabId, s);
      grades.push(probe.status || "missing");
    }
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }

  const summary = PTCommon.summarizeVerify(grades);
  const count = (g) => grades.filter(x => x === g).length;
  const counts = { fallback: count("fallback"), missing: count("missing"), unreachable: count("unreachable") };

  const fresh = await PTDB.getRecording(rec.id);
  if (!fresh) return summary;
  fresh.lastVerified = { ts: Date.now(), summary: summary + " — sentinel" };
  if (fresh.watch) {
    const prev = fresh.watch.lastCounts || { fallback: 0, missing: 0, unreachable: 0 };
    // Alert only on NEW problems vs the previous sweep; a site that stays
    // unreachable (login wall) or stays drifted never re-notifies.
    const worse = (counts.fallback + counts.missing) > (prev.fallback + prev.missing) ||
                  counts.unreachable > prev.unreachable;
    fresh.watch.lastRun = Date.now();
    fresh.watch.lastCounts = counts;
    if (worse) {
      fresh.watch.lastNotified = Date.now();
      sentinelAlert(fresh.title, counts, summary);
    }
  }
  fresh.updatedAt = Date.now();
  await PTDB.saveRecording(fresh);
  return summary;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "pt-sentinel") return;
  await hydrate();
  if (session.recording || sentinelBusy) return; // never open tabs mid-recording
  sentinelBusy = true;
  try {
    const metas = await PTDB.listRecordings();
    for (const m of metas) {
      if (!m.watch) continue;
      const period = (m.watch.periodHours || 24) * 3600 * 1000;
      if (Date.now() - (m.watch.lastRun || 0) < period) continue;
      const rec = await PTDB.getRecording(m.id);
      if (rec && rec.watch) await sentinelVerify(rec);
    }
  } finally {
    sentinelBusy = false;
  }
});

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
        session = { recording: false, steps: [], http: [], startedAt: 0 };
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
      case "setParam": {
        const s = session.steps.find(s => s.id === msg.id);
        if (s) {
          if (msg.param) s.param = String(msg.param).trim();
          else delete s.param;
        }
        await persist();
        sendResponse({ ok: true });
        break;
      }
      case "setNarration": {
        const byId = new Map(session.steps.map(s => [s.id, s]));
        for (const item of msg.items || []) {
          const s = byId.get(item.id);
          if (s) s.narration = String(item.narration || "");
        }
        await persist();
        chrome.runtime.sendMessage({ evt: "sessionChanged" }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "dropNarration": {
        const s = session.steps.find(s => s.id === msg.id);
        if (s) s.narration = "";
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
      case "evidenceShot": {
        // One evidence screenshot for a run step. Stored locally under the
        // run's synthetic recId; reuses the rate-gated capture pipeline.
        const blob = await captureShot(null);
        if (blob && msg.runId) {
          const key = msg.runId + ":" + msg.n;
          try {
            await PTDB.putShot({ stepId: key, recId: "run:" + msg.runId, blob });
            sendResponse({ ok: true, key });
            break;
          } catch (e) { /* fall through */ }
        }
        sendResponse({ ok: false });
        break;
      }
      case "watchChanged":
        await ensureSentinelAlarm();
        sendResponse({ ok: true });
        break;
      case "sentinelRunNow": {
        // Deterministic trigger for tests and a manual "check now".
        const rec = await PTDB.getRecording(msg.recId);
        if (!rec) { sendResponse({ ok: false, error: "Recording not found." }); break; }
        const summary = await sentinelVerify(rec);
        sendResponse({ ok: true, summary });
        break;
      }
      case "libraryOpened":
        setSentinelBadge(false);
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
          const src = await resolveSource(msg.recordingId);
          const md = target === "sop"
            ? await generateSOP(src.steps, msg.context || "")
            : await generateAutomation(src, msg.context || "", target, { secretServer: !!msg.secretServer });
          sendResponse({ ok: true, markdown: md });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "auditPayload": {
        try {
          const audit = await buildAudit(msg.target || "sop", msg.context || "", msg.recordingId, msg.recordingIdB,
            { secretServer: !!msg.secretServer });
          sendResponse({ ok: true, audit });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "generateDiff": {
        try {
          const md = await generateDiff(msg.recordingIdA, msg.recordingIdB, msg.context || "");
          sendResponse({ ok: true, markdown: md });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "generateBranch": {
        try {
          const md = await generateBranch(msg.trunkId, msg.context || "");
          sendResponse({ ok: true, markdown: md });
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

// Generation source: the live session, or a saved recording from the library.
// Returns steps plus the captured HTTP log (consumed only by the psweb target).
async function resolveSource(recordingId) {
  if (!recordingId) return { steps: session.steps, http: session.http || [], paramSets: 0 };
  const rec = await PTDB.getRecording(recordingId);
  if (!rec) throw new Error("Recording not found in library.");
  // paramSets travels as a COUNT only — row values never leave the machine.
  return { steps: rec.steps, http: rec.http || [], paramSets: (rec.paramSets || []).length };
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
    narration: s.narration || undefined,
    caption: (s.type === "desktop" && s.caption) || undefined, // vision caption written at capture time
    run_time_parameter: s.param || undefined,                  // per-run input: render as <NAME>
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
6. Steps with source "desktop-capture" have NO semantic label. If such a step carries a "caption" field, it was written by a vision model from the frame at capture time — treat it as the step's description (its screenshot may not be attached). Otherwise the attached screenshot with the matching step number is the source of truth: describe only the action or state that is clearly visible; if ambiguous, describe conservatively rather than guessing.
7. Infer Prerequisites from the pages and applications used (required system access, accounts). Be conservative — mark inferences as such.
8. Use the operator's notes (the "note" fields) as authoritative context.
9. The "narration" fields are the operator's spoken commentary transcribed during recording. Use them as authoritative intent and context — the "why" behind steps, prerequisites, warnings — but attribute nothing to the UI from them: element labels in the action log remain the only ground truth for what is on screen.
10. Steps with "run_time_parameter" take a different value on every run (e.g. the affected user in a JML process). Write the step using the placeholder in angle brackets exactly — e.g. Enter <EMPLOYEE_ID> in **Employee ID** — and add an "Inputs" list under Prerequisites naming every parameter with a one-line description of what to supply.`;

// Everything generateSOP would send, without sending it. The privacy audit
// renders this same object, so the audit is the real payload by construction.
async function buildSopRequest(steps, userContext, st) {
  if (!steps.length) throw new Error("No steps recorded yet.");

  const log = JSON.stringify(buildActionLog(steps), null, 1);
  let userText = `Create an SOP from this recorded session.\n\nACTION LOG:\n${log}`;
  if (userContext) userText += `\n\nOPERATOR CONTEXT (purpose/audience):\n${userContext}`;

  // Privacy rule: web/UIA screenshots stay local unless opted in.
  // Desktop-capture frames are the only meaning their steps have, so they are
  // attached when such steps exist — UNLESS a capture-time caption already
  // carries that meaning as text (caption-on-capture), in which case the
  // frame stays local too and generation is text-only.
  const attach = (s) => stepHasShot(s) &&
    (st.includeScreenshots || (s.type === "desktop" && !s.caption));
  const shots = [];
  for (const s of steps.filter(attach)) {
    const data = await shotDataFor(s);
    if (data) shots.push({ n: s.n, data });
  }

  const hasDesktopFrames = steps.some(s => s.type === "desktop" && stepHasShot(s) && !s.caption);
  if (!st.includeScreenshots) {
    userText += hasDesktopFrames
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
    param_name: s.param || undefined,                // operator-marked run-time parameter (exact name)
    selector: s.selector || undefined,               // web: verified CSS selector (primary)
    alt_selectors: altSelectors(s),                  // web: alternate verified anchors, trust-ordered
    automation_id: s.autoId || undefined,            // desktop: UIA AutomationId
    class_name: s.className || undefined,            // desktop: UIA ClassName
    app: s.app || undefined,
    window: (s.type === "uia" || s.type === "desktop") ? s.pageTitle : undefined,
    url: s.url || undefined,
    note: s.note || undefined,
    narration: s.narration || undefined,
    caption: (s.type === "desktop" && s.caption) || undefined
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
9. Some steps carry "alt_selectors" — alternate verified anchors for the SAME element, in decreasing trust order. Try the primary "selector" first and fall back through alt_selectors in the element-lookup helper. Never invent anchors that are not in the log.
10. Steps with "param_name" are operator-marked run-time inputs (they change every run — e.g. the affected user in a JML process): emit a mandatory param() parameter with EXACTLY that name; if the log shows a recorded value, put it in a comment as a sample, never as a default.`,

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
7. Some steps carry "alt_selectors" — alternate verified anchors for the SAME element, in decreasing trust order. List them in the entry's object properties as secondary match criteria the developer can pin if the primary anchor proves unstable. Never invent anchors that are not in the log.
8. Steps with "param_name" are operator-marked run-time inputs: add them to the Variables table with EXACTLY that name (type: prompt/input variable) and reference the variable in the corresponding Bot Action.`,

  playwright: `You are an automation engineer converting a recorded procedure into a production-quality Node.js Playwright script.

You will receive a JSON action log with GROUND-TRUTH element anchors captured at record time:
- Browser steps carry a verified CSS "selector" (primary) and may carry "alt_selectors" — alternate verified anchors for the SAME element in decreasing trust order.
- Desktop steps (source "desktop-uia" or "desktop-capture") cannot be automated by Playwright.

Rules:
1. Output ONLY the JavaScript file. No markdown fences, no prose outside code comments.
2. Structure: const { chromium } = require("playwright"); an async main() with try/finally browser close; and a locOf(page, selectors, stepN) helper that returns the first locator whose selector resolves within a short per-candidate timeout (~1500 ms) and throws with the step number when none do.
3. For each step call locOf with [selector, ...alt_selectors] using the captured strings VERBATIM — never invent or "improve" selectors. click → .click(); input → .fill(value); select → .selectOption({ label: value }); key steps with "Enter" → .press("Enter"); nav steps → await page.goto(url) with the captured "url".
4. Steps with "value_masked": true read their value from process.env.PT_<LABEL_IN_SNAKE_CASE>; start the file with a comment block listing every required environment variable and exit early with a clear message when one is missing.
5. Desktop steps become a clearly-marked "// TODO step N: not a browser step — <description>" comment, never fake code.
6. Wrap each step in try/catch that rethrows with the step number and human description; console.log each step before performing it.
7. Use the operator's "note" and "narration" fields as code comments where they clarify intent.
8. Be conservative: replay exactly what was recorded; no speculative branches, no extra assertions.
9. Steps with "param_name" are operator-marked run-time inputs: read them from process.env with EXACTLY that name (PT_ prefix not needed when param_name is present), list them in the required-environment comment block, and treat any recorded value as a sample in a comment only.`,

  pwtest: `You are a QA engineer converting a recorded procedure into a READ-ONLY Playwright regression test (@playwright/test) that verifies the procedure's UI anchors still resolve — the CI version of an SOP health check.

You will receive a JSON action log with GROUND-TRUTH element anchors captured at record time (primary "selector" plus optional "alt_selectors" in decreasing trust order).

Rules:
1. Output ONLY the JavaScript test file. No markdown fences, no prose outside code comments.
2. Use const { test, expect } = require("@playwright/test"). Group consecutive steps sharing the same "url" (compare origin+path, ignore query/hash) into one test() named after the page; each test does ONE page.goto(url), then asserts anchors.
3. The test is READ-ONLY: never click, fill, submit, or press keys. State this in a top-of-file comment.
4. For each anchored step, assert that at least one of its anchors resolves: implement a firstResolving(page, selectors) helper returning the first locator with a match, and await expect(...).toBeVisible() with the step number and label in the failure message. Use captured selectors VERBATIM.
5. Steps without a selector (nav, desktop, manual) contribute only their url grouping or a "// not verifiable: <description>" comment.
6. Ignore "value_masked" — nothing is typed in a read-only check.
7. Keep it runnable as-is with: npx playwright test <file>.`
};

AUTOMATION_PROMPTS.psweb = `You are an automation engineer converting a recorded web procedure into a production-quality PowerShell 5.1+ script that uses ONLY Invoke-WebRequest and Invoke-RestMethod — no browser, no Selenium, no external modules.

You will receive:
- A JSON ACTION LOG of the operator's UI steps (intent and ordering; element labels are ground truth for meaning).
- An HTTP LOG captured during the recording: the real requests the web app made (method, URL, type, form fields or JSON key structure, status). This is the ground truth for what to replay. Masked values appear as "[masked]".

Rules:
1. Output ONLY the PowerShell script. No markdown fences, no prose outside comments.
2. Replay the HTTP LOG in order: Invoke-WebRequest with -SessionVariable on the first request and -WebSession thereafter so cookies persist across the whole flow; use Invoke-RestMethod for JSON endpoints, building bodies with ConvertTo-Json to match the logged key structure exactly.
3. When a POST's fields include hidden or anti-forgery values (__RequestVerificationToken, csrf, __VIEWSTATE and similar), first GET the page, extract the token from the response (.InputFields or the HTML), and send that — never hard-code such values.
4. Masked values and steps with "param_name" become mandatory param() parameters (use param_name verbatim when present, otherwise derive from the field name). Secrets use [SecureString]/PSCredential with a comment pointing at the org's vault.
5. Check every response: throw with the step context when the status differs from the logged success status. Use -UseBasicParsing for 5.1 compatibility and set an explicit -UserAgent.
6. Where a request needs a dynamic value the log cannot supply (server-generated ids, tokens in redirects), extract it from the preceding response when the source is evident; otherwise emit a clearly-marked "# TODO: dynamic value" block. Never invent endpoints or fields not present in the HTTP LOG.
7. Comment each block with the corresponding UI step number and description; include a Write-StepLog helper and a run summary at the end.
8. Be conservative: replay exactly what was recorded; no speculative requests.`;

// Delinea Secret Server prompt modifiers (per target language) — filled by the
// SS checkbox; see SS_RULES definitions below.
const TARGET_DOC = {
  powershell: "a PowerShell automation script",
  aa: "an Automation Anywhere A360 build sheet",
  playwright: "a Node.js Playwright automation script",
  pwtest: "a read-only Playwright regression test spec",
  psweb: "a pure-HTTP PowerShell script (Invoke-WebRequest / Invoke-RestMethod)"
};

// Delinea Secret Server (on-prem) credential mode — appended to the system
// prompt when the operator enables the 🔐 checkbox. Same audit-by-construction
// guarantee: the audit shows the exact modified prompt.
const SS_RULES_PS = `ADDITIONAL REQUIREMENT — Delinea Secret Server (on-prem) credential sourcing:
A. Include a Secret Server helper block built ONLY on Invoke-RestMethod (no Thycotic module dependency):
   - Get-SSAuth -SecretServerUrl -AuthMethod: "windows" uses -UseDefaultCredentials on every SS call (IWA); "token" performs the OAuth2 password grant (POST <url>/oauth2/token, grant_type=password) using a -SSApiCredential PSCredential parameter and returns a Bearer header. Default -AuthMethod to "windows".
   - Get-SSSecret (GET <url>/api/v1/secrets/{id}), Get-SSSecretField (returns a named field's value from the items array by slug), Set-SSSecretField (PUT <url>/api/v1/secrets/{id}/fields/{slug}).
B. Parameters: -SecretServerUrl (mandatory), -AuthMethod, plus one mandatory -<Name>SecretId [int] per credential the procedure uses (derive <Name> from the step label or param_name). Every masked/credential value MUST be resolved from Secret Server at runtime via those IDs — never prompted, never hard-coded, never echoed to output or logs.
C. If the procedure changes a service-account password (evident from the steps or the operator context): generate the new password locally with a New-RandomPassword helper (length/complexity parameters, cryptographic RNG), perform the recorded change against the target system using it, VERIFY success, and only then write it back with Set-SSSecretField to the same secret's password field. If the write-back fails, fail loudly and explicitly state that the target system and Secret Server are now OUT OF SYNC and the new password exists only in this session — but never print the password itself.`;

const SS_RULES_NODE = `ADDITIONAL REQUIREMENT — Delinea Secret Server (on-prem) credential sourcing:
A. Include a Secret Server helper block built on Node's fetch: ssAuth(url, method) supporting "token" (OAuth2 password grant to <url>/oauth2/token with SS_API_USER/SS_API_PASSWORD env vars) — note in a comment that Windows integrated auth is not natively available from Node and "token" is the practical method here; ssGetSecret(id), ssGetField(secret, slug), ssSetField(id, slug, value) against <url>/api/v1/secrets.
B. Required env vars: SS_URL plus one <NAME>_SECRET_ID per credential (derive <NAME> from the step label or param_name). Every masked/credential value MUST resolve from Secret Server at runtime — never hard-coded, never logged.
C. If the procedure changes a service-account password: generate it locally (crypto.randomBytes-based helper), apply the recorded change, verify, then ssSetField the new value back; on write-back failure, exit loudly stating target and Secret Server are OUT OF SYNC — without printing the password.`;

const SS_RULES = { powershell: SS_RULES_PS, psweb: SS_RULES_PS, playwright: SS_RULES_NODE };

// CSV batch-mode prompt modifiers — appended when the source recording has a
// saved runs table. Only the parameter NAMES appear here; the CSV row VALUES
// never leave the machine (the generated script reads the file at run time).
const CSV_RULES_PS = `ADDITIONAL REQUIREMENT — CSV batch runs:
The operator keeps a runs table whose CSV columns are EXACTLY these run-time parameter names: <NAMES>.
Put the per-run work in one main function whose parameters use those exact names, and add an optional -CsvPath [string] script parameter: when provided, Import-Csv -Path $CsvPath | ForEach-Object { } invokes the main function once per row, splatting the row's properties onto the matching parameters (@row-style); when absent, keep the single-run parameters. Log each row's outcome with its row number and stop on the first failing row. Only the column NAMES above are known here — never invent sample values.`;

const CSV_RULES_NODE = `ADDITIONAL REQUIREMENT — CSV batch runs:
The operator keeps a runs table whose CSV columns are EXACTLY these run-time parameter names: <NAMES>.
Add a batch mode: when invoked with --csv <path>, parse the file with a small built-in RFC-4180 parser (no dependencies) and run the main flow once per row, using each row's values in place of the corresponding environment variables; log each row's outcome with its row number and stop on the first failing row. Without --csv, keep the single-run env-var behavior. Only the column NAMES above are known here — never invent sample values.`;

const CSV_RULES = { powershell: CSV_RULES_PS, psweb: CSV_RULES_PS, playwright: CSV_RULES_NODE };

// Build-only counterpart for automation targets. Text-only by design:
// anchors are the payload, never pixels.
// extras: { http: [...captured requests], secretServer: bool }
function buildAutomationRequest(steps, userContext, target, extras = {}) {
  if (!steps.length) throw new Error("No steps recorded yet.");
  let sys = AUTOMATION_PROMPTS[target];
  if (!sys) throw new Error("Unknown automation target: " + target);
  if (extras.secretServer && SS_RULES[target]) sys += "\n\n" + SS_RULES[target];
  if (extras.paramSets && CSV_RULES[target]) {
    const names = [...new Set(steps.filter(s => !s.masked).map(s => s.param).filter(Boolean))];
    if (names.length) sys += "\n\n" + CSV_RULES[target].replace("<NAMES>", names.join(", "));
  }

  const log = JSON.stringify(buildAutomationLog(steps), null, 1);
  let userText = `Convert this recorded session into ${TARGET_DOC[target]}.\n\nACTION LOG:\n${log}`;

  if (target === "psweb") {
    const http = extras.http || [];
    if (!http.length) throw new Error("No HTTP requests were captured for this recording — the HTTP-only target needs a recording made after the HTTP-capture update.");
    userText += `\n\nHTTP LOG (requests captured during the recording — ground truth to replay):\n${JSON.stringify(http, null, 1)}`;
  }

  if (userContext) userText += `\n\nOPERATOR CONTEXT:\n${userContext}`;

  return { system: sys, userText, shots: [] };
}

async function generateAutomation(src, userContext, target, extras = {}) {
  const st = await getSettings();
  requireEndpoint(st);
  const req = buildAutomationRequest(src.steps, userContext, target,
    Object.assign({ http: src.http, paramSets: src.paramSets }, extras));
  if (st.provider === "anthropic") return callAnthropic(st, req.system, req.userText, req.shots);
  return callOpenAI(st, req.system, req.userText, req.shots);
}

// ── Change-management summary from a recording diff ────────────────────────
const DIFF_PROMPT = `You are a technical writer producing a change-management summary comparing two recorded versions of the same procedure, for a regulated enterprise environment.

You will receive metadata for the OLD and NEW recordings and a JSON list of aligned diff entries computed locally from the two recordings — they are ground truth. Ops: "unchanged", "relabeled" (same control, new label), "added" (new in NEW), "removed" (gone from NEW). Entries may carry url_changed / value_changed / anchors_changed flags.

Rules:
1. Output ONLY the Markdown document. No preamble, no code fences around the whole document.
2. Structure: # Title, ## Summary (one plain-language paragraph), ## What changed (grouped: relabeled / added / removed, quoting UI labels verbatim in bold), ## Impact on operators (retraining points — conservative, evidence-based), ## Impact on automation (steps with anchors_changed — flag scripts and bots needing re-validation). Omit any section with nothing to say.
3. Do not invent, infer, or soften changes beyond the entries provided.
4. Quote element labels exactly as given.`;

// Diff entries stripped to what the model needs — never anchors or values.
function buildDiffRequest(recA, recB, entries, userContext) {
  const plain = (t) => String(t || "").replace(/\*\*/g, "");
  const payload = entries.map(e => ({
    op: e.op,
    n_old: e.a ? e.a.n : undefined,
    n_new: e.b ? e.b.n : undefined,
    text_old: e.a ? plain(e.a.text) : undefined,
    text_new: e.b ? plain(e.b.text) : undefined,
    page: (e.b || e.a).pageTitle || undefined,
    url_changed: e.urlChanged || undefined,
    value_changed: e.valueChanged || undefined,
    anchors_changed: e.anchorsChanged || undefined
  }));
  const meta = (rec) =>
    `"${rec.title}" (${new Date(rec.createdAt).toISOString().slice(0, 10)}, ${rec.steps.length} steps)`;
  let userText = `Produce a change-management summary.\n\nOLD RECORDING: ${meta(recA)}\nNEW RECORDING: ${meta(recB)}\n\nDIFF ENTRIES:\n${JSON.stringify(payload, null, 1)}`;
  if (userContext) userText += `\n\nOPERATOR CONTEXT:\n${userContext}`;
  return { system: DIFF_PROMPT, userText, shots: [] };
}

async function loadDiffPair(idA, idB) {
  const [recA, recB] = await Promise.all([PTDB.getRecording(idA), PTDB.getRecording(idB)]);
  if (!recA || !recB) throw new Error("Recording not found in library.");
  return { recA, recB, entries: PTCommon.diffSteps(recA.steps, recB.steps) };
}

async function generateDiff(idA, idB, userContext) {
  const st = await getSettings();
  requireEndpoint(st);
  const { recA, recB, entries } = await loadDiffPair(idA, idB);
  const req = buildDiffRequest(recA, recB, entries, userContext);
  if (st.provider === "anthropic") return callAnthropic(st, req.system, req.userText, req.shots);
  return callOpenAI(st, req.system, req.userText, req.shots);
}

// ── Branch-aware SOP from a trunk recording + tagged variants ───────────────
const BRANCH_PROMPT = `You are a technical writer producing ONE branch-aware Standard Operating Procedure (SOP) in Markdown that covers a base procedure (the TRUNK) and its recorded VARIANTS, for a regulated enterprise environment.

You will receive the trunk's JSON action log (real element labels — ground truth) and, for each variant, its label and a list of diff entries computed locally against the trunk. Entry ops: "unchanged", "relabeled" (same control, new label), "added" (only in the variant), "removed" (trunk step the variant skips).

Rules:
1. Output ONLY the Markdown document. No preamble, no code fences around the whole document.
2. Structure: # Title, ## Purpose, ## Scope, ## Prerequisites, ## Procedure (numbered), ## Notes (omit if nothing to add).
3. Produce ONE procedure for the whole process. Where a variant diverges, insert an explicit numbered decision point of the form "If <condition>: continue at step N" — infer the condition from the variant's label and step texts, and mark every such inference as an inference.
4. Give each branch's steps a labeled sub-sequence (e.g. 6a.1, 6a.2 for the first branch) and state explicitly where the branch rejoins the trunk.
5. Bold every UI element name exactly as given. Do not invent, rename, or "correct" element labels, and do not add steps beyond the provided entries.
6. End the document with a \`\`\`mermaid flowchart summarizing the trunk, every decision point, and every branch path.`;

// Variant payload carries op + step text only — never anchors, values, or URLs.
function buildBranchRequest(trunk, variants, userContext) {
  const plain = (t) => String(t || "").replace(/\*\*/g, "");
  const varPayload = variants.map(v => ({
    label: v.rec.variantLabel || v.rec.title,
    entries: v.entries.map(e => ({
      op: e.op,
      n_trunk: e.a ? e.a.n : undefined,
      n_variant: e.b ? e.b.n : undefined,
      text: plain((e.b || e.a).text),
      text_trunk: e.op === "relabeled" ? plain(e.a.text) : undefined,
      text_variant: e.op === "relabeled" ? plain(e.b.text) : undefined
    }))
  }));
  let userText = `Create ONE branch-aware SOP for this procedure and its variants.\n\n` +
    `TRUNK "${trunk.title}" ACTION LOG:\n${JSON.stringify(buildActionLog(trunk.steps), null, 1)}\n\n` +
    `VARIANTS (diff entries vs the trunk, computed locally):\n${JSON.stringify(varPayload, null, 1)}`;
  if (userContext) userText += `\n\nOPERATOR CONTEXT:\n${userContext}`;
  return { system: BRANCH_PROMPT, userText, shots: [] };
}

async function loadBranchSet(trunkId) {
  const trunk = await PTDB.getRecording(trunkId);
  if (!trunk) throw new Error("Recording not found in library.");
  const metas = await PTDB.listRecordings();
  const variants = [];
  for (const m of metas.filter(x => x.variantOf === trunkId)) {
    const rec = await PTDB.getRecording(m.id);
    if (rec) variants.push({ rec, entries: PTCommon.diffSteps(trunk.steps, rec.steps) });
  }
  if (!variants.length) throw new Error("No variants are tagged on this recording.");
  return { trunk, variants };
}

async function generateBranch(trunkId, userContext) {
  const st = await getSettings();
  requireEndpoint(st);
  const { trunk, variants } = await loadBranchSet(trunkId);
  const req = buildBranchRequest(trunk, variants, userContext);
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

async function buildAudit(target, userContext, recordingId, recordingIdB, extras = {}) {
  const st = await getSettings();
  let steps, req;
  if (target === "diff") {
    const { recA, recB, entries } = await loadDiffPair(recordingId, recordingIdB);
    steps = []; // the diff payload carries step text only — no anchors, values, or shots
    req = buildDiffRequest(recA, recB, entries, userContext);
  } else if (target === "branch") {
    const { trunk, variants } = await loadBranchSet(recordingId);
    steps = trunk.steps; // trunk action log is sent; variant entries are text-only
    req = buildBranchRequest(trunk, variants, userContext);
  } else {
    const src = await resolveSource(recordingId);
    steps = src.steps;
    req = target === "sop"
      ? await buildSopRequest(steps, userContext, st)
      : buildAutomationRequest(steps, userContext, target,
          Object.assign({ http: src.http, paramSets: src.paramSets }, extras));
  }
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
    secretServer: !!extras.secretServer,
    includeScreenshots: !!st.includeScreenshots,
    stepCount: stats.stepCount,
    shotsCaptured: stats.shotSteps,             // step numbers that have a local screenshot
    shotsAttached: req.shots.map(s => s.n),     // step numbers whose pixels would be sent
    maskedSteps: stats.maskedSteps,             // masked values: label only, value never captured
    narratedSteps: stats.narratedSteps,         // step numbers whose spoken-narration transcript is sent
    captionedSteps: stats.captionedSteps,       // desktop frames captioned at capture — caption text sent, pixels stay local
    paramSteps: stats.paramSteps,               // operator-marked run-time parameters
    system: req.system,
    userText: req.userText,
    body                                        // exact request body, images redacted, no credentials
  };
}

// Keep badge accurate across worker restarts; re-assert the sentinel alarm
// (idempotent) so watches survive browser and extension restarts.
chrome.runtime.onStartup?.addListener(async () => { await hydrate(); setBadge(session.recording); });
hydrate().then(() => setBadge(session.recording));
ensureSentinelAlarm().catch(() => {});
