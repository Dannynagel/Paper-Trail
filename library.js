// Paper Trail — Library tab: saved recordings (list, open, re-generate).
// Loaded after sidepanel.js; shares its globals ($, send, esc, setGenSource…).
// Later features hook in via optional globals checked at render time:
// startVerify(id), startWalkthrough(id), startAudit(id).

let libObjUrls = [];
let libCompareA = null; // first pick of a pending ⇄ Compare

function libRevokeUrls() {
  for (const u of libObjUrls) URL.revokeObjectURL(u);
  libObjUrls = [];
}

function libDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function renderLibrary() {
  const wrap = $("libList");
  send({ cmd: "libraryOpened" }); // clears the sentinel "!" badge
  const list = await PTDB.listRecordings();
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">No saved recordings yet.<br>
      Record a procedure, then press <b>💾 Save</b> in the Recorder tab.</div>`;
    $("libDetail").hidden = true;
    return;
  }
  const canVerify = typeof startVerify === "function";
  const canWalk = typeof startWalkthrough === "function";
  const canAudit = typeof startAudit === "function";
  const canCompare = typeof startCompare === "function" && list.length > 1;
  const canRun = typeof startAutopilot === "function";

  wrap.innerHTML = list.map(r => `
    <div class="step lib-row" data-id="${r.id}">
      <div class="rail"><span class="n">${r.stepCount}</span>steps</div>
      <div class="body">
        <div class="action"><b>${esc(r.title)}</b></div>
        <div class="page">${esc(libDate(r.createdAt))}${r.lastVerified
          ? ` · verified ${esc(libDate(r.lastVerified.ts))} — ${esc(r.lastVerified.summary)}` : ""}</div>
        <div class="page">${(r.urlHosts || []).map(esc).join(" · ") || esc(r.source || "")}${
          r.httpCount ? ` · ${r.httpCount} HTTP` : ""}</div>
        <div class="lib-actions">
          <button data-act="open">Open</button>
          ${canRun ? `<button data-act="run" title="Autopilot: perform the recorded steps in the browser">⚡ Run</button>` : ""}
          ${canWalk ? `<button data-act="walk" title="Guided walkthrough on the live site">▶ Walk</button>` : ""}
          ${canVerify ? `<button data-act="verify" title="Check anchors against the live site">✓ Verify</button>` : ""}
          <button data-act="regen" title="Generate from this recording">Re-gen</button>
          ${canCompare ? `<button data-act="compare" title="Diff against another recording">⇄ Compare</button>` : ""}
          <button data-act="watch" title="${r.watch
            ? "Drift sentinel is watching this SOP — click to stop"
            : "Watch for drift: re-verify anchors every 24 h and alert on new problems"}"${
            r.watch ? ` class="active"` : ""}>⏰${r.watch ? " on" : ""}</button>
          ${canAudit ? `<button data-act="audit" title="Preview exactly what would be sent to the model">Audit</button>` : ""}
          <button data-act="rename">Rename</button>
          <button data-act="del" class="danger" title="Delete recording">✕</button>
        </div>
      </div>
    </div>`).join("");
}

async function openRecording(id) {
  const rec = await PTDB.getRecording(id);
  if (!rec) return;
  libRevokeUrls();
  const runs = await PTDB.listRunsByRec(id);
  const shots = await PTDB.getShotsByRec(id);
  const srcByStep = new Map(shots.map(s => {
    const u = URL.createObjectURL(s.blob);
    libObjUrls.push(u);
    return [s.stepId, u];
  }));

  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>${esc(rec.title)}</span>
      <div class="result-actions"><button id="libDetailClose" class="ghost">Close</button></div>
    </div>
    <section class="steps lib-steps">
      ${rec.steps.map(step => `
        <div class="step" data-step-id="${step.id}">
          <div class="rail"><span class="n">${step.n}</span></div>
          <div class="body">
            <div class="action">${actionHtml(step.text)}</div>
            <div class="page" title="${esc(step.url)}">${esc(step.pageTitle || step.url)}</div>
            ${step.masked ? `<div class="masked">value masked</div>` : ""}
            ${step.param ? `<div class="param-chip">param: &lt;${esc(step.param)}&gt;</div>` : ""}
            ${step.note ? `<div class="page">📝 ${esc(step.note)}</div>` : ""}
            ${step.caption ? `<div class="caption">🖼→📝 <em>${esc(step.caption)}</em></div>` : ""}
            ${step.narration ? `<div class="narration">🎙 <em>${esc(step.narration)}</em></div>` : ""}
            ${srcByStep.has(step.id)
              ? `<img src="${srcByStep.get(step.id)}" alt="Step ${step.n} screenshot" loading="lazy">` : ""}
          </div>
          <div class="tools">
            ${(step.type === "input" || step.type === "select")
              ? `<button data-libact="param" data-id="${step.id}" title="Mark as run-time parameter">⚙</button>` : ""}
          </div>
        </div>`).join("")}
    </section>
    ${csvParamNames(rec).length ? csvSectionHtml(rec) : ""}
    ${runs.length ? `
      <div class="result-bar"><span>Runs (${runs.length}) — evidence stays local</span></div>
      <section class="steps lib-steps">
        ${runs.map(r => `
          <div class="step">
            <div class="rail"><span class="n">${r.steps.length}</span>steps</div>
            <div class="body">
              <div class="action">${esc(libDate(r.startedAt))} · ${esc(r.mode)}</div>
              <div class="page">${esc(PTCommon.summarizeRun(r.steps))}</div>
              <div class="lib-actions"><button data-runid="${r.id}">Open report</button></div>
            </div>
          </div>`).join("")}
      </section>` : ""}`;
  detail.querySelectorAll("button[data-runid]").forEach(btn =>
    btn.addEventListener("click", () => openRun(btn.dataset.runid)));
  if (csvParamNames(rec).length) wireCsvSection(rec);
  detail.querySelectorAll("button[data-libact='param']").forEach(btn =>
    btn.addEventListener("click", async () => {
      const fresh = await PTDB.getRecording(rec.id);
      if (!fresh) return;
      const step = fresh.steps.find(s => s.id === btn.dataset.id);
      if (!step) return;
      const name = askParamName(step);
      if (name === undefined) return;
      if (name) step.param = name; else delete step.param;
      fresh.updatedAt = Date.now();
      await PTDB.saveRecording(fresh);
      openRecording(rec.id); // re-render with the new chip
    }));
  $("libDetailClose").addEventListener("click", () => {
    detail.hidden = true;
    detail.innerHTML = "";
    libRevokeUrls();
  });
  detail.scrollIntoView({ behavior: "smooth" });
}

