// Chrome rate-limits captureVisibleTab to ~2 calls/second, and the page needs
// time to repaint after each scroll (lazy images, animations settling).
const CAPTURE_DELAY_MS = 600;
const CHATGPT_SCROLL_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

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
      await cleanupCaptureTab(tab.id);
      setTemporaryErrorBadge(tab.id);
    }
  })().catch((err) => {
    console.error("Unable to start screenshot capture:", err);
    sendResponse({ ok: false, error: err.message || "Capture failed." });
  });

  return true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setTemporaryErrorBadge(tabId) {
  chrome.action.setBadgeText({ text: "ERR", tabId }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }, 2200);
}

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
    label: "Preparing visible area",
    detail: "Checking viewport size",
  });
  await sleep(250);
  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing visible area",
    detail: "Hiding capture overlay",
  });
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(80);

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
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function captureSelectedArea(tab) {
  const tabId = tab.id;
  await chrome.action.setBadgeText({ text: "SEL", tabId });

  const selection = await exec(tabId, selectViewportArea);
  if (!selection || selection.reason) {
    await chrome.action.setBadgeText({ text: "", tabId });
    if (selection?.reason) {
      await exec(tabId, showSelectionFeedback, [
        selection.reason === "too-small" ? "Selection too small" : "Selection canceled",
      ]);
    }
    return;
  }

  await chrome.action.setBadgeText({ text: "1/1", tabId });
  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Preparing selected area",
    detail: "Using selected region",
  });
  await sleep(250);
  await updateCaptureProgress(tabId, {
    current: 0,
    total: 1,
    label: "Capturing selected area",
    detail: "Hiding capture overlay",
  });
  await updateCaptureProgress(tabId, { hidden: true });
  await sleep(80);
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

async function updateCaptureProgress(tabId, progress) {
  try {
    await exec(tabId, renderCaptureProgress, [progress]);
  } catch (err) {
    console.warn("Unable to update capture progress UI:", err);
  }
}

