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

  wrap.innerHTML = list.map(r => `
    <div class="step lib-row" data-id="${r.id}">
      <div class="rail"><span class="n">${r.stepCount}</span>steps</div>
      <div class="body">
        <div class="action"><b>${esc(r.title)}</b></div>
        <div class="page">${esc(libDate(r.createdAt))}${r.lastVerified
          ? ` · verified ${esc(libDate(r.lastVerified.ts))} — ${esc(r.lastVerified.summary)}` : ""}</div>
        <div class="page">${(r.urlHosts || []).map(esc).join(" · ") || esc(r.source || "")}</div>
        <div class="lib-actions">
          <button data-act="open">Open</button>
          ${canWalk ? `<button data-act="walk" title="Guided walkthrough on the live site">▶ Walk</button>` : ""}
          ${canVerify ? `<button data-act="verify" title="Check anchors against the live site">✓ Verify</button>` : ""}
          <button data-act="regen" title="Generate from this recording">Re-gen</button>
          ${canCompare ? `<button data-act="compare" title="Diff against another recording">⇄ Compare</button>` : ""}
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
        <div class="step">
          <div class="rail"><span class="n">${step.n}</span></div>
          <div class="body">
            <div class="action">${actionHtml(step.text)}</div>
            <div class="page" title="${esc(step.url)}">${esc(step.pageTitle || step.url)}</div>
            ${step.masked ? `<div class="masked">value masked</div>` : ""}
            ${step.note ? `<div class="page">📝 ${esc(step.note)}</div>` : ""}
            ${step.caption ? `<div class="caption">🖼→📝 <em>${esc(step.caption)}</em></div>` : ""}
            ${step.narration ? `<div class="narration">🎙 <em>${esc(step.narration)}</em></div>` : ""}
            ${srcByStep.has(step.id)
              ? `<img src="${srcByStep.get(step.id)}" alt="Step ${step.n} screenshot" loading="lazy">` : ""}
          </div>
        </div>`).join("")}
    </section>`;
  $("libDetailClose").addEventListener("click", () => {
    detail.hidden = true;
    detail.innerHTML = "";
    libRevokeUrls();
  });
  detail.scrollIntoView({ behavior: "smooth" });
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
    case "audit":
      if (typeof startAudit === "function") startAudit(id);
      break;
  }
});
