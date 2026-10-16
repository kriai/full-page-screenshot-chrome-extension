# Competitive parity plan

Status: proposed, revised after review. Nothing here is implemented yet.

Reference: "Full Page Screenshot - Screen Capture & Editor" v3.1.0
(`ijidfpoenjmfdabnmchmdoopghmjnjij`), reverse-engineered from the installed
build. Notes and prettified sources are in `.context/rea/` (not tracked).

The capture engine here is already ahead of the reference on target
selection, occlusion, app-shell compositing, seam repair, prepend tracking,
permissions and tests. The reference is ahead on very long pages, slow-loading
pages and editor and store polish.

Two rules for this plan:
- A feature earns its place by fixing something measurable, not by being in
  the reference. Capture changes are judged against the benchmark in step 1.
- Keep the design rules that got the engine here: no host names or class
  names in capture logic, every page change recorded and reversed, failures
  reported rather than hidden.

## Delivery order

| # | PR | Size | Release |
| - | -- | ---- | ------- |
| 1 | End-to-end tests and a real-site benchmark | M | A |
| 1b | Fix the capture bugs the benchmark found | M | A |
| 2 | Image storage in IndexedDB, frames out of memory | M | A |
| 3 | Clear errors for pages that can't be captured, plus `file://` | S | A |
| 4a | Very long pages at full resolution: capture, view, export | L | B |
| 4b | Annotations on multi-part captures | M | B |
| 5 | "Wait for slow content" mode | M | B |
| 6 | Keyboard shortcuts | S | C |
| 7 | Editor: browser frame, saved defaults, date/URL stamp | M | C |
| 8 | Translated store listing, then interface translations | M | C |
| 9 | Rating prompt and uninstall survey | S | C |

Releases: every merge to `main` bumps the version and builds a release, which
would mean nine Web Store reviews. Merge the PRs of each release into a
`next` branch and merge that to `main` once per release.

---

## 1. End-to-end tests and a real-site benchmark

Every later step needs the real extension exercised in Chrome. Today that is
manual, because loading an unpacked extension needs the file picker.

End-to-end tests:
- Playwright with Chromium, a persistent context and
  `--load-extension=<build>`. Runs headed locally and with `--headless=new` in
  CI.
- Captures are started from the service worker
  (`context.serviceWorkers()[0].evaluate(...)`), calling `capturePage`
  directly, since the toolbar popup can't be clicked.
- `activeTab` is only granted by a user gesture, so tests use a test build
  that adds `<all_urls>` host access through a manifest overlay
  (`scripts/test-build.sh`). The shipped manifest is unchanged.
- Checking the result: fixture rows carry a colour band that encodes their
  index. The test decodes the stored image and asserts every index appears
  exactly once, in order. The checks are row-level, not pixel-perfect, so they
  don't break on font rendering.
- Covers every `test/fixtures/*.html` page, plus visible and area capture and
  history reopen.

Benchmark:
- `test/benchmark/sites.json`: 15-20 public pages covering a long article, a
  docs site, Wikipedia, an infinite feed, a single-page app with skeleton
  loaders, a sticky-header news site, a parallax marketing page, a GitHub
  file view and a page well past the canvas limit.
- `scripts/benchmark.mjs` runs each with diagnostics on and records: frames,
  seam retries, seam shifts, gap px, downscale factor, frames shot with images
  still loading, duration, and the truncation reason.
- Real sites change, so before/after runs are made on the same day and
  compared to each other, never to an old baseline.

## 1b. Fix the capture bugs the benchmark found

First baseline (2026-10-16, 1x, headless):

| Site | Result | Likely cause |
| ---- | ------ | ------------ |
| react.dev | 80 frames, image 80 px tall | A tall sticky sidebar is read as a header and footer at once, trimming the band to 80 px; the walk then cannot advance because the overlap (266 px) is larger than the band |
| MDN | 80-frame cap after 6,500 of 19,800 px | Same sidebar misread as a footer: 342 px band, 76 px steps |
| Google Fonts, WHATWG spec | No image at all | A page over the 80,000 px budget is refused before the first frame instead of captured up to the limit |
| dev.to | Worker stitcher failed, viewer fallback used | Infinite feed hit the frame cap at 59,000 px; stitcher failure not yet diagnosed |
| The Verge | Stuck, 132 px gap | The page shrinks while scrolling (ads collapsing); drift correction of -878 px |
| npm, Stack Overflow, Unsplash | Blank white page | Bot protection in headless Chromium; replace these sites or run with `HEADED=1` |

Fixed on `competitive-parity`, each with a fixture that failed first:

