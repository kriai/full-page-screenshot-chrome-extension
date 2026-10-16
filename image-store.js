// Screenshot storage, shared by the service worker, the editor and the history
// page. Images live in IndexedDB as Blobs; chrome.storage.local keeps only
// metadata that points at them.
//
// They used to be base64 data URLs inside chrome.storage.local: a third larger
// than the image, and every read or write moved the whole string - including
// a history write after every annotation edit, since each project carried its
// base image inline.
//
// A history entry points at up to three images:
//   baseKey   the capture as taken (img:<id>; base:<id> for migrated entries)
//   imageKey  what the entry shows and downloads: the base itself when there
//             are no annotations, otherwise an annotated render (out:<id>)
//   thumbKey  a small preview for the history page (thumb:<id>)
// and frame:<run>:<n> holds one viewport of a capture still being stitched.
(function (root) {
  const DB_NAME = "fps-images";
  const STORE = "images";
  // Orphans younger than this may belong to a save still in flight.
  const ORPHAN_AGE_MS = 10 * 60 * 1000;

  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE, { keyPath: "key" });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another context upgrading the database closes this connection;
          // the next call opens a fresh one.
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          opening = null;
          reject(request.error);
        };
      });
    }
    return opening;
  }

  async function run(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      Promise.resolve(work(tx.objectStore(STORE))).then((value) => {
        result = value;
      }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Image store transaction aborted."));
    });
  }

  const request = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  function put(key, blob) {
    return run("readwrite", (store) => {
      store.put({ key, blob, createdAt: Date.now() });
    });
  }

  async function getRecord(key) {
    if (!key) return null;
    return run("readonly", (store) => request(store.get(key)));
  }

  // The Blob for a key. A key that predates the move to IndexedDB may still
  // hold a data URL in chrome.storage.local; it is moved across on first read.
  async function get(key) {
    if (!key) return null;
    const record = await getRecord(key);
    if (record) return record.blob;
    if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
    const legacy = (await chrome.storage.local.get(key))[key];
    if (typeof legacy !== "string" || !legacy.startsWith("data:")) return null;
    const blob = await blobFromDataUrl(legacy);
    await put(key, blob);
    await chrome.storage.local.remove(key);
    return blob;
  }

  function remove(keys) {
    const list = [...new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))];
    if (!list.length) return Promise.resolve();
    return run("readwrite", (store) => {
      for (const key of list) store.delete(key);
    });
  }

  function list() {
    return run("readonly", (store) =>
      new Promise((resolve, reject) => {
        const out = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return resolve(out);
          out.push({ key: at.value.key, createdAt: at.value.createdAt || 0, size: at.value.blob?.size || 0 });
          at.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      })
    );
  }

  async function blobFromDataUrl(dataUrl) {
    return (await fetch(dataUrl)).blob();
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // A preview for the history grid: the top of the image at card width. The
  // history page used to decode every full screenshot - a 30,000px capture is
  // over 100MB of pixels - just to show a few hundred of them.
  async function makeThumbnail(blob, width = 480, maxHeight = 960) {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, width / bitmap.width);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const sourceHeight = Math.min(bitmap.height, Math.round(maxHeight / scale));
      const h = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, w, h);
      return canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    } finally {
      bitmap.close();
    }
  }

  // Every image key a history entry owns.
  function entryKeys(entry) {
    return [
      entry?.imageKey,
      entry?.baseKey,
      entry?.thumbKey,
      ...(entry?.parts || []).flatMap((part) => [part.imageKey, part.outKey]),
    ].filter(Boolean);
  }

  // One-time move of history saved by earlier versions. Each entry could hold
  // its image inline (`dataUrl`), under a chrome.storage.local key
  // (`imageKey`), and its unannotated base inside the project
  // (`project.baseDataUrl`). Keys are derived from the entry, so two contexts
  // migrating at once write the same thing.
  async function migrateLegacyHistory() {
    const { history = [], imageStoreVersion = 0 } = await chrome.storage.local.get([
      "history",
      "imageStoreVersion",
    ]);
    if (imageStoreVersion >= 1) return { migrated: 0 };

    let migrated = 0;
    const next = [];
    for (let i = 0; i < history.length; i++) {
      const entry = { ...history[i] };
      const id = entry.id || `legacy-${entry.savedAt || 0}-${i}`;
      entry.id = id;
      try {
        if (typeof entry.dataUrl === "string" && entry.dataUrl.startsWith("data:")) {
          entry.imageKey = `img:${id}`;
          await put(entry.imageKey, await blobFromDataUrl(entry.dataUrl));
          migrated++;
        } else if (entry.imageKey) {
          // get() moves a chrome.storage.local image across as it reads it.
          await get(entry.imageKey);
          migrated++;
        }
        delete entry.dataUrl;

        if (entry.project?.baseDataUrl) {
          entry.baseKey = `base:${id}`;
          await put(entry.baseKey, await blobFromDataUrl(entry.project.baseDataUrl));
          const { baseDataUrl: _moved, ...project } = entry.project;
          entry.project = project;
        } else if (!entry.baseKey) {
          entry.baseKey = entry.imageKey;
        }
        if (entry.imageKey) next.push(entry);
      } catch (err) {
        // One unreadable entry must not cost the rest of the history.
        console.warn("Could not migrate a saved screenshot:", err);
      }
    }
    await chrome.storage.local.set({ history: next, imageStoreVersion: 1 });
    return { migrated };
  }

  // Images nothing points at any more: frames of a capture whose service
  // worker died mid-run, a save interrupted halfway. Young ones are left
  // alone, since they may belong to a save in progress.
  async function sweepOrphans({ ageMs = ORPHAN_AGE_MS } = {}) {
    const { history = [], capture } = await chrome.storage.local.get(["history", "capture"]);
    const live = new Set(history.flatMap(entryKeys));
    if (capture) {
      for (const key of [capture.imageKey, capture.baseKey]) if (key) live.add(key);
      for (const frame of capture.frames || []) if (frame.key) live.add(frame.key);
      for (const part of capture.parts || []) if (part.imageKey) live.add(part.imageKey);
    }
    const now = Date.now();
    const stale = (await list())
      .filter((item) => !live.has(item.key) && now - item.createdAt >= ageMs)
      .map((item) => item.key);
    await remove(stale);
    return { removed: stale.length };
  }

  root.FpsImages = {
    put,
    get,
    remove,
    list,
    newId,
    blobFromDataUrl,
    makeThumbnail,
    entryKeys,
    migrateLegacyHistory,
    sweepOrphans,
  };
})(globalThis);
