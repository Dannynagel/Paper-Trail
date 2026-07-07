// Paper Trail — side panel

const $ = (id) => document.getElementById(id);
let currentSession = { recording: false, steps: [] };
let currentMarkdown = "";
let activeRecording = null;    // saved recording used as the generation source (null = live session)
let spliceMap = new Map();     // step number -> screenshot data URL, snapshotted at generation time
const objUrlCache = new Map(); // step id -> object URL for live-session screenshots in IndexedDB

function revokeObjUrls() {
  for (const u of objUrlCache.values()) URL.revokeObjectURL(u);
  objUrlCache.clear();
}

// Fill in <img data-shot-id> placeholders from IndexedDB (live-session shots).
async function hydrateShots(root) {
  for (const img of root.querySelectorAll("img[data-shot-id]")) {
    const id = img.dataset.shotId;
    let u = objUrlCache.get(id);
    if (!u) {
      const rec = await PTDB.getShot(id).catch(() => null);
      if (!rec || !rec.blob) { img.remove(); continue; }
      u = URL.createObjectURL(rec.blob);
      objUrlCache.set(id, u);
    }
    img.src = u;
  }
}

// ── Messaging helpers ──────────────────────────────────────────────────────
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

async function refresh() {
  const resp = await send({ cmd: "getState" });
  if (!resp) return;
  currentSession = resp.session;
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.evt === "sessionChanged") refresh();
});

// ── Rendering ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ts, startedAt) {
  if (!startedAt) return "";
  const d = Math.max(0, Math.round((ts - startedAt) / 1000));
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
}