// ── Runs table (CSV → rec.paramSets) — values stay local, never sent ───────
// Columns are the recording's run-time parameter names (masked-step params
// excluded: those values are typed by a human on every run).
function csvParamNames(rec) {
  return [...new Set(rec.steps.filter(s => !s.masked).map(s => s.param).filter(Boolean))];
}

function csvSectionHtml(rec) {
  const names = csvParamNames(rec);
  const saved = (rec.paramSets || []).length;
  const canBatch = typeof startAutopilotBatch === "function" && saved;
  return `
    <div class="result-bar"><span>Runs table — ${saved ? `${saved} row(s) saved` : "no rows yet"}</span></div>
    <div class="lib-actions" style="display:block;padding:8px">
      <div class="page">Paste CSV with EXACTLY these columns: <b>${names.map(esc).join(", ")}</b>.
        Values stay in this browser — only the column names ever reach a model.</div>
      <textarea id="csvText" rows="4" style="width:100%;margin:6px 0"
        placeholder="${esc(names.join(","))}&#10;first run's values…"></textarea>
      <div class="lib-actions">
        <button id="csvSave">Save rows</button>
        <button id="csvTemplate" class="ghost" title="CSV with the right header row">Download CSV template</button>
        ${canBatch ? `<button id="csvRunAll" class="primary" title="One autopilot run + evidence record per row, stop on failure">⚡ Run all rows</button>` : ""}
        ${saved ? `<button id="csvClear" class="ghost danger">Clear rows</button>` : ""}
      </div>
      <div id="csvStatus" class="status" hidden></div>
    </div>`;
}

