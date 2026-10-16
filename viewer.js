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
};

const toolHints = {
  arrow: "Drag to draw an arrow.",
  rect: "Drag to draw a box.",
  crop: "Drag to crop the screenshot.",
  pen: "Drag to draw freehand.",
  text: "Click the screenshot, then type.",
  step: "Click to place a numbered marker.",
  blur: "Drag over content to blur it.",
  pixelate: "Drag over content to pixelate it.",
  redact: "Drag over content to cover it.",
};

const defaultStyle = { color: "#ff453a", strokeWidth: 5, textSize: 28 };
const MAX_EDITOR_PREVIEW_PIXELS = 24000000;

const shortcutToolMap = {
  a: "arrow",
  b: "rect",
  c: "crop",
  p: "pen",
  t: "text",
  s: "step",
  u: "blur",
  x: "pixelate",
  r: "redact",
};

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
  if (!options.quiet) showExportStatus("Edited", "pending");
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

function currentStyle() {
  return {
    color: document.getElementById("color").value,
    strokeWidth: Number(document.getElementById("stroke").value),
    textSize: Number(document.getElementById("textSize").value),
  };
}

function setCurrentColor(value) {
  const color = document.getElementById("color");
  if (!color) return;

  color.value = value;
  syncSwatchesForColor();
  syncColorButtons(value);
}

function setCurrentStyle(style) {
  const color = document.getElementById("color");
  const stroke = document.getElementById("stroke");
  const strokeValue = document.getElementById("strokeValue");
  const textSize = document.getElementById("textSize");
  const textSizeValue = document.getElementById("textSizeValue");

  if (style.color && color) color.value = style.color;
  if (style.strokeWidth && stroke) {
    stroke.value = String(style.strokeWidth);
  }
  if (style.textSize && textSize) {
    textSize.value = String(style.textSize);
    if (textSizeValue) textSizeValue.textContent = `${textSize.value} px`;
  }
  syncSwatchesForColor();
  if (color) syncColorButtons(color.value);
  syncStrokeValueLabel();
  renderStylePreview();
}

function syncColorButtons(value) {
  if (!value) return;
  const normalized = value.toLowerCase();
  document.querySelectorAll("[data-mini-color]").forEach((button) => {
    button.classList.toggle("active", button.dataset.miniColor.toLowerCase() === normalized);
  });
}

function textFromEditor(element) {
  return element.innerText.replace(/\n+$/g, "").trim();
}

function openTextEditor(point, baseName) {
  if (editor.activeTextInput) editor.activeTextInput.finish(true);

  const shell = document.getElementById("canvasShell");
  const canvasRect = editor.canvas.getBoundingClientRect();
  const shellRect = shell.getBoundingClientRect();
  const scaleX = canvasRect.width / editor.baseCanvas.width;
  const scaleY = canvasRect.height / editor.baseCanvas.height;
  const wrap = document.createElement("div");
  const input = document.createElement("div");
  const actions = document.createElement("div");
  const cancel = document.createElement("button");
  const done = document.createElement("button");
  let finished = false;

  wrap.className = "text-editor-wrap";
  wrap.style.left = `${canvasRect.left - shellRect.left + point.x * scaleX}px`;
  wrap.style.top = `${canvasRect.top - shellRect.top + point.y * scaleY}px`;
  input.className = "text-editor";
  input.contentEditable = "true";
  input.dataset.placeholder = "Type text";
  actions.className = "text-editor-actions";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  done.type = "button";
  done.className = "primary";
  done.textContent = "Done";
  actions.append(cancel, done);
  wrap.append(input, actions);
  shell.appendChild(wrap);

  function syncStyle() {
    const style = currentStyle();
    input.style.color = style.color;
    input.style.fontSize = `${Math.max(13, style.textSize * scaleY)}px`;
    input.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.85)";
  }

  function finish(commit) {
    if (finished) return;
    finished = true;
    const text = textFromEditor(input);
    wrap.remove();
    editor.activeTextInput = null;

    if (commit && text) {
      pushOperation({ type: "text", point, text, ...currentStyle() }, baseName);
    }
  }

  editor.activeTextInput = { finish, syncStyle };

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
  cancel.addEventListener("click", () => finish(false));
  done.addEventListener("click", () => finish(true));
  syncStyle();
  requestAnimationFrame(() => input.focus());
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
  const total = editor.parts.reduce((sum, part) => sum + part.height, 0);
  document.getElementById("dimensions").textContent =
    `${editor.baseCanvas.width} x ${editor.baseCanvas.height}px of ${total}px`;
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

async function exportBusy(anchor, work) {
  if (anchor.dataset.busy) return;
  anchor.dataset.busy = "1";
  const label = anchor.textContent;
  anchor.textContent = "Preparing...";
  try {
    await work();
  } catch (err) {
    console.error("Export failed:", err);
    showExportStatus("Export failed", "error");
  } finally {
    anchor.textContent = label;
    delete anchor.dataset.busy;
  }
}

