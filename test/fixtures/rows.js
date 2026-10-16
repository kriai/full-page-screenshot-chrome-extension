// Numbered rows with seam markers: after stitching, every number must appear
// exactly once and the coloured bars must form one unbroken sequence.
//
// Each row also carries a machine-readable code at its left edge, so the
// end-to-end tests can read the row index back out of the finished image.
// It is plain black and white cells, which survive colour management and
// scaling where an exact colour would not:
//
//   [black][white] 13 index bits, 7 check bits [white][black]
//
// A set bit is black. The check bits are a hash of the index, so a stray run
// of text pixels cannot pass for a row. Decoded by test/e2e/harness.mjs -
// keep the two in step.
const ROW_CODE = { cells: 24, indexBits: 13, checkBits: 7 };
const rowCheck = (index) => (index * 37 + 11) % 128;

function rowCode(index) {
  const bits = [];
  for (let b = ROW_CODE.indexBits - 1; b >= 0; b--) bits.push((index >> b) & 1);
  const check = rowCheck(index);
  for (let b = ROW_CODE.checkBits - 1; b >= 0; b--) bits.push((check >> b) & 1);
  const cells = [1, 0, ...bits, 0, 1];
  const code = document.createElement("span");
  code.className = "code";
  code.dataset.row = String(index);
  for (const cell of cells) {
    const i = document.createElement("i");
    if (cell) i.className = "on";
    code.appendChild(i);
  }
  return code;
}

// `start` numbers rows from somewhere other than zero, so a page with several
// lists still gives every row a unique index.
function buildRows(host, count, options = {}) {
  const rowHeight = options.rowHeight || 60;
  const start = options.start || 0;
  for (let n = 0; n < count; n++) {
    const i = start + n;
    const row = document.createElement("div");
    row.className = "row";
    row.style.height = `${rowHeight}px`;
    row.style.background = i % 2 ? "#f4f6fb" : "#ffffff";
    row.innerHTML = `<span class="num">${String(i + 1).padStart(4, "0")}</span>
      <span class="bar" style="background:hsl(${(i * 7) % 360} 80% 55%)"></span>
      <span class="label">${options.label || "row"} ${i + 1}</span>`;
    row.prepend(rowCode(i));
    host.appendChild(row);
  }
}
