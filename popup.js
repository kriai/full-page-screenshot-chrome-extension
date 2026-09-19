const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-mode]"));
const actions = document.getElementById("capture-actions");
const captureState = document.getElementById("capture-state");
const captureLabel = document.getElementById("capture-label");
const captureDetail = document.getElementById("capture-detail");
const captureCount = document.getElementById("capture-count");
const capturePercent = document.getElementById("capture-percent");
const captureProgress = document.getElementById("capture-progress");
const progressTrack = document.querySelector(".progress-track");
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Keeping the popup connected serves two purposes: it receives live progress,
// and it can take viewport snapshots for the worker while it remains open,
// following the reference extension's handoff. Chrome may enforce the same
// global quota on either caller; the worker treats that refusal as a wait and
// retry. If the popup closes, its direct path takes over and the toolbar badge
// keeps showing status.
const port = chrome.runtime.connect({ name: "capture-popup" });

function showCaptureState() {
  actions.hidden = true;
  status.textContent = "";
  status.classList.remove("loading");
  captureState.classList.add("active");
  if (!prefersReducedMotion && !captureState.dataset.entered) {
    captureState.dataset.entered = "1";
    captureState.animate(
      [
        { opacity: 0, transform: "translateY(8px) scale(.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }
    );
  }
}

function updateProgress(message) {
  showCaptureState();
  const percent = Math.max(0, Math.min(100, Math.round(Number(message.percent) || 0)));
  captureLabel.textContent = message.label || "Capturing screenshot";
  captureDetail.textContent = message.detail || "Keep this tab active until capture finishes.";
  captureCount.textContent = message.count || "Working";
  capturePercent.textContent = `${percent}%`;
  captureProgress.style.width = `${Math.max(2, percent)}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
}

function showError(message) {
  showCaptureState();
  captureLabel.textContent = "Capture failed";
  captureDetail.textContent = message || "Please try again.";
  captureCount.textContent = "";
  capturePercent.textContent = "";
  captureProgress.style.width = "100%";
  captureProgress.style.background = "#D14B55";
}

port.onMessage.addListener((message) => {
  if (message?.type === "captureViewport") {
    chrome.tabs.captureVisibleTab(message.windowId, { format: "png" }, (dataUrl) => {
      const error = chrome.runtime.lastError?.message;
      port.postMessage({
        type: "captureViewportResult",
        token: message.token,
        dataUrl: dataUrl || null,
        error: error || (dataUrl ? null : "Unable to capture this viewport."),
      });
    });
    return;
  }
  if (message?.type === "closeForPicker") window.close();
  if (message?.type === "captureProgress") updateProgress(message);
  if (message?.type === "captureError") showError(message.error);
});

async function startCapture(mode, options = {}) {
  const labels = {
    fullPage: "Preparing full page",
    visible: "Capturing visible area",
    selection: "Open page and drag an area",
  };
  buttons.forEach((button) => {
    button.disabled = true;
  });

  if (mode === "selection") {
    status.textContent = labels.selection;
    status.classList.add("loading");
  } else {
    updateProgress({
      percent: mode === "visible" ? 12 : 2,
      label: labels[mode] || "Preparing capture",
      detail: mode === "visible"
        ? "Taking the screenshot now"
        : "Finding the page content to capture",
      count: "Starting",
    });
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "startCapture",
      mode,
      options,
    });
  } catch (err) {
    response = { ok: false, error: err.message };
  }

  if (!response || !response.ok) {
    if (mode === "selection") {
      status.textContent = response?.error || "Capture failed.";
      status.classList.remove("loading");
      buttons.forEach((button) => {
        button.disabled = false;
      });
    } else {
      showError(response?.error || "Capture failed.");
    }
    return;
  }

  // The selection overlay needs focus on the page. Full-page and visible-area
  // captures keep this popup open so it can animate and service fast captures.
  if (mode === "selection" || options.pickTarget) window.close();
}

buttons.forEach((button) => {
  button.addEventListener("click", (event) => {
    // Alt/Shift-click forces the scroll-area picker when the automatic choice
    // is wrong (pages with several independently scrolling panes).
    const pickTarget =
      button.dataset.mode === "fullPage" && (event.altKey || event.shiftKey);
    startCapture(button.dataset.mode, { pickTarget });
  });
});

document.getElementById("history").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const options = { url: chrome.runtime.getURL("history.html") };
  if (tab?.id) options.openerTabId = tab.id;
  await chrome.tabs.create(options);
  window.close();
});
