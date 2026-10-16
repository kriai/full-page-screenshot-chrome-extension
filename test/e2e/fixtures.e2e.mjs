// End-to-end: capture every fixture page with the real extension and check
// that every row lands in the finished image exactly once, in order, at its
// full height. Run with: npm run test:e2e (HEADED=1 to watch).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { capture, decodeRows, launch, range, startServer, verifyRows } from "./harness.mjs";

// A fixture row is 60px with a 1px border, so its code is 59 CSS px tall.
const ROW = 59;
const TIMEOUT = 120000;

let server;
const harnesses = new Map();

before(async () => {
  server = await startServer();
});

after(async () => {
  for (const harness of harnesses.values()) await harness.close();
  await server.close();
});

async function harnessFor(deviceScaleFactor) {
  if (!harnesses.has(deviceScaleFactor)) {
    harnesses.set(deviceScaleFactor, await launch({ deviceScaleFactor }));
  }
  return harnesses.get(deviceScaleFactor);
}

async function captureFixture(name, { deviceScaleFactor = 1, mode = "fullPage", pick } = {}) {
  const harness = await harnessFor(deviceScaleFactor);
  const page = await harness.context.newPage();
  try {
    await page.goto(`${server.origin}/test/fixtures/${name}.html`);
    await page.waitForLoadState("load");
    const result = await capture(harness, page, { mode, pick, diagnostics: true });
    assert.equal(result.error, null, `capture failed: ${result.error}`);
    const dataUrl = result.prestitched?.dataUrl || result.frameDataUrl;
    assert.ok(dataUrl, "the capture produced no image");
    const decoded = await decodeRows(harness, dataUrl);
    const restored = await page.evaluate(() => ({
      leftovers: document.querySelectorAll("[data-fps-ui], [data-fps-prev-visibility]").length,
      scrollY: window.scrollY,
    }));
    return { result, decoded, restored };
  } finally {
    await page.close();
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

const cases = [
  { name: "document-scroll", expected: range(0, 120) },
  // The composer is kept on the last frame, where it belongs, and the pane
  // cannot scroll the final row out from under it (README, "Known
  // limitations"). Real apps pad below their last message; this fixture does
  // not.
  { name: "fixed-shell", expected: range(0, 139), optional: [139] },
  { name: "sticky-and-fixed", expected: range(0, 120) },
  { name: "lazy-growth", expected: range(0, 180) },
  // Only a window of the small inner scroller's rows is ever on screen.
  { name: "nested-scrollers", expected: [...range(0, 40), ...range(100, 140)], optional: range(40, 100) },
  { name: "virtualized", expected: range(0, 400) },
  { name: "heavy-dom", expected: range(0, 200) },
];

for (const { name, ...expectation } of cases) {
  test(`full page: ${name}`, { timeout: TIMEOUT }, async () => {
    assertFullPage(await captureFixture(name), expectation);
  });
}

test("full page: two-panes, picking the left pane", { timeout: TIMEOUT }, async () => {
  const captured = await captureFixture("two-panes", {
    pick: (page) => page.mouse.click(320, 400),
  });
  assertFullPage(captured, { expected: range(0, 90) });
});

for (const name of ["document-scroll", "fixed-shell"]) {
  test(`full page at 2x: ${name}`, { timeout: TIMEOUT }, async () => {
    const expectation = cases.find((c) => c.name === name);
    assertFullPage(
      await captureFixture(name, { deviceScaleFactor: 2 }),
      { expected: expectation.expected, optional: expectation.optional },
      2
    );
  });
}

test("visible area: document-scroll", { timeout: TIMEOUT }, async () => {
  const { result, decoded } = await captureFixture("document-scroll", { mode: "visible" });
  assert.equal(result.error, null);
  // 800px viewport below a ~45px banner: rows 0-11 whole, 12 possibly cut.
  assert.deepEqual(verifyRows(decoded, { expected: range(0, 12), optional: [12], rowHeight: ROW }), []);
});
