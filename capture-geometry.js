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
  function resolveFrameLayout(frames, options = {}) {
    const scale = options.scale || 1;
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

      draws.push({
        index,
        sx: Math.round(source.left * scale),
        sy: Math.round(sourceTop * scale),
        sw: Math.round(source.width * scale),
        sh: Math.round(height * scale),
        dx: 0,
        dy: Math.round((top - ordered[0].frame.dest.top) * scale),
      });
      width = Math.max(width, Math.round(source.width * scale));
      covered = top + height;
    }

    const first = ordered.length ? ordered[0].frame.dest.top : 0;
    const height = draws.length
      ? Math.max(...draws.map((d) => d.dy + d.sh))
      : 0;

    return {
      draws,
      gaps,
      width,
      height,
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
    clamp,
    planScrollPositions,
    CaptureWalk,
    resolveFrameLayout,
    checkOutputBudget,
    checkScaleConsistency,
  };
});