function actionHtml(text) {
  // step.text uses **bold** for element labels
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function render() {
  const s = currentSession;

  // Controls
  const rec = $("btnRecord");
  rec.textContent = s.recording ? "■ Stop recording" : "● Start recording";
  rec.classList.toggle("recording", s.recording);
  $("scanline").hidden = !s.recording;
  $("btnSave").disabled = s.recording || !s.steps.length;

  const st = $("status");
  st.className = "status" + (s.recording ? " rec" : "");
  st.textContent = s.recording
    ? `REC — ${s.steps.length} step${s.steps.length === 1 ? "" : "s"} captured`
    : s.steps.length
      ? `Stopped — ${s.steps.length} steps ready`
      : "Idle — nothing recorded";

  // Ledger
  const wrap = $("steps");
  if (!s.steps.length) {
    revokeObjUrls();
    wrap.innerHTML = `<div class="empty">Start recording, then perform the procedure in any tab.<br>
      Every click, field, and page change is captured with its real label.<br>
      <span style="font-family:var(--mono);font-size:10px">Alt+Shift+S start/stop · Alt+Shift+C manual capture</span></div>`;
    return;
  }

  wrap.innerHTML = s.steps.map(step => `
    <div class="step" data-id="${step.id}">
      <div class="rail"><span class="n">${step.n}</span>${fmtTime(step.ts, s.startedAt)}</div>
      <div class="body">
        <div class="action">${actionHtml(step.text)}</div>
        <div class="page" title="${esc(step.url)}">${esc(step.pageTitle || step.url)}</div>
        ${step.masked ? `<div class="masked">value masked</div>` : ""}
        ${step.shot ? `<img src="${step.shot}" alt="Step ${step.n} screenshot" loading="lazy">` :
          step.hasShot ? `<img data-shot-id="${step.id}" alt="Step ${step.n} screenshot" loading="lazy">` :
          (step.shotDropped ? `<div class="masked">screenshot removed</div>` : "")}
        <textarea class="note" placeholder="Add note for the writer…" data-id="${step.id}">${esc(step.note)}</textarea>
      </div>
      <div class="tools">
        ${(step.shot || step.hasShot) ? `<button data-act="dropShot" data-id="${step.id}" title="Remove screenshot">🖼✕</button>` : ""}
        <button data-act="delete" data-id="${step.id}" title="Delete step">✕</button>
      </div>
    </div>`).join("");
  hydrateShots(wrap);
}

// ── Event wiring ───────────────────────────────────────────────────────────
$("btnRecord").addEventListener("click", async () => {
  await send({ cmd: currentSession.recording ? "stop" : "start" });
  refresh();
});

$("btnCapture").addEventListener("click", async () => {
  await send({ cmd: "manualCapture" });
  refresh();
});

$("btnClear").addEventListener("click", async () => {
  if (!currentSession.steps.length || confirm("Discard all recorded steps?")) {
    await send({ cmd: "clear" });
    $("result").hidden = true;
    currentMarkdown = "";
    refresh();
  }
});

$("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── Tabs (Recorder / Library) ──────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".tabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  $("tab-recorder").hidden = tab !== "recorder";
  $("tab-library").hidden = tab !== "library";
  if (tab === "library" && typeof renderLibrary === "function") renderLibrary();
}
document.querySelectorAll(".tabs button").forEach(btn =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// ── Save session to library (archives: session moves out of the recorder) ──
$("btnSave").addEventListener("click", async () => {
  const steps = currentSession.steps;
  if (!steps.length || currentSession.recording) return;
  const first = steps.find(s => s.pageTitle);
  const def = `${(first && first.pageTitle) || "Recording"} — ${new Date().toLocaleDateString()}`;
  const title = prompt("Save recording to library as:\n(The recorder ledger is cleared after saving.)", def);
  if (title === null) return;

  const recId = crypto.randomUUID();
  const rec = {
    id: recId,
    title: title.trim() || def,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stepCount: steps.length,
    urlHosts: [...new Set(steps.map(s => PTCommon.urlHost(s.url)).filter(Boolean))].slice(0, 5),
    source: steps.every(s => s.type === "uia" || s.type === "desktop") ? "desktop"
          : steps.some(s => s.type === "uia" || s.type === "desktop") ? "mixed" : "web",
    steps: steps.map(s => {
      const copy = Object.assign({}, s, { shot: null, hasShot: !!(s.shot || s.hasShot) });
      return copy;
    })
  };

  // Persist shots: inline data URLs become Blobs; IDB-resident live shots are
  // reassigned to the new recording without copying bytes.
  for (const s of steps) {
    if (s.shot) {
      const blob = await (await fetch(s.shot)).blob();
      await PTDB.putShot({ stepId: s.id, recId, blob });
    }
  }
  await PTDB.reassignShots(PTDB.LIVE_REC_ID, recId);
  await PTDB.saveRecording(rec);

  await send({ cmd: "clear" });
  refresh();
  switchTab("library");
  const ls = $("libStatus");
  ls.textContent = `Saved ✓ — “${rec.title}”`;
  setTimeout(() => { ls.textContent = "Library — saved recordings live in this browser profile only."; }, 3000);
});

// ── Generation source (live session vs a saved recording) ─────────────────
function setGenSource(rec) {
  activeRecording = rec;
  const el = $("genSource");
  if (rec) {
    el.hidden = false;
    el.innerHTML = `SOURCE ► ${esc(rec.title)} (${rec.steps.length} steps) ` +
      `<button id="btnGenSourceClear" class="ghost" style="padding:1px 6px;font-size:10px">✕ back to live</button>`;
    $("btnGenSourceClear").addEventListener("click", () => setGenSource(null));
  } else {
    el.hidden = true;
    el.innerHTML = "";
  }
}

// ── Window-capture mode (desktop apps, vision-based) ───────────────────────
// getDisplayMedia lets the user pick ANY window. We sample the stream at
// ~1.4 fps into a tiny grayscale buffer; when the screen changes and then
// settles, we capture a full frame as a step. Ctrl+Shift+9 (global) forces
// a capture even while the desktop app has focus.
let deskStream = null, deskVideo = null, deskTimer = null, deskLabel = "";
let sctx = null, SW = 96, SH = 54;
let lastSample = null, pendingChange = false, lastCapTs = 0;
const CHANGE_RATIO = 0.045, SETTLE_RATIO = 0.012, CAP_COOLDOWN = 1500;

async function startDesktopCapture() {
  try {
    deskStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 }, audio: false
    });
  } catch (e) { return; } // user cancelled picker

  const track = deskStream.getVideoTracks()[0];
  deskLabel = (track.label || "Desktop window").replace(/^window:|^screen:/i, "").trim();
  track.addEventListener("ended", stopDesktopCapture);

  deskVideo = document.createElement("video");
  deskVideo.srcObject = deskStream;
  deskVideo.muted = true;
  await deskVideo.play();

  const ar = (deskVideo.videoHeight / deskVideo.videoWidth) || 0.5625;
  SH = Math.max(24, Math.round(SW * ar));
  const c = document.createElement("canvas");
  c.width = SW; c.height = SH;
  sctx = c.getContext("2d", { willReadFrequently: true });
  lastSample = null; pendingChange = false; lastCapTs = 0;

  if (!currentSession.recording) await send({ cmd: "start" });
  deskTimer = setInterval(sampleFrame, 700);
  // First frame: establish opening state
  setTimeout(() => captureDesktopFrame(true), 800);
  renderDesktopStatus();
  refresh();
}

