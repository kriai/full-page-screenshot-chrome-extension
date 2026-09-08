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
  },
  nextOperationId: 1,
  operations: [],
  pendingPreview: null,
  previewScale: 1,
  projectBaseDataUrl: "",
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
  const pageWidth = 612;
  const pageHeight = Math.round((pageWidth * imageHeight) / imageWidth);
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im1 Do\nQ\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    {
      dictionary: `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`,
      stream: jpegBytes,
    },
    {
      dictionary: `<< /Length ${textBytes(content).length} >>`,
      stream: textBytes(content),
    },
  ];

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

function drawCapture(capture, images) {
  const { frames, metrics, mode, cropRect } = capture;
  const scale = images[0].width / metrics.viewportWidth;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

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

function cloneProject() {
  if (!editor.projectBaseDataUrl && editor.baseCanvas) {
    editor.projectBaseDataUrl = editor.baseCanvas.toDataURL("image/png");
  }
  return {
    version: 1,
    baseDataUrl: editor.projectBaseDataUrl,
    baseWidth: editor.baseCanvas.width,
    baseHeight: editor.baseCanvas.height,
    operations: editor.operations.map(cloneOperation),
    layout: cloneLayout(),
  };
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
  if (!project) return;

  if (project.baseDataUrl) editor.projectBaseDataUrl = project.baseDataUrl;
  if (project.layout) {
    editor.layout = {
      ...editor.layout,
      ...project.layout,
    };
  }
  if (Array.isArray(project.operations)) {
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

function renderFinalCanvas() {
  const screenshot = renderAnnotatedCanvas();
  if (!editor.layout.enabled) return screenshot;

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
  const jpegBlob = await canvasToBlob(jpegCanvas, "image/jpeg", 0.92);
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
    await saveRenderedProjectToHistory(outputCanvas);
  }
}

async function ensureFreshExports(baseName) {
  const png = document.getElementById("downloadPng");
  if (!editor.exportDirty && png?.dataset.exportReady === "1") return;
  showExportStatus("Updating...");
  await refreshExports(baseName);
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

  function refreshLayout() {
    editor.layout = {
      enabled: enabled.checked,
      background: background.value,
      aspect: aspect.value,
      padding: Number(padding.value),
      radius: Number(radius.value),
      shadow: Number(shadow.value),
    };
    if (controls) controls.hidden = !editor.layout.enabled;
    if (paddingValue) paddingValue.textContent = `${editor.layout.padding} px`;
    if (radiusValue) radiusValue.textContent = `${editor.layout.radius} px`;
    if (shadowValue) shadowValue.textContent = `${editor.layout.shadow} px`;
    applyLayoutPreview();
    scheduleExportRefresh(baseName);
  }

  syncLayoutControlValues();
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
      await saveRenderedProjectToHistory(outputCanvas);
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
      await saveRenderedProjectToHistory(outputCanvas);
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

async function autoSaveHistory(capture) {
  const { history = [], historyLimit = 20 } = await chrome.storage.local.get([
    "history",
    "historyLimit",
  ]);
  const limit = normalizeHistoryLimit(historyLimit);
  const outputCanvas =
    editor.operations.length || editor.layout.enabled ? renderFinalCanvas() : editor.baseCanvas;
  const dataUrl = outputCanvas.toDataURL("image/png");
  if (outputCanvas === editor.baseCanvas) editor.projectBaseDataUrl = dataUrl;
  history.unshift({
    baseName: editor.baseName,
    dataUrl,
    height: outputCanvas.height,
    mode: capture.mode || "fullPage",
    project: cloneProject(),
    savedAt: Date.now(),
    title: capture.pageTitle || "Screenshot",
    url: capture.pageUrl || "",
    width: outputCanvas.width,
  });
  await chrome.storage.local.set({
    history: history.slice(0, limit),
    historyLimit: limit,
  });
  editor.historyReady = true;
}

async function saveProjectToHistory() {
  if (!editor.historyReady || !editor.baseName || !editor.baseCanvas) return;

  const { history = [] } = await chrome.storage.local.get("history");
  const index = history.findIndex((entry) => entry.baseName === editor.baseName);
  if (index < 0) return;

  history[index] = {
    ...history[index],
    project: cloneProject(),
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ history });
}

async function saveRenderedProjectToHistory(outputCanvas) {
  if (!editor.historyReady || !editor.baseName || !editor.baseCanvas || !outputCanvas) return;

  const { history = [] } = await chrome.storage.local.get("history");
  const index = history.findIndex((entry) => entry.baseName === editor.baseName);
  if (index < 0) return;

  history[index] = {
    ...history[index],
    dataUrl: outputCanvas.toDataURL("image/png"),
    height: outputCanvas.height,
    project: cloneProject(),
    updatedAt: Date.now(),
    width: outputCanvas.width,
  };
  await chrome.storage.local.set({ history });
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
  const index = history.findIndex((entry) => entry.baseName === editor.baseName);
  if (index < 0) return;

  history[index] = {
    ...history[index],
    uploadedAt,
    uploadExpiresAt,
    uploadUrl: url,
  };
  await chrome.storage.local.set({ history });
}

async function main() {
  const status = document.getElementById("status");
  const { capture } = await chrome.storage.local.get("capture");
  if (!capture) {
    status.classList.remove("loading");
    status.textContent =
      "No capture found. Click the extension button on a page first.";
    return;
  }

  const { frames, pageTitle } = capture;
  document.getElementById("title").textContent = pageTitle || "Screenshot";
  document.title = `Screenshot - ${pageTitle || ""}`;

  status.textContent = "Loading captured frames";
  const images = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
  status.textContent = "Stitching screenshot";
  editor.baseCanvas = drawCapture(capture, images);
  editor.projectBaseDataUrl = capture.project?.baseDataUrl || "";
  editor.baseDisplayCanvas = document.getElementById("baseDisplayCanvas");
  editor.baseDisplayCtx = editor.baseDisplayCanvas.getContext("2d");
  editor.canvas = document.getElementById("editorCanvas");
  editor.ctx = editor.canvas.getContext("2d");
  syncDisplayCanvases();
  const baseName = capture.baseName || buildBaseName(capture);
  editor.baseName = baseName;
  editor.exportBaseName = baseName;
  loadProjectState(capture.project);
  redraw();

  document.getElementById(
    "dimensions"
  ).textContent = `${editor.baseCanvas.width} x ${editor.baseCanvas.height}px`;

  setupDownloadActions(baseName);
  await setupCopyButton();
  await setupUploadButton();
  if (capture.fromHistory) {
    editor.historyReady = true;
    await saveProjectToHistory();
  } else {
    status.textContent = "Saving to history";
    await autoSaveHistory(capture);
  }
  markExportsStale(baseName, { quiet: true });
  status.textContent = "Preparing editor";
  setupAnnotationControls(baseName);
  setupLayoutControls(baseName);

  document.getElementById("canvasShell").hidden = false;
  document.getElementById("annotationPanel").hidden = false;
  document.getElementById("actions").hidden = false;
  setupZoomControls();
  status.classList.remove("loading");
  status.hidden = true;

  // The frames are large; drop them now that the image is rendered.
  await chrome.storage.local.remove("capture");
}

main().catch((err) => {
  const status = document.getElementById("status");
  status.classList.remove("loading");
  status.textContent = `Failed to stitch: ${err}`;
});
