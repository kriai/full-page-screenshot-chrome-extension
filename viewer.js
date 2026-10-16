const editor = {
  baseCanvas: null,
  baseDisplayCanvas: null,
  baseDisplayCtx: null,
  canvas: null,
  ctx: null,
  annotateMode: false,
  currentTool: "arrow",
  activeTextInput: null,
  baseName: "screenshot",
  dragStart: null,
  draft: null,
  exportStatusTimer: null,
  exportBaseName: "screenshot",
  exportDirty: true,
  exportVersion: 0,
  exportUrls: [],
  historySaveTimer: null,
  historyReady: false,
  interaction: null,
  layout: {
    enabled: false,
    background: "soft",
    padding: 48,
    radius: 14,
    shadow: 28,
    aspect: "auto",
    frame: "none",
    frameAddress: true,
    stamp: "none",
    stampUrl: false,
  },
  // For the browser frame's address bar and the date stamp.
  pageUrl: "",
  capturedAt: 0,
  jpegQuality: 0.92,
  nextOperationId: 1,
  operations: [],
  pendingPreview: null,
  previewScale: 1,
  // The history entry this editor saves into, once there is one.
  historyId: "",
  // A capture too tall for one image arrives in parts: [{ imageKey, width,
  // height, outKey? }]. Only the current part's image is held; each part
  // keeps its own annotations and undo history in partState.
  parts: null,
  partIndex: 0,
  partState: [],
  pendingStyleEdit: null,
  redrawFrame: 0,
  redoStack: [],
  selectedIndex: -1,
  undoStack: [],
  zoom: 1,
  zoomMode: "fit",
  // The style new annotations get, and the selected one shows. Hide areas
  // keep their own strength so it does not follow the drawing thickness.
  style: null,
  hideMethod: "blur",
  // Crop is a pending rectangle until Apply; null outside the crop tool.
  cropDraft: null,
  cropAspect: "free",
  toolBeforeCrop: "arrow",
  // Steps placed from this operation id on count from 1 again.
  stepRestartId: 0,
};

const TOOLS = {
  select: {
    label: "Select",
    key: "V",
    hint: "Click any annotation to move, restyle or delete it. Everything you added is listed below.",
  },
  arrow: { label: "Arrow", key: "A", hint: "Drag to point at something." },
  rect: { label: "Box", key: "R", hint: "Drag to outline an area." },
  text: { label: "Text", key: "T", hint: "Click anywhere to add a label." },
  step: { label: "Step", key: "S", hint: "Click to drop numbered markers. Numbers count up automatically." },
  pen: { label: "Pen", key: "P", hint: "Draw freehand." },
  hide: { label: "Hide", key: "H", hint: "Drag over anything sensitive: names, emails, numbers." },
  crop: { label: "Crop", key: "C", hint: "Drag the edges to trim the screenshot." },
};

// B stays on Box for anyone used to the old shortcut.
const shortcutToolMap = { v: "select", a: "arrow", r: "rect", b: "rect", t: "text", s: "step", p: "pen", h: "hide", c: "crop" };

// The Hide tool draws one of three operation types; saved projects keep them.
const HIDE_TYPES = ["blur", "pixelate", "redact"];
const HIDE_NOTES = {
  blur: "Softens content. Good for faces and backgrounds.",
  pixelate: "Turns content into blocks. Hard to read, still shows shape.",
  redact: "Solid bar. The safest choice for passwords, emails and IDs.",
};
// Presets over the stroke and text-size values the editor has always used.
const THICKNESS = { thin: 3, medium: 5, thick: 9 };
const TEXT_SIZES = { small: 20, medium: 28, large: 44 };
const STEP_TEXT_SIZE = 28;
const CROP_ASPECTS = { free: 0, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1 };

const defaultStyle = { color: "#E5484D", strokeWidth: 5, textSize: 28, strength: 5, textBackground: false };
editor.style = { ...defaultStyle };
const MAX_EDITOR_PREVIEW_PIXELS = 24000000;

// Which panel a tool or an operation type belongs to.
function toolGroup(typeOrTool) {
  return HIDE_TYPES.includes(typeOrTool) ? "hide" : typeOrTool;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// A frame arrives as a Blob, as a key into the image store, or - from a
// capture saved by an older version - as a data URL.
async function loadFrameImage(frame) {
  const blob = frame.blob || (frame.key ? await FpsImages.get(frame.key) : null);
  if (!blob) {
    if (frame.dataUrl) return loadImage(frame.dataUrl);
    throw new Error("A captured frame is missing from storage.");
  }
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error(`Unable to create ${type} output.`));
      }
    }, type, quality);
  });
}

function slugify(value, fallback = "screenshot", maxLength = 60) {
  const slug = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/g, "");
  return slug || fallback;
}

function timestampSlug(capturedAt) {
  const date = new Date(capturedAt || Date.now());
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

function captureModeLabel(mode) {
  if (mode === "visible") return "visible";
  if (mode === "selection") return "selection";
  return "full-page";
}

function buildBaseName(capture) {
  let domain = "page";
  try {
    domain = new URL(capture.pageUrl).hostname.replace(/^www\./, "");
  } catch (_err) {
    // Keep the fallback.
  }

  const maxLength = 110;
  const domainSlug = slugify(domain, "page", 32);
  const modeSlug = captureModeLabel(capture.mode);
  const timeSlug = timestampSlug(capture.capturedAt);
  const reserved = `${domainSlug}-${modeSlug}-${timeSlug}`.length + 2;
  const titleLength = Math.max(12, maxLength - reserved);
  const titleSlug = slugify(capture.pageTitle, "screenshot", titleLength);

  return `${domainSlug}-${titleSlug}-${modeSlug}-${timeSlug}`;
}

function makeJpegCanvas(canvas) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const ctx = exportCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  ctx.drawImage(canvas, 0, 0);
  return exportCanvas;
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function byteLength(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function makePdfBlob(jpegBytes, imageWidth, imageHeight) {
  return makePdfPages([{ jpegBytes, width: imageWidth, height: imageHeight }]);
}

// One page per image: a capture saved in parts becomes one page per part.
function makePdfPages(pages) {
  const pageWidth = 612;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = [];
  for (const page of pages) {
    const pageHeight = Math.round((pageWidth * page.height) / page.width);
    const pageObject = objects.length + 1;
    kids.push(`${pageObject} 0 R`);
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im1 Do\nQ\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im1 ${pageObject + 1} 0 R >> >> /Contents ${pageObject + 2} 0 R >>`,
      {
        dictionary: `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>`,
        stream: page.jpegBytes,
      },
      {
        dictionary: `<< /Length ${textBytes(content).length} >>`,
        stream: textBytes(content),
      }
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  const chunks = [textBytes("%PDF-1.4\n")];
  const offsets = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength(chunks));
    chunks.push(textBytes(`${i + 1} 0 obj\n`));
    if (typeof objects[i] === "string") {
      chunks.push(textBytes(`${objects[i]}\nendobj\n`));
    } else {
      chunks.push(textBytes(`${objects[i].dictionary}\nstream\n`));
      chunks.push(objects[i].stream);
      chunks.push(textBytes("\nendstream\nendobj\n"));
    }
  }

  const xrefOffset = byteLength(chunks);
  chunks.push(textBytes(`xref\n0 ${objects.length + 1}\n`));
  chunks.push(textBytes("0000000000 65535 f \n"));
  for (let i = 1; i < offsets.length; i++) {
    chunks.push(textBytes(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`));
  }
  chunks.push(
    textBytes(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    )
  );

  return new Blob([concatBytes(chunks)], { type: "application/pdf" });
}