| Bug | Fix | Fixture |
| --- | --- | ------- |
| Sticky side columns read as header/footer | Released into the page flow for the capture (`fpsStickyRail`) | `sticky-rails.html`, `?full=1` |
| Walk stalls when pinned elements eat the band | Always advance at least half the last band (`CaptureWalk.nextTop`) | unit test |
| Pages over the height budget refused | Budget checked against what was captured; stitcher plans for what the budgets can reach | `very-tall.html` |
| Shrunk stitch one pixel over the canvas limit | `fitOutputScale` leaves 4px for rounding | `infinite-feed.html`, unit test |
| `#hash` updates while scrolling cancelled the capture (react.dev) | Only a change before the hash, or a reload, cancels | `scrollspy.html` |
| Shrinking page reported stuck; seams compared in stale coordinates, re-takes exhausted, rows repeated | Walk follows measured drift; completion uses live height; seam probe uses corrected positions | `collapsing-ads.html` |

The stitcher's failure message is now recorded in the diagnostics
(`stitchError`). npm, Stack Overflow and Unsplash still serve a blank page to
headless Chromium; they stay in the list for headed runs.

## 2. Image storage in IndexedDB, frames out of memory

Two problems that affect every capture, and that step 4 would make worse:
- Images are stored as base64 data URLs in `chrome.storage.local`. That's a
  third larger than the image, and every read and write moves the whole
  string.
- `runCaptureLoop` keeps every frame's data URL in memory for the whole run
  (`background.js:1409`), up to 80 screenshots at once today.

Changes:
- New `image-store.js` wrapping one IndexedDB database (shared by the service
  worker and the extension pages, same origin) with an `images` store of
  `{ key, blob, width, height }`.
- Frames go to IndexedDB as Blobs the moment they arrive; the loop keeps only
  their keys. The viewer's fallback stitching path reads them back from there,
  so it still works when the worker's stitcher fails.
- Output is stored straight from `convertToBlob`; `canvasDataUrl` and
  `bytesToBase64` go away.
- History entries in `chrome.storage.local` keep only metadata and an
  `imageKey`. A small thumbnail Blob is saved with each capture so the history
  page doesn't decode full-size images.
- The viewer, copy, export and upload read Blobs (`URL.createObjectURL`,
  `ClipboardItem`).
- Migration on `runtime.onInstalled` with `reason: "update"`: move every
  `captureImage:*` key and inline `history[].dataUrl` into IndexedDB, rewrite
  the entries, then delete the old keys. Idempotent, so an interrupted run
  finishes on the next start.
- Success measure: service-worker memory at the end of a 60-frame capture,
  and time to open the editor and the history page.

## 3. Clear errors for pages that can't be captured, plus `file://`

Today `background.js:77` rejects anything that isn't http(s) with one generic
message, and injection failures show Chrome's raw text.

- New pure module `page-access.js` (loaded with `importScripts`, tested in
  node like `capture-geometry.js`):
  - `classifyUrl(url)` returns `{ ok }` or `{ ok: false, reason }` for
    `chrome:`, `chrome-extension:`, `chrome-untrusted:`, `devtools:`,
    `edge:`/`brave:`/`opera:`/`vivaldi:`, `about:`, `view-source:`,
    `data:`/`blob:`/`javascript:`, the Chrome Web Store and Edge Add-ons hosts,
    and Chrome's PDF viewer.
  - `explainError(err)` maps errors to plain text: "cannot be scripted" /
    "gallery", "No tab with id", "Frame with ID ... was removed", "Cannot
    access contents of the page" (the activeTab grant expired: "Click the
    toolbar button again"), quota errors that ran out of retries.
- `file://`: captured when `chrome.extension.isAllowedFileSchemeAccess()` is
  true; otherwise the message explains how to turn on "Allow access to file
  URLs". This is new capability, so the PR isn't `[patch]`.
- The popup shows the reason before any progress UI starts; the badge tooltip
  uses the same text.
- Tests: `test/page-access.test.mjs` with tables of URLs and error strings.

## 4a. Very long pages at full resolution

Today a page past Chrome's canvas limit is shrunk (refused below 20%), and the
run stops at 80 frames or 80,000 px. On a 2x display shrinking starts at about
16,000 CSS px.

Rule: one image whenever the page fits at full resolution. Parts appear only
past the canvas limit.

Capture:
- `capture-geometry.js`: `planParts({ width, height, scale })` returns no
  split when the page fits, otherwise the fewest parts of equal height within
  the canvas side and pixel limits. Pure, unit-tested.
