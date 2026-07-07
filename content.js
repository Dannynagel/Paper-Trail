// Paper Trail — content script
// Captures semantic user actions (what was actually clicked/typed, by label)
// and reports them to the service worker. No pixels are read here; the
// worker takes the screenshot. Values are masked by default.

(() => {
  if (window.__paperTrailLoaded) return;
  window.__paperTrailLoaded = true;

  let recording = false;
  let captureValues = false;
  let lastClickTs = 0;

  // ── Recording state sync ────────────────────────────────────────────────
  chrome.runtime.sendMessage({ cmd: "isRecording" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp) { recording = !!resp.recording; captureValues = !!resp.captureValues; }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.evt === "recordingState") {
      recording = !!msg.recording;
      captureValues = !!msg.captureValues;
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

  function describe(target) {
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
    return { label: label || "(unlabeled)", kind, tag, selector: cssPath(el) };
  }

  // Robust selector for RPA replay: id → test attrs → name/aria → short structural path.
  function cssPath(el) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
      const anchors = ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"];
      for (const a of anchors) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) {
          const sel = `${el.tagName.toLowerCase()}[${a}="${v.replace(/"/g, '\\"')}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
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
    } catch (e) { return ""; }
  }

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
    if (!recording) return;
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
      x: e.clientX,
      y: e.clientY
    });
  }, true);

  document.addEventListener("change", (e) => {
    if (!recording) return;
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    if (!/input|select|textarea/.test(tag)) return;

    const type = (el.type || "").toLowerCase();
    const label = labelForInput(el);
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    let value = "";
    const sensitive = type === "password" || /pass|secret|token|key|ssn|card/i.test(el.name || "") ||
                      (el.autocomplete || "").includes("cc-");
    if (tag === "select") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      value = captureValues ? clean(opt ? opt.textContent : el.value, 60) : "";
    } else if (type === "checkbox" || type === "radio") {
      value = el.checked ? "checked" : "unchecked";
    } else if (captureValues && !sensitive) {
      value = clean(el.value, 60);
    }

    post({
      type: tag === "select" ? "select" : "input",
      label, value,
      masked: sensitive || (!captureValues && tag !== "select" && type !== "checkbox" && type !== "radio"),
      kind: tag === "select" ? "dropdown" : (type || "field"),
      selector: cssPath(el),
      x: cx, y: cy
    });
  }, true);

  document.addEventListener("submit", (e) => {
    if (!recording) return;
    const f = e.target;
    const name = clean(f.getAttribute("aria-label") || f.name || f.id || "form", 60);
    post({ type: "submit", label: name, kind: "form", x: 0, y: 0 });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!recording) return;
    if (e.key !== "Enter") return;
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    if (tag === "textarea" && !e.ctrlKey) return; // Enter in textarea is just a newline
    post({
      type: "key",
      label: labelForInput(el),
      value: "Enter",
      kind: "field",
      x: 0, y: 0
    });
  }, true);
})();
