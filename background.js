// Shared geometry helpers (also used by the viewer and the node tests).
importScripts("capture-geometry.js");

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
    try {
      await capturePage(tab, message.mode, message.options || {});
    } catch (err) {
      if (err?.canceled) {
        console.info("Screenshot capture canceled:", err.message);
      } else {
        console.error("Screenshot capture failed:", err);
        setTemporaryErrorBadge(tab.id, err?.message);
      }
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

  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing visible area",
    detail: "Hold still - the overlay steps out of the shot.",
  });
  await sleep(PANEL_READ_MS);
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(PANEL_FADE_MS);

  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  await updateCaptureProgress(tabId, {
    current: 1,
    total: 1,
    label: "Preparing editor",
    detail: "Saving capture",
  });
  await updateCaptureProgress(tabId, { remove: true });

  await saveCapture(tab, {
    frames: [{ x: 0, y: 0, dataUrl }],
    metrics,
    mode: "visible",
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
  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing selected area",
    detail: "Hold still - the overlay steps out of the shot.",
  });
  await sleep(PANEL_READ_MS);
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(PANEL_FADE_MS);
  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  await updateCaptureProgress(tabId, {
    current: 1,
    total: 1,
    label: "Preparing editor",
    detail: "Cropping selection",
  });
  await updateCaptureProgress(tabId, { remove: true });

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

// Chrome rate-limits captureVisibleTab to about two calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// How long the on-page panel stays up before the frame loop starts, and how
// long its fade needs to finish so it cannot be caught in the first frame.
const PANEL_READ_MS = 900;
const PANEL_FADE_MS = 160;
// Budgets that stop growing/infinite pages instead of running forever.
const BUDGET = {
  maxFrames: 80,
  maxDurationMs: 180000,
  maxContentHeight: 80000,
};

let lastCaptureAt = 0;
const activeSessions = new Map();

async function captureVisibleTabRateLimited(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  lastCaptureAt = Date.now();
  return dataUrl;
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

    // Element targets capture only that pane, so make the scope visible first.
    if (target.kind === "element") await callPage(tabId, "flashTarget", {});

    // Threads that page in older content have to finish doing that before the
    // first frame, or everything captured afterwards is offset.
    await updateCaptureProgress(tabId, {
      current: 0,
      total: 1,
      label: "Preparing full page",
      detail: "Loading content above the starting point",
    });
    const settled = await callPage(tabId, "settleTop", {});
    if (settled?.contentHeight > target.contentHeight) {
      target = { ...target, contentHeight: settled.contentHeight };
    }

    // Last word before the panel goes away: the frame loop cannot show
    // anything on the page, because every frame is photographed.
    const sections = Math.max(
      1,
      Math.ceil(target.contentHeight / Math.max(1, target.viewportHeight))
    );
    await updateCaptureProgress(tabId, {
      current: 0,
      total: sections,
      label: "Capturing full page",
      detail: `About ${sections} section${sections === 1 ? "" : "s"}, roughly ${Math.max(
        1,
        Math.round((sections * MIN_CAPTURE_INTERVAL_MS) / 1000)
      )}s. Progress shows on the toolbar icon - keep this tab active.`,
    });
    await sleep(PANEL_READ_MS);

    // Hidden for the whole loop, and shown again only once it is over.
    await updateCaptureProgress(tabId, { hidden: true });
    await sleep(PANEL_FADE_MS);

    const result = await runCaptureLoop(tab, session, target);
    if (!result.frames.length) {
      throw new Error(result.truncated?.message || "No frames were captured.");
    }

    await updateCaptureProgress(tabId, {
      current: result.frames.length,
      total: result.frames.length,
      label: "Preparing editor",
      detail: "Stitching captured sections",
    });

    await saveCapture(tab, {
      frames: result.frames,
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
        contentHeight: result.contentHeight,
        capturedHeight: result.covered,
        viewportWidth: target.viewportWidth,
      },
      truncated: result.truncated,
      diagnostics: result.diagnostics || undefined,
      mode: "fullPage",
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
      ]
    : null;

  let contentHeight = target.contentHeight;
  let scrollRange = target.scrollRange;
  let truncated = null;
  let previousScrollTop = -1;

  const overlap = Math.round(
    FpsGeometry.clamp(Math.round(target.viewportHeight * 0.05), 16, 96)
  );
  const walk = new FpsGeometry.CaptureWalk({ overlap });
  let estimatedTotal = FpsGeometry.planScrollPositions({
    scrollRange,
    band: Math.max(1, target.viewportHeight),
    overlap,
  }).length;

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
    let measured = await callPage(tabId, "measureFrame", { isFirst: index === 0 });

    // If a pinned element grew and opened a gap, drop back by the shortfall
    // once rather than losing rows.
    const shortfall = walk.repairShortfall(measured);
    if (shortfall) {
      await callPage(tabId, "scrollAndSettle", {
        top: Math.max(0, measured.scrollTop - shortfall),
        timeoutMs: 900,
      });
      measured = await callPage(tabId, "measureFrame", { isFirst: false });
    }

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
    const dataUrl = await captureVisibleTabRateLimited(tab.windowId);

    frames.push({
      dataUrl,
      scrollTop: measured.scrollTop,
      source: measured.source,
      dest: measured.dest,
      viewportWidth: measured.viewportWidth,
      dpr: measured.dpr,
    });
    scales.push(measured.dpr);
    const covered = walk.accept(measured);

    diagnostics?.push({
      event: "frame",
      index,
      requestedTop,
      scrollTop: measured.scrollTop,
      repaired: shortfall,
      source: measured.source,
      destTop: measured.dest.top,
      trimTop: measured.trimTop,
      trimBottom: measured.trimBottom,
      blockedMiddle: measured.blockedMiddle,
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

    const atBottom = measured.scrollTop >= scrollRange - 1;
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

  const widths = frames.map((frame) => frame.viewportWidth);
  const consistency = FpsGeometry.checkScaleConsistency(scales);
  const sameWidth = widths.every((width) => width === widths[0]);
  if ((!consistency.ok || !sameWidth) && !truncated) {
    truncated = {
      reason: "scale",
      message: "The page zoom or window size changed during capture; sections may not line up.",
    };
  }

  if (diagnostics) {
    diagnostics.push({ event: "end", frames: frames.length, truncated, covered: walk.covered });
    console.info("[full-page-screenshot] capture diagnostics", diagnostics);
  }

  return { frames, covered: walk.covered, contentHeight, truncated, diagnostics };
}

async function saveCapture(tab, capture) {
  // Hand the frames to the viewer page via storage (data URLs can be many MB,
  // which is why the manifest requests unlimitedStorage).
  await chrome.storage.local.set({
    capture: {
      ...capture,
      pageUrl: tab.url,
      pageTitle: tab.title,
      capturedAt: Date.now(),
    },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
}
