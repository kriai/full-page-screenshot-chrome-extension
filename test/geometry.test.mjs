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
  // Without an output scale the destination matches the source exactly.
  assert.deepEqual(layout.draws[0], {
    index: 0,
    sx: 20,
    sy: 10,
    sw: 800,
    sh: 600,
    dx: 0,
    dy: 0,
    dw: 800,
    dh: 600,
  });
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

/* ---------------------------- seam alignment ---------------------------- */

// One band of a screenshot, as RGBA. Each row gets a flat colour keyed off
// `y + offset`, so two bands built with different offsets are the same image
// slid vertically - exactly what a mis-scrolled frame looks like. `tone`
// decides what the rows look like down the band.
function makeBand(width, rows, offset, tone) {
  const data = new Uint8ClampedArray(width * rows * 4);
  for (let y = 0; y < rows; y++) {
    const [r, g, b] = tone(y + offset);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

// Rows that do not resemble each other, the way a paragraph of prose or a
// photograph does not: there is one right answer and the search should find it.
function textured(y) {
  let h = ((y | 0) * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
}

// A strictly periodic band - a table of identical rows, a striped list. Every
// seventh row matches, so several offsets are near-perfect and none is right.
function periodic(y) {
  const v = ((((y | 0) * 37) % 256) + 256) % 256;
  return [v, (v * 2) % 256, (v * 3) % 256];
}

// Recreates what alignSeam does in the service worker: the previous frame's
// band, a taller window from the new frame, and a score at each candidate.
function seamScorer({ width = 96, band = 48, search = 48, truth = 0, tone = textured } = {}) {
  const prev = makeBand(width, band, 0, tone);
  // Offset chosen so the new frame's rows line up with the old ones exactly
  // `truth` pixels away from where the geometry says they should.
  const next = makeBand(width, band + 2 * search, -(search + truth), tone);
  return {
    search,
    score: (shift) => G.meanChannelDiff(prev, next, 0, search + shift, width, band),
  };
}

test("meanChannelDiff is zero for identical bands and rises with difference", () => {
  const a = makeBand(8, 4, 0, textured);
  assert.equal(G.meanChannelDiff(a, a, 0, 0, 8, 4), 0);
  assert.ok(G.meanChannelDiff(a, makeBand(8, 4, 3, textured), 0, 0, 8, 4) > 0);
});

test("findSeamShift recovers the offset a mis-scrolled frame landed at", () => {
  for (const truth of [-48, -24, -17, -5, -1, 3, 11, 24, 48]) {
    const { score, search } = seamScorer({ truth });
    assert.equal(G.findSeamShift(score, search).shift, truth, `shift ${truth}`);
  }
});

test("findSeamShift leaves an already aligned seam alone", () => {
  const { score, search } = seamScorer({ truth: 0 });
  const found = G.findSeamShift(score, search);
  assert.equal(found.shift, 0);
  assert.equal(found.base, 0);
});

test("findSeamShift sweeps past near-misses in repeating content", () => {
  // A uniform table offers several offsets that fit almost as well as the real
  // one. A coarse-then-fine search settles on whichever near-miss it sampled
  // first; sweeping every offset finds the one that actually fits.
  const { score, search } = seamScorer({ truth: -17, tone: periodic });
  assert.equal(G.findSeamShift(score, search).shift, -17);
});

// Mean absolute channel differences measured from rendered bands - a
// paragraph of 16px prose and a photo-like run of gradients. The thresholds in
// SEAM are set against these, so they are pinned here: a change to the
// constants that stops separating a clean seam from a broken one fails loudly
// rather than quietly never firing.
// `subpixel` is a half-device-pixel rasterisation difference. For prose it is
// zero: Chrome snaps glyphs to whole device pixels, so text has no sub-pixel
// noise floor - it either matches or is out by a whole pixel.
const MEASURED = {
  prose: { aligned: 0, subpixel: 0, off1: 6.2, off2: 12.3, off3: 16.9, unrelated: 6.3 },
  photo: { aligned: 0, subpixel: 1.5, off1: 3.7, off2: 7.3, off3: 10.8, unrelated: 90.3 },
};

test("a correctly aligned seam reads as clean on both kinds of content", () => {
  const S = G.SEAM;
  for (const [kind, m] of Object.entries(MEASURED)) {
    assert.ok(m.subpixel < S.retryDiff, `${kind}: an aligned seam must not be re-taken`);
    assert.ok(m.subpixel <= S.acceptDiff, `${kind}: an aligned seam must pass acceptDiff`);
  }
});

test("a 2px slip is searched for and its correction believed", () => {
  const S = G.SEAM;
  for (const [kind, m] of Object.entries(MEASURED)) {
    // It has to get past the "already agree" gate...
    assert.ok(m.off2 > S.skipDiff, `${kind}: a 2px slip must be searched, not skipped`);
    // ...and the correction, which lands on the aligned figure, has to clear
    // both acceptance gates or the frame is left where it was.
    assert.ok(m.subpixel <= m.off2 * S.acceptRatio, `${kind}: improves by a clear margin`);
    assert.ok(m.subpixel <= S.acceptDiff, `${kind}: lands low enough to believe`);
  }
});

test("an unexplained slip is re-taken once it is big enough to see", () => {
  const S = G.SEAM;
  // The threshold tracks visibility rather than pixel count, which is the
  // useful behaviour: the same error matters more on text than on a gradient.
  // In prose, where a two-pixel jog in a line of text is obvious, 2px already
  // crosses it.
  assert.ok(MEASURED.prose.off2 >= S.retryDiff);
  // On a smooth photo-like band the same 2px is barely perceptible and is left
  // alone; the threshold is reached only by a much larger slip.
  assert.ok(MEASURED.photo.off2 < S.retryDiff);
  assert.ok(MEASURED.photo.off3 < S.retryDiff);
  // No frame is ever re-taken for a seam that was already clean.
  for (const [kind, m] of Object.entries(MEASURED)) {
    assert.ok(m.subpixel < S.retryDiff, `${kind}: clean seams are never re-taken`);
  }
});

test("mid-paint frames are only detectable on dense content", () => {
  // Documented limitation, pinned so it is noticed if it ever changes.
  // A photo-like band showing unrelated content is unmistakable...
  assert.ok(MEASURED.photo.unrelated > G.SEAM.retryDiff);
  // ...but two unrelated paragraphs of prose score about what a single pixel
  // of slip scores, because both are mostly white. No threshold separates
  // them without firing on ordinary frames, so the retry cannot catch a
  // mid-paint text frame at all.
  assert.ok(MEASURED.prose.unrelated <= MEASURED.prose.off1 + 0.5);
  assert.ok(MEASURED.prose.unrelated < G.SEAM.retryDiff);
});

test("findSeamShift refuses a match that is merely the least bad", () => {
  // Every candidate is equally wrong: the overlap genuinely differs, so there
  // is no offset worth dragging the frame over to.
  const found = G.findSeamShift((shift) => 60 + Math.abs(shift) * 1e-6, 24);
  assert.equal(found.shift, 0);
  assert.equal(found.diff, found.base);
});

test("findSeamShift does not search when it has no room to", () => {
  let calls = 0;
  const found = G.findSeamShift(() => {
    calls++;
    return 90;
  }, 0);
  assert.equal(found.shift, 0);
  assert.equal(calls, 1);
});

test("planSeamProbe reads the band from the bottom of the shared overlap", () => {
  // Two 800px frames, the second starting 650px down: 150px of overlap, more
  // than enough for a full band and a full search either side of it.
  const probe = G.planSeamProbe(
    { top: 0, height: 800, destTop: 0 },
    { top: 0, height: 800, destTop: 650 }
  );
  assert.equal(probe.band, 48); // capped by SEAM.maxBand
  assert.equal(probe.prevRow, 752); // the last 48 rows of the frame we have
  assert.equal(probe.nextRow, 102); // where the new frame claims those rows are
  assert.equal(probe.search, 48); // capped by SEAM.maxSearch
});

test("planSeamProbe keeps room to search when the overlap is tight", () => {
  // 40px of overlap: a 40px band would fit, but could then only ever confirm
  // the offset it was handed. Half goes to the band, half to the search.
  const probe = G.planSeamProbe(
    { top: 0, height: 800, destTop: 0 },
    { top: 0, height: 800, destTop: 760 }
  );
  assert.equal(probe.band, 20);
  assert.equal(probe.search, 20);
  assert.ok(probe.search > 0, "a probe that cannot move proves nothing");
});

test("planSeamProbe declines frames with too little in common", () => {
  assert.equal(
    G.planSeamProbe({ top: 0, height: 800, destTop: 0 }, { top: 0, height: 800, destTop: 795 }),
    null
  );
  // A gap rather than an overlap: nothing to compare at all.
  assert.equal(
    G.planSeamProbe({ top: 0, height: 800, destTop: 0 }, { top: 0, height: 800, destTop: 900 }),
    null
  );
});

test("planSeamProbe keeps the probe inside both readable bands", () => {
  // Both frames are trimmed 40px at the top by a sticky header.
  const probe = G.planSeamProbe(
    { top: 40, height: 700, destTop: 0 },
    { top: 40, height: 700, destTop: 400 }
  );
  assert.ok(probe.prevRow >= 40);
  assert.ok(probe.prevRow + probe.band <= 740);
  assert.ok(probe.nextRow - probe.search >= 40);
  assert.ok(probe.nextRow + probe.search + probe.band <= 740);
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
    // Content that loads in *above* the viewport once we scroll past
    // `insertAt`: the document gets taller, scrollTop does not move, and every
    // row below the insertion slides `insertPx` further down the document.
    this.insertAt = options.insertAt ?? null;
    this.insertPx = options.insertPx || 0;
    this.inserted = 0;
    this.pendingDrift = 0;
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
    if (this.insertAt !== null && !this.inserted && this.scrollTop >= this.insertAt) {
      this.inserted = this.insertPx;
      this.pendingDrift = this.insertPx;
      this.contentHeight += this.insertPx;
    }
  }


  measure(isFirst) {
    const trimTop = isFirst || this.frameIndex < this.pinnedTopAfterFrame ? 0 : this.pinnedTop;
    const trimBottom = isFirst ? 0 : this.pinnedBottom;
    this.frameIndex++;
    // The page anchor reports each insertion exactly once, on the first
    // measurement after it happened.
    const drift = this.pendingDrift;
    this.pendingDrift = 0;
    return {
      drift,
      // How far the content had already slid when this frame was taken, so a
      // test can say where its rows really belong.
      inserted: this.inserted,
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
  let driftPx = 0;

  for (let index = 0; index < maxFrames; index++) {
    target.scrollTo(walk.nextTop(target.scrollRange()));
    let measured = target.measure(index === 0);
    driftPx += measured.drift || 0;

    const shortfall = walk.repairShortfall(measured);
    if (shortfall) {
      target.scrollTo(Math.max(0, measured.scrollTop - shortfall));
      measured = target.measure(false);
      driftPx += measured.drift || 0;
    }

    frames.push({
      ...measured,
      viewportWidth: target.viewportWidth,
      // The walk keeps steering in the page's live coordinates; only the
      // geometry handed to the stitcher is corrected back to the capture's.
      reportedTop: measured.dest.top,
      dest: { ...measured.dest, top: Math.max(0, measured.dest.top - driftPx) },
    });
    walk.accept(measured);

    if (walk.isComplete(measured, target.contentHeight)) break;
    if (measured.scrollTop >= target.scrollRange() - 1 && measured.scrollTop === previousScrollTop) {
      stopped = "stuck";
      break;
    }
    previousScrollTop = measured.scrollTop;
    if (index === maxFrames - 1) stopped = "frames";
  }

  return { walk, frames, stopped, driftPx, layout: G.resolveFrameLayout(frames, { scale: 1 }) };
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

test("content loading in above the viewport does not shift the stitch", () => {
  // 400px of comments render in above the fold a third of the way down. Every
  // frame after that reports a document offset 400px larger than the ones
  // already captured were recorded against.
  const target = new FakeTarget({
    contentHeight: 6000,
    viewportHeight: 800,
    insertAt: 1500,
    insertPx: 400,
  });
  const run = runWalk(target);

  assert.equal(run.driftPx, 400, "the insertion was seen exactly once");
  assertContiguous(run.layout);
  // The capture covers the page it started on, not that page plus the
  // insertion counted twice.
  assert.equal(run.layout.height, 6000);
  for (const frame of run.frames) {
    assert.equal(
      frame.dest.top,
      Math.max(0, frame.reportedTop - frame.inserted),
      "frame sits where its rows really are"
    );
  }
});

test("without the correction the same insertion inflates the stitch", () => {
  const target = new FakeTarget({
    contentHeight: 6000,
    viewportHeight: 800,
    insertAt: 1500,
    insertPx: 400,
  });
  const run = runWalk(target);
  // Re-lay the same frames out using the offsets the page reported, which is
  // what the capture did before the anchor existed.
  const uncorrected = G.resolveFrameLayout(
    run.frames.map((frame) => ({ ...frame, dest: { top: frame.reportedTop } })),
    { scale: 1 }
  );
  // 400px of rows get painted twice - once where they belong, once again
  // under the labels the page started handing out after the insertion.
  assert.equal(uncorrected.height, 6400);
  assert.equal(run.layout.height, 6000);
});

/* --------------------------- oversized output --------------------------- */

test("fitOutputScale leaves an image that already fits alone", () => {
  assert.equal(G.fitOutputScale(2400, 8000), 1);
});

test("fitOutputScale shrinks a page taller than a canvas can be", () => {
  const fit = G.fitOutputScale(2400, 60000);
  assert.ok(fit > 0 && fit < 1);
  assert.ok(60000 * fit <= G.MAX_CANVAS_SIDE);
  assert.equal(G.checkOutputBudget(Math.round(2400 * fit), Math.round(60000 * fit)).ok, true);
});

test("fitOutputScale refuses a reduction too heavy to be worth it", () => {
  // A page this tall would come back at under a fifth of its size, which is no
  // longer a screenshot of anything readable.
  assert.equal(G.fitOutputScale(2400, 400000), 0);
  assert.equal(G.fitOutputScale(0, 100), 0);
});

test("an output scale moves the destination but not the source", () => {
  const frames = [
    { dest: { top: 0 }, source: { left: 0, top: 0, width: 600, height: 400 } },
    { dest: { top: 400 }, source: { left: 0, top: 0, width: 600, height: 400 } },
  ];
  const full = G.resolveFrameLayout(frames, { scale: 2 });
  const half = G.resolveFrameLayout(frames, { scale: 2, outputScale: 0.5 });

  // Source rectangles index into the screenshots and must not move.
  assert.deepEqual(
    half.draws.map((d) => [d.sx, d.sy, d.sw, d.sh]),
    full.draws.map((d) => [d.sx, d.sy, d.sw, d.sh])
  );
  // The destination, and so the canvas, is halved.
  assert.equal(half.width, full.width / 2);
  assert.equal(half.height, full.height / 2);
  assert.deepEqual(
    half.draws.map((d) => [d.dy, d.dh]),
    [
      [0, 400],
      [400, 400],
    ]
  );
});

test("scaled draws meet exactly, leaving no hairline between frames", () => {
  // Heights that do not divide evenly are where a naive round() opens a gap.
  const frames = [0, 333, 666, 999].map((top) => ({
    dest: { top },
    source: { left: 0, top: 0, width: 600, height: 333 },
  }));
  for (const outputScale of [1, 0.7, 0.37, 0.5123]) {
    const layout = G.resolveFrameLayout(frames, { scale: 2, outputScale });
    for (let i = 1; i < layout.draws.length; i++) {
      const previous = layout.draws[i - 1];
      assert.equal(
        previous.dy + previous.dh,
        layout.draws[i].dy,
        `outputScale ${outputScale}: frame ${i} starts where ${i - 1} ended`
      );
    }
  }
});

/* ------------------------- runaway drift guard -------------------------- */

// Reproduces the shape of a real failure: on an app shell the drift anchor was
// picked from outside the scrolling pane, so every frame reported the whole
// scroll step as "drift". Accumulated and subtracted, that drove every frame's
// offset to zero, the stitcher dropped them all as redundant, and a 40-screen
// conversation came back as a single screen.
test("drift that would collapse the stitch is rejected, not applied", () => {
  const VIEWPORT = 800;
  const STEP = 700;
  const frames = [];
  let driftPx = 0;
  let lastDestTop = -1;
  let rejections = 0;

  for (let index = 0; index < 8; index++) {
    const reportedTop = index * STEP;
    // The broken anchor reports the entire scroll step as drift, every frame.
    const drift = index === 0 ? 0 : STEP;
    driftPx += drift;

    let destTop = reportedTop - driftPx;
    if (frames.length && destTop <= lastDestTop) {
      driftPx -= drift;
      destTop = reportedTop - driftPx;
      rejections++;
    }
    destTop = Math.max(0, destTop);
    lastDestTop = destTop;
    frames.push({ dest: { top: destTop }, source: { left: 0, top: 0, width: 600, height: VIEWPORT } });
  }

  assert.equal(rejections, 7, "every runaway reading is refused");
  const layout = G.resolveFrameLayout(frames, { scale: 1 });
  // Without the guard this is one viewport tall and one draw wide.
  assert.equal(layout.draws.length, 8);
  assert.equal(layout.height, 7 * STEP + VIEWPORT);
  assertContiguous(layout);
});

test("frames stacked at one offset collapse to a single screen", () => {
  // The failure the guard exists to prevent, stated directly.
  const frames = Array.from({ length: 8 }, () => ({
    dest: { top: 0 },
    source: { left: 0, top: 0, width: 600, height: 800 },
  }));
  const layout = G.resolveFrameLayout(frames, { scale: 1 });
  assert.equal(layout.draws.length, 1);
  assert.equal(layout.height, 800);
});

/* ---------------------------- app shell output --------------------------- */

const SHELL = {
  viewport: { width: 1470, height: 835 },
  pane: { left: 240, top: 56, width: 1230, height: 679 },
};

function paneFrames(count, step) {
  return Array.from({ length: count }, (_, i) => ({
    dest: { top: i * step },
    source: { left: SHELL.pane.left, top: SHELL.pane.top, width: SHELL.pane.width, height: SHELL.pane.height },
  }));
}

test("an app shell keeps the window around the scrolling pane", () => {
  const layout = G.resolveFrameLayout(paneFrames(6, 559), { scale: 1 });
  const box = G.shellComposite(SHELL, layout, 1);

  // Full window width, not just the pane: the sidebar has to fit beside it.
  assert.equal(box.width, 1470);
  assert.equal(box.paneX, 240);
  // The header keeps its height above the pane, the composer is pushed to the
  // foot of the whole image rather than repeating mid-page.
  assert.equal(box.paneY, 56);
  assert.equal(box.footerHeight, 835 - (56 + 679));
  assert.equal(box.height, 56 + layout.height + box.footerHeight);
});

test("a shell composite scales with the output", () => {
  const layout = G.resolveFrameLayout(paneFrames(4, 559), { scale: 2, outputScale: 0.5 });
  const box = G.shellComposite(SHELL, layout, 2);
  // scale 2 then halved again lands back on CSS pixels.
  assert.equal(box.paneX, 240);
  assert.equal(box.paneY, 56);
  assert.equal(box.width, 1470);
});

test("a pane filling its window needs no furniture", () => {
  // Not a shell: the pane is the viewport, so the composite is the pane.
  const full = { viewport: { width: 1200, height: 800 }, pane: { left: 0, top: 0, width: 1200, height: 800 } };
  const layout = G.resolveFrameLayout(
    [{ dest: { top: 0 }, source: { left: 0, top: 0, width: 1200, height: 800 } }],
    { scale: 1 }
  );
  const box = G.shellComposite(full, layout, 1);
  assert.equal(box.paneX, 0);
  assert.equal(box.paneY, 0);
  assert.equal(box.footerHeight, 0);
  assert.equal(box.height, layout.height);
});
