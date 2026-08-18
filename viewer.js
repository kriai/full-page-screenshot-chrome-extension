const editor = {
  baseCanvas: null,
  canvas: null,
  ctx: null,
  currentTool: "arrow",
  activeTextInput: null,
  baseName: "screenshot",
  dragStart: null,
  draft: null,
  exportVersion: 0,
  exportUrls: [],
  interaction: null,
  operations: [],
  redoStack: [],
  selectedIndex: -1,
};

const toolHints = {
  arrow: "Drag to draw an arrow.",
  rect: "Drag to draw a box.",
  pen: "Drag to draw freehand.",
  text: "Click the screenshot, then type.",
  step: "Click to place a numbered marker.",
  pixelate: "Drag over content to pixelate it.",
  redact: "Drag over content to cover it.",
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
  return {
    x: ((event.clientX - rect.left) / rect.width) * editor.canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * editor.canvas.height,
  };
}

function currentStyle() {
  return {
    color: document.getElementById("color").value,
    strokeWidth: Number(document.getElementById("stroke").value),
    textSize: Number(document.getElementById("textSize").value),
  };
}

function textFromEditor(element) {
  return element.innerText.replace(/\n+$/g, "").trim();
}

function openTextEditor(point, baseName) {
  if (editor.activeTextInput) editor.activeTextInput.finish(true);

  const shell = document.getElementById("canvasShell");
  const canvasRect = editor.canvas.getBoundingClientRect();
  const shellRect = shell.getBoundingClientRect();
  const scaleX = canvasRect.width / editor.canvas.width;
  const scaleY = canvasRect.height / editor.canvas.height;
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

function pushOperation(operation, baseName = editor.baseName) {
  editor.operations.push(operation);
  editor.redoStack = [];
  editor.selectedIndex = editor.operations.length - 1;
  redraw();
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
  const scale = editor.canvas.width / editor.canvas.getBoundingClientRect().width;
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
  ctx.lineWidth = Math.max(2, editor.canvas.width / editor.canvas.getBoundingClientRect().width);
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

  const cssWidth = 230;
  const cssHeight = 92;
  const scale = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== cssWidth * scale || canvas.height !== cssHeight * scale) {
    canvas.width = cssWidth * scale;
    canvas.height = cssHeight * scale;
  }

  const ctx = canvas.getContext("2d");
  const style = currentStyle();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (editor.currentTool === "text") {
    drawText(ctx, {
      type: "text",
      point: { x: 22, y: 26 },
      text: "Text",
      ...style,
    });
    return;
  }
  if (editor.currentTool === "step") {
    drawStep(ctx, {
      type: "step",
      point: { x: cssWidth / 2, y: cssHeight / 2 },
      number: nextStepNumber(),
      radius: 36,
      ...style,
    });
    return;
  }
  if (editor.currentTool === "rect") {
    drawRect(ctx, {
      type: "rect",
      rect: { x: 42, y: 24, width: 146, height: 44 },
      ...style,
    });
    return;
  }
  if (editor.currentTool === "pen") {
    drawPen(ctx, {
      type: "pen",
      points: [
        { x: 32, y: 60 },
        { x: 76, y: 30 },
        { x: 122, y: 58 },
        { x: 180, y: 28 },
      ],
      ...style,
    });
    return;
  }
  if (editor.currentTool === "pixelate") {
    ctx.fillStyle = "#344055";
    ctx.fillRect(48, 24, 132, 44);
    ctx.fillStyle = "#78a0ff";
    for (let x = 48; x < 180; x += 16) {
      for (let y = 24; y < 68; y += 16) ctx.fillRect(x, y, 13, 13);
    }
    return;
  }
  if (editor.currentTool === "redact") {
    applyRedact(ctx, {
      type: "redact",
      rect: { x: 48, y: 28, width: 132, height: 36 },
    });
    return;
  }
  drawArrow(ctx, {
    type: "arrow",
    from: { x: 34, y: 62 },
    to: { x: 184, y: 30 },
    ...style,
  });
}

