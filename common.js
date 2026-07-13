// Paper Trail — shared pure helpers.
// Plain script, no DOM/extension APIs at load time, so it runs identically in
// the content script, the side panel, and tests.html. Exposes one global: PTCommon.

const PTCommon = (() => {

  // Normalize a captured label for comparison: case/whitespace-insensitive,
  // tolerant of the "…" the recorder appends when it truncates at 80 chars.
  function normLabel(s) {
    return String(s || "").replace(/…$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Loose match between a live label and a recorded one. Exact after
  // normalization, or prefix-tolerant when either side was truncated.
  function labelMatches(a, b) {
    const x = normLabel(a), y = normLabel(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const min = Math.min(x.length, y.length);
    // Only trust a prefix match when the shorter side is a truncation-length label
    return min >= 20 && (x.startsWith(y) || y.startsWith(x));
  }

  // Ordered, deduped anchor candidates for a step — the single source of
  // trust order. Test attributes outrank ids (they exist to be stable; ids
  // are often framework-generated). The primary selector sits mid-list, so
  // legacy single-selector steps degrade to [selector] — v1.1 behavior.
  function anchorList(step) {
    if (!step) return [];
    const a = step.anchors || {};
    const out = [];
    for (const s of [a.testAttr, a.id, a.attr, step.selector, a.css]) {
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  // SPA-tolerant page identity: same origin + path, ignoring query and hash.
  function samePage(u1, u2) {
    try {
      const a = new URL(u1), b = new URL(u2);
      return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
    } catch (e) { return false; }
  }

  function sameOrigin(u1, u2) {
    try { return new URL(u1).origin === new URL(u2).origin; } catch (e) { return false; }
  }

  function urlHost(u) {
    try { return new URL(u).host; } catch (e) { return ""; }
  }

  // Reduce per-step verify grades into the report headline.
  // grades: array of "found" | "fallback" | "missing" | "unreachable" | "na"
  function summarizeVerify(grades) {
    const c = { found: 0, fallback: 0, missing: 0, unreachable: 0, na: 0 };
    for (const g of grades) c[g in c ? g : "na"]++;
    const checked = c.found + c.fallback + c.missing + c.unreachable;
    if (!checked) return "no verifiable steps";
    const parts = [`${c.found}/${checked} anchors healthy`];
    const bad = [];
    if (c.fallback) bad.push(`${c.fallback} drifted`);
    if (c.missing) bad.push(`${c.missing} missing`);
    if (c.unreachable) bad.push(`${c.unreachable} unreachable`);
    if (bad.length) parts.push(bad.join(", "));
    return parts.join(" — ");
  }

  // ── Recording diff ────────────────────────────────────────────────────────

  const stepKey = (s) => `${s.type}|${s.kind || ""}|${normLabel(s.label)}`;

  // Shared normalized words / max words — the relabel-pairing heuristic.
  function tokenOverlap(a, b) {
    const ta = new Set(normLabel(a).split(" ").filter(Boolean));
    const tb = new Set(normLabel(b).split(" ").filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return shared / Math.max(ta.size, tb.size);
  }

  // Align two step ledgers (LCS on type|kind|label keys) and classify each
  // position. Within the gaps between matches, a removed+added pair at the
  // same offset with matching type+kind and token overlap ≥ 0.3 reads as a
  // relabel. Known limit: a MOVED step appears as removed + added.
  function diffSteps(stepsA, stepsB) {
    const A = stepsA || [], B = stepsB || [];
    const keyA = A.map(stepKey), keyB = B.map(stepKey);
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = keyA[i] === keyB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const entries = [];
    const emitGap = (removed, added) => {
      const len = Math.max(removed.length, added.length);
      for (let k = 0; k < len; k++) {
        const a = removed[k], b = added[k];
        if (a && b && a.type === b.type && (a.kind || "") === (b.kind || "") &&
            tokenOverlap(a.label, b.label) >= 0.3) {
          entries.push({ op: "relabeled", a, b });
        } else {
          if (a) entries.push({ op: "removed", a });
          if (b) entries.push({ op: "added", b });
        }
      }
    };

    let i = 0, j = 0, remGap = [], addGap = [];
    while (i < n && j < m) {
      if (keyA[i] === keyB[j]) {
        emitGap(remGap, addGap); remGap = []; addGap = [];
        const a = A[i], b = B[j];
        const e = { op: "unchanged", a, b };
        if (a.url && b.url && !samePage(a.url, b.url)) e.urlChanged = true;
        if ((a.value || "") !== (b.value || "")) e.valueChanged = true;
        if ((a.selector || "") !== (b.selector || "")) e.anchorsChanged = true;
        entries.push(e);
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        remGap.push(A[i++]);
      } else {
        addGap.push(B[j++]);
      }
    }
    while (i < n) remGap.push(A[i++]);
    while (j < m) addGap.push(B[j++]);
    emitGap(remGap, addGap);
    return entries;
  }

  function summarizeDiff(entries) {
    const c = { unchanged: 0, relabeled: 0, added: 0, removed: 0 };
    for (const e of entries) if (e.op in c) c[e.op]++;
    const parts = [`${c.unchanged} unchanged`];
    if (c.relabeled) parts.push(`${c.relabeled} relabeled`);
    if (c.added) parts.push(`${c.added} added`);
    if (c.removed) parts.push(`${c.removed} removed`);
    return parts.join(", ");
  }

  // Attribute Whisper verbose_json segments to steps by timestamp. A segment
  // belongs to the LATEST step whose ts ≤ the segment's absolute end time —
  // narration follows the action it describes. End-inclusive on purpose: nav
  // steps are timestamped before their paint-settle delay. Segments ending
  // before the first step attach to step 1.
  function mapNarration(segments, steps, audioStartTs) {
    if (!segments || !segments.length || !steps || !steps.length) return [];
    const ordered = steps.slice().sort((a, b) => a.ts - b.ts);
    const texts = new Map(); // step id -> [text]
    for (const seg of segments) {
      const text = String(seg.text || "").trim();
      if (!text) continue;
      const endAbs = audioStartTs + (seg.end || 0) * 1000;
      let owner = ordered[0];
      for (const s of ordered) {
        if (s.ts <= endAbs) owner = s;
        else break;
      }
      if (!texts.has(owner.id)) texts.set(owner.id, []);
      texts.get(owner.id).push(text);
    }
    return [...texts.entries()].map(([id, parts]) => ({ id, narration: parts.join(" ") }));
  }

  // Privacy-audit stats over a step array (pure; used by background + tests).
  function auditStats(steps) {
    const maskedSteps = steps.filter(s => s.masked).map(s => ({ n: s.n, label: s.label }));
    const shots = steps.filter(s => s.shot || s.hasShot).map(s => s.n);
    const narratedSteps = steps.filter(s => s.narration).map(s => s.n);
    const captionedSteps = steps.filter(s => s.type === "desktop" && s.caption).map(s => s.n);
    const paramSteps = steps.filter(s => s.param).map(s => ({ n: s.n, param: s.param }));
    return { maskedSteps, shotSteps: shots, narratedSteps, captionedSteps, paramSteps, stepCount: steps.length };
  }

  // RFC-4180-ish CSV parser for the runs table: quoted fields, "" escapes,
  // CR/LF/CRLF line ends. Header row is trimmed; data rows are kept verbatim
  // (including ragged lengths — the caller validates against its params).
  function parseCsv(text) {
    const s = String(text || "");
    const out = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(field); field = "";
        out.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); out.push(row); }
    const nonEmpty = out.filter(r => r.some(f => f.trim() !== ""));
    const headers = (nonEmpty.shift() || []).map(h => h.trim());
    return { headers, rows: nonEmpty };
  }

  // Reduce an evidence run's per-step statuses into its outcome line.
  // statuses: "done" | "confirmed" | "manual" | "skipped" | "failed"
  function summarizeRun(steps) {
    const c = { done: 0, confirmed: 0, manual: 0, skipped: 0, failed: 0 };
    for (const s of steps || []) if (s.status in c) c[s.status]++;
    const parts = [];
    const executed = c.done + c.confirmed;
    if (executed) parts.push(`${executed} executed`);
    if (c.manual) parts.push(`${c.manual} manual`);
    if (c.skipped) parts.push(`${c.skipped} skipped`);
    if (c.failed) parts.push(`${c.failed} failed`);
    return parts.length ? parts.join(", ") : "no steps";
  }

  // Blob → data URL (panel/content contexts; the service worker has its own).
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  return {
    normLabel, labelMatches, anchorList, samePage, sameOrigin, urlHost,
    summarizeVerify, diffSteps, summarizeDiff, mapNarration, auditStats,
    summarizeRun, parseCsv, blobToDataUrl
  };
})();