- `IncrementalStitcher` cuts on frame boundaries: when the next draw would
  pass the planned cut, the current canvas is stored as a part and a new one
  starts at that frame. No frame is split across two images, so every seam is
  one that seam repair already checked. Part heights end up close to equal,
  not exact.
- Height grows during a run, so the plan is recomputed as it grows; cuts that
  have already happened stay where they are.
- App shell: header furniture on the first part, footer on the last.
- Budgets when splitting: 400 frames, 400,000 px of content, 10 minutes.
- Setting `settings.longPages`: `"full"` (default, parts when needed) or
  `"shrink"` (today's behaviour).

Storage and history:
- One history entry per capture with `parts: [{ imageKey, width, height }]`.
  The history limit counts captures, not parts.
- `history.js`: a multi-part card shows "6 parts" and the first part's
  thumbnail; deleting it removes every part.

Editor and export:
- Part switcher in the header ("Part 2 of 6", previous/next, `[` and `]`).
- Annotations are turned off for multi-part captures in this PR, with a
  one-line note; 4b adds them.
- Copy and PNG/JPEG export act on the current part.
- "Download as one PNG": a streaming PNG encoder writes the parts out row by
  row, with no canvas, so the file can be taller than any canvas. Rows are read
  in strips with `getImageData`, filtered, compressed with
  `CompressionStream("deflate")` (zlib framing, which PNG needs), split into
  IDAT chunks with CRC32, and collected into a Blob. Some image viewers can't
  open images past 65,535 px, so the button says so. JPEG can't exceed
  65,535 px on a side, so there's no single-file JPEG.
- "Download all (zip)": a small store-only zip writer with no dependency
  (PNGs don't compress further).
- PDF: one part per page, by extending `makePdfBlob` to multiple pages.
- `captureNotice` says "Saved as 6 parts" instead of the downscale message.

Tests:
- Node: `planParts`, cut placement, PNG encoder output (decoded again in the
  test), zip structure, and a replayed walk over a simulated 400,000 px page
  that must produce contiguous parts with no gaps or repeats at the cuts.
- End to end: `test/fixtures/very-tall.html` (indexed rows to about 250,000 px)
  captured with every index exactly once across the parts and in the single
  PNG.

## 4b. Annotations on multi-part captures

- The project stores `operationsByPart`; undo and redo keep one stack per
  part.
- The layout (padding, background, frame) is shared and applies to each part
  on export. The single-PNG export draws annotations into each part's rows
  before encoding.
- History reopen restores every part's annotations.

## 5. "Wait for slow content" mode

The gap: a frame can be shot once the layout has looked still for 80 ms, even
though the data the page is fetching hasn't arrived. Opt-in checkbox under
"Capture full page", remembered as `settings.waitForContent`. Off by default,
so ordinary captures keep their speed.

- Network tracker, injected with
  `chrome.scripting.executeScript({ world: "MAIN" })`: wraps `fetch` and
  `XMLHttpRequest.prototype.send` and publishes the in-flight count on
  `document.documentElement` as `data-fps-net`. Requests older than 20 s stop
  counting. Restore puts the original functions back (the reference never
  does).
- Known blind spots, written into the setting's help text and the README:
  requests already in flight when the capture starts, WebSockets,
  EventSource, plain image loads (those are covered by the image checks), and
  pages that cache their own reference to `fetch`.
- Calibration before the first frame: if the count doesn't reach 0 within
  1.2 s, the page has permanent connections and the network signal is ignored
  for this run (recorded in diagnostics).
- `fpsScrollAndSettle` takes a `patient` profile in this mode: it also waits
  while `data-fps-net > 0`, tracks lazy images just below the viewport with an
  IntersectionObserver, stalls after 8 s without progress and stops at 25 s
  per frame.
- At the bottom: wait up to 15 s for growth while the network is busy,
  instead of only when the page grew during the run.
- `BUDGET.maxDurationMs` goes to 5 minutes in this mode.
- The popup says "Waiting for content to load" while it waits.
- Ship only if the benchmark shows fewer frames shot with images still loading
  on the slow sites, with no new gaps elsewhere.
- Fixture: `test/fixtures/slow-network.html`, rows rendered from delayed
  `fetch` responses.

## 6. Keyboard shortcuts

- `manifest.json` `commands` for full page, visible area and selected area.
  Chrome allows at most four suggested keys and needs Ctrl or Alt in each.
- Alt+Shift switches input language on Windows, so Alt+Shift+letter can
  misfire there. Choose keys after checking Chrome's built-ins and both
  Windows and macOS. If in doubt, suggest a key only for full page and leave
  the others for users to set at `chrome://extensions/shortcuts`.
- `chrome.commands.onCommand` calls the same `capturePage` path. Commands
  grant `activeTab`, so no new permission is needed.
- With no popup open, progress shows on the badge as it does today; errors
  from step 3 go to the badge tooltip.
- The popup shows each button's shortcut.

## 7. Editor: browser frame, saved defaults, date/URL stamp

- Browser frame in the layout panel: none / macOS / Windows, light or dark,
  optional address bar showing the page URL. Drawn in `renderFinalCanvas`
  around the screenshot, inside the existing padding and shadow. Stored in
  `project.layout.frame`, so history reopen keeps it.
- Saved defaults: export format, JPEG quality (fixed at 0.92 today,
  `viewer.js:1801`), colour, stroke width, text size, layout preset and
  history limit, in `settings`. The current hard-coded values become the
  fallbacks.
- Stamp: none / date / date and time / ISO, plus optional URL, in a chosen
  corner. Part of the layout, so it can be changed or removed later.

## 8. Translations

Store listing first, since it drives search reach and is cheap:
- Localised name, short description and screenshots captions in
  `store-assets/` (not shipped).

Interface second:
- Move every UI string (popup, editor, history, worker messages, step 3's
  errors) into `_locales/en/messages.json`. Manifest name and description
  become `__MSG_appName__` / `__MSG_appDesc__` with `default_locale: "en"`.
- Small `i18n.js`: `t(key, substitutions)` for script text and a `data-i18n`
  attribute pass for HTML.
- Right-to-left: set `dir` from `chrome.i18n.getMessage("@@bidi_dir")` and
  switch layout CSS to logical properties (`margin-inline-start` and so on) in
  the popup, editor and history page.
- Start with fewer languages and get each one reviewed by a speaker. Machine
  translation that nobody has read can cost ratings.
- `test/i18n.test.mjs` fails if any locale is missing a key or a
  substitution placeholder.
- `scripts/package.sh` already ships every tracked file, so `_locales/` needs
  no packaging change.

## 9. Rating prompt and uninstall survey

- After the 5th successful capture, the editor shows one dismissible line:
  "Enjoying it? Rate it on the Chrome Web Store". Yes opens the store review
  page; No or close never asks again (`settings.reviewPrompt`).
- `chrome.runtime.setUninstallURL` points at a short survey with only the
  version in the URL. Optional.
- Needs the Web Store listing URL and, for the survey, a form URL.

---

## Experiment, not scheduled

Holding the page's own JavaScript animation still. Wrapping
`requestAnimationFrame` only during each shot (as the reference does) doesn't
stop animation between frames, so overlaps still differ. Holding it for the
whole run would block lazy loaders and virtualised lists that run on it, and
libraries such as GSAP and Lottie keep their own reference to the function, so
wrapping it later doesn't reach them. First measure how many seam re-takes on
the benchmark come from animated content. Only if that share is meaningful,
prototype a whole-run hold and check it against lazy-loading and virtualised
fixtures.

## Dropped

- Scrolling to the bottom and back before the first frame. It can mark mail or
  chat as read, load another batch of an infinite feed and start bottom-of-page
  downloads while the first frames are taken. The only gain is a better early
  progress estimate, and the loop already re-measures every frame.
- Object eraser: selecting an annotation and deleting it already does this.
- Pixel eraser for pen strokes, editor theme setting, per-capture notes: no
  evidence users want them.
- From the reference: `<all_urls>` and `tabs` permissions, site-specific fixes
  keyed to LinkedIn, Reddit, Squarespace or Notion class names, turning sticky
  elements into ordinary ones (it moved ChatGPT's thread out from under the
  capture; see `docs/full-page-capture-plan.md`), and seeking off-screen
  videos to their last frame.

## Validation for every PR

- `node --test "test/*.test.mjs"` and the end-to-end suite pass.
- Capture changes (2, 4a, 5): benchmark before and after, same day, with the
  numbers in the PR description.
- Re-check the signed-in ChatGPT thread for 2, 4a and 5.
- Regression: visible and area capture, copy, PNG/JPEG/PDF export, Uguu
  upload, history reopen with annotations, migrated history from the previous
  version.

## Open questions

1. Long pages: is "full resolution, parts only when needed" the right default,
   with "shrink" as the setting?
2. Should "Download as one PNG" be the main download button for multi-part
   captures, or should the zip be?
3. Shortcut keys: one suggested key for full page, or all three?
4. Store listing URL and survey form URL for step 9, or skip it.
5. Which languages first, and who can review them?
6. Is a test-only manifest with `<all_urls>` acceptable for the end-to-end
   suite?