function drawArrow(ctx, operation) {
  const { from, to, color, strokeWidth } = operation;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = Math.max(14, strokeWidth * 4);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headLength * Math.cos(angle - Math.PI / 6),
    to.y - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    to.x - headLength * Math.cos(angle + Math.PI / 6),
    to.y - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRect(ctx, operation) {
  const { rect, color, strokeWidth } = operation;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
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

function applyRedact(ctx, operation) {
  const { rect } = operation;
  ctx.save();
  ctx.fillStyle = "#050507";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawPreview(ctx, operation) {
  if (operation.type === "pixelate" || operation.type === "redact") {
    ctx.save();
    ctx.strokeStyle = operation.type === "pixelate" ? "#78a0ff" : "#f2f4f8";
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
  if (operation.type === "pixelate") applyPixelate(ctx, operation);
  if (operation.type === "redact") applyRedact(ctx, operation);
}

function redraw(preview = null) {
  editor.ctx.clearRect(0, 0, editor.canvas.width, editor.canvas.height);
  editor.ctx.drawImage(editor.baseCanvas, 0, 0);
  for (const operation of editor.operations) {
    applyOperation(editor.ctx, operation);
  }
  if (preview) drawPreview(editor.ctx, preview);
  if (!preview) drawSelection(editor.ctx);
}

function makeDragOperation(tool, start, end) {
  const style = currentStyle();
  if (tool === "arrow") {
    return { type: "arrow", from: start, to: end, ...style };
  }
  if (tool === "rect" || tool === "pixelate" || tool === "redact") {
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

function scheduleExportRefresh(baseName) {
  const version = ++editor.exportVersion;
  setTimeout(() => {
    if (version === editor.exportVersion) refreshExports(baseName);
  }, 120);
}

function renderFinalCanvas() {
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

async function refreshExports(baseName) {
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
}

function setupDownloadActions(baseName) {
  for (const id of ["downloadPng", "downloadJpeg", "downloadPdf"]) {
    const anchor = document.getElementById(id);
    anchor.addEventListener("click", async (event) => {
      if (!editor.activeTextInput) return;
      event.preventDefault();
      editor.activeTextInput.finish(true);
      await refreshExports(baseName);
      anchor.click();
    });
  }
}

function setupAnnotationControls(baseName) {
  const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
  const toolHint = document.getElementById("toolHint");
  const color = document.getElementById("color");
  const swatches = Array.from(document.querySelectorAll("[data-color]"));
  const stroke = document.getElementById("stroke");
  const strokeValue = document.getElementById("strokeValue");
  const textSize = document.getElementById("textSize");
  const textSizeValue = document.getElementById("textSizeValue");

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.currentTool = button.dataset.tool;
      toolButtons.forEach((item) => item.classList.toggle("active", item === button));
      toolHint.textContent = toolHints[editor.currentTool];
      renderStylePreview();
    });
  });

  function syncSwatches() {
    swatches.forEach((swatch) => {
      swatch.classList.toggle(
        "active",
        swatch.dataset.color.toLowerCase() === color.value.toLowerCase()
      );
    });
  }

  function loadSelectedStyle(operation) {
    if (operation.color) color.value = operation.color;
    if (operation.strokeWidth) {
      stroke.value = String(operation.strokeWidth);
      strokeValue.textContent = stroke.value;
    }
    if (operation.textSize) {
      textSize.value = String(operation.textSize);
      textSizeValue.textContent = textSize.value;
    }
    syncSwatches();
    renderStylePreview();
  }

  function updateSelectedStyle() {
    if (editor.selectedIndex < 0) return;
    const operation = editor.operations[editor.selectedIndex];
    if (!operation) return;

    const style = currentStyle();
    if ("color" in operation) operation.color = style.color;
    if ("strokeWidth" in operation) operation.strokeWidth = style.strokeWidth;
    if ("textSize" in operation) operation.textSize = style.textSize;
    if (operation.type === "step") operation.radius = Math.max(36, style.textSize * 1.24);
    redraw();
    scheduleExportRefresh(baseName);
  }

  swatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      color.value = swatch.dataset.color;
      syncSwatches();
      if (editor.activeTextInput) editor.activeTextInput.syncStyle();
      updateSelectedStyle();
      renderStylePreview();
    });
  });
  color.addEventListener("input", () => {
    syncSwatches();
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });

  stroke.addEventListener("input", () => {
    strokeValue.textContent = stroke.value;
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });
  textSize.addEventListener("input", () => {
    textSizeValue.textContent = textSize.value;
    if (editor.activeTextInput) editor.activeTextInput.syncStyle();
    updateSelectedStyle();
    renderStylePreview();
  });

  document.getElementById("undo").addEventListener("click", () => {
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const operation = editor.operations.pop();
    if (operation) editor.redoStack.push(operation);
    editor.selectedIndex = editor.operations.length - 1;
    redraw();
    scheduleExportRefresh(baseName);
  });

  document.getElementById("redo").addEventListener("click", () => {
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    const operation = editor.redoStack.pop();
    if (!operation) return;
    editor.operations.push(operation);
    editor.selectedIndex = editor.operations.length - 1;
    redraw();
    scheduleExportRefresh(baseName);
  });

  document.getElementById("clear").addEventListener("click", () => {
    if (editor.activeTextInput) editor.activeTextInput.finish(false);
    editor.operations = [];
    editor.redoStack = [];
    editor.selectedIndex = -1;
    redraw();
    scheduleExportRefresh(baseName);
  });

  editor.canvas.addEventListener("pointerdown", (event) => {
    const point = pointerToCanvasPoint(event);
    const selected = editor.operations[editor.selectedIndex];
    const handle = selected ? handleAtPoint(selected, point) : null;
    if (selected && handle) {
      event.preventDefault();
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
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.selectedIndex = hitIndex;
      loadSelectedStyle(editor.operations[hitIndex]);
      redraw();
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
      editor.selectedIndex = -1;
      openTextEditor(point, baseName);
      return;
    }
    if (editor.currentTool === "step") {
      event.preventDefault();
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      editor.selectedIndex = -1;
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
    event.preventDefault();
    editor.selectedIndex = -1;
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
      redraw();
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
    redraw(editor.draft);
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
    editor.interaction = null;
    editor.redoStack = [];
    redraw();
    scheduleExportRefresh(baseName);
  });

  editor.canvas.addEventListener("pointercancel", () => {
    editor.draft = null;
    editor.dragStart = null;
    editor.interaction = null;
    redraw();
  });

  renderStylePreview();
}

