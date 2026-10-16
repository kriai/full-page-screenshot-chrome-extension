// End-to-end: where screenshots are kept. Images belong in the IndexedDB image
// store (image-store.js); chrome.storage.local holds only small metadata.
// They used to be base64 strings in chrome.storage.local, rewritten on every
// annotation edit. Run with: npm run test:e2e.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { capture, extensionUrl, launch, startServer, waitForEditor } from "./harness.mjs";

const TIMEOUT = 120000;
let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
});

async function withHarness(fn) {
  const harness = await launch();
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

async function openFixture(harness, name) {
  const page = await harness.context.newPage();
  await page.goto(`${server.origin}/test/fixtures/${name}.html`);
  return page;
}

// Everything the worker can see about storage, in one call.
function storageState(harness) {
  return harness.worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const images = await FpsImages.list();
    return {
      localBytes: JSON.stringify(local).length,
      history: local.history || [],
      capture: local.capture || null,
      legacyKeys: Object.keys(local).filter((key) => key.startsWith("captureImage:")),
      images,
    };
  });
}

// Poll the worker until `check` passes or time runs out.
async function eventually(harness, check, timeout = 15000) {
  const until = Date.now() + timeout;
  let state;
  for (;;) {
    state = await storageState(harness);
    if (check(state)) return state;
    if (Date.now() > until) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("storage", { concurrency: true }, () => {
  it("a full-page capture is stored as an image, not as text", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      const page = await openFixture(harness, "document-scroll");
      const result = await capture(harness, page, {});
      assert.equal(result.error, null);
      const state = await storageState(harness);
      const [entry] = state.history;
      assert.ok(entry?.imageKey && entry.baseKey && entry.thumbKey, "history entry without image keys");
      assert.equal(entry.dataUrl, undefined);
      const keys = new Set(state.images.map((image) => image.key));
      for (const key of [entry.imageKey, entry.thumbKey]) assert.ok(keys.has(key), `${key} not stored`);
      assert.equal(state.images.filter((image) => image.key.startsWith("frame:")).length, 0, "frames left behind");
      assert.ok(state.localBytes < 50000, `chrome.storage.local holds ${state.localBytes} bytes`);
    })
  );

  it("the editor stitches from stored frames when the worker cannot, then deletes them", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      await harness.worker.evaluate(() => {
        IncrementalStitcher.prototype.finish = async () => {
          throw new Error("forced by the test");
        };
      });
      const page = await openFixture(harness, "document-scroll");
      const result = await capture(harness, page, { keepEditor: true });
      assert.equal(result.error, null);
      assert.equal(result.prestitched, null, "the forced failure did not reach the fallback path");
      const editor = await waitForEditor(harness);
      assert.match(await editor.textContent("#dimensions"), /^1280 × 72\d\d$/);
      const state = await eventually(
        harness,
        (s) => s.history.length === 1 && !s.capture && !s.images.some((image) => image.key.startsWith("frame:"))
      );
      assert.equal(state.history.length, 1, "the editor did not save the capture to history");
      assert.equal(state.capture, null, "the handed-over capture was not cleared");
      assert.equal(state.images.filter((image) => image.key.startsWith("frame:")).length, 0, "frames left behind");
    })
  );

  it("saving annotations keeps the original and writes only metadata to storage", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      const page = await openFixture(harness, "document-scroll");
      await capture(harness, page, { keepEditor: true });
      const editor = await waitForEditor(harness);
      await editor.evaluate(async () => {
        editor.operations.push({ type: "rect", color: "#ff0000", size: 4, rect: { x: 40, y: 40, w: 200, h: 120 } });
        await saveRenderedProjectToHistory(renderFinalCanvas());
      });
      const state = await storageState(harness);
      const [entry] = state.history;
      assert.notEqual(entry.imageKey, entry.baseKey, "the annotated render overwrote the original");
      const keys = new Set(state.images.map((image) => image.key));
      assert.ok(keys.has(entry.imageKey) && keys.has(entry.baseKey));
      assert.equal(entry.project.baseDataUrl, undefined, "the project still carries the image inline");
      assert.equal(entry.project.operations.length, 1);
      assert.ok(state.localBytes < 50000, `chrome.storage.local holds ${state.localBytes} bytes`);
    })
  );

  it("the history page shows thumbnails and reopens an entry in the editor", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      const page = await openFixture(harness, "document-scroll");
      await capture(harness, page, {});
      const [entry] = (await storageState(harness)).history;
      const history = await harness.context.newPage();
      await history.goto(extensionUrl(harness, "history.html"));
      await history.waitForFunction(() => {
        const img = document.querySelector("img.thumb");
        return img && img.complete && img.naturalWidth > 0;
      });
      await history.click(".actions button[title='Open saved screenshot in the editor']");
      const editor = await waitForEditor(harness);
      assert.equal(await editor.textContent("#dimensions"), `${entry.width} × ${entry.height}`);
    })
  );

  it("history saved by an older version is moved into the image store", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      const outcome = await harness.worker.evaluate(async () => {
        const png = async (color) => {
          const canvas = new OffscreenCanvas(40, 30);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 40, 30);
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
          return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
        };
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          history: [
            {
              baseName: "inline",
              savedAt: 1,
              width: 40,
              height: 30,
              dataUrl: await png("red"),
              project: { version: 1, baseDataUrl: await png("blue"), operations: [], layout: {} },
            },
            { baseName: "keyed", savedAt: 2, width: 40, height: 30, imageKey: "captureImage:2:1" },
          ],
          "captureImage:2:1": await png("green"),
        });
        await FpsImages.migrateLegacyHistory();
        const local = await chrome.storage.local.get(null);
        const blobs = {};
        for (const entry of local.history) {
          for (const key of FpsImages.entryKeys(entry)) blobs[key] = (await FpsImages.get(key))?.size || 0;
        }
        return { local, blobs };
      });
      const { local, blobs } = outcome;
      assert.equal(local.imageStoreVersion, 1);
      assert.equal(local["captureImage:2:1"], undefined, "the old storage key was left behind");
      assert.equal(local.history.length, 2);
      for (const entry of local.history) {
        assert.equal(entry.dataUrl, undefined);
        assert.equal(entry.project?.baseDataUrl, undefined);
        assert.ok(blobs[entry.imageKey] > 0 && blobs[entry.baseKey] > 0, `${entry.baseName} lost its image`);
      }
      assert.notEqual(local.history[0].imageKey, local.history[0].baseKey, "the annotated and original images merged");
    })
  );

  it("images nothing refers to are swept, live ones kept", { timeout: TIMEOUT }, () =>
    withHarness(async (harness) => {
      const page = await openFixture(harness, "document-scroll");
      await capture(harness, page, {});
      const after = await harness.worker.evaluate(async () => {
        await FpsImages.put("frame:abandoned:0", new Blob(["x"]));
        await FpsImages.sweepOrphans({ ageMs: 0 });
        return (await FpsImages.list()).map((image) => image.key);
      });
      const [entry] = (await storageState(harness)).history;
      assert.ok(!after.includes("frame:abandoned:0"), "the orphaned frame survived");
      assert.ok(after.includes(entry.imageKey), "a live image was swept");
    })
  );
});
