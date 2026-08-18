function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
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

  const { frames, metrics, pageTitle } = capture;
  document.getElementById("title").textContent = pageTitle || "Screenshot";
  document.title = `Screenshot – ${pageTitle || ""}`;

  const images = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));

  // Derive the real pixel scale from the first captured image rather than
  // trusting devicePixelRatio (browser zoom changes the effective ratio).
  const scale = images[0].width / metrics.viewportWidth;
  const canvas = document.createElement("canvas");
  canvas.width = images[0].width;
  canvas.height = Math.round(metrics.pageHeight * scale);
  const ctx = canvas.getContext("2d");

  // Each frame is drawn at the scroll offset it was captured at; overlapping
  // regions (the clamped last frame) simply paint the same pixels twice.
  frames.forEach((frame, i) => {
    ctx.drawImage(images[i], 0, Math.round(frame.y * scale));
  });

  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);

  const img = document.getElementById("result");
  img.src = url;
  img.hidden = false;
  status.hidden = true;

  document.getElementById(
    "dimensions"
  ).textContent = `${canvas.width} × ${canvas.height}px`;

  const download = document.getElementById("download");
  const slug = (pageTitle || "screenshot")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  download.href = url;
  download.download = `${slug || "screenshot"}.png`;
  download.hidden = false;

  // The frames are large; drop them now that the image is rendered.
  await chrome.storage.local.remove("capture");
}

main().catch((err) => {
  document.getElementById("status").textContent = `Failed to stitch: ${err}`;
});
