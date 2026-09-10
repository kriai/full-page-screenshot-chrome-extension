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
- On-page capture progress appears once before the capture and once after it,
  and never flashes between frames: while frames are being taken the toolbar
  icon carries the count and the hover tooltip carries the detail.

## How it works

- `popup.html` and `popup.js` show the capture mode choices.
- `background.js` (service worker) drives the capture. For full-page captures it
  injects `capture-page.js`, picks a **scroll target** (the document or the
  dominant scrollable element), then repeats: scroll, wait for layout and images
  to settle, measure the readable band, and grab it with
  `chrome.tabs.captureVisibleTab`.
- `capture-page.js` is the page-side half: target ranking and verification,
  settle detection, per-frame geometry, occlusion handling, the click-to-select
  picker, and an idempotent restore.
- `capture-geometry.js` holds the pure geometry shared by the worker, the viewer
  and the tests: scroll planning, overlap trimming, gap detection and canvas
  budgets.
- Frames are handed to `viewer.html` through `chrome.storage.local`
  (data URLs are large, hence the `unlimitedStorage` permission).
- `viewer.js` stitches or crops the captured frame data onto an editable canvas
  at the captured pixel scale, applies annotations, then prepares clipboard,
  PNG, JPEG, and PDF outputs.

### Full-page capture details

- **Any scroll container.** The target is ranked by how much of the viewport it
  owns, how much content it holds and how centred it is - no host names or class
  names - and is confirmed with a reversible one-pixel scroll. Pages whose body
  does not scroll (fixed app shells, chat UIs, dashboards) work the same way as
  ordinary pages.
- **Choose the area yourself.** When two panes score almost the same, the picker
  opens automatically. **Alt-click** (or Shift-click) *Full page screenshot* to
  force it.
- **Lazy loading and growing pages.** Each step waits for the scroll height,
  target rectangle and on-screen images to stop changing, and the content height
  is re-measured after every frame.
- **Pinned elements.** Anything pinned over the capture band is classified by
  where it sits, not by what site it is on:
  - A bar pinned to the *top* is page furniture: it appears once, in the first
    frame, and the band is trimmed below it afterwards.
  - A bar pinned to the *bottom* (composer, toolbar, cookie bar) covers content
    in every frame, including the first, so it is excluded from all of them.
  - `position: fixed` elements are hidden, even when they sit inside the scroll
    container in the DOM - they never scroll with the content, so they are
    always chrome. `position: sticky` elements are only trimmed around, never
    hidden: they are page content that happens to be pinned, and hiding an
    app's own composer can wake up its "stick to bottom" logic and move the
    page out from under the capture.
  - A pinned element is measured together with the children it paints outside
    its own box (a scroll-to-bottom button floating above a composer, say), so
    the whole cluster is treated as one occluder.
  - Occlusion is decided fresh on every frame, so an element that scrolls back
    into its natural position reappears there. Every changed inline style is
    restored with its original value and priority.
- **Threads that load older content.** If the target pages in content when it
  reaches the top, the capture waits there until it stops growing - otherwise
  every offset measured afterwards would be wrong.
- **Explicit stitching.** Every frame records the viewport rectangle it read and
  the content offset it belongs at, so overlap is trimmed deterministically and
  missing rows are reported instead of silently dropped.
- **Bounded failures.** Time, frame count, page height and canvas budgets stop
  runaway pages; the viewer then says the capture is partial and why. Capture is
  cancelled if the tab navigates, closes, or stops being the active tab.
- **Progress without flicker.** Every frame is photographed, so nothing drawn on
  the page can be visible while the loop runs. The panel therefore shows once up
  front - section count, rough duration, "keep this tab active" - fades out for
  the whole loop, and returns for stitching. During the loop the toolbar badge
  shows `12/50` and its tooltip the percentage; neither can land in a shot.

## Tests

- `node --test "test/*.test.mjs"` covers the shared geometry and replays the
  capture walk against simulated pages (sticky headers, pinned bars appearing
  mid-run, lazy growth, single-frame pages).
- `test/fixtures/*.html` are manual pages for the real extension: document
  scrolling, a fixed app shell, nested scrollers, two competing panes, sticky
  and fixed chrome, lazy images with a growing page, a virtualized list, and a
  ~20k-element heavy DOM. Serve them (`python3 -m http.server`) and capture each
  one; every numbered row must appear exactly once.
- `test/fixtures/_harness.js` drives the real page-side engine against any page
  without taking screenshots, and reports coverage, gaps, occlusion handling and
  restoration. In the page console:

  ```js
  (0, eval)(await (await fetch('/test/fixtures/_harness.js')).text());
  await __fpsHarness();
  ```

### Diagnostics

Capture diagnostics are off by default. Turn them on from the service worker
console with `chrome.storage.local.set({ captureDiagnostics: true })`; each run
then logs per-frame geometry, offsets and timings (no page text, no image data)
and attaches them to the capture handed to the viewer.

## Known limitations

- Can't capture `chrome://` pages, the Chrome Web Store, or PDFs.
- Only one vertical scroll target per capture: independently scrolling panes are
  not combined into a single image, and horizontal tiling is not supported.
- Virtualized lists are captured viewport by viewport; if the list recycles rows
  with unstable offsets the capture is reported as incomplete.
- Cross-origin iframes and closed shadow roots cannot be expanded or measured.
- Selected-area capture is limited to the current visible viewport.
- Extremely tall pages stop at the canvas budget (~32k px per side) with an
  explanation rather than a broken image.
- The strip of content hidden behind a sticky bottom bar at the very end of a
  page cannot be reached, since hiding the bar risks disturbing the app. It is
  the bar's own footprint, so the capture is still reported as complete.
- The tab must stay active for the whole capture; Chrome throttles timers and
  refuses `captureVisibleTab` for background tabs, so switching away cancels
  the run.
- `captureVisibleTab` is rate-limited to ~2 calls/sec, so long pages take a
  moment; the toolbar badge shows progress.
