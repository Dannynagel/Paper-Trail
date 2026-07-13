// Paper Trail — Verify Mode: replay a saved recording's anchors against the
// live UI, read-only, and grade each step. Runs entirely in the side panel
// (the panel outlives MV3 service-worker eviction; the worker is not involved).
//
// Grades: found (selector healthy) · fallback (label found it — selector
// drifted; unique matches carry a suggested repair) · missing · unreachable
// (page never loaded / redirected off-origin) · na (not verifiable: desktop,
// UIA, manual, or selector-less steps).

let verifyRun = null;

const VERIFY_NAV_TIMEOUT = 20000;
const VERIFY_SETTLE_MS = 600;

function verifiableStep(s) {
  if (s.type === "nav") return !!s.url;
  return !!(s.selector && s.url);
}

async function startVerify(recId) {
  if (verifyRun) return;
  if (typeof walk !== "undefined" && walk) {
    alert("A walkthrough is in progress — end it first.");
    return;
  }
  if (typeof ap !== "undefined" && ap) {
    alert("Autopilot is running — stop it first.");
    return;
  }
  if (currentSession.recording) {
    alert("Stop recording before running Verify.");
    return;
  }
  const rec = await PTDB.getRecording(recId);
  if (!rec) return;

  verifyRun = { recId, rec, tabId: null, cancelled: false };
  const results = rec.steps.map(s => ({ step: s, grade: "pending", suggestion: "", matchCount: 0 }));
  renderVerifyReport(rec, results);

  try {
    for (const r of results) {
      if (verifyRun.cancelled) break;
      const s = r.step;
      if (!verifiableStep(s)) {
        r.grade = "na";
        updateVerifyRow(r);
        continue;
      }

      const nav = await verifyEnsureTabAt(s.url);
      if (verifyRun.cancelled) break;
      if (!nav.reached) {
        r.grade = "unreachable";
        r.detail = nav.finalUrl && !PTCommon.sameOrigin(nav.finalUrl, s.url)
          ? "redirected off-origin (login wall?)" : "page did not load";
        updateVerifyRow(r);
        continue;
      }

      if (s.type === "nav") {
        r.grade = PTCommon.samePage(nav.finalUrl, s.url) ? "found" : "fallback";
        if (r.grade === "fallback") r.detail = "same origin, different path";
        updateVerifyRow(r);
        continue;
      }

      const probe = await PTCommon.probeFrames(verifyRun.tabId, s);
      r.grade = probe.status;
      r.suggestion = probe.status === "fallback" ? probe.matchedSelector : "";
      r.freshAnchors = probe.status === "fallback" ? probe.freshAnchors : undefined;
      r.matchCount = probe.matchCount;
      if (probe.status === "fallback" && !probe.matchedSelector) {
        r.detail = `ambiguous — ${probe.matchCount} label matches`;
      }
      updateVerifyRow(r);
    }
  } finally {
    const grades = results.map(r => (r.grade === "pending" ? "na" : r.grade));
    const summary = PTCommon.summarizeVerify(grades);
    if (!verifyRun.cancelled) {
      rec.lastVerified = { ts: Date.now(), summary };
      rec.updatedAt = Date.now();
      await PTDB.saveRecording(rec).catch(() => {});
    }
    if (verifyRun.tabId) chrome.tabs.remove(verifyRun.tabId).catch(() => {});
    finishVerifyReport(rec, results, summary);
    verifyRun = null;
    renderLibrary();
  }
}

// Navigate the dedicated verify tab only when the current page differs
// (origin+path), tolerating SPA query/hash drift.
async function verifyEnsureTabAt(url) {
  if (!verifyRun.tabId) {
    const done = PTCommon.waitTabLoad(VERIFY_NAV_TIMEOUT, (id) => id === verifyRun.tabId);
    const tab = await chrome.tabs.create({ url, active: true });
    verifyRun.tabId = tab.id;
    return verifyFinishNav(await done, url);
  }
  const tab = await chrome.tabs.get(verifyRun.tabId).catch(() => null);
  if (!tab) return { reached: false, finalUrl: "" };
  if (PTCommon.samePage(tab.url, url)) return { reached: true, finalUrl: tab.url };
  const done = PTCommon.waitTabLoad(VERIFY_NAV_TIMEOUT, (id) => id === verifyRun.tabId);
  await chrome.tabs.update(verifyRun.tabId, { url });
  return verifyFinishNav(await done, url);
}

