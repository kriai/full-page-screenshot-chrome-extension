// Shared geometry helpers (also used by the viewer and the node tests).
importScripts("capture-geometry.js");

let capturePopup = null;
let popupCaptureToken = 0;
const pendingPopupCaptures = new Map();

function postToCapturePopup(message) {
  if (!capturePopup) return false;
  try {
    capturePopup.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function rejectPopupCaptures(message) {
  for (const pending of pendingPopupCaptures.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  pendingPopupCaptures.clear();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture-popup") return;
  capturePopup = port;
  port.onMessage.addListener((message) => {
    if (message?.type !== "captureViewportResult") return;
    const pending = pendingPopupCaptures.get(message.token);
    if (!pending) return;
    pendingPopupCaptures.delete(message.token);
    clearTimeout(pending.timer);
    if (message.dataUrl) pending.resolve(message.dataUrl);
    else pending.reject(new Error(message.error || "Popup capture failed."));
  });
  port.onDisconnect.addListener(() => {
    if (capturePopup !== port) return;
    capturePopup = null;
    rejectPopupCaptures("The capture popup closed.");
  });
});

function captureThroughPopup(windowId) {
  if (!capturePopup) return Promise.reject(new Error("No capture popup is connected."));
  return new Promise((resolve, reject) => {
    const token = ++popupCaptureToken;
    const timer = setTimeout(() => {
      pendingPopupCaptures.delete(token);
      reject(new Error("Popup capture timed out."));
    }, 2500);
    pendingPopupCaptures.set(token, { resolve, reject, timer });
    if (!postToCapturePopup({ type: "captureViewport", token, windowId })) {
      clearTimeout(timer);
      pendingPopupCaptures.delete(token);
      reject(new Error("The capture popup is unavailable."));
    }
  });
}

function reportCaptureProgress({ percent, label, detail, count }) {
  postToCapturePopup({
    type: "captureProgress",
    percent: Math.max(0, Math.min(100, Math.round(percent || 0))),
    label,
    detail,
    count,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "startCapture") return false;

  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      sendResponse({
        ok: false,
        error: "Open a normal http or https page first.",
      });
      return;
    }

    sendResponse({ ok: true });
    reportCaptureProgress({
      percent: message.mode === "fullPage" ? 2 : 10,
      label: message.mode === "fullPage" ? "Preparing full page" : "Preparing capture",
      detail: "Inspecting the page",
      count: "Starting",
    });
    try {
      await capturePage(tab, message.mode, message.options || {});
    } catch (err) {
      if (err?.canceled) {
        console.info("Screenshot capture canceled:", err.message);
      } else {
        console.error("Screenshot capture failed:", err);
        setTemporaryErrorBadge(tab.id, err?.message);
      }
      postToCapturePopup({
        type: "captureError",
        error: err?.message || "Capture failed.",
      });
      if (!err?.concurrent) await cleanupCaptureTab(tab.id);
    }
  })().catch((err) => {
    console.error("Unable to start screenshot capture:", err);
    sendResponse({ ok: false, error: err.message || "Capture failed." });
  });

  return true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setTemporaryErrorBadge(tabId, message) {
  updateCaptureBadge(tabId, {
    text: "ERR",
    title: message || "Capture failed",
    color: "#b4232c",
  }).catch(() => {});
  setTimeout(() => {
    clearCaptureBadge(tabId).catch(() => {});
  }, 2600);
}

async function exec(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

async function capturePage(tab, mode, options = {}) {
  if (mode === "visible") {
    await captureVisibleArea(tab);
    return;
  }
  if (mode === "selection") {
    await captureSelectedArea(tab);
    return;
  }
  await captureFullPage(tab, options);
}

async function getVisibleMetrics(tabId) {
  return exec(tabId, () => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
  }));
}

async function captureVisibleArea(tab) {
  const tabId = tab.id;
  await updateCaptureBadge(tabId, { text: "1/1", title: "Capturing the visible area" });

  reportCaptureProgress({
    percent: 20,
    label: "Capturing visible area",
    detail: "Taking the screenshot now",
    count: "1 section",
  });

  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await captureVisibleTabRateLimited(tab.windowId);
  reportCaptureProgress({
    percent: 96,
    label: "Preparing editor",
    detail: "Saving capture",
    count: "1 of 1",
  });

  await saveCapture(tab, {
    frames: [{ x: 0, y: 0, dataUrl }],
    metrics,
    mode: "visible",
  });
  reportCaptureProgress({
    percent: 100,
    label: "Capture complete",
    detail: "Opening the editor",
    count: "1 of 1",
  });
  await clearCaptureBadge(tabId);
}

async function captureSelectedArea(tab) {
  const tabId = tab.id;
  await updateCaptureBadge(tabId, { text: "SEL", title: "Drag to select an area" });

  const selection = await exec(tabId, selectViewportArea);
  if (!selection || selection.reason) {
    await clearCaptureBadge(tabId);
    if (selection?.reason) {
      await exec(tabId, showSelectionFeedback, [
        selection.reason === "too-small" ? "Selection too small" : "Selection canceled",
      ]);
    }
    return;
  }

  await updateCaptureBadge(tabId, { text: "1/1", title: "Capturing the selected area" });
  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  await saveCapture(tab, {
    cropRect: selection,
    frames: [{ x: 0, y: 0, dataUrl }],
    metrics,
    mode: "selection",
  });
  await clearCaptureBadge(tabId);
}

