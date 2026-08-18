const status = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-mode]"));

async function startCapture(mode) {
  status.textContent = mode === "selection" ? "Drag an area on the page." : "Capturing...";
  buttons.forEach((button) => {
    button.disabled = true;
  });

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "startCapture",
      mode,
    });
  } catch (err) {
    response = { ok: false, error: err.message };
  }

  if (!response || !response.ok) {
    status.textContent = response?.error || "Capture failed.";
    buttons.forEach((button) => {
      button.disabled = false;
    });
    return;
  }

  window.close();
}

buttons.forEach((button) => {
  button.addEventListener("click", () => startCapture(button.dataset.mode));
});

document.getElementById("history").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  window.close();
});