function stopDesktopCapture() {
  if (deskTimer) clearInterval(deskTimer);
  deskTimer = null;
  if (deskStream) deskStream.getTracks().forEach(t => t.stop());
  deskStream = null; deskVideo = null; lastSample = null;
  renderDesktopStatus();
}

function graySample() {
  sctx.drawImage(deskVideo, 0, 0, SW, SH);
  const d = sctx.getImageData(0, 0, SW, SH).data;
  const g = new Uint8Array(SW * SH);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] + d[i + 1] + d[i + 2]) / 3 | 0;
  return g;
}

function diffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 28) c++;
  return c / a.length;
}

function sampleFrame() {
  if (!deskVideo || deskVideo.readyState < 2) return;
  const cur = graySample();
  const diff = diffRatio(cur, lastSample);
  const prev = lastSample;
  lastSample = cur;
  if (!prev) return;

  if (pendingChange) {
    // Wait for the screen to settle so we don't capture mid-transition
    if (diff < SETTLE_RATIO) {
      pendingChange = false;
      if (Date.now() - lastCapTs > CAP_COOLDOWN) captureDesktopFrame(false);
    }
  } else if (diff > CHANGE_RATIO) {
    pendingChange = true;
  }
}

async function captureDesktopFrame(manual) {
  if (!deskVideo || deskVideo.readyState < 2) return;
  lastCapTs = Date.now();
  const vw = deskVideo.videoWidth || 1200;
  const w = Math.min(1200, vw);
  const h = Math.round(w * ((deskVideo.videoHeight || 675) / vw));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(deskVideo, 0, 0, w, h);
  const shot = c.toDataURL("image/jpeg", 0.72);
  await send({ cmd: "addDesktopStep", shot, label: deskLabel, manual: !!manual });
  refresh();
}

function renderDesktopStatus() {
  const el = $("deskStatus");
  const btn = $("btnDesktop");
  if (deskStream) {
    el.hidden = false;
    el.textContent = `WINDOW ► ${deskLabel} — auto-captures on change · Ctrl+Shift+9 manual`;
    btn.textContent = "🖥 Stop window capture";
    btn.classList.add("active-rec");
  } else {
    el.hidden = nativeOn ? false : true;
    if (nativeOn) el.textContent = "UIA ► semantic desktop capture active";
    btn.textContent = "🖥 Record a window";
    btn.classList.remove("active-rec");
  }
}

$("btnDesktop").addEventListener("click", () =>
  deskStream ? stopDesktopCapture() : startDesktopCapture());

// ── UIA companion toggle (semantic desktop capture) ────────────────────────
let nativeOn = false;

$("btnNative").addEventListener("click", async () => {
  if (nativeOn) {
    await send({ cmd: "nativeDisconnect" });
    setNativeUI(false, "");
    return;
  }
  const resp = await send({ cmd: "nativeConnect" });
  if (!resp || !resp.ok) setNativeUI(false, "Companion not installed — see native-host/README");
  // success is confirmed by the host's hello → nativeState event
});

function setNativeUI(connected, error) {
  nativeOn = connected;
  const btn = $("btnNative");
  btn.classList.toggle("active", connected);
  btn.textContent = connected ? "⚡ UIA connected" : "⚡ UIA companion";
  if (error) {
    const gs = $("genStatus");
    gs.hidden = false; gs.className = "status err";
    gs.textContent = error;
    setTimeout(() => { gs.hidden = true; }, 5000);
  }
  renderDesktopStatus();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.evt === "desktopFrameRequest" && deskStream) captureDesktopFrame(true);
  if (msg.evt === "nativeState") {
    setNativeUI(msg.connected, msg.connected ? "" :
      (msg.error ? "UIA companion: " + msg.error : ""));
    if (msg.connected && !currentSession.recording) send({ cmd: "start" }).then(refresh);
  }
});

send({ cmd: "nativeStatus" }).then(r => { if (r && r.connected) setNativeUI(true, ""); });

$("steps").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    await send({ cmd: btn.dataset.act === "delete" ? "deleteStep" : "dropShot", id: btn.dataset.id });
    refresh();
    return;
  }
  const img = e.target.closest("img");
  if (img) {
    const w = window.open("");
    if (w) w.document.write(`<img src="${img.src}" style="max-width:100%">`);
  }
});

$("steps").addEventListener("change", async (e) => {
  const ta = e.target.closest("textarea.note");
  if (ta) await send({ cmd: "updateNote", id: ta.dataset.id, note: ta.value });
});

// ── Generation ─────────────────────────────────────────────────────────────
let currentTarget = "sop";