async function verifyFinishNav(loaded, wanted) {
  if (!loaded) return { reached: false, finalUrl: "" };
  await new Promise(r => setTimeout(r, VERIFY_SETTLE_MS));
  const tab = await chrome.tabs.get(verifyRun.tabId).catch(() => null);
  if (!tab) return { reached: false, finalUrl: "" };
  return { reached: PTCommon.sameOrigin(tab.url, wanted), finalUrl: tab.url || "" };
}

// Frame probing lives in PTCommon.probeFrames (shared with the drift sentinel).

// ── Report rendering (in the Library tab's detail area) ────────────────────
const VERIFY_GRADE_LABEL = {
  pending: "…", na: "not verifiable", found: "anchor healthy",
  fallback: "drifted", missing: "missing", unreachable: "unreachable"
};

function renderVerifyReport(rec, results) {
  const detail = $("libDetail");
  detail.hidden = false;
  detail.innerHTML = `
    <div class="result-bar">
      <span>Verify — ${esc(rec.title)}</span>
      <div class="result-actions"><button id="verCancel" class="ghost">Cancel</button></div>
    </div>
    <div id="verSummary" class="status">Opening a tab and checking each anchor…</div>
    <section class="steps lib-steps">
      ${results.map(r => `
        <div class="step" id="ver-${r.step.id}">
          <div class="rail"><span class="n">${r.step.n}</span></div>
          <div class="body">
            <div class="action">${actionHtml(r.step.text)}</div>
            <div class="page ver-grade"><span class="ver-dot ver-pending"></span>checking…</div>
          </div>
        </div>`).join("")}
    </section>
    <div class="lib-actions" style="padding:8px" id="verApplyWrap" hidden>
      <button id="verApply" class="primary">Apply suggested selectors</button>
    </div>`;
  $("verCancel").addEventListener("click", () => {
    if (verifyRun) verifyRun.cancelled = true;
  });
  detail.scrollIntoView({ behavior: "smooth" });
}

function updateVerifyRow(r) {
  const row = document.getElementById(`ver-${r.step.id}`);
  if (!row) return;
  const g = row.querySelector(".ver-grade");
  const extra = r.suggestion
    ? ` — suggested repair: <code>${esc(r.suggestion)}</code>`
    : (r.detail ? ` — ${esc(r.detail)}` : "");
  g.innerHTML = `<span class="ver-dot ver-${r.grade}"></span>${esc(VERIFY_GRADE_LABEL[r.grade] || r.grade)}${extra}`;
}

function finishVerifyReport(rec, results, summary) {
  const sum = $("verSummary");
  if (sum) sum.textContent = summary;
  const cancel = document.getElementById("verCancel");
  if (cancel) cancel.textContent = "Close";
  const fixes = results.filter(r => r.grade === "fallback" && r.suggestion);
  const wrap = document.getElementById("verApplyWrap");
  if (wrap && fixes.length) {
    wrap.hidden = false;
    const btn = document.getElementById("verApply");
    btn.textContent = `Apply ${fixes.length} suggested selector${fixes.length === 1 ? "" : "s"}`;
    btn.addEventListener("click", async () => {
      const fresh = await PTDB.getRecording(rec.id);
      if (!fresh) return;
      const byId = new Map(fresh.steps.map(s => [s.id, s]));
      for (const f of fixes) {
        const s = byId.get(f.step.id);
        if (!s) continue;
        s.selector = f.suggestion;
        // Overwrite, never merge — stale alternates must not linger and mask drift.
        s.anchors = f.freshAnchors || undefined;
      }
      fresh.updatedAt = Date.now();
      fresh.lastVerified = { ts: Date.now(), summary: summary + " — repairs applied" };
      await PTDB.saveRecording(fresh);
      wrap.hidden = true;
      const s2 = $("verSummary");
      if (s2) s2.textContent = `${fixes.length} selector(s) repaired ✓ — re-run Verify to confirm`;
      renderLibrary();
    }, { once: true });
  }
  const closeBtn = document.getElementById("verCancel");
  if (closeBtn) closeBtn.addEventListener("click", () => {
    $("libDetail").hidden = true;
    $("libDetail").innerHTML = "";
  }, { once: true });
}