function selectViewportArea() {
  return new Promise((resolve) => {
    const existing = document.getElementById("__fps_selection_overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    const box = document.createElement("div");
    const hint = document.createElement("div");
    let startX = 0;
    let startY = 0;
    let active = false;
    let finished = false;

    overlay.id = "__fps_selection_overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "cursor:crosshair",
      "background:rgba(20,24,33,0.14)",
      "user-select:none",
    ].join(";");

    box.style.cssText = [
      "position:absolute",
      "display:none",
      "border:2px solid #4f7cff",
      "background:rgba(79,124,255,0.18)",
      "box-shadow:0 0 0 9999px rgba(0,0,0,0.2)",
      "box-sizing:border-box",
      "pointer-events:none",
    ].join(";");

    hint.textContent = "Drag to select an area. Esc cancels.";
    hint.style.cssText = [
      "position:absolute",
      "top:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "padding:8px 10px",
      "border-radius:6px",
      "background:#1f2328",
      "color:#fff",
      "font:13px system-ui,sans-serif",
      "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
      "pointer-events:none",
    ].join(";");

    overlay.append(box, hint);
    document.documentElement.appendChild(overlay);

    function cleanup(value) {
      if (finished) return;
      finished = true;
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    function draw(clientX, clientY) {
      const left = Math.min(startX, clientX);
      const top = Math.min(startY, clientY);
      const width = Math.abs(clientX - startX);
      const height = Math.abs(clientY - startY);
      box.style.display = "block";
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup({ reason: "cancel" });
      }
    }

    window.addEventListener("keydown", onKeyDown, true);

    overlay.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      active = true;
      startX = event.clientX;
      startY = event.clientY;
      overlay.setPointerCapture(event.pointerId);
      draw(startX, startY);
    });

    overlay.addEventListener("pointermove", (event) => {
      if (!active) return;
      event.preventDefault();
      draw(event.clientX, event.clientY);
    });

    overlay.addEventListener("pointerup", (event) => {
      if (!active) return;
      event.preventDefault();
      active = false;

      const left = Math.max(0, Math.min(startX, event.clientX));
      const top = Math.max(0, Math.min(startY, event.clientY));
      const right = Math.min(window.innerWidth, Math.max(startX, event.clientX));
      const bottom = Math.min(window.innerHeight, Math.max(startY, event.clientY));
      const width = right - left;
      const height = bottom - top;

      cleanup(width < 4 || height < 4 ? { reason: "too-small" } : { left, top, width, height });
    });
  });
}

function showSelectionFeedback(message) {
  const existing = document.getElementById("__fps_selection_feedback");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "__fps_selection_feedback";
  toast.dataset.fpsUi = "1";
  toast.textContent = message;
  toast.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:16px",
    "z-index:2147483647",
    "transform:translateX(-50%)",
    "padding:8px 10px",
    "border:1px solid rgba(255,255,255,0.12)",
    "border-radius:6px",
    "background:#1f2328",
    "color:#fff",
    "font:13px system-ui,sans-serif",
    "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
    "pointer-events:none",
  ].join(";");
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 1400);
}

// Toolbar surface: the only progress indicator that never lands in a
// screenshot, so it carries the frame loop while the on-page panel is hidden.
async function updateCaptureBadge(tabId, { text, title, color }) {
  const calls = [chrome.action.setBadgeText({ text: text ?? "", tabId })];
  if (title) calls.push(chrome.action.setTitle({ title, tabId }));
  if (color) calls.push(chrome.action.setBadgeBackgroundColor({ color, tabId }));
  await Promise.all(calls.map((call) => call.catch(() => {})));
}

async function clearCaptureBadge(tabId) {
  await Promise.all([
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}),
    chrome.action.setTitle({ title: "Capture full page screenshot", tabId }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ color: "#3f6fd8", tabId }).catch(() => {}),
  ]);
}

async function updateCaptureProgress(tabId, progress) {
  try {
    await exec(tabId, renderCaptureProgress, [progress]);
  } catch (err) {
    console.warn("Unable to update capture progress UI:", err);
  }
}

async function cleanupCaptureTab(tabId) {
  await updateCaptureProgress(tabId, { remove: true });
  await callPage(tabId, "restore", {}).catch(() => {});
}

