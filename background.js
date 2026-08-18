// Chrome rate-limits captureVisibleTab to ~2 calls/second, and the page needs
// time to repaint after each scroll (lazy images, animations settling).
const CAPTURE_DELAY_MS = 600;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    // chrome://, the Web Store, PDFs etc. cannot be captured
    return;
  }
  try {
    await captureFullPage(tab);
  } catch (err) {
    console.error("Full page capture failed:", err);
    await chrome.action.setBadgeText({ text: "ERR", tabId: tab.id });
  }
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
          const pos = getComputedStyle(el).position;
          if (pos === "fixed" || pos === "sticky") {
            el.dataset.fpsHidden = "1";
            el.style.setProperty("visibility", "hidden", "important");
          }
        }
      });
    }

    await sleep(CAPTURE_DELAY_MS);

    // The browser may clamp the scroll; record where the page actually is.
    const actualY = await exec(tabId, () => window.scrollY);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    frames.push({ y: actualY, dataUrl });
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
  await chrome.action.setBadgeText({ text: "", tabId });

  // Hand the frames to the viewer page via storage (data URLs can be many MB,
  // which is why the manifest requests unlimitedStorage).
  await chrome.storage.local.set({
    capture: {
      frames,
      metrics,
      pageUrl: tab.url,
      pageTitle: tab.title,
      capturedAt: Date.now(),
    },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
}
