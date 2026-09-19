// Page-side half of the capture engine. Injected once per capture with
// chrome.scripting.executeScript({files}), it publishes __fpsPage in the
// extension's isolated world so the service worker can call these helpers
// across several executeScript round trips.
//
// Everything here runs in the page's DOM but in an isolated JS world: page
// scripts cannot see or clobber it.
(() => {
  if (globalThis.__fpsPage) return;

  /* --------------------------- in-page code --------------------------- *
   * Everything below runs in the page via chrome.scripting.executeScript,
   * so each function must be self-contained (no closures over the worker).
   * --------------------------------------------------------------------- */

  // Walk the document plus any reachable open shadow roots.
  function fpsCollectElements() {
    const out = [];
    const walk = (root, depth) => {
      if (depth > 4) return;
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  }

  // Rank scrollable areas by how much of the viewport they own, how much
  // content they hold and how centred they are. Deliberately free of class
  // names and host names so the same ranking works on any site.
  function fpsRankScrollTargets() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const viewportArea = Math.max(1, vw * vh);
    const MIN_RANGE = 64;
    const candidates = [];

    const docEl = document.scrollingElement || document.documentElement;
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    const docRange = Math.max(0, docHeight - vh);
    if (docRange >= MIN_RANGE) {
      candidates.push({
        el: docEl,
        kind: "document",
        range: docRange,
        score: 1 + Math.min(1, docRange / (vh * 2)),
        rect: { left: 0, top: 0, width: vw, height: vh },
      });
    }

    const main = document.querySelector("main, [role='main']");
    for (const el of fpsCollectElements()) {
      if (el.closest("[data-fps-ui]")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (Number(style.opacity) === 0) continue;
      const overflowY = style.overflowY;
      if (!/(auto|scroll|overlay)/.test(overflowY)) continue;

      const range = el.scrollHeight - el.clientHeight;
      if (range < MIN_RANGE) continue;

      const rect = el.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(vw, rect.right);
      const bottom = Math.min(vh, rect.bottom);
      const width = right - left;
      const height = bottom - top;
      if (width < 200 || height < 200) continue;

      const areaRatio = (width * height) / viewportArea;
      const rangeScore = Math.min(1, range / (vh * 2));
      const centerX = left + width / 2;
      const centrality = 1 - Math.min(1, Math.abs(centerX - vw / 2) / (vw / 2));
      const carriesMain = main && (el.contains(main) || main.contains(el)) ? 0.15 : 0;

      candidates.push({
        el,
        kind: "element",
        range,
        score: areaRatio * 0.55 + rangeScore * 0.25 + centrality * 0.1 + carriesMain,
        rect: { left, top, width, height },
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  // Confirm a candidate really scrolls by nudging it and putting it back.
  function fpsVerifyScrolls(candidate) {
    if (candidate.kind === "document") {
      const before = window.scrollY;
      const probe = before > 0 ? before - 1 : before + 1;
      window.scrollTo({ top: probe, left: window.scrollX, behavior: "instant" });
      const moved = window.scrollY !== before;
      window.scrollTo({ top: before, left: window.scrollX, behavior: "instant" });
      return moved;
    }
    const el = candidate.el;
    const before = el.scrollTop;
    const probe = before > 0 ? before - 1 : before + 1;
    el.scrollTop = probe;
    const moved = el.scrollTop !== before;
    el.scrollTop = before;
    return moved;
  }

  function fpsDescribeTarget(candidate) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const el = candidate.kind === "document" ? null : candidate.el;
    const contentHeight = el
      ? el.scrollHeight
      : Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        );
    return {
      kind: candidate.kind,
      contentHeight,
      scrollRange: candidate.range,
      rect: candidate.rect,
      viewportWidth: vw,
      viewportHeight: vh,
      dpr: window.devicePixelRatio,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
      originalElementScrollTop: el ? el.scrollTop : null,
      originalElementScrollLeft: el ? el.scrollLeft : null,
    };
  }

  // Pick the scroll target and mark it for the rest of the session. An element
  // the user chose by hand (marked "picked") always wins.
  function fpsPrepareTarget(options) {
    const ambiguityMargin = options?.ambiguityMargin ?? 0.12;
    const picked = document.querySelector('[data-fps-scroll-target="picked"]');

    const ranked = fpsRankScrollTargets();
    let chosen = null;
    let alternatives = [];

    if (picked) {
      chosen = {
        el: picked,
        kind: "element",
        range: picked.scrollHeight - picked.clientHeight,
        score: Infinity,
        rect: (() => {
          const r = picked.getBoundingClientRect();
          return {
            left: Math.max(0, r.left),
            top: Math.max(0, r.top),
            width: Math.min(window.innerWidth, r.right) - Math.max(0, r.left),
            height: Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top),
          };
        })(),
      };
    } else {
      for (const candidate of ranked) {
        if (fpsVerifyScrolls(candidate)) {
          chosen = candidate;
          break;
        }
      }
      // Only candidates ranked *below* the chosen one count as alternatives;
      // higher-ranked ones were rejected because they do not actually scroll.
      const chosenIndex = ranked.indexOf(chosen);
      alternatives = ranked
        .slice(chosenIndex + 1, chosenIndex + 4)
        .map((c) => ({ kind: c.kind, score: c.score, rect: c.rect }));
    }

    if (!chosen) return { reason: "no-scrollable-area" };

    const runnerUp = alternatives[0];
    const ambiguous =
      !picked &&
      !!runnerUp &&
      chosen.score > 0 &&
      (chosen.score - runnerUp.score) / chosen.score < ambiguityMargin;

    if (chosen.kind === "element") {
      chosen.el.setAttribute("data-fps-scroll-target", "active");
      fpsTarget = chosen.el;
      fpsTargetLost = false;
    } else {
      document.documentElement.setAttribute("data-fps-scroll-target", "document");
    }

    return { ...fpsDescribeTarget(chosen), ambiguous, alternatives };
  }

  // The chosen pane, held directly rather than looked up each time.
  //
  // It used to be re-found by attribute on every call, which quietly fails on
  // any framework that re-renders: React replaces the node, or drops an
  // unknown attribute, and the lookup starts returning null. Everything then
  // silently falls back to the document - which on an app shell does not
  // scroll at all - so the pane stops advancing and every later frame reports
  // the same offset. The whole capture stacks up at one position.
  let fpsTarget = null;
  let fpsTargetLost = false;

  function fpsActiveTargetElement() {
    if (fpsTarget && fpsTarget.isConnected) return fpsTarget;
    // Re-acquire if the node was replaced but the marker survived on its
    // successor; otherwise report the loss rather than pretending it is a
    // document capture.
    const marked = document.querySelector('[data-fps-scroll-target="active"]');
    if (marked) fpsTarget = marked;
    else if (fpsTarget) fpsTargetLost = true;
    return fpsTarget && fpsTarget.isConnected ? fpsTarget : marked;
  }

  // Scroll the target, then wait until layout and images stop changing, so a
  // lazy-loading page is not photographed mid-render.
  // How many images are on or near the screen and still loading. An image with
  // no src at all counts too: that is a lazy placeholder whose loader has not
  // run yet, and photographing it gets a grey box.
  function fpsPendingImages() {
    const vh = window.innerHeight;
    let pending = 0;
    const images = document.images;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const unsourced = !img.getAttribute("src") && !img.getAttribute("srcset");
      if (img.complete && !unsourced) continue;
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < vh) pending++;
    }
    return pending;
  }

  // A coarse fingerprint of everything the capture actually depends on. Text
  // churn in a live region does not change it, which matters: a chat app or a
  // clock ticking in the corner would otherwise never look "quiet" and every
  // frame would wait out its full budget.
  function fpsLayoutSignature(el) {
    const rect = el ? el.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    return [
      el ? el.scrollHeight : document.documentElement.scrollHeight,
      el ? el.scrollTop : window.scrollY,
      Math.round(rect.top),
      Math.round(rect.height),
      fpsPendingImages(),
    ].join(":");
  }

  async function fpsScrollAndSettle(request) {
    const el = fpsActiveTargetElement();
    const top = Math.max(0, request.top || 0);

    if (el) {
      el.scrollTo({ top, left: el.scrollLeft, behavior: "instant" });
    } else {
      window.scrollTo({ top, left: 0, behavior: "instant" });
    }

    const startedAt = Date.now();
    // Two budgets, not one. Almost every frame is ready within a few frames of
    // painting, and holding each one open for the worst case is what makes a
    // long capture feel slow. The long budget is only spent while images are
    // actually still arriving.
    const budget = request.timeoutMs || 400;
    const patientBudget = request.patientMs || 1800;
    const minWait = request.minWaitMs || 60;
    // An image count that has not moved in this long is an image that is not
    // coming; stop waiting on it rather than spending the whole budget.
    const stallMs = request.stallMs || 900;

    // Newly mounted media is worth one extra beat even when the layout
    // fingerprint has settled, because the image inside has yet to load.
    let mounted = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added.nodeType !== 1) continue;
          if (added.matches?.("img,video,canvas,picture") || added.querySelector?.("img,picture")) {
            mounted++;
            return;
          }
        }
      }
    });
    try {
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch {
      /* a document without a body yet cannot be observed */
    }

    let previous = fpsLayoutSignature(el);
    let stableSince = Date.now();
    let pendingSince = Date.now();
    let lastPending = fpsPendingImages();
    let seenMounted = mounted;

    try {
      for (;;) {
        const now = Date.now();
        // Only a frame with images still loading earns the longer wait.
        const limit = lastPending > 0 ? patientBudget : budget;
        if (now - startedAt >= limit) break;
        await new Promise((resolve) => setTimeout(resolve, 25));

        const current = fpsLayoutSignature(el);
        if (current !== previous) {
          previous = current;
          stableSince = Date.now();
        }
        if (mounted !== seenMounted) {
          seenMounted = mounted;
          stableSince = Date.now();
        }

        const pending = fpsPendingImages();
        if (pending !== lastPending) {
          lastPending = pending;
          pendingSince = Date.now();
        }

        const settled = Date.now() - stableSince >= 80;
        const imagesDone = pending === 0 || Date.now() - pendingSince > stallMs;
        if (Date.now() - startedAt >= minWait && settled && imagesDone) break;
      }
    } finally {
      observer.disconnect();
    }

    // One more painted frame, so anything that settled on the last tick is on
    // screen before the screenshot. requestAnimationFrame does not fire in a
    // backgrounded tab, so it is raced against a timer - without that, a user
    // switching tabs mid-capture would hang this call forever rather than
    // letting the run notice and cancel.
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 80)),
    ]);

    return { settleMs: Date.now() - startedAt, pending: fpsPendingImages(), mounted };
  }

  // Scroll extent only - no occlusion pass, no anchor, no style writes. Used
  // where the loop needs to know whether the page grew without paying for, or
  // disturbing, a full measurement.
  function fpsMetrics() {
    const el = fpsActiveTargetElement();
    if (el) {
      return {
        contentHeight: el.scrollHeight,
        scrollRange: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    }
    const contentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    return { contentHeight, scrollRange: Math.max(0, contentHeight - window.innerHeight) };
  }

  // Undo every visibility override this engine applied. Occlusion decisions are
  // remade from scratch on each frame, so this runs at the start of every
  // measurement as well as at the end of the capture.
  function fpsRestoreVisibility() {
    for (const node of document.querySelectorAll("[data-fps-prev-visibility]")) {
      const raw = node.getAttribute("data-fps-prev-visibility") || "|";
      const separator = raw.indexOf("|");
      const priority = raw.slice(0, separator);
      const value = raw.slice(separator + 1);
      if (value) node.style.setProperty("visibility", value, priority);
      else node.style.removeProperty("visibility");
      if (!node.getAttribute("style")) node.removeAttribute("style");
      node.removeAttribute("data-fps-prev-visibility");
    }
  }

  // Some apps (chat threads especially) load older content when you reach the
  // top, which prepends rows and shifts every offset underneath. Sit at the
  // top until the content stops growing before the first frame is taken.
  async function fpsSettleTop(request) {
    const el = fpsActiveTargetElement();
    const rounds = request?.rounds || 8;
    const measure = () =>
      el
        ? el.scrollHeight
        : Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
          );

    // Start with the height already on screen. Ordinary pages then need one
    // settle pass; the old -1 sentinel guaranteed two passes and made every
    // capture wait twice even when nothing loaded at the top.
    let height = measure();
    let loads = 0;
    for (let i = 0; i < rounds; i++) {
      await fpsScrollAndSettle({ top: 0, timeoutMs: request?.timeoutMs || 1800 });
      const current = measure();
      if (current === height) break;
      loads++;
      height = current;
    }
    return { contentHeight: height, loads };
  }

  /* ------------------------------- freeze -------------------------------- *
   * A screenshot is a still of something that is not still. Between the first
   * frame and the last, entrance animations play, carousels advance, videos
   * run, and scroll-linked effects move things under the camera. Every one of
   * those shows up as a torn or duplicated strip.
   *
   * So before the loop starts, the page is pinned down: animation stopped at
   * its finished state, media parked, scroll-reveal content forced visible,
   * and the overlays that cover content taken out of the shot. All of it is
   * recorded and reversed afterwards - `fpsThaw` is the exact inverse, and is
   * safe to run twice or after a failure.
   * ---------------------------------------------------------------------- */

  // Sheets and inline styles this pass installed, kept so they can be lifted
  // again in reverse order.
  const fpsFrozen = { sheets: [], styled: [], animations: [], videos: [] };

  function fpsAddSheet(css) {
    const style = document.createElement("style");
    style.dataset.fpsUi = "1";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    fpsFrozen.sheets.push(style);
  }

  // Override a property, remembering what was there. Uses !important because
  // the rules being fought are usually !important themselves.
  function fpsForce(node, props) {
    if (!node || !node.style) return;
    fpsFrozen.styled.push({ node, cssText: node.style.cssText });
    for (const [prop, value] of Object.entries(props)) {
      const name = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
      node.style.setProperty(name, value, "important");
    }
  }

  function fpsFreezeAnimations() {
    // A zero-duration animation without a fill mode snaps back to its *base*
    // style, and for a scroll-reveal effect that base is opacity: 0 - so the
    // naive "turn off animations" rule erases the very content it was meant
    // to settle. Filling forwards holds the last keyframe instead.
    fpsAddSheet(`
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        animation-fill-mode: forwards !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      html, body { scroll-behavior: auto !important; }
      /* An app shell scrolls an inner element, and that element paints its own
         scrollbar - which lands in the capture as a grey stripe down the page.
         Hide every scrollbar, not just the document's. */
      *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      * { scrollbar-width: none !important; }
    `);

    if (typeof document.getAnimations !== "function") return;
    let running;
    try {
      running = document.getAnimations();
    } catch {
      return;
    }
    for (const animation of running) {
      try {
        // getComputedTiming resolves what the animation is actually doing;
        // getTiming reports only what was specified, and returns iterations as
        // null for a CSS `infinite`, which reads as "finite" and sends an
        // endless animation down the finish() path.
        const timing = animation.effect?.getComputedTiming?.() ?? animation.effect?.getTiming?.();
        if (timing && !Number.isFinite(timing.iterations)) {
          // A loop has no final state to settle into; park it where it is.
          if (animation.playState === "running") {
            animation.pause();
            fpsFrozen.animations.push(animation);
          }
        } else {
          animation.finish();
        }
      } catch {
        /* an animation that refuses to be finished is left alone */
      }
    }
  }

  // Playing video is a different frame in every screenshot, which stitches
  // into a vertical smear. Pause anything on or near the screen.
  function fpsFreezeVideo() {
    for (const video of document.querySelectorAll("video")) {
      try {
        const r = video.getBoundingClientRect();
        if (r.width <= 0 || r.bottom < 0 || r.top > window.innerHeight * 3) continue;
        if (!video.paused) {
          video.pause();
          fpsFrozen.videos.push(video);
        }
      } catch {
        /* a cross-origin or detached video cannot be paused */
      }
    }
  }

  // Scroll-reveal libraries start content at opacity 0 and animate it in when
  // it scrolls into view. Below the fold that has not happened yet, so the
  // capture would photograph blank space where the text is. Anything holding
  // real text at zero opacity gets shown.
  function fpsRevealHiddenContent() {
    // Read every rect before writing a single style. A style write invalidates
    // layout, so mutating inside the measuring loop makes each following
    // measurement reflow the whole document - which on a long page is the
    // difference between milliseconds and minutes.
    const toReveal = [];
    for (const node of document.querySelectorAll("[data-aos], [class*='reveal'], [class*='fade']")) {
      if (toReveal.length >= 300) break;
      const style = getComputedStyle(node);
      if (parseFloat(style.opacity) > 0.05) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      // Only content, never chrome: a positioned element at zero opacity is
      // usually a tooltip or a menu waiting to be opened.
      if (style.position === "fixed" || style.position === "absolute") continue;
      if (!node.textContent || !node.textContent.trim()) continue;
      if (node.offsetWidth * node.offsetHeight < 2500) continue;
      toReveal.push(node);
    }
    for (const node of toReveal) fpsForce(node, { opacity: "1", transform: "none" });
    const revealed = toReveal.length;
    // AOS re-applies its own classes on scroll, so the attribute goes too.
    for (const node of document.querySelectorAll("[data-aos]")) {
      const value = node.getAttribute("data-aos");
      fpsFrozen.styled.push({ node, attr: "data-aos", value });
      node.removeAttribute("data-aos");
    }
    return revealed;
  }

  // Parallax and scroll-pinning effects move an element as a function of
  // scroll position, so every frame catches it somewhere different. Pin the
  // common implementations in place.
  function fpsFreezeScrollEffects() {
    fpsAddSheet(`
      [data-effect='BackgroundParallax'], [data-effect='BackgroundParallaxZoom'] {
        position: absolute !important;
      }
      .parallax-mirror { display: none !important; }
      .Parallax-item, .Parallax-item figure {
        position: absolute !important;
        transform: translate3d(0, 0, 0) !important;
      }
      /* Pinning libraries reserve a tall spacer and translate their content
         through it; without the scroll driving them the spacer is just a hole. */
      .pin-spacer, .scrollmagic-pin-spacer {
        height: auto !important;
        min-height: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
      }
    `);
    for (const node of document.querySelectorAll("[data-parallax='scroll'][data-image-src]")) {
      fpsForce(node, {
        backgroundImage: `url(${node.dataset.imageSrc ?? ""})`,
        backgroundPosition: "center",
        backgroundSize: "cover",
      });
    }
  }

  // Cookie banners, newsletter modals and their backdrops sit over the content
  // in every single frame. They are identified by shape rather than by class
  // name, so the same rules work on a site nobody has special-cased.
  function fpsDismissOverlays() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Collected first, hidden afterwards: see fpsRevealHiddenContent.
    const toHide = [];
    const target = fpsActiveTargetElement();

    // Nothing that holds the content may be hidden, whatever it calls itself.
    // App shells label panes `role="dialog"` all the time, and hiding an
    // ancestor of the scroll target collapses it to nothing - the capture then
    // reports a scroll range of zero and stops after a single frame.
    const wouldHideContent = (node) =>
      node.closest("[data-fps-ui]") ||
      (target && (node === target || node.contains(target) || target.contains(node)));

    for (const node of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
      if (wouldHideContent(node)) continue;
      // The role alone is not enough. A real modal is lifted out of the flow
      // and actually on screen; a pane that merely carries the attribute is
      // part of the page.
      const style = getComputedStyle(node);
      if (style.position !== "fixed" && style.position !== "absolute") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = node.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || r.bottom <= 0 || r.top >= vh) continue;
      toHide.push(node);
    }

    for (const node of fpsCollectElements()) {
      if (toHide.length >= 60) break;
      if (wouldHideContent(node)) continue;
      const style = getComputedStyle(node);
      if (style.position !== "fixed") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = node.getBoundingClientRect();

      // A full-viewport translucent sheet is a backdrop, not content.
      const coversViewport = r.width >= vw * 0.95 && r.height >= vh * 0.95;
      const looksLikeScrim =
        style.backgroundColor.includes("rgba") ||
        parseFloat(style.opacity) < 1 ||
        style.backdropFilter !== "none" ||
        node.childElementCount === 0;
      if (coversViewport && looksLikeScrim) {
        toHide.push(node);
        continue;
      }

      // A large box floating clear of every edge, stacked above the page, is a
      // dialog. Bars pinned to an edge are page furniture and are left to the
      // per-frame occlusion pass, which knows how to keep them once.
      const insetFromEdges =
        r.left > vw * 0.05 && r.right < vw * 0.95 && r.top > vh * 0.02 && r.bottom < vh * 0.98;
      const substantial = r.width > vw * 0.25 && r.height > vh * 0.25;
      if (insetFromEdges && substantial && parseInt(style.zIndex, 10) > 999) {
        toHide.push(node);
      }
    }
    for (const node of toHide) fpsForce(node, { display: "none" });
    return toHide.length;
  }

  function fpsFreeze(options) {
    if (fpsFrozen.sheets.length) return { alreadyFrozen: true };
    fpsFreezeAnimations();
    fpsFreezeScrollEffects();
    fpsFreezeVideo();
    const revealed = fpsRevealHiddenContent();
    const overlays = options?.keepOverlays ? 0 : fpsDismissOverlays();
    return { revealed, overlays, sheets: fpsFrozen.sheets.length };
  }

  // Exact inverse of fpsFreeze. Idempotent, and safe after a partial freeze.
  function fpsThaw() {
    for (const sheet of fpsFrozen.sheets.splice(0)) sheet.remove();
    // Reverse order, so an element styled twice ends up with its original.
    for (const entry of fpsFrozen.styled.splice(0).reverse()) {
      if (entry.attr) {
        if (entry.value !== null) entry.node.setAttribute(entry.attr, entry.value);
        continue;
      }
      entry.node.style.cssText = entry.cssText;
      if (!entry.node.getAttribute("style")) entry.node.removeAttribute("style");
    }
    for (const animation of fpsFrozen.animations.splice(0)) {
      try {
        animation.play();
      } catch {
        /* the animation may have been torn down with its element */
      }
    }
    for (const video of fpsFrozen.videos.splice(0)) {
      try {
        video.play().catch(() => {});
      } catch {
        /* autoplay policy may refuse; the page was going to handle that anyway */
      }
    }
  }

  /* ---------------------------- reflow anchor ---------------------------- *
   * Lazy content that loads *above* the current position pushes everything
   * below it further down the document. scrollTop does not move, so every
   * frame we already took now describes stale coordinates and the next one
   * would be stitched too low - a duplicated strip, or a gap.
   *
   * Nothing in the scroll arithmetic can see this happen. So watch one
   * ordinary element near the bottom of the viewport and remember where it
   * sits in the document: any jump in that absolute position is exactly how
   * far the content moved underneath us.
   * ---------------------------------------------------------------------- */
  let fpsAnchor = null;

  // The anchor is only meaningful if it travels with the content being
  // captured. Anything pinned - or anything living outside the pane that
  // scrolls - keeps the same viewport position while scrollTop advances, so
  // its apparent "drift" is the whole scroll step. Accumulated, that wipes out
  // every frame's offset and the stitch collapses to a single screen.
  function fpsAnchorRides(node, target) {
    if (target && !target.contains(node)) return false;
    const stopAt = target || document.body;
    for (let el = node, depth = 0; el && el !== stopAt && depth < 24; el = el.parentElement, depth++) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") return false;
    }
    return true;
  }

  function fpsSetAnchor(scrollTop, contentHeight) {
    fpsAnchor = null;
    const target = fpsActiveTargetElement();
    // Sample inside the scrolling pane, not the window: on an app shell the
    // window's lower edge is the composer, which never moves.
    const box = target
      ? target.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    const width = Math.min(window.innerWidth, box.left + box.width) - left;
    const height = Math.min(window.innerHeight, box.top + box.height) - top;
    if (width < 8 || height < 8) return;

    // Low in the pane first: that content is the most likely to still be on
    // screen after the next scroll.
    for (const y of [0.94, 0.86, 0.72, 0.55]) {
      for (const x of [0.5, 0.3, 0.7]) {
        const node = document.elementFromPoint(
          Math.round(left + width * x),
          Math.round(top + height * y)
        );
        if (!node || node === document.body || node === document.documentElement) continue;
        if (node.closest("[data-fps-ui]")) continue;
        if (!fpsAnchorRides(node, target)) continue;
        const r = node.getBoundingClientRect();
        // Too short to locate precisely, or so tall it is a layout wrapper
        // whose own top says nothing about the rows we are photographing.
        if (r.height < 4 || r.height > height) continue;
        fpsAnchor = { node, top: r.top + scrollTop, contentHeight };
        return;
      }
    }
  }

  // How far the content has moved since the anchor was placed, in content px.
  //
  // Sub-2px wobble is rounding. Beyond that the question is whether the move
  // is real: an element can also jump because the page swapped routes or
  // collapsed a section, and "correcting" for that would wreck the stitch
  // rather than save it. Small moves are taken at face value. A large one has
  // to be corroborated by the document growing to match - content inserted
  // above makes the page taller by just about the distance it pushed
  // everything down, and a layout swap does not.
  function fpsReadAnchorDrift(scrollTop, contentHeight) {
    if (!fpsAnchor || !fpsAnchor.node.isConnected) return 0;
    // It may have become pinned since, or been moved out of the pane.
    if (!fpsAnchorRides(fpsAnchor.node, fpsActiveTargetElement())) return 0;
    const drift = fpsAnchor.node.getBoundingClientRect().top + scrollTop - fpsAnchor.top;
    if (!Number.isFinite(drift)) return 0;

    const size = Math.abs(drift);
    if (size < 2) return 0;
    if (size <= 600) return drift;

    const growth = contentHeight - fpsAnchor.contentHeight;
    const corroborated = Math.abs(drift - growth) <= Math.max(24, size * 0.1);
    return corroborated ? drift : 0;
  }

  // Just the scroll offset, for callers that need to know the page has not
  // moved without paying for a full measurement.
  function fpsScrollTop() {
    const el = fpsActiveTargetElement();
    return { scrollTop: el ? el.scrollTop : window.scrollY };
  }

  // A tall, narrow element pinned to the viewport is a navigation rail, not
  // something covering the content. Hiding it deletes a real column of the
  // page; leaving it fixed repeats it down every frame. Pinning it to the
  // document at the place it currently occupies renders it once, in full,
  // exactly where a reader would expect it.
  //
  // Only direct children of the body qualify: an element positioned inside
  // some other transformed or positioned ancestor would land somewhere else
  // entirely once its containing block changed.
  // Decides only - the style write is deferred to the end of the measuring
  // pass, because writing here would reflow the page under every rect still
  // to be read.
  function fpsRailPlacement(node, box, vw, vh) {
    if (box.height < vh * 0.9 || box.right - box.left >= vw * 0.5) return null;
    // Re-pinning something that holds the content would move the content.
    const target = fpsActiveTargetElement();
    if (target && (node === target || node.contains(target) || target.contains(node))) return null;
    const parent = node.offsetParent;
    if (parent && parent !== document.body && parent !== document.documentElement) return null;
    return {
      node,
      style: {
        position: "absolute",
        top: `${Math.round(box.top + window.scrollY)}px`,
        left: `${Math.round(box.left + window.scrollX)}px`,
        right: "auto",
        bottom: "auto",
      },
    };
  }

  // A pinned element's own rectangle is not always what it paints: ChatGPT's
  // composer, for one, hangs its scroll-to-bottom button above the sticky box.
  // Absorb descendants that render right against the box so the whole pinned
  // cluster is treated as one occluder; anything further away (a portal, an
  // off-screen panel) is left alone so the box cannot balloon.
  function fpsPinnedBox(node, rect) {
    let top = rect.top;
    let bottom = rect.bottom;
    let left = rect.left;
    let right = rect.right;

    const kids = node.querySelectorAll("*");
    if (kids.length <= 400) {
      const slack = 48;
      for (const kid of kids) {
        const r = kid.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.bottom < rect.top - slack || r.top > rect.bottom + slack) continue;
        if (r.right < rect.left - slack || r.left > rect.right + slack) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
    }

    return { top, bottom, left, right, height: bottom - top };
  }

  // Hide or trim around anything pinned over the capture band, remembering the
  // exact inline style so it can be restored. Fixed overlays are hidden (after
  // the first frame keeps page headers once); sticky elements and pinned
  // descendants of the target are never hidden, the band is trimmed instead.
  function fpsMeasureFrame(request) {
    const isFirst = !!request?.isFirst;
    // Start from a clean page: an element that was pinned over the last frame
    // may have scrolled back into its natural place in this one.
    fpsRestoreVisibility();
    const el = fpsActiveTargetElement();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let bandLeft = 0;
    let bandRight = vw;
    let bandTop = 0;
    let bandBottom = vh;
    let originTop = 0;
    let scrollTop = window.scrollY;
    let contentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    let scrollRange = Math.max(0, contentHeight - vh);

    if (el) {
      const rect = el.getBoundingClientRect();
      const clientTop = rect.top + el.clientTop;
      const clientLeft = rect.left + el.clientLeft;
      bandTop = Math.max(0, clientTop);
      bandBottom = Math.min(vh, clientTop + el.clientHeight);
      bandLeft = Math.max(0, clientLeft);
      bandRight = Math.min(vw, clientLeft + el.clientWidth);
      originTop = clientTop;
      scrollTop = el.scrollTop;
      contentHeight = el.scrollHeight;
      scrollRange = Math.max(0, el.scrollHeight - el.clientHeight);
    }

    // A fresh capture must not inherit the previous one's anchor.
    if (isFirst) fpsAnchor = null;
    const drift = fpsReadAnchorDrift(scrollTop, contentHeight);

    // Collect first, mutate afterwards: writing a style in the middle of the
    // rect loop invalidates layout, so every following getBoundingClientRect
    // would force a fresh reflow of the whole page.
    const toHide = [];
    const hide = (node) => toHide.push(node);
    const toUnpin = [];

    let trimTop = 0;
    let trimBottom = 0;
    let blockedMiddle = false;
    let unpinnedRails = 0;
    const isLast = !!request?.isLast;

    for (const node of fpsCollectElements()) {
      if (node.closest("[data-fps-ui]")) continue;
      if (el && (node === el || node.contains(el))) continue;

      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;

      const style = getComputedStyle(node);
      const position = style.position;
      if (position !== "fixed" && position !== "sticky") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (Number(style.opacity) === 0) continue;

      const box = fpsPinnedBox(node, r);
      // Require a real overlap: a sidebar poking a few pixels into the band is
      // beside the capture, not on top of it.
      const overlapWidth = Math.min(box.right, bandRight) - Math.max(box.left, bandLeft);
      const overlapHeight = Math.min(box.bottom, bandBottom) - Math.max(box.top, bandTop);
      if (overlapHeight < 2) continue;
      if (overlapWidth < Math.min(24, (bandRight - bandLeft) * 0.5)) continue;

      const coversTop = box.top <= bandTop + 2;
      const coversBottom = box.bottom >= bandBottom - 2;
      const isHeader = coversTop && !coversBottom;
      const isFooter = coversBottom && !coversTop;

      // A bar pinned to the top of the band is page furniture the screenshot
      // should show once, in its natural place, then skip past.
      // A fixed element never scrolls with the content, even when it sits
      // inside the scroll container in the DOM (the target itself and its
      // ancestors were already skipped above), so it is always chrome and can
      // always be hidden. Sticky elements are page content that happens to be
      // pinned right now, so those are only trimmed around - hiding an app's
      // own composer can wake up its "stick to bottom" logic and move the page
      // out from under the capture.
      const fixed = position === "fixed";
      const insideTarget = el ? el.contains(node) : false;

      // Before deciding to hide anything: a full-height rail can be kept by
      // pinning it to the document instead. It then scrolls with the content
      // like everything else and needs no special handling below.
      if (fixed && !insideTarget) {
        const rail = fpsRailPlacement(node, box, vw, vh);
        if (rail) {
          toUnpin.push(rail);
          continue;
        }
      }

      // A bar pinned to the top of the band is page furniture the screenshot
      // should show once, in its natural place, then skip past.
      if (isHeader) {
        if (isFirst && (insideTarget || box.height <= vh * 0.5)) continue;
        if (fixed) hide(node);
        else trimTop = Math.max(trimTop, box.bottom - bandTop);
        continue;
      }

      // Anything pinned to the bottom - composers, toolbars, cookie bars - is
      // covering content in every frame, including the first. It is still part
      // of the page though, so it is kept on the very last frame, where it
      // sits at the foot of the stitched image exactly as it does on screen.
      if (isFooter) {
        if (isLast && fixed && box.height <= vh * 0.5) continue;
        if (fixed) hide(node);
        else trimBottom = Math.max(trimBottom, bandBottom - box.top);
        continue;
      }

      if (coversTop && coversBottom) {
        if (fixed) hide(node);
        else trimTop = Math.max(trimTop, box.bottom - bandTop);
        continue;
      }

      // Floating mid-band: trimming cannot help, so a fixed widget is hidden
      // and a sticky one is reported as blocking part of the frame.
      if (fixed) hide(node);
      else blockedMiddle = true;
    }

    for (const rail of toUnpin) {
      fpsForce(rail.node, rail.style);
      unpinnedRails++;
    }

    for (const node of toHide) {
      if (!node.hasAttribute("data-fps-prev-visibility")) {
        const value = node.style.getPropertyValue("visibility");
        const priority = node.style.getPropertyPriority("visibility");
        node.setAttribute("data-fps-prev-visibility", `${priority}|${value}`);
      }
      node.style.setProperty("visibility", "hidden", "important");
    }

    // A mis-measured occluder must not eat the frame; past this much the band
    // is reported as blocked instead of being trimmed away.
    const maxTrim = (bandBottom - bandTop) * 0.45;
    if (trimTop > maxTrim) { trimTop = maxTrim; blockedMiddle = true; }
    if (trimBottom > maxTrim) { trimBottom = maxTrim; blockedMiddle = true; }

    const sourceTop = bandTop + trimTop;
    const sourceHeight = Math.max(0, bandBottom - trimBottom - sourceTop);
    const sourceWidth = Math.max(0, bandRight - bandLeft);

    // An app shell is a pane that scrolls inside a window of furniture - a
    // sidebar, a header, a composer. The pane alone is the scrolling content,
    // but the furniture is part of the picture the user is looking at, so its
    // position is reported and the stitcher paints it around the result.
    const shell =
      el &&
      (bandLeft > 40 ||
        bandTop > 40 ||
        bandRight < vw - 40 ||
        bandBottom < vh - 40)
        ? {
            viewport: { width: vw, height: vh },
            pane: {
              left: bandLeft,
              top: bandTop,
              width: Math.max(0, bandRight - bandLeft),
              height: Math.max(0, bandBottom - bandTop),
            },
          }
        : null;

    // Re-anchor last, with the occluders already hidden and nothing else left
    // to move: this is the layout the screenshot is about to record.
    fpsSetAnchor(scrollTop, contentHeight);

    return {
      drift,
      scrollTop,
      contentHeight,
      scrollRange,
      trimTop,
      trimBottom,
      blockedMiddle,
      unpinnedRails,
      shell,
      targetLost: fpsTargetLost,
      viewportWidth: vw,
      viewportHeight: vh,
      dpr: window.devicePixelRatio,
      source: { left: bandLeft, top: sourceTop, width: sourceWidth, height: sourceHeight },
      dest: { top: scrollTop + (sourceTop - originTop) },
    };
  }

  // Idempotent: safe to run after success, failure or cancellation, and safe to
  // run twice.
  function fpsRestore(state) {
    fpsRestoreVisibility();
    fpsThaw();
    fpsAnchor = null;
    fpsTarget = null;
    fpsTargetLost = false;

    const el = document.querySelector('[data-fps-scroll-target="active"]');
    if (el) {
      if (Number.isFinite(state?.elementScrollTop)) {
        el.scrollTo({
          top: state.elementScrollTop,
          left: Number.isFinite(state.elementScrollLeft) ? state.elementScrollLeft : el.scrollLeft,
          behavior: "instant",
        });
      }
      el.removeAttribute("data-fps-scroll-target");
    }
    for (const node of document.querySelectorAll('[data-fps-scroll-target]')) {
      node.removeAttribute("data-fps-scroll-target");
    }

    if (Number.isFinite(state?.left) || Number.isFinite(state?.top)) {
      window.scrollTo({
        left: Number.isFinite(state.left) ? state.left : window.scrollX,
        top: Number.isFinite(state.top) ? state.top : window.scrollY,
        behavior: "instant",
      });
    }

    const overlay = document.getElementById("__fps_progress_overlay");
    if (overlay) overlay.remove();
  }

  // Show the user which pane is about to be captured. Awaited and fully
  // removed before the first frame, so it can never land in a screenshot.
  function fpsFlashTarget(options) {
    return new Promise((resolve) => {
      const el = fpsActiveTargetElement();
      if (!el) {
        resolve(false);
        return;
      }
      const r = el.getBoundingClientRect();
      const outline = document.createElement("div");
      outline.dataset.fpsUi = "1";
      outline.style.cssText = [
        "position:fixed",
        `left:${Math.max(0, r.left)}px`,
        `top:${Math.max(0, r.top)}px`,
        `width:${Math.min(window.innerWidth, r.right) - Math.max(0, r.left)}px`,
        `height:${Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)}px`,
        "z-index:2147483646",
        "pointer-events:none",
        "border:2px solid #78a0ff",
        "border-radius:6px",
        "background:rgba(120,160,255,0.14)",
      ].join(";");
      document.documentElement.appendChild(outline);
      setTimeout(() => {
        outline.remove();
        resolve(true);
      }, options?.durationMs || 420);
    });
  }

  // Click-to-select override: outline the scrollable areas and let the user
  // choose which pane to capture.
  function fpsPickScrollTarget() {
    return new Promise((resolve) => {
      const candidates = fpsRankScrollTargets().filter((c) => c.kind === "element");
      if (!candidates.length) {
        resolve({ picked: false, reason: "no-candidates" });
        return;
      }

      const overlay = document.createElement("div");
      overlay.dataset.fpsUi = "1";
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483646",
        "cursor:crosshair",
        "background:rgba(12,14,20,0.28)",
      ].join(";");

      const outline = document.createElement("div");
      outline.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "border:2px solid #78a0ff",
        "border-radius:6px",
        "background:rgba(120,160,255,0.16)",
        "transition:all 90ms ease",
      ].join(";");

      const hint = document.createElement("div");
      hint.style.cssText = [
        "position:fixed",
        "left:50%",
        "top:24px",
        "transform:translateX(-50%)",
        "padding:10px 14px",
        "border-radius:8px",
        "background:rgba(24,27,34,0.94)",
        "color:#fff",
        "font:13px system-ui,sans-serif",
        "pointer-events:none",
      ].join(";");
      hint.textContent = "Click the area to capture - Esc to cancel";

      overlay.append(outline, hint);
      document.documentElement.appendChild(overlay);

      let current = candidates[0];
      const draw = () => {
        const r = current.el.getBoundingClientRect();
        outline.style.left = `${Math.max(0, r.left)}px`;
        outline.style.top = `${Math.max(0, r.top)}px`;
        outline.style.width = `${Math.min(window.innerWidth, r.right) - Math.max(0, r.left)}px`;
        outline.style.height = `${Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)}px`;
      };
      draw();

      const finish = (result) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(result);
      };
      const onMove = (event) => {
        const hit = candidates
          .filter((c) => {
            const r = c.el.getBoundingClientRect();
            return (
              event.clientX >= r.left &&
              event.clientX <= r.right &&
              event.clientY >= r.top &&
              event.clientY <= r.bottom
            );
          })
          .sort((a, b) => b.score - a.score)[0];
        if (hit && hit !== current) {
          current = hit;
          draw();
        }
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish({ picked: false, reason: "canceled" });
        }
      };

      overlay.addEventListener("mousemove", onMove);
      overlay.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        current.el.setAttribute("data-fps-scroll-target", "picked");
        finish({ picked: true });
      });
      document.addEventListener("keydown", onKey, true);
    });
  }

  globalThis.__fpsPage = {
    rankScrollTargets: fpsRankScrollTargets,
    prepareTarget: fpsPrepareTarget,
    scrollAndSettle: fpsScrollAndSettle,
    scrollTop: fpsScrollTop,
    metrics: fpsMetrics,
    freeze: fpsFreeze,
    thaw: fpsThaw,
    settleTop: fpsSettleTop,
    measureFrame: fpsMeasureFrame,
    restore: fpsRestore,
    pickScrollTarget: fpsPickScrollTarget,
    flashTarget: fpsFlashTarget,
  };
})();
