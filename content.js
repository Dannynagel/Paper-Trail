// Paper Trail — content script
// Captures semantic user actions (what was actually clicked/typed, by label)
// and reports them to the service worker. No pixels are read here; the
// worker takes the screenshot. Values are masked by default.

(() => {
  if (window.__paperTrailLoaded) return;
  window.__paperTrailLoaded = true;

  // One mode machine, one listener set:
  // "idle" | "recording" | "walkthrough" | "autopilot".
  // Recording is owned by the broadcast state; walkthrough and autopilot are
  // owned by tab-targeted messages and never clobbered by broadcasts — but a
  // recording start tears both down.
  let mode = "idle";
  let captureValues = false;
  let lastClickTs = 0;

  // ── Recording state sync ────────────────────────────────────────────────
  chrome.runtime.sendMessage({ cmd: "isRecording" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp) {
      if (resp.recording) mode = "recording";
      captureValues = !!resp.captureValues;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.evt === "recordingState") {
      if (msg.recording) {
        if (mode === "walkthrough" || mode === "autopilot") walkCleanup();
        mode = "recording";
      } else if (mode === "recording") {
        mode = "idle";
      }
      captureValues = !!msg.captureValues;
    } else if (msg.cmd === "execStep") {
      sendResponse(execStep(msg.step || {}, msg.value, !!msg.confirm, !!msg.gate));
    } else if (msg.cmd === "probeStep") {
      const r = resolveStep(msg.step || {});
      sendResponse({
        status: r.status,
        matchedSelector: r.matchedSelector,
        matchCount: r.matchCount,
        freshAnchors: r.freshAnchors,
        frameUrl: location.href
      });
    } else if (msg.cmd === "walkArm") {
      sendResponse(walkArm(msg.step || {}));
    } else if (msg.cmd === "walkDisarm") {
      walkCleanup();
      sendResponse({ ok: true });
    } else if (msg.cmd === "walkFindByText") {
      sendResponse({ count: walkHighlightByText(msg.label || "") });
    } else if (msg.cmd === "walkPing") {
      walkLastPing = Date.now();
      sendResponse({ ok: true });
    }
  });

  // ── Label extraction ────────────────────────────────────────────────────
  const INTERACTIVE =
    'button, a, input, select, textarea, summary, [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';

  function clean(s, max = 80) {
    if (!s) return "";
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
  }

  function labelForInput(el) {
    // aria-label / aria-labelledby
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(id => {
        const n = document.getElementById(id);
        return n ? n.textContent : "";
      }).join(" ");
      if (clean(t)) return clean(t);
    }
    // <label for=...> or wrapping <label>
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && clean(lab.textContent)) return clean(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    // fallbacks
    return clean(el.placeholder || el.name || el.title || el.type || el.tagName.toLowerCase());
  }

  // Label + kind only — no selector/anchor extraction. The scan paths call
  // this per candidate element; computing anchors there (several full-document
  // uniqueness probes each) was pure waste for candidates that don't match.
  function labelKindFor(target) {
    const el = target.closest ? (target.closest(INTERACTIVE) || target) : target;
    const tag = (el.tagName || "").toLowerCase();
    const role = el.getAttribute && el.getAttribute("role");
    let kind = role || tag;
    let label = "";

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.type || "").toLowerCase();
      kind = tag === "select" ? "dropdown" : (type || "field");
      label = labelForInput(el);
    } else if (tag === "a") {
      kind = "link";
      label = clean(el.getAttribute("aria-label") || el.textContent || el.title || el.href);
    } else {
      kind = role || (tag === "button" ? "button" : tag);
      label = clean(
        el.getAttribute && (el.getAttribute("aria-label") || "") ||
        el.textContent || el.value || el.title || el.alt || tag
      );
    }
    return { el, tag, kind, label: label || "(unlabeled)" };
  }

  function describe(target) {
    const d = labelKindFor(target);
    const selector = cssPath(d.el);
    return { label: d.label, kind: d.kind, tag: d.tag, selector, anchors: anchorsFor(d.el, selector) };
  }

  // Attribute selector, returned only when it uniquely identifies the element.
  function attrSelector(el, attr) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (!v) return "";
    const sel = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    return "";
  }

  // Short structural path (id shortcut → :nth-of-type chain, capped at 6 levels).
  function structuralPath(el) {
    const path = [];
    let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth++ < 6) {
      if (n.id) { path.unshift("#" + CSS.escape(n.id)); break; }
      let seg = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === n.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      }
      path.unshift(seg);
      n = parent;
    }
    return path.join(" > ").slice(0, 240);
  }

  // Primary selector for RPA replay: id → test attrs → name/aria → structural path.
  function cssPath(el) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      for (const a of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"]) {
        const sel = attrSelector(el, a);
        if (sel) return sel;
      }
      return structuralPath(el);
    } catch (e) { return ""; }
  }

  // Every independent anchor the element offers (self-healing capture): unlike
  // cssPath, which picks one winner, this records all of them so a single UI
  // change can't orphan the step. Anchors equal to the primary are omitted.
  function anchorsFor(el, primary) {
    try {
      const a = {};
      for (const t of ["data-testid", "data-test", "data-qa", "data-cy"]) {
        const sel = attrSelector(el, t);
        if (sel) { a.testAttr = sel; break; }
      }
      if (el.id) {
        const sel = "#" + CSS.escape(el.id);
        try { if (document.querySelectorAll(sel).length === 1) a.id = sel; } catch (e) {}
      }
      for (const t of ["name", "aria-label"]) {
        const sel = attrSelector(el, t);
        if (sel) { a.attr = sel; break; }
      }
      const sp = structuralPath(el);
      if (sp) a.css = sp;
      for (const k of Object.keys(a)) if (a[k] === primary) delete a[k];
      return Object.keys(a).length ? a : undefined;
    } catch (e) { return undefined; }
  }

  // ── Anchor resolution (Verify Mode + Guided Walkthrough) ────────────────
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // Locate a recorded step's element on the live page.
  //   found    — the recorded PRIMARY selector still resolves AND its label agrees
  //   fallback — the primary drifted, but an alternate anchor or the label
  //              found the element (matchedSelector + freshAnchors suggest a repair)
  //   missing  — no anchor resolves
  // anchorsOnly skips the label scan: Autopilot may ACT only on recorded
  // anchors — a label guess is good enough to suggest a repair, never to
  // click on the user's behalf.
  function resolveStep(step, anchorsOnly) {
    const tryAnchor = (sel) => {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { return null; /* invalid selector */ }
      if (!el || !isVisible(el)) return null;
      if (step.label && !PTCommon.labelMatches(labelKindFor(el).label, step.label)) return null;
      return el;
    };

    // 1. Primary selector — the only path that grades "found".
    if (step.selector) {
      const el = tryAnchor(step.selector);
      if (el) return { status: "found", el, matchedSelector: step.selector, matchCount: 1 };
    }
    // 2. Alternate anchors in trust order — a hit means the primary drifted.
    for (const sel of PTCommon.anchorList(step)) {
      if (sel === step.selector) continue;
      const el = tryAnchor(sel);
      if (el) {
        return {
          status: "fallback", el, matchedSelector: sel, matchCount: 1,
          freshAnchors: anchorsFor(el, sel)
        };
      }
    }
    // 3. Label scan across interactive elements.
    if (step.label && !anchorsOnly) {
      const matches = [];
      for (const c of document.querySelectorAll(INTERACTIVE)) {
        if (!isVisible(c)) continue;
        const d = labelKindFor(c);
        if (!PTCommon.labelMatches(d.label, step.label)) continue;
        if (step.kind && d.kind && step.kind !== d.kind) continue;
        matches.push(c);
        if (matches.length > 8) break; // hopeless — report ambiguity, don't scan forever
      }
      if (matches.length === 1) {
        const el = matches[0];
        const sel = cssPath(el);
        return {
          status: "fallback", el, matchedSelector: sel, matchCount: 1,
          freshAnchors: anchorsFor(el, sel)
        };
      }
      if (matches.length > 1) {
        return { status: "fallback", el: null, matchedSelector: "", matchCount: matches.length };
      }
    }
    return { status: "missing", el: null, matchedSelector: "", matchCount: 0 };
  }

  // ── Guided walkthrough (arm → highlight → detect the user's action) ─────
  let armedStep = null, armedEl = null;
  let guideBox = null, guideTip = null;
  let walkLastPing = 0, walkWatch = null, repoQueued = false;

  function stepTip(step) {
    return `${step.n ? step.n + ". " : ""}${String(step.text || "").replace(/\*\*/g, "")}`;
  }

  // Shared overlay arming: highlight el for step, watch for the user's action
  // (checkWalkMatch), keep the deadman ticking. Used by the walkthrough and by
  // Autopilot's staged-confirm and human-gate states.
  function armOverlay(step, el, tip, newMode) {
    armedStep = step;
    armedEl = el;
    mode = newMode;

    guideBox = document.createElement("div");
    guideBox.className = "paper-trail-guide-box";
    guideTip = document.createElement("div");
    guideTip.className = "paper-trail-guide-tip";
    guideTip.textContent = tip;
    document.documentElement.appendChild(guideBox);
    document.documentElement.appendChild(guideTip);
    placeGuide();
    try { armedEl.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}

    window.addEventListener("scroll", repositionGuide, true);
    window.addEventListener("resize", repositionGuide);
    walkLastPing = Date.now();
    // Deadman switch: if the side panel stops pinging (closed, crashed),
    // clear the overlay rather than haunting the page. Also re-glue the box
    // through layout shifts the scroll/resize events don't cover.
    walkWatch = setInterval(() => {
      if (Date.now() - walkLastPing > 20000) walkCleanup();
      else repositionGuide();
    }, 1000);
  }

  function walkArm(step) {
    walkCleanup();
    const r = resolveStep(step);
    if (!r.el) return { armed: false, status: r.status, matchCount: r.matchCount };
    armOverlay(step, r.el, stepTip(step), "walkthrough");
    return { armed: true, via: r.status === "found" ? "selector" : "label" };
  }

  function walkCleanup() {
    if (guideBox) guideBox.remove();
    if (guideTip) guideTip.remove();
    guideBox = guideTip = null;
    armedStep = null;
    armedEl = null;
    window.removeEventListener("scroll", repositionGuide, true);
    window.removeEventListener("resize", repositionGuide);
    if (walkWatch) { clearInterval(walkWatch); walkWatch = null; }
    if (mode === "walkthrough" || mode === "autopilot") mode = "idle";
  }

  function repositionGuide() {
    if (repoQueued) return;
    repoQueued = true;
    requestAnimationFrame(() => { repoQueued = false; placeGuide(); });
  }

  function placeGuide() {
    if (!guideBox || !armedEl || !armedEl.isConnected) return;
    const r = armedEl.getBoundingClientRect();
    guideBox.style.left = (r.left + scrollX - 4) + "px";
    guideBox.style.top = (r.top + scrollY - 4) + "px";
    guideBox.style.width = (r.width + 8) + "px";
    guideBox.style.height = (r.height + 8) + "px";
    guideTip.style.left = Math.max(4, r.left + scrollX) + "px";
    const above = r.top + scrollY - guideTip.offsetHeight - 12;
    guideTip.style.top = (above > scrollY ? above : r.bottom + scrollY + 12) + "px";
  }

  // Did this event complete the armed step? Identity first, then selector,
  // then label+kind — the same anchors, in decreasing order of trust.
  function checkWalkMatch(e, evType) {
    if (!armedStep) return;
    const t = armedStep.type;
    const typeOk =
      (evType === "click" && t === "click") ||
      (evType === "change" && (t === "input" || t === "select")) ||
      (evType === "key" && t === "key");
    if (!typeOk) return;

    const raw = e.target;
    const el = raw.closest ? (raw.closest(INTERACTIVE) || raw) : raw;
    let via = "";
    if (armedEl && (raw === armedEl || el === armedEl ||
        (armedEl.contains && armedEl.contains(raw)) ||
        (el.contains && el.contains(armedEl)))) {
      via = "element";
    }
    if (!via) {
      for (const sel of PTCommon.anchorList(armedStep)) {
        try { if (el.matches && el.matches(sel)) { via = "selector"; break; } } catch (err) {}
      }
    }
    if (!via) {
      const d = labelKindFor(raw);
      if (PTCommon.labelMatches(d.label, armedStep.label) &&
          (!armedStep.kind || !d.kind || d.kind === armedStep.kind)) via = "label";
    }
    if (!via) return;

    const stepId = armedStep.id;
    const keepMode = mode; // stay in walkthrough/autopilot until the panel disarms or re-arms
    if (evType === "click" && e.clientX) ripple(e.clientX, e.clientY);
    walkCleanup();
    mode = keepMode;
    try { chrome.runtime.sendMessage({ evt: "walkStepDone", stepId, via }); } catch (err) {}
  }

  // Degraded "show me" mode for stale anchors: flash everything whose label
  // contains the recorded text.
  function walkHighlightByText(label) {
    const want = PTCommon.normLabel(label);
    if (!want) return 0;
    let count = 0;
    for (const c of document.querySelectorAll(INTERACTIVE)) {
      if (count >= 12) break;
      if (!isVisible(c)) continue;
      if (PTCommon.normLabel(labelKindFor(c).label).includes(want)) {
        c.classList.add("paper-trail-text-hit");
        count++;
      }
    }
    if (count) setTimeout(() => {
      document.querySelectorAll(".paper-trail-text-hit")
        .forEach(x => x.classList.remove("paper-trail-text-hit"));
    }, 6000);
    return count;
  }

  // ── Autopilot executor ──────────────────────────────────────────────────
  // Performs one recorded step on this page. Safety rules (see docs/DESIGN):
  //  · anchors only — resolveStep(step, true) never label-guesses an element
  //  · masked steps (and gate:true steps whose value the panel doesn't have)
  //    are NEVER executed: the human performs them under the guide overlay,
  //    detected by checkWalkMatch exactly like a walkthrough step
  //  · confirm:true only stages (highlights); a second call executes
  function execStep(step, value, confirm, gate) {
    if (step.masked || gate) {
      walkCleanup();
      const r = resolveStep(step); // human guidance may use the label scan
      if (!r.el) return { failed: true, reason: "element not found for manual entry" };
      const why = step.masked ? "value is masked — Autopilot never handles it" : "no recorded value";
      armOverlay(step, r.el, `${stepTip(step)} — do this yourself now (${why})`, "autopilot");
      return { humanGate: true };
    }

    const r = resolveStep(step, true);
    if (!r.el) {
      return {
        failed: true,
        reason: r.status === "missing" ? "no recorded anchor resolves on this page" : "anchor mismatch"
      };
    }

    if (confirm) {
      walkCleanup();
      armOverlay(step, r.el, `${stepTip(step)} — ▶ in the panel runs it (or do it yourself)`, "autopilot");
      return { staged: true, via: r.matchedSelector };
    }

    walkCleanup();
    mode = "autopilot";
    try {
      performStep(r.el, step, value);
    } catch (e) {
      return { failed: true, reason: String(e.message || e) };
    }
    return { done: true, via: r.matchedSelector };
  }

  function performStep(el, step, value) {
    const val = value == null ? "" : String(value);
    switch (step.type) {
      case "click":
        el.click();
        return;
      case "input": {
        const type = (el.type || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          // A real click keeps framework listeners and label toggling intact.
          if (el.checked !== (val !== "unchecked")) el.click();
          return;
        }
        const proto = el.tagName.toLowerCase() === "textarea"
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (!desc || !desc.set) throw new Error("element does not accept a value");
        try { el.focus(); } catch (e) {}
        // Native setter so React/Vue/Angular value trackers see the change.
        desc.set.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "select": {
        let picked = null;
        for (const opt of el.options || []) {
          if (opt.value === val || PTCommon.normLabel(opt.textContent) === PTCommon.normLabel(val)) {
            picked = opt;
            break;
          }
        }
        if (!picked) throw new Error(`option "${val}" not found in the dropdown`);
        el.value = picked.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "key": {
        try { el.focus(); } catch (e) {}
        const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        return;
      }
      default:
        throw new Error("Autopilot cannot execute step type: " + step.type);
    }
  }

  window.addEventListener("pagehide", walkCleanup);

  function post(action) {
    try {
      chrome.runtime.sendMessage({
        evt: "action",
        data: Object.assign(action, {
          url: location.href,
          title: clean(document.title, 100),
          vw: window.innerWidth,
          vh: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          ts: Date.now()
        })
      });
    } catch (e) { /* extension reloaded; ignore */ }
  }

  // ── Click ripple (visual confirmation of capture) ───────────────────────
  function ripple(x, y) {
    const d = document.createElement("div");
    d.className = "paper-trail-ripple";
    d.style.left = x + "px";
    d.style.top = y + "px";
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 650);
  }

  // ── Event listeners (capture phase, so SPAs can't swallow them) ─────────
  document.addEventListener("click", (e) => {
    if (mode === "walkthrough" || mode === "autopilot") { checkWalkMatch(e, "click"); return; }
    if (mode !== "recording") return;
    if (e.clientX === 0 && e.clientY === 0 && !e.detail) return; // synthetic
    const now = Date.now();
    if (now - lastClickTs < 150) return; // double-fire guard
    lastClickTs = now;

    const info = describe(e.target);
    ripple(e.clientX, e.clientY);
    post({
      type: "click",
      label: info.label,
      kind: info.kind,
      selector: info.selector,
      anchors: info.anchors,
      x: e.clientX,
      y: e.clientY
    });
  }, true);

  document.addEventListener("change", (e) => {
    if (mode === "walkthrough" || mode === "autopilot") { checkWalkMatch(e, "change"); return; }
    if (mode !== "recording") return;
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    if (!/input|select|textarea/.test(tag)) return;

    const type = (el.type || "").toLowerCase();
    const label = labelForInput(el);
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    let value = "";
    // One sensitive-name policy with the HTTP-log masking (PTCommon.looksSecret).
    const sensitive = type === "password" || PTCommon.looksSecret(el.name) ||
                      (el.autocomplete || "").includes("cc-");
    if (tag === "select") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      value = captureValues ? clean(opt ? opt.textContent : el.value, 60) : "";
    } else if (type === "checkbox" || type === "radio") {
      value = el.checked ? "checked" : "unchecked";
    } else if (captureValues && !sensitive) {
      value = clean(el.value, 60);
    }

    const selector = cssPath(el);
    post({
      type: tag === "select" ? "select" : "input",
      label, value,
      masked: sensitive || (!captureValues && tag !== "select" && type !== "checkbox" && type !== "radio"),
      kind: tag === "select" ? "dropdown" : (type || "field"),
      selector,
      anchors: anchorsFor(el, selector),
      x: cx, y: cy
    });
  }, true);

  document.addEventListener("submit", (e) => {
    if (mode !== "recording") return;
    const f = e.target;
    const name = clean(f.getAttribute("aria-label") || f.name || f.id || "form", 60);
    post({ type: "submit", label: name, kind: "form", x: 0, y: 0 });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    if (tag === "textarea" && !e.ctrlKey) return; // Enter in textarea is just a newline
    if (mode === "walkthrough" || mode === "autopilot") { checkWalkMatch(e, "key"); return; }
    if (mode !== "recording") return;
    const selector = cssPath(el);
    post({
      type: "key",
      label: labelForInput(el),
      value: "Enter",
      kind: "field",
      selector,
      anchors: anchorsFor(el, selector),
      x: 0, y: 0
    });
  }, true);
})();
