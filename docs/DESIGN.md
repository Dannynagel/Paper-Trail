# Paper Trail — Design Document

**Version 1.0.0 · Chrome Extension (Manifest V3) + optional Windows UIA companion**

Paper Trail converts a live browser or desktop session into (a) an illustrated Standard Operating Procedure and (b) optionally, an RPA artifact — by capturing *semantic* actions rather than video.

---

## 1. Design philosophy

### 1.1 Semantic capture over pixel capture

Screen-recording documentation tools capture pixels and reconstruct intent afterward (OCR, vision models). Paper Trail inverts this: it observes the event at its source and records ground truth.

| Question | Video pipeline | Paper Trail |
|---|---|---|
| What was clicked? | Vision-model inference | The element's actual accessible name, from the DOM / UIA tree |
| When to screenshot? | Timed interval or manual hotkey | Exactly at each action, automatically |
| Where was the click? | Unknown | Recorded coordinates, ring drawn on the frame |
| Can it drive automation? | No (no anchors) | Yes (CSS selectors, UIA AutomationIds) |

### 1.2 The privacy inversion

The default data flow sends **no pixels** to any model:

1. Capture produces two artifacts per step: a semantic record (label, kind, selector, page, URL) and a screenshot (kept local).
2. Generation sends only the semantic action log. The model writes the SOP and emits `{{screenshot_N}}` placeholder tokens.
3. At export, the extension splices the local screenshots into the tokens deterministically.

Result: a fully illustrated document from a model that never saw the screen. Two rule-bound exceptions exist (§6).

### 1.3 Zero infrastructure

No server, no build step, no frameworks, no CDN. The extension is the entire product; the UIA companion is a single PowerShell file with embedded C#.

---

## 2. Component architecture

```
+------------------------- Chrome ---------------------------+
|                                                             |
|  content.js (all frames)      sidepanel.js                  |
|  - capture-phase listeners    - step ledger UI              |
|  - label + selector extract   - window-capture engine       |
|  - ripple feedback            - generation / export         |
|          |                    - markdown renderer           |
|          v runtime messages          ^                      |
|  background.js (service worker) -----+                      |
|  - session state (storage.session)                          |
|  - captureVisibleTab + OffscreenCanvas annotation           |
|  - LLM clients (Anthropic / OpenAI / custom)                |
|  - native messaging port <--------------+                   |
+------------------------------------------|------------------+
                                           | stdio (4-byte LE + JSON)
                              PaperTrailHost.ps1 (Windows)
                              - WH_MOUSE_LL global hook
                              - UIAutomation FromPoint
                              - GDI window capture + ring
```

### 2.1 Step data model

Every capture path produces the same step shape, so the ledger, generator, and exporters are source-agnostic:

```js
{
  id, n, ts,                 // uuid + ordinal + epoch ms
  type,                      // click | input | select | key | submit | nav | manual | desktop | uia
  text,                      // humanized action; element labels wrapped in ** **
  label, kind,               // accessible name + role/control type
  value, masked,             // field value (empty when masked)
  selector,                  // web: verified CSS selector (RPA anchor)
  autoId, className, app,    // desktop-uia: UIA anchors + process name
  url, pageTitle,            // provenance
  note,                      // operator annotation (authoritative for generation)
  shot                       // JPEG data URL, local-only by default
}
```

### 2.2 Session lifecycle

The service worker owns the session and persists it to `chrome.storage.session` after every mutation, so MV3 worker restarts are lossless. On quota pressure, the oldest screenshots are dropped first — the semantic log is never sacrificed. Recording state is broadcast to all tabs, so capture follows the user across tabs and windows naturally.

---

## 3. Capture engines

### 3.1 Browser DOM (content.js)

Capture-phase listeners (`click`, `change`, `submit`, `keydown`) fire before SPAs can swallow events. Label extraction resolves in accessibility order:

`aria-label` → `aria-labelledby` → `<label for>` / wrapping `<label>` → visible text → `placeholder` / `name` / `title` / `alt`

Selector extraction (the RPA anchor) prefers stability over brevity:

`#id` → unique `[data-testid|data-test|data-qa|data-cy|name|aria-label]` (verified unique via `querySelectorAll`) → short structural path with `:nth-of-type`, capped at 6 ancestors / 240 chars

