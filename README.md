# Full Page Screenshot

Chrome extension (Manifest V3) that captures a full-page screenshot by
scrolling the page viewport-by-viewport, stitching the slices on a canvas,
and opening the result in a new tab with a download button.

## Load it

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open any normal web page and click the extension's toolbar button
   (pin it via the puzzle-piece menu if you don't see it)

## How it works

- `background.js` (service worker) drives the capture: it measures the page,
  scrolls one viewport at a time via `chrome.scripting.executeScript`, and
  grabs each slice with `chrome.tabs.captureVisibleTab`. Fixed/sticky
  elements are hidden after the first slice so headers don't repeat.
- Frames are handed to `viewer.html` through `chrome.storage.local`
  (data URLs are large, hence the `unlimitedStorage` permission).
- `viewer.js` stitches the slices onto a canvas at the captured pixel scale
  and renders the final PNG.

## Known limitations

- Can't capture `chrome://` pages, the Chrome Web Store, or PDFs.
- Pages that scroll inside an inner container (not the window) won't scroll.
- Extremely tall pages can exceed the browser's max canvas height (~32k px).
- `captureVisibleTab` is rate-limited to ~2 calls/sec, so long pages take a
  moment; the toolbar badge shows progress.
