// End-to-end: capture every fixture page with the real extension and check
// that every row lands in the finished image exactly once, in order, at its
// full height. Run with: npm run test:e2e (HEADED=1 to watch).
//
// Chrome allows an extension about two screenshots a second, and that quota
// is per browser - it is what a capture spends its time on. So every test
// gets a browser of its own and the tests run side by side: the suite takes
// about as long as its slowest test rather than the sum of them.
// E2E_CONCURRENCY overrides how many run at once.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { capture, decodeRows, launch, range, setBudget, startServer, verifyRows } from "./harness.mjs";

// A fixture row is 60px with a 1px border, so its code is 59 CSS px tall.
const ROW = 59;
const TIMEOUT = 120000;
// Measured on a 10-core machine: 8 at once is fastest (51s); past that the
// browsers compete for CPU and every capture slows down.
const CONCURRENCY =
  Number(process.env.E2E_CONCURRENCY) || Math.max(2, Math.min(8, availableParallelism() - 2));

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
});

async function captureFixture(
  name,
  { deviceScaleFactor = 1, viewport, mode = "fullPage", pick, query = "", budget, options = {} } = {}
) {
  const harness = await launch({ deviceScaleFactor, viewport });
  try {
    if (budget) await setBudget(harness, budget);
    const page = await harness.context.newPage();
    await page.goto(`${server.origin}/test/fixtures/${name}.html${query}`);
    await page.waitForLoadState("load");
    const result = await capture(harness, page, { mode, pick, options, diagnostics: true });
    assert.equal(result.error, null, `capture failed: ${result.error}`);
    assert.ok(result.hasImage, "the capture produced no image");
    const decoded = await decodeRows(harness);
    const restored = await page.evaluate(() => ({
      leftovers: document.querySelectorAll("[data-fps-ui], [data-fps-prev-visibility]").length,
      scrollY: window.scrollY,
    }));
    return { result, decoded, restored };
  } finally {
    await harness.close();
  }
}

function assertFullPage({ result, decoded, restored }, expectation, scale = 1) {
  assert.equal(result.truncated, null, `capture reported partial: ${result.truncated?.message}`);
  assert.ok(result.prestitched, "the worker stitcher failed and the viewer fallback was used");
  assert.deepEqual(result.prestitched.gaps, [], "the stitcher reported gaps");
  assert.equal(restored.leftovers, 0, "the page was not fully restored");
  const problems = verifyRows(decoded, { rowHeight: ROW * scale, ...expectation });
  assert.deepEqual(problems, []);
}

// Rows from 0 up to wherever the capture stopped, each exactly once.
function assertPrefix({ result, decoded }, atLeast) {
  assert.ok(result.prestitched, "the worker stitcher failed and the viewer fallback was used");
  const last = Math.max(-1, ...decoded.runs.map((run) => run.index));
  assert.ok(last + 1 >= atLeast, `only ${last + 1} rows captured`);
  assert.deepEqual(verifyRows(decoded, { expected: range(0, last + 1), rowHeight: ROW }), []);
}

const FIXED_SHELL = {
  // The composer is kept on the last frame, where it belongs, and the pane
  // cannot scroll the final row out from under it (README, "Known
  // limitations"). Real apps pad below their last message; this fixture does
  // not.
  expected: range(0, 139),
  optional: [139],
};

const fullPageCases = [
  { name: "document-scroll", expected: range(0, 120) },
  { name: "fixed-shell", ...FIXED_SHELL },
  { name: "sticky-and-fixed", expected: range(0, 120) },
  { name: "lazy-growth", expected: range(0, 180) },
  // Only a window of the small inner scroller's rows is ever on screen.
  { name: "nested-scrollers", expected: [...range(0, 40), ...range(100, 140)], optional: range(40, 100) },
  { name: "virtualized", expected: range(0, 200) },
  { name: "heavy-dom", expected: range(0, 200) },
  // Docs-site layout (MDN, react.dev): sticky navigation columns either side
  // of the content. They are side columns, not headers or footers - trimming
  // the band around them once shrank react.dev's capture to an 80px strip.
  { name: "sticky-rails", expected: range(0, 150), maxFrames: 20 },
  { name: "sticky-rails", query: "?full=1", expected: range(0, 150), maxFrames: 20 },
  // News front page (The Verge): reserved ad slots collapse once they scroll
  // out of view, so the page shrinks between frames. The walk has to follow
  // the rows, seams have to be compared where the rows now are, and the end
  // of a page that is now shorter than it was has to be recognised.
  { name: "collapsing-ads", expected: range(0, 120) },
  // Docs page whose address bar follows the section in view. Changing only
  // the hash is not navigation; it used to cancel the capture.
  { name: "scrollspy", expected: range(0, 120) },
  // News site (The Verge): a masthead that slides back in as the page scrolls
  // up, with a section bar pinned under it. Scrolling back to recover rows
  // grows the masthead by the same distance, and the bar does not touch the
  // top of the window, yet both belong to the header.
  { name: "reveal-header", expected: range(0, 120) },
];