function setupPartControls(baseName) {
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

  const width = Math.max(...editor.parts.map((part) => part.width));
  const all = document.getElementById("downloadAll");
  const zip = document.getElementById("downloadZip");
  const pdf = document.getElementById("downloadPdf");
  all.hidden = false;
  zip.hidden = false;
  all.addEventListener("click", (event) => {
    event.preventDefault();
    exportBusy(all, async () => {
      downloadBlob(await FpsExport.stackToPng(await partSources(), width), `${baseName}.png`);
    });
  });
  zip.addEventListener("click", (event) => {
    event.preventDefault();
    exportBusy(zip, async () => {
      const files = [];
      const sources = await partSources();
      for (let i = 0; i < sources.length; i++) {
        const blob = sources[i] instanceof Blob ? sources[i] : await canvasToBlob(sources[i], "image/png");
        files.push({ name: `${baseName}-part-${i + 1}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      downloadBlob(new Blob(FpsExport.zipStore(files), { type: "application/zip" }), `${baseName}.zip`);
    });
  });
  // A split capture's PDF has a page per part, built when asked for.
  pdf.title = "Download PDF (one page per part)";
  pdf.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      exportBusy(pdf, async () => {
        const pages = [];
        for (const source of await partSources()) {
          const canvas = source instanceof Blob ? await blobToCanvas(source) : source;
          const jpeg = await canvasToBlob(makeJpegCanvas(canvas), "image/jpeg", editor.jpegQuality);
          pages.push({ jpegBytes: new Uint8Array(await jpeg.arrayBuffer()), width: canvas.width, height: canvas.height });
        }
        downloadBlob(makePdfPages(pages), `${baseName}.pdf`);
      });
    },
    true
  );
  syncPartNav();
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

function syncSwatchesForColor() {
  const color = document.getElementById("color");
  if (!color) return;

  document.querySelectorAll("[data-color]").forEach((swatch) => {
    swatch.classList.toggle(
      "active",
      swatch.dataset.color.toLowerCase() === color.value.toLowerCase()
    );
  });
}

function loadOperationStyle(operation) {
  if (!operation) return;

  const color = document.getElementById("color");
  const stroke = document.getElementById("stroke");
  const strokeValue = document.getElementById("strokeValue");
  const textSize = document.getElementById("textSize");
  const textSizeValue = document.getElementById("textSizeValue");

  if (operation.color && color) color.value = operation.color;
  if (operation.strokeWidth && stroke) {
    stroke.value = String(operation.strokeWidth);
  }
  if (operation.textSize && textSize) {
    textSize.value = String(operation.textSize);
    if (textSizeValue) textSizeValue.textContent = `${textSize.value} px`;
  }
  syncSwatchesForColor();
  if (color) syncColorButtons(color.value);
  syncStyleControlVisibility();
  renderStylePreview();
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
  renderStylePreview();
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

function nextStepNumber() {
  return (
    editor.operations
      .filter((operation) => operation.type === "step")
      .reduce((max, operation) => Math.max(max, operation.number || 0), 0) + 1
  );
}

function textBounds(operation) {
  const ctx = editor.ctx;
  const lines = operation.text.split("\n");
  const lineHeight = operation.textSize * 1.22;
  ctx.save();
  ctx.font = `700 ${operation.textSize}px system-ui, sans-serif`;
  const width = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
  ctx.restore();
  return {
    x: operation.point.x,
    y: operation.point.y,
    width,
    height: lineHeight * lines.length,
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
    const radius = operation.radius || Math.max(36, operation.textSize * 1.24);
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

function syncMiniToolbar() {
  const toolbar = document.getElementById("miniToolbar");
  if (toolbar) {
    toolbar.hidden = true;
    toolbar.classList.remove("visible");
  }
}

function containsPoint(rect, point, padding = 0) {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

function selectionHandles(operation) {
  if (operation.type === "arrow") {
    return [
      { name: "from", x: operation.from.x, y: operation.from.y },
      { name: "to", x: operation.to.x, y: operation.to.y },
    ];
  }
  const bounds = operationBounds(operation);
  return [
    { name: "nw", x: bounds.x, y: bounds.y },
    { name: "ne", x: bounds.x + bounds.width, y: bounds.y },
    { name: "se", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { name: "sw", x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function handleAtPoint(operation, point) {
  const scale = editor.baseCanvas.width / editor.canvas.getBoundingClientRect().width;
  const radius = Math.max(8, 6 * scale);
  return selectionHandles(operation).find(
    (handle) => Math.hypot(handle.x - point.x, handle.y - point.y) <= radius
  );
}

function operationAtPoint(point) {
  for (let i = editor.operations.length - 1; i >= 0; i--) {
    if (containsPoint(operationBounds(editor.operations[i]), point, 8)) return i;
  }
  return -1;
}

function drawSelection(ctx) {
  const operation = editor.operations[editor.selectedIndex];
  if (!operation) return;

  const bounds = operationBounds(operation);
  ctx.save();
  ctx.strokeStyle = "#78a0ff";
  ctx.lineWidth = Math.max(2, editor.baseCanvas.width / editor.canvas.getBoundingClientRect().width);
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#4f7cff";
  for (const handle of selectionHandles(operation)) {
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, Math.max(5, ctx.lineWidth * 3), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
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

function resizeBounds(startBounds, handle, point) {
  const left = handle === "nw" || handle === "sw" ? point.x : startBounds.x;
  const right =
    handle === "ne" || handle === "se" ? point.x : startBounds.x + startBounds.width;
  const top = handle === "nw" || handle === "ne" ? point.y : startBounds.y;
  const bottom =
    handle === "sw" || handle === "se" ? point.y : startBounds.y + startBounds.height;
  const normalized = normalizeRect({ x: left, y: top }, { x: right, y: bottom });
  return {
    x: normalized.x,
    y: normalized.y,
    width: Math.max(4, normalized.width),
    height: Math.max(4, normalized.height),
  };
}

function resizeOperation(operation, startOperation, startBounds, handle, point) {
  if (operation.type === "arrow") {
    if (handle === "from") operation.from = { ...point };
    if (handle === "to") operation.to = { ...point };
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
    operation.point = { x: nextBounds.x, y: nextBounds.y };
    operation.textSize = Math.max(8, Math.round(startOperation.textSize * scale));
    return;
  }
  if (operation.type === "step") {
    operation.point = {
      x: nextBounds.x + nextBounds.width / 2,
      y: nextBounds.y + nextBounds.height / 2,
    };
    operation.radius = Math.max(18, Math.min(nextBounds.width, nextBounds.height) / 2);
  }
}

function renderStylePreview() {
  const canvas = document.getElementById("stylePreview");
  if (!canvas) return;

  const cssWidth = 132;
  const cssHeight = 44;
  const scale = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== cssWidth * scale || canvas.height !== cssHeight * scale) {
    canvas.width = cssWidth * scale;
    canvas.height = cssHeight * scale;
  }

  const ctx = canvas.getContext("2d");
  const style = currentStyle();
  const previewTool = styleControlTool();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (previewTool === "text") {
    drawText(ctx, {
      type: "text",
      point: { x: 14, y: 12 },
      text: "Text",
      ...style,
    });
    return;
  }
  if (previewTool === "step") {
    drawStep(ctx, {
      type: "step",
      point: { x: cssWidth / 2, y: cssHeight / 2 },
      number: nextStepNumber(),
      radius: 17,
      ...style,
    });
    return;
  }
  if (previewTool === "rect") {
    drawRect(ctx, {
      type: "rect",
      rect: { x: 24, y: 13, width: 84, height: 20 },
      ...style,
    });
    return;
  }
  if (previewTool === "pen") {
    drawPen(ctx, {
      type: "pen",
      points: [
        { x: 20, y: 36 },
        { x: 50, y: 15 },
        { x: 78, y: 34 },
        { x: 110, y: 16 },
      ],
      ...style,
    });
    return;
  }
  if (previewTool === "pixelate") {
    ctx.fillStyle = "#344055";
    ctx.fillRect(24, 13, 84, 20);
    ctx.fillStyle = "#78a0ff";
    for (let x = 24; x < 108; x += 12) {
      for (let y = 13; y < 33; y += 12) ctx.fillRect(x, y, 10, 10);
    }
    return;
  }
  if (previewTool === "blur") {
    ctx.fillStyle = "#344055";
    ctx.fillRect(24, 13, 84, 20);
    ctx.fillStyle = "#e8edf6";
    ctx.fillRect(34, 18, 64, 4);
    ctx.fillRect(34, 26, 52, 4);
    applyBlur(ctx, {
      type: "blur",
      rect: { x: 24, y: 13, width: 84, height: 20 },
      ...style,
    });
    return;
  }
  if (previewTool === "redact") {
    applyRedact(ctx, {
      type: "redact",
      rect: { x: 24, y: 13, width: 84, height: 20 },
      ...style,
    });
    return;
  }
  drawArrow(ctx, {
    type: "arrow",
    from: { x: 20, y: 34 },
    to: { x: 112, y: 14 },
    ...style,
  });
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

function drawArrow(ctx, operation) {
  const { from, to, color, strokeWidth } = operation;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const arrowLength = Math.hypot(to.x - from.x, to.y - from.y);
  if (arrowLength < 1) return;

  const shaftWidth = Math.max(3, strokeWidth);
  const tailHalf = shaftWidth * 0.42;
  const neckHalf = shaftWidth * 0.72;
  const headLength = Math.min(arrowLength * 0.42, Math.max(16, shaftWidth * 3.4));
  const headWidth = Math.min(arrowLength * 0.5, Math.max(headLength * 0.82, shaftWidth * 2.35));
  const headHalf = headWidth / 2;
  const unitX = Math.cos(angle);
  const unitY = Math.sin(angle);
  const perpendicularX = -unitY;
  const perpendicularY = unitX;
  const base = {
    x: to.x - unitX * headLength,
    y: to.y - unitY * headLength,
  };
  const shaftEnd = {
    x: base.x + unitX * Math.min(shaftWidth * 0.18, headLength * 0.18),
    y: base.y + unitY * Math.min(shaftWidth * 0.18, headLength * 0.18),
  };

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.min(3.5, Math.max(1.2, shaftWidth * 0.16));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  applyAnnotationShadow(ctx, shaftWidth);

  ctx.beginPath();
  ctx.moveTo(from.x + perpendicularX * tailHalf, from.y + perpendicularY * tailHalf);
  ctx.lineTo(shaftEnd.x + perpendicularX * neckHalf, shaftEnd.y + perpendicularY * neckHalf);
  ctx.lineTo(base.x + perpendicularX * headHalf, base.y + perpendicularY * headHalf);
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(base.x - perpendicularX * headHalf, base.y - perpendicularY * headHalf);
  ctx.lineTo(shaftEnd.x - perpendicularX * neckHalf, shaftEnd.y - perpendicularY * neckHalf);
  ctx.lineTo(from.x - perpendicularX * tailHalf, from.y - perpendicularY * tailHalf);
  ctx.arc(from.x, from.y, tailHalf, angle - Math.PI / 2, angle + Math.PI / 2, true);
  ctx.closePath();
  ctx.fill();

  clearAnnotationShadow(ctx);
  ctx.stroke();
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

function drawStep(ctx, operation) {
  const radius = operation.radius || Math.max(36, operation.textSize * 1.24);

  ctx.save();
  ctx.fillStyle = operation.color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(2, operation.strokeWidth);
  applyAnnotationShadow(ctx, radius * 0.35);
  ctx.beginPath();
  ctx.arc(operation.point.x, operation.point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

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

function drawEffectOutline(ctx, operation) {
  const { rect } = operation;
  if (!rect || rect.width < 2 || rect.height < 2) return;

  ctx.save();
  ctx.strokeStyle = operation.type === "redact" ? "#f2f4f8" : "#78a0ff";
  ctx.lineWidth = Math.max(2, operation.strokeWidth || 2);
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
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
    drawEffectOutline(ctx, operation);
    return;
  }

  if (
    operation.type === "redact" ||
    operation.type === "blur" ||
    operation.type === "crop"
  ) {
    ctx.save();
    ctx.strokeStyle = operation.type === "redact" ? "#f2f4f8" : "#78a0ff";
    if (operation.type === "crop") {
      ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
      ctx.beginPath();
      ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.rect(operation.rect.x, operation.rect.y, operation.rect.width, operation.rect.height);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#ffffff";
    }
    ctx.lineWidth = Math.max(2, operation.strokeWidth);
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(
      operation.rect.x,
      operation.rect.y,
      operation.rect.width,
      operation.rect.height
    );
    ctx.restore();
    return;
  }
  applyOperation(ctx, operation);
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

function drawEffectMarker(ctx, operation) {
  const { rect } = operation;
  if (!rect || rect.width < 2 || rect.height < 2) return;

  ctx.save();
  ctx.fillStyle =
    operation.type === "pixelate" ? "rgba(120, 160, 255, 0.14)" : "rgba(245, 248, 255, 0.12)";
  ctx.strokeStyle = operation.type === "pixelate" ? "#78a0ff" : "#f2f4f8";
  ctx.lineWidth = Math.max(2, operation.strokeWidth || 2);
  ctx.setLineDash([10, 8]);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawEditorOperation(ctx, operation) {
  if (operation.type === "pixelate") {
    drawPixelatedBaseRegion(ctx, operation);
    return;
  }
  if (operation.type === "blur") {
    drawEffectMarker(ctx, operation);
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
  if (!preview) drawSelection(editor.ctx);
  if (!preview) syncMiniToolbar();
  editor.ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function makeDragOperation(tool, start, end) {
  const style = currentStyle();
  if (tool === "arrow") {
    return { type: "arrow", from: start, to: end, ...style };
  }
  if (tool === "redact") {
    return { type: tool, rect: normalizeRect(start, end), ...style, color: "#111111" };
  }
  if (tool === "rect" || tool === "pixelate" || tool === "blur" || tool === "crop") {
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
  document.getElementById("dimensions").textContent = `${width} x ${height}px`;
  redraw();
  applyZoom(fitZoom(), "fit");
  markExportsStale(baseName);
}

function showExportStatus(text, state = "pending") {
  const status = document.getElementById("exportStatus");
  if (!status) return;

  clearTimeout(editor.exportStatusTimer);
  status.hidden = false;
  status.textContent = text;
  status.classList.toggle("done", state === "done");
  if (state === "done") {
    editor.exportStatusTimer = setTimeout(() => {
      status.hidden = true;
      status.classList.remove("done");
    }, 1200);
  }
}

function scheduleExportRefresh(baseName) {
  markExportsStale(baseName);
}

function pulseFeedback(element) {
  element.classList.remove("feedback");
  void element.offsetWidth;
  element.classList.add("feedback");
}

function setButtonLabel(button, icon, text) {
  button.textContent = "";
  const iconElement = document.createElement("span");
  iconElement.className = "icon";
  iconElement.setAttribute("aria-hidden", "true");
  if (icon === "copy") {
    iconElement.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="11" height="11" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
  } else if (icon === "upload") {
    iconElement.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12"></path>
        <path d="m7 8 5-5 5 5"></path>
        <path d="M5 21h14"></path>
      </svg>
    `;
  } else {
    iconElement.textContent = icon;
  }
  button.append(iconElement, document.createTextNode(text));
}

function syncEditActionState() {
  const undo = document.getElementById("undo");
  const redo = document.getElementById("redo");
  const clear = document.getElementById("clear");
  if (!undo || !redo || !clear) return;

  undo.disabled = editor.undoStack.length === 0;
  redo.disabled = editor.redoStack.length === 0;
  clear.disabled = editor.operations.length === 0;
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

function syncStrokeValueLabel() {
  const stroke = document.getElementById("stroke");
  const strokeValue = document.getElementById("strokeValue");
  if (!stroke || !strokeValue) return;

  const rawValue = Number(stroke.value);
  const tool = styleControlTool();
  const value = tool === "pixelate" ? Math.max(6, rawValue * 4) : rawValue;
  strokeValue.textContent = `${value} px`;
}

function syncStyleControlVisibility() {
  const colorControl = document.getElementById("colorControl");
  const colorSwatches = document.getElementById("colorSwatches");
  const strokeControl = document.getElementById("strokeControl");
  const strokeLabel = document.getElementById("strokeLabel");
  const textSizeControl = document.getElementById("textSizeControl");
  if (!colorControl || !strokeControl || !textSizeControl) return;

  const tool = styleControlTool();
  const showColor = ["arrow", "rect", "pen", "text", "step"].includes(tool);
  const showStroke = ["arrow", "rect", "pen", "pixelate", "blur"].includes(tool);
  const showTextSize = ["text", "step"].includes(tool);

  colorControl.hidden = !showColor;
  if (colorSwatches) colorSwatches.hidden = !showColor;
  strokeControl.hidden = !showStroke;
  textSizeControl.hidden = !showTextSize;
  if (strokeLabel) {
    strokeLabel.textContent =
      tool === "pixelate" ? "Block size" : tool === "blur" ? "Blur" : "Stroke";
  }
  syncStrokeValueLabel();
}

function clampZoom(value) {
  return Math.min(4, Math.max(0.08, value));
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

function fitZoom() {
  const stage = document.querySelector(".stage");
  if (!stage || !editor.canvas) return 1;

  const style = getComputedStyle(stage);
  const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const available = Math.max(120, stage.clientWidth - horizontalPadding);
  const layoutWidth = editor.layout.enabled ? editor.layout.padding * 2 : 0;
  return clampZoom(Math.min(1, available / (editor.baseCanvas.width + layoutWidth)));
}

function zoomLabel(value, mode = editor.zoomMode) {
  if (mode === "fit") return "Fit";
  return `${Math.round(value * 100)}%`;
}

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
  if (zoomValue) zoomValue.textContent = zoomLabel(next, mode);
  requestAnimationFrame(syncMiniToolbar);
}

function setupZoomControls() {
  const controls = document.getElementById("zoomControls");
  const zoomOut = document.getElementById("zoomOut");
  const zoomIn = document.getElementById("zoomIn");
  const zoomFit = document.getElementById("zoomFit");
  const zoomActual = document.getElementById("zoomActual");
  if (!controls || !zoomOut || !zoomIn || !zoomFit || !zoomActual) return;

  controls.hidden = false;
  zoomOut.addEventListener("click", () => applyZoom(editor.zoom / 1.2));
  zoomIn.addEventListener("click", () => applyZoom(editor.zoom * 1.2));
  zoomFit.addEventListener("click", () => applyZoom(fitZoom(), "fit"));
  zoomActual.addEventListener("click", () => applyZoom(1, "actual"));
  window.addEventListener("resize", () => {
    if (editor.zoomMode === "fit") applyZoom(fitZoom(), "fit");
  });

  requestAnimationFrame(() => applyZoom(fitZoom(), "fit"));
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

function setupJpegQuality(baseName) {
  const input = document.getElementById("jpegQuality");
  const label = document.getElementById("jpegQualityValue");
  if (!input) return;
  input.value = String(Math.round(editor.jpegQuality * 100));
  label.textContent = input.value;
  input.addEventListener("input", () => {
    label.textContent = input.value;
  });
  input.addEventListener("change", async () => {
    editor.jpegQuality = Number(input.value) / 100;
    await saveEditorDefaults({ jpegQuality: editor.jpegQuality });
    scheduleExportRefresh(baseName);
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
    anchor.addEventListener("click", () => pulseFeedback(anchor));
  }
}

function syncLayoutControlValues() {
  const controls = document.getElementById("layoutControls");
  const enabled = document.getElementById("layoutEnabled");
  const background = document.getElementById("layoutBackground");
  const aspect = document.getElementById("layoutAspect");
  const padding = document.getElementById("layoutPadding");
  const paddingValue = document.getElementById("layoutPaddingValue");
  const radius = document.getElementById("layoutRadius");
  const radiusValue = document.getElementById("layoutRadiusValue");
  const shadow = document.getElementById("layoutShadow");
  const shadowValue = document.getElementById("layoutShadowValue");
  if (!enabled || !background || !aspect || !padding || !radius || !shadow) return;

  enabled.checked = Boolean(editor.layout.enabled);
  if (controls) controls.hidden = !enabled.checked;
  document.getElementById("layoutFrame").value = editor.layout.frame || "none";
  document.getElementById("layoutFrameAddress").checked = editor.layout.frameAddress !== false;
  document.getElementById("layoutStamp").value = editor.layout.stamp || "none";
  document.getElementById("layoutStampUrl").checked = !!editor.layout.stampUrl;
  background.value = editor.layout.background;
  aspect.value = editor.layout.aspect;
  padding.value = String(editor.layout.padding);
  radius.value = String(editor.layout.radius);
  shadow.value = String(editor.layout.shadow);
  if (paddingValue) paddingValue.textContent = `${editor.layout.padding} px`;
  if (radiusValue) radiusValue.textContent = `${editor.layout.radius} px`;
  if (shadowValue) shadowValue.textContent = `${editor.layout.shadow} px`;
}

function setupLayoutControls(baseName) {
  const controls = document.getElementById("layoutControls");
  const enabled = document.getElementById("layoutEnabled");
  const background = document.getElementById("layoutBackground");
  const aspect = document.getElementById("layoutAspect");
  const padding = document.getElementById("layoutPadding");
  const paddingValue = document.getElementById("layoutPaddingValue");
  const radius = document.getElementById("layoutRadius");
  const radiusValue = document.getElementById("layoutRadiusValue");
  const shadow = document.getElementById("layoutShadow");
  const shadowValue = document.getElementById("layoutShadowValue");
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
    if (paddingValue) paddingValue.textContent = `${editor.layout.padding} px`;
    if (radiusValue) radiusValue.textContent = `${editor.layout.radius} px`;
    if (shadowValue) shadowValue.textContent = `${editor.layout.shadow} px`;
    applyLayoutPreview();
    scheduleExportRefresh(baseName);
  }

  syncLayoutControlValues();
  for (const control of [frame, frameAddress, stamp, stampUrl]) control.addEventListener("change", refreshLayout);
  saveDefault.addEventListener("click", async () => {
    await saveEditorDefaults({ layout: cloneLayout() });
    saveDefault.textContent = "Saved as default";
    setTimeout(() => {
      saveDefault.textContent = "Use as default";
    }, 1400);
  });
  enabled.addEventListener("change", refreshLayout);
  background.addEventListener("change", refreshLayout);
  aspect.addEventListener("change", refreshLayout);
  padding.addEventListener("input", refreshLayout);
  radius.addEventListener("input", refreshLayout);
  shadow.addEventListener("input", refreshLayout);
}

function setupAnnotationControls(baseName) {
  const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
  const miniColorButtons = Array.from(document.querySelectorAll("[data-mini-color]"));
  const toolHint = document.getElementById("toolHint");
  const color = document.getElementById("color");
  const swatches = Array.from(document.querySelectorAll("[data-color]"));
  const stroke = document.getElementById("stroke");
  const strokeValue = document.getElementById("strokeValue");
  const textSize = document.getElementById("textSize");
  const textSizeValue = document.getElementById("textSizeValue");
  editor.canvas.dataset.currentTool = editor.currentTool;

  function syncToolSurface() {
    if (toolHint) toolHint.textContent = toolHints[editor.currentTool];
  }

  function selectTool(tool) {
    const button = toolButtons.find((item) => item.dataset.tool === tool);
    if (!button) return;

    finalizeStyleEdit();
    if (editor.activeTextInput) editor.activeTextInput.finish(true);
    editor.currentTool = tool;
    editor.selectedIndex = -1;
    editor.canvas.dataset.currentTool = editor.currentTool;
    if (tool === "redact") setCurrentColor("#111111");
    toolButtons.forEach((item) => item.classList.toggle("active", item === button));
    pulseFeedback(button);
    syncToolSurface();
    redraw();
    syncStyleControlVisibility();
    renderStylePreview();
  }

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => selectTool(button.dataset.tool));
  });

  function syncSwatches() {
    syncSwatchesForColor();
  }

  function loadSelectedStyle(operation) {
    loadOperationStyle(operation);
  }

  function updateSelectedStyle() {
    if (editor.selectedIndex < 0) return;
    const operation = editor.operations[editor.selectedIndex];
    if (!operation) return;

    const style = currentStyle();
    if (["arrow", "rect", "pen", "text", "step"].includes(operation.type)) {
      operation.color = style.color;
    }
    if (["arrow", "rect", "pen", "pixelate", "blur"].includes(operation.type)) {
      operation.strokeWidth = style.strokeWidth;
    }
    if (["text", "step"].includes(operation.type)) operation.textSize = style.textSize;
    if (operation.type === "step") operation.radius = Math.max(36, style.textSize * 1.24);
    redraw();
    scheduleExportRefresh(baseName);
  }

  function applyColor(value) {
    beginStyleEdit();
    setCurrentColor(value);
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    finalizeStyleEdit();
    renderStylePreview();
  }

  miniColorButtons.forEach((button) => {
    button.addEventListener("click", () => applyColor(button.dataset.miniColor));
  });

  swatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      beginStyleEdit();
      color.value = swatch.dataset.color;
      syncSwatches();
      syncColorButtons(color.value);
      if (editor.activeTextInput) editor.activeTextInput.syncStyle();
      updateSelectedStyle();
      finalizeStyleEdit();
      renderStylePreview();
    });
  });
  color.addEventListener("input", () => {
    beginStyleEdit();
    syncSwatches();
    syncColorButtons(color.value);
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });
  color.addEventListener("change", finalizeStyleEdit);
  color.addEventListener("blur", finalizeStyleEdit);

  stroke.addEventListener("input", () => {
    beginStyleEdit();
    syncStrokeValueLabel();
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });
  stroke.addEventListener("change", finalizeStyleEdit);
  stroke.addEventListener("blur", finalizeStyleEdit);
  textSize.addEventListener("input", () => {
    beginStyleEdit();
    textSizeValue.textContent = `${textSize.value} px`;
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });
  textSize.addEventListener("change", finalizeStyleEdit);
  textSize.addEventListener("blur", finalizeStyleEdit);

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
    renderStylePreview();
    scheduleExportRefresh(baseName);
  }

  function deleteSelectedOperation() {
    finalizeStyleEdit();
    if (editor.selectedIndex < 0) return;
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const index = editor.selectedIndex;
    const operation = cloneOperation(editor.operations[index]);
    editor.operations.splice(index, 1);
    editor.selectedIndex = -1;
    commitUndoAction({ type: "remove", operation, index });
    redraw();
    syncEditActionState();
    syncStyleControlVisibility();
    renderStylePreview();
    scheduleExportRefresh(baseName);
  }

  function duplicateSelectedOperation() {
    finalizeStyleEdit();
    const operation = editor.operations[editor.selectedIndex];
    if (!operation) return;
    const duplicate = cloneOperation(operation);
    delete duplicate.id;
    moveOperation(duplicate, 24, 24);
    pushOperation(duplicate, baseName);
  }

  document.getElementById("undo").addEventListener("click", undoOperation);
  document.getElementById("redo").addEventListener("click", redoOperation);
  document.getElementById("clear").addEventListener("click", clearAnnotations);
  document.getElementById("deleteSelected").addEventListener("click", deleteSelectedOperation);
  document.getElementById("duplicateSelected").addEventListener("click", duplicateSelectedOperation);

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

    if (event.key === "Escape") {
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(false);
      editor.selectedIndex = -1;
      editor.interaction = null;
      editor.draft = null;
      editor.dragStart = null;
      redraw();
      syncStyleControlVisibility();
      renderStylePreview();
      return;
    }

    if (!hasModifier && !event.altKey && !event.shiftKey && shortcutToolMap[key]) {
      event.preventDefault();
      selectTool(shortcutToolMap[key]);
    }
  });

  editor.canvas.addEventListener("pointerdown", (event) => {
    const point = pointerToCanvasPoint(event);
    const selected = editor.operations[editor.selectedIndex];
    const handle = selected ? handleAtPoint(selected, point) : null;
    if (selected && handle) {
      event.preventDefault();
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.interaction = {
        type: "resize",
        handle: handle.name,
        startOperation: cloneOperation(selected),
        startBounds: operationBounds(selected),
      };
      editor.canvas.setPointerCapture(event.pointerId);
      return;
    }

    const hitIndex = operationAtPoint(point);
    if (hitIndex >= 0) {
      event.preventDefault();
      finalizeStyleEdit();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.selectedIndex = hitIndex;
      loadSelectedStyle(editor.operations[hitIndex]);
      redraw();
      syncStyleControlVisibility();
      editor.interaction = {
        type: "move",
        lastPoint: point,
        startOperation: cloneOperation(editor.operations[hitIndex]),
      };
      editor.canvas.setPointerCapture(event.pointerId);
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
      syncStyleControlVisibility();
      pushOperation(
        {
          type: "step",
          point,
          number: nextStepNumber(),
          radius: Math.max(36, currentStyle().textSize * 1.24),
          ...currentStyle(),
        },
        baseName
      );
      renderStylePreview();
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
      editor.draft = { type: "pen", points: [point], ...currentStyle() };
    } else {
      editor.draft = makeDragOperation(editor.currentTool, point, point);
    }
  });

  editor.canvas.addEventListener("pointermove", (event) => {
    if (editor.interaction) {
      event.preventDefault();
      const point = pointerToCanvasPoint(event);
      const operation = editor.operations[editor.selectedIndex];
      if (!operation) return;

      if (editor.interaction.type === "move") {
        const dx = point.x - editor.interaction.lastPoint.x;
        const dy = point.y - editor.interaction.lastPoint.y;
        moveOperation(operation, dx, dy);
        editor.interaction.lastPoint = point;
      }
      if (editor.interaction.type === "resize") {
        resizeOperation(
          operation,
          editor.interaction.startOperation,
          editor.interaction.startBounds,
          editor.interaction.handle,
          point
        );
      }
      requestRedraw();
      return;
    }

    if (!editor.draft || !editor.dragStart) return;
    event.preventDefault();
    const point = pointerToCanvasPoint(event);
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
      if (operation.type === "crop") {
        cropToRect(operation.rect, baseName);
      } else {
        pushOperation(operation, baseName);
      }
    } else {
      redraw();
    }
  });

  editor.canvas.addEventListener("pointerup", (event) => {
    if (!editor.interaction) return;
    event.preventDefault();
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
    renderStylePreview();
    scheduleExportRefresh(baseName);
  });

  editor.canvas.addEventListener("pointercancel", () => {
    editor.draft = null;
    editor.dragStart = null;
    editor.interaction = null;
    redraw();
    syncStyleControlVisibility();
    renderStylePreview();
  });

  setCurrentStyle(defaultStyle);
  syncToolSurface();
  renderStylePreview();
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
      setButtonLabel(copy, "copy", "Copied");
      pulseFeedback(copy);
    } catch (err) {
      console.error("Copy failed:", err);
      setButtonLabel(copy, "copy", "Use PNG");
      const png = document.getElementById("downloadPng");
      if (png) {
        pulseFeedback(png);
        png.focus();
      }
      pulseFeedback(copy);
    } finally {
      setTimeout(() => {
        copy.disabled = false;
        copy.classList.remove("feedback");
        setButtonLabel(copy, "copy", "Copy");
      }, 1500);
    }
  });
}