Password fields, and fields whose `name`/`autocomplete` suggests secrets or payment data, are masked unconditionally; all other values are masked unless the operator opts in.

### 3.2 Window-capture mode (sidepanel.js)

For native apps without a UIA companion. `getDisplayMedia` streams the chosen window; a 96-px grayscale sample is taken every 700 ms and compared against the previous sample. A two-state machine avoids mid-transition junk:

```
IDLE --(diff > 4.5%)--> CHANGED --(diff < 1.2%, i.e. settled)--> capture frame, cooldown 1.5 s
```

`Ctrl+Shift+9` is a `"global": true` Chrome command — it fires even while the desktop app has focus and forces a frame. These steps carry no semantics; their meaning is the frame itself.

### 3.3 UIA companion (native-host/)

The Windows UI Automation tree is treated as the desktop's DOM. A `WH_MOUSE_LL` hook (message pump on the main thread, work offloaded to the thread pool so the hook callback stays instantaneous) catches each left-click; `AutomationElement.FromPoint` yields Name, ControlType, AutomationId, and ClassName, with a 3-level ancestor walk for unlabeled elements. The foreground window is captured via GDI, downscaled to ≤1100 px, ring-annotated at the click point, and JPEG-encoded under the 1 MB native-messaging message cap.

Native messaging protocol: 4-byte little-endian length prefix + UTF-8 JSON, host → extension messages `hello`, `click`, `error`. The host exits when Chrome closes stdin.

---

## 4. Screenshot pipeline (browser steps)

`chrome.tabs.captureVisibleTab` is rate-limited by Chrome (~2/sec), so captures are serialized with a 620 ms gate. Frames are downscaled to ≤1200 px wide on an `OffscreenCanvas`, a red ring (plus outer halo) is drawn at the click point mapped from CSS-pixel to image coordinates, and the result is encoded JPEG q0.72 — a budget of roughly 120–250 KB per step against the 10 MB `storage.session` quota.

---

## 5. Generation contract

The model receives a JSON action log and must obey a strict output discipline enforced by the system prompts:

- **SOP target** - element labels are used verbatim (never "corrected"); images are referenced only via {{screenshot_N}} tokens for steps that actually have screenshots; desktop-capture steps must be described only from what is visible.
- **PowerShell target** - captured selectors/AutomationIds are used verbatim; masked values become param() parameters (secrets as [SecureString]); anchor-less steps become explicit TODO blocks, never invented anchors.
- **Automation Anywhere target** - a build sheet (A360 bot JSON is not a hand-authoring format) quoting captured object properties verbatim, preferring AutomationId / CSS anchors and never recommending coordinate or image matching when an anchor exists.

Providers: Anthropic (/v1/messages with direct-browser-access header), OpenAI (/v1/chat/completions), or any OpenAI-compatible URL (Open WebUI, Azure OpenAI via Open WebUI, vLLM, LiteLLM). Keys live in chrome.storage.local and are sent only to the configured endpoint.

---

## 6. Privacy & security model

| Data | Default | Exception |
|---|---|---|
| Semantic action log | Sent to configured model at generation | - |
| Browser/UIA screenshots | Local only; spliced at export | Operator enables "Send screenshots" |
| Window-capture frames | Attached at generation | By design: the frame is the step's only meaning |
| Typed values | Masked | Operator opt-in; secret-like fields stay masked regardless |
| RPA generation | Always text-only | None - anchors are the payload, never pixels |

Additional properties: no external CDN or third-party scripts; capture is inert unless recording is on; the UIA companion is per-user (HKCU), launched only by Chrome/Edge native messaging with the extension's ID pinned in allowed_origins, and exits when the extension disconnects.

---

## 7. Known limits and roadmap

- chrome.storage.session bounds a session to roughly 60 illustrated steps (configurable ceiling); an IndexedDB saved-SOP library is the planned fix.
- Canvas-rendered apps (Citrix/VDI, Flutter web) expose little DOM - window-capture mode or manual captures cover them.
- Elevated (admin) windows may deny UIA reads; those clicks degrade to window title + screenshot.
- Keystroke capture is deliberately excluded from the UIA companion in v1.
- Roadmap: region redaction brush; verify mode (replay recorded anchors against the live UI to flag stale SOPs); DOCX export; team templates.
