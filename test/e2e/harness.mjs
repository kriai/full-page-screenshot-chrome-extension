// Drives the real extension in Chromium: load the test build, open a page,
// run a capture through the service worker, and read the row codes (see
// test/fixtures/rows.js) back out of the finished image.
//
// Shared by the end-to-end tests and scripts/benchmark.mjs.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { TEST_EXTENSION_DIR } from "../../scripts/test-build.mjs";

export const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

// Serves the repo root, so fixtures load the same way they do when served by
// hand with `python3 -m http.server`.
export async function startServer(root = REPO_ROOT) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function launch({ deviceScaleFactor = 1, viewport = { width: 1280, height: 800 } } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "fps-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The "chromium" channel is full Chromium in new headless mode; the
    // default headless shell cannot load extensions.
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport,
    args: [
      // Playwright's own scale emulation does not reach captureVisibleTab,
      // which records the real compositor output; this flag does.
      `--force-device-scale-factor=${deviceScaleFactor}`,
      `--disable-extensions-except=${TEST_EXTENSION_DIR}`,
      `--load-extension=${TEST_EXTENSION_DIR}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(installRecorder);
  return {
    context,
    worker,
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// Runs inside the service worker. background.js declares its functions at the
// top level of a classic worker script, so they are globals and can be
// wrapped: this keeps what the capture handed to saveCapture, which the
// viewer would otherwise consume and delete.
function installRecorder() {
  if (globalThis.__e2eRecorder) return;
  globalThis.__e2eRecorder = true;
  const original = saveCapture;
  // eslint-disable-next-line no-global-assign
  saveCapture = async (tab, capture) => {
    globalThis.__e2eLast = {
      mode: capture.mode,
      frames: capture.frames?.length || 0,
      truncated: capture.truncated || null,
      diagnostics: capture.diagnostics || null,
      // Single-viewport modes hand over one raw frame instead of a stitch.
      frameDataUrl: capture.frames?.length === 1 ? capture.frames[0].dataUrl : null,
      prestitched: capture.prestitched
        ? {
            dataUrl: capture.prestitched.dataUrl,
            width: capture.prestitched.width,
            height: capture.prestitched.height,
            downscaled: capture.prestitched.downscaled,
            gaps: capture.prestitched.gaps,
            shell: capture.prestitched.shell,
          }
        : null,
    };
    return original(tab, capture);
  };
}

/**
 * Capture `page` the way the toolbar would.
 * `pick` is called if the scroll-area picker comes up, for pages where the
 * extension asks which pane to capture. Without it, a picker would wait for a
 * click forever.
 */
export async function capture(harness, page, { mode = "fullPage", options = {}, diagnostics = false, pick } = {}) {
  await page.bringToFront();
  const url = page.url();
  const running = harness.worker.evaluate(
    async ({ url, mode, options, diagnostics }) => {
      await chrome.storage.local.set({ captureDiagnostics: diagnostics });
      globalThis.__e2eLast = null;
      const tabs = await chrome.tabs.query({ active: true });
      const tab = tabs.find((t) => t.url === url) || tabs[0];
      const startedAt = Date.now();
      let error = null;
      try {
        await capturePage(tab, mode, options);
      } catch (err) {
        error = err?.message || String(err);
      }
      return { ...(globalThis.__e2eLast || {}), error, durationMs: Date.now() - startedAt };
    },
    { url, mode, options, diagnostics }
  );

  if (pick) {
    const picker = page.locator('div[data-fps-ui="1"][style*="crosshair"]');
    const shown = await Promise.race([
      picker.waitFor({ timeout: 20000 }).then(() => true, () => false),
      running.then(() => false, () => false),
    ]);
    if (shown) await pick(page);
  }

  const result = await running;
  // The editor opens in a new tab; close it so the next capture starts from
  // the page under test.
  for (const other of harness.context.pages()) {
    if (other !== page && other.url().startsWith("chrome-extension://")) await other.close();
  }
  return result;
}

// Runs inside the service worker: decode the stitched PNG and return the row
// code under every image row, run-length encoded.
async function decodeRowsInWorker(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const CELLS = 24;
  const INDEX_BITS = 13;
  const CHECK_BITS = 7;
  const isBlack = (d, i) => d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90;
  const isWhite = (d, i) => d[i] > 170 && d[i + 1] > 170 && d[i + 2] > 170;

  // Decode the code whose first (black) cell starts at x, or return -1.
  function decodeAt(d, x) {
    let run = 0;
    while (x + run < width && isBlack(d, (x + run) * 4)) run++;
    if (run < 2 || run > 12) return -1;
    const cell = run;
    if (x + CELLS * cell > width) return -1;
    const bits = [];
    // Two samples per cell, which must agree: a real cell is one flat colour.
    for (let k = 0; k < CELLS; k++) {
      const a = Math.floor(x + (k + 0.3) * cell) * 4;
      const b = Math.floor(x + (k + 0.7) * cell) * 4;
      if (isBlack(d, a) && isBlack(d, b)) bits.push(1);
      else if (isWhite(d, a) && isWhite(d, b)) bits.push(0);
      else return -1;
    }
    if (bits[0] !== 1 || bits[1] !== 0 || bits[CELLS - 2] !== 0 || bits[CELLS - 1] !== 1) return -1;
    let index = 0;
    for (let b = 0; b < INDEX_BITS; b++) index = (index << 1) | bits[2 + b];
    let check = 0;
    for (let b = 0; b < CHECK_BITS; b++) check = (check << 1) | bits[2 + INDEX_BITS + b];
    return check === (index * 37 + 11) % 128 ? index : -1;
  }

  const runs = [];
  let lastX = -1;
  const STRIP = 256;
  for (let top = 0; top < height; top += STRIP) {
    const rows = Math.min(STRIP, height - top);
    const data = ctx.getImageData(0, top, width, rows).data;
    for (let r = 0; r < rows; r++) {
      const line = data.subarray(r * width * 4, (r + 1) * width * 4);
      let index = lastX >= 0 ? decodeAt(line, lastX) : -1;
      if (index < 0) {
        for (let x = 0; x < width - CELLS * 2; x++) {
          if (!isBlack(line, x * 4) || (x > 0 && isBlack(line, (x - 1) * 4))) continue;
          index = decodeAt(line, x);
          if (index >= 0) {
            lastX = x;
            break;
          }
        }
      }
      const y = top + r;
      const prev = runs[runs.length - 1];
      if (index < 0) continue;
      if (prev && prev.index === index && prev.bottom === y) prev.bottom = y + 1;
      else runs.push({ index, top: y, bottom: y + 1 });
    }
  }
  return { width, height, runs };
}

export async function decodeRows(harness, dataUrl) {
  return harness.worker.evaluate(decodeRowsInWorker, dataUrl);
}

/**
 * Check decoded runs against what the page holds.
 *   expected:  indices that must each appear exactly once, in order
 *   optional:  indices allowed to appear (for example rows of a small inner
 *              scroller, which only shows a window of its rows)
 *   rowHeight: device px of a whole row's code, for the height check; rows
 *              at either end and optional rows are exempt
 * Returns a list of problems; empty means the capture is right.
 */
export function verifyRows(decoded, { expected, optional = [], rowHeight, tolerance = 3 }) {
  const problems = [];
  const allowed = new Set([...expected, ...optional]);
  const seen = new Map();
  let previous = -1;
  for (const run of decoded.runs) {
    if (!allowed.has(run.index)) problems.push(`row ${run.index} should not be in the image (y ${run.top})`);
    if (seen.has(run.index)) {
      problems.push(`row ${run.index} appears twice (y ${seen.get(run.index).top} and ${run.top})`);
    } else {
      seen.set(run.index, run);
    }
    if (run.index < previous) problems.push(`row ${run.index} is out of order after row ${previous} (y ${run.top})`);
    previous = Math.max(previous, run.index);
  }
  const missing = expected.filter((index) => !seen.has(index));
  if (missing.length) problems.push(`missing rows: ${compactRanges(missing)}`);

  if (rowHeight) {
    const optionalSet = new Set(optional);
    const runs = decoded.runs;
    for (let i = 1; i < runs.length - 1; i++) {
      const run = runs[i];
      if (optionalSet.has(run.index) || optionalSet.has(runs[i - 1].index) || optionalSet.has(runs[i + 1].index)) {
        continue;
      }
      const height = run.bottom - run.top;
      if (Math.abs(height - rowHeight) > tolerance) {
        problems.push(`row ${run.index} is ${height}px tall, expected ${rowHeight} (y ${run.top})`);
      }
    }
  }
  return problems;
}

export function range(from, to) {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

function compactRanges(values) {
  const parts = [];
  for (let i = 0; i < values.length; i++) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    parts.push(i === j ? `${values[i]}` : `${values[i]}-${values[j]}`);
    i = j;
  }
  return parts.join(", ");
}