// The panel is built once and then only its text and bar width are written.
// Rebuilding innerHTML on every update replaced the bar with a fresh node, so
// its width transition never had a previous value to animate from.
function renderCaptureProgress(progress) {
  const id = "__fps_progress_overlay";
  const existing = document.getElementById(id);

  if (progress.remove) {
    if (existing) existing.remove();
    return;
  }

  // Fade out rather than snap: the panel stays in the DOM (fixed, no pointer
  // events, no layout impact) so the next show does not rebuild it.
  if (progress.hidden) {
    if (existing) existing.style.opacity = "0";
    return;
  }

  const overlay = existing || document.createElement("div");
  if (!existing) {
    overlay.id = id;
    overlay.dataset.fpsUi = "1";
    overlay.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483647",
      "width:260px",
      "padding:14px",
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:10px",
      "background:rgba(24,27,34,0.94)",
      "box-shadow:0 18px 50px rgba(0,0,0,0.35)",
      "color:#fff",
      "font:13px system-ui,sans-serif",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 120ms ease",
    ].join(";");
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;">
        <strong data-fps-part="label" style="font-size:13px;font-weight:700;"></strong>
        <span data-fps-part="count" style="color:#b9c2d0;font-size:12px;"></span>
      </div>
      <div data-fps-part="detail" style="margin:-4px 0 10px;color:#b9c2d0;font-size:12px;line-height:1.35;"></div>
      <div style="height:7px;overflow:hidden;border-radius:999px;background:#343946;">
        <div data-fps-part="bar" style="height:100%;width:0%;border-radius:999px;background:#78a0ff;transition:width 160ms ease;"></div>
      </div>
    `;
    document.documentElement.appendChild(overlay);
    // Let the initial opacity:0 render before the fade-in is requested.
    requestAnimationFrame(() => {
      overlay.style.opacity = "1";
    });
  } else {
    overlay.style.opacity = "1";
  }

  const total = Math.max(1, progress.total || 1);
  const current = Math.min(total, Math.max(0, progress.current || 0));
  const part = (name) => overlay.querySelector(`[data-fps-part="${name}"]`);
  part("label").textContent = progress.label || "Capturing screenshot";
  part("count").textContent = `${current}/${total}`;
  part("detail").textContent = progress.detail || "Please keep this tab active.";
  part("bar").style.width = `${Math.round((current / total) * 100)}%`;
}

/* ------------------------------------------------------------------ *
 * Generic full-page capture engine
 *
 * One scroll-and-stitch loop drives every site. It works against a
 * "scroll target" that is either the document or a scrollable element,
 * and records explicit geometry for every frame so the viewer can
 * stitch without guessing.
 * ------------------------------------------------------------------ */

// Chrome rate-limits captureVisibleTab to about two calls per second, but it
// allows a couple back to back before throttling.
const MIN_CAPTURE_INTERVAL_MS = 550;
const CAPTURE_BURST = 2;
const CAPTURE_RATE_CEILING_PER_SEC = 2.2;
const CAPTURE_RATE_FLOOR_PER_SEC = 0.8;
// A quota refusal is transient, not a failed capture. Chrome can hold the gate
// closed for roughly a second after a burst, so a handful of 50ms retries was
// too short and leaked MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND to the user.
// This matches the reference extension's bounded retry window.
const CAPTURE_RETRY_LIMIT = 60;
// Budgets that stop growing/infinite pages instead of running forever.
// An infinite feed answers "are you at the bottom?" with "not any more" a
// moment later. Two short waits is enough to follow a feed that is still
// loading without adding a noticeable pause to every ordinary page.
const GROWTH_WAIT_MS = 700;
const MAX_GROWTH_CHECKS = 2;
const BUDGET = {
  maxFrames: 80,
  maxDurationMs: 180000,
  // Beyond a canvas's reach on purpose: the stitcher fits an oversized page
  // down rather than refusing it, so this is a guard against runaway infinite
  // scroll rather than a technical ceiling.
  maxContentHeight: 80000,
};

let lastCaptureAt = 0;
const activeSessions = new Map();

// Chrome's screenshot quota is a rate, not a spacing: it allows a short burst
// and then throttles. Spacing every single capture evenly leaves that burst
// unused and makes a long page feel slow for no reason, so this is a token
// bucket instead - take a token when one is there, wait only when the bucket
// is empty.
//
// The refill rate is a guess that corrects itself. Chrome does not document
// the real number and it moves with load, so a refusal narrows the estimate
// and a run of successes widens it again.
const captureRate = {
  tokens: CAPTURE_BURST,
  perSecond: 1000 / MIN_CAPTURE_INTERVAL_MS,
  goodRun: 0,
  lastRefillAt: Date.now(),
};

function isQuotaError(err) {
  return /quota|exceed|too many|MAX_CAPTURE/i.test(err?.message || "");
}

function refillCaptureTokens() {
  const now = Date.now();
  captureRate.tokens = Math.min(
    CAPTURE_BURST,
    captureRate.tokens + ((now - captureRate.lastRefillAt) * captureRate.perSecond) / 1000
  );
  captureRate.lastRefillAt = now;
}

async function captureVisibleTabRateLimited(windowId) {
  let quotaRetries = 0;
  for (;;) {
    // While the popup is open, capture from that extension page. It is both
    // the progress surface and the fastest available caller. Closing it is
    // harmless: the rejected request drops through to the worker path below.
    if (capturePopup) {
      try {
        const dataUrl = await captureThroughPopup(windowId);
        lastCaptureAt = Date.now();
        return dataUrl;
      } catch (err) {
        if (isQuotaError(err)) {
          if (++quotaRetries > CAPTURE_RETRY_LIMIT) throw err;
          await sleep(50);
          continue;
        }
      }
    }

    refillCaptureTokens();
    if (captureRate.tokens < 1) {
      await sleep(Math.ceil(((1 - captureRate.tokens) * 1000) / captureRate.perSecond) + 5);
      refillCaptureTokens();
    }
    try {
      captureRate.tokens = Math.max(0, captureRate.tokens - 1);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureAt = Date.now();
      // A long clean run means the estimate is more cautious than it needs to
      // be, but never past the documented "about two per second".
      if (++captureRate.goodRun >= 10) {
        captureRate.perSecond = Math.min(
          CAPTURE_RATE_CEILING_PER_SEC,
          captureRate.perSecond * 1.1
        );
        captureRate.goodRun = 0;
      }
      return dataUrl;
    } catch (err) {
      if (!isQuotaError(err) || ++quotaRetries > CAPTURE_RETRY_LIMIT) throw err;
      // Refused: the bucket was emptier than we thought. Slow down and drain
      // it, then try again shortly rather than sitting out a long penalty.
      captureRate.goodRun = 0;
      captureRate.tokens = 0;
      captureRate.perSecond = Math.max(CAPTURE_RATE_FLOOR_PER_SEC, captureRate.perSecond * 0.75);
      captureRate.lastRefillAt = Date.now();
      await sleep(80);
    }
  }
}

/* ------------------------------ seam repair ------------------------------ *
 * The scroll loop derives each frame's content offset from scrollTop, which
 * assumes the page moved by exactly the amount we asked for. Real pages round
 * sub-pixel scroll positions, re-anchor themselves, and settle a few rows late
 * after a lazy image finally lands. Each of those leaves a visible tear at the
 * join, and no amount of arithmetic can see it - the page reports the offset
 * it believes, not the one it rendered.
 *
 * So look at the pixels. Every frame after the first is compared against the
 * bottom of the one before it, and the vertical offset that actually lines
 * them up is folded into the running content position.
 * ------------------------------------------------------------------------ */

// How many frames may be re-taken over one capture when the join looks wrong
// beyond what a shift explains. Each costs a rate-limited screenshot, so this
// buys quality on the few bad frames without doubling a whole run.
const MAX_SEAM_RETRIES = 3;
const SEAM_RETRY_SETTLE_MS = 150;

async function decodeFrame(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Read one band of a screenshot as RGBA, squashed to SEAM.sampleWidth columns.
// Seams are horizontal, so horizontal detail is noise worth throwing away, but
// the vertical scale stays 1:1 - it is the resolution the search depends on.
function readSeamBand(bitmap, left, width, row, rows) {
  const w = FpsGeometry.SEAM.sampleWidth;
  const canvas = new OffscreenCanvas(w, rows);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, left, row, width, rows, 0, 0, w, rows);
  return ctx.getImageData(0, 0, w, rows).data;
}

// Compare the bottom of the previous frame against the region of the new frame
// that should hold the same rows. `prev` and `next` must both carry the
// geometry the page reported, uncorrected: the shift being measured is exactly
// the discrepancy between that report and the pixels.
//
// Returns null when the two frames do not overlap enough to be worth
// comparing, and a shift of 0 when they already agree or when no candidate was
// convincing enough to move a frame over.
function alignSeam(prev, prevBitmap, next, nextBitmap, scale) {
  const px = (v) => Math.round(v * scale);

  // Read the same columns from both frames. An overlay that changed width
  // between them would otherwise put different content at the same fraction of
  // each band, and the comparison would be meaningless.
  const left = Math.max(prev.source.left, next.source.left);
  const right = Math.min(
    prev.source.left + prev.source.width,
    next.source.left + next.source.width
  );
  if (right - left < 8) return null;

  // Rounding can push a band a pixel past the screenshot; clamping keeps the
  // probe off the transparent strip outside it, which would read as a
  // difference that is not there.
  const prevTop = px(prev.source.top);
  const nextTop = px(next.source.top);
  const prevHeight =
    Math.min(px(prev.source.top + prev.source.height), prevBitmap.height) - prevTop;
  const nextHeight =
    Math.min(px(next.source.top + next.source.height), nextBitmap.height) - nextTop;
  if (prevHeight < 4 || nextHeight < 4) return null;

  const probe = FpsGeometry.planSeamProbe(
    { top: prevTop, height: prevHeight, destTop: px(prev.dest.top) },
    { top: nextTop, height: nextHeight, destTop: px(next.dest.top) }
  );
  if (!probe) return null;

  const sx = px(left);
  const sw = px(right - left);
  const prevBand = readSeamBand(prevBitmap, sx, sw, probe.prevRow, probe.band);
  // Read the whole search window at once and index into it: a canvas round
  // trip per candidate shift would cost far more than the search itself.
  const windowRows = probe.band + 2 * probe.search;
  const nextBand = readSeamBand(nextBitmap, sx, sw, probe.nextRow - probe.search, windowRows);

  const width = FpsGeometry.SEAM.sampleWidth;
  const found = FpsGeometry.findSeamShift(
    (shift) =>
      FpsGeometry.meanChannelDiff(prevBand, nextBand, 0, probe.search + shift, width, probe.band),
    probe.search
  );
  return { ...found, band: probe.band, search: probe.search };
}

// Decode the frame just captured, measure how well it joins the previous one,
// and - when the join is bad in a way no shift explains - take it again. A
// screenshot caught mid-paint differs from its neighbour at every candidate
// offset; a second one, a moment later, usually does not.
//
// `shift` comes back in content px, ready to fold into the running correction.
// Seam repair is an improvement, never a requirement: anything that goes wrong
// in here leaves the frame exactly as the scroll arithmetic produced it.
async function repairSeam({ dataUrl, measured, prevMeasured, prevBitmap, retriesLeft, recapture }) {
  // `diff`/`base` stay null when the probe did not run, so a reader can tell
  // "nothing to compare" from "compared, and the seam was already clean".
  const plain = {
    dataUrl,
    bitmap: null,
    shift: 0,
    diff: null,
    base: null,
    scale: null,
    retried: false,
  };
  try {
    const bitmap = await decodeFrame(dataUrl);

    // The scale the screenshot actually came back at, read off the pixels.
    // devicePixelRatio is only the page's opinion of it, and Chrome does not
    // always honour that on hidpi displays or under a zoomed-out window. A
    // probe measured against the wrong scale reads as noise, and the viewer
    // stitches with this same ratio, so it is what the run should record.
    const scale =
      measured.viewportWidth > 0 ? bitmap.width / measured.viewportWidth : measured.dpr;
    const scaled = { ...plain, bitmap, scale: scale > 0 ? scale : null };
    if (!prevMeasured || !prevBitmap || !(scale > 0)) return scaled;

    const found = alignSeam(prevMeasured, prevBitmap, measured, bitmap, scale);
    if (!found) return scaled;
    const result = { ...found, shift: found.shift / scale, scale };

    if (found.diff <= FpsGeometry.SEAM.retryDiff || retriesLeft <= 0) {
      return { dataUrl, bitmap, ...result, retried: false };
    }

    await sleep(SEAM_RETRY_SETTLE_MS);
    const retry = await recapture();
    // Every offset recorded for this frame was measured at a particular scroll
    // position. If the page has moved since, the replacement shows different
    // rows than the geometry describes, and a better-looking seam would just
    // be a coincidence dressed up as a fix.
    if (!retry.settled) return { dataUrl, bitmap, ...result, retried: false };

    const retryBitmap = await decodeFrame(retry.dataUrl);
    const retryFound = alignSeam(prevMeasured, prevBitmap, measured, retryBitmap, scale);
    // Keep whichever frame joins better. A retry that is no improvement means
    // the overlap genuinely differs - the page moved on rather than the
    // screenshot arriving early - and the first frame is as good as any.
    if (retryFound && retryFound.diff < found.diff) {
      bitmap.close();
      return {
        dataUrl: retry.dataUrl,
        bitmap: retryBitmap,
        ...retryFound,
        shift: retryFound.shift / scale,
        scale,
        retried: true,
      };
    }
    retryBitmap.close();
    return { dataUrl, bitmap, ...result, retried: true };
  } catch (err) {
    console.warn("Seam alignment skipped:", err);
    return plain;
  }
}

/* ------------------------- incremental stitching ------------------------- *
 * Paint each accepted frame while it is already decoded for seam repair. By
 * the time capture ends, the expensive multi-frame image is ready in the
 * worker; the editor only has to decode one finished PNG. The frame metadata
 * still goes through resolveFrameLayout, so overlap trimming is identical to
 * the old viewer-side path rather than being a second geometry algorithm.
 * ------------------------------------------------------------------------ */

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 49152;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(binary);
}

async function canvasDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return `data:image/png;base64,${bytesToBase64(await blob.arrayBuffer())}`;
}

class IncrementalStitcher {
  constructor(target) {
    this.target = target;
    this.frames = [];
    this.canvas = null;
    this.ctx = null;
    this.scale = 0;
    this.outputScale = 1;
    this.firstDataUrl = "";
    this.lastDataUrl = "";
    this.shell = null;
    this.failed = null;
    this.gaps = [];
    this.contentHeight = 0;
  }

  plannedOutputScale(frame, contentHeight, shell) {
    const scale = this.scale || frame.dpr || 1;
    const paneWidth = frame.source.width * scale;
    const chromeHeight = shell
      ? shell.pane.top + Math.max(0, shell.viewport.height - shell.pane.top - shell.pane.height)
      : 0;
    const fullWidth = Math.max(paneWidth, shell ? shell.viewport.width * scale : paneWidth);
    const fullHeight = (Math.max(contentHeight, frame.dest.top + frame.source.height) + chromeHeight) * scale;
    return FpsGeometry.fitOutputScale(fullWidth, fullHeight);
  }

  resize(width, height, nextOutputScale = this.outputScale) {
    width = Math.max(1, Math.ceil(width));
    height = Math.max(1, Math.ceil(height));
    const maxHeight = Math.min(
      FpsGeometry.MAX_CANVAS_SIDE,
      Math.floor(FpsGeometry.MAX_CANVAS_PIXELS / width)
    );
    if (width > FpsGeometry.MAX_CANVAS_SIDE || height > maxHeight) {
      throw new Error("The incremental screenshot canvas exceeds Chrome's size limit.");
    }
    if (this.canvas && this.canvas.width === width && this.canvas.height >= height &&
        nextOutputScale === this.outputScale) return;

    const nextHeight = this.canvas && nextOutputScale === this.outputScale
      ? Math.min(maxHeight, Math.max(height, Math.ceil(this.canvas.height * 1.35)))
      : height;
    const next = new OffscreenCanvas(width, nextHeight);
    const ctx = next.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, next.width, next.height);
    ctx.imageSmoothingQuality = "high";
    if (this.canvas) {
      const ratio = nextOutputScale / this.outputScale;
      ctx.drawImage(
        this.canvas,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
        0,
        0,
        Math.round(this.canvas.width * ratio),
        Math.round(this.canvas.height * ratio)
      );
    }
    this.canvas = next;
    this.ctx = ctx;
    this.outputScale = nextOutputScale;
  }

  async append(frame, bitmap, { contentHeight, shell }) {
    if (this.failed) return;
    let ownedBitmap = null;
    try {
      const image = bitmap || (ownedBitmap = await decodeFrame(frame.dataUrl));
      const scale = frame.viewportWidth > 0 ? image.width / frame.viewportWidth : frame.dpr;
      if (!(scale > 0)) throw new Error("The captured frame has no usable pixel scale.");
      if (!this.scale) this.scale = scale;
      if (Math.abs(scale - this.scale) > this.scale * 0.01) {
        throw new Error("The page pixel scale changed while stitching.");
      }

      this.shell = shell || this.shell;
      const fit = this.plannedOutputScale(frame, contentHeight, this.shell);
      if (!fit) throw new Error("The completed screenshot is too large to stitch.");
      const nextOutputScale = Math.min(this.outputScale, fit);

      const metadata = {
        source: frame.source,
        dest: frame.dest,
        viewportWidth: frame.viewportWidth,
        dpr: scale,
      };
      this.frames.push(metadata);
      const layout = FpsGeometry.resolveFrameLayout(this.frames, {
        scale: this.scale,
        outputScale: nextOutputScale,
      });
      const draw = layout.draws.find((candidate) => candidate.index === this.frames.length - 1);
      this.gaps = layout.gaps;
      this.contentHeight = layout.contentHeight;
      if (!draw) return;

      const plannedHeight = Math.max(
        draw.dy + draw.dh,
        Math.ceil(Math.max(contentHeight, frame.dest.top + frame.source.height) * this.scale * nextOutputScale)
      );
      this.resize(layout.width, plannedHeight, nextOutputScale);
      this.ctx.drawImage(
        image,
        draw.sx,
        draw.sy,
        draw.sw,
        draw.sh,
        draw.dx,
        draw.dy,
        draw.dw,
        draw.dh
      );
      if (!this.firstDataUrl) this.firstDataUrl = frame.dataUrl;
      this.lastDataUrl = frame.dataUrl;
    } catch (err) {
      this.failed = err;
      console.warn("Incremental stitching disabled for this capture:", err);
    } finally {
      ownedBitmap?.close();
    }
  }

  async finish() {
    if (this.failed) throw this.failed;
    if (!this.canvas || !this.frames.length) throw new Error("No stitched frames were produced.");

    const layout = FpsGeometry.resolveFrameLayout(this.frames, {
      scale: this.scale,
      outputScale: this.outputScale,
    });
    const box = this.shell
      ? FpsGeometry.shellComposite(this.shell, layout, this.scale)
      : null;
    const width = box ? box.width : layout.width;
    const height = box ? box.height : layout.height;
    const budget = FpsGeometry.checkOutputBudget(width, height);
    if (!budget.ok) throw new Error(budget.message);

    const output = new OffscreenCanvas(width, height);
    const ctx = output.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";

    let first = null;
    let last = null;
    try {
      if (box) {
        first = await decodeFrame(this.firstDataUrl);
        ctx.drawImage(
          first,
          0,
          0,
          first.width,
          first.height,
          0,
          0,
          box.viewportWidth,
          box.viewportHeight
        );
      }
      ctx.drawImage(
        this.canvas,
        0,
        0,
        layout.width,
        layout.height,
        box ? box.paneX : 0,
        box ? box.paneY : 0,
        layout.width,
        layout.height
      );

      if (box && box.footerHeight > 0) {
        last = await decodeFrame(this.lastDataUrl);
        const finalFrame = this.frames[this.frames.length - 1];
        const frameScale = last.width / finalFrame.viewportWidth;
        const srcTop = Math.round(
          (this.shell.pane.top + this.shell.pane.height) * frameScale
        );
        const srcHeight = Math.max(0, last.height - srcTop);
        if (srcHeight > 0) {
          ctx.drawImage(
            last,
            0,
            srcTop,
            last.width,
            srcHeight,
            0,
            box.paneY + layout.height,
            box.viewportWidth,
            box.footerHeight
          );
        }
      }

      const dataUrl = await canvasDataUrl(output);
      return {
        dataUrl,
        width,
        height,
        downscaled: this.outputScale < 1 ? this.outputScale : 0,
        gaps: layout.gaps,
        capturedHeight: layout.contentHeight,
        shell: !!this.shell,
      };
    } finally {
      first?.close();
      last?.close();
      this.canvas = null;
      this.ctx = null;
    }
  }
}

class CaptureCanceled extends Error {
  constructor(reason) {
    super(reason);
    this.name = "CaptureCanceled";
    this.canceled = true;
  }
}

function beginSession(tab) {
  if (activeSessions.has(tab.id)) return null;
  const session = {
    tabId: tab.id,
    windowId: tab.windowId,
    startedAt: Date.now(),
    canceledReason: "",
  };
  activeSessions.set(tab.id, session);
  return session;
}

function endSession(tabId) {
  activeSessions.delete(tabId);
}

function cancelSession(tabId, reason) {
  const session = activeSessions.get(tabId);
  if (session && !session.canceledReason) session.canceledReason = reason;
}

// captureVisibleTab always grabs the window's active tab, so anything that
// moves the page or the focus out from under us has to stop the run.
chrome.tabs.onRemoved.addListener((tabId) => cancelSession(tabId, "The tab was closed."));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    cancelSession(tabId, "The page navigated during capture.");
  }
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const session of activeSessions.values()) {
    if (session.windowId === windowId && session.tabId !== tabId) {
      cancelSession(session.tabId, "Another tab became active during capture.");
    }
  }
});

function checkCanceled(session) {
  if (session.canceledReason) throw new CaptureCanceled(session.canceledReason);
}

async function injectPageEngine(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["capture-page.js"],
  });
}

// Call one of the page-side helpers published by capture-page.js.
async function callPage(tabId, method, payload = null) {
  return exec(
    tabId,
    (name, arg) => {
      const api = globalThis.__fpsPage;
      return api && api[name] ? api[name](arg) : null;
    },
    [method, payload]
  );
}

/* --------------------------- the capture loop --------------------------- */

async function captureFullPage(tab, options = {}) {
  const tabId = tab.id;
  const session = beginSession(tab);
  if (!session) {
    const busy = new Error("A capture is already running in this tab.");
    busy.concurrent = true; // the other run owns the page; don't touch it
    throw busy;
  }

  let restoreState = {};
  try {
    reportCaptureProgress({
      percent: 3,
      label: "Preparing full page",
      detail: "Finding the scrolling content",
      count: "Starting",
    });
    await injectPageEngine(tabId);

    if (options.pickTarget) {
      const picked = await callPage(tabId, "pickScrollTarget");
      if (!picked?.picked && picked?.reason === "canceled") {
        await exec(tabId, showSelectionFeedback, ["Capture canceled"]);
        return;
      }
    }

    let target = await callPage(tabId, "prepareTarget", {});
    if (!target) throw new Error("Could not inspect this page for a scrollable area.");
    if (target.reason === "no-scrollable-area") {
      // Nothing scrolls: a single viewport is the whole page.
      await captureVisibleArea(tab);
      return;
    }

    if (target.ambiguous && !options.pickTarget) {
      postToCapturePopup({ type: "closeForPicker" });
      await sleep(80);
      const picked = await callPage(tabId, "pickScrollTarget");
      if (picked?.picked) {
        target = (await callPage(tabId, "prepareTarget", {})) || target;
      } else if (picked?.reason === "canceled") {
        await exec(tabId, showSelectionFeedback, ["Capture canceled"]);
        return;
      }
    }

    restoreState = {
      left: target.originalScrollX,
      top: target.originalScrollY,
      elementScrollTop: target.originalElementScrollTop,
      elementScrollLeft: target.originalElementScrollLeft,
    };

    // Stop the page moving before anything is measured and before the
    // top-settle so content revealed there is counted in the height.
    const frozen = await callPage(tabId, "freeze", {
      keepOverlays: !!options.keepOverlays,
    });
    target = { ...target, frozen: frozen || null };

    // Threads that page in older content have to finish doing that before the
    // first frame, or everything captured afterwards is offset.
    reportCaptureProgress({
      percent: 6,
      label: "Preparing full page",
      detail: "Loading content above the starting point",
      count: "Almost ready",
    });
    const settled = await callPage(tabId, "settleTop", {});
    if (settled?.contentHeight > target.contentHeight) {
      target = { ...target, contentHeight: settled.contentHeight };
    }

    const sections = Math.max(
      1,
      Math.ceil(target.contentHeight / Math.max(1, target.viewportHeight))
    );
    reportCaptureProgress({
      percent: 8,
      label: "Capturing full page",
      detail: "Keep this tab active until capture finishes",
      count: `0 of about ${sections}`,
    });

    const result = await runCaptureLoop(tab, session, target);
    if (!result.frames.length) {
      throw new Error(result.truncated?.message || "No frames were captured.");
    }

    reportCaptureProgress({
      percent: 96,
      label: "Preparing editor",
      detail: "Stitching captured sections",
      count: `${result.frames.length} section${result.frames.length === 1 ? "" : "s"}`,
    });

    await saveCapture(tab, {
      frames: result.frames,
      prestitched: result.stitched || undefined,
      metrics: {
        // Kept for the viewer's older stitching path and for file naming.
        pageHeight: result.contentHeight,
        viewportWidth: target.viewportWidth,
        viewportHeight: target.viewportHeight,
        dpr: target.dpr,
        originalScrollX: target.originalScrollX,
        originalScrollY: target.originalScrollY,
      },
      layout: {
        version: 2,
        targetKind: target.kind,
        // Present only for an app shell: the window furniture around the
        // scrolling pane, so the viewer can paint it back in.
        shell: result.shell || undefined,
        contentHeight: result.contentHeight,
        capturedHeight: result.covered,
        viewportWidth: target.viewportWidth,
      },
      truncated: result.truncated,
      diagnostics: result.diagnostics || undefined,
      mode: "fullPage",
    });
    reportCaptureProgress({
      percent: 100,
      label: "Capture complete",
      detail: "Opening the editor",
      count: `${result.frames.length} section${result.frames.length === 1 ? "" : "s"}`,
    });
  } finally {
    await callPage(tabId, "restore", restoreState).catch((err) =>
      console.warn("Unable to restore page after capture:", err)
    );
    await updateCaptureProgress(tabId, { remove: true });
    await clearCaptureBadge(tabId);
    endSession(tabId);
  }
}

async function runCaptureLoop(tab, session, target) {
  const tabId = tab.id;
  const frames = [];
  const scales = [];
  // Opt-in, local only: geometry and timing, never page text or image data.
  const { captureDiagnostics } = await chrome.storage.local.get("captureDiagnostics");
  const diagnostics = captureDiagnostics
    ? [
        {
          event: "target",
          kind: target.kind,
          contentHeight: target.contentHeight,
          scrollRange: target.scrollRange,
          rect: target.rect,
          viewportWidth: target.viewportWidth,
          viewportHeight: target.viewportHeight,
          dpr: target.dpr,
          ambiguous: !!target.ambiguous,
        },
        { event: "freeze", ...(target.frozen || {}) },
      ]
    : null;

  let contentHeight = target.contentHeight;
  let scrollRange = target.scrollRange;
  let truncated = null;
  let previousScrollTop = -1;

  // Running correction between the coordinates the page reports now and the
  // ones the frames already captured were recorded in, in content px. Reflow
  // above the viewport and seam misalignment both push it along, and both
  // persist for the rest of the capture - so it accumulates rather than being
  // applied per frame.
  //
  // The scroll walk is deliberately left out of this: it steers the live page,
  // so it has to keep speaking the page's own coordinates. Only the geometry
  // handed to the viewer is corrected.
  let driftPx = 0;
  let prevMeasured = null;
  let prevBitmap = null;
  let seamShifts = 0;
  let seamRetries = 0;
  let growthChecks = 0;
  let grewDuringRun = false;
  let driftRejections = 0;
  let lastDestTop = -1;
  let shell = null;
  const stitcher = new IncrementalStitcher(target);

  // Frames deliberately share a strip of content. It absorbs a pinned element
  // that grows between frames, and it is the only material the seam probe has
  // to work with - too thin and there is nothing to compare, or no room to
  // slide it. The cost is one extra frame per dozen screens.
  //
  // How much is needed depends on what the page does. An element target is an
  // app shell, where the pane's own chrome moves the most; a page with pinned
  // furniture shifts more between frames than a plain document does. The
  // amount is settled after the first frame, once the page has been looked at.
  let overlap = Math.round(FpsGeometry.clamp(Math.round(target.viewportHeight * 0.08), 48, 120));
  if (target.kind === "element") {
    overlap = Math.round(FpsGeometry.clamp(overlap * 2, 96, Math.floor(target.viewportHeight / 3)));
  }
  const walk = new FpsGeometry.CaptureWalk({ overlap });
  let overlapTuned = false;
  let estimatedTotal = FpsGeometry.planScrollPositions({
    scrollRange,
    band: Math.max(1, target.viewportHeight),
    overlap,
  }).length;

  try {
    for (let index = 0; ; index++) {
      checkCanceled(session);

      if (index >= BUDGET.maxFrames) {
        truncated = { reason: "frames", message: `Stopped after ${BUDGET.maxFrames} sections.` };
        break;
      }
      if (Date.now() - session.startedAt > BUDGET.maxDurationMs) {
        truncated = { reason: "time", message: "Stopped after the capture time limit." };
        break;
      }
      if (contentHeight > BUDGET.maxContentHeight) {
        truncated = {
          reason: "height",
          message: `The page is taller than the ${BUDGET.maxContentHeight}px capture limit.`,
        };
        break;
      }

      const total = Math.max(estimatedTotal, index + 1);
      await updateCaptureBadge(tabId, {
        text: `${index + 1}/${total}`,
        title: `Capturing section ${index + 1} of ${total} - keep this tab active`,
      });

      const requestedTop = walk.nextTop(scrollRange);
      await callPage(tabId, "scrollAndSettle", { top: requestedTop, timeoutMs: 1500 });
      // The frame that lands at the very bottom is where bottom-pinned page
      // furniture belongs, so the page side is told which one that is.
      const isLast = requestedTop >= scrollRange - 1;
      let measured = await callPage(tabId, "measureFrame", { isFirst: index === 0, isLast });
      // Each measurement re-places the page anchor, so its drift is only ever
      // reported once; taking it as it arrives keeps the repair path below from
      // either double-counting or losing a shift.
      driftPx += measured.drift || 0;

      // If a pinned element grew and opened a gap, drop back by the shortfall
      // once rather than losing rows.
      const shortfall = walk.repairShortfall(measured);
      if (shortfall) {
        await callPage(tabId, "scrollAndSettle", {
          top: Math.max(0, measured.scrollTop - shortfall),
          timeoutMs: 900,
        });
        measured = await callPage(tabId, "measureFrame", { isFirst: false, isLast });
        driftPx += measured.drift || 0;
      }

      // The first frame reveals what this page actually does. Pinned
      // furniture eats part of every band and shifts things between frames,
      // so give those pages more shared strip to work with.
      if (!overlapTuned) {
        overlapTuned = true;
        const pinned = (measured.trimTop || 0) + (measured.trimBottom || 0);
        if (pinned > 0 || measured.blockedMiddle) {
          walk.overlap = Math.round(
            FpsGeometry.clamp(
              Math.max(overlap, pinned + 48),
              overlap,
              Math.floor(target.viewportHeight / 3)
            )
          );
          overlap = walk.overlap;
        }
      }

      // If the pane the capture was steering disappeared, every later frame
      // would silently describe the document instead - which on an app shell
      // does not scroll - and the run would stack up at one offset. Stop and
      // say so rather than saving a capture that is quietly one screen.
      if (measured.targetLost) {
        truncated = {
          reason: "target-lost",
          message: "The area being captured was replaced by the page while scrolling.",
        };
        break;
      }

      if (!shell && measured.shell) shell = measured.shell;

      if (measured.contentHeight > contentHeight + 8) grewDuringRun = true;
      contentHeight = Math.max(contentHeight, measured.contentHeight);
      scrollRange = measured.scrollRange;

      if (measured.source.height <= 0 || measured.source.width <= 0) {
        truncated = {
          reason: "occluded",
          message: "The scrollable area was fully covered by pinned page elements.",
        };
        break;
      }

      checkCanceled(session);
      let dataUrl = await captureVisibleTabRateLimited(tab.windowId);

      const seam = await repairSeam({
        dataUrl,
        measured,
        prevMeasured,
        prevBitmap,
        retriesLeft: MAX_SEAM_RETRIES - seamRetries,
        recapture: async () => {
          checkCanceled(session);
          const retryUrl = await captureVisibleTabRateLimited(tab.windowId);
          const at = await callPage(tabId, "scrollTop").catch(() => null);
          return {
            dataUrl: retryUrl,
            settled: !!at && Math.abs(at.scrollTop - measured.scrollTop) <= 2,
          };
        },
      });
      dataUrl = seam.dataUrl;
      if (seam.retried) seamRetries++;
      if (seam.shift) {
        seamShifts++;
        driftPx += seam.shift;
      }

      // The frames keep the coordinates the earlier ones were recorded in, so
      // the viewer can stitch them without knowing any of this happened.
      //
      // The correction is only ever allowed to slide a frame; it must never
      // reorder the run. A frame that lands at or above where the previous one
      // started is not a corrected frame, it is a lost one - the stitcher drops
      // it as redundant, and a whole capture can collapse to a single screen
      // that way. When that happens the drift reading is the thing that is
      // wrong, so it is rolled back rather than trusted.
      let destTop = measured.dest.top - driftPx;
      if (frames.length && destTop <= lastDestTop) {
        diagnostics?.push({
          event: "driftRejected",
          index,
          driftTotal: driftPx,
          reportedTop: measured.dest.top,
          wouldBe: destTop,
          lastDestTop,
        });
        driftPx -= measured.drift || 0;
        driftPx -= seam.shift || 0;
        destTop = measured.dest.top - driftPx;
        driftRejections++;
      }
      destTop = Math.max(0, destTop);
      lastDestTop = destTop;

      const frame = {
        dataUrl,
        scrollTop: measured.scrollTop,
        source: measured.source,
        dest: { ...measured.dest, top: destTop },
        viewportWidth: measured.viewportWidth,
        dpr: seam.scale || measured.dpr,
      };
      frames.push(frame);
      scales.push(seam.scale || measured.dpr);
      await stitcher.append(frame, seam.bitmap, { contentHeight, shell });
      // The walk steers the live page, so it is fed the page's own numbers.
      const covered = walk.accept(measured);

      prevBitmap?.close();
      prevBitmap = seam.bitmap;
      prevMeasured = measured;

      diagnostics?.push({
        event: "frame",
        index,
        requestedTop,
        scrollTop: measured.scrollTop,
        repaired: shortfall,
        source: measured.source,
        destTop,
        reportedTop: measured.dest.top,
        drift: measured.drift || 0,
        driftTotal: driftPx,
        seamShift: seam.shift,
        seamDiff: seam.diff,
        seamBase: seam.base,
        seamRetried: seam.retried,
        trimTop: measured.trimTop,
        trimBottom: measured.trimBottom,
        blockedMiddle: measured.blockedMiddle,
        unpinnedRails: measured.unpinnedRails,
        isLast,
        contentHeight: measured.contentHeight,
        covered,
        elapsedMs: Date.now() - session.startedAt,
      });

      const step = Math.max(1, measured.source.height - overlap);
      estimatedTotal = Math.max(
        index + 1,
        index + 1 + Math.ceil(Math.max(0, scrollRange - measured.scrollTop) / step)
      );

      await updateCaptureBadge(tabId, {
        text: `${index + 1}/${Math.max(estimatedTotal, index + 1)}`,
        title: `Captured ${Math.round(
          Math.min(100, (covered / Math.max(1, contentHeight)) * 100)
        )}% of the page - keep this tab active`,
      });
      reportCaptureProgress({
        percent: 8 + 86 * Math.min(1, covered / Math.max(1, contentHeight)),
        label: "Capturing full page",
        detail: "Keep this tab active until capture finishes",
        count: `${index + 1} of about ${Math.max(estimatedTotal, index + 1)}`,
      });

      const atBottom = measured.scrollTop >= scrollRange - 1;
      // Reaching the bottom of an infinite feed only means the next batch has
      // not been asked for yet. Wait a moment and look again - but only on a
      // page that has actually been growing as it was captured. Doing it
      // everywhere adds a second and a half to every ordinary capture for a
      // result that never changes.
      if (atBottom && grewDuringRun && growthChecks < MAX_GROWTH_CHECKS) {
        await sleep(GROWTH_WAIT_MS);
        growthChecks++;
        // Deliberately not measureFrame: that re-runs the occlusion pass and
        // re-places the drift anchor, and its drift reading would be thrown
        // away here. This only asks how tall the page is now.
        const grown = await callPage(tabId, "metrics").catch(() => null);
        if (grown && grown.scrollRange > scrollRange + 8) {
          scrollRange = grown.scrollRange;
          contentHeight = Math.max(contentHeight, grown.contentHeight);
          diagnostics?.push({ event: "growth", index, scrollRange, contentHeight });
          previousScrollTop = measured.scrollTop;
          continue;
        }
      }
      if (walk.isComplete(measured, contentHeight)) break;
      if (atBottom && measured.scrollTop === previousScrollTop) {
        // The target refuses to scroll further but content is still missing.
        truncated = {
          reason: "stuck",
          message: "The page stopped scrolling before the end of its content.",
        };
        break;
      }
      previousScrollTop = measured.scrollTop;
    }
  } finally {
    // An ImageBitmap holds memory outside the JS heap, so it is released here
    // rather than left to the collector - including when the run is cancelled
    // or a page call fails mid-loop.
    prevBitmap?.close();
  }

  const widths = frames.map((frame) => frame.viewportWidth);
  const consistency = FpsGeometry.checkScaleConsistency(scales);
  const sameWidth = widths.every((width) => width === widths[0]);
  if ((!consistency.ok || !sameWidth) && !truncated) {
    truncated = {
      reason: "scale",
      message: "The page zoom or window size changed during capture; sections may not line up.",
    };
  }

  let stitched = null;
  if (consistency.ok && sameWidth) {
    try {
      reportCaptureProgress({
        percent: 95,
        label: "Finishing screenshot",
        detail: "Encoding the completed image",
        count: `${frames.length} section${frames.length === 1 ? "" : "s"}`,
      });
      stitched = await stitcher.finish();
    } catch (err) {
      console.warn("Falling back to viewer-side stitching:", err);
    }
  }

  if (diagnostics) {
    diagnostics.push({
      event: "end",
      frames: frames.length,
      truncated,
      covered: walk.covered,
      seamShifts,
      seamRetries,
      growthChecks,
      grewDuringRun,
      driftRejections,
      overlap,
      captureIntervalMs: Math.round(1000 / captureRate.perSecond),
      driftTotal: driftPx,
    });
    console.info("[full-page-screenshot] capture diagnostics", diagnostics);
  }

  return { frames, covered: walk.covered, contentHeight, truncated, diagnostics, shell, stitched };
}

async function saveCapture(tab, capture) {
  const capturedAt = Date.now();
  const pageUrl = tab.url;
  const pageTitle = tab.title;

  if (capture.prestitched?.dataUrl) {
    const { prestitched, ...metadata } = capture;
    const baseName = buildCaptureBaseName({ pageUrl, pageTitle, mode: capture.mode, capturedAt });
    const { history = [], historyLimit = 20 } = await chrome.storage.local.get([
      "history",
      "historyLimit",
    ]);
    const limit = Math.min(50, Math.max(1, Number(historyLimit) || 20));
    const imageKey = `captureImage:${capturedAt}:${tab.id}`;
    history.unshift({
      baseName,
      height: prestitched.height,
      imageKey,
      mode: capture.mode || "fullPage",
      savedAt: capturedAt,
      title: pageTitle || "Screenshot",
      url: pageUrl || "",
      width: prestitched.width,
    });
    const keptHistory = history.slice(0, limit);
    const staleImageKeys = history.slice(limit).map((entry) => entry.imageKey).filter(Boolean);
    // Store each prepared image under its own key. The editor can fetch one
    // PNG directly instead of deserializing every image in the history list.
    await chrome.storage.local.set({
      [imageKey]: prestitched.dataUrl,
      history: keptHistory,
      historyLimit: limit,
      capture: {
        ...metadata,
        frames: [],
        baseName,
        capturedAt,
        historySaved: true,
        imageKey,
        pageUrl,
        pageTitle,
        prestitched: true,
        prestitchedReport: {
          capturedHeight: prestitched.capturedHeight,
          downscaled: prestitched.downscaled,
          gaps: prestitched.gaps,
          height: prestitched.height,
          shell: prestitched.shell,
          width: prestitched.width,
        },
      },
    });
    if (staleImageKeys.length) await chrome.storage.local.remove(staleImageKeys);
  } else {
    // Fallback for a worker/canvas failure and for single-viewport modes.
    await chrome.storage.local.set({
      capture: {
        ...capture,
        pageUrl,
        pageTitle,
        capturedAt,
      },
    });
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
}

function slugCapturePart(value, fallback = "screenshot", maxLength = 60) {
  const slug = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/g, "");
  return slug || fallback;
}

function buildCaptureBaseName({ pageUrl, pageTitle, mode, capturedAt }) {
  let domain = "page";
  try {
    domain = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    /* keep fallback */
  }
  const modeSlug = mode === "visible" ? "visible" : mode === "selection" ? "selection" : "full-page";
  const timeSlug = new Date(capturedAt).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const domainSlug = slugCapturePart(domain, "page", 32);
  const reserved = `${domainSlug}-${modeSlug}-${timeSlug}`.length + 2;
  const titleSlug = slugCapturePart(pageTitle, "screenshot", Math.max(12, 110 - reserved));
  return `${domainSlug}-${titleSlug}-${modeSlug}-${timeSlug}`;
}
