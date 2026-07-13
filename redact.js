// Paper Trail — Redaction brush: black out parts of a stored screenshot
// before it is exported or shared. Applying flattens the rectangles into the
// JPEG and replaces the blob in the shots store AT THE SAME stepId, so every
// consumer (ledger, library, exports, packs, evidence) picks it up — and the
// original pixels are gone for good, which is the point.
//
// The core is pure (blob in → blob out) so tests can drive it headlessly.

function redactBlob(blob, rects) {
  return createImageBitmap(blob).then((bmp) => {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    ctx.fillStyle = "#000";
    for (const r of rects || []) {
      const w = Math.abs(r.w), h = Math.abs(r.h);
      if (!w || !h) continue;
      ctx.fillRect(Math.min(r.x, r.x + r.w), Math.min(r.y, r.y + r.h), w, h);
    }
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  });
}

async function openRedactor(stepId, onApplied) {
  if (document.getElementById("redactModal")) return;
  const shot = await PTDB.getShot(stepId).catch(() => null);
  if (!shot || !shot.blob) return;
  let bmp;
  try { bmp = await createImageBitmap(shot.blob); } catch (e) { return; }

  const wrap = document.createElement("div");
  wrap.id = "redactModal";
  wrap.style.cssText = "position:fixed;inset:0;background:rgba(8,10,14,.85);z-index:1000;" +
    "display:flex;flex-direction:column;padding:10px;gap:8px";
  wrap.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;color:#DEE4EC;font:12px system-ui">
      <b>🖌 Redact</b>
      <span style="flex:1">drag to black out areas — Apply replaces the screenshot permanently</span>
      <button id="redactUndo" class="ghost">↶ Undo</button>
      <button id="redactApply" class="primary">Apply</button>
      <button id="redactCancel" class="ghost">Cancel</button>
    </div>
    <div style="flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center">
      <canvas id="redactCanvas" style="max-width:100%;cursor:crosshair"></canvas>
    </div>`;
  document.body.appendChild(wrap);

  const canvas = wrap.querySelector("#redactCanvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  const rects = [];
  let drag = null;

  const paintRect = (r) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(Math.min(r.x, r.x + r.w), Math.min(r.y, r.y + r.h), Math.abs(r.w), Math.abs(r.h));
  };
  // Coalesce through rAF: pointermove fires far above refresh rate and each
  // paint redraws the full bitmap.
  let paintQueued = false;
  const repaint = () => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      ctx.drawImage(bmp, 0, 0);
      for (const r of rects) paintRect(r);
      if (drag) paintRect(drag);
    });
  };
  const toImage = (e) => {
    const b = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - b.left) * (canvas.width / b.width),
      y: (e.clientY - b.top) * (canvas.height / b.height)
    };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const p = toImage(e);
    drag = { x: p.x, y: p.y, w: 0, h: 0 };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toImage(e);
    drag.w = p.x - drag.x;
    drag.h = p.y - drag.y;
    repaint();
  });
  canvas.addEventListener("pointerup", () => {
    if (drag && Math.abs(drag.w) > 3 && Math.abs(drag.h) > 3) rects.push(drag);
    drag = null;
    repaint();
  });
  repaint();

  const close = () => { bmp.close && bmp.close(); wrap.remove(); };
  wrap.querySelector("#redactCancel").addEventListener("click", close);
  wrap.querySelector("#redactUndo").addEventListener("click", () => { rects.pop(); repaint(); });
  wrap.querySelector("#redactApply").addEventListener("click", async () => {
    if (!rects.length) { close(); return; }
    if (!confirm("Permanently black out the marked areas?\nThe original screenshot cannot be recovered.")) return;
    const redacted = await redactBlob(shot.blob, rects);
    await PTDB.putShot({ stepId, recId: shot.recId, blob: redacted });
    // Invalidate the panel's object-URL cache so every view reloads the new bytes.
    if (typeof objUrlCache !== "undefined" && objUrlCache.has(stepId)) {
      URL.revokeObjectURL(objUrlCache.get(stepId));
      objUrlCache.delete(stepId);
    }
    close();
    if (typeof onApplied === "function") onApplied();
  });
}
