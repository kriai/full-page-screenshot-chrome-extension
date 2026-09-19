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
- The popup becomes a live animated progress view during capture. If it is
  closed, capture continues and the toolbar icon carries the section count.

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
  and the tests: scroll planning, overlap trimming, gap detection, seam
  alignment and canvas budgets.
- Full-page frames are stitched incrementally into an `OffscreenCanvas` in the
  service worker while capture is still running. The finished PNG is saved to
  history before `viewer.html` opens, so the editor loads one ready image rather
  than decoding and joining every viewport itself. If worker-side canvas work
  fails, the raw-frame viewer path remains as a fallback.
- `viewer.js` loads the prepared image onto an editable canvas, applies
  annotations, then prepares clipboard, PNG, JPEG, and PDF outputs.

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
- **The page is held still first.** Between the first frame and the last, a
  live page keeps moving: entrance animations play, spinners turn, videos run,
  and scroll-linked effects slide things under the camera. Before anything is
  measured the page is pinned down - finite animations are run to their
  finished state rather than switched off, since a scroll-reveal effect that is
  merely cancelled snaps back to the `opacity: 0` it started from; endless ones
  are parked; video is paused; parallax is fixed in place. Cookie scrims and
  modal dialogs, which otherwise cover content in every single frame, are
  identified by shape rather than by class name and taken out of the shot. All
  of it is recorded and reversed afterwards.
- **An app shell is captured as a window, not a column.** Where the page
  scrolls a pane inside fixed furniture - a sidebar, a header, a composer - the
  finished image is the whole window, not the bare pane. The pane's content is
  stitched as usual and the furniture is painted around it once: the header
  keeps its place above, the sidebar beside, and whatever sits below the pane
  is moved to the foot of the image rather than repeating down the middle of
  it. The side columns only carry as far as the furniture was ever on screen,
  which is one viewport.
- **Full-height side rails are kept, not deleted.** A navigation rail pinned to
  the viewport cannot simply be hidden - that removes a real column of the
  page - and cannot be left fixed, or it repeats down every frame. It is
  re-pinned to the document where it currently sits, so it renders once, in
  full. Bottom-pinned bars are hidden while scrolling past and restored for the
  final frame, where they belong.
- **Seams checked against the pixels.** A frame's offset comes from `scrollTop`,
  which assumes the page moved exactly as far as it was asked to. Sub-pixel
  rounding, scroll anchoring and a late-settling row all break that quietly. So
  each frame's overlap is compared against the previous frame's and slid to the
  offset that actually lines up; a join still wrong after that has its frame
  re-taken, up to three times per capture. Repetitive content that offers no
  single convincing match is left where the arithmetic put it.
- **Content that loads in above the viewport.** A comment thread or feed can
  prepend rows mid-capture, pushing everything below them down the document
  while `scrollTop` stays put - every frame already taken is then recorded
  against coordinates that no longer exist. One element near the foot of the
  viewport is tracked across frames, and any jump in its absolute position is
  taken out of the offsets handed to the viewer. Large jumps are only believed
  when the document grew to match, so a route change is not mistaken for a
  shift.
- **Pages taller than a canvas are fitted, not cut.** Chrome will not allocate
  a canvas past 32767px on a side, which a long page passes easily. Given the
  choice between the whole page slightly reduced and a sharp fragment of it,
  the stitcher scales the output down to fit and says by how much. Only a page
  that would need reducing past a fifth is refused.
- **The editor opens with a finished image.** Each frame is added to the worker's
  canvas as soon as its seam has been checked. At the end that canvas is encoded
  and stored once as both the capture and its initial history entry; only then
  is the editor tab opened. This avoids a blank editor waiting to decode,
  stitch, re-encode, and save the same screenshot a second time.
- **Bounded failures.** Time, frame count, page height and canvas budgets stop
  runaway pages; the viewer then says the capture is partial and why. Capture is
  cancelled if the tab navigates, closes, or stops being the active tab.
- **Progress without flicker.** Every frame is photographed, so progress stays
  in the extension popup instead of being drawn over the page. Its animated bar
  tracks captured sections. If the popup closes, the toolbar badge shows
  `12/50` and its tooltip the percentage; neither can land in a shot.
- **Resilient capture handoff.** While the progress popup stays open, it takes
  viewport snapshots for the service worker. Chrome can enforce its global
  screenshot quota on either caller, so temporary quota refusals are waited out
  and retried instead of failing the capture. Closing the popup is safe: the
  worker path takes over automatically.

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

## Releasing

Packaging is automated. Merging to `main` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Compares the merge against the last `v*` tag to see whether any **shipped
   extension file** changed. Docs, `store-assets/`, `.github/` and `scripts/`
   don't count — a README-only merge produces no version bump and no release.
2. Bumps `manifest.json`: **minor** by default. Put `[patch]` or `[major]` in
   a PR title or a commit **subject line** to override. Only subject lines are
   scanned - a commit body that mentions the keyword, such as one documenting
   this convention, does not trigger it.
3. Builds the zip, commits the bump, tags `vX.Y.Z`, and publishes a GitHub
   Release with the zip attached.

Grab the zip from the [Releases page](../../releases) and upload it at the
[Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole).

To build the same zip locally:

```sh
./scripts/package.sh          # -> fullpage-screenshot-<version>.zip
./scripts/package.sh --list   # show exactly what would ship
```

The package is *everything git tracks* minus the excludes listed at the top of
`scripts/package.sh`, so a new source file ships automatically — nothing to
register. CI and local builds run the identical script.

You can also trigger a build by hand from the **Actions** tab
("Package extension" → "Run workflow"), which lets you pick the bump type.
