// Paper Trail — shared IndexedDB module.
// Loaded by BOTH the service worker (importScripts) and the side panel
// (<script>), so it must stay a plain script exposing one global: PTDB.
// Contract: the panel owns long-running flows; the worker only performs
// short transactional bursts so MV3 eviction can never strand a write.

const PTDB = (() => {
  const DB_NAME = "paper-trail";
  const DB_VERSION = 1;
  const LIVE_REC_ID = "live"; // reserved recId for the in-progress session's shots

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("recordings")) {
          const r = db.createObjectStore("recordings", { keyPath: "id" });
          r.createIndex("byCreated", "createdAt");
        }
        if (!db.objectStoreNames.contains("shots")) {
          const s = db.createObjectStore("shots", { keyPath: "stepId" });
          s.createIndex("byRec", "recId");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Never hold a version upgrade hostage from the other context.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  const prom = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  // Open-per-call: cheap, and avoids stale connections across SW restarts.
  // fn(tx) may only await IDB requests from this tx (anything else commits it).
  async function withTx(stores, mode, fn) {
    const db = await open();
    try {
      const tx = db.transaction(stores, mode);
      const out = await fn(tx);
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
      });
      return out;
    } finally {
      db.close();
    }
  }

  // ── Recordings ────────────────────────────────────────────────────────────

  function saveRecording(rec) {
    return withTx("recordings", "readwrite", (tx) => prom(tx.objectStore("recordings").put(rec)));
  }

  async function listRecordings() {
    const all = await withTx("recordings", "readonly", (tx) => prom(tx.objectStore("recordings").getAll()));
    return all
      .map(({ steps, ...meta }) => meta) // metadata only — never ship step arrays to a list view
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getRecording(id) {
    return withTx("recordings", "readonly", (tx) => prom(tx.objectStore("recordings").get(id)));
  }

  async function renameRecording(id, title) {
    return withTx("recordings", "readwrite", async (tx) => {
      const store = tx.objectStore("recordings");
      const rec = await prom(store.get(id));
      if (!rec) return null;
      rec.title = title;
      rec.updatedAt = Date.now();
      await prom(store.put(rec));
      return rec;
    });
  }

  function deleteRecording(id) {
    return withTx(["recordings", "shots"], "readwrite", async (tx) => {
      await prom(tx.objectStore("recordings").delete(id));
      await eachByRec(tx, id, (cursor) => cursor.delete());
    });
  }

  // ── Shots (screenshots as Blobs, keyed by the step's UUID) ────────────────

  function putShot(shot) {
    // shot: { stepId, recId, blob }
    return withTx("shots", "readwrite", (tx) => prom(tx.objectStore("shots").put(shot)));
  }

  function getShot(stepId) {
    return withTx("shots", "readonly", (tx) => prom(tx.objectStore("shots").get(stepId)));
  }

  function getShotsByRec(recId) {
    return withTx("shots", "readonly", (tx) =>
      prom(tx.objectStore("shots").index("byRec").getAll(recId)));
  }

  function deleteShot(stepId) {
    return withTx("shots", "readwrite", (tx) => prom(tx.objectStore("shots").delete(stepId)));
  }

  function deleteShotsByRec(recId) {
    return withTx("shots", "readwrite", (tx) => eachByRec(tx, recId, (cursor) => cursor.delete()));
  }

  // Move the live session's shots under a saved recording without copying bytes.
  function reassignShots(fromRecId, toRecId) {
    return withTx("shots", "readwrite", (tx) => eachByRec(tx, fromRecId, (cursor) => {
      const v = cursor.value;
      v.recId = toRecId;
      cursor.update(v);
    }));
  }

  function eachByRec(tx, recId, visit) {
    return new Promise((res, rej) => {
      const req = tx.objectStore("shots").index("byRec").openCursor(recId);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return res();
        visit(cursor);
        cursor.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }

  async function estimateSize(recId) {
    const [rec, shots] = await Promise.all([getRecording(recId), getShotsByRec(recId)]);
    const meta = rec ? JSON.stringify(rec).length : 0;
    return meta + shots.reduce((n, s) => n + (s.blob ? s.blob.size : 0), 0);
  }

  return {
    LIVE_REC_ID,
    saveRecording, listRecordings, getRecording, renameRecording, deleteRecording,
    putShot, getShot, getShotsByRec, deleteShot, deleteShotsByRec,
    reassignShots, estimateSize
  };
})();