function drawCapture(capture, images, report = {}) {
  const { frames, metrics, mode, cropRect } = capture;
  const scale = images[0].width / metrics.viewportWidth;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // Full-page captures are normally handed over as one worker-stitched PNG.
  // Loading it is the same cheap path as a visible-area screenshot; preserve
  // the stitch report so partial/downscaled notices still reach the user.
  if (capture.prestitched) {
    canvas.width = images[0].width;
    canvas.height = images[0].height;
    ctx.drawImage(images[0], 0, 0);
    Object.assign(report, capture.prestitchedReport || {});
    return canvas;
  }

  if (mode === "selection" && cropRect) {
    const sx = Math.round(cropRect.left * scale);
    const sy = Math.round(cropRect.top * scale);
    const sw = Math.round(cropRect.width * scale);
    const sh = Math.round(cropRect.height * scale);
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(images[0], sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  if (mode === "visible") {
    canvas.width = images[0].width;
    canvas.height = images[0].height;
    ctx.drawImage(images[0], 0, 0);
    return canvas;
  }

  // Captures from the shared engine carry explicit per-frame geometry: a
  // source rectangle in viewport pixels and the content offset it belongs at.
  if (capture.layout?.version === 2 && frames[0]?.source) {
    const scales = frames.map((frame, i) => images[i].width / frame.viewportWidth);
    const consistency = FpsGeometry.checkScaleConsistency(scales);
    if (!consistency.ok) {
      report.scaleWarning =
        "The page zoom or window size changed while capturing, so sections may not line up.";
    }

    let layout = FpsGeometry.resolveFrameLayout(frames, { scale: consistency.scale });

    // A tall page can capture cleanly and still be too big to hand over as one
    // image - Chrome will not allocate a canvas past 32767px on a side. Given
    // the choice between the whole page slightly reduced and a sharp fragment
    // of it, the whole page is what was asked for, so it is fitted rather than
    // cut off.
    if (!FpsGeometry.checkOutputBudget(layout.width, layout.height).ok) {
      const fit = FpsGeometry.fitOutputScale(layout.width, layout.height);
      if (!fit) {
        throw new Error(FpsGeometry.checkOutputBudget(layout.width, layout.height).message);
      }
      layout = FpsGeometry.resolveFrameLayout(frames, {
        scale: consistency.scale,
        outputScale: fit,
      });
      const budget = FpsGeometry.checkOutputBudget(layout.width, layout.height);
      if (!budget.ok) throw new Error(budget.message);
      report.downscaled = fit;
    }

    // An app shell scrolls a pane inside a window of furniture. The pane is
    // what the layout above describes; the sidebar, header and composer around
    // it are static, so they are painted once rather than repeated down every
    // frame. Offsets put the pane back where it sits in the window.
    const shell = capture.layout?.shell;
    const box = shell ? FpsGeometry.shellComposite(shell, layout, consistency.scale) : null;
    const paneX = box ? box.paneX : 0;
    const paneY = box ? box.paneY : 0;

    canvas.width = box ? box.width : layout.width;
    canvas.height = box ? box.height : layout.height;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";

    // The furniture first, from the opening frame: everything outside the pane
    // is drawn, then the pane's own content is laid over the top of it.
    if (box && images[0]) {
      ctx.drawImage(
        images[0],
        0,
        0,
        images[0].width,
        images[0].height,
        0,
        0,
        box.viewportWidth,
        box.viewportHeight
      );
    }

    for (const draw of layout.draws) {
      ctx.drawImage(
        images[draw.index],
        draw.sx,
        draw.sy,
        draw.sw,
        draw.sh,
        draw.dx + paneX,
        draw.dy + paneY,
        draw.dw,
        draw.dh
      );
    }

    // Anything below the pane - a composer, a toolbar - belongs at the foot of
    // the finished image, taken from the last frame, where it is showing the
    // end of the content rather than the middle.
    if (box && box.footerHeight > 0) {
      const last = images[images.length - 1];
      const srcTop = Math.round(
        (shell.pane.top + shell.pane.height) * (last.width / frames[frames.length - 1].viewportWidth)
      );
      const srcHeight = Math.max(0, last.height - srcTop);
      if (srcHeight > 0) {
        ctx.drawImage(
          last,
          0,
          srcTop,
          last.width,
          srcHeight,
          0,
          paneY + layout.height,
          box.viewportWidth,
          box.footerHeight
        );
      }
    }

    report.gaps = layout.gaps;
    report.capturedHeight = layout.contentHeight;
    report.shell = !!shell;
    return canvas;
  }

  if (metrics.scrollRect) {
    const rect = metrics.scrollRect;
    const sx = Math.round(rect.left * scale);
    const sy = Math.round(rect.top * scale);
    const sw = Math.round(rect.width * scale);
    const visibleHeight = Math.round(rect.height * scale);

    canvas.width = sw;
    canvas.height = Math.round(metrics.pageHeight * scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    frames.forEach((frame, i) => {
      const dy = Math.round(frame.y * scale);
      const remainingHeight = Math.max(0, canvas.height - dy);
      const sh = Math.min(visibleHeight, remainingHeight);
      if (sh > 0) ctx.drawImage(images[i], sx, sy, sw, sh, 0, dy, sw, sh);
    });

    return canvas;
  }

  const legacyBudget = FpsGeometry.checkOutputBudget(
    images[0].width,
    Math.round(metrics.pageHeight * scale)
  );
  if (!legacyBudget.ok) throw new Error(legacyBudget.message);

  canvas.width = images[0].width;
  canvas.height = Math.round(metrics.pageHeight * scale);

  // Each frame is drawn at the scroll offset it was captured at; overlapping
  // regions (the clamped last frame) simply paint the same pixels twice.
  frames.forEach((frame, i) => {
    ctx.drawImage(images[i], 0, Math.round(frame.y * scale));
  });

  return canvas;
}

function setDownload(anchor, blob, filename) {
  const nextUrl = URL.createObjectURL(blob);
  editor.exportUrls.push(nextUrl);
  anchor.href = nextUrl;
  anchor.download = filename;
}

function clearExportUrls() {
  for (const url of editor.exportUrls) URL.revokeObjectURL(url);
  editor.exportUrls = [];
  for (const id of ["downloadPng", "downloadJpeg", "downloadPdf"]) {
    const anchor = document.getElementById(id);
    if (!anchor) continue;
    anchor.removeAttribute("href");
    delete anchor.dataset.exportReady;
  }
}

function markExportsStale(baseName = editor.exportBaseName, options = {}) {
  editor.exportBaseName = baseName || editor.baseName || "screenshot";
  editor.exportDirty = true;
  editor.exportVersion++;
  clearExportUrls();
  scheduleProjectHistorySave();
}

function setCanvasCssWidth(canvas, width) {
  if (!canvas) return;
  canvas.style.width = width ? `${width}px` : "";
}

function syncDisplayCanvases() {
  if (!editor.baseCanvas || !editor.baseDisplayCanvas || !editor.canvas) return;

  const pixels = editor.baseCanvas.width * editor.baseCanvas.height;
  editor.previewScale =
    pixels > MAX_EDITOR_PREVIEW_PIXELS
      ? Math.sqrt(MAX_EDITOR_PREVIEW_PIXELS / pixels)
      : 1;
  const previewWidth = Math.max(1, Math.round(editor.baseCanvas.width * editor.previewScale));
  const previewHeight = Math.max(1, Math.round(editor.baseCanvas.height * editor.previewScale));

  for (const canvas of [editor.baseDisplayCanvas, editor.canvas]) {
    if (canvas.width !== previewWidth) canvas.width = previewWidth;
    if (canvas.height !== previewHeight) canvas.height = previewHeight;
  }

  editor.baseDisplayCtx.clearRect(
    0,
    0,
    editor.baseDisplayCanvas.width,
    editor.baseDisplayCanvas.height
  );
  editor.baseDisplayCtx.drawImage(
    editor.baseCanvas,
    0,
    0,
    editor.baseDisplayCanvas.width,
    editor.baseDisplayCanvas.height
  );
}

function requestRedraw(preview = null) {
  editor.pendingPreview = preview;
  if (editor.redrawFrame) return;
  editor.redrawFrame = requestAnimationFrame(() => {
    editor.redrawFrame = 0;
    const nextPreview = editor.pendingPreview;
    editor.pendingPreview = null;
    redraw(nextPreview);
  });
}

function normalizeRect(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return { x, y, width, height };
}

function pointerToCanvasPoint(event) {
  const rect = editor.canvas.getBoundingClientRect();
  const width = editor.baseCanvas?.width || editor.canvas.width;
  const height = editor.baseCanvas?.height || editor.canvas.height;
  return {
    x: ((event.clientX - rect.left) / rect.width) * width,
    y: ((event.clientY - rect.top) / rect.height) * height,
  };
}

// The style an operation of `tool` is drawn with. Hide areas use the strength
// as their stroke width, which blur and pixelate read as their amount.
function currentStyle(tool = editor.currentTool) {
  const style = editor.style;
  return {
    color: style.color,
    strokeWidth: toolGroup(tool) === "hide" ? style.strength : style.strokeWidth,
    textSize: style.textSize,
  };
}

function setCurrentStyle(style) {
  for (const key of Object.keys(defaultStyle)) {
    if (style[key] !== undefined && style[key] !== null) editor.style[key] = style[key];
  }
  if (HIDE_NOTES[style.hideMethod]) editor.hideMethod = style.hideMethod;
  syncStyleControls();
}

// The preset whose value is closest, so a value from an older version still
// lights one up.
function nearestPreset(presets, value) {
  let best = null;
  for (const [name, preset] of Object.entries(presets)) {
    if (best === null || Math.abs(preset - value) < Math.abs(presets[best] - value)) best = name;
  }
  return best;
}

function setChecked(selector, attribute, value) {
  for (const button of document.querySelectorAll(selector)) {
    button.setAttribute("aria-checked", String(button.dataset[attribute] === value));
  }
}

function strengthLabel(value, method) {
  return method === "pixelate" ? `${Math.max(6, value * 4)}px` : `${value}px`;
}

// Puts editor.style into the panel's controls.
function syncStyleControls() {
  const style = editor.style;
  const color = String(style.color).toLowerCase();
  for (const swatch of document.querySelectorAll("[data-color]")) {
    swatch.setAttribute("aria-checked", String(swatch.dataset.color.toLowerCase() === color));
  }
  setChecked("[data-thickness]", "thickness", nearestPreset(THICKNESS, style.strokeWidth));
  setChecked("[data-text-size]", "textSize", nearestPreset(TEXT_SIZES, style.textSize));
  const background = document.getElementById("textBackground");
  if (background) background.checked = !!style.textBackground;

  const selected = editor.operations[editor.selectedIndex];
  const method = selected && HIDE_TYPES.includes(selected.type) ? selected.type : editor.hideMethod;
  setChecked("[data-hide-method]", "hideMethod", method);
  const note = document.getElementById("hideNote");
  if (note) note.textContent = HIDE_NOTES[method];
  const strength = document.getElementById("strength");
  if (strength) {
    strength.value = String(style.strength);
    document.getElementById("strengthControl").hidden = method === "redact";
    document.getElementById("strengthValue").textContent = strengthLabel(style.strength, method);
  }

  const next = document.getElementById("nextStep");
  if (next) {
    next.textContent = String(nextStepNumber());
    next.style.background = style.color;
    next.style.color = isLightColor(style.color) ? "#111111" : "#ffffff";
  }
}

function isLightColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value));
  if (!match) return false;
  const n = parseInt(match[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}

function textFromEditor(element) {
  return element.innerText.replace(/\n+$/g, "").trim();
}

const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>';
const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

// Typing a label: a small input floats 12px above the text (below it near the
// top edge, always inside the canvas area) at a fixed screen size, while the
// label itself shows on the canvas in its final colour and size.
function openTextEditor(point, baseName) {
  if (editor.activeTextInput) editor.activeTextInput.finish(true);

  const area = document.querySelector(".canvas-area");
  const stage = document.getElementById("stage");
  const wrap = document.createElement("div");
  wrap.className = "text-input";
  const dot = document.createElement("span");
  dot.className = "text-dot";
  const input = document.createElement("div");
  input.className = "text-field";
  input.contentEditable = "true";
  input.dataset.placeholder = "Type a label";
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-label", "Label text");
  const done = document.createElement("button");
  done.type = "button";
  done.className = "text-done";
  done.title = "Done (Enter)";
  done.setAttribute("aria-label", "Done");
  done.innerHTML = CHECK_ICON;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "text-cancel";
  cancel.title = "Cancel (Esc)";
  cancel.setAttribute("aria-label", "Cancel");
  cancel.innerHTML = CLOSE_ICON;
  wrap.append(dot, input, done, cancel);
  area.appendChild(wrap);

  // The first few times only.
  let hint = null;
  if ((editor.textHintUses || 0) < 3) {
    hint = document.createElement("div");
    hint.className = "text-hint";
    hint.textContent = "Enter to finish · Esc to cancel";
    area.appendChild(hint);
    editor.textHintUses = (editor.textHintUses || 0) + 1;
    chrome.storage.local.set({ textHintUses: editor.textHintUses }).catch(() => {});
  }

  editor.textDraft = { type: "text", point, text: "", ...currentStyle("text"), background: !!editor.style.textBackground };
  let finished = false;

  function place() {
    const m = clientMapper();
    const box = area.getBoundingClientRect();
    const draft = editor.textDraft;
    const bounds = draft.text
      ? textBounds(draft)
      : { x: point.x, y: point.y, width: 0, height: draft.textSize * 1.22 };
    const textTop = m.y(bounds.y);
    const textBottom = m.y(bounds.y + bounds.height);
    const height = wrap.offsetHeight;
    const width = wrap.offsetWidth;
    let top = textTop - 12 - height;
    const above = top >= box.top + 8;
    if (!above) top = textBottom + 12;
    top = Math.min(Math.max(top, box.top + 8), box.bottom - height - 8);
    const left = Math.min(Math.max(m.x(bounds.x), box.left + 8), box.right - width - 8);
    wrap.style.left = `${left - box.left}px`;
    wrap.style.top = `${top - box.top}px`;
    if (hint) {
      const hintTop = above ? textBottom + 8 : top + height + 4;
      hint.style.left = `${left - box.left}px`;
      hint.style.top = `${Math.min(hintTop, box.bottom - 24) - box.top}px`;
    }
  }

  function syncStyle() {
    const style = currentStyle("text");
    Object.assign(editor.textDraft, style, { background: !!editor.style.textBackground });
    dot.style.background = style.color;
    requestRedraw();
    place();
  }

  function finish(commit) {
    if (finished) return;
    finished = true;
    const text = textFromEditor(input);
    const draft = editor.textDraft;
    wrap.remove();
    hint?.remove();
    stage.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    editor.activeTextInput = null;
    editor.textDraft = null;

    if (commit && text) {
      pushOperation({ ...draft, text, point }, baseName);
    } else {
      redraw();
    }
  }

  editor.activeTextInput = { finish, syncStyle };

  input.addEventListener("input", () => {
    editor.textDraft.text = textFromEditor(input);
    requestRedraw();
    place();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    }
  });
  // Keep the focus in the field when a button is pressed.
  for (const button of [done, cancel]) button.addEventListener("pointerdown", (event) => event.preventDefault());
  cancel.addEventListener("click", () => finish(false));
  done.addEventListener("click", () => finish(true));
  stage.addEventListener("scroll", place, { passive: true });
  window.addEventListener("resize", place);
  syncStyle();
  requestAnimationFrame(() => {
    place();
    input.focus();
  });
}

function cloneOperation(operation) {
  return JSON.parse(JSON.stringify(operation));
}

function sameOperation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneLayout(layout = editor.layout) {
  return JSON.parse(JSON.stringify(layout));
}

// Annotations and layout only. The unannotated image lives in the image store
// under the entry's `baseKey`; projects used to carry it inline as a data URL,
// so every edit rewrote the whole screenshot into history.
function cloneProject() {
  if (editor.parts) stashPartState();
  return {
    version: 2,
    baseWidth: editor.baseCanvas.width,
    baseHeight: editor.baseCanvas.height,
    operations: editor.parts ? [] : editor.operations.map(cloneOperation),
    ...(editor.parts
      ? { parts: editor.partState.map((state) => ({ operations: state.operations.map(cloneOperation) })) }
      : {}),
    layout: cloneLayout(),
  };
}

/* ------------------------------ parts ---------------------------------- */

function newPartState(operations = []) {
  const ops = operations.map((operation) => cloneOperation(operation));
  return {
    operations: ops,
    undoStack: [],
    redoStack: [],
    nextOperationId: ops.reduce((max, operation) => Math.max(max, operation.id || 0), 0) + 1,
  };
}

function stashPartState() {
  editor.partState[editor.partIndex] = {
    operations: editor.operations,
    undoStack: editor.undoStack,
    redoStack: editor.redoStack,
    nextOperationId: editor.nextOperationId,
  };
}

function applyPartState(state) {
  editor.operations = state.operations;
  editor.undoStack = state.undoStack;
  editor.redoStack = state.redoStack;
  editor.nextOperationId = state.nextOperationId;
  editor.selectedIndex = -1;
  editor.stepRestartId = 0;
}

async function loadPartCanvas(index) {
  const part = editor.parts[index];
  const blob = await FpsImages.get(part.imageKey);
  if (!blob) throw new Error(`Part ${index + 1} is missing from storage.`);
  const image = await loadFrameImage({ blob });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

function syncPartNav() {
  const nav = document.getElementById("partNav");
  if (!nav) return;
  nav.hidden = !editor.parts;
  if (!editor.parts) return;
  document.getElementById("partLabel").textContent = `Part ${editor.partIndex + 1} of ${editor.parts.length}`;
  document.getElementById("partPrev").disabled = editor.partIndex === 0;
  document.getElementById("partNext").disabled = editor.partIndex === editor.parts.length - 1;
  syncMeta();
}

// The top bar's meta line: the image's size and how many annotations it has.
function syncMeta() {
  if (!editor.baseCanvas) return;
  const { width, height } = editor.baseCanvas;
  const total = editor.parts ? editor.parts.reduce((sum, part) => sum + part.height, 0) : 0;
  document.getElementById("dimensions").textContent =
    `${width} × ${height}` + (editor.parts ? ` of ${total}` : "");
  const count = document.getElementById("annotationCount");
  if (!count || !editor.canvas) return;
  const n = editor.operations.length;
  count.hidden = false;
  count.textContent = `${n} annotation${n === 1 ? "" : "s"}`;
}

async function switchPart(index) {
  if (!editor.parts || index === editor.partIndex || index < 0 || index >= editor.parts.length) return;
  finalizeStyleEdit();
  if (editor.activeTextInput) editor.activeTextInput.finish(true);
  // The part being left is saved first, so its annotations are not lost if
  // the editor is closed on the next one.
  await saveRenderedPartToHistory().catch((err) => console.warn("Unable to save the part:", err));
  stashPartState();
  editor.baseCanvas = await loadPartCanvas(index);
  editor.partIndex = index;
  applyPartState(editor.partState[index]);
  syncDisplayCanvases();
  redraw();
  applyLayoutPreview();
  syncPartNav();
  syncJpegLabel();
  syncEditActionState();
  syncStyleControlVisibility();
  syncNavigator();
  markExportsStale(editor.baseName, { quiet: true });
}

// Part `index` with its annotations, without the presentation layout: what
// the stacked exports are built from. Blur and pixelate read the part's own
// pixels through editor.baseCanvas, so it is swapped in for the render.
async function renderPartAnnotated(index) {
  if (index === editor.partIndex) return renderAnnotatedCanvas();
  const base = await loadPartCanvas(index);
  const saved = { base: editor.baseCanvas, operations: editor.operations };
  editor.baseCanvas = base;
  editor.operations = editor.partState[index].operations;
  try {
    return renderAnnotatedCanvas();
  } finally {
    editor.baseCanvas = saved.base;
    editor.operations = saved.operations;
  }
}

// What the stacked exports draw for each part: the stored image when it has
// no annotations, otherwise a fresh render.
async function partSources() {
  stashPartState();
  const sources = [];
  for (let i = 0; i < editor.parts.length; i++) {
    if (editor.partState[i].operations.length) sources.push(await renderPartAnnotated(i));
    else sources.push(await FpsImages.get(editor.parts[i].imageKey));
  }
  return sources;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setupPartControls() {
  if (!editor.parts) return;
  document.getElementById("partPrev").addEventListener("click", () => switchPart(editor.partIndex - 1));
  document.getElementById("partNext").addEventListener("click", () => switchPart(editor.partIndex + 1));
  document.addEventListener("keydown", (event) => {
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (event.key === "[") switchPart(editor.partIndex - 1);
    if (event.key === "]") switchPart(editor.partIndex + 1);
  });
  // Cropping one part would leave it a different width from the rest.
  const crop = document.querySelector('[data-tool="crop"]');
  if (crop) crop.hidden = true;

  syncPartNav();
}

// One image small enough to open anywhere: every part stacked and scaled to
// fit a single canvas. Used for the split capture's "One image that opens
// anywhere" and "Smaller file" downloads.
async function shrunkWholePage(sources) {
  const width = Math.max(...editor.parts.map((part) => part.width));
  const total = editor.parts.reduce((sum, part) => sum + part.height, 0);
  const scale = Math.min(1, (FpsGeometry.MAX_CANVAS_SIDE - 4) / total, Math.sqrt(FpsGeometry.MAX_CANVAS_PIXELS / (width * total)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(total * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  let y = 0;
  for (const source of sources) {
    const image = source instanceof Blob ? await createImageBitmap(source) : source;
    const height = Math.round(image.height * scale);
    ctx.drawImage(image, 0, y, Math.round(image.width * scale), height);
    y += height;
    if (source instanceof Blob) image.close();
  }
  return canvas;
}

// A button that opens a menu below it. The menu closes on a click outside
// `container`, on Escape, and when the returned function is called.
function setupMenu(toggle, menu, container) {
  const setOpen = (open) => {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button[role='menuitem']")?.focus();
  };
  toggle.addEventListener("click", () => setOpen(menu.hidden));
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !container.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  return setOpen;
}

// The Export menu names each file by what it is for. Choices that only make
// sense for a capture saved in parts appear only then. Copy, beside it, is the
// one primary action; upload is here and never the default.
function setupDownloadMenu(baseName) {
  const toggle = document.getElementById("downloadToggle");
  const menu = document.getElementById("downloadMenu");
  const split = !!editor.parts;

  document.getElementById("downloadSplit").hidden = !split;
  if (split) {
    document.getElementById("pngSub").textContent = "One tall image, best quality";
    document.getElementById("jpegSub").textContent = "Smaller file, shrunk to fit";
    document.getElementById("pdfSub").textContent = "One page per part";
    document.getElementById("zipSub").textContent = `Zip of ${editor.parts.length} PNGs`;
  }
  syncJpegLabel();

  const setOpen = setupMenu(toggle, menu, document.getElementById("download"));
  menu.querySelector("#upload").addEventListener("click", () => setOpen(false));

  const width = split ? Math.max(...editor.parts.map((part) => part.width)) : 0;
  const actions = {
    png: async () => {
      if (!split) return document.getElementById("downloadPng").click();
      downloadBlob(await FpsExport.stackToPng(await partSources(), width), `${baseName}.png`);
    },
    jpeg: async () => {
      if (!split) return document.getElementById("downloadJpeg").click();
      // A JPEG cannot be taller than 65,535px, so the whole page is shrunk.
      const canvas = await shrunkWholePage(await partSources());
      downloadBlob(await canvasToBlob(makeJpegCanvas(canvas), "image/jpeg", editor.jpegQuality), `${baseName}.jpg`);
    },
    pdf: async () => {
      if (!split) return document.getElementById("downloadPdf").click();
      const pages = [];
      for (const source of await partSources()) {
        const canvas = source instanceof Blob ? await blobToCanvas(source) : source;
        const jpeg = await canvasToBlob(makeJpegCanvas(canvas), "image/jpeg", editor.jpegQuality);
        pages.push({ jpegBytes: new Uint8Array(await jpeg.arrayBuffer()), width: canvas.width, height: canvas.height });
      }
      downloadBlob(makePdfPages(pages), `${baseName}.pdf`);
    },
    zip: async () => {
      const files = [];
      const sources = await partSources();
      for (let i = 0; i < sources.length; i++) {
        const blob = sources[i] instanceof Blob ? sources[i] : await canvasToBlob(sources[i], "image/png");
        files.push({ name: `${baseName}-part-${i + 1}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      downloadBlob(new Blob(FpsExport.zipStore(files), { type: "application/zip" }), `${baseName}.zip`);
    },
    smaller: async () => {
      const canvas = await shrunkWholePage(await partSources());
      downloadBlob(await canvasToBlob(canvas, "image/png"), `${baseName}-smaller.png`);
    },
    // The current part, with the presentation layout, as the editor shows it.
    part: () => document.getElementById("downloadPng").click(),
  };

  const run = async (kind) => {
    setOpen(false);
    finalizeStyleEdit();
    if (editor.activeTextInput) editor.activeTextInput.finish(true);
    if (!split || kind === "part") return actions[kind]();
    showExportStatus("Preparing...");
    try {
      await actions[kind]();
      showExportStatus("Downloaded", "done");
    } catch (err) {
      console.error("Export failed:", err);
      showExportStatus("Export failed", "error");
    }
  };
  for (const item of menu.querySelectorAll("[data-download]")) {
    item.addEventListener("click", () => run(item.dataset.download));
  }
}

function syncJpegLabel() {
  const part = document.getElementById("partSub");
  if (part && editor.parts) part.textContent = `Part ${editor.partIndex + 1}, PNG`;
}

async function blobToCanvas(blob) {
  const image = await loadFrameImage({ blob });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

// A split capture keeps an annotated render per part (outKey) only for parts
// that have annotations, so the history page's download includes them.
async function saveRenderedPartToHistory() {
  if (!editor.parts || !editor.historyReady) return;
  const { history = [] } = await chrome.storage.local.get("history");
  const index = findHistoryIndex(history);
  if (index < 0) return;
  const entry = history[index];
  const id = entry.id || editor.historyId || FpsImages.newId();
  const parts = (entry.parts || editor.parts).map((part) => ({ ...part }));
  const part = parts[editor.partIndex];
  if (editor.operations.length) {
    part.outKey = `out:${id}:${editor.partIndex}`;
    await FpsImages.put(part.outKey, await canvasToBlob(renderAnnotatedCanvas(), "image/png"));
  } else if (part.outKey) {
    await FpsImages.remove(part.outKey);
    delete part.outKey;
  }
  const thumbKey = `thumb:${id}`;
  if (editor.partIndex === 0) {
    const shown = part.outKey ? await FpsImages.get(part.outKey) : await FpsImages.get(part.imageKey);
    if (shown) await FpsImages.put(thumbKey, await FpsImages.makeThumbnail(shown));
  }
  editor.parts = parts;
  const { history: latest = [] } = await chrome.storage.local.get("history");
  const at = latest.findIndex((item) => item.id === entry.id && item.baseName === entry.baseName);
  if (at < 0) return;
  latest[at] = {
    ...latest[at],
    id,
    parts,
    imageKey: parts[0].outKey || parts[0].imageKey,
    thumbKey,
    project: cloneProject(),
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ history: latest });
}

function ensureOperationId(operation) {
  if (!operation.id) operation.id = editor.nextOperationId++;
  return operation;
}

function findOperationIndexById(id) {
  return editor.operations.findIndex((operation) => operation.id === id);
}

// The selected annotation's style becomes the current one, as it always has:
// what the panel shows is what the next annotation gets.
function loadOperationStyle(operation) {
  if (!operation) return;
  const group = toolGroup(operation.type);
  const style = editor.style;
  if (group === "hide") {
    if (operation.type !== "redact" && operation.strokeWidth) style.strength = operation.strokeWidth;
    editor.hideMethod = operation.type;
  } else {
    if (operation.color) style.color = operation.color;
    if (["arrow", "rect", "pen"].includes(group) && operation.strokeWidth) style.strokeWidth = operation.strokeWidth;
    if (group === "text") {
      if (operation.textSize) style.textSize = operation.textSize;
      style.textBackground = !!operation.background;
    }
  }
  syncStyleControls();
  syncStyleControlVisibility();
}

function commitUndoAction(action) {
  if (!action) return;
  editor.undoStack.push(action);
  editor.redoStack = [];
  syncEditActionState();
}

function applyUndoAction(action) {
  if (action.type === "add") {
    const index = findOperationIndexById(action.operation.id);
    if (index >= 0) editor.operations.splice(index, 1);
    editor.selectedIndex = Math.min(index, editor.operations.length - 1);
  }
  if (action.type === "replace") {
    const index = findOperationIndexById(action.id);
    if (index >= 0) {
      editor.operations[index] = cloneOperation(action.before);
      editor.selectedIndex = index;
    }
  }
  if (action.type === "remove") {
    editor.operations.splice(action.index, 0, cloneOperation(action.operation));
    editor.selectedIndex = action.index;
  }
  if (action.type === "clear") {
    editor.operations = action.operations.map(cloneOperation);
    editor.selectedIndex = editor.operations.length - 1;
  }
}

function applyRedoAction(action) {
  if (action.type === "add") {
    editor.operations.push(cloneOperation(action.operation));
    editor.selectedIndex = editor.operations.length - 1;
  }
  if (action.type === "replace") {
    const index = findOperationIndexById(action.id);
    if (index >= 0) {
      editor.operations[index] = cloneOperation(action.after);
      editor.selectedIndex = index;
    }
  }
  if (action.type === "remove") {
    const index = findOperationIndexById(action.operation.id);
    if (index >= 0) editor.operations.splice(index, 1);
    editor.selectedIndex = Math.min(index, editor.operations.length - 1);
  }
  if (action.type === "clear") {
    editor.operations = [];
    editor.selectedIndex = -1;
  }
}

function syncAfterHistoryChange(baseName) {
  redraw();
  syncEditActionState();
  const selected = editor.operations[editor.selectedIndex];
  if (selected) loadOperationStyle(selected);
  syncStyleControlVisibility();
  scheduleExportRefresh(baseName);
}

function pushOperation(operation, baseName = editor.baseName) {
  ensureOperationId(operation);
  editor.operations.push(operation);
  editor.selectedIndex = editor.operations.length - 1;
  commitUndoAction({ type: "add", operation: cloneOperation(operation) });
  redraw();
  syncEditActionState();
  syncStyleControlVisibility();
  scheduleExportRefresh(baseName);
}

// One more than the highest step placed since the last "Restart at 1".
function nextStepNumber() {
  return (
    editor.operations
      .filter((operation) => operation.type === "step" && (operation.id || 0) >= editor.stepRestartId)
      .reduce((max, operation) => Math.max(max, operation.number || 0), 0) + 1
  );
}

// The space a label background adds around its text.
function textPadding(operation, textSize = operation.textSize) {
  return operation.background ? { x: textSize * 0.4, y: textSize * 0.22 } : { x: 0, y: 0 };
}

function measureText(operation) {
  const ctx = editor.ctx || document.createElement("canvas").getContext("2d");
  const lines = operation.text.split("\n");
  ctx.save();
  ctx.font = `700 ${operation.textSize}px system-ui, sans-serif`;
  const width = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
  ctx.restore();
  return { width, height: operation.textSize * 1.22 * lines.length };
}

function textBounds(operation) {
  const { width, height } = measureText(operation);
  const pad = textPadding(operation);
  return {
    x: operation.point.x - pad.x,
    y: operation.point.y - pad.y,
    width: width + pad.x * 2,
    height: height + pad.y * 2,
  };
}

function operationBounds(operation) {
  if (operation.type === "arrow") {
    const pad = Math.max(12, operation.strokeWidth * 4);
    const x = Math.min(operation.from.x, operation.to.x) - pad;
    const y = Math.min(operation.from.y, operation.to.y) - pad;
    return {
      x,
      y,
      width: Math.abs(operation.to.x - operation.from.x) + pad * 2,
      height: Math.abs(operation.to.y - operation.from.y) + pad * 2,
    };
  }
  if (operation.rect) return { ...operation.rect };
  if (operation.type === "pen") {
    const xs = operation.points.map((point) => point.x);
    const ys = operation.points.map((point) => point.y);
    const pad = Math.max(6, operation.strokeWidth);
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return {
      x,
      y,
      width: Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2),
    };
  }
  if (operation.type === "text") return textBounds(operation);
  if (operation.type === "step") {
    const radius = stepRadius(operation) + stepRing(operation);
    return {
      x: operation.point.x - radius,
      y: operation.point.y - radius,
      width: radius * 2,
      height: radius * 2,
    };
  }
  if (operation.type === "blur") return { ...operation.rect };
  return { x: 0, y: 0, width: 0, height: 0 };
}

function containsPoint(rect, point, padding = 0) {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

/* -------------------- on-screen tool UI (screen space) ------------------- */

// Selection outlines, handles, chips and the crop frame are drawn on an
// overlay over the canvas area at a fixed on-screen size, whatever the zoom.
// Annotations themselves stay on the editor canvas and scale with the image.

const OUTLINE_GAP = 3; // px between a shape and its selection outline
const HANDLE_HIT = 10; // half of the 20px hit area around every handle

// Image coordinates to and from viewport (client) coordinates.
function clientMapper() {
  const rect = editor.canvas.getBoundingClientRect();
  const scale = rect.width / editor.baseCanvas.width || 1;
  return {
    scale,
    rect,
    x: (x) => rect.left + x * scale,
    y: (y) => rect.top + y * scale,
  };
}

// Base-image pixels per CSS pixel at the current zoom.
function cssPixel() {
  const width = editor.canvas.getBoundingClientRect().width || editor.baseCanvas.width;
  return editor.baseCanvas.width / width;
}

function stepRing(operation) {
  return Math.max(2, stepRadius(operation) * 0.1);
}

function stepRadius(operation) {
  return operation.radius || Math.max(36, operation.textSize * 1.24);
}

// The area a shape visibly covers, for its outline.
function visualBounds(operation) {
  if (operation.type === "rect") {
    const half = operation.strokeWidth / 2;
    const { x, y, width, height } = operation.rect;
    return { x: x - half, y: y - half, width: width + half * 2, height: height + half * 2 };
  }
  if (operation.type === "pen") {
    const xs = operation.points.map((point) => point.x);
    const ys = operation.points.map((point) => point.y);
    const half = operation.strokeWidth / 2;
    return {
      x: Math.min(...xs) - half,
      y: Math.min(...ys) - half,
      width: Math.max(...xs) - Math.min(...xs) + half * 2,
      height: Math.max(...ys) - Math.min(...ys) + half * 2,
    };
  }
  return operationBounds(operation);
}

// What a selected annotation shows, in client coordinates: an outline box,
// a ring (steps), and its handles. Boxes and hidden areas get eight handles;
// pen strokes and text four; arrows only their two ends; a step one round
// handle beside its ring, flipped to the top-left near the screen's edge.
function selectionGeometry(operation) {
  const m = clientMapper();
  if (operation.type === "arrow") {
    return {
      handles: [
        { name: "from", x: m.x(operation.from.x), y: m.y(operation.from.y), round: true },
        { name: "to", x: m.x(operation.to.x), y: m.y(operation.to.y), round: true },
      ],
    };
  }
  if (operation.type === "step") {
    const cx = m.x(operation.point.x);
    const cy = m.y(operation.point.y);
    const ring = (stepRadius(operation) + stepRing(operation)) * m.scale + 2;
    const reach = (ring + 7) * Math.SQRT1_2;
    const area = document.querySelector(".canvas-area").getBoundingClientRect();
    const flip = cx + reach + HANDLE_HIT > area.right || cy + reach + HANDLE_HIT > area.bottom;
    return {
      ring: { cx, cy, r: ring + 0.5 },
      handles: [
        flip
          ? { name: "step-nw", x: cx - reach, y: cy - reach, round: true }
          : { name: "step-se", x: cx + reach, y: cy + reach, round: true },
      ],
    };
  }
  const b = visualBounds(operation);
  // Whole pixels, so the 1px line and its halo stay crisp.
  const x0 = Math.floor(m.x(b.x) - OUTLINE_GAP);
  const y0 = Math.floor(m.y(b.y) - OUTLINE_GAP);
  const box = {
    x: x0,
    y: y0,
    width: Math.ceil(m.x(b.x + b.width) + OUTLINE_GAP) - x0,
    height: Math.ceil(m.y(b.y + b.height) + OUTLINE_GAP) - y0,
  };
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const midX = left + box.width / 2;
  const midY = top + box.height / 2;
  const handles = [
    { name: "nw", x: left, y: top },
    { name: "ne", x: right, y: top },
    { name: "se", x: right, y: bottom },
    { name: "sw", x: left, y: bottom },
  ];
  if (operation.type === "rect" || HIDE_TYPES.includes(operation.type)) {
    handles.push(
      { name: "n", x: midX, y: top },
      { name: "e", x: right, y: midY },
      { name: "s", x: midX, y: bottom },
      { name: "w", x: left, y: midY }
    );
  }
  return { box, handles };
}

// The handle of `operation` under the pointer, by its 20 × 20px hit area.
function handleAtClient(operation, clientX, clientY) {
  return selectionGeometry(operation).handles.find(
    (handle) => Math.abs(handle.x - clientX) <= HANDLE_HIT && Math.abs(handle.y - clientY) <= HANDLE_HIT
  );
}

function operationAtPoint(point) {
  for (let i = editor.operations.length - 1; i >= 0; i--) {
    if (containsPoint(operationBounds(editor.operations[i]), point, 8)) return i;
  }
  return -1;
}

// 1px dark line with a 2px white halo outside it: visible on any page.
function strokeOutline(ctx, box) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
  ctx.restore();
}

function drawOverlayHandle(ctx, handle) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (handle.round) {
    ctx.arc(handle.x, handle.y, 4.5, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, handle.x - 3.5, handle.y - 3.5, 7, 7, 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// A small dark label, e.g. "Blur · 8" or the crop size.
function drawChip(ctx, text, x, y, { mono = false } = {}) {
  ctx.save();
  ctx.font = mono ? "11px ui-monospace, 'SF Mono', Menlo, monospace" : "500 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const width = Math.ceil(ctx.measureText(text).width) + 12;
  ctx.fillStyle = "#1c1c1c";
  roundRectPath(ctx, x, y, width, 20, 4);
  ctx.fill();
  ctx.fillStyle = "#ededed";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 6, y + 10.5);
  ctx.restore();
  return width;
}

function drawSelectionOverlay(ctx, operation, { handles = true } = {}) {
  const geometry = selectionGeometry(operation);
  if (geometry.box) strokeOutline(ctx, geometry.box);
  if (geometry.ring) {
    const { cx, cy, r } = geometry.ring;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#111111";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (operation.type === "blur" && geometry.box && handles) {
    drawChip(ctx, `Blur · ${operation.strokeWidth}`, geometry.box.x + OUTLINE_GAP, geometry.box.y - 8 - 20);
  }
  if (handles) geometry.handles.forEach((handle) => drawOverlayHandle(ctx, handle));
}

// The pending crop: outside dimmed, a white frame with corner brackets and
// edge bars, and its size in image pixels above it.
function drawCropOverlayScreen(ctx, m) {
  const rect = editor.cropDraft;
  if (!rect) return;
  const image = { x: m.x(0), y: m.y(0), width: editor.baseCanvas.width * m.scale, height: editor.baseCanvas.height * m.scale };
  const x = m.x(rect.x);
  const y = m.y(rect.y);
  const w = rect.width * m.scale;
  const h = rect.height * m.scale;
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.rect(image.x, image.y, image.width, image.height);
  ctx.rect(x, y, w, h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

  ctx.fillStyle = "#ffffff";
  const L = 16;
  const T = 3;
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) {
    const ox = sx > 0 ? cx - T : cx - L + T;
    const oy = sy > 0 ? cy - T : cy - L + T;
    ctx.fillRect(ox, sy > 0 ? cy - T : cy, L, T);
    ctx.fillRect(sx > 0 ? cx - T : cx, oy, T, L);
  }
  for (const [bx, by, bw, bh] of [[x + w / 2 - 6, y - 2, 12, 4], [x + w / 2 - 6, y + h - 2, 12, 4], [x - 2, y + h / 2 - 6, 4, 12], [x + w - 2, y + h / 2 - 6, 4, 12]]) {
    roundRectPath(ctx, bx, by, bw, bh, 1);
    ctx.fill();
  }
  ctx.restore();

  const label = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  const area = document.querySelector(".canvas-area").getBoundingClientRect();
  const chipY = y - 8 - 20 >= area.top + 4 ? y - 8 - 20 : y + 8;
  drawChip(ctx, label, x + (chipY > y ? 8 : 0), chipY, { mono: true });
}

// Redraws the overlay for the current state. Cheap: it only strokes a few
// shapes, so it runs on every redraw, scroll and zoom.
function renderOverlay() {
  const overlay = document.getElementById("overlayCanvas");
  if (!overlay || !editor.canvas || !editor.baseCanvas) return;
  const area = overlay.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(area.width * dpr);
  const height = Math.round(area.height * dpr);
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  const ctx = overlay.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // Client coordinates, so geometry from getBoundingClientRect draws as is.
  ctx.setTransform(dpr, 0, 0, dpr, -area.left * dpr, -area.top * dpr);
  const stage = document.getElementById("stage").getBoundingClientRect();
  ctx.save();
  ctx.beginPath();
  ctx.rect(stage.left, stage.top, stage.width, stage.height);
  ctx.clip();

  const m = clientMapper();
  if (editor.currentTool === "crop") drawCropOverlayScreen(ctx, m);

  // While something is being moved, resized or drawn its handles hide and
  // only the outline stays.
  const busy = !!(editor.interaction || editor.draft);
  const draft = editor.draft;
  if (draft && draft.type !== "arrow" && draft.type !== "pen" && operationIsLargeEnough(draft)) {
    drawSelectionOverlay(ctx, draft, { handles: false });
  }
  if (editor.textDraft?.text) drawSelectionOverlay(ctx, editor.textDraft, { handles: false });
  const selected = editor.operations[editor.selectedIndex];
  if (selected && editor.currentTool !== "crop") drawSelectionOverlay(ctx, selected, { handles: !busy });
  ctx.restore();
}

function moveOperation(operation, dx, dy) {
  if (operation.from) {
    operation.from.x += dx;
    operation.from.y += dy;
    operation.to.x += dx;
    operation.to.y += dy;
  }
  if (operation.rect) {
    operation.rect.x += dx;
    operation.rect.y += dy;
  }
  if (operation.points) {
    operation.points.forEach((point) => {
      point.x += dx;
      point.y += dy;
    });
  }
  if (operation.point) {
    operation.point.x += dx;
    operation.point.y += dy;
  }
}

function scalePoint(point, fromBounds, toBounds) {
  const rx = fromBounds.width ? (point.x - fromBounds.x) / fromBounds.width : 0;
  const ry = fromBounds.height ? (point.y - fromBounds.y) / fromBounds.height : 0;
  point.x = toBounds.x + rx * toBounds.width;
  point.y = toBounds.y + ry * toBounds.height;
}

// `startBounds` with `handle` (a corner or edge name) moved to `point`.
function resizeBounds(startBounds, handle, point) {
  const left = handle.includes("w") ? point.x : startBounds.x;
  const right = handle.includes("e") ? point.x : startBounds.x + startBounds.width;
  const top = handle.includes("n") ? point.y : startBounds.y;
  const bottom = handle.includes("s") ? point.y : startBounds.y + startBounds.height;
  const normalized = normalizeRect({ x: left, y: top }, { x: right, y: bottom });
  return {
    x: normalized.x,
    y: normalized.y,
    width: Math.max(4, normalized.width),
    height: Math.max(4, normalized.height),
  };
}

// Where a handle sits on the shape's own bounds, in image coordinates. A drag
// moves that point by the pointer's travel, so grabbing a handle that sits a
// few pixels outside the shape doesn't make it jump.
function handleAnchor(operation, bounds, handle) {
  if (handle === "from") return { ...operation.from };
  if (handle === "to") return { ...operation.to };
  return {
    x: handle.includes("w") ? bounds.x : handle.includes("e") ? bounds.x + bounds.width : bounds.x + bounds.width / 2,
    y: handle.includes("n") ? bounds.y : handle.includes("s") ? bounds.y + bounds.height : bounds.y + bounds.height / 2,
  };
}

function resizeOperation(operation, startOperation, startBounds, handle, point, delta) {
  if (operation.type === "arrow") {
    if (handle === "from") operation.from = { ...point };
    if (handle === "to") operation.to = { ...point };
    return;
  }
  if (operation.type === "step") {
    // The one handle sits on the diagonal; travel along it grows the marker.
    const along = (delta.x + delta.y) / 2;
    const start = stepRadius(startOperation);
    operation.radius = Math.max(18, handle === "step-nw" ? start - along : start + along);
    return;
  }

  const nextBounds = resizeBounds(startBounds, handle, point);
  if (operation.rect) {
    operation.rect = nextBounds;
    return;
  }
  if (operation.type === "pen") {
    operation.points = startOperation.points.map((item) => {
      const pointCopy = { ...item };
      scalePoint(pointCopy, startBounds, nextBounds);
      return pointCopy;
    });
    return;
  }
  if (operation.type === "text") {
    const scale = Math.max(
      nextBounds.width / Math.max(1, startBounds.width),
      nextBounds.height / Math.max(1, startBounds.height)
    );
    operation.textSize = Math.max(8, Math.round(startOperation.textSize * scale));
    const pad = textPadding(operation);
    operation.point = { x: nextBounds.x + pad.x, y: nextBounds.y + pad.y };
  }
}

function applyAnnotationShadow(ctx, size = 6) {
  ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
  ctx.shadowBlur = Math.max(2, size * 0.45);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.max(1, size * 0.18);
}

function clearAnnotationShadow(ctx) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// A shaft ending at the base of a filled triangular head, drawn as one shape
// so its shadow doesn't double where they meet. The head is at least 14px and
// four times the stroke width long, and 0.85 times as wide as it is long.
function drawArrow(ctx, operation) {
  const { from, to, color, strokeWidth } = operation;
  const arrowLength = Math.hypot(to.x - from.x, to.y - from.y);
  if (arrowLength < 1) return;

  const shaftWidth = Math.max(2, strokeWidth);
  const headLength = Math.min(arrowLength * 0.75, Math.max(14, shaftWidth * 4));
  const headHalf = (headLength * 0.85) / 2;
  const unitX = (to.x - from.x) / arrowLength;
  const unitY = (to.y - from.y) / arrowLength;
  const perpX = -unitY;
  const perpY = unitX;
  const half = shaftWidth / 2;
  const base = { x: to.x - unitX * headLength, y: to.y - unitY * headLength };
  // The shaft runs a little into the head so no seam shows at the base.
  const neck = { x: base.x + unitX * half, y: base.y + unitY * half };
  const angle = Math.atan2(unitY, unitX);

  ctx.save();
  ctx.fillStyle = color;
  applyAnnotationShadow(ctx, shaftWidth);
  ctx.beginPath();
  ctx.moveTo(from.x + perpX * half, from.y + perpY * half);
  ctx.lineTo(neck.x + perpX * half, neck.y + perpY * half);
  ctx.lineTo(neck.x - perpX * half, neck.y - perpY * half);
  ctx.lineTo(from.x - perpX * half, from.y - perpY * half);
  ctx.arc(from.x, from.y, half, angle + Math.PI / 2, angle - Math.PI / 2);
  ctx.closePath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(base.x + perpX * headHalf, base.y + perpY * headHalf);
  ctx.lineTo(base.x - perpX * headHalf, base.y - perpY * headHalf);
  ctx.closePath();
  ctx.fill("nonzero");
  ctx.restore();
}

function drawRect(ctx, operation) {
  const { rect, color, strokeWidth } = operation;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
  applyAnnotationShadow(ctx, strokeWidth);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawPen(ctx, operation) {
  if (operation.points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = operation.color;
  ctx.lineWidth = operation.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  applyAnnotationShadow(ctx, operation.strokeWidth);
  ctx.beginPath();
  ctx.moveTo(operation.points[0].x, operation.points[0].y);
  for (const point of operation.points.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, operation) {
  const lines = operation.text.split("\n");
  const lineHeight = operation.textSize * 1.22;

  ctx.save();
  ctx.font = `700 ${operation.textSize}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  if (operation.background) {
    // A label: the text on a solid box, dark or light against its colour.
    const bounds = textBounds(operation);
    applyAnnotationShadow(ctx, operation.textSize * 0.35);
    ctx.fillStyle = isLightColor(operation.color) ? "#111318" : "#ffffff";
    roundRectPath(ctx, bounds.x, bounds.y, bounds.width, bounds.height, operation.textSize * 0.25);
    ctx.fill();
    clearAnnotationShadow(ctx);
    ctx.fillStyle = operation.color;
    lines.forEach((line, index) => ctx.fillText(line, operation.point.x, operation.point.y + index * lineHeight));
    ctx.restore();
    return;
  }
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = Math.max(1, operation.strokeWidth);
  ctx.fillStyle = operation.color;
  applyAnnotationShadow(ctx, operation.textSize * 0.35);
  lines.forEach((line, index) => {
    const y = operation.point.y + index * lineHeight;
    ctx.strokeText(line, operation.point.x, y);
    ctx.fillText(line, operation.point.x, y);
  });
  ctx.restore();
}

// A filled circle with its number, inside a white ring that keeps it readable
// on dark pages. The ring scales with the marker.
function drawStep(ctx, operation) {
  const radius = stepRadius(operation);
  const ring = stepRing(operation);

  ctx.save();
  ctx.fillStyle = "#fff";
  applyAnnotationShadow(ctx, radius * 0.35);
  ctx.beginPath();
  ctx.arc(operation.point.x, operation.point.y, radius + ring, 0, Math.PI * 2);
  ctx.fill();
  clearAnnotationShadow(ctx);
  ctx.fillStyle = operation.color;
  ctx.beginPath();
  ctx.arc(operation.point.x, operation.point.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = `800 ${Math.max(14, radius * 0.95)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(operation.number), operation.point.x, operation.point.y + 1);
  ctx.restore();
}

function applyPixelate(ctx, operation) {
  const { rect, strokeWidth } = operation;
  if (rect.width < 2 || rect.height < 2) return;

  const blockSize = Math.max(6, strokeWidth * 4);
  const sampleWidth = Math.max(1, Math.round(rect.width / blockSize));
  const sampleHeight = Math.max(1, Math.round(rect.height / blockSize));
  const temp = document.createElement("canvas");
  temp.width = sampleWidth;
  temp.height = sampleHeight;
  const tempCtx = temp.getContext("2d");
  tempCtx.drawImage(
    ctx.canvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    temp.width,
    temp.height
  );

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(temp, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawPixelatedBaseRegion(ctx, operation) {
  const { rect, strokeWidth } = operation;
  if (!editor.baseCanvas || rect.width < 2 || rect.height < 2) return;

  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(editor.baseCanvas.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(editor.baseCanvas.height, Math.ceil(rect.y + rect.height));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  const blockSize = Math.max(6, strokeWidth * 4);
  const sampleWidth = Math.max(1, Math.round(width / blockSize));
  const sampleHeight = Math.max(1, Math.round(height / blockSize));
  const temp = document.createElement("canvas");
  temp.width = sampleWidth;
  temp.height = sampleHeight;
  const tempCtx = temp.getContext("2d");
  tempCtx.drawImage(editor.baseCanvas, x, y, width, height, 0, 0, sampleWidth, sampleHeight);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(temp, x, y, width, height);
  ctx.restore();
}

// The real blur, in the editor as in the export, from the image under it.
// Blurring a large area takes a while, so each area's result is kept until
// it moves, resizes, changes strength or the image changes.
const blurCache = new Map();

function drawBlurredBaseRegion(ctx, operation) {
  const { rect } = operation;
  if (!editor.baseCanvas || rect.width < 2 || rect.height < 2) return;
  const blur = Math.max(2, operation.strokeWidth);
  const key = [rect.x, rect.y, rect.width, rect.height, blur].map((n) => Math.round(n)).join(",");
  let entry = operation.id ? blurCache.get(operation.id) : null;
  if (!entry || entry.key !== key || entry.base !== editor.baseCanvas) {
    const pad = Math.ceil(blur * 3);
    const x = Math.max(0, Math.floor(rect.x - pad));
    const y = Math.max(0, Math.floor(rect.y - pad));
    const right = Math.min(editor.baseCanvas.width, Math.ceil(rect.x + rect.width + pad));
    const bottom = Math.min(editor.baseCanvas.height, Math.ceil(rect.y + rect.height + pad));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, right - x);
    canvas.height = Math.max(1, bottom - y);
    const blurred = canvas.getContext("2d");
    blurred.filter = `blur(${blur}px)`;
    blurred.drawImage(editor.baseCanvas, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    entry = { key, base: editor.baseCanvas, canvas, x, y };
    if (operation.id) blurCache.set(operation.id, entry);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.drawImage(entry.canvas, entry.x, entry.y);
  ctx.restore();
}

// While a blur area is drawn, moved or resized: a light fill, blurred on
// release.
function drawBlurPreview(ctx, operation) {
  const { rect } = operation;
  ctx.save();
  ctx.fillStyle = "rgba(144, 151, 161, 0.35)";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function applyBlur(ctx, operation) {
  const { rect, strokeWidth } = operation;
  if (rect.width < 2 || rect.height < 2) return;

  const blur = Math.max(2, strokeWidth);
  const pad = Math.ceil(blur * 3);
  const sx = Math.max(0, Math.floor(rect.x - pad));
  const sy = Math.max(0, Math.floor(rect.y - pad));
  const right = Math.min(ctx.canvas.width, Math.ceil(rect.x + rect.width + pad));
  const bottom = Math.min(ctx.canvas.height, Math.ceil(rect.y + rect.height + pad));
  const sw = Math.max(1, right - sx);
  const sh = Math.max(1, bottom - sy);
  const temp = document.createElement("canvas");
  temp.width = sw;
  temp.height = sh;
  temp.getContext("2d").drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(temp, sx, sy);
  ctx.restore();
}

function applyRedact(ctx, operation) {
  const { rect } = operation;
  ctx.save();
  ctx.fillStyle = "#050507";
  applyAnnotationShadow(ctx, Math.max(6, Math.min(rect.width, rect.height) * 0.12));
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawPreview(ctx, operation) {
  if (operation.type === "pixelate") {
    drawPixelatedBaseRegion(ctx, operation);
    return;
  }
  if (operation.type === "redact") {
    applyRedact(ctx, operation);
    return;
  }
  if (operation.type === "blur") {
    drawBlurPreview(ctx, operation);
    return;
  }
  applyOperation(ctx, operation);
}

function cropHandles(rect) {
  const { x, y, width: w, height: h } = rect;
  return [
    { edge: "nw", x, y },
    { edge: "n", x: x + w / 2, y },
    { edge: "ne", x: x + w, y },
    { edge: "e", x: x + w, y: y + h / 2 },
    { edge: "se", x: x + w, y: y + h },
    { edge: "s", x: x + w / 2, y: y + h },
    { edge: "sw", x, y: y + h },
    { edge: "w", x, y: y + h / 2 },
  ];
}

function applyOperation(ctx, operation) {
  if (operation.type === "arrow") drawArrow(ctx, operation);
  if (operation.type === "rect") drawRect(ctx, operation);
  if (operation.type === "pen") drawPen(ctx, operation);
  if (operation.type === "text") drawText(ctx, operation);
  if (operation.type === "step") drawStep(ctx, operation);
  if (operation.type === "blur") applyBlur(ctx, operation);
  if (operation.type === "pixelate") applyPixelate(ctx, operation);
  if (operation.type === "redact") applyRedact(ctx, operation);
}

function drawEditorOperation(ctx, operation) {
  if (operation.type === "pixelate") {
    drawPixelatedBaseRegion(ctx, operation);
    return;
  }
  if (operation.type === "blur") {
    const editing =
      editor.interaction && editor.interaction.type !== "crop" && editor.operations[editor.selectedIndex] === operation;
    if (editing) drawBlurPreview(ctx, operation);
    else drawBlurredBaseRegion(ctx, operation);
    return;
  }
  applyOperation(ctx, operation);
}

function redraw(preview = null) {
  if (editor.redrawFrame) {
    cancelAnimationFrame(editor.redrawFrame);
    editor.redrawFrame = 0;
    editor.pendingPreview = null;
  }
  editor.ctx.setTransform(1, 0, 0, 1, 0, 0);
  editor.ctx.clearRect(0, 0, editor.canvas.width, editor.canvas.height);
  editor.ctx.setTransform(editor.previewScale, 0, 0, editor.previewScale, 0, 0);
  for (const operation of editor.operations) {
    drawEditorOperation(editor.ctx, operation);
  }
  if (preview) drawPreview(editor.ctx, preview);
  // The label being typed, in its final colour and size.
  if (editor.textDraft?.text) applyOperation(editor.ctx, editor.textDraft);
  editor.ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderOverlay();
  scheduleNavigatorRender();
}

function makeDragOperation(tool, start, end) {
  const style = currentStyle(tool);
  if (tool === "arrow") {
    return { type: "arrow", from: start, to: end, ...style };
  }
  if (tool === "hide") {
    const type = editor.hideMethod;
    const rect = normalizeRect(start, end);
    return type === "redact" ? { type, rect, ...style, color: "#111111" } : { type, rect, ...style };
  }
  if (tool === "rect") {
    return { type: tool, rect: normalizeRect(start, end), ...style };
  }
  return null;
}

function operationIsLargeEnough(operation) {
  if (operation.type === "arrow") {
    return Math.hypot(operation.to.x - operation.from.x, operation.to.y - operation.from.y) > 8;
  }
  if (operation.type === "pen") return operation.points.length > 1;
  if (operation.rect) return operation.rect.width > 6 && operation.rect.height > 6;
  return true;
}

function cropToRect(rect, baseName = editor.baseName) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.min(editor.baseCanvas.width - x, Math.round(rect.width));
  const height = Math.min(editor.baseCanvas.height - y, Math.round(rect.height));
  if (width < 8 || height < 8) {
    redraw();
    return;
  }

  const cropped = document.createElement("canvas");
  cropped.width = width;
  cropped.height = height;
  cropped.getContext("2d").drawImage(editor.baseCanvas, x, y, width, height, 0, 0, width, height);
  editor.baseCanvas = cropped;
  syncDisplayCanvases();
  setCanvasCssWidth(editor.baseDisplayCanvas, 0);
  setCanvasCssWidth(editor.canvas, 0);
  editor.operations.forEach((operation) => moveOperation(operation, -x, -y));
  editor.selectedIndex = -1;
  syncMeta();
  redraw();
  applyZoom(fitZoom(), "fit");
  markExportsStale(baseName);
}

// A short line in the top bar for exports that take a moment: preparing,
// done, failed. Done and failed fade on their own.
function showExportStatus(text, state = "pending") {
  const status = document.getElementById("exportStatus");
  if (!status) return;

  clearTimeout(editor.exportStatusTimer);
  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("error", state === "error");
  if (state === "done" || state === "error") {
    editor.exportStatusTimer = setTimeout(() => {
      status.hidden = true;
      status.classList.remove("error");
    }, state === "error" ? 4000 : 1600);
  }
}

function scheduleExportRefresh(baseName) {
  markExportsStale(baseName);
}

const COPY_ICONS = {
  copy: "M8 8h12v12H8zM4 16V4h12",
  check: "M5 12l5 5L20 7",
};

// The Copy button's icon and label; "check" after a successful copy.
function setButtonLabel(button, icon, text) {
  button.textContent = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, String(value));
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", COPY_ICONS[icon] || COPY_ICONS.copy);
  svg.appendChild(path);
  const label = document.createElement("span");
  label.textContent = text;
  button.append(svg, label);
}

function syncEditActionState() {
  const undo = document.getElementById("undo");
  const redo = document.getElementById("redo");
  const clear = document.getElementById("clear");
  if (!undo || !redo || !clear) return;

  undo.disabled = editor.undoStack.length === 0;
  redo.disabled = editor.redoStack.length === 0;
  clear.disabled = editor.operations.length === 0;
  syncMeta();
  renderAnnotationList();
}

function beginStyleEdit() {
  const operation = editor.operations[editor.selectedIndex];
  if (!operation) return;
  if (editor.pendingStyleEdit?.id === operation.id) return;

  editor.pendingStyleEdit = {
    id: operation.id,
    before: cloneOperation(operation),
  };
}

function finalizeStyleEdit() {
  const pending = editor.pendingStyleEdit;
  if (!pending) return;

  editor.pendingStyleEdit = null;
  const index = findOperationIndexById(pending.id);
  if (index < 0) return;

  const after = cloneOperation(editor.operations[index]);
  if (sameOperation(pending.before, after)) return;
  commitUndoAction({
    type: "replace",
    id: pending.id,
    before: pending.before,
    after,
  });
}

function styleControlTool() {
  return editor.operations[editor.selectedIndex]?.type || editor.currentTool;
}

// The right panel shows only what the current tool (or, in Select, the
// selected annotation) uses. Its header always names the tool.
function syncStyleControlVisibility() {
  const header = TOOLS[editor.currentTool];
  if (!header || !document.getElementById("toolName")) return;
  document.getElementById("toolName").textContent = header.label;
  document.getElementById("toolKey").textContent = header.key;
  document.getElementById("toolHint").textContent = header.hint;

  const tool = editor.currentTool;
  const group = toolGroup(styleControlTool());
  const show = {
    colorSection: ["arrow", "rect", "text", "step", "pen"].includes(group),
    thicknessSection: ["arrow", "rect", "pen"].includes(group),
    textSection: group === "text",
    stepSection: group === "step",
    hideSection: group === "hide",
    cropSection: tool === "crop",
    layersSection: tool === "select",
  };
  for (const [id, visible] of Object.entries(show)) document.getElementById(id).hidden = !visible;
  syncStyleControls();
  syncCropControls();
  renderAnnotationList();
}

// Name and kind for the Select tool's list.
function annotationLabel(operation) {
  const hidden = { blur: "Blur", pixelate: "Pixelate", redact: "Redact" };
  if (hidden[operation.type]) return { name: "Hidden area", kind: hidden[operation.type], color: "#8A8A8A" };
  if (operation.type === "arrow") return { name: "Arrow", kind: "Pointer", color: operation.color };
  if (operation.type === "rect") return { name: "Box", kind: "Outline", color: operation.color };
  if (operation.type === "pen") return { name: "Drawing", kind: "Pen", color: operation.color };
  if (operation.type === "step") return { name: `Step ${operation.number}`, kind: "Step", color: operation.color };
  if (operation.type === "text") {
    const text = operation.text.replace(/\s+/g, " ").trim();
    return { name: text.length > 24 ? `${text.slice(0, 23)}…` : text, kind: "Text", color: operation.color };
  }
  return { name: operation.type, kind: "", color: operation.color };
}

const TRASH_PATH = "M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3";

// Every annotation on the screenshot, in the order it was added. A row
// selects its annotation; the bin deletes it. The handlers live in
// setupAnnotationControls, which sets editor.listActions.
function renderAnnotationList() {
  const list = document.getElementById("layerList");
  if (!list || document.getElementById("layersSection").hidden) return;
  list.textContent = "";
  document.getElementById("layersEmpty").hidden = editor.operations.length > 0;
  editor.operations.forEach((operation, index) => {
    const label = annotationLabel(operation);
    const row = document.createElement("div");
    row.className = "layer";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === editor.selectedIndex));
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "layer-pick";
    const dot = document.createElement("span");
    dot.className = "layer-dot";
    dot.style.background = label.color;
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = label.name;
    const kind = document.createElement("span");
    kind.className = "layer-kind";
    kind.textContent = label.kind;
    pick.append(dot, name, kind);
    pick.addEventListener("click", () => editor.listActions?.select(index));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "layer-delete";
    remove.title = `Delete ${label.name}`;
    remove.setAttribute("aria-label", `Delete ${label.name}`);
    remove.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TRASH_PATH}"></path></svg>`;
    remove.addEventListener("click", () => editor.listActions?.remove(index));
    row.append(pick, remove);
    list.appendChild(row);
  });
}

function syncCropControls() {
  setChecked("[data-crop-aspect]", "cropAspect", editor.cropAspect);
  const apply = document.getElementById("applyCrop");
  if (!apply || !editor.baseCanvas) return;
  const rect = editor.cropDraft;
  const whole =
    !rect ||
    (Math.round(rect.x) <= 0 &&
      Math.round(rect.y) <= 0 &&
      Math.round(rect.width) >= editor.baseCanvas.width &&
      Math.round(rect.height) >= editor.baseCanvas.height);
  apply.disabled = whole;
}

function clampZoom(value) {
  return Math.min(4, Math.max(0.02, value));
}

function layoutCssBackground(background) {
  if (background === "plain") return "#f4f6f8";
  if (background === "dark") return "linear-gradient(135deg, #151922, #343947)";
  if (background === "blue") return "linear-gradient(135deg, #d7f1ff, #7aa7ff)";
  if (background === "sunset") return "linear-gradient(135deg, #ffd7a8, #ff8fb3 55%, #8aa7ff)";
  return "linear-gradient(135deg, #eef3f8, #d5dde8)";
}

function applyLayoutPreview() {
  const shell = document.getElementById("canvasShell");
  if (!shell || !editor.canvas) return;

  updateChromePreview();
  if (!editor.layout.enabled) {
    shell.style.padding = "";
    shell.style.background = "";
    shell.style.boxShadow = "";
    shell.style.borderRadius = "";
    if (editor.baseDisplayCanvas) editor.baseDisplayCanvas.style.borderRadius = "";
    editor.canvas.style.borderRadius = "";
    return;
  }

  const scaledPadding = Math.round(editor.layout.padding * editor.zoom);
  const scaledRadius = Math.round(editor.layout.radius * editor.zoom);
  shell.style.padding = `${scaledPadding}px`;
  shell.style.background = layoutCssBackground(editor.layout.background);
  shell.style.boxShadow =
    editor.layout.shadow > 0
      ? `0 ${Math.round(editor.layout.shadow * editor.zoom * 0.45)}px ${Math.round(
          editor.layout.shadow * editor.zoom
        )}px rgba(0, 0, 0, 0.32)`
      : "none";
  shell.style.borderRadius = `${Math.max(8, scaledRadius + scaledPadding)}px`;
  if (editor.baseDisplayCanvas) editor.baseDisplayCanvas.style.borderRadius = `${scaledRadius}px`;
  editor.canvas.style.borderRadius = `${scaledRadius}px`;
}

// DOM stand-ins for the frame and stamp while editing, so the on-screen
// preview matches what the export will draw.
function updateChromePreview() {
  const stack = document.getElementById("canvasStack") || editor.canvas?.parentElement;
  if (!stack) return;
  let frame = document.getElementById("framePreview");
  if (!frame) {
    frame = document.createElement("div");
    frame.id = "framePreview";
    frame.className = "frame-preview";
    frame.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="address"></span>';
    stack.parentElement.insertBefore(frame, stack);
  }
  let stamp = document.getElementById("stampPreview");
  if (!stamp) {
    stamp = document.createElement("div");
    stamp.id = "stampPreview";
    stamp.className = "stamp-preview";
    stack.appendChild(stamp);
  }

  const theme = editor.layout.enabled ? FRAME_THEMES[editor.layout.frame] : null;
  frame.hidden = !theme;
  if (theme && editor.baseCanvas) {
    const s = chromeScale(editor.baseCanvas.width);
    const cssWidth = editor.canvas.getBoundingClientRect().width || editor.baseCanvas.width * editor.zoom;
    frame.style.width = `${cssWidth}px`;
    // The bar is 40px per density step in the export; scale it to the canvas
    // as it is displayed.
    frame.style.height = `${Math.round((40 * s * cssWidth) / editor.baseCanvas.width)}px`;
    frame.style.background = theme.bar;
    frame.style.color = theme.text;
    frame.classList.toggle("windows", theme.controls === "buttons");
    const dots = frame.querySelector(".dots");
    dots.hidden = theme.controls !== "dots";
    ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
      dots.children[i].style.background = color;
    });
    const address = frame.querySelector(".address");
    address.hidden = !(editor.layout.frameAddress && editor.pageUrl);
    address.style.background = theme.pill;
    address.textContent = editor.pageUrl.replace(/^https?:\/\//, "");
  }

  const text = editor.layout.enabled && editor.layout.stamp !== "none" ? stampText() : "";
  stamp.hidden = !text;
  stamp.textContent = text;
}

function stageInnerSize() {
  const stage = document.getElementById("stage");
  const style = getComputedStyle(stage);
  return {
    width: Math.max(120, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
    height: Math.max(120, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
  };
}

// Fit width: the screenshot as wide as the canvas area, never past 100%.
function fitZoom() {
  if (!editor.canvas) return 1;
  const { width } = stageInnerSize();
  const layoutWidth = editor.layout.enabled ? editor.layout.padding * 2 : 0;
  return clampZoom(Math.min(1, width / (editor.baseCanvas.width + layoutWidth)));
}

// Fit page: the whole screenshot, top to bottom, in view.
function fitPageZoom() {
  if (!editor.canvas) return 1;
  const { width, height } = stageInnerSize();
  const notices = document.getElementById("notices");
  const available = height - (notices.offsetHeight ? notices.offsetHeight + 16 : 0);
  const pad = editor.layout.enabled ? editor.layout.padding * 2 : 0;
  const bar = editor.layout.enabled && FRAME_THEMES[editor.layout.frame] ? 40 * chromeScale(editor.baseCanvas.width) : 0;
  return clampZoom(
    Math.min(1, width / (editor.baseCanvas.width + pad), Math.max(1, available) / (editor.baseCanvas.height + pad + bar))
  );
}

const ZOOM_MODES = { fit: "Fit width", page: "Fit page" };

function applyZoom(value, mode = "custom") {
  if (!editor.canvas) return;
  const next = clampZoom(value);
  editor.zoom = next;
  editor.zoomMode = mode;
  const displayWidth = Math.round(editor.baseCanvas.width * next);
  setCanvasCssWidth(editor.baseDisplayCanvas, displayWidth);
  setCanvasCssWidth(editor.canvas, displayWidth);
  applyLayoutPreview();
  const zoomValue = document.getElementById("zoomValue");
  if (zoomValue) zoomValue.textContent = ZOOM_MODES[mode] || "Zoom";
  const zoomPercent = document.getElementById("zoomPercent");
  if (zoomPercent) zoomPercent.textContent = `${Math.round(next * 100)}%`;
  requestAnimationFrame(() => {
    redraw();
    syncNavigator();
  });
}

// One Zoom menu: fit width, fit page, actual size, in and out.
function setupZoomControls() {
  const controls = document.getElementById("zoomControls");
  const button = document.getElementById("zoomButton");
  const menu = document.getElementById("zoomMenu");
  if (!controls || !button || !menu) return;
  controls.hidden = false;
  const setOpen = setupMenu(button, menu, controls);
  const actions = {
    width: () => applyZoom(fitZoom(), "fit"),
    page: () => applyZoom(fitPageZoom(), "page"),
    actual: () => applyZoom(1, "actual"),
    in: () => applyZoom(editor.zoom * 1.2),
    out: () => applyZoom(editor.zoom / 1.2),
  };
  for (const item of menu.querySelectorAll("[data-zoom]")) {
    item.addEventListener("click", () => {
      actions[item.dataset.zoom]();
      // Zooming in steps keeps the menu open for the next step.
      if (item.dataset.zoom !== "in" && item.dataset.zoom !== "out") setOpen(false);
    });
  }
  window.addEventListener("resize", () => {
    if (editor.zoomMode === "fit") applyZoom(fitZoom(), "fit");
    else if (editor.zoomMode === "page") applyZoom(fitPageZoom(), "page");
    else {
      syncNavigator();
      renderOverlay();
    }
  });
  requestAnimationFrame(() => applyZoom(fitZoom(), "fit"));
}

/* --------------------------- page navigator ---------------------------- */

const NAV_WIDTH = 40;

// A thin map of the whole screenshot at the canvas's right edge, with a box
// for the part in view. Shown only when the screenshot is taller than the
// canvas area; its column keeps its width either way so nothing shifts.
function syncNavigator() {
  const nav = document.getElementById("pageNav");
  const stage = document.getElementById("stage");
  if (!nav || !stage || !editor.canvas || !editor.baseCanvas) return;
  const canvasRect = editor.canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const scrolls = stage.scrollHeight > stage.clientHeight + 1;
  nav.classList.toggle("idle", !scrolls || !canvasRect.height);
  if (!scrolls || !canvasRect.height) return;

  const map = document.getElementById("navMap");
  const { width, height } = editor.baseCanvas;
  const maxHeight = Math.max(80, nav.clientHeight - 36 - 60);
  let mapHeight = Math.round((NAV_WIDTH * height) / width);
  let mapWidth = NAV_WIDTH;
  if (mapHeight > maxHeight) {
    mapHeight = maxHeight;
    mapWidth = Math.max(8, Math.round((maxHeight * width) / height));
  }
  if (map.style.width !== `${mapWidth}px` || map.style.height !== `${mapHeight}px`) {
    map.style.width = `${mapWidth}px`;
    map.style.height = `${mapHeight}px`;
    renderNavigator();
  }

  const top = Math.max(0, Math.min(1, (stageRect.top - canvasRect.top) / canvasRect.height));
  const bottom = Math.max(top, Math.min(1, (stageRect.bottom - canvasRect.top) / canvasRect.height));
  const box = document.getElementById("navBox");
  box.style.top = `${top * mapHeight}px`;
  box.style.height = `${Math.max(6, (bottom - top) * mapHeight)}px`;

  const screens = Math.max(1, Math.ceil(canvasRect.height / stage.clientHeight));
  const current = Math.min(screens, Math.floor(top * screens + 0.001) + 1);
  const label = document.getElementById("navLabel");
  label.textContent = "";
  label.append(`${current} / ${screens}`, document.createElement("br"), "screens");
}

// Draws the screenshot and its annotations into the map.
function renderNavigator() {
  const map = document.getElementById("navMap");
  const canvas = document.getElementById("navCanvas");
  if (!map || !canvas || !editor.baseDisplayCanvas || !map.style.width) return;
  const dpr = window.devicePixelRatio || 1;
  const width = parseFloat(map.style.width);
  const height = parseFloat(map.style.height);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(editor.baseDisplayCanvas, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(editor.canvas, 0, 0, canvas.width, canvas.height);
}

// Redraws come in bursts while drawing; the map catches up once they stop.
function scheduleNavigatorRender() {
  clearTimeout(editor.navigatorTimer);
  editor.navigatorTimer = setTimeout(() => {
    if (!document.getElementById("pageNav")?.classList.contains("idle")) renderNavigator();
  }, 250);
}

function setupNavigator() {
  const stage = document.getElementById("stage");
  const map = document.getElementById("navMap");
  if (!stage || !map) return;
  // Scroll so the point under the pointer is centred in the canvas area.
  const jump = (event) => {
    const mapRect = map.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientY - mapRect.top) / mapRect.height));
    const canvasRect = editor.canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const target = canvasRect.top + fraction * canvasRect.height;
    stage.scrollTop += target - (stageRect.top + stageRect.height / 2);
  };
  map.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    map.setPointerCapture(event.pointerId);
    jump(event);
  });
  map.addEventListener("pointermove", (event) => {
    if (map.hasPointerCapture(event.pointerId)) jump(event);
  });
  stage.addEventListener(
    "scroll",
    () => {
      syncNavigator();
      renderOverlay();
    },
    { passive: true }
  );
}

function loadProjectState(project) {
  if (editor.parts) {
    editor.partState = editor.parts.map((_, i) => newPartState(project?.parts?.[i]?.operations || []));
    applyPartState(editor.partState[0]);
  }
  if (!project) return;

  if (project.layout) {
    editor.layout = {
      ...editor.layout,
      ...project.layout,
    };
  }
  if (Array.isArray(project.operations) && !editor.parts) {
    editor.operations = project.operations.map((operation) => ensureOperationId(cloneOperation(operation)));
    editor.nextOperationId =
      editor.operations.reduce((max, operation) => Math.max(max, operation.id || 0), 0) + 1;
    editor.selectedIndex = -1;
  }
}

function renderAnnotatedCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = editor.baseCanvas.width;
  canvas.height = editor.baseCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(editor.baseCanvas, 0, 0);
  for (const operation of editor.operations) {
    applyOperation(ctx, operation);
  }
  return canvas;
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillPresentationBackground(ctx, width, height, background) {
  if (background === "plain") {
    ctx.fillStyle = "#f4f6f8";
  } else if (background === "dark") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#151922");
    gradient.addColorStop(1, "#343947");
    ctx.fillStyle = gradient;
  } else if (background === "blue") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#d7f1ff");
    gradient.addColorStop(1, "#7aa7ff");
    ctx.fillStyle = gradient;
  } else if (background === "sunset") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#ffd7a8");
    gradient.addColorStop(0.55, "#ff8fb3");
    gradient.addColorStop(1, "#8aa7ff");
    ctx.fillStyle = gradient;
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#eef3f8");
    gradient.addColorStop(1, "#d5dde8");
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}

function presentationSize(imageWidth, imageHeight) {
  const padding = editor.layout.padding;
  const minWidth = imageWidth + padding * 2;
  const minHeight = imageHeight + padding * 2;
  const aspectMap = {
    square: 1,
    "4:3": 4 / 3,
    "16:9": 16 / 9,
  };
  const ratio = aspectMap[editor.layout.aspect];

  if (!ratio) return { width: minWidth, height: minHeight };

  let width = minWidth;
  let height = Math.round(width / ratio);
  if (height < minHeight) {
    height = minHeight;
    width = Math.round(height * ratio);
  }
  return { width, height };
}

const FRAME_THEMES = {
  mac: { bar: "#e9e9eb", text: "#4b5563", pill: "#ffffff", controls: "dots" },
  "mac-dark": { bar: "#2b2c30", text: "#d1d5db", pill: "#3a3b40", controls: "dots" },
  windows: { bar: "#f3f3f3", text: "#374151", pill: "#ffffff", controls: "buttons" },
  "windows-dark": { bar: "#202124", text: "#e5e7eb", pill: "#35363a", controls: "buttons" },
};

// Frame and stamp sizes follow the screenshot's pixel density: a 2x capture
// is twice as wide, and its frame should look the same once displayed.
function chromeScale(width) {
  return Math.min(3, Math.max(0.75, width / 1280));
}

function stampText() {
  const at = new Date(editor.capturedAt || Date.now());
  const parts = [];
  if (editor.layout.stamp === "date") parts.push(at.toLocaleDateString());
  if (editor.layout.stamp === "datetime") parts.push(at.toLocaleString());
  if (editor.layout.stamp === "iso") parts.push(at.toISOString());
  if (editor.layout.stampUrl && editor.pageUrl) parts.push(editor.pageUrl);
  return parts.join("  ·  ");
}

// The capture time (and page address, if asked for) in the bottom-right
// corner of the screenshot.
function drawStamp(screenshot) {
  const text = editor.layout.stamp !== "none" ? stampText() : "";
  if (!text) return screenshot;
  const s = chromeScale(screenshot.width);
  const ctx = screenshot.getContext("2d");
  ctx.save();
  ctx.font = `${Math.round(14 * s)}px system-ui, sans-serif`;
  const maxWidth = screenshot.width - 40 * s;
  const width = Math.min(maxWidth, ctx.measureText(text).width) + 20 * s;
  const height = 28 * s;
  const x = screenshot.width - width - 12 * s;
  const y = screenshot.height - height - 12 * s;
  ctx.fillStyle = "rgba(17, 24, 39, 0.72)";
  roundRectPath(ctx, x, y, width, height, 6 * s);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 10 * s, y + height / 2, maxWidth);
  ctx.restore();
  return screenshot;
}

// A browser window's title bar above the screenshot: traffic lights for
// macOS, window buttons for Windows, and the page address if wanted.
function drawBrowserFrame(screenshot) {
  const theme = FRAME_THEMES[editor.layout.frame];
  if (!theme) return screenshot;
  const s = chromeScale(screenshot.width);
  const bar = Math.round(40 * s);
  const canvas = document.createElement("canvas");
  canvas.width = screenshot.width;
  canvas.height = screenshot.height + bar;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = theme.bar;
  roundRectPath(ctx, 0, 0, canvas.width, bar + 12 * s, 10 * s);
  ctx.fill();
  ctx.drawImage(screenshot, 0, bar);

  let addressLeft = 16 * s;
  let addressRight = canvas.width - 16 * s;
  if (theme.controls === "dots") {
    ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(20 * s + i * 20 * s, bar / 2, 6 * s, 0, Math.PI * 2);
      ctx.fill();
    });
    addressLeft = 90 * s;
    addressRight = canvas.width - 90 * s;
  } else {
    ctx.strokeStyle = theme.text;
    ctx.lineWidth = Math.max(1, s);
    const y = bar / 2;
    const right = canvas.width - 22 * s;
    ctx.beginPath();
    ctx.moveTo(right - 5 * s, y - 5 * s);
    ctx.lineTo(right + 5 * s, y + 5 * s);
    ctx.moveTo(right + 5 * s, y - 5 * s);
    ctx.lineTo(right - 5 * s, y + 5 * s);
    ctx.stroke();
    ctx.strokeRect(right - 51 * s, y - 5 * s, 10 * s, 10 * s);
    ctx.beginPath();
    ctx.moveTo(right - 97 * s, y);
    ctx.lineTo(right - 87 * s, y);
    ctx.stroke();
    addressRight = canvas.width - 140 * s;
  }

  if (editor.layout.frameAddress && editor.pageUrl) {
    const width = Math.max(0, addressRight - addressLeft);
    const height = 24 * s;
    const x = theme.controls === "dots" ? addressLeft + Math.max(0, width - Math.min(width, 640 * s)) / 2 : addressLeft;
    const w = theme.controls === "dots" ? Math.min(width, 640 * s) : width;
    ctx.fillStyle = theme.pill;
    roundRectPath(ctx, x, (bar - height) / 2, w, height, 6 * s);
    ctx.fill();
    ctx.fillStyle = theme.text;
    ctx.font = `${Math.round(13 * s)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = theme.controls === "dots" ? "center" : "left";
    const textX = theme.controls === "dots" ? x + w / 2 : x + 10 * s;
    ctx.fillText(editor.pageUrl.replace(/^https?:\/\//, ""), textX, bar / 2, w - 20 * s);
  }
  return canvas;
}

function renderFinalCanvas() {
  let screenshot = renderAnnotatedCanvas();
  if (!editor.layout.enabled) return screenshot;
  screenshot = drawBrowserFrame(drawStamp(screenshot));

  const { width, height } = presentationSize(screenshot.width, screenshot.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  fillPresentationBackground(ctx, width, height, editor.layout.background);

  const x = Math.round((width - screenshot.width) / 2);
  const y = Math.round((height - screenshot.height) / 2);
  const radius = editor.layout.radius;

  ctx.save();
  if (editor.layout.shadow > 0) {
    ctx.shadowColor = "rgba(25, 31, 42, 0.34)";
    ctx.shadowBlur = editor.layout.shadow;
    ctx.shadowOffsetY = Math.round(editor.layout.shadow * 0.28);
  }
  roundRectPath(ctx, x, y, screenshot.width, screenshot.height, radius);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, screenshot.width, screenshot.height, radius);
  ctx.clip();
  ctx.drawImage(screenshot, x, y);
  ctx.restore();

  return canvas;
}

async function refreshExports(baseName, options = {}) {
  const version = ++editor.exportVersion;
  const png = document.getElementById("downloadPng");
  const jpeg = document.getElementById("downloadJpeg");
  const pdf = document.getElementById("downloadPdf");

  png.removeAttribute("href");
  jpeg.removeAttribute("href");
  pdf.removeAttribute("href");
  clearExportUrls();

  const outputCanvas = renderFinalCanvas();
  const pngBlob = await canvasToBlob(outputCanvas, "image/png");
  const jpegCanvas = makeJpegCanvas(outputCanvas);
  const jpegBlob = await canvasToBlob(jpegCanvas, "image/jpeg", editor.jpegQuality);
  const pdfBlob = makePdfBlob(
    new Uint8Array(await jpegBlob.arrayBuffer()),
    outputCanvas.width,
    outputCanvas.height
  );

  if (version !== editor.exportVersion) return;
  setDownload(png, pngBlob, `${baseName}.png`);
  setDownload(jpeg, jpegBlob, `${baseName}.jpg`);
  setDownload(pdf, pdfBlob, `${baseName}.pdf`);
  for (const anchor of [png, jpeg, pdf]) anchor.dataset.exportReady = "1";
  editor.exportDirty = false;
  editor.exportBaseName = baseName;
  if (!options.quiet) showExportStatus("Updated", "done");
  if (!options.skipHistory) {
    await saveRenderedProjectToHistory(outputCanvas, pngBlob);
  }
}

async function ensureFreshExports(baseName) {
  const png = document.getElementById("downloadPng");
  if (!editor.exportDirty && png?.dataset.exportReady === "1") return;
  showExportStatus("Updating...");
  await refreshExports(baseName);
}

// Editor defaults: the annotation style follows whatever was used last, and
// the presentation layout is whatever was last saved with "Use as default".
async function loadEditorDefaults() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return settings.editorDefaults || {};
}

async function saveEditorDefaults(patch) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const editorDefaults = { ...(settings.editorDefaults || {}), ...patch };
  await chrome.storage.local.set({ settings: { ...settings, editorDefaults } });
}

// JPG quality is a slider on the JPG row of the Export menu. Moving it keeps
// the menu open and downloads nothing; it is remembered for next time.
function setupJpegQuality(baseName) {
  const input = document.getElementById("jpegQuality");
  const label = document.getElementById("jpegQualityValue");
  if (!input) return;
  input.value = String(Math.round(editor.jpegQuality * 100));
  label.textContent = input.value;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("input", () => {
    label.textContent = input.value;
  });
  input.addEventListener("change", async () => {
    editor.jpegQuality = Number(input.value) / 100;
    syncJpegLabel();
    scheduleExportRefresh(baseName);
    await saveEditorDefaults({ jpegQuality: editor.jpegQuality });
  });
}

function setupDownloadActions(baseName) {
  for (const id of ["downloadPng", "downloadJpeg", "downloadPdf"]) {
    const anchor = document.getElementById(id);
    anchor.addEventListener("click", async (event) => {
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      if (!editor.exportDirty && anchor.dataset.exportReady === "1") return;
      event.preventDefault();
      await ensureFreshExports(baseName);
      anchor.click();
    });
  }
}

function syncLayoutControlValues() {
  const controls = document.getElementById("layoutControls");
  const enabled = document.getElementById("layoutEnabled");
  const background = document.getElementById("layoutBackground");
  const aspect = document.getElementById("layoutAspect");
  const padding = document.getElementById("layoutPadding");
  const radius = document.getElementById("layoutRadius");
  const shadow = document.getElementById("layoutShadow");
  if (!enabled || !background || !aspect || !padding || !radius || !shadow) return;

  enabled.checked = Boolean(editor.layout.enabled);
  if (controls) controls.hidden = !enabled.checked;
  document.getElementById("frameDot").hidden = !enabled.checked;
  document.getElementById("layoutFrame").value = editor.layout.frame || "none";
  document.getElementById("layoutFrameAddress").checked = editor.layout.frameAddress !== false;
  document.getElementById("layoutStamp").value = editor.layout.stamp || "none";
  document.getElementById("layoutStampUrl").checked = !!editor.layout.stampUrl;
  background.value = editor.layout.background;
  aspect.value = editor.layout.aspect;
  padding.value = String(editor.layout.padding);
  radius.value = String(editor.layout.radius);
  shadow.value = String(editor.layout.shadow);
  syncPickers();
  syncLayoutValues();
}

function syncLayoutValues() {
  document.getElementById("layoutPaddingValue").textContent = String(editor.layout.padding);
  document.getElementById("layoutRadiusValue").textContent = String(editor.layout.radius);
  document.getElementById("layoutShadowValue").textContent = String(editor.layout.shadow);
}

// The swatches, window chips and segmented buttons stand in for hidden
// selects, which stay the source of truth for refreshLayout.
const LAYOUT_PICKERS = [
  { selector: "[data-background]", attribute: "background", select: "layoutBackground" },
  { selector: "[data-frame]", attribute: "frame", select: "layoutFrame" },
  { selector: "[data-aspect]", attribute: "aspect", select: "layoutAspect" },
  { selector: "[data-stamp]", attribute: "stamp", select: "layoutStamp" },
];

function syncPickers() {
  for (const picker of LAYOUT_PICKERS) {
    setChecked(picker.selector, picker.attribute, document.getElementById(picker.select).value);
  }
  const frame = document.getElementById("layoutFrame").value;
  const stamp = document.getElementById("layoutStamp").value;
  document.getElementById("layoutFrameAddress").closest("label").hidden = frame === "none";
  document.getElementById("layoutStampUrl").closest("label").hidden = stamp === "none";
}

function setupPickers() {
  for (const swatch of document.querySelectorAll("[data-background]")) {
    swatch.style.background = layoutCssBackground(swatch.dataset.background);
  }
  for (const picker of LAYOUT_PICKERS) {
    const select = document.getElementById(picker.select);
    for (const button of document.querySelectorAll(picker.selector)) {
      button.addEventListener("click", () => {
        select.value = button.dataset[picker.attribute];
        select.dispatchEvent(new Event("change"));
        syncPickers();
      });
    }
  }
}

function setupLayoutControls(baseName) {
  const controls = document.getElementById("layoutControls");
  const enabled = document.getElementById("layoutEnabled");
  const background = document.getElementById("layoutBackground");
  const aspect = document.getElementById("layoutAspect");
  const padding = document.getElementById("layoutPadding");
  const radius = document.getElementById("layoutRadius");
  const shadow = document.getElementById("layoutShadow");
  if (!enabled || !background || !aspect || !padding || !radius || !shadow) return;

  const frame = document.getElementById("layoutFrame");
  const frameAddress = document.getElementById("layoutFrameAddress");
  const stamp = document.getElementById("layoutStamp");
  const stampUrl = document.getElementById("layoutStampUrl");
  const saveDefault = document.getElementById("layoutSaveDefault");

  function refreshLayout() {
    editor.layout = {
      enabled: enabled.checked,
      background: background.value,
      aspect: aspect.value,
      padding: Number(padding.value),
      radius: Number(radius.value),
      shadow: Number(shadow.value),
      frame: frame.value,
      frameAddress: frameAddress.checked,
      stamp: stamp.value,
      stampUrl: stampUrl.checked,
    };
    if (controls) controls.hidden = !editor.layout.enabled;
    document.getElementById("frameDot").hidden = !editor.layout.enabled;
    syncLayoutValues();
    applyLayoutPreview();
    syncNavigator();
    scheduleExportRefresh(baseName);
  }

  syncLayoutControlValues();
  setupPickers();
  for (const control of [enabled, background, aspect, frame, frameAddress, stamp, stampUrl]) {
    control.addEventListener("change", refreshLayout);
  }
  for (const control of [padding, radius, shadow]) control.addEventListener("input", refreshLayout);
  saveDefault.addEventListener("click", async () => {
    await saveEditorDefaults({ layout: cloneLayout() });
    saveDefault.textContent = "Saved for new screenshots";
    setTimeout(() => {
      saveDefault.textContent = "Save as default";
    }, 1600);
  });
}

// Annotate and Frame share the panel; picking a tool returns to Annotate.
function showPanelTab(name) {
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  document.getElementById("annotatePane").hidden = name !== "annotate";
  document.getElementById("framePane").hidden = name !== "frame";
}

function setupPanelTabs() {
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => showPanelTab(tab.dataset.tab));
  }
}

function setupAnnotationControls(baseName) {
  const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
  editor.canvas.dataset.currentTool = editor.currentTool;

  function selectTool(tool) {
    const button = toolButtons.find((item) => item.dataset.tool === tool);
    if (!button || button.hidden) return;

    finalizeStyleEdit();
    if (editor.activeTextInput) editor.activeTextInput.finish(true);
    if (tool === "crop" && editor.currentTool !== "crop") {
      editor.toolBeforeCrop = editor.currentTool;
      editor.cropDraft = fullImageRect();
    }
    if (tool !== "crop") editor.cropDraft = null;
    // Select keeps what was just drawn selected, so it can be adjusted.
    if (tool !== "select") editor.selectedIndex = -1;
    editor.currentTool = tool;
    editor.canvas.dataset.currentTool = tool;
    editor.canvas.style.cursor = "";
    toolButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    showPanelTab("annotate");
    redraw();
    syncStyleControlVisibility();
  }

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => selectTool(button.dataset.tool));
  });

  /* ------------------------------ style ------------------------------ */

  function updateSelectedStyle() {
    const operation = editor.operations[editor.selectedIndex];
    if (!operation) return;

    const style = editor.style;
    const group = toolGroup(operation.type);
    if (["arrow", "rect", "pen", "text", "step"].includes(group)) operation.color = style.color;
    if (["arrow", "rect", "pen"].includes(group)) operation.strokeWidth = style.strokeWidth;
    if (group === "text") {
      operation.textSize = style.textSize;
      operation.background = !!style.textBackground;
    }
    if (group === "hide") {
      operation.type = editor.hideMethod;
      if (operation.type === "redact") operation.color = "#111111";
      else operation.strokeWidth = style.strength;
    }
    redraw();
    scheduleExportRefresh(baseName);
  }

  // The annotation style carries over to the next screenshot.
  function persistStyle() {
    saveEditorDefaults({ style: { ...editor.style, hideMethod: editor.hideMethod } }).catch(() => {});
  }

  // A style change applies to the selected annotation too. Sliders commit
  // once, when released, so a drag is one undo step.
  function changeStyle(patch, { commit = true } = {}) {
    beginStyleEdit();
    Object.assign(editor.style, patch);
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    syncStyleControls();
    if (commit) {
      finalizeStyleEdit();
      persistStyle();
    }
  }

  for (const swatch of document.querySelectorAll("[data-color]")) {
    swatch.addEventListener("click", () => changeStyle({ color: swatch.dataset.color }));
  }
  for (const button of document.querySelectorAll("[data-thickness]")) {
    button.addEventListener("click", () => changeStyle({ strokeWidth: THICKNESS[button.dataset.thickness] }));
  }
  for (const button of document.querySelectorAll("[data-text-size]")) {
    button.addEventListener("click", () => changeStyle({ textSize: TEXT_SIZES[button.dataset.textSize] }));
  }
  const textBackground = document.getElementById("textBackground");
  textBackground.addEventListener("change", () => changeStyle({ textBackground: textBackground.checked }));
  for (const button of document.querySelectorAll("[data-hide-method]")) {
    button.addEventListener("click", () => {
      beginStyleEdit();
      editor.hideMethod = button.dataset.hideMethod;
      updateSelectedStyle();
      finalizeStyleEdit();
      syncStyleControls();
      persistStyle();
    });
  }
  const strength = document.getElementById("strength");
  strength.addEventListener("input", () => changeStyle({ strength: Number(strength.value) }, { commit: false }));
  strength.addEventListener("change", () => {
    finalizeStyleEdit();
    persistStyle();
  });
  document.getElementById("restartSteps").addEventListener("click", () => {
    editor.stepRestartId = editor.nextOperationId;
    syncStyleControls();
  });

  /* ------------------------------- crop ------------------------------ */

  function fullImageRect() {
    return { x: 0, y: 0, width: editor.baseCanvas.width, height: editor.baseCanvas.height };
  }

  // `start` with `edge` dragged to `point`: inside the image, at least 8px,
  // and at the chosen aspect, growing away from the side that stays put.
  function resizeCrop(start, edge, point) {
    const W = editor.baseCanvas.width;
    const H = editor.baseCanvas.height;
    const px = Math.max(0, Math.min(W, point.x));
    const py = Math.max(0, Math.min(H, point.y));
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (edge.includes("w")) left = Math.min(px, right - 8);
    if (edge.includes("e")) right = Math.max(px, left + 8);
    if (edge.includes("n")) top = Math.min(py, bottom - 8);
    if (edge.includes("s")) bottom = Math.max(py, top + 8);
    const ratio = CROP_ASPECTS[editor.cropAspect];
    if (!ratio) return { x: left, y: top, width: right - left, height: bottom - top };

    const anchorX = edge.includes("w") ? right : edge.includes("e") ? left : start.x + start.width / 2;
    const anchorY = edge.includes("n") ? bottom : edge.includes("s") ? top : start.y + start.height / 2;
    let w = right - left;
    let h = bottom - top;
    if (edge === "n" || edge === "s") w = h * ratio;
    else h = w / ratio;
    const maxW = edge.includes("w") ? anchorX : edge.includes("e") ? W - anchorX : 2 * Math.min(anchorX, W - anchorX);
    const maxH = edge.includes("n") ? anchorY : edge.includes("s") ? H - anchorY : 2 * Math.min(anchorY, H - anchorY);
    const scale = Math.min(1, maxW / w, maxH / h);
    w *= scale;
    h *= scale;
    return {
      x: edge.includes("w") ? anchorX - w : edge.includes("e") ? anchorX : anchorX - w / 2,
      y: edge.includes("n") ? anchorY - h : edge.includes("s") ? anchorY : anchorY - h / 2,
      width: w,
      height: h,
    };
  }

  // The edge or corner of the pending crop under `point`, if any.
  function cropEdgeAt(point) {
    const rect = editor.cropDraft;
    if (!rect) return null;
    const tolerance = 10 * cssPixel();
    const handle = cropHandles(rect).find(
      (item) => Math.abs(item.x - point.x) <= tolerance && Math.abs(item.y - point.y) <= tolerance
    );
    if (handle) return handle.edge;
    const withinX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance;
    const withinY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;
    if (withinY && Math.abs(point.x - rect.x) <= tolerance) return "w";
    if (withinY && Math.abs(point.x - (rect.x + rect.width)) <= tolerance) return "e";
    if (withinX && Math.abs(point.y - rect.y) <= tolerance) return "n";
    if (withinX && Math.abs(point.y - (rect.y + rect.height)) <= tolerance) return "s";
    return null;
  }

  const EDGE_CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };

  // Choosing an aspect reshapes the pending crop to the largest area of that
  // shape inside it.
  function setCropAspect(name) {
    editor.cropAspect = name;
    const ratio = CROP_ASPECTS[name];
    const rect = editor.cropDraft;
    if (ratio && rect) {
      let width = rect.width;
      let height = width / ratio;
      if (height > rect.height) {
        height = rect.height;
        width = height * ratio;
      }
      editor.cropDraft = {
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height,
      };
    }
    redraw();
    syncCropControls();
  }

  function applyCrop() {
    if (!editor.cropDraft || document.getElementById("applyCrop").disabled) return;
    cropToRect(editor.cropDraft, baseName);
    editor.cropDraft = null;
    selectTool(editor.toolBeforeCrop || "arrow");
  }

  function cancelCrop() {
    editor.cropDraft = null;
    selectTool(editor.toolBeforeCrop || "arrow");
  }

  for (const button of document.querySelectorAll("[data-crop-aspect]")) {
    button.addEventListener("click", () => setCropAspect(button.dataset.cropAspect));
  }
  document.getElementById("applyCrop").addEventListener("click", applyCrop);
  document.getElementById("cancelCrop").addEventListener("click", cancelCrop);

  /* --------------------------- edit actions -------------------------- */

  function undoOperation() {
    finalizeStyleEdit();
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const action = editor.undoStack.pop();
    if (!action) return;
    applyUndoAction(action);
    editor.redoStack.push(action);
    syncAfterHistoryChange(baseName);
  }

  function redoOperation() {
    finalizeStyleEdit();
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const action = editor.redoStack.pop();
    if (!action) return;
    applyRedoAction(action);
    editor.undoStack.push(action);
    syncAfterHistoryChange(baseName);
  }

  function clearAnnotations() {
    finalizeStyleEdit();
    if (editor.operations.length === 0) return;
    if (!confirm("Clear all annotations from this screenshot?")) return;
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const operations = editor.operations.map(cloneOperation);
    editor.operations = [];
    editor.selectedIndex = -1;
    commitUndoAction({ type: "clear", operations });
    redraw();
    syncEditActionState();
    syncStyleControlVisibility();
    scheduleExportRefresh(baseName);
  }

  function deleteOperationAt(index) {
    finalizeStyleEdit();
    if (index < 0 || index >= editor.operations.length) return;
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const operation = cloneOperation(editor.operations[index]);
    editor.operations.splice(index, 1);
    editor.selectedIndex = -1;
    commitUndoAction({ type: "remove", operation, index });
    redraw();
    syncEditActionState();
    syncStyleControlVisibility();
    scheduleExportRefresh(baseName);
  }

  // Brings an annotation picked from the list into view.
  function scrollOperationIntoView(operation) {
    const stage = document.getElementById("stage");
    const bounds = operationBounds(operation);
    const canvasRect = editor.canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scale = canvasRect.height / editor.baseCanvas.height;
    const top = canvasRect.top + bounds.y * scale;
    const bottom = top + bounds.height * scale;
    if (top >= stageRect.top && bottom <= stageRect.bottom) return;
    stage.scrollTop += (top + bottom) / 2 - (stageRect.top + stageRect.height / 2);
  }

  editor.listActions = {
    select(index) {
      finalizeStyleEdit();
      const operation = editor.operations[index];
      if (!operation) return;
      editor.selectedIndex = index;
      loadOperationStyle(operation);
      redraw();
      syncStyleControlVisibility();
      scrollOperationIntoView(operation);
    },
    remove: deleteOperationAt,
  };

  document.getElementById("undo").addEventListener("click", undoOperation);
  document.getElementById("redo").addEventListener("click", redoOperation);
  document.getElementById("clear").addEventListener("click", clearAnnotations);

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTextEntry =
      target?.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName || "");
    const key = event.key.toLowerCase();
    const hasModifier = event.metaKey || event.ctrlKey;

    if (isTextEntry && event.key !== "Escape") return;

    if (hasModifier && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redoOperation();
      } else {
        undoOperation();
      }
      return;
    }

    if (hasModifier && key === "y") {
      event.preventDefault();
      redoOperation();
      return;
    }

    if (editor.currentTool === "crop" && (event.key === "Enter" || event.key === "Escape")) {
      if (!isTextEntry && !target?.closest?.("[role='menu']")) {
        event.preventDefault();
        if (event.key === "Enter") applyCrop();
        else cancelCrop();
        return;
      }
    }

    if (event.key === "Escape") {
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(false);
      editor.selectedIndex = -1;
      editor.interaction = null;
      editor.draft = null;
      editor.dragStart = null;
      redraw();
      syncStyleControlVisibility();
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && !hasModifier && editor.selectedIndex >= 0) {
      event.preventDefault();
      deleteOperationAt(editor.selectedIndex);
      return;
    }

    if (!hasModifier && !event.altKey && !event.shiftKey && shortcutToolMap[key]) {
      event.preventDefault();
      selectTool(shortcutToolMap[key]);
    }
  });

  /* ------------------------------ pointer ---------------------------- */

  function onCanvasPointerDown(event) {
    const point = pointerToCanvasPoint(event);

    if (editor.currentTool === "crop") {
      event.preventDefault();
      const edge = cropEdgeAt(point);
      editor.interaction = edge
        ? { type: "crop", edge, start: { ...editor.cropDraft } }
        : {
            type: "crop",
            edge: null,
            origin: {
              x: Math.max(0, Math.min(editor.baseCanvas.width, point.x)),
              y: Math.max(0, Math.min(editor.baseCanvas.height, point.y)),
            },
          };
      editor.canvas.setPointerCapture(event.pointerId);
      return;
    }

    // The selected annotation's handles resize it in any tool.
    const selected = editor.operations[editor.selectedIndex];
    const handle = selected ? handleAtClient(selected, event.clientX, event.clientY) : null;
    if (selected && handle) {
      event.preventDefault();
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.interaction = {
        type: "resize",
        handle: handle.name,
        startPoint: point,
        startOperation: cloneOperation(selected),
        startBounds: operationBounds(selected),
      };
      editor.canvas.setPointerCapture(event.pointerId);
      return;
    }

    // Only Select picks annotations up; every other tool always draws.
    if (editor.currentTool === "select") {
      event.preventDefault();
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      const hitIndex = operationAtPoint(point);
      editor.selectedIndex = hitIndex;
      if (hitIndex >= 0) {
        loadOperationStyle(editor.operations[hitIndex]);
        editor.interaction = {
          type: "move",
          lastPoint: point,
          startOperation: cloneOperation(editor.operations[hitIndex]),
        };
        editor.canvas.setPointerCapture(event.pointerId);
      }
      redraw();
      syncStyleControlVisibility();
      return;
    }

    if (editor.currentTool === "text") {
      event.preventDefault();
      finalizeStyleEdit();
      editor.selectedIndex = -1;
      syncStyleControlVisibility();
      openTextEditor(point, baseName);
      return;
    }
    if (editor.currentTool === "step") {
      event.preventDefault();
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.selectedIndex = -1;
      pushOperation(
        {
          type: "step",
          point,
          number: nextStepNumber(),
          ...currentStyle("step"),
          textSize: STEP_TEXT_SIZE,
          radius: Math.max(36, STEP_TEXT_SIZE * 1.24),
        },
        baseName
      );
      return;
    }

    if (editor.activeTextInput) editor.activeTextInput.finish(true);
    finalizeStyleEdit();
    event.preventDefault();
    editor.selectedIndex = -1;
    syncStyleControlVisibility();
    editor.dragStart = point;
    editor.canvas.setPointerCapture(event.pointerId);
    if (editor.currentTool === "pen") {
      editor.draft = { type: "pen", points: [point], ...currentStyle("pen") };
    } else {
      editor.draft = makeDragOperation(editor.currentTool, point, point);
    }
  }

  editor.canvas.addEventListener("pointerdown", onCanvasPointerDown);
  // Handles and the crop frame reach a few pixels past the image's edge,
  // where the pointer lands on the canvas area instead of the canvas.
  document.getElementById("stage").addEventListener("pointerdown", (event) => {
    if (event.target === editor.canvas || event.button !== 0) return;
    const selected = editor.operations[editor.selectedIndex];
    const onHandle = selected && editor.currentTool !== "crop" && handleAtClient(selected, event.clientX, event.clientY);
    const onCrop = editor.currentTool === "crop" && cropEdgeAt(pointerToCanvasPoint(event));
    if (onHandle || onCrop) onCanvasPointerDown(event);
  });

  const HANDLE_CURSORS = { ...EDGE_CURSORS, from: "move", to: "move", "step-se": "nwse-resize", "step-nw": "nwse-resize" };

  // What the pointer would do here, as a cursor, in the tools that move things.
  function syncHoverCursor(point, event) {
    let cursor = "";
    if (editor.currentTool === "crop") {
      cursor = EDGE_CURSORS[cropEdgeAt(point)] || "";
    } else {
      const selected = editor.operations[editor.selectedIndex];
      const handle = selected && handleAtClient(selected, event.clientX, event.clientY);
      if (handle) cursor = HANDLE_CURSORS[handle.name] || "move";
      else if (editor.currentTool === "select" && operationAtPoint(point) >= 0) cursor = "move";
    }
    editor.canvas.style.cursor = cursor;
  }

  editor.canvas.addEventListener("pointermove", (event) => {
    const point = pointerToCanvasPoint(event);
    if (editor.interaction?.type === "crop") {
      event.preventDefault();
      const interaction = editor.interaction;
      if (interaction.edge) {
        editor.cropDraft = resizeCrop(interaction.start, interaction.edge, point);
      } else {
        const dx = point.x - interaction.origin.x;
        const dy = point.y - interaction.origin.y;
        if (Math.hypot(dx, dy) < 4 * cssPixel()) return;
        const edge = (dy < 0 ? "n" : "s") + (dx < 0 ? "w" : "e");
        editor.cropDraft = resizeCrop({ ...interaction.origin, width: 0, height: 0 }, edge, point);
      }
      requestRedraw();
      syncCropControls();
      return;
    }

    if (editor.interaction) {
      event.preventDefault();
      const operation = editor.operations[editor.selectedIndex];
      if (!operation) return;

      if (editor.interaction.type === "move") {
        const dx = point.x - editor.interaction.lastPoint.x;
        const dy = point.y - editor.interaction.lastPoint.y;
        moveOperation(operation, dx, dy);
        editor.interaction.lastPoint = point;
      }
      if (editor.interaction.type === "resize") {
        const { startOperation, startBounds, handle, startPoint } = editor.interaction;
        const delta = { x: point.x - startPoint.x, y: point.y - startPoint.y };
        const anchor = handleAnchor(startOperation, startBounds, handle);
        resizeOperation(
          operation,
          startOperation,
          startBounds,
          handle,
          { x: anchor.x + delta.x, y: anchor.y + delta.y },
          delta
        );
      }
      requestRedraw();
      return;
    }

    if (!editor.draft || !editor.dragStart) {
      syncHoverCursor(point, event);
      return;
    }
    event.preventDefault();
    if (editor.draft.type === "pen") {
      editor.draft.points.push(point);
    } else {
      editor.draft = makeDragOperation(editor.currentTool, editor.dragStart, point);
    }
    requestRedraw(editor.draft);
  });

  editor.canvas.addEventListener("pointerup", (event) => {
    if (!editor.draft) return;
    event.preventDefault();
    const operation = editor.draft;
    editor.draft = null;
    editor.dragStart = null;
    if (operationIsLargeEnough(operation)) {
      pushOperation(operation, baseName);
    } else {
      redraw();
    }
  });

  editor.canvas.addEventListener("pointerup", (event) => {
    if (!editor.interaction) return;
    event.preventDefault();
    if (editor.interaction.type === "crop") {
      editor.interaction = null;
      redraw();
      syncCropControls();
      return;
    }
    const operation = editor.operations[editor.selectedIndex];
    const before = editor.interaction.startOperation;
    editor.interaction = null;
    if (operation && before && !sameOperation(before, operation)) {
      commitUndoAction({
        type: "replace",
        id: operation.id,
        before,
        after: cloneOperation(operation),
      });
    }
    redraw();
    syncEditActionState();
    syncStyleControlVisibility();
    scheduleExportRefresh(baseName);
  });

  editor.canvas.addEventListener("pointercancel", () => {
    editor.draft = null;
    editor.dragStart = null;
    editor.interaction = null;
    redraw();
    syncStyleControlVisibility();
  });

  syncEditActionState();
  syncStyleControlVisibility();
  editor.annotateMode = true;
}

async function setupCopyButton() {
  const copy = document.getElementById("copy");
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      const outputCanvas = renderFinalCanvas();
      const pngBlob = await canvasToBlob(outputCanvas, "image/png");
      await navigator.clipboard.write([
        new ClipboardItem({ [pngBlob.type]: pngBlob }),
      ]);
      await saveRenderedProjectToHistory(outputCanvas, pngBlob);
      setButtonLabel(copy, "check", "Copied");
    } catch (err) {
      console.error("Copy failed:", err);
      setButtonLabel(copy, "copy", "Use PNG");
      showExportStatus("Couldn't copy. Export a PNG instead.", "error");
    } finally {
      setTimeout(() => {
        copy.disabled = false;
        setButtonLabel(copy, "copy", "Copy");
      }, 1600);
    }
  });
}

async function setupUploadButton() {
  // The menu closes on click, so progress shows in the top bar's status line.
  const upload = document.getElementById("upload");
  const label = document.getElementById("uploadLabel");
  const defaultLabel = label.textContent;
  upload.addEventListener("click", async () => {
    if (upload.disabled) return;
    upload.disabled = true;
    label.textContent = "Uploading...";
    showExportStatus("Uploading...");

    try {
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      const outputCanvas = renderFinalCanvas();
      const pngBlob = await canvasToBlob(outputCanvas, "image/png");
      const form = new FormData();
      form.append("files[]", pngBlob, `${editor.baseName}.png`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response;
      let text;
      try {
        response = await fetch("https://uguu.se/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        text = (await response.text()).trim();
      } finally {
        clearTimeout(timeout);
      }

      let url = "";
      try {
        const data = JSON.parse(text);
        url = data?.files?.[0]?.url || "";
      } catch (_err) {
        url = text;
      }

      if (!response.ok) {
        const error = new Error(text || `Upload failed with HTTP ${response.status}.`);
        error.uiLabel = `HTTP ${response.status}`;
        throw error;
      }
      if (!/^https:\/\/\S+\.uguu\.se\/\S+/.test(url)) {
        const error = new Error(text || "Upload did not return a valid image URL.");
        error.uiLabel = "Invalid response";
        throw error;
      }

      try {
        await navigator.clipboard.writeText(url);
      } catch (err) {
        err.uiLabel = "Copy failed";
        throw err;
      }
      await saveRenderedProjectToHistory(outputCanvas, pngBlob);
      await saveUploadToHistory(url);
      showExportStatus("Link copied", "done");
    } catch (err) {
      if (err.name === "AbortError") {
        err.uiLabel = "Timed out";
      }
      console.error("Upload failed:", err);
      const reason = err.uiLabel || (err.name === "TypeError" ? "Network failed" : "Upload failed");
      showExportStatus(reason === "Upload failed" ? reason : `Upload failed: ${reason}`, "error");
    } finally {
      upload.disabled = false;
      label.textContent = defaultLabel;
    }
  });
}

function normalizeHistoryLimit(value) {
  return Math.min(50, Math.max(1, Number(value) || 20));
}

function hasEdits() {
  return editor.operations.length > 0 || editor.layout.enabled;
}

// Write the image a history entry shows - the unannotated base when there is
// nothing on it, otherwise an annotated render under its own key - and its
// thumbnail. Returns the entry fields that point at them.
async function storeShownImage(id, baseKey, outputCanvas, pngBlob) {
  let imageKey = baseKey;
  let shown = null;
  if (hasEdits()) {
    imageKey = `out:${id}`;
    shown = pngBlob || (await canvasToBlob(outputCanvas, "image/png"));
    await FpsImages.put(imageKey, shown);
  } else {
    await FpsImages.remove(`out:${id}`);
  }
  const thumbKey = `thumb:${id}`;
  try {
    shown = shown || (await FpsImages.get(baseKey));
    if (shown) await FpsImages.put(thumbKey, await FpsImages.makeThumbnail(shown));
  } catch (err) {
    console.warn("Unable to update the history thumbnail:", err);
  }
  return { imageKey, thumbKey };
}

async function autoSaveHistory(capture) {
  const { history = [], historyLimit = 20 } = await chrome.storage.local.get([
    "history",
    "historyLimit",
  ]);
  const limit = normalizeHistoryLimit(historyLimit);
  const id = FpsImages.newId();
  const baseKey = `img:${id}`;
  await FpsImages.put(baseKey, await canvasToBlob(editor.baseCanvas, "image/png"));
  const outputCanvas = hasEdits() ? renderFinalCanvas() : editor.baseCanvas;
  const { imageKey, thumbKey } = await storeShownImage(id, baseKey, outputCanvas);
  editor.historyId = id;
  history.unshift({
    id,
    baseName: editor.baseName,
    imageKey,
    baseKey,
    thumbKey,
    height: outputCanvas.height,
    mode: capture.mode || "fullPage",
    project: cloneProject(),
    savedAt: Date.now(),
    title: capture.pageTitle || "Screenshot",
    url: capture.pageUrl || "",
    width: outputCanvas.width,
  });
  const keptHistory = history.slice(0, limit);
  const staleImageKeys = history.slice(limit).flatMap(FpsImages.entryKeys);
  await chrome.storage.local.set({
    history: keptHistory,
    historyLimit: limit,
  });
  await FpsImages.remove(staleImageKeys);
  editor.historyReady = true;
}

function findHistoryIndex(history) {
  if (editor.historyId) {
    const byId = history.findIndex((entry) => entry.id === editor.historyId);
    if (byId >= 0) return byId;
  }
  return history.findIndex((entry) => entry.baseName === editor.baseName);
}

async function saveProjectToHistory() {
  if (!editor.historyReady || !editor.baseName || !editor.baseCanvas) return;

  const { history = [] } = await chrome.storage.local.get("history");
  const index = findHistoryIndex(history);
  if (index < 0) return;

  const project = cloneProject();
  history[index] = {
    ...history[index],
    project,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ history });
}

// `pngBlob`, when the caller already encoded the output, saves encoding a
// large image twice.
async function saveRenderedProjectToHistory(outputCanvas, pngBlob) {
  if (editor.parts) return saveRenderedPartToHistory();
  if (!editor.historyReady || !editor.baseName || !editor.baseCanvas || !outputCanvas) return;

  const { history = [] } = await chrome.storage.local.get("history");
  const index = findHistoryIndex(history);
  if (index < 0) return;

  const entry = history[index];
  const id = entry.id || editor.historyId || FpsImages.newId();
  const baseKey = entry.baseKey || entry.imageKey;
  const shown = await storeShownImage(id, baseKey, outputCanvas, pngBlob);
  // An entry whose thumbnail key changed leaves the old one behind otherwise.
  if (entry.thumbKey && entry.thumbKey !== shown.thumbKey) await FpsImages.remove(entry.thumbKey);

  const { history: latest = [] } = await chrome.storage.local.get("history");
  const at = latest.findIndex((item) => item.id === entry.id && item.baseName === entry.baseName);
  if (at < 0) return;
  latest[at] = {
    ...latest[at],
    id,
    baseKey,
    ...shown,
    height: outputCanvas.height,
    project: cloneProject(),
    updatedAt: Date.now(),
    width: outputCanvas.width,
  };
  await chrome.storage.local.set({ history: latest });
}

function scheduleProjectHistorySave() {
  if (!editor.historyReady) return;

  clearTimeout(editor.historySaveTimer);
  editor.historySaveTimer = setTimeout(() => {
    saveProjectToHistory().catch((err) => {
      console.warn("Unable to save editable screenshot project:", err);
    });
  }, 450);
}

async function saveUploadToHistory(url) {
  const { history = [] } = await chrome.storage.local.get("history");
  const uploadedAt = Date.now();
  const uploadExpiresAt = uploadedAt + 3 * 60 * 60 * 1000;
  const index = findHistoryIndex(history);
  if (index < 0) return;

  history[index] = {
    ...history[index],
    uploadedAt,
    uploadExpiresAt,
    uploadUrl: url,
  };
  await chrome.storage.local.set({ history });
}

const NOTICE_ICONS = {
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#BDBDBD" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>',
  warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5B83D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z"></path><path d="M12 10v4M12 17h.01"></path></svg>',
};

// One notice per capture, its wording built from everything that happened:
// a capture can succeed only partially (budgets stop very long pages, pinned
// elements can hide rows, a mid-capture zoom breaks alignment), images may
// not have loaded, and a page too tall for one image is saved in parts. A
// warning icon means something is missing; info means it is all there. Of
// the two fixes, recapturing comes first: it changes what was captured.
function captureNotice(capture, report) {
  const messages = [];
  let warning = false;
  let action = null;
  const truncated = capture.truncated;
  if (truncated?.reason === "height") {
    const limit = Number(/(\d+)px/.exec(truncated.message || "")?.[1]);
    messages.push(
      limit
        ? `Stopped at the ${limit.toLocaleString("en-US")}px limit; the page is taller.`
        : truncated.message
    );
    warning = true;
  } else if (truncated?.message) {
    messages.push(`Partial capture: ${truncated.message}`);
    warning = true;
  }
  if (report.scaleWarning) {
    messages.push(report.scaleWarning);
    warning = true;
  }
  if (report.downscaled) {
    messages.push(
      `The page was taller than a single image can be, so it was scaled to ${Math.round(
        report.downscaled * 100
      )}% to fit rather than cut short.`
    );
  }
  if (report.gaps?.length) {
    const missing = report.gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0);
    messages.push(`${Math.round(missing)}px of the page could not be captured.`);
    warning = true;
  }
  const loading = capture.loading;
  if (loading?.frames > 0 && capture.sourceTabId) {
    if (loading.waited) {
      messages.push("Some images still hadn't loaded, even after waiting.");
    } else {
      messages.push("Some images hadn't finished loading.");
      action = {
        label: "Recapture, waiting for images",
        run: async () => {
          const response = await chrome.runtime.sendMessage({
            type: "recapture",
            tabId: capture.sourceTabId,
            url: capture.pageUrl,
          });
          if (!response?.ok) throw new Error(response?.error || "Couldn't recapture the page.");
        },
      };
    }
  }
  if (editor.parts) {
    const count = editor.parts.length;
    messages.push(
      truncated?.reason === "height"
        ? `Saved in ${count} parts at full resolution.`
        : `Too tall for one image, so it's saved in ${count} parts at full resolution.`
    );
    action = action || {
      label: "Save as one smaller image",
      run: () => document.querySelector('[data-download="smaller"]').click(),
    };
  }
  if (!messages.length) return null;
  return { text: messages.join(" "), kind: warning ? "warning" : "info", action };
}

// A notice above the screenshot, with an optional action and a close button.
function addNotice({ text, kind = "info", action = null }) {
  const box = document.createElement("div");
  box.className = "notice";
  box.setAttribute("role", "status");
  box.insertAdjacentHTML("beforeend", NOTICE_ICONS[kind] || NOTICE_ICONS.info);
  const message = document.createElement("p");
  message.textContent = text;
  box.appendChild(message);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notice-action";
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action.run();
      } catch (err) {
        message.textContent = err.message || String(err);
      } finally {
        button.disabled = false;
      }
    });
    box.appendChild(button);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.innerHTML = CLOSE_ICON;
  dismiss.addEventListener("click", () => {
    box.remove();
    renderOverlay();
    syncNavigator();
  });
  box.appendChild(dismiss);
  document.getElementById("notices").replaceChildren(box);
}

