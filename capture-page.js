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
    } else {
      document.documentElement.setAttribute("data-fps-scroll-target", "document");
    }

    return { ...fpsDescribeTarget(chosen), ambiguous, alternatives };
  }

  function fpsActiveTargetElement() {
    return document.querySelector('[data-fps-scroll-target="active"]');
  }

  // Scroll the target, then wait until layout and images stop changing, so a
  // lazy-loading page is not photographed mid-render.
  async function fpsScrollAndSettle(request) {
    const el = fpsActiveTargetElement();
    const top = Math.max(0, request.top || 0);

    if (el) {
      el.scrollTo({ top, left: el.scrollLeft, behavior: "instant" });
    } else {
      window.scrollTo({ top, left: 0, behavior: "instant" });
    }

    const deadline = Date.now() + (request.timeoutMs || 1500);
    const minWait = request.minWaitMs || 120;
    const startedAt = Date.now();
    const sample = () => {
      const rect = el ? el.getBoundingClientRect() : { top: 0, height: window.innerHeight };
      const pending = [...document.images].filter((img) => {
        const r = img.getBoundingClientRect();
        const onScreen = r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
        return onScreen && !img.complete;
      }).length;
      return [
        el ? el.scrollHeight : document.documentElement.scrollHeight,
        el ? el.scrollTop : window.scrollY,
        Math.round(rect.top),
        Math.round(rect.height),
        pending,
      ].join(":");
    };

    let previous = sample();
    let stableFor = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const current = sample();
      if (current === previous) {
        stableFor += 60;
        if (stableFor >= 120 && Date.now() - startedAt >= minWait) break;
      } else {
        stableFor = 0;
        previous = current;
      }
    }

    return { settleMs: Date.now() - startedAt };
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

    let height = -1;
    let loads = 0;
    for (let i = 0; i < rounds; i++) {
      await fpsScrollAndSettle({ top: 0, timeoutMs: request?.timeoutMs || 1800 });
      const current = measure();
      if (current === height) break;
      if (height >= 0) loads++;
      height = current;
    }
    return { contentHeight: height, loads };
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

    // Collect first, mutate afterwards: writing a style in the middle of the
    // rect loop invalidates layout, so every following getBoundingClientRect
    // would force a fresh reflow of the whole page.
    const toHide = [];
    const hide = (node) => toHide.push(node);

    let trimTop = 0;
    let trimBottom = 0;
    let blockedMiddle = false;

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

      // A bar pinned to the top of the band is page furniture the screenshot
      // should show once, in its natural place, then skip past.
      if (isHeader) {
        if (isFirst && (insideTarget || box.height <= vh * 0.5)) continue;
        if (fixed) hide(node);
        else trimTop = Math.max(trimTop, box.bottom - bandTop);
        continue;
      }

      // Anything pinned to the bottom - composers, toolbars, cookie bars - is
      // covering content in every frame, including the first.
      if (isFooter) {
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

    return {
      scrollTop,
      contentHeight,
      scrollRange,
      trimTop,
      trimBottom,
      blockedMiddle,
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
    settleTop: fpsSettleTop,
    measureFrame: fpsMeasureFrame,
    restore: fpsRestore,
    pickScrollTarget: fpsPickScrollTarget,
    flashTarget: fpsFlashTarget,
  };
})();