async function setupUploadButton() {
  const upload = document.getElementById("upload");
  const defaultLabel = "Upload & copy URL";
  upload.addEventListener("click", async () => {
    upload.disabled = true;
    upload.classList.remove("danger");
    upload.classList.add("success");
    setButtonLabel(upload, "upload", "Uploading...");

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
      setButtonLabel(upload, "upload", "URL copied");
      pulseFeedback(upload);
    } catch (err) {
      if (err.name === "AbortError") {
        err.uiLabel = "Timed out";
      }
      console.error("Upload failed:", err);
      upload.classList.remove("success");
      upload.classList.add("danger");
      const label = err.uiLabel || (err.name === "TypeError" ? "Network failed" : "Upload failed");
      setButtonLabel(upload, "upload", label);
      pulseFeedback(upload);
    } finally {
      setTimeout(() => {
        upload.disabled = false;
        upload.classList.remove("feedback");
        upload.classList.remove("danger");
        upload.classList.add("success");
        setButtonLabel(upload, "upload", defaultLabel);
      }, 1800);
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

// A capture can succeed only partially: budgets stop very long pages, pinned
// elements can hide rows, and a mid-capture zoom breaks alignment. Say so
// rather than handing back a silently incomplete image.
function captureNotice(capture, report) {
  const parts = [];
  if (capture.truncated?.message) {
    parts.push(`Partial capture: ${capture.truncated.message}`);
  }
  if (report.scaleWarning) parts.push(report.scaleWarning);
  if (capture.parts?.length > 1) {
    parts.push(
      `This page was too tall for one image, so it was saved in ${capture.parts.length} parts at full resolution. ` +
        "Use the arrows (or [ and ]) to move between them; One PNG downloads the whole page as a single file."
    );
  }
  if (report.downscaled) {
    parts.push(
      `The page was taller than a single image can be, so it was scaled to ${Math.round(
        report.downscaled * 100
      )}% to fit rather than cut short.`
    );
  }
  if (report.gaps?.length) {
    const missing = report.gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0);
    parts.push(`${Math.round(missing)}px of the page could not be captured.`);
  }
  return parts.join(" ");
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
  if (defaults.jpegQuality) editor.jpegQuality = defaults.jpegQuality;
  // A reopened project keeps its own layout; a new capture starts from the
  // saved default.
  if (defaults.layout && !capture.project?.layout) editor.layout = { ...editor.layout, ...defaults.layout };
  loadProjectState(capture.project);
  redraw();

  document.getElementById(
    "dimensions"
  ).textContent = `${editor.baseCanvas.width} x ${editor.baseCanvas.height}px`;

  setupDownloadActions(baseName);
  setupPartControls(baseName);
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
  setupAnnotationControls(baseName);
  if (defaults.style) setCurrentStyle(defaults.style);
  // The annotation style carries over to the next screenshot.
  for (const id of ["color", "stroke", "textSize"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      saveEditorDefaults({ style: currentStyle() }).catch(() => {});
    });
  }
  setupLayoutControls(baseName);

  document.getElementById("canvasShell").hidden = false;
  document.getElementById("annotationPanel").hidden = false;
  document.getElementById("actions").hidden = false;
  setupZoomControls();
  status.classList.remove("loading");

  const notice = captureNotice(capture, stitchReport);
  if (notice) {
    status.textContent = notice;
    status.hidden = false;
  } else {
    status.hidden = true;
  }

  // The frames are large; drop them now that the image is rendered and saved.
  await chrome.storage.local.remove("capture");
  await FpsImages.remove(handedFrames);
}

main().catch((err) => {
  const status = document.getElementById("status");
  status.classList.remove("loading");
  status.textContent = `Failed to stitch: ${err}`;
});
