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

async function openInEditor(entry) {
  const project = entry.project || null;
  const dataUrl = project?.baseDataUrl || entry.dataUrl;
  await chrome.storage.local.set({
    capture: {
      baseName: entry.baseName || "screenshot",
      capturedAt: entry.savedAt || Date.now(),
      frames: [{ x: 0, y: 0, dataUrl }],
      fromHistory: true,
      metrics: {
        viewportWidth: project?.baseWidth || entry.width,
        viewportHeight: project?.baseHeight || entry.height,
        dpr: 1,
        originalScrollX: 0,
        originalScrollY: 0,
      },
      mode: "visible",
      pageTitle: entry.title || "Screenshot",
      pageUrl: entry.url || "",
      project,
    },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
}

function copyIconSvg() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
}

function iconSvg(name) {
  const icons = {
    check: `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m5 12 4 4L19 6"></path>
      </svg>
    `,
    download: `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12"></path>
        <path d="m7 10 5 5 5-5"></path>
        <path d="M5 21h14"></path>
      </svg>
    `,
    edit: `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
      </svg>
    `,
    external: `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 3h6v6"></path>
        <path d="M10 14 21 3"></path>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      </svg>
    `,
    trash: `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M19 6l-1 14H6L5 6"></path>
      </svg>
    `,
  };
  return icons[name] || "";
}

function makeIconControl(element, icon, label) {
  element.classList.add("icon-button");
  element.innerHTML = iconSvg(icon);
  element.title = label;
  element.setAttribute("aria-label", label);
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
    if (timer) timer.textContent = expired ? "Upload expired" : formatRemaining(remaining);
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
    card.tabIndex = 0;
    card.title = "Press Enter to edit this screenshot";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = entry.dataUrl;
    img.alt = entry.title || "Saved screenshot";
    img.title = "Open saved screenshot in the editor";
    img.addEventListener("click", async () => {
      await openInEditor(entry);
    });

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
      copyUpload.classList.add("copied");
      copyUpload.innerHTML = iconSvg("check");
      copyUpload.title = "Copied uploaded link";
      copyUpload.setAttribute("aria-label", "Copied uploaded link");
      setTimeout(() => {
        copyUpload.classList.remove("copied");
        copyUpload.innerHTML = copyIconSvg();
        copyUpload.title = "Copy uploaded link";
        copyUpload.setAttribute("aria-label", "Copy uploaded link");
      }, 900);
    });

    uploadActions.append(uploadLink, copyUpload);
    uploadStatus.append(uploadTimer, uploadActions);

    const actions = document.createElement("div");
    actions.className = "actions";

    const download = document.createElement("a");
    download.href = entry.dataUrl;
    download.download = filename(entry);
    makeIconControl(download, "download", "Download PNG");

    const edit = document.createElement("button");
    edit.type = "button";
    makeIconControl(edit, "edit", "Open saved screenshot in the editor");
    edit.addEventListener("click", async () => {
      edit.disabled = true;
      edit.textContent = "...";
      try {
        await openInEditor(entry);
        edit.innerHTML = iconSvg("check");
      } catch (err) {
        console.error("Unable to open saved screenshot:", err);
        edit.textContent = "!";
      } finally {
        setTimeout(() => {
          edit.disabled = false;
          makeIconControl(edit, "edit", "Open saved screenshot in the editor");
        }, 1200);
      }
    });

    const source = document.createElement("a");
    source.href = entry.url || "#";
    source.target = "_blank";
    source.rel = "noreferrer";
    makeIconControl(source, "external", "Open original page");
    source.hidden = !entry.url;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.classList.add("danger-action");
    makeIconControl(remove, "trash", "Delete saved screenshot");
    let deleteConfirmTimer = null;
    const deleteEntry = async () => {
      remove.disabled = true;
      card.classList.add("removing");
      await wait(140);
      const next = await loadHistory();
      next.splice(index, 1);
      await saveHistory(next);
      render(next);
    };
    remove.addEventListener("click", async () => {
      if (!remove.classList.contains("confirming")) {
        remove.classList.add("confirming");
        remove.textContent = "Delete?";
        remove.title = "Click again to delete";
        remove.setAttribute("aria-label", "Click again to delete saved screenshot");
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = setTimeout(() => {
          remove.classList.remove("confirming");
          makeIconControl(remove, "trash", "Delete saved screenshot");
        }, 1800);
        return;
      }
      clearTimeout(deleteConfirmTimer);
      await deleteEntry();
    });

    card.addEventListener("keydown", async (event) => {
      if (event.target !== card) return;
      if (event.key === "Enter") {
        event.preventDefault();
        await openInEditor(entry);
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        remove.click();
      }
    });

    actions.append(download, edit, source, remove);
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