function showCaptureNotices(capture, report) {
  const notice = captureNotice(capture, report);
  if (notice) addNotice(notice);
}

async function main() {
  const status = document.getElementById("status");
  const stored = await chrome.storage.local.get("capture");
  let capture = stored.capture;
  if (!capture) {
    status.classList.remove("loading");
    status.textContent =
      "No capture found. Click the extension button on a page first.";
    return;
  }

  // History from an older version may not have been moved yet if the worker
  // has not run since the update; the base image has to be found either way.
  await FpsImages.migrateLegacyHistory().catch((err) => console.warn("History migration failed:", err));
  // Frames handed over for viewer-side stitching, deleted once the editor has
  // its own copy of the image.
  const handedFrames = (capture.frames || []).map((frame) => frame.key).filter(Boolean);

  if (capture.parts?.length > 1) editor.parts = capture.parts.map((part) => ({ ...part }));

  if (capture.prestitched && !capture.frames?.length) {
    // A split capture opens on its first part.
    const first = editor.parts ? editor.parts[0] : null;
    const blob = await FpsImages.get(first ? first.imageKey : capture.baseKey || capture.imageKey);
    if (!blob) throw new Error("The prepared screenshot could not be found in history.");
    capture = {
      ...capture,
      frames: [{ x: 0, y: 0, blob }],
      metrics: {
        ...capture.metrics,
        viewportWidth: first?.width || capture.prestitchedReport?.width || capture.metrics.viewportWidth,
        viewportHeight: first?.height || capture.prestitchedReport?.height || capture.metrics.viewportHeight,
        dpr: 1,
      },
    };
  }
  if (capture.historyId) editor.historyId = capture.historyId;

  const { frames, pageTitle } = capture;
  document.getElementById("title").textContent = pageTitle || "Screenshot";
  document.title = `Screenshot - ${pageTitle || ""}`;

  status.textContent = "Loading captured frames";
  const images = await Promise.all(frames.map(loadFrameImage));
  status.textContent = "Stitching screenshot";
  const stitchReport = {};
  editor.baseCanvas = drawCapture(capture, images, stitchReport);
  editor.baseDisplayCanvas = document.getElementById("baseDisplayCanvas");
  editor.baseDisplayCtx = editor.baseDisplayCanvas.getContext("2d");
  editor.canvas = document.getElementById("editorCanvas");
  editor.ctx = editor.canvas.getContext("2d");
  syncDisplayCanvases();
  const baseName = capture.baseName || buildBaseName(capture);
  editor.baseName = baseName;
  editor.exportBaseName = baseName;
  editor.pageUrl = capture.pageUrl || "";
  editor.capturedAt = capture.capturedAt || Date.now();
  const defaults = await loadEditorDefaults();
  editor.textHintUses = (await chrome.storage.local.get("textHintUses")).textHintUses || 0;
  if (defaults.jpegQuality) editor.jpegQuality = defaults.jpegQuality;
  // A reopened project keeps its own layout; a new capture starts from the
  // saved default.
  if (defaults.layout && !capture.project?.layout) editor.layout = { ...editor.layout, ...defaults.layout };
  loadProjectState(capture.project);
  redraw();

  syncMeta();

  setupDownloadActions(baseName);
  setupPartControls();
  setupDownloadMenu(baseName);
  setupJpegQuality(baseName);
  await setupCopyButton();
  await setupUploadButton();
  if (capture.fromHistory || capture.historySaved) {
    editor.historyReady = true;
    if (capture.fromHistory) await saveProjectToHistory();
  } else {
    status.textContent = "Saving to history";
    await autoSaveHistory(capture);
  }
  markExportsStale(baseName, { quiet: true });
  status.textContent = "Preparing editor";
  if (defaults.style) setCurrentStyle(defaults.style);
  setupAnnotationControls(baseName);
  setupLayoutControls(baseName);
  setupPanelTabs();
  setupNavigator();

  document.getElementById("canvasShell").hidden = false;
  document.getElementById("annotationPanel").hidden = false;
  document.getElementById("toolRail").hidden = false;
  document.getElementById("actions").hidden = false;
  setupZoomControls();
  status.classList.remove("loading");

  status.hidden = true;
  showCaptureNotices(capture, stitchReport);

  // The frames are large; drop them now that the image is rendered and saved.
  await chrome.storage.local.remove("capture");
  await FpsImages.remove(handedFrames);
}

main().catch((err) => {
  const status = document.getElementById("status");
  status.classList.remove("loading");
  status.textContent = `Failed to stitch: ${err}`;
});
