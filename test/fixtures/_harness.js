// Dev harness: drives the real page-side capture engine (capture-page.js +
// capture-geometry.js) against a page without taking screenshots, and reports
// coverage, occlusion handling and restoration. Load it in the page console:
//
//   (0, eval)(await (await fetch('/test/fixtures/_harness.js')).text());
//   await __fpsHarness();
//
// Paths assume the repo root is served (python3 -m http.server 8731).
globalThis.__fpsHarness = async function (opts = {}) {
  const root = opts.root || "";
  if (!globalThis.FpsGeometry) (0, eval)(await (await fetch(`${root}/capture-geometry.js`)).text());
  if (!globalThis.__fpsPage) (0, eval)(await (await fetch(`${root}/capture-page.js`)).text());
  const P = globalThis.__fpsPage;
  const G = globalThis.FpsGeometry;

  if (opts.preScroll) {
    const pre = opts.preScroll.selector ? document.querySelector(opts.preScroll.selector) : null;
    if (pre) pre.scrollTop = opts.preScroll.top;
    else window.scrollTo(0, opts.preScroll.top);
  }
  const watched = () => (opts.watch ? document.querySelector(opts.watch)?.scrollTop : null);
  const before = { win: window.scrollY, el: watched() };

  const target = P.prepareTarget({});
  if (!target || target.reason) return { target };

  const overlap = Math.round(G.clamp(Math.round(target.viewportHeight * 0.05), 16, 96));
  const walk = new G.CaptureWalk({ overlap });
  const frames = [];
  let contentHeight = target.contentHeight;
  let scrollRange = target.scrollRange;
  let previous = -1;
  let stopped = "complete";
  let repairs = 0;

  for (let i = 0; i < (opts.maxFrames || 80); i++) {
    await P.scrollAndSettle({ top: walk.nextTop(scrollRange), timeoutMs: 1200 });
    let measured = P.measureFrame({ isFirst: i === 0 });

    const shortfall = walk.repairShortfall(measured);
    if (shortfall) {
      repairs++;
      await P.scrollAndSettle({ top: Math.max(0, measured.scrollTop - shortfall), timeoutMs: 800 });
      measured = P.measureFrame({ isFirst: false });
    }

    contentHeight = Math.max(contentHeight, measured.contentHeight);
    scrollRange = measured.scrollRange;
    frames.push(measured);
    walk.accept(measured);

    if (walk.isComplete(measured, contentHeight)) break;
    if (measured.scrollTop >= scrollRange - 1 && measured.scrollTop === previous) {
      stopped = "stuck";
      break;
    }
    previous = measured.scrollTop;
    if (i === (opts.maxFrames || 80) - 1) stopped = "frames";
  }

  const layout = G.resolveFrameLayout(frames, { scale: 1 });
  const hiddenDuring = document.querySelectorAll("[data-fps-prev-visibility]").length;
  P.restore({
    left: target.originalScrollX,
    top: target.originalScrollY,
    elementScrollTop: target.originalElementScrollTop,
    elementScrollLeft: target.originalElementScrollLeft,
  });

  return {
    kind: target.kind,
    ambiguous: target.ambiguous,
    alternatives: target.alternatives?.length,
    targetRect: target.rect,
    contentHeight,
    frameCount: frames.length,
    stopped,
    repairs,
    overlap,
    gaps: layout.gaps,
    stitchedHeight: layout.height,
    stitchedWidth: layout.width,
    coverage: +(layout.height / contentHeight).toFixed(4),
    firstBand: frames[0]?.source,
    secondBand: frames[1]?.source,
    trims: frames.map((f) => [f.trimTop, f.trimBottom]),
    hiddenDuring,
    leftovers: document.querySelectorAll("[data-fps-prev-visibility],[data-fps-scroll-target]").length,
    restored: { before, after: { win: window.scrollY, el: watched() } },
  };
};