$("genTarget").addEventListener("change", () => {
  const t = $("genTarget").value;
  $("btnGenerate").textContent =
    t === "sop" ? "Generate SOP" :
    t === "powershell" ? "Generate PowerShell script" : "Generate AA build sheet";
});

$("btnGenerate").addEventListener("click", async () => {
  const btn = $("btnGenerate");
  const gs = $("genStatus");
  btn.disabled = true;
  gs.hidden = false; gs.className = "status"; gs.textContent = "Generating…";

  const target = $("genTarget").value;
  const resp = await send({
    cmd: "generate",
    context: $("context").value.trim(),
    target,
    recordingId: activeRecording ? activeRecording.id : undefined
  });
  btn.disabled = false;

  if (!resp || !resp.ok) {
    gs.className = "status err";
    gs.textContent = "Failed: " + (resp ? resp.error : "no response");
    return;
  }
  gs.hidden = true;
  currentTarget = target;
  currentMarkdown = resp.markdown.trim()
    // Belt-and-braces: strip a whole-document code fence if the model added one
    .replace(/^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i, "$1");
  await prepareSplice();
  showResult();
});

// Snapshot the screenshots for {{screenshot_N}} splicing — from the active
// recording (IndexedDB Blobs) or the live session (inline or IDB).
async function prepareSplice() {
  spliceMap = new Map();
  const steps = activeRecording ? activeRecording.steps : currentSession.steps;
  for (const s of steps) {
    if (s.shot) {
      spliceMap.set(s.n, s.shot);
    } else if (s.hasShot) {
      const rec = await PTDB.getShot(s.id);
      if (rec && rec.blob) spliceMap.set(s.n, await PTCommon.blobToDataUrl(rec.blob));
    }
  }
}

function spliceImages(md) {
  return md.replace(/\{\{screenshot_(\d+)\}\}/g, (m, n) => {
    const src = spliceMap.get(Number(n));
    return src ? `![Step ${n}](${src})` : "";
  });
}

function showResult() {
  $("result").hidden = false;
  $("editor").hidden = true;
  $("preview").hidden = false;
  const isScript = currentTarget === "powershell";
  const isAudit = currentTarget === "audit";
  $("result").querySelector(".result-bar span").textContent =
    isScript ? "PowerShell draft" :
    currentTarget === "aa" ? "AA build sheet" :
    isAudit ? "Privacy audit" : "Draft";
  $("btnDlPs1").hidden = !isScript;
  $("btnDlJson").hidden = !isAudit;
  $("btnDlMd").hidden = isScript;
  $("btnDlHtml").hidden = isScript;
  $("preview").innerHTML = isScript
    ? `<pre style="white-space:pre-wrap;font:11.5px/1.5 var(--mono);margin:0">${esc(currentMarkdown)}</pre>`
    : mdToHtml(spliceImages(currentMarkdown));
  $("result").scrollIntoView({ behavior: "smooth" });
}

// ── Privacy audit — the exact payload, built locally, never sent ───────────
let lastAudit = null;

async function startAudit(recordingId) {
  const gs = $("genStatus");
  gs.hidden = false; gs.className = "status"; gs.textContent = "Building audit locally…";
  const resp = await send({
    cmd: "auditPayload",
    target: $("genTarget").value,
    context: $("context").value.trim(),
    recordingId
  });
  if (!resp || !resp.ok) {
    gs.className = "status err";
    gs.textContent = "Audit failed: " + (resp ? resp.error : "no response");
    return;
  }
  gs.hidden = true;
  lastAudit = resp.audit;
  currentTarget = "audit";
  currentMarkdown = auditMarkdown(resp.audit);
  spliceMap = new Map(); // the audit never embeds pixels
  showResult();
}

function auditMarkdown(a) {
  const localOnly = a.shotsCaptured.filter(n => !a.shotsAttached.includes(n));
  const masked = a.maskedSteps.length
    ? a.maskedSteps.map(m => `- Step ${m.n}: **${m.label}** — value never captured; the log says only that a value was entered`).join("\n")
    : "- None recorded";
  const attached = a.shotsAttached.length
    ? `${a.shotsAttached.length} would be attached to the request (steps ${a.shotsAttached.join(", ")})`
    : "none would be attached to the request";
  const targetName = a.target === "sop" ? "SOP document" :
    a.target === "powershell" ? "PowerShell automation" : "Automation Anywhere build sheet";

  return `# Privacy Audit — what leaves this machine

Built locally on ${new Date(a.generatedAt).toLocaleString()}. Producing this audit sent nothing anywhere.

## Destination

- Output type: ${targetName}
- Provider: ${a.provider}
- Model: ${a.model}
- Endpoint: ${a.endpoint}

## Screenshots

- ${a.shotsCaptured.length} screenshot(s) exist locally for this recording; ${attached}
- ${localOnly.length} stay on this machine and are spliced into exports locally
- "Attach screenshots" setting: ${a.includeScreenshots ? "ON — browser screenshots are sent" : "OFF — only text leaves this machine (desktop-capture frames excepted)"}

## Masked values

${masked}

## Credentials

- The API key travels only as a request header to the endpoint above; it is not part of the body and is excluded from this audit.

## System prompt (sent verbatim)

\`\`\`
${a.system}
\`\`\`

## User message (sent verbatim)

\`\`\`
${a.userText}
\`\`\`

## Exact request body (images redacted)

\`\`\`json
${JSON.stringify(a.body, null, 2)}
\`\`\`
`;
}