function wireCsvSection(rec) {
  const names = csvParamNames(rec);
  const status = (msg, err) => {
    const el = $("csvStatus");
    el.hidden = false;
    el.className = "status" + (err ? " err" : "");
    el.textContent = msg;
  };

  $("csvTemplate").addEventListener("click", () =>
    download(`${rec.title.replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 40) || "recording"}_runs.csv`,
      names.join(",") + "\r\n", "text/csv"));

  $("csvSave").addEventListener("click", async () => {
    const { headers, rows } = PTCommon.parseCsv($("csvText").value);
    if (!rows.length) { status("No data rows found under the header.", true); return; }
    const missing = names.filter(n => !headers.includes(n));
    const extra = headers.filter(h => !names.includes(h));
    if (missing.length || extra.length) {
      status(`Header mismatch — ${missing.length ? "missing: " + missing.join(", ") : ""}` +
        `${missing.length && extra.length ? "; " : ""}${extra.length ? "unexpected: " + extra.join(", ") : ""}`, true);
      return;
    }
    const bad = rows.findIndex(r => r.length !== headers.length);
    if (bad !== -1) {
      status(`Row ${bad + 1} has ${rows[bad].length} field(s), expected ${headers.length}.`, true);
      return;
    }
    const paramSets = rows.map((r, i) => {
      const values = {};
      headers.forEach((h, col) => values[h] = r[col]);
      return { name: `Row ${i + 1}`, values };
    });
    const fresh = await PTDB.getRecording(rec.id);
    if (!fresh) return;
    fresh.paramSets = paramSets;
    fresh.updatedAt = Date.now();
    await PTDB.saveRecording(fresh);
    openRecording(rec.id);
  });

  const clear = document.getElementById("csvClear");
  if (clear) clear.addEventListener("click", async () => {
    const fresh = await PTDB.getRecording(rec.id);
    if (!fresh) return;
    delete fresh.paramSets;
    fresh.updatedAt = Date.now();
    await PTDB.saveRecording(fresh);
    openRecording(rec.id);
  });

  const runAll = document.getElementById("csvRunAll");
  if (runAll) runAll.addEventListener("click", () => startAutopilotBatch(rec.id));
}

// ── Evidence run report (all local; export splices screenshots as data URLs) ─
const RUN_DOT = {
  done: "ver-found", confirmed: "ver-found", manual: "ver-fallback",
  skipped: "ver-na", failed: "ver-missing"
};

async function openRun(runId) {
  const run = await PTDB.getRun(runId);
  if (!run) return;
  libRevokeUrls();
  const shots = await PTDB.getShotsByRec("run:" + runId);
  const srcByKey = new Map(shots.map(s => {
    const u = URL.createObjectURL(s.blob);
    libObjUrls.push(u);
    return [s.stepId, u];
  }));

  const params = Object.entries(run.params || {});
  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Evidence — ${esc(run.recTitle)} · ${esc(libDate(run.startedAt))}</span>
      <div class="result-actions">
        <button id="runDlMd" class="ghost">⬇ .md</button>
        <button id="runDlHtml" class="ghost">⬇ .html</button>
        <button id="runBack" class="ghost">Back</button>
      </div>
    </div>
    <div class="status">${esc(run.mode)} · ${esc(PTCommon.summarizeRun(run.steps))}${
      params.length ? " · " + esc(params.map(([k, v]) => `${k}=${v}`).join(", ")) : ""}</div>
    <section class="steps lib-steps">
      ${run.steps.map(s => `
        <div class="step">
          <div class="rail"><span class="n">${s.n}</span></div>
          <div class="body">
            <div class="action">${actionHtml(s.text)}</div>
            <div class="page"><span class="ver-dot ${RUN_DOT[s.status] || "ver-na"}"></span>${esc(s.status)}
              · ${esc(new Date(s.ts).toLocaleTimeString())}</div>
            ${srcByKey.has(run.id + ":" + s.n)
              ? `<img src="${srcByKey.get(run.id + ":" + s.n)}" alt="Step ${s.n} evidence" loading="lazy">` : ""}
          </div>
        </div>`).join("")}
    </section>`;
  $("runBack").addEventListener("click", () => openRecording(run.recId));
  $("runDlMd").addEventListener("click", async () =>
    download(`Evidence_${runFileStem(run)}.md`, await runReportMarkdown(run), "text/markdown"));
  $("runDlHtml").addEventListener("click", async () => {
    const body = mdToHtml(await runReportMarkdown(run));
    download(`Evidence_${runFileStem(run)}.html`,
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Evidence — ${esc(run.recTitle)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 24px}
img{max-width:100%;border:1px solid #ccc;border-radius:6px;margin:8px 0}</style>
</head><body>${body}</body></html>`, "text/html");
  });
  detail.scrollIntoView({ behavior: "smooth" });
}

