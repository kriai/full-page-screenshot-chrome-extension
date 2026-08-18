// Chrome rate-limits captureVisibleTab to ~2 calls/second, and the page needs
// time to repaint after each scroll (lazy images, animations settling).
const CAPTURE_DELAY_MS = 600;

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
      await capturePage(tab, message.mode);
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      await updateCaptureProgress(tab.id, { remove: true });
      await chrome.action.setBadgeText({ text: "ERR", tabId: tab.id });
    }
  })().catch((err) => {
    console.error("Unable to start screenshot capture:", err);
    sendResponse({ ok: false, error: err.message || "Capture failed." });
  });

  return true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

async function capturePage(tab, mode) {
  if (mode === "visible") {
    await captureVisibleArea(tab);
    return;
  }
  if (mode === "selection") {
    await captureSelectedArea(tab);
    return;
  }
  await captureFullPage(tab);
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
  await chrome.action.setBadgeText({ text: "1/1", tabId });

  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing visible area",
  });
  await sleep(250);
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(80);

  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  await updateCaptureProgress(tabId, { remove: true });

  await saveCapture(tab, {
    frames: [{ x: 0, y: 0, dataUrl }],
    metrics,
    mode: "visible",
  });
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function captureSelectedArea(tab) {
  const tabId = tab.id;
  await chrome.action.setBadgeText({ text: "SEL", tabId });

  const selection = await exec(tabId, selectViewportArea);
  if (!selection) {
    await chrome.action.setBadgeText({ text: "", tabId });
    return;
  }

  await chrome.action.setBadgeText({ text: "1/1", tabId });
  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing selected area",
  });
  await sleep(250);
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(80);
  const metrics = await getVisibleMetrics(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  await updateCaptureProgress(tabId, { remove: true });

  await saveCapture(tab, {
    cropRect: selection,
    frames: [{ x: 0, y: 0, dataUrl }],
    metrics,
    mode: "selection",
  });
  await chrome.action.setBadgeText({ text: "", tabId });
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
        cleanup(null);
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

      cleanup(width < 4 || height < 4 ? null : { left, top, width, height });
    });
  });
}

async function updateCaptureProgress(tabId, progress) {
  try {
    await exec(tabId, renderCaptureProgress, [progress]);
  } catch (err) {
    console.warn("Unable to update capture progress UI:", err);
  }
}

function renderCaptureProgress(progress) {
  const id = "__fps_progress_overlay";
  const existing = document.getElementById(id);

  if (progress.remove) {
    if (existing) existing.remove();
    return;
  }

  if (progress.hidden) {
    if (existing) existing.hidden = true;
    return;
  }

  const overlay = existing || document.createElement("div");
  overlay.id = id;
  overlay.dataset.fpsUi = "1";
  overlay.hidden = false;
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
  ].join(";");

  const total = Math.max(1, progress.total || 1);
  const current = Math.min(total, Math.max(0, progress.current || 0));
  const percent = Math.round((current / total) * 100);
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;">
      <strong style="font-size:13px;font-weight:700;">${progress.label || "Capturing screenshot"}</strong>
      <span style="color:#b9c2d0;font-size:12px;">${current}/${total}</span>
    </div>
    <div style="height:7px;overflow:hidden;border-radius:999px;background:#343946;">
      <div style="height:100%;width:${percent}%;border-radius:999px;background:#78a0ff;transition:width 160ms ease;"></div>
    </div>
  `;

  if (!existing) document.documentElement.appendChild(overlay);
}

async function captureFullPage(tab) {
  const tabId = tab.id;

  const metrics = await exec(tabId, () => ({
    pageHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    originalScrollY: window.scrollY,
  }));

  // One capture per viewport, with the final one clamped to the page bottom.
  const positions = [];
  const maxY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  for (let y = 0; y < maxY; y += metrics.viewportHeight) positions.push(y);
  positions.push(maxY);

  await updateCaptureProgress(tabId, {
    current: 0,
    total: positions.length,
    label: "Capturing full page",
  });

  const frames = [];
  for (let i = 0; i < positions.length; i++) {
    await chrome.action.setBadgeText({
      text: `${i + 1}/${positions.length}`,
      tabId,
    });

    await exec(
      tabId,
      (top) => window.scrollTo({ top, left: 0, behavior: "instant" }),
      [positions[i]]
    );

    // From the second frame on, hide fixed/sticky elements so headers and
    // cookie bars don't repeat in every slice.
    if (i === 1) {
      await exec(tabId, () => {
        for (const el of document.querySelectorAll("*")) {
          if (el.closest("[data-fps-ui]")) continue;
          const pos = getComputedStyle(el).position;
          if (pos === "fixed" || pos === "sticky") {
            el.dataset.fpsHidden = "1";
            el.style.setProperty("visibility", "hidden", "important");
          }
        }
      });
    }

    await updateCaptureProgress(tabId, {
      current: i,
      total: positions.length,
      label: "Capturing full page",
    });
    await sleep(CAPTURE_DELAY_MS);
    await updateCaptureProgress(tabId, { hidden: true });
    await sleep(80);

    // The browser may clamp the scroll; record where the page actually is.
    const actualY = await exec(tabId, () => window.scrollY);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    frames.push({ y: actualY, dataUrl });
    await updateCaptureProgress(tabId, {
      current: i + 1,
      total: positions.length,
      label: "Capturing full page",
    });
  }

  // Restore the page: unhide fixed elements, scroll back to where the user was.
  await exec(
    tabId,
    (top) => {
      for (const el of document.querySelectorAll("[data-fps-hidden]")) {
        el.style.removeProperty("visibility");
        delete el.dataset.fpsHidden;
      }
      window.scrollTo({ top, left: 0, behavior: "instant" });
    },
    [metrics.originalScrollY]
  );
  await updateCaptureProgress(tabId, { remove: true });
  await chrome.action.setBadgeText({ text: "", tabId });

  await saveCapture(tab, {
    frames,
    metrics,
    mode: "fullPage",
  });
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