$("btnAudit").addEventListener("click", () =>
  startAudit(activeRecording ? activeRecording.id : undefined));

$("btnDlJson").addEventListener("click", () => {
  if (lastAudit) download("Privacy_Audit.json", JSON.stringify(lastAudit, null, 2), "application/json");
});

$("btnEdit").addEventListener("click", () => {
  const ed = $("editor"), pv = $("preview");
  if (ed.hidden) {
    ed.value = currentMarkdown;
    ed.hidden = false; pv.hidden = true;
    $("btnEdit").textContent = "Preview";
  } else {
    currentMarkdown = ed.value;
    ed.hidden = true; pv.hidden = false;
    pv.innerHTML = currentTarget === "powershell"
      ? `<pre style="white-space:pre-wrap;font:11.5px/1.5 var(--mono);margin:0">${esc(currentMarkdown)}</pre>`
      : mdToHtml(spliceImages(currentMarkdown));
    $("btnEdit").textContent = "Edit";
  }
});

$("btnCopy").addEventListener("click", async () => {
  const text = currentTarget === "powershell" ? currentMarkdown : spliceImages(currentMarkdown);
  await navigator.clipboard.writeText(text);
  $("btnCopy").textContent = "Copied ✓";
  setTimeout(() => $("btnCopy").textContent = "Copy", 1400);
});

$("btnDlPs1").addEventListener("click", () =>
  download(`${sopTitle()}.ps1`, currentMarkdown, "text/plain"));

function download(name, content, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sopTitle() {
  const m = currentMarkdown.match(/^#\s+(.+)$/m);
  const fallback = currentTarget === "powershell" ? "Automation_Script" : "SOP";
  return (m ? m[1] : fallback).replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || fallback;
}

$("btnDlMd").addEventListener("click", () =>
  download(`${sopTitle()}.md`, spliceImages(currentMarkdown), "text/markdown"));

$("btnDlHtml").addEventListener("click", () => {
  const body = mdToHtml(spliceImages(currentMarkdown));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(sopTitle())}</title>
<style>
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:820px;margin:32px auto;padding:0 24px;color:#1C2128}
h1{font-size:26px;border-bottom:2px solid #1B4F72;padding-bottom:8px}
h2{font-size:18px;color:#1B4F72;margin-top:26px}
img{max-width:100%;border:1px solid #D8D8D2;border-radius:6px;margin:8px 0}
li{margin:5px 0} code{background:#F0F0EA;padding:1px 5px;border-radius:3px}
@media print{body{margin:8mm auto}img{page-break-inside:avoid}}
</style></head><body>${body}</body></html>`;
  download(`${sopTitle()}.html`, html, "text/html");
});

// ── Minimal Markdown renderer (headings, lists, bold/italic, img, code) ────
function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  let html = "", inOl = false, inUl = false, inCode = false;

  const closeLists = () => {
    if (inOl) { html += "</ol>"; inOl = false; }
    if (inUl) { html += "</ul>"; inUl = false; }
  };
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) { inCode = !inCode; html += inCode ? "<pre><code>" : "</code></pre>"; continue; }
    if (inCode) { html += esc(line) + "\n"; continue; }

    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      closeLists();
      const h = m[1].length;
      html += `<h${h}>${inline(m[2])}</h${h}>`;
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)/))) {
      if (!inOl) { closeLists(); html += "<ol>"; inOl = true; }
      html += `<li>${inline(m[2])}</li>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (!inUl) { closeLists(); html += "<ul>"; inUl = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (/^\s*$/.test(line)) {
      closeLists();
    } else if (/^!\[/.test(line.trim())) {
      closeLists();
      html += `<p>${inline(line.trim())}</p>`;
    } else {
      closeLists();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeLists();
  if (inCode) html += "</code></pre>";
  return html;
}

// ── Init ───────────────────────────────────────────────────────────────────
refresh();
