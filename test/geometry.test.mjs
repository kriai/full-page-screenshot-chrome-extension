// Unit tests for the shared capture geometry, plus end-to-end runs of the
// capture walk against simulated pages (sticky headers, lazy growth,
// unhideable bottom bars). Run with: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../capture-geometry.js");

/* ------------------------------ unit tests ------------------------------ */

test("planScrollPositions always ends at the bottom", () => {
  assert.deepEqual(G.planScrollPositions({ scrollRange: 2000, band: 800, overlap: 0 }), [
    0, 800, 1600, 2000,
  ]);
  assert.deepEqual(G.planScrollPositions({ scrollRange: 0, band: 800 }), [0]);
  assert.deepEqual(G.planScrollPositions({ scrollRange: 100, band: 800, overlap: 50 }), [0, 100]);
});

test("resolveFrameLayout trims overlap so every row is painted once", () => {
  const frame = (destTop, height) => ({
    dest: { top: destTop },
    source: { left: 0, top: 0, width: 400, height },
  });
  const layout = G.resolveFrameLayout([frame(0, 500), frame(450, 500), frame(900, 200)], {
    scale: 1,
  });

  assert.equal(layout.gaps.length, 0);
  assert.equal(layout.height, 1100);
  assert.deepEqual(
    layout.draws.map((d) => [d.dy, d.sh]),
    [
      [0, 500],
      [500, 450],
      [950, 150],
    ]
  );
  // The trimmed frames read from further down their own screenshot.
  assert.equal(layout.draws[1].sy, 50);
  assert.equal(layout.draws[2].sy, 50);
});

test("resolveFrameLayout reports gaps and drops redundant frames", () => {
  const frames = [
    { dest: { top: 0 }, source: { left: 0, top: 0, width: 400, height: 300 } },
    { dest: { top: 100 }, source: { left: 0, top: 0, width: 400, height: 100 } },
    { dest: { top: 500 }, source: { left: 0, top: 0, width: 400, height: 300 } },
  ];
  const layout = G.resolveFrameLayout(frames, { scale: 1 });
  assert.deepEqual(layout.gaps, [{ from: 300, to: 500 }]);
  assert.deepEqual(
    layout.draws.map((d) => d.index),
    [0, 2]
  );
});

test("resolveFrameLayout scales to device pixels", () => {
  const layout = G.resolveFrameLayout(
    [{ dest: { top: 0 }, source: { left: 10, top: 5, width: 400, height: 300 } }],
    { scale: 2 }
  );
  assert.deepEqual(layout.draws[0], { index: 0, sx: 20, sy: 10, sw: 800, sh: 600, dx: 0, dy: 0 });
  assert.equal(layout.width, 800);
});

test("checkOutputBudget rejects canvases Chrome cannot allocate", () => {
  assert.equal(G.checkOutputBudget(1200, 8000).ok, true);
  assert.equal(G.checkOutputBudget(1200, 40000).ok, false);
  assert.equal(G.checkOutputBudget(20000, 20000).reason, "pixels");
  assert.equal(G.checkOutputBudget(0, 100).reason, "empty");
});

test("checkScaleConsistency flags a zoom change mid-capture", () => {
  assert.equal(G.checkScaleConsistency([2, 2, 2]).ok, true);
  assert.equal(G.checkScaleConsistency([2, 2, 1.5]).ok, false);
});

/* --------------------- simulated end-to-end capture --------------------- */

// A stand-in for a scrollable target: `pinnedTop`/`pinnedBottom` are pixels
// eaten by elements that cannot be hidden, `growAt` models lazy loading.
class FakeTarget {
  constructor(options) {
    this.contentHeight = options.contentHeight;
    this.viewportHeight = options.viewportHeight;
    this.viewportWidth = options.viewportWidth || 1000;
    this.pinnedTop = options.pinnedTop || 0;
    this.pinnedTopAfterFrame = options.pinnedTopAfterFrame ?? 0;
    this.pinnedBottom = options.pinnedBottom || 0;
    this.growAt = options.growAt || null;
    this.grownHeight = options.grownHeight || options.contentHeight;
    this.scrollTop = 0;
    this.frameIndex = 0;
  }

  scrollRange() {
    return Math.max(0, this.contentHeight - this.viewportHeight);
  }

  scrollTo(top) {
    this.scrollTop = Math.min(this.scrollRange(), Math.max(0, top));
    if (this.growAt !== null && this.scrollTop >= this.growAt) {
      this.contentHeight = Math.max(this.contentHeight, this.grownHeight);
    }
  }

  measure(isFirst) {
    const trimTop = isFirst || this.frameIndex < this.pinnedTopAfterFrame ? 0 : this.pinnedTop;
    const trimBottom = isFirst ? 0 : this.pinnedBottom;
    this.frameIndex++;
    return {
      scrollTop: this.scrollTop,
      contentHeight: this.contentHeight,
      scrollRange: this.scrollRange(),
      trimTop,
      trimBottom,
      viewportWidth: this.viewportWidth,
      dpr: 1,
      source: {
        left: 0,
        top: trimTop,
        width: this.viewportWidth,
        height: this.viewportHeight - trimTop - trimBottom,
      },
      dest: { top: this.scrollTop + trimTop },
    };
  }
}

