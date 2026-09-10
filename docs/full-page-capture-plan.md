# General full-page capture plan

Status: implemented on this branch. Steps 1-6 below are in place; the
"delivery order" items that need a signed-in browser (the private page and a
live ChatGPT conversation) are still unverified.
Branch: `plan/global-full-page-capture`, based on the existing workspace HEAD
(`b9009ca`) to retain its capture/editor improvements.

## What shipped

| Plan item | Where |
| --- | --- |
| Fixtures | `test/fixtures/*.html` (document, fixed shell, nested scrollers, two panes, sticky/fixed chrome, lazy growth, virtualized) |
| Shared session state, serialization, cancellation | `background.js` - `beginSession`/`cancelSession`, tab `onRemoved`/`onUpdated`/`onActivated` listeners |
| Generic target discovery and verification | `capture-page.js` - `fpsRankScrollTargets`, `fpsVerifyScrolls`, `fpsPrepareTarget` |
| Click-to-select override | `capture-page.js` - `fpsPickScrollTarget`; automatic when scores are within 12%, forced with Alt-click in the popup |
| Adaptive readiness and dynamic height | `capture-page.js` - `fpsScrollAndSettle`; the loop re-measures content height every frame |
| Occlusion handling and restore | `capture-page.js` - `fpsMeasureFrame` (hide fixed, trim around sticky), `fpsRestore` (idempotent, runs in `finally`) |
| Explicit stitching geometry | `capture-geometry.js` - `CaptureWalk`, `resolveFrameLayout`, `checkOutputBudget`, `checkScaleConsistency`; consumed by `viewer.js` |
| Bounded failures reported to the user | `BUDGET` in `background.js`, `captureNotice` in `viewer.js` |

The ChatGPT-specific expansion, metrics, scrolling and chrome-hiding code was
removed: an inner scroller inside a one-viewport-tall document is exactly the
case the shared engine now handles, and the site-specific layout rewriting was
the riskiest part of the old path.

Automated coverage: `node --test "test/*.test.mjs"` - 12 tests over the geometry
plus replays of the capture walk against simulated pages.

### Verified in Chrome (page-side engine, via `test/fixtures/_harness.js`)

The real `capture-page.js` + `capture-geometry.js` were driven against every
fixture in a live Chrome. Every run: zero gaps, `coverage 1.0`, zero leftover
markers or inline styles, original scroll position restored.

| Fixture | Target | Frames | Result |
| --- | --- | --- | --- |
| `document-scroll` | document | 10 | 7245px covered; start scroll 1500 restored |
| `fixed-shell` | element (inner scroller) | 13 | 8400px covered; sidebar + composer hidden; element scrollTop 900 restored |
| `sticky-and-fixed` | document | 11 | 3 fixed overlays hidden, 45px sticky trimmed from frame 1 on |
| `nested-scrollers` | element (dominant outer) | 7 | 5205px covered; off-screen inner scroller correctly not a candidate |
| `two-panes` | element | 8 | identical scores -> `ambiguous: true`; hand-picked pane captured alone (733px wide) |
| `lazy-growth` | document | 15 | page grew 3645 -> 10845px mid-run and was followed to the new bottom |
| `virtualized` | element | 33 | 24000px covered with only ~18 rows in the DOM at a time |
| `heavy-dom` | document | 18 | 20416 elements: ranking 19ms, per-frame measure 8ms |

Also verified live: the picker outlines the hovered pane, click selects it and
Esc cancels with no UI left behind; restore is exact and idempotent - a
pre-existing `visibility: visible !important` came back with its priority, an
unrelated inline `outline` survived, and an element with no `style` attribute
did not gain an empty one.

### Verified in Chrome against a real signed-in ChatGPT thread

A 29,600px conversation, driven the same way. Findings and what changed:

| What went wrong | Fix |
| --- | --- |
| The composer, its fade and the scroll-to-bottom button were baked into the first frame | The first-frame exemption is now only for *top*-pinned bars; bottom-pinned ones are excluded from every frame |
| The scroll-to-bottom button paints ~27px above its sticky parent's box, so it escaped the parent's trim | `fpsPinnedBox` unions a pinned element with the children it paints just outside its own box |
| ChatGPT's fixed right-edge rail sits *inside* the scroll container in the DOM, so the `insideTarget` guard spared it and it printed on every frame | `position: fixed` is always chrome and always hidden; only the target and its ancestors are exempt |
| A sidebar poking 18px into the band counted as a mid-band occluder | An occluder must overlap the band by at least 24px horizontally |
| Reaching the top loaded older messages, growing the thread 2,364 -> 29,600px after the offsets were measured | `settleTop` sits at the top until the content stops growing, before the first frame |
| Hiding the sticky composer made the thread auto-scroll to the bottom, wrecking the run (gaps, 11 frames) | Sticky elements are trimmed around, never hidden; only fixed ones are hidden |

Final result on that thread: 50 frames, **zero gaps**, 99.6% coverage, nothing
left modified. The missing 0.4% is the strip behind the composer at maximum
scroll - the bar's own footprint - which `CaptureWalk.isComplete` now discounts
so the capture is not reported as partial.

Re-verified after those changes: `sticky-and-fixed` (coverage 1.0, 3 fixed
overlays hidden, 45px sticky trimmed), `fixed-shell` (coverage 1.0, 12 frames -
one fewer than before, since the composer is now hidden rather than trimmed),
`heavy-dom` (coverage 1.0; ~44ms per frame to scan 20k elements, against a
550ms screenshot interval).