async function cleanupCaptureTab(tabId) {
  await updateCaptureProgress(tabId, { remove: true });
  await restorePageAfterCapture(tabId);
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
    <div style="margin:-4px 0 10px;color:#b9c2d0;font-size:12px;line-height:1.35;">${progress.detail || "Please keep this tab active."}</div>
    <div style="height:7px;overflow:hidden;border-radius:999px;background:#343946;">
      <div style="height:100%;width:${percent}%;border-radius:999px;background:#78a0ff;transition:width 160ms ease;"></div>
    </div>
  `;

  if (!existing) document.documentElement.appendChild(overlay);
}

async function restorePageAfterCapture(tabId, scroll = {}) {
  try {
    await exec(
      tabId,
      ({ left, top, elementScrollTop }) => {
        for (const el of document.querySelectorAll("[data-fps-hidden]")) {
          el.style.removeProperty("visibility");
          delete el.dataset.fpsHidden;
        }

        if (["chatgpt.com", "chat.openai.com"].includes(location.hostname)) {
          const scrollTarget = document.querySelector('[data-fps-scroll-target="chatgpt"]');
          if (scrollTarget) {
            if (Number.isFinite(elementScrollTop)) {
              scrollTarget.scrollTo({
                top: elementScrollTop,
                left: scrollTarget.scrollLeft,
                behavior: "instant",
              });
            }
            delete scrollTarget.dataset.fpsScrollTarget;
          }

          const captureRoot = document.getElementById("__fps_chatgpt_capture_root");
          if (captureRoot) captureRoot.remove();
          const captureStyle = document.getElementById("__fps_chatgpt_capture_style");
          if (captureStyle) captureStyle.remove();

          for (const el of document.querySelectorAll("[data-fps-chatgpt-had-style]")) {
            if (!el.hasAttribute("data-fps-chatgpt-had-style")) continue;

            const hadStyle = el.getAttribute("data-fps-chatgpt-had-style") === "1";
            const originalStyle = el.getAttribute("data-fps-chatgpt-original-style") || "";
            if (hadStyle) {
              el.setAttribute("style", originalStyle);
            } else {
              el.removeAttribute("style");
            }
            el.removeAttribute("data-fps-chatgpt-had-style");
            el.removeAttribute("data-fps-chatgpt-original-style");
          }
        }

        const hasLeft = Number.isFinite(left);
        const hasTop = Number.isFinite(top);
        if (hasLeft || hasTop) {
          window.scrollTo({
            left: hasLeft ? left : window.scrollX,
            top: hasTop ? top : window.scrollY,
            behavior: "instant",
          });
        }
      },
      [
        {
          left: scroll.originalScrollX,
          top: scroll.originalScrollY,
          elementScrollTop: scroll.originalElementScrollTop,
        },
      ]
    );
  } catch (err) {
    console.warn("Unable to restore page after capture:", err);
  }
}

function isChatGptUrl(url) {
  try {
    return CHATGPT_SCROLL_HOSTS.has(new URL(url).hostname);
  } catch (_err) {
    return false;
  }
}

function setupChatGptDocumentCapture() {
  if (!["chatgpt.com", "chat.openai.com"].includes(location.hostname)) return null;

  function findTarget() {
    const candidates = [...document.querySelectorAll("section, div, main, [role='region']")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const className = typeof el.className === "string" ? el.className : "";
        const scrollable = el.scrollHeight > el.clientHeight + 100;
        const visible = rect.width >= 320 && rect.height >= 240 && style.display !== "none";
        const overflowAllowed = style.overflowY !== "hidden" && style.visibility !== "hidden";
        if (!scrollable || !visible || !overflowAllowed) return null;

        let score = el.scrollHeight - el.clientHeight;
        if (className.includes("threadViewport")) score += 20000;
        if (className.includes("detailBody")) score += 12000;
        if (className.includes("conversation")) score += 8000;
        if (el.getAttribute("role") === "region") score += 6000;
        score += Math.min(3000, rect.height + rect.width / 4);

        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.el || null;
  }

  const target = findTarget();
  if (!target) return null;
  target.dataset.fpsScrollTarget = "chatgpt";

  const previousRoot = document.getElementById("__fps_chatgpt_capture_root");
  if (previousRoot) previousRoot.remove();
  const previousStyle = document.getElementById("__fps_chatgpt_capture_style");
  if (previousStyle) previousStyle.remove();

  const rect = target.getBoundingClientRect();
  const root = document.createElement("div");
  const style = document.createElement("style");
  const clone = target.cloneNode(true);

  root.id = "__fps_chatgpt_capture_root";
  root.dataset.fpsUi = "1";
  root.style.cssText = [
    "position:absolute",
    "z-index:2147483646",
    "top:0",
    "left:0",
    "width:100vw",
    "min-height:100vh",
    "background:#fff",
    "color:#111",
    "overflow:visible",
  ].join(";");

  style.id = "__fps_chatgpt_capture_style";
  style.textContent = `
    #__fps_chatgpt_capture_root,
    #__fps_chatgpt_capture_root * {
      animation: none !important;
      transition: none !important;
      max-height: none !important;
      scroll-behavior: auto !important;
    }
    #__fps_chatgpt_capture_root [class*="threadViewport"],
    #__fps_chatgpt_capture_root [class*="detailBody"],
    #__fps_chatgpt_capture_root [class*="conversation"],
    #__fps_chatgpt_capture_root [class*="thread"] {
      contain: none !important;
      height: auto !important;
      max-height: none !important;
      min-height: 0 !important;
      overflow: visible !important;
      position: static !important;
      transform: none !important;
    }
    #__fps_chatgpt_capture_root form,
    #__fps_chatgpt_capture_root textarea,
    #__fps_chatgpt_capture_root [contenteditable="true"],
    #__fps_chatgpt_capture_root button,
    #__fps_chatgpt_capture_root [role="button"],
    #__fps_chatgpt_capture_root [aria-label*="Scroll"],
    #__fps_chatgpt_capture_root [aria-label*="scroll"] {
      display: none !important;
    }
  `;

  clone.removeAttribute("id");
  clone.removeAttribute("data-fps-scroll-target");
  clone.style.cssText = [
    "box-sizing:border-box",
    `width:${Math.max(320, rect.width)}px`,
    "height:auto",
    "max-height:none",
    "min-height:0",
    "overflow:visible",
    "position:static",
    "transform:none",
    "contain:none",
    "margin:0 auto",
    "background:#fff",
  ].join(";");

  root.appendChild(clone);

  for (const el of [document.documentElement, document.body].filter(Boolean)) {
    if (!el.hasAttribute("data-fps-chatgpt-had-style")) {
      el.setAttribute("data-fps-chatgpt-had-style", el.hasAttribute("style") ? "1" : "0");
      el.setAttribute("data-fps-chatgpt-original-style", el.getAttribute("style") || "");
    }
  }

  document.documentElement.style.setProperty("overflow", "auto", "important");
  document.documentElement.style.setProperty("height", "auto", "important");
  document.body.style.setProperty("overflow", "auto", "important");
  document.body.style.setProperty("height", "auto", "important");
  document.body.style.setProperty("min-height", `${Math.max(target.scrollHeight, window.innerHeight)}px`, "important");

  document.documentElement.appendChild(style);
  document.body.appendChild(root);

  const pageHeight = Math.max(root.scrollHeight, clone.scrollHeight, target.scrollHeight, window.innerHeight);
  root.style.minHeight = `${pageHeight}px`;
  document.body.style.setProperty("min-height", `${pageHeight}px`, "important");

  window.scrollTo({ top: 0, left: 0, behavior: "instant" });

  return {
    pageHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    originalElementScrollTop: target.scrollTop,
    stagedChatGptCapture: true,
  };
}

function setupChatGptExpandedCapture() {
  if (!["chatgpt.com", "chat.openai.com"].includes(location.hostname)) return null;

  function findTarget() {
    const candidates = [...document.querySelectorAll("section, div, main, [role='region']")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const className = typeof el.className === "string" ? el.className : "";
        const scrollable = el.scrollHeight > el.clientHeight + 100;
        const visible = rect.width >= 320 && rect.height >= 240 && style.display !== "none";
        const overflowAllowed = style.overflowY !== "hidden" && style.visibility !== "hidden";
        if (!scrollable || !visible || !overflowAllowed) return null;

        let score = el.scrollHeight - el.clientHeight;
        if (className.includes("threadViewport")) score += 20000;
        if (className.includes("detailBody")) score += 12000;
        if (className.includes("conversation")) score += 8000;
        if (el.getAttribute("role") === "region") score += 6000;
        score += Math.min(3000, rect.height + rect.width / 4);

        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.el || null;
  }

  function rememberStyle(el) {
    if (!el || el.hasAttribute("data-fps-chatgpt-had-style")) return;
    el.setAttribute("data-fps-chatgpt-had-style", el.hasAttribute("style") ? "1" : "0");
    el.setAttribute("data-fps-chatgpt-original-style", el.getAttribute("style") || "");
  }

  function hide(el) {
    if (!el || el.closest("[data-fps-ui]")) return;
    el.dataset.fpsHidden = "1";
    el.style.setProperty("visibility", "hidden", "important");
  }

  const target = findTarget();
  if (!target) return null;

  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  const originalElementScrollTop = target.scrollTop;
  const pageHeight = Math.max(target.scrollHeight, window.innerHeight);
  target.dataset.fpsScrollTarget = "chatgpt";
  target.scrollTo({ top: 0, left: target.scrollLeft, behavior: "instant" });

  const path = [];
  for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
    path.push(el);
  }
  path.push(document.documentElement);

  for (const el of path) {
    rememberStyle(el);
    el.style.setProperty("overflow", "visible", "important");
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("contain", "none", "important");
    el.style.setProperty("transform", "none", "important");
    el.style.setProperty("position", "static", "important");
    if (el === target) {
      el.style.setProperty("height", `${pageHeight}px`, "important");
      el.style.setProperty("min-height", `${pageHeight}px`, "important");
    } else {
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("min-height", "0", "important");
    }
  }

  rememberStyle(document.body);
  document.body.style.setProperty("overflow", "visible", "important");
  document.body.style.setProperty("height", "auto", "important");
  document.body.style.setProperty("min-height", `${pageHeight}px`, "important");

  for (const el of target.querySelectorAll("*")) {
    const className = typeof el.className === "string" ? el.className : "";
    if (
      el.scrollHeight > el.clientHeight + 100 ||
      className.includes("threadViewport") ||
      className.includes("detailBody") ||
      className.includes("conversation") ||
      className.includes("thread")
    ) {
      rememberStyle(el);
      el.style.setProperty("overflow", "visible", "important");
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
      el.style.setProperty("contain", "none", "important");
      el.style.setProperty("transform", "none", "important");
    }
  }

  for (const el of document.querySelectorAll("form, textarea, [contenteditable='true']")) {
    const rect = el.getBoundingClientRect();
    if (rect.width >= 260 && rect.top > window.innerHeight * 0.25) hide(el.closest("form") || el);
  }

  for (const el of document.querySelectorAll("button, a, [role='button'], [tabindex]")) {
    const text = (el.textContent || "").trim().toLowerCase();
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const rect = el.getBoundingClientRect();
    const isAuthControl = text === "log in" || text === "sign up for free";
    const isScrollControl =
      label.includes("scroll") || (rect.width <= 96 && rect.height <= 96 && rect.top > window.innerHeight * 0.25);
    const isTopChatGptControl = text === "chatgpt" && rect.top < 80 && rect.left < 180;
    if (isAuthControl || isScrollControl || isTopChatGptControl) hide(el);
  }

  for (const el of document.querySelectorAll("*")) {
    if (el.closest("[data-fps-ui]") || el === target || el.contains(target) || target.contains(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") hide(el);
  }

  window.scrollTo({ top: 0, left: 0, behavior: "instant" });

  const expandedHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    pageHeight
  );

  return {
    pageHeight: expandedHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    originalScrollX,
    originalScrollY,
    originalElementScrollTop,
    stagedChatGptCapture: true,
  };
}

function chatGptScrollMetrics() {
  if (!["chatgpt.com", "chat.openai.com"].includes(location.hostname)) return null;

  function findTarget() {
    const existing = document.querySelector('[data-fps-scroll-target="chatgpt"]');
    if (existing && existing.scrollHeight > existing.clientHeight + 100) {
      return existing;
    }

    const candidates = [...document.querySelectorAll("section, div, main, [role='region']")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const className = typeof el.className === "string" ? el.className : "";
        const scrollable = el.scrollHeight > el.clientHeight + 100;
        const visible = rect.width >= 320 && rect.height >= 240 && style.display !== "none";
        const overflowAllowed = style.overflowY !== "hidden" && style.visibility !== "hidden";
        if (!scrollable || !visible || !overflowAllowed) return null;

        let score = el.scrollHeight - el.clientHeight;
        if (className.includes("threadViewport")) score += 20000;
        if (className.includes("detailBody")) score += 12000;
        if (className.includes("conversation")) score += 8000;
        if (el.getAttribute("role") === "region") score += 6000;
        score += Math.min(3000, rect.height + rect.width / 4);

        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const candidate = candidates[0]?.el || null;
    if (candidate) candidate.dataset.fpsScrollTarget = "chatgpt";
    return candidate;
  }

  const target = findTarget();
  if (!target) return null;

  function bottomObscurerTop(rect) {
    let top = rect.bottom;

    for (const el of document.querySelectorAll("form, textarea, [contenteditable='true']")) {
      if (el.closest("[data-fps-ui]")) continue;

      const elRect = el.getBoundingClientRect();
      const overlapsTarget =
        elRect.bottom > rect.top &&
        elRect.top < rect.bottom &&
        elRect.right > rect.left &&
        elRect.left < rect.right;
      const looksLikeComposer =
        elRect.width >= 260 &&
        elRect.height >= 24 &&
        elRect.top > window.innerHeight * 0.35;

      if (overlapsTarget && looksLikeComposer) top = Math.min(top, elRect.top);
    }

    for (const el of document.querySelectorAll("button, [role='button'], [tabindex], svg")) {
      if (el.closest("[data-fps-ui]")) continue;

      const elRect = el.getBoundingClientRect();
      const centerX = elRect.left + elRect.width / 2;
      const targetCenterX = rect.left + rect.width / 2;
      const overlapsTarget =
        elRect.bottom > rect.top &&
        elRect.top < rect.bottom &&
        elRect.right > rect.left &&
        elRect.left < rect.right;
      const looksLikeFloatingControl =
        elRect.width >= 16 &&
        elRect.width <= 96 &&
        elRect.height >= 16 &&
        elRect.height <= 96 &&
        Math.abs(centerX - targetCenterX) < 120 &&
        elRect.top > window.innerHeight * 0.25;

      if (overlapsTarget && looksLikeFloatingControl) top = Math.min(top, elRect.top);
    }

    return top;
  }

  const rect = target.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const safeHeight = Math.max(220, Math.min(320, Math.floor(target.clientHeight * 0.32)));
  const bottom = Math.min(window.innerHeight, rect.bottom, top + safeHeight);
  const captureHeight = Math.max(0, bottom - top);

  return {
    pageHeight: target.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: captureHeight || target.clientHeight,
    scrollStep: Math.max(120, captureHeight),
    dpr: window.devicePixelRatio,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    originalElementScrollTop: target.scrollTop,
    scrollRect: {
      left,
      top,
      width: Math.max(0, right - left),
      height: captureHeight,
    },
    scrollTarget: "chatgpt",
  };
}

function scrollChatGptTarget(top) {
  function findTarget() {
    const existing = document.querySelector('[data-fps-scroll-target="chatgpt"]');
    if (existing && existing.scrollHeight > existing.clientHeight + 100) {
      return existing;
    }

    const candidates = [...document.querySelectorAll("section, div, main, [role='region']")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const className = typeof el.className === "string" ? el.className : "";
        const scrollable = el.scrollHeight > el.clientHeight + 100;
        const visible = rect.width >= 320 && rect.height >= 240 && style.display !== "none";
        const overflowAllowed = style.overflowY !== "hidden" && style.visibility !== "hidden";
        if (!scrollable || !visible || !overflowAllowed) return null;

        let score = el.scrollHeight - el.clientHeight;
        if (className.includes("threadViewport")) score += 20000;
        if (className.includes("detailBody")) score += 12000;
        if (className.includes("conversation")) score += 8000;
        if (el.getAttribute("role") === "region") score += 6000;
        score += Math.min(3000, rect.height + rect.width / 4);

        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const candidate = candidates[0]?.el || null;
    if (candidate) candidate.dataset.fpsScrollTarget = "chatgpt";
    return candidate;
  }

  const target = findTarget();
  if (!target) return null;

  target.scrollTo({
    top,
    left: target.scrollLeft,
    behavior: "instant",
  });
  return target.scrollTop;
}

function hideChatGptCaptureChrome() {
  const target = document.querySelector('[data-fps-scroll-target="chatgpt"]');
  if (!target) return;

  function hide(el) {
    if (!el || el.closest("[data-fps-ui]") || el === target || el.contains(target)) return;
    el.dataset.fpsHidden = "1";
    el.style.setProperty("visibility", "hidden", "important");
  }

  function hideCompactAncestor(el) {
    let current = el;
    let best = el;

    while (current && current !== document.body && current !== target) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= 260 && rect.height > 24 && rect.height <= 220) best = current;
      if (rect.width > window.innerWidth * 0.92 || rect.height > window.innerHeight * 0.45) break;
      current = current.parentElement;
    }

    hide(best);
  }

  for (const el of document.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const targetRect = target.getBoundingClientRect();
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const style = getComputedStyle(el);
    const compact = rect.width >= 24 && rect.width <= 96 && rect.height >= 24 && rect.height <= 96;
    const centered = Math.abs(centerX - targetCenterX) < 96;
    const lowerHalf = rect.top > window.innerHeight * 0.25;
    const chromeLike =
      style.borderRadius !== "0px" ||
      style.boxShadow !== "none" ||
      el.querySelector("svg") ||
      el.tagName === "SVG";

    if (compact && centered && lowerHalf && chromeLike) hideCompactAncestor(el);
  }

  for (const el of document.querySelectorAll("button, a, [role='button'], [tabindex]")) {
    const text = (el.textContent || "").trim().toLowerCase();
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const rect = el.getBoundingClientRect();
    const isAuthControl = text === "log in" || text === "sign up for free";
    const isScrollControl =
      label.includes("scroll") || (rect.width <= 64 && rect.height <= 64 && rect.top > window.innerHeight * 0.45);
    const isTopChatGptControl = text === "chatgpt" && rect.top < 80 && rect.left < 160;

    if (isAuthControl || isScrollControl || isTopChatGptControl) hideCompactAncestor(el);
  }

  for (const el of document.querySelectorAll("*")) {
    if (el.closest("[data-fps-ui]")) continue;
    if (el === target || el.contains(target)) continue;

    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") {
      el.dataset.fpsHidden = "1";
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
}

async function captureStandardFullPage(tab, metrics) {
  const tabId = tab.id;

  // One capture per viewport, with the final one clamped to the page bottom.
  const positions = [];
  const maxY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  for (let y = 0; y < maxY; y += metrics.viewportHeight) positions.push(y);
  positions.push(maxY);

  await updateCaptureProgress(tabId, {
    current: 0,
    total: positions.length,
    label: "Preparing full page",
    detail: `${positions.length} section${positions.length === 1 ? "" : "s"} to capture`,
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
      label: `Positioning section ${i + 1}`,
      detail: "Scrolling and waiting for content to settle",
    });
    await sleep(CAPTURE_DELAY_MS);
    await updateCaptureProgress(tabId, {
      current: i,
      total: positions.length,
      label: `Capturing section ${i + 1}`,
      detail: "Hiding capture overlay",
    });
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
      label: `Captured section ${i + 1}`,
      detail: `${positions.length - i - 1} section${positions.length - i - 1 === 1 ? "" : "s"} remaining`,
    });
  }

  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Restoring page",
    detail: "Putting scroll position and sticky elements back",
  });

  // Restore the page: unhide fixed elements, scroll back to where the user was.
  await exec(
    tabId,
    ({ left, top }) => {
      for (const el of document.querySelectorAll("[data-fps-hidden]")) {
        el.style.removeProperty("visibility");
        delete el.dataset.fpsHidden;
      }
      window.scrollTo({
        left: Number.isFinite(left) ? left : 0,
        top: Number.isFinite(top) ? top : 0,
        behavior: "instant",
      });
    },
    [{ left: metrics.originalScrollX, top: metrics.originalScrollY }]
  );
  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Preparing editor",
    detail: "Stitching captured sections",
  });
  await updateCaptureProgress(tabId, { remove: true });
  await chrome.action.setBadgeText({ text: "", tabId });

  await saveCapture(tab, {
    frames,
    metrics,
    mode: "fullPage",
  });
}

async function captureFullPage(tab) {
  const tabId = tab.id;

  let metrics = await exec(tabId, () => ({
    pageHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
  }));

  const shouldUseChatGptPath =
    isChatGptUrl(tab.url) && metrics.pageHeight <= metrics.viewportHeight + 1;
  if (!shouldUseChatGptPath) {
    await captureStandardFullPage(tab, metrics);
    return;
  }

  const expandedChatGptMetrics =
    await exec(tabId, setupChatGptExpandedCapture);
  if (expandedChatGptMetrics?.pageHeight > expandedChatGptMetrics.viewportHeight) {
    metrics = expandedChatGptMetrics;
  }

  const chatGptMetrics =
    !metrics.stagedChatGptCapture && isChatGptUrl(tab.url) && metrics.pageHeight <= metrics.viewportHeight + 1
      ? await exec(tabId, chatGptScrollMetrics)
      : null;

  if (
    chatGptMetrics?.scrollRect?.width > 0 &&
    chatGptMetrics.scrollRect.height > 0 &&
    chatGptMetrics.pageHeight > chatGptMetrics.viewportHeight
  ) {
    await captureScrollableElementPage(tab, chatGptMetrics);
    return;
  }

  // One capture per viewport, with the final one clamped to the page bottom.
  const positions = [];
  const maxY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  for (let y = 0; y < maxY; y += metrics.viewportHeight) positions.push(y);
  positions.push(maxY);

  await updateCaptureProgress(tabId, {
    current: 0,
    total: positions.length,
    label: "Preparing full page",
    detail: `${positions.length} section${positions.length === 1 ? "" : "s"} to capture`,
  });

  const frames = [];
  try {
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
      if (i === 1 && !metrics.stagedChatGptCapture) {
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
        label: `Positioning section ${i + 1}`,
        detail: "Scrolling and waiting for content to settle",
      });
      await sleep(CAPTURE_DELAY_MS);
      await updateCaptureProgress(tabId, {
        current: i,
        total: positions.length,
        label: `Capturing section ${i + 1}`,
        detail: "Hiding capture overlay",
      });
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
        label: `Captured section ${i + 1}`,
        detail: `${positions.length - i - 1} section${positions.length - i - 1 === 1 ? "" : "s"} remaining`,
      });
    }
  } catch (err) {
    await restorePageAfterCapture(tabId, metrics);
    throw err;
  }

  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Restoring page",
    detail: "Putting scroll position and sticky elements back",
  });

  await restorePageAfterCapture(tabId, metrics);
  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Preparing editor",
    detail: "Stitching captured sections",
  });
  await updateCaptureProgress(tabId, { remove: true });
  await chrome.action.setBadgeText({ text: "", tabId });

  await saveCapture(tab, {
    frames,
    metrics,
    mode: "fullPage",
  });
}

async function captureScrollableElementPage(tab, metrics) {
  const tabId = tab.id;

  const positions = [];
  const scrollStep = Math.max(120, metrics.scrollStep || metrics.viewportHeight);
  const maxY = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
  for (let y = 0; y < maxY; y += scrollStep) positions.push(y);
  positions.push(maxY);

  await updateCaptureProgress(tabId, {
    current: 0,
    total: positions.length,
    label: "Preparing full page",
    detail: `${positions.length} section${positions.length === 1 ? "" : "s"} to capture`,
  });

  const frames = [];
  try {
    await exec(tabId, hideChatGptCaptureChrome);

    for (let i = 0; i < positions.length; i++) {
      await chrome.action.setBadgeText({
        text: `${i + 1}/${positions.length}`,
        tabId,
      });

      const actualY = await exec(tabId, scrollChatGptTarget, [positions[i]]);

      await updateCaptureProgress(tabId, {
        current: i,
        total: positions.length,
        label: `Positioning section ${i + 1}`,
        detail: "Scrolling and waiting for content to settle",
      });
      await sleep(CAPTURE_DELAY_MS);
      await exec(tabId, hideChatGptCaptureChrome);
      await updateCaptureProgress(tabId, {
        current: i,
        total: positions.length,
        label: `Capturing section ${i + 1}`,
        detail: "Hiding capture overlay",
      });
      await updateCaptureProgress(tabId, { hidden: true });
      await sleep(80);

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      frames.push({ y: Number.isFinite(actualY) ? actualY : positions[i], dataUrl });
      await updateCaptureProgress(tabId, {
        current: i + 1,
        total: positions.length,
        label: `Captured section ${i + 1}`,
        detail: `${positions.length - i - 1} section${positions.length - i - 1 === 1 ? "" : "s"} remaining`,
      });
    }
  } catch (err) {
    await restorePageAfterCapture(tabId, metrics);
    throw err;
  }

  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Restoring page",
    detail: "Putting scroll position and sticky elements back",
  });

  await restorePageAfterCapture(tabId, metrics);
  await updateCaptureProgress(tabId, {
    current: positions.length,
    total: positions.length,
    label: "Preparing editor",
    detail: "Stitching captured sections",
  });
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