describe("capture", { concurrency: CONCURRENCY }, () => {
  for (const { name, query = "", maxFrames, ...expectation } of fullPageCases) {
    it(`full page: ${name}${query}`, { timeout: TIMEOUT }, async () => {
      const captured = await captureFixture(name, { query });
      assertFullPage(captured, expectation);
      if (maxFrames) {
        assert.ok(captured.result.frames <= maxFrames, `took ${captured.result.frames} frames`);
      }
    });
  }

  // "Wait for slow content": rows arrive 1.5s after their section scrolls
  // into view, behind a skeleton the same height, so nothing in the layout
  // says to wait. Only the network tracker does.
  it("full page: slow-network with wait for slow content", { timeout: TIMEOUT }, async () => {
    const captured = await captureFixture("slow-network", { options: { waitForContent: true } });
    assertFullPage(captured, { expected: range(0, 120) });
  });

  it("full page: two-panes, picking the left pane", { timeout: TIMEOUT }, async () => {
    const captured = await captureFixture("two-panes", {
      pick: (page) => page.mouse.click(320, 400),
    });
    assertFullPage(captured, { expected: range(0, 90) });
  });

  // An app shell at 2x covers both the device-pixel scale and the shell
  // compositing in one run.
  it("full page at 2x: fixed-shell", { timeout: TIMEOUT }, async () => {
    assertFullPage(await captureFixture("fixed-shell", { deviceScaleFactor: 2 }), FIXED_SHELL, 2);
  });

  // A real reload mid-capture must stop the run rather than stitch frames of
  // two different documents together.
  it("full page: reload-midway is cancelled", { timeout: TIMEOUT }, async () => {
    const harness = await launch();
    try {
      const page = await harness.context.newPage();
      await page.goto(`${server.origin}/test/fixtures/reload-midway.html`);
      const result = await capture(harness, page, {});
      assert.match(result.error || "", /reloaded|navigated/);
    } finally {
      await harness.close();
    }
  });

  it("visible area: document-scroll", { timeout: TIMEOUT }, async () => {
    const { result, decoded } = await captureFixture("document-scroll", { mode: "visible" });
    assert.equal(result.error, null);
    // 800px viewport below a ~45px banner: rows 0-11 whole, 12 possibly cut.
    assert.deepEqual(verifyRows(decoded, { expected: range(0, 12), optional: [12], rowHeight: ROW }), []);
  });

  // Past the budget: the capture must stop at the limit and still deliver
  // what it has, not refuse the page outright. A low budget keeps the run
  // short and the image below canvas size, so every row code stays readable.
  it("full page: very-tall stops at the height budget with an image", { timeout: TIMEOUT }, async () => {
    const captured = await captureFixture("very-tall", { budget: { maxContentHeight: 8000 } });
    assert.equal(captured.result.truncated?.reason, "height");
    assertPrefix(captured, 120);
  });

  // An endless feed runs into the frame cap past canvas size, so the stitch
  // has to be shrunk to fit. That path once failed on a one-pixel rounding
  // error and left the capture without an image. A tall window gets there in
  // 20 frames instead of 80. The shrunken row codes are too small to read,
  // so only the result is checked.
  it("full page: infinite-feed is shrunk to fit, not lost", { timeout: TIMEOUT }, async () => {
    const { result } = await captureFixture("infinite-feed", {
      viewport: { width: 1280, height: 2000 },
      budget: { maxFrames: 20 },
    });
    assert.equal(result.truncated?.reason, "frames");
    assert.ok(result.prestitched, "the worker stitcher failed and the viewer fallback was used");
    assert.ok(result.prestitched.downscaled > 0 && result.prestitched.downscaled < 1);
    assert.ok(result.prestitched.height <= 32767);
  });
});
