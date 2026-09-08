# Full Page Screenshot

Chrome extension (Manifest V3) that captures full-page, visible-area, or
selected-area screenshots and opens the result in a new tab with copy and
export controls.

## Load it

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open any normal web page and click the extension's toolbar button
   (pin it via the puzzle-piece menu if you don't see it)
5. Choose **Capture full page**, **Capture visible area**, or **Select area**

## Features

- Full-page capture by scrolling and stitching viewport screenshots.
- Visible-area capture for the current viewport.
- Selected-area capture by dragging a rectangle over the current viewport.
- Copy the rendered PNG to the clipboard.
- One-click upload to Uguu with the image URL copied to the clipboard.
- Export as PNG, JPEG, or PDF.
- Download filenames include the page domain, page title, capture mode, and
  timestamp.
- Annotate screenshots with arrows, boxes, freehand pen, click-to-type text,
  crop, blur, pixelate, and redaction before copying or exporting.
- Move and resize existing annotations by clicking them directly.
- Add numbered step markers for walkthroughs and bug reports.
- Add a presentation canvas with background, padding, rounded corners, shadow,
  and aspect-ratio controls for polished exports.
- Undo and redo annotation changes.
- Automatically save captures to a local history page. History keeps 20 images
  by default and can be changed from the history page.
- Reopen saved history items as editable projects with annotations and export
  layout settings preserved.
- Preview the active annotation style before drawing.
- On-page capture progress shows the current capture step without appearing in
  the final screenshot.

## How it works

- `popup.html` and `popup.js` show the capture mode choices.
- `background.js` (service worker) drives the capture: it measures the page,
  optionally collects a drag selection, shows temporary progress UI, scrolls one
  viewport at a time for full-page captures via
  `chrome.scripting.executeScript`, and grabs each slice with
  `chrome.tabs.captureVisibleTab`. Fixed/sticky elements are hidden after the
  first full-page slice so headers don't repeat.
- Frames are handed to `viewer.html` through `chrome.storage.local`
  (data URLs are large, hence the `unlimitedStorage` permission).
- `viewer.js` stitches or crops the captured frame data onto an editable canvas
  at the captured pixel scale, applies annotations, then prepares clipboard,
  PNG, JPEG, and PDF outputs.

## Known limitations

- Can't capture `chrome://` pages, the Chrome Web Store, or PDFs.
- Pages that scroll inside an inner container (not the window) won't scroll.
- Selected-area capture is limited to the current visible viewport.
- Extremely tall pages can exceed the browser's max canvas height (~32k px).
- `captureVisibleTab` is rate-limited to ~2 calls/sec, so long pages take a
  moment; the toolbar badge shows progress.
