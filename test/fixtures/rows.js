// Numbered rows with seam markers: after stitching, every number must appear
// exactly once and the coloured bars must form one unbroken sequence.
function buildRows(host, count, options = {}) {
  const rowHeight = options.rowHeight || 60;
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.height = `${rowHeight}px`;
    row.style.background = i % 2 ? "#f4f6fb" : "#ffffff";
    row.innerHTML = `<span class="num">${String(i + 1).padStart(4, "0")}</span>
      <span class="bar" style="background:hsl(${(i * 7) % 360} 80% 55%)"></span>
      <span class="label">${options.label || "row"} ${i + 1}</span>`;
    host.appendChild(row);
  }
}
