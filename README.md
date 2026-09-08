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

## Releasing

Packaging is automated. Merging to `main` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Compares the merge against the last `v*` tag to see whether any **shipped
   extension file** changed. Docs, `store-assets/`, `.github/` and `scripts/`
   don't count — a README-only merge produces no version bump and no release.
2. Bumps `manifest.json`: **minor** by default. Put `[patch]` or `[major]`
   anywhere in the PR title or a commit message to override.
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
