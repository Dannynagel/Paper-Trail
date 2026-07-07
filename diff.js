// Paper Trail — Recording diff: compare two saved recordings of the same
// procedure and produce a what-changed report for change management.
// The alignment (PTCommon.diffSteps) runs entirely locally; the optional
// "Generate change summary" button is the only path that talks to a model.
// Hooked into library rows via the optional-global pattern (startCompare).

let lastDiff = null; // { recA, recB, entries, summary }

const DIFF_OP_STYLE = {
  unchanged: { dot: "ver-na", label: "unchanged" },
  relabeled: { dot: "ver-fallback", label: "relabeled" },
  added: { dot: "ver-found", label: "added" },
  removed: { dot: "ver-missing", label: "removed" }
};

async function startCompare(idA, idB) {
  const [recA, recB] = await Promise.all([PTDB.getRecording(idA), PTDB.getRecording(idB)]);
  if (!recA || !recB) return;
  const entries = PTCommon.diffSteps(recA.steps, recB.steps);
  const summary = PTCommon.summarizeDiff(entries);
  lastDiff = { recA, recB, entries, summary };
  renderDiffReport();
}

function diffRowHtml(e, idx) {
  const s = DIFF_OP_STYLE[e.op];
  const nOld = e.a ? e.a.n : "·";
  const nNew = e.b ? e.b.n : "·";
  let body;
  if (e.op === "relabeled") {
    body = `${actionHtml(e.a.text)}<div class="page">now: ${actionHtml(e.b.text)}</div>`;
  } else {
    body = actionHtml((e.b || e.a).text);
  }
  const flags = [];
  if (e.urlChanged) flags.push("page moved");
  if (e.valueChanged) flags.push("value changed");
  if (e.anchorsChanged) flags.push("anchor changed");
  return `
    <div class="step">
      <div class="rail"><span class="n">${nOld}→${nNew}</span></div>
      <div class="body">
        <div class="action">${body}</div>
        <div class="page"><span class="ver-dot ${s.dot}"></span>${s.label}${
          flags.length ? ` — <span class="masked">${esc(flags.join(", "))}</span>` : ""}</div>
      </div>
    </div>`;
}

function renderDiffReport() {
  const { recA, recB, entries, summary } = lastDiff;
  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Diff — ${esc(recA.title)} → ${esc(recB.title)}</span>
      <div class="result-actions">
        <button id="diffMd" class="ghost">.md</button>
        <button id="diffHtml" class="ghost">.html</button>
        <button id="diffClose" class="ghost">Close</button>
      </div>
    </div>
    <div class="status">${esc(summary)} · a moved step reads as removed + added</div>
    <section class="steps lib-steps">${entries.map(diffRowHtml).join("")}</section>
    <div class="lib-actions" style="padding:8px">
      <button id="diffGen" class="primary">Generate change summary</button>
      <button id="diffAudit" class="ghost" title="Preview exactly what the change summary would send">Audit</button>
    </div>
    <div id="diffStatus" class="status" hidden></div>`;

  $("diffClose").addEventListener("click", () => {
    detail.hidden = true;
    detail.innerHTML = "";
  });
  $("diffMd").addEventListener("click", () =>
    download(`Change_Report_${diffFileStem()}.md`, diffMarkdown(), "text/markdown"));
  $("diffHtml").addEventListener("click", () => {
    const body = mdToHtml(diffMarkdown());
    download(`Change_Report_${diffFileStem()}.html`,
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Change report</title></head><body>${body}</body></html>`,
      "text/html");
  });
  $("diffGen").addEventListener("click", generateDiffSummary);
  $("diffAudit").addEventListener("click", auditDiffSummary);
  detail.scrollIntoView({ behavior: "smooth" });
}

function diffFileStem() {
  return `${lastDiff.recA.title}_${lastDiff.recB.title}`
    .replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "recordings";
}

function diffMarkdown() {
  const { recA, recB, entries, summary } = lastDiff;
  const marker = { unchanged: "=", relabeled: "✱", added: "+", removed: "−" };
  const lines = entries.map(e => {
    const text = (t) => String(t || "").replace(/\*\*/g, "");
    const base = e.op === "relabeled"
      ? `**${text(e.a.text)}** → **${text(e.b.text)}**`
      : text((e.b || e.a).text);
    const flags = [
      e.urlChanged && "page moved",
      e.valueChanged && "value changed",
      e.anchorsChanged && "anchor changed"
    ].filter(Boolean);
    return `- \`${marker[e.op]}\` ${e.op === "unchanged" ? base : `**${e.op}**: ${base}`}${
      flags.length ? ` _(${flags.join(", ")})_` : ""}`;
  });
  return `# Change report — ${lastDiff.recA.title} → ${lastDiff.recB.title}

- Old: **${recA.title}** (${new Date(recA.createdAt).toLocaleDateString()}, ${recA.steps.length} steps)
- New: **${recB.title}** (${new Date(recB.createdAt).toLocaleDateString()}, ${recB.steps.length} steps)
- Summary: ${summary}

Legend: \`=\` unchanged · \`✱\` relabeled · \`+\` added · \`−\` removed. A step that moved position appears as removed + added.

## Steps

${lines.join("\n")}
`;
}

async function generateDiffSummary() {
  const st = $("diffStatus");
  st.hidden = false; st.className = "status"; st.textContent = "Generating change summary…";
  const resp = await send({
    cmd: "generateDiff",
    recordingIdA: lastDiff.recA.id,
    recordingIdB: lastDiff.recB.id,
    context: $("context").value.trim()
  });
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
}

async function auditDiffSummary() {
  const st = $("diffStatus");
  st.hidden = false; st.className = "status"; st.textContent = "Building audit locally…";
  const resp = await send({
    cmd: "auditPayload",
    target: "diff",
    context: $("context").value.trim(),
    recordingId: lastDiff.recA.id,
    recordingIdB: lastDiff.recB.id
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
}