Not verified: the Chrome plumbing that needs the unpacked extension loaded -
`captureVisibleTab` timing, the badge/progress overlay, and the viewer canvas.
Loading an unpacked extension needs the `chrome://extensions` file picker, which
cannot be driven from here. The private page is still unverified.

## Findings

- `background.js:945` captures ordinary sites by scrolling the window only.
- `background.js:1058` enables inner-container handling only for ChatGPT hosts,
  and only when the document is approximately one viewport tall.
- The ChatGPT path first changes ancestor layout extensively. Generalizing those
  style overrides could break other apps, especially virtualized layouts.
- Capture positions and height are calculated before scrolling, so later growth
  is missed. Fixed waits do not establish that newly visible content has rendered.
- Blanket hiding of fixed/sticky elements can hide substantive content or its
  ancestor. Restoration removes inline visibility rather than preserving it.
- Ordinary capture failures lose the original scroll coordinates during cleanup.
- `viewer.js:210` supports document and container stitching, but uses a single
  crop rectangle for all container frames and paints overlaps without validation.

The private page has not been inspected. An inner scroller is a plausible cause,
not a confirmed diagnosis. Capture should operate in the user's existing signed-in
tab; no separate login or page fetch is needed for the proposed design.

## Recommended approach

Build one layout-aware scroll-and-stitch engine with document and element target
adapters. Keep the existing screenshot mechanism. Target selection, readiness,
geometry, cleanup, and stitching should be shared across sites.

1. **Establish reproducible failures and diagnostics.** Create local pages covering
   document scrolling, fixed app shells, nested scrollers, two competing panes,
   sticky headers/footers, lazy images, and virtualized lists. Add opt-in local
   diagnostics recording target dimensions, offsets, timing, and failure reasons;
   omit page text, credentials, and image contents. Use these on the private page
   during validation in the user's signed-in browser.

2. **Discover and verify the scroll target.** Inspect `document.scrollingElement`
   and visible overflow containers, including accessible open shadow roots. Rank
   by visible area, usable scroll range, central/main-content placement, clipping,
   and occlusion; avoid relying on class names or domain names. Verify movement
   with a small reversible scroll. Inspect candidates even if the document itself
   scrolls. When multiple panes are equally plausible, offer an on-page highlight
   and click-to-select override. Retain the selected element for the session;
   fail clearly if navigation or rendering replaces it.

3. **Define output explicitly.** Document capture produces the full document
   width currently supported. Element capture produces the selected pane's full
   vertical content, cropped to its visible horizontal bounds. Preview/highlight
   this scope before capturing a pane. Combining independently scrolling panes
   into one synthetic full-app image and horizontal tiling are later work.

4. **Capture adaptively.** Scroll the real target with overlapping steps. After
   each step, wait for bounded geometry stability and visible image readiness,
   then measure actual offsets and crop bounds immediately around capture.
   Re-measure extent after each frame. Stop at a stable bottom; enforce time,
   frame, pixel, and memory budgets for growing/infinite pages. Distinguish a
   budget-limited partial capture from success. For virtualized lists, capture
   each rendered viewport before advancing; detect unstable offsets or recycled
   content that prevents reliable stitching and report incomplete coverage.

5. **Handle overlays and restore state reliably.** Determine which fixed/sticky
   elements actually occlude the capture region. Use safe crop bands/overlap or
   narrowly scoped temporary changes; never hide the target or its ancestors.
   Preserve relevant headers once without covering content beneath them. Record
   exact values and priorities for every changed style plus original scroll
   positions. Use an idempotent cleanup routine in `finally` for success, error,
   and cancellation. Add one active session per tab and serialize screenshot
   calls; cancel on tab switches/navigation so another tab is not stitched in.

6. **Make stitching geometry explicit.** Store a per-frame source rectangle,
   destination offset, and measured pixel scale. Trim overlap deterministically,
   including a clamped final scroll; detect gaps and inconsistent viewport/zoom
   changes. Check output dimensions and allocation budgets before creating the
   editor canvas. Keep older saved captures readable. Initially stop oversized
   captures with a useful explanation; segmented export is a separate extension.

## Delivery order and validation

1. Fixtures and diagnostics, then shared capture-session state and cleanup.
2. Generic target selection and element scrolling with per-frame geometry.
3. Adaptive readiness, dynamic height, occlusion handling, and bounded failures.
4. Verify the private page and existing ChatGPT behavior, then retire the
   site-specific expansion path once the shared engine passes those cases.
5. Update README limitations to match demonstrated support.

Validate the actual extension in Chrome, not just mocked screenshot calls. Use
numbered rows and colored seam markers to check that top/bottom and every row
appear exactly once. Cover partial final frames, zoom/Retina, nonzero starting
scroll, slow loading, sticky ancestors, virtualized lists, cancellation, capture
errors, tab changes, and simultaneous starts. Assert restoration after success
and failure. Regression-check visible/selected capture, editor exports, and saved
history. No tests were run for this planning-only change.

## Alternative considered and boundaries

Chrome's [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
captures the active tab's visible area and limits screenshot calls to two per
second. Keep a shared rate limiter and the existing `activeTab` permission model.

DevTools [Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
offers `captureBeyondViewport`; an extension can access CDP through
[`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger),
which requires the debugger permission. Evaluate this only as a later optional
backend. The API does not promise to expand nested overflow containers or render
all virtualized rows, so it should not be assumed to solve the current gap.

Cross-origin iframe internals, closed shadow roots, endless feeds, and unstable
virtualized coordinate systems need explicit unsupported/partial outcomes when
the engine cannot establish complete coverage. First release support is finite
documents and accessible dominant vertical scroll panes; “global” means a shared
strategy across domains, not a guarantee for every possible app layout.