async function setupCopyButton() {
  const copy = document.getElementById("copy");
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      const pngBlob = await canvasToBlob(renderFinalCanvas(), "image/png");
      await navigator.clipboard.write([
        new ClipboardItem({ [pngBlob.type]: pngBlob }),
      ]);
      copy.textContent = "Copied";
    } catch (err) {
      console.error("Copy failed:", err);
      copy.textContent = "Copy failed";
    } finally {
      setTimeout(() => {
        copy.disabled = false;
        copy.textContent = "Copy";
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
    upload.textContent = "Uploading...";

    try {
      if (editor.activeTextInput) editor.activeTextInput.finish(true);
      const pngBlob = await canvasToBlob(renderFinalCanvas(), "image/png");
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
        throw new Error(text || `Upload failed with HTTP ${response.status}.`);
      }
      if (!/^https:\/\/\S+\.uguu\.se\/\S+/.test(url)) {
        throw new Error(text || "Upload did not return a valid image URL.");
      }

      await navigator.clipboard.writeText(url);
      upload.textContent = "URL copied";
    } catch (err) {
      if (err.name === "AbortError") {
        err = new Error("Upload timed out. Uguu may be slow or unavailable.");
      }
      console.error("Upload failed:", err);
      upload.classList.remove("success");
      upload.classList.add("danger");
      upload.textContent = "Upload failed";
    } finally {
      setTimeout(() => {
        upload.disabled = false;
        upload.classList.remove("danger");
        upload.classList.add("success");
        upload.textContent = defaultLabel;
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
  const outputCanvas = renderFinalCanvas();
  history.unshift({
    baseName: editor.baseName,
    dataUrl: outputCanvas.toDataURL("image/png"),
    height: outputCanvas.height,
    savedAt: Date.now(),
    title: capture.pageTitle || "Screenshot",
    url: capture.pageUrl || "",
    width: outputCanvas.width,
  });
  await chrome.storage.local.set({
    history: history.slice(0, limit),
    historyLimit: limit,
  });
}

async function main() {
  const status = document.getElementById("status");
  const { capture } = await chrome.storage.local.get("capture");
  if (!capture) {
    status.textContent =
      "No capture found. Click the extension button on a page first.";
    return;
  }

  const { frames, pageTitle } = capture;
  document.getElementById("title").textContent = pageTitle || "Screenshot";
  document.title = `Screenshot - ${pageTitle || ""}`;

  const images = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
  editor.baseCanvas = drawCapture(capture, images);
  editor.canvas = document.getElementById("editorCanvas");
  editor.ctx = editor.canvas.getContext("2d");
  editor.canvas.width = editor.baseCanvas.width;
  editor.canvas.height = editor.baseCanvas.height;
  redraw();

  document.getElementById(
    "dimensions"
  ).textContent = `${editor.canvas.width} x ${editor.canvas.height}px`;

  const baseName = buildBaseName(capture);
  editor.baseName = baseName;
  await refreshExports(baseName);
  setupDownloadActions(baseName);
  await setupCopyButton();
  await setupUploadButton();
  await autoSaveHistory(capture);
  setupAnnotationControls(baseName);

  document.getElementById("canvasShell").hidden = false;
  document.getElementById("annotationPanel").hidden = false;
  document.getElementById("actions").hidden = false;
  status.hidden = true;

  // The frames are large; drop them now that the image is rendered.
  await chrome.storage.local.remove("capture");
}

main().catch((err) => {
  document.getElementById("status").textContent = `Failed to stitch: ${err}`;
});
