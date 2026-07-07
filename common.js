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

  // Privacy-audit stats over a step array (pure; used by background + tests).
  function auditStats(steps) {
    const maskedSteps = steps.filter(s => s.masked).map(s => ({ n: s.n, label: s.label }));
    const shots = steps.filter(s => s.shot || s.hasShot).map(s => s.n);
    return { maskedSteps, shotSteps: shots, stepCount: steps.length };
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

  return { normLabel, labelMatches, samePage, sameOrigin, urlHost, summarizeVerify, auditStats, blobToDataUrl };
})();
