// Which pages can be captured, and what to tell someone when one cannot.
// Pure functions: loaded by the service worker with importScripts and by the
// node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FpsPageAccess = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MESSAGES = {
    browser: "Chrome doesn't let extensions capture its own pages (settings, new tab, extensions).",
    extension: "Pages that belong to an extension can't be captured.",
    store: "Chrome doesn't let extensions capture the Chrome Web Store.",
    devtools: "Developer tools can't be captured.",
    about: "about: pages can't be captured.",
    viewSource: "view-source: pages can't be captured. Open the page itself instead.",
    special: "This kind of address can't be captured.",
    pdf: "Chrome's PDF viewer can't be captured.",
    file: 'To capture files on your computer, open chrome://extensions, click Details on this extension and turn on "Allow access to file URLs".',
    invalid: "This page can't be captured.",
  };

  const PROTOCOLS = {
    "chrome:": "browser",
    "chrome-untrusted:": "browser",
    "chrome-search:": "browser",
    "edge:": "browser",
    "brave:": "browser",
    "opera:": "browser",
    "vivaldi:": "browser",
    "chrome-extension:": "extension",
    "moz-extension:": "extension",
    "devtools:": "devtools",
    "about:": "about",
    "data:": "special",
    "blob:": "special",
    "javascript:": "special",
    "filesystem:": "special",
  };

  const STORE_HOSTS = ["chromewebstore.google.com", "chrome.google.com", "microsoftedge.microsoft.com"];

  function blocked(reason) {
    return { ok: false, reason, message: MESSAGES[reason] };
  }

  // `fileAccess` is chrome.extension.isAllowedFileSchemeAccess(), which only
  // the caller can ask.
  function classifyUrl(url, { fileAccess = false } = {}) {
    if (!url) return blocked("invalid");
    if (url.startsWith("view-source:")) return blocked("viewSource");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return blocked("invalid");
    }
    if (PROTOCOLS[parsed.protocol]) return blocked(PROTOCOLS[parsed.protocol]);
    if (parsed.protocol === "file:") return fileAccess ? { ok: true } : blocked("file");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return blocked("special");
    if (parsed.hostname === "chrome.google.com" && !parsed.pathname.startsWith("/webstore")) return { ok: true };
    if (STORE_HOSTS.includes(parsed.hostname)) return blocked("store");
    if (/\.pdf$/i.test(parsed.pathname)) return blocked("pdf");
    return { ok: true };
  }

  // Chrome's own wording for failures, turned into something a person can act
  // on. Anything unrecognised is passed through rather than hidden.
  const ERRORS = [
    [/cannot be scripted|extensions gallery|cannot access a chrome/i, MESSAGES.browser],
    [/Cannot access contents of (the page|url)|must request permission|activeTab/i,
      "Chrome withdrew access to this tab. Click the extension's button again to capture it."],
    [/No tab with id|tab was closed/i, "The tab was closed before the capture finished."],
    [/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/, "Chrome is limiting screenshots right now. Wait a moment and try again."],
    [/Frame with ID \d+ (was removed|is showing error page)|error page/i,
      "The page changed while it was being captured. Try again once it has finished loading."],
    [/image readback failed|Failed to capture tab/i,
      "Chrome couldn't take the screenshot. Make sure the tab is visible and try again."],
  ];

  function explainError(err) {
    const message = (err && err.message) || String(err || "");
    for (const [pattern, text] of ERRORS) if (pattern.test(message)) return text;
    return message || "Capture failed.";
  }

  return { classifyUrl, explainError, MESSAGES };
});
