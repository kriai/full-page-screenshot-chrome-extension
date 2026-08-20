async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  return history;
}

async function saveHistory(history) {
  await chrome.storage.local.set({ history });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHistoryLimit(value) {
  return Math.min(50, Math.max(1, Number(value) || 20));
}

function filename(entry) {
  return `${entry.baseName || "screenshot"}.png`;
}

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_err) {
    return "Unknown source";
  }
}

function inferMode(entry) {
  const mode = entry.mode || "";
  if (mode === "fullPage") return "Full page";
  if (mode === "visible") return "Visible";
  if (mode === "selection") return "Selection";
  if (entry.baseName?.includes("-visible-")) return "Visible";
  if (entry.baseName?.includes("-selection-")) return "Selection";
  if (entry.baseName?.includes("-full-page-")) return "Full page";
  return "Screenshot";
}

function formatSavedAt(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRemaining(ms) {
  if (ms <= 0) return "Link expired";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}

function copyIconSvg() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
}

function syncUploadTimers() {
  document.querySelectorAll("[data-upload-expires-at]").forEach((element) => {
    const expiresAt = Number(element.dataset.uploadExpiresAt);
    const remaining = expiresAt - Date.now();
    const timer = element.querySelector(".upload-timer");
    const link = element.querySelector("a");
    const copy = element.querySelector(".copy-upload-link");
    const expired = remaining <= 0;

    element.classList.toggle("expired", expired);
    if (timer) timer.textContent = formatRemaining(remaining);
    if (link) {
      link.hidden = expired;
      link.removeAttribute("aria-disabled");
    }
    if (copy) copy.hidden = expired;
  });
}

function render(history) {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const clearAll = document.getElementById("clearAll");
  grid.textContent = "";
  empty.hidden = history.length > 0;
  clearAll.disabled = history.length === 0;

  history.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = entry.dataUrl;
    img.alt = entry.title || "Saved screenshot";

    const body = document.createElement("div");
    body.className = "body";

    const title = document.createElement("p");
    title.className = "title";
    title.textContent = entry.title || "Screenshot";

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${entry.width} x ${entry.height} px - ${formatSavedAt(entry.savedAt)}`;

    const metaRow = document.createElement("div");
    metaRow.className = "meta-row";

    const mode = document.createElement("span");
    mode.className = "pill";
    mode.textContent = inferMode(entry);

    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = sourceDomain(entry.url);
    domain.title = entry.url || "";

    metaRow.append(mode, domain);

    const uploadStatus = document.createElement("div");
    uploadStatus.className = "upload-status";
    uploadStatus.hidden = !entry.uploadUrl || !entry.uploadExpiresAt;
    if (entry.uploadExpiresAt) {
      uploadStatus.dataset.uploadExpiresAt = String(entry.uploadExpiresAt);
    }

    const uploadTimer = document.createElement("span");
    uploadTimer.className = "upload-timer";
    uploadTimer.textContent = formatRemaining((entry.uploadExpiresAt || 0) - Date.now());

    const uploadLink = document.createElement("a");
    uploadLink.href = entry.uploadUrl || "#";
    uploadLink.target = "_blank";
    uploadLink.rel = "noreferrer";
    uploadLink.textContent = "Open upload";
    uploadLink.title = "Open uploaded Uguu link";

    const uploadActions = document.createElement("div");
    uploadActions.className = "upload-actions";

    const copyUpload = document.createElement("button");
    copyUpload.type = "button";
    copyUpload.className = "icon-button copy-upload-link";
    copyUpload.innerHTML = copyIconSvg();
    copyUpload.title = "Copy uploaded link";
    copyUpload.setAttribute("aria-label", "Copy uploaded link");
    copyUpload.addEventListener("click", async () => {
      await navigator.clipboard.writeText(entry.uploadUrl);
      copyUpload.textContent = "✓";
      setTimeout(() => {
        copyUpload.innerHTML = copyIconSvg();
      }, 900);
    });

    uploadActions.append(uploadLink, copyUpload);
    uploadStatus.append(uploadTimer, uploadActions);

    const actions = document.createElement("div");
    actions.className = "actions";

    const download = document.createElement("a");
    download.href = entry.dataUrl;
    download.download = filename(entry);
    download.textContent = "Download";
    download.title = "Download PNG";

    const source = document.createElement("a");
    source.href = entry.url || "#";
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Open page";
    source.title = "Open original page";
    source.hidden = !entry.url;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.title = "Delete saved screenshot";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      card.classList.add("removing");
      await wait(140);
      const next = await loadHistory();
      next.splice(index, 1);
      await saveHistory(next);
      render(next);
    });

    actions.append(download, source, remove);
    body.append(title, metaRow, meta, uploadStatus, actions);
    card.append(img, body);
    grid.appendChild(card);
  });

  syncUploadTimers();
}

document.getElementById("clearAll").addEventListener("click", async () => {
  const history = await loadHistory();
  if (history.length === 0) return;
  if (!confirm(`Clear ${history.length} saved screenshot${history.length === 1 ? "" : "s"}?`)) {
    return;
  }
  await saveHistory([]);
  render([]);
});

async function setupLimit() {
  const input = document.getElementById("historyLimit");
  const { historyLimit = 20 } = await chrome.storage.local.get("historyLimit");
  input.value = String(normalizeHistoryLimit(historyLimit));

  input.addEventListener("change", async () => {
    const limit = normalizeHistoryLimit(input.value);
    input.value = String(limit);
    const history = (await loadHistory()).slice(0, limit);
    await chrome.storage.local.set({ history, historyLimit: limit });
    render(history);
  });
}

setupLimit();
loadHistory().then(render);
setInterval(syncUploadTimers, 1000);

async function setupBackToPage() {
  const button = document.getElementById("backToPage");
  const current = await chrome.tabs.getCurrent();
  if (!current?.openerTabId) return;

  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await chrome.tabs.update(current.openerTabId, { active: true });
      await chrome.tabs.remove(current.id);
    } catch (_err) {
      button.hidden = true;
    }
  });
}

setupBackToPage();
