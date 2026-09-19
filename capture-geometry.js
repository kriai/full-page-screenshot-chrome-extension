// Pure geometry helpers shared by the capture engine (background service
// worker), the stitcher (viewer) and the node tests. No DOM, no chrome APIs.
//
// Coordinate systems:
//   * "content" px  - CSS pixels along the scroll target's full content.
//   * "viewport" px - CSS pixels inside the captured screenshot's viewport.
//   * "device" px   - pixels in the PNG returned by captureVisibleTab
//                     (viewport px multiplied by the measured scale).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FpsGeometry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Chrome refuses canvases beyond these limits, and allocating close to them
  // tends to fail on lower-memory machines.
  const MAX_CANVAS_SIDE = 32767;
  const MAX_CANVAS_PIXELS = 200e6;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /* --------------------------- seam alignment ---------------------------- *
   * The scroll loop assumes the page moved by exactly the amount we asked
   * for, and derives every frame's content offset from scrollTop. Sub-pixel
   * rounding, scroll anchoring and content that reflows mid-capture all break
   * that assumption, and the result is a visible tear where two frames meet.
   *
   * These helpers work on two overlapping bands - the bottom of the frame we
   * already have, and the region of the new frame that should hold the same
   * rows - and answer "how far off is it?". Deciding the shift is worth
   * believing is part of the job: a page whose overlap genuinely differs (an
   * animation, a carousel) must not be dragged out of alignment by a match
   * that is merely the least bad.
   * ---------------------------------------------------------------------- */

  const SEAM = {
    // Bands are squashed to this width before comparing. Seams are horizontal,
    // so horizontal detail is noise; 96 columns is enough to tell rows apart
    // and keeps each probe well under a millisecond.
    sampleWidth: 96,
    // Device px of overlap actually compared, and how far either side of the
    // nominal position we look for a better match. The range only has to cover
    // rounding and a late-settling row or two - anything larger is a reflow,
    // which the page-side anchor reports directly.
    maxBand: 48,
    maxSearch: 48,
    // The thresholds below are a mean absolute channel difference, 0-255.
    // They are measured rather than chosen, because the numbers depend
    // enormously on what is on the page. Two reference bands - a paragraph of
    // 16px prose, and a photo-like run of gradients and blobs:
    //
    //                         prose   photo
    //   perfectly aligned       0.0     0.0
    //   aligned, sub-pixel      0.0     1.5
    //   out by 1px              6.2     3.7
    //   out by 2px             12.3     7.3
    //   out by 3px             16.9    10.8
    //   out by 12px            30.0    39.9
    //   unrelated content       6.3    90.3
    //
    // Two things in that table drive everything below. Chrome snaps glyph
    // rasterisation to whole device pixels, so text has no sub-pixel noise
    // floor at all: a prose band either matches exactly or is out by a whole
    // pixel. And prose is sparse dark-on-white, so two unrelated paragraphs
    // sit on top of each other in mostly-white pixels and differ *less* than
    // the same paragraph shifted two - which is why the absolute thresholds
    // here are small, and why one of them cannot do its whole job.

    // Below this the bands already agree and searching would only chase
    // rasterisation noise. Held under the photo column's 1px case so that even
    // a small slip on dense content is still reachable.
    skipDiff: 3,
    // A shift has to at least halve the difference and land genuinely low
    // before a frame is moved on its evidence. The absolute gate does most of
    // the work: a correct match lands on the "aligned" row - 0 for prose, 1.5
    // for a photo - so 10 clears every real correction with room to spare
    // while still rejecting a search that merely found the least bad offset.
    acceptRatio: 0.5,
    acceptDiff: 10,
    // Past this, a seam the search could not fix is treated as a bad frame
    // rather than a misplaced one, and the frame is re-taken.
    //
    // The threshold tracks how visible an error is rather than how many
    // pixels it is, which is the useful behaviour: 2px crosses it in prose,
    // where a jogged line of text is obvious, but not in a smooth gradient,
    // where the same 2px cannot be seen.
    //
    // On dense content it also catches a frame caught mid-paint, which scores
    // 90.3. On prose it cannot: unrelated text scores 6.3, about what a
    // one-pixel slip scores, so no threshold separates them without firing on
    // every frame. What it does catch on prose is a visible slip the search
    // could not explain, which is the more common failure anyway.
    retryDiff: 12,
  };

  // Mean absolute RGB difference between `rows` scanlines of two RGBA buffers,
  // starting at scanline `rowA` / `rowB`. Alpha is ignored: screenshots are
  // opaque, so it carries no signal.
  function meanChannelDiff(a, b, rowA, rowB, width, rows) {
    const stride = width * 4;
    let total = 0;
    for (let y = 0; y < rows; y++) {
      let ia = (rowA + y) * stride;
      let ib = (rowB + y) * stride;
      for (let x = 0; x < width; x++, ia += 4, ib += 4) {
        total +=
          Math.abs(a[ia] - b[ib]) +
          Math.abs(a[ia + 1] - b[ib + 1]) +
          Math.abs(a[ia + 2] - b[ib + 2]);
      }
    }
    return total / (width * rows * 3);
  }

  // Search for the vertical offset that best lines the two bands up. `score`
  // takes a candidate shift in device px and returns its difference.
  //
  // Every offset in range is tried. A coarse sweep refined around its winner
  // would be cheaper, but it only lands on the right answer when the
  // difference curve slopes towards it - and that assumes content with
  // vertical extent. Dense small text, hairline rules and tight table borders
  // all produce a curve that is flat everywhere except at the true offset,
  // where a coarse sweep steps straight over it. At this range an exhaustive
  // sweep is a few hundred thousand byte comparisons per seam, which is
  // nothing beside the screenshot that produced the band.
  //
  // Returns the nominal difference as `base` either way, so a caller can tell
  // "already aligned" (low base) from "no shift was believable" (high base).
  function findSeamShift(score, search, options = {}) {
    const skipDiff = options.skipDiff ?? SEAM.skipDiff;
    const acceptRatio = options.acceptRatio ?? SEAM.acceptRatio;
    const acceptDiff = options.acceptDiff ?? SEAM.acceptDiff;

    const base = score(0);
    const reach = Math.floor(Math.max(0, search));
    if (reach < 1 || base <= skipDiff) return { shift: 0, diff: base, base };

    let bestShift = 0;
    let bestDiff = base;
    for (let s = -reach; s <= reach; s++) {
      if (s === 0) continue;
      const diff = score(s);
      // Ties go to the smaller move: if two offsets fit equally well the page
      // most likely did not travel as far as the larger one claims.
      if (diff < bestDiff || (diff === bestDiff && Math.abs(s) < Math.abs(bestShift))) {
        bestDiff = diff;
        bestShift = s;
      }
    }

    const believable =
      bestShift !== 0 && bestDiff <= base * acceptRatio && bestDiff <= acceptDiff;
    return believable
      ? { shift: bestShift, diff: bestDiff, base }
      : { shift: 0, diff: base, base };
  }

  // Where to read the two bands from, given the geometry of the frame we have
  // and the frame we just took. All inputs and outputs are device pixels in
  // their own frame's screenshot. Returns null when the frames do not overlap
  // enough for a comparison to mean anything.
  //
  // `prevRow` / `nextRow` are the top scanline of the band in each frame; a
  // candidate shift moves `nextRow` only.
  function planSeamProbe(prev, next, options = {}) {
    const maxBand = options.maxBand ?? SEAM.maxBand;
    const maxSearch = options.maxSearch ?? SEAM.maxSearch;

    // Content rows the two frames have in common, in the coordinate space the
    // page reported. The band is taken from the bottom of that run: it is the
    // part closest to the seam, and the part most likely to still be on screen
    // in the new frame.
    const prevEnd = prev.destTop + prev.height;
    const overlap = Math.floor(Math.min(prevEnd - next.destTop, prev.height, next.height));
    if (overlap < 8) return null;

    // The overlap has to pay for two things: rows to compare, and room to
    // slide them past each other. Spending all of it on the band would leave a
    // probe that can only ever confirm the offset it was handed, so cap the
    // band at half and let the search have the rest.
    const band = Math.min(maxBand, Math.floor(overlap / 2));
    if (band < 4) return null;

    const prevRow = prev.top + prev.height - band;
    const nextRow = next.top + (prevEnd - band - next.destTop);
    if (prevRow < prev.top || nextRow < next.top) return null;

    // Never let the probe wander outside the readable band of either frame:
    // beyond it lies a hidden overlay's leftovers, or nothing at all. Below
    // the band the new frame usually has a whole viewport to spare; above it,
    // only what the overlap did not spend.
    const up = nextRow - next.top;
    const down = next.top + next.height - (nextRow + band);
    const search = Math.floor(clamp(Math.min(maxSearch, up, down), 0, maxSearch));

    return { band, prevRow, nextRow, search };
  }

  // Scroll offsets for one pass over `scrollRange`, advancing by the usable
  // band height minus `overlap`. The final position is always the very bottom
  // so a short last frame still reaches the end of the content.
  function planScrollPositions({ scrollRange, band, overlap = 0 }) {
    const maxTop = Math.max(0, Math.floor(scrollRange) || 0);
    const usable = Math.max(1, Math.floor(band) - Math.max(0, Math.floor(overlap)));
    const positions = [];
    for (let top = 0; top < maxTop; top += usable) positions.push(top);
    positions.push(maxTop);
    return positions;
  }

  // Turn recorded frames into explicit draw rectangles. Each frame carries the
  // content offset it starts at (`dest.top`) and the viewport rectangle that
  // was actually readable (`source`). Overlap is trimmed off the *later* frame
  // so every content row is painted exactly once, in capture order.
  // `outputScale` shrinks the stitched image without changing where the pixels
  // are read from. Source rectangles have to stay at the screenshots' own
  // scale - they index into the PNGs - so only the destination moves. This is
  // what lets a page taller than a canvas be delivered whole and slightly
  // reduced, rather than sharp and cut off.
  function resolveFrameLayout(frames, options = {}) {
    const scale = options.scale || 1;
    const outputScale = options.outputScale || 1;
    const ordered = frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame && frame.source && frame.source.height > 0)
      .sort((a, b) => a.frame.dest.top - b.frame.dest.top || a.index - b.index);

    const draws = [];
    const gaps = [];
    let covered = 0;
    let width = 0;

    for (const { frame, index } of ordered) {
      const source = frame.source;
      let top = frame.dest.top;
      let sourceTop = source.top;
      let height = source.height;

      if (top + height <= covered) continue; // fully redundant frame
      if (top < covered) {
        const trim = covered - top;
        top += trim;
        sourceTop += trim;
        height -= trim;
      } else if (top > covered && draws.length) {
        gaps.push({ from: covered, to: top });
      }

      const out = scale * outputScale;
      draws.push({
        index,
        sx: Math.round(source.left * scale),
        sy: Math.round(sourceTop * scale),
        sw: Math.round(source.width * scale),
        sh: Math.round(height * scale),
        dx: 0,
        dy: Math.round((top - ordered[0].frame.dest.top) * out),
        dw: Math.round(source.width * out),
        // Round the bottom edge rather than the height, so consecutive draws
        // share an edge exactly. Rounding each height independently leaves a
        // hairline of background between frames at fractional output scales.
        dh:
          Math.round((top + height - ordered[0].frame.dest.top) * out) -
          Math.round((top - ordered[0].frame.dest.top) * out),
      });
      width = Math.max(width, Math.round(source.width * out));
      covered = top + height;
    }

    const first = ordered.length ? ordered[0].frame.dest.top : 0;
    const height = draws.length ? Math.max(...draws.map((d) => d.dy + d.dh)) : 0;

    return {
      draws,
      gaps,
      width,
      height,
      outputScale,
      contentTop: first,
      contentHeight: covered - first,
    };
  }

  // The scroll-position arithmetic of the capture loop, kept pure so it can be
  // driven by tests against simulated pages. The service worker owns the
  // side effects (scrolling, screenshots); this owns "where next, and are we
  // done yet".
  class CaptureWalk {
    constructor(options = {}) {
      this.overlap = Math.max(0, Math.round(options.overlap || 0));
      this.covered = 0;        // content px already represented by accepted frames
      this.trimEstimate = 0;   // how much the last frame lost to pinned elements
      this.unreachable = 0;    // strip a bottom-pinned bar keeps out of reach
      this.frameCount = 0;
    }

    // Aim so the next frame starts on the last row we already have, minus the
    // overlap, and allow for the band the pinned elements will eat again.
    nextTop(scrollRange) {
      if (this.frameCount === 0) return 0;
      return clamp(this.covered - this.overlap - this.trimEstimate, 0, Math.max(0, scrollRange));
    }

    // A pinned element that grew since the previous frame can push the frame's
    // first content row past what we have; scrolling back by the shortfall
    // closes the gap.
    repairShortfall(measured) {
      if (this.frameCount === 0) return 0;
      const shortfall = measured.dest.top - this.covered;
      return shortfall > 1 && measured.scrollTop > 0 ? shortfall : 0;
    }

    accept(measured) {
      this.frameCount++;
      this.covered = Math.max(this.covered, measured.dest.top + measured.source.height);
      this.trimEstimate = measured.trimTop || 0;
      this.unreachable = Math.max(this.unreachable, measured.trimBottom || 0);
      return this.covered;
    }

    // At the bottom of the scroll range, the strip still hidden behind a
    // pinned bar can never be reached. That is the bar's own footprint, not
    // missing page content, so it does not make the capture partial.
    isComplete(measured, contentHeight) {
      if (measured.scrollTop < measured.scrollRange - 1) return false;
      const unreachable = Math.max(this.unreachable, measured.trimBottom || 0);
      return this.covered >= contentHeight - unreachable - 2;
    }
  }

  function checkOutputBudget(width, height) {
    if (!(width > 0) || !(height > 0)) {
      return { ok: false, reason: "empty", message: "The capture produced no pixels." };
    }
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
      return {
        ok: false,
        reason: "side",
        message: `The stitched image would be ${width} x ${height}px; Chrome cannot create a canvas larger than ${MAX_CANVAS_SIDE}px on a side.`,
      };
    }
    if (width * height > MAX_CANVAS_PIXELS) {
      return {
        ok: false,
        reason: "pixels",
        message: `The stitched image would be ${width} x ${height}px (${Math.round(
          (width * height) / 1e6
        )} megapixels), above the ${Math.round(MAX_CANVAS_PIXELS / 1e6)} megapixel limit this extension can allocate.`,
      };
    }
    return { ok: true };
  }

  // Where the scrolling pane sits inside the finished image, for an app shell.
  //
  // The pane's own stitch is `layout`; everything around it - a sidebar, a
  // header, a composer - is static, so it is painted once instead of repeated
  // down every frame. The pane keeps its place in the window, the furniture
  // above it keeps its height, and whatever sits below the pane is pushed to
  // the foot of the finished image.
  function shellComposite(shell, layout, scale = 1) {
    const out = (layout.outputScale || 1) * scale;
    const px = (v) => Math.round(v * out);
    const paneX = px(shell.pane.left);
    const paneY = px(shell.pane.top);
    const footerHeight = Math.max(
      0,
      px(shell.viewport.height) - px(shell.pane.top + shell.pane.height)
    );
    return {
      paneX,
      paneY,
      footerHeight,
      width: Math.max(px(shell.viewport.width), paneX + layout.width),
      height: paneY + layout.height + footerHeight,
      viewportWidth: px(shell.viewport.width),
      viewportHeight: px(shell.viewport.height),
      // Below this the furniture is no longer on screen in any frame, so the
      // side columns simply stop. Reported so a caller can fill the rest
      // rather than leaving a hard edge.
      furnitureBottom: Math.min(px(shell.viewport.height), paneY + layout.height),
    };
  }

  // The largest factor a stitch of this size can keep and still be allocated.
  // 1 when it already fits. Returns 0 when even a heavy reduction cannot save
  // it, which means the capture is genuinely too big to deliver as one image.
  function fitOutputScale(width, height) {
    if (!(width > 0) || !(height > 0)) return 0;
    const bySide = Math.min(MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
    const byPixels = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    const fit = Math.min(1, bySide, byPixels);
    // Below this the result is too soft to be worth handing over as if it were
    // a screenshot of the page.
    return fit < 0.2 ? 0 : fit;
  }

  // Frames are only stitchable together when they share a pixel scale; a zoom
  // change or a window resize mid-capture invalidates the geometry.
  function checkScaleConsistency(scales, tolerance = 0.01) {
    const valid = scales.filter((s) => Number.isFinite(s) && s > 0);
    if (!valid.length) return { ok: false, scale: 1, spread: 0 };
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    return { ok: max - min <= tolerance * min, scale: valid[0], spread: max - min };
  }

  return {
    MAX_CANVAS_SIDE,
    MAX_CANVAS_PIXELS,
    SEAM,
    clamp,
    planScrollPositions,
    CaptureWalk,
    resolveFrameLayout,
    checkOutputBudget,
    shellComposite,
    fitOutputScale,
    checkScaleConsistency,
    meanChannelDiff,
    findSeamShift,
    planSeamProbe,
  };
});
