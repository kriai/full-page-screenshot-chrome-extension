const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-mode]"));

async function startCapture(mode, options = {}) {
  const labels = {
    fullPage: "Starting full-page capture",
    visible: "Starting visible-area capture",
    selection: "Open page and drag an area",
  };
  status.textContent = options.pickTarget
    ? "Click the area to capture"
    : labels[mode] || "Starting capture";
  status.classList.add("loading");
  buttons.forEach((button) => {
    button.disabled = true;
  });

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
    status.textContent = response?.error || "Capture failed.";
    status.classList.remove("loading");
    buttons.forEach((button) => {
      button.disabled = false;
    });
    return;
  }

  window.close();
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