// Mirrors runCaptureLoop in background.js, minus the browser side effects.
function runWalk(target, { overlap = 32, maxFrames = 200 } = {}) {
  const walk = new G.CaptureWalk({ overlap });
  const frames = [];
  let previousScrollTop = -1;
  let stopped = "complete";

  for (let index = 0; index < maxFrames; index++) {
    target.scrollTo(walk.nextTop(target.scrollRange()));
    let measured = target.measure(index === 0);

    const shortfall = walk.repairShortfall(measured);
    if (shortfall) {
      target.scrollTo(Math.max(0, measured.scrollTop - shortfall));
      measured = target.measure(false);
    }

    frames.push({ ...measured, viewportWidth: target.viewportWidth });
    walk.accept(measured);

    if (walk.isComplete(measured, target.contentHeight)) break;
    if (measured.scrollTop >= target.scrollRange() - 1 && measured.scrollTop === previousScrollTop) {
      stopped = "stuck";
      break;
    }
    previousScrollTop = measured.scrollTop;
    if (index === maxFrames - 1) stopped = "frames";
  }

  return { walk, frames, stopped, layout: G.resolveFrameLayout(frames, { scale: 1 }) };
}

function assertContiguous(layout) {
  assert.deepEqual(layout.gaps, [], "no gaps");
  for (let i = 1; i < layout.draws.length; i++) {
    const previous = layout.draws[i - 1];
    assert.equal(
      previous.dy + previous.sh,
      layout.draws[i].dy,
      `frame ${i} continues exactly where frame ${i - 1} ended`
    );
  }
}

test("plain document scroll covers the page exactly once", () => {
  const target = new FakeTarget({ contentHeight: 5000, viewportHeight: 900 });
  const run = runWalk(target);
  assertContiguous(run.layout);
  assert.equal(run.layout.height, 5000);
  assert.equal(run.stopped, "complete");
});

test("a sticky header is captured once and never re-photographed", () => {
  const target = new FakeTarget({ contentHeight: 4200, viewportHeight: 800, pinnedTop: 120 });
  const run = runWalk(target);
  assertContiguous(run.layout);
  assert.equal(run.layout.height, 4200);
  // Only the first frame keeps the full band; the rest start below the header.
  assert.equal(run.frames[0].source.top, 0);
  assert.ok(run.frames.slice(1).every((f) => f.source.top === 120));
});

test("a pinned element that appears mid-capture does not open a gap", () => {
  const target = new FakeTarget({
    contentHeight: 4000,
    viewportHeight: 800,
    pinnedTop: 220,
    pinnedTopAfterFrame: 3, // no trim until the fourth frame
  });
  const run = runWalk(target, { overlap: 24 });
  assertContiguous(run.layout);
  assert.equal(run.layout.height, 4000);
});

test("content that grows while scrolling is followed to the new bottom", () => {
  const target = new FakeTarget({
    contentHeight: 3000,
    viewportHeight: 800,
    growAt: 1500,
    grownHeight: 6400,
  });
  const run = runWalk(target);
  assertContiguous(run.layout);
  assert.equal(target.contentHeight, 6400);
  assert.equal(run.layout.height, 6400);
});

test("an unhideable bottom bar still reaches the end of the content", () => {
  const target = new FakeTarget({
    contentHeight: 3600,
    viewportHeight: 800,
    pinnedBottom: 180,
  });
  const run = runWalk(target);
  assertContiguous(run.layout);
  // Everything except the strip behind the bar is captured, and that strip is
  // the bar's own footprint - the run counts as complete, not partial.
  assert.equal(run.layout.height, target.contentHeight - 180);
  assert.equal(run.stopped, "complete");
});

test("a bottom bar that flickers away on the last frame still completes", () => {
  // The bar is measured on every frame but happens to be gone from the final
  // one; the run must not be reported as having stopped short.
  const target = new FakeTarget({ contentHeight: 3600, viewportHeight: 800, pinnedBottom: 180 });
  const originalMeasure = target.measure.bind(target);
  target.measure = (isFirst) => {
    const measured = originalMeasure(isFirst);
    if (measured.scrollTop >= target.scrollRange() - 1) measured.trimBottom = 0;
    return measured;
  };
  const run = runWalk(target);
  assertContiguous(run.layout);
  assert.equal(run.stopped, "complete");
});

test("a page shorter than the viewport produces a single frame", () => {
  const target = new FakeTarget({ contentHeight: 600, viewportHeight: 900 });
  const run = runWalk(target);
  assert.equal(run.frames.length, 1);
  assert.equal(run.layout.height, 900);
});
