// File formats for very long captures, shared by the editor, the history page
// and the node tests.
//
// A page past Chrome's canvas limit (32,767px on a side) is captured in parts.
// A canvas can never hold the whole thing, so a single full-resolution PNG is
// written here a strip of rows at a time - compressed as it goes - instead of
// being drawn and encoded in one piece. The zip writer packages the parts
// themselves.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FpsExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  // `previous` continues a running CRC across several buffers.
  function crc32(bytes, previous = 0) {
    let c = previous ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const ascii = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

  function u32be(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0);
    return out;
  }

  function pngChunk(type, data) {
    const typeBytes = ascii(type);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(data, crc32(typeBytes)));
    return out;
  }

  const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const IDAT_TARGET = 256 * 1024;

  /**
   * Encode an RGBA image as PNG without ever holding it whole.
   *   strips: async iterable of RGBA byte arrays, each a whole number of rows
   *           (rows * width * 4 bytes), top to bottom, `height` rows in all
   * Returns the file as an array of byte chunks (wrap in a Blob to save).
   */
  async function encodePng({ width, height, strips }) {
    if (!(width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff)) {
      throw new Error(`Cannot write a ${width} x ${height} PNG.`);
    }
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, no filter, no interlace
    const out = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];

    // PNG wants zlib framing, which is what CompressionStream calls "deflate".
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Read while writing, or the stream's backpressure stalls the writer.
    const collecting = (async () => {
      let pending = [];
      let size = 0;
      const flush = () => {
        if (!size) return;
        const data = new Uint8Array(size);
        let at = 0;
        for (const piece of pending) {
          data.set(piece, at);
          at += piece.length;
        }
        out.push(pngChunk("IDAT", data));
        pending = [];
        size = 0;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending.push(value);
        size += value.length;
        if (size >= IDAT_TARGET) flush();
      }
      flush();
    })();

    const stride = width * 4;
    let rows = 0;
    for await (const strip of strips) {
      const count = strip.length / stride;
      if (!Number.isInteger(count)) throw new Error("A PNG strip is not a whole number of rows.");
      // Each row is prefixed with its filter type; 0 means unfiltered.
      const filtered = new Uint8Array(count * (stride + 1));
      for (let r = 0; r < count; r++) {
        filtered.set(strip.subarray(r * stride, (r + 1) * stride), r * (stride + 1) + 1);
      }
      await writer.write(filtered);
      rows += count;
    }
    await writer.close();
    await collecting;
    if (rows !== height) throw new Error(`Expected ${height} rows for the PNG, got ${rows}.`);
    out.push(pngChunk("IEND", new Uint8Array(0)));
    return out;
  }

  /**
   * A zip of already-compressed files (PNG, JPEG), stored without further
   * compression. files: [{ name, bytes: Uint8Array }]. Returns byte chunks.
   */
  function zipStore(files, date = new Date()) {
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const out = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const name = new TextEncoder().encode(file.name);
      const size = file.bytes.length;
      if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error("The zip would exceed 4GB.");
      const crc = crc32(file.bytes);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      out.push(local, file.bytes);

      const entry = new Uint8Array(46 + name.length);
      const cv = new DataView(entry.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      entry.set(name, 46);
      central.push(entry);
      offset += local.length + size;
    }

    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    out.push(...central, end);
    return out;
  }

  /**
   * Browser only: the RGBA rows of several image sources stacked top to
   * bottom, as strips for encodePng. A source is a Blob or anything
   * drawImage accepts (an annotated part's canvas).
   */
  async function* stackedStrips(sources, width, rowsPerStrip = 256) {
    const canvas = new OffscreenCanvas(width, rowsPerStrip);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    for (const source of sources) {
      const image = source instanceof Blob ? await createImageBitmap(source) : source;
      try {
        for (let top = 0; top < image.height; top += rowsPerStrip) {
          const rows = Math.min(rowsPerStrip, image.height - top);
          ctx.clearRect(0, 0, width, rowsPerStrip);
          ctx.drawImage(image, 0, top, width, rows, 0, 0, width, rows);
          yield ctx.getImageData(0, 0, width, rows).data;
        }
      } finally {
        if (source instanceof Blob) image.close();
      }
    }
  }

  // Browser only: one PNG Blob from parts of equal width.
  async function stackToPng(sources, width) {
    let height = 0;
    const images = [];
    for (const source of sources) {
      if (source instanceof Blob) {
        const bitmap = await createImageBitmap(source);
        height += bitmap.height;
        bitmap.close();
      } else {
        height += source.height;
      }
      images.push(source);
    }
    const chunks = await encodePng({ width, height, strips: stackedStrips(images, width) });
    return new Blob(chunks, { type: "image/png" });
  }

  return { crc32, encodePng, zipStore, stackedStrips, stackToPng };
});