function runFileStem(run) {
  return `${run.recTitle}_${new Date(run.startedAt).toISOString().slice(0, 10)}`
    .replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "run";
}

async function runReportMarkdown(run) {
  const shots = await PTDB.getShotsByRec("run:" + run.id);
  const dataByKey = new Map();
  for (const s of shots) dataByKey.set(s.stepId, await PTCommon.blobToDataUrl(s.blob));
  const params = Object.entries(run.params || {});
  const lines = run.steps.map(s => {
    const img = dataByKey.get(run.id + ":" + s.n);
    return `${s.n}. ${String(s.text || "").replace(/\*\*/g, "")} — **${s.status}** (${new Date(s.ts).toLocaleTimeString()})` +
      (img ? `\n\n![Step ${s.n}](${img})` : "");
  });
  return `# Evidence — ${run.recTitle}

- Run: ${new Date(run.startedAt).toLocaleString()}${run.finishedAt ? ` → ${new Date(run.finishedAt).toLocaleString()}` : ""}
- Mode: ${run.mode}
- Outcome: ${PTCommon.summarizeRun(run.steps)}
${params.length ? `- Parameters: ${params.map(([k, v]) => `${k} = ${v}`).join(", ")}\n` : ""}
## Steps

${lines.join("\n\n")}
`;
}

$("libList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const row = btn.closest(".lib-row");
  const id = row && row.dataset.id;
  if (!id) return;

  switch (btn.dataset.act) {
    case "open":
      await openRecording(id);
      break;
    case "regen": {
      const rec = await PTDB.getRecording(id);
      if (!rec) return;
      setGenSource(rec);
      document.querySelector(".generate").scrollIntoView({ behavior: "smooth" });
      break;
    }
    case "rename": {
      const rec = await PTDB.getRecording(id);
      if (!rec) return;
      const title = prompt("Rename recording:", rec.title);
      if (title === null || !title.trim()) return;
      await PTDB.renameRecording(id, title.trim());
      if (activeRecording && activeRecording.id === id) activeRecording.title = title.trim();
      renderLibrary();
      break;
    }
    case "del": {
      if (!confirm("Delete this recording and its screenshots?")) return;
      await PTDB.deleteRecording(id);
      if (activeRecording && activeRecording.id === id) setGenSource(null);
      $("libDetail").hidden = true;
      renderLibrary();
      break;
    }
    case "compare": {
      if (typeof startCompare !== "function") break;
      if (!libCompareA) {
        libCompareA = id;
        $("libStatus").textContent = "Compare ► pick the second recording (⇄ on another row; same row cancels)";
      } else if (libCompareA === id) {
        libCompareA = null;
        $("libStatus").textContent = "Library — saved recordings live in this browser profile only.";
      } else {
        const a = libCompareA;
        libCompareA = null;
        $("libStatus").textContent = "Library — saved recordings live in this browser profile only.";
        startCompare(a, id);
      }
      break;
    }
    case "verify":
      if (typeof startVerify === "function") startVerify(id);
      break;
    case "walk":
      if (typeof startWalkthrough === "function") startWalkthrough(id);
      break;
    case "run":
      if (typeof startAutopilot === "function") startAutopilot(id);
      break;
    case "watch": {
      const rec = await PTDB.getRecording(id);
      if (!rec) break;
      if (rec.watch) delete rec.watch;
      else rec.watch = { periodHours: 24, lastRun: 0, lastNotified: 0 };
      rec.updatedAt = Date.now();
      await PTDB.saveRecording(rec);
      await send({ cmd: "watchChanged" });
      renderLibrary();
      break;
    }
    case "audit":
      if (typeof startAudit === "function") startAudit(id);
      break;
  }
});
