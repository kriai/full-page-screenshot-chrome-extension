const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-mode]"));
const actions = document.getElementById("capture-actions");
const captureState = document.getElementById("capture-state");
const errorState = document.getElementById("error-state");
const captureLabel = document.getElementById("capture-label");
const captureDetail = document.getElementById("capture-detail");
const captureCount = document.getElementById("capture-count");
const capturePercent = document.getElementById("capture-percent");
const captureProgress = document.getElementById("capture-progress");
const progressTrack = document.querySelector(".progress-track");
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Set once Cancel is pressed, so the progress and error messages the stopping
// run still sends don't bring its card back.
let canceledByUser = false;

// Keeping the popup connected serves two purposes: it receives live progress,
// and it can take viewport snapshots for the worker while it remains open,
// following the reference extension's handoff. Chrome may enforce the same
// global quota on either caller; the worker treats that refusal as a wait and
// retry. If the popup closes, its direct path takes over and the toolbar badge
// keeps showing status.
const port = chrome.runtime.connect({ name: "capture-popup" });

// One of the three cards: the capture buttons, progress, or a failure.
function showView(view) {
  actions.hidden = view !== actions;
  captureState.hidden = view !== captureState;
  errorState.hidden = view !== errorState;
}

function showCaptureState() {
  status.textContent = "";
  if (!captureState.hidden) return;
  showView(captureState);
  if (!prefersReducedMotion) {
    captureState.animate(
      [
        { opacity: 0, transform: "translateY(8px) scale(.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }
    );
  }
}

function showIdle() {
  showView(actions);
  buttons.forEach((button) => {
    button.disabled = false;
  });
  captureProgress.style.width = "2%";
  status.textContent = "";
  buttons[0].focus();
}

function updateProgress(message) {
  if (canceledByUser) return;
  showCaptureState();
  const percent = Math.max(0, Math.min(100, Math.round(Number(message.percent) || 0)));
  captureLabel.textContent = message.label || "Capturing screenshot";
  captureDetail.textContent = message.detail || "Keep this tab active until capture finishes.";
  captureCount.textContent = message.count || "Working";
  capturePercent.textContent = `${percent}%`;
  captureProgress.style.width = `${Math.max(2, percent)}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
}

// Shorter wording for the popup's two-line message, where page-access.js has
// a longer explanation for the toolbar badge.
const BLOCKED_COPY = {
  browser: "Chrome blocks extensions on its own pages. Open a regular website and try again.",
  file: "Allow file access in the extension's settings to capture files on your computer.",
};

// `reason` comes from page-access.js and means the page can't be captured at
// all; a file page has a setting that fixes it, so the card offers a way
// straight to it. `url` is the tab's address, when the worker could see it.
function showError(message, { reason, url, canceled } = {}) {
  if (canceledByUser) return;
  showView(errorState);
  document.getElementById("error-title").textContent = reason
    ? "Can't capture this page"
    : canceled
      ? "Capture stopped"
      : "Capture failed";
  const detail = document.getElementById("error-detail");
  detail.textContent = BLOCKED_COPY[reason] || message || "Please try again.";
  detail.title = message || "";
  const chip = document.getElementById("error-url");
  chip.hidden = !url;
  chip.firstElementChild.textContent = url || "";
  chip.title = url || "";
  const fix = document.getElementById("capture-fix");
  fix.hidden = reason !== "file";
  fix.onclick = () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    window.close();
  };
  document.getElementById("error-back").focus();
}

document.getElementById("error-back").addEventListener("click", showIdle);

// Cancel asks the worker to stop the run in this tab; it stops at the next
// frame, restores the page and deletes what it had captured.
document.getElementById("capture-cancel").addEventListener("click", async () => {
  canceledByUser = true;
  showIdle();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "cancelCapture", tabId: tab?.id }).catch(() => {});
});

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
  if (message?.type === "captureError") {
    showError(message.error, { url: message.url, canceled: message.canceled });
  }
});

async function startCapture(mode, options = {}) {
  const labels = {
    fullPage: "Preparing full page",
    visible: "Capturing visible area",
    selection: "Open page and drag an area",
  };
  canceledByUser = false;
  buttons.forEach((button) => {
    button.disabled = true;
  });

  if (mode === "selection") {
    status.textContent = labels.selection;
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
    showError(response?.error || "Capture failed.", { reason: response?.reason, url: response?.url });
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
    const pickTarget = button.dataset.mode === "fullPage" && (event.altKey || event.shiftKey);
    startCapture(button.dataset.mode, { pickTarget });
  });
});

// Show each mode's keyboard shortcut, if one is set, in its button's tooltip.
chrome.commands.getAll().then((commands) => {
  const modes = { "capture-full-page": "fullPage", "capture-visible": "visible", "capture-area": "selection" };
  for (const command of commands) {
    const button = buttons.find((b) => b.dataset.mode === modes[command.name]);
    if (button && command.shortcut) button.title = `${button.title} (${command.shortcut})`;
  }
});

document.getElementById("history").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const options = { url: chrome.runtime.getURL("history.html") };
  if (tab?.id) options.openerTabId = tab.id;
  await chrome.tabs.create(options);
  window.close();
});
