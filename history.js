async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  return history;
}

async function saveHistory(history) {
  await chrome.storage.local.set({ history });
}

function normalizeHistoryLimit(value) {
  return Math.min(50, Math.max(1, Number(value) || 20));
}

function filename(entry) {
  return `${entry.baseName || "screenshot"}.png`;
}

function render(history) {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  grid.textContent = "";
  empty.hidden = history.length > 0;

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
    meta.textContent = `${entry.width} x ${entry.height} px - ${new Date(entry.savedAt).toLocaleString()}`;

    const actions = document.createElement("div");
    actions.className = "actions";

    const download = document.createElement("a");
    download.href = entry.dataUrl;
    download.download = filename(entry);
    download.textContent = "Download";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      const next = await loadHistory();
      next.splice(index, 1);
      await saveHistory(next);
      render(next);
    });

    actions.append(download, remove);
    body.append(title, meta, actions);
    card.append(img, body);
    grid.appendChild(card);
  });
}

document.getElementById("clearAll").addEventListener("click", async () => {
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
