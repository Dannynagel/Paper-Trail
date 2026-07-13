// Paper Trail — Library tab: saved recordings (list, open, re-generate).
// Loaded after sidepanel.js; shares its globals ($, send, esc, setGenSource…).
// Later features hook in via optional globals checked at render time:
// startVerify(id), startWalkthrough(id), startAudit(id).

let libObjUrls = [];
let libCompareA = null; // first pick of a pending ⇄ Compare
let libVariantA = null; // pending ⑂ Variant: the recording being tagged

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
  const caps = {
    verify: typeof startVerify === "function",
    walk: typeof startWalkthrough === "function",
    audit: typeof startAudit === "function",
    compare: typeof startCompare === "function" && list.length > 1,
    run: typeof startAutopilot === "function"
  };

  // Group variants under their trunk; a variant whose trunk was deleted
  // floats back to the top level.
  const ids = new Set(list.map(r => r.id));
  const variantsOf = new Map();
  for (const r of list) {
    if (r.variantOf && ids.has(r.variantOf)) {
      if (!variantsOf.has(r.variantOf)) variantsOf.set(r.variantOf, []);
      variantsOf.get(r.variantOf).push(r);
    }
  }
  const top = list.filter(r => !(r.variantOf && ids.has(r.variantOf)));
  wrap.innerHTML = top.map(r =>
    libRowHtml(r, caps, false, (variantsOf.get(r.id) || []).length) +
    (variantsOf.get(r.id) || []).map(v => libRowHtml(v, caps, true, 0)).join("")
  ).join("");
}

function libRowHtml(r, caps, isVariant, variantCount) {
  return `
    <div class="step lib-row" data-id="${r.id}"${isVariant ? ` style="margin-left:22px"` : ""}>
      <div class="rail"><span class="n">${r.stepCount}</span>steps</div>
      <div class="body">
        <div class="action">${isVariant ? "⑂ " : ""}<b>${esc(r.title)}</b>${
          isVariant ? ` <span class="param-chip">${esc(r.variantLabel || "variant")}</span>` : ""}</div>
        <div class="page">${esc(libDate(r.createdAt))}${r.lastVerified
          ? ` · verified ${esc(libDate(r.lastVerified.ts))} — ${esc(r.lastVerified.summary)}` : ""}</div>
        <div class="page">${(r.urlHosts || []).map(esc).join(" · ") || esc(r.source || "")}${
          r.httpCount ? ` · ${r.httpCount} HTTP` : ""}</div>
        <div class="lib-actions">
          <button data-act="open">Open</button>
          ${caps.run ? `<button data-act="run" title="Autopilot: perform the recorded steps in the browser">⚡ Run</button>` : ""}
          ${caps.walk ? `<button data-act="walk" title="Guided walkthrough on the live site">▶ Walk</button>` : ""}
          ${caps.verify ? `<button data-act="verify" title="Check anchors against the live site">✓ Verify</button>` : ""}
          <button data-act="regen" title="Generate from this recording">Re-gen</button>
          ${caps.compare ? `<button data-act="compare" title="Diff against another recording">⇄ Compare</button>` : ""}
          <button data-act="variant" title="${isVariant
            ? "Untag this variant"
            : "Tag this recording as a variant of a trunk procedure"}">⑂ ${isVariant ? "Untag" : "Variant"}</button>
          ${variantCount ? `<button data-act="branch" class="primary" title="One SOP with decision points covering the trunk and its ${variantCount} variant(s)">⑂ SOP</button>` : ""}
          <button data-act="watch" title="${r.watch
            ? "Drift sentinel is watching this SOP — click to stop"
            : "Watch for drift: re-verify anchors every 24 h and alert on new problems"}"${
            r.watch ? ` class="active"` : ""}>⏰${r.watch ? " on" : ""}</button>
          ${caps.audit ? `<button data-act="audit" title="Preview exactly what would be sent to the model">Audit</button>` : ""}
          <button data-act="rename">Rename</button>
          <button data-act="export" title="Export as a shareable .ptpack (recording + screenshots; runs and watch stay local)">⬇</button>
          <button data-act="del" class="danger" title="Delete recording">✕</button>
        </div>
      </div>
    </div>`;
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
            ${(srcByStep.has(step.id) && typeof openRedactor === "function")
              ? `<button data-libact="redact" data-id="${step.id}" title="Black out parts of this screenshot (permanent)">🖌</button>` : ""}
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
  detail.querySelectorAll("button[data-libact='redact']").forEach(btn =>
    btn.addEventListener("click", () => openRedactor(btn.dataset.id, () => openRecording(rec.id))));
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
    case "variant": {
      const rec = await PTDB.getRecording(id);
      if (!rec) break;
      if (rec.variantOf) {
        delete rec.variantOf;
        delete rec.variantLabel;
        rec.updatedAt = Date.now();
        await PTDB.saveRecording(rec);
        renderLibrary();
        break;
      }
      if (!libVariantA) {
        libVariantA = id;
        $("libStatus").textContent = "Variant ► now pick the TRUNK recording (⑂ on another row; same row cancels)";
      } else if (libVariantA === id) {
        libVariantA = null;
        $("libStatus").textContent = "Library — saved recordings live in this browser profile only.";
      } else {
        // second click: this row is the trunk for the recording picked first
        const variantId = libVariantA;
        libVariantA = null;
        $("libStatus").textContent = "Library — saved recordings live in this browser profile only.";
        if (rec.variantOf) { alert("Pick a trunk that is not itself a variant."); break; }
        const variant = await PTDB.getRecording(variantId);
        if (!variant) break;
        const label = prompt(`Label for this variant path of “${rec.title}”:`, "Alternate path");
        if (label === null) break;
        variant.variantOf = id;
        variant.variantLabel = label.trim() || "Alternate path";
        variant.updatedAt = Date.now();
        await PTDB.saveRecording(variant);
        renderLibrary();
      }
      break;
    }
    case "branch":
      renderBranchPane(id);
      break;
    case "export": {
      const pack = await buildPack(id);
      if (!pack) break;
      const stem = pack.rec.title.replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "recording";
      download(`${stem}.ptpack`, JSON.stringify(pack), "application/json");
      break;
    }
  }
});

// ── Library packs (.ptpack) — share a recording between profiles ───────────
// The pack carries the recording and its screenshots. Runs, watch state, and
// the runs-table values are local operational state and never travel; variant
// links are dropped because recording ids don't survive across profiles.
async function buildPack(recId) {
  const rec = await PTDB.getRecording(recId);
  if (!rec) return null;
  const copy = JSON.parse(JSON.stringify(rec));
  delete copy.watch;
  delete copy.paramSets;
  delete copy.variantOf;
  delete copy.variantLabel;
  const shots = await PTDB.getShotsByRec(recId);
  const packed = [];
  for (const s of shots) {
    packed.push({ stepId: s.stepId, b64: await PTCommon.blobToDataUrl(s.blob) });
  }
  return { format: "ptpack/1", rec: copy, shots: packed };
}

async function importPack(pack) {
  if (!pack || pack.format !== "ptpack/1" || !pack.rec ||
      !Array.isArray(pack.rec.steps) || typeof pack.rec.title !== "string") {
    throw new Error("not a valid .ptpack file");
  }
  const rec = pack.rec;
  rec.id = crypto.randomUUID(); // fresh identity here; step UUIDs are kept
  delete rec.watch;
  delete rec.paramSets;
  delete rec.variantOf;
  delete rec.variantLabel;
  rec.updatedAt = Date.now();
  for (const s of pack.shots || []) {
    if (!s || !s.stepId || typeof s.b64 !== "string" || !/^data:image\//.test(s.b64)) continue;
    const blob = await (await fetch(s.b64)).blob();
    await PTDB.putShot({ stepId: s.stepId, recId: rec.id, blob });
  }
  await PTDB.saveRecording(rec);
  return rec.id;
}

$("btnImportPack").addEventListener("click", () => $("libImportFile").click());
$("libImportFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // allow re-picking the same file
  if (!file) return;
  const ls = $("libStatus");
  try {
    const pack = JSON.parse(await file.text());
    await importPack(pack);
    ls.textContent = `Imported ✓ — “${pack.rec.title}”`;
    renderLibrary();
  } catch (err) {
    ls.textContent = "Import failed: " + String(err.message || err);
  }
});

// ── Branched SOP pane (mirrors the diff pane: generate + audit) ────────────
async function renderBranchPane(trunkId) {
  const trunk = await PTDB.getRecording(trunkId);
  if (!trunk) return;
  const metas = await PTDB.listRecordings();
  const variants = metas.filter(m => m.variantOf === trunkId);
  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Branched SOP — ${esc(trunk.title)}</span>
      <div class="result-actions"><button id="branchClose" class="ghost">Close</button></div>
    </div>
    <div class="status">One SOP with decision points covering the trunk and:
      ${variants.map(v => `<b>${esc(v.variantLabel || v.title)}</b>`).join(", ")}.
      Only step texts and diff ops are sent — no anchors or values.</div>
    <div class="lib-actions" style="padding:8px">
      <button id="branchGen" class="primary">Generate branched SOP</button>
      <button id="branchAudit" class="ghost" title="Preview exactly what would be sent">Audit</button>
    </div>
    <div id="branchStatus" class="status" hidden></div>`;
  $("branchClose").addEventListener("click", () => {
    detail.hidden = true;
    detail.innerHTML = "";
  });
  $("branchGen").addEventListener("click", async () => {
    const st = $("branchStatus");
    st.hidden = false; st.className = "status"; st.textContent = "Generating branched SOP…";
    const resp = await send({ cmd: "generateBranch", trunkId, context: $("context").value.trim() });
    if (!resp || !resp.ok) {
      st.className = "status err";
      st.textContent = "Failed: " + (resp ? resp.error : "no response");
      return;
    }
    st.hidden = true;
    currentTarget = "sop"; // markdown document semantics for preview/export
    currentMarkdown = resp.markdown.trim().replace(/^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i, "$1");
    spliceMap = new Map();
    showResult();
  });
  $("branchAudit").addEventListener("click", async () => {
    const st = $("branchStatus");
    st.hidden = false; st.className = "status"; st.textContent = "Building audit locally…";
    const resp = await send({
      cmd: "auditPayload", target: "branch",
      context: $("context").value.trim(), recordingId: trunkId
    });
    if (!resp || !resp.ok) {
      st.className = "status err";
      st.textContent = "Audit failed: " + (resp ? resp.error : "no response");
      return;
    }
    st.hidden = true;
    lastAudit = resp.audit;
    currentTarget = "audit";
    currentMarkdown = auditMarkdown(resp.audit);
    spliceMap = new Map();
    showResult();
  });
  detail.scrollIntoView({ behavior: "smooth" });
}
