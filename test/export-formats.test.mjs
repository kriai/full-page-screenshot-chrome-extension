// The streaming PNG writer and the zip writer used for captures too tall for
// one canvas.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const X = require("../export-formats.js");

const concat = (chunks) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

async function* strips(width, height, rowsPerStrip) {
  for (let top = 0; top < height; top += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - top);
    const data = new Uint8Array(rows * width * 4);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < width; x++) {
        const i = (r * width + x) * 4;
        data.set([(top + r) & 255, x & 255, 7, 255], i);
      }
    }
    yield data;
  }
}

function readChunks(png) {
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    assert.equal(crc, X.crc32(data, X.crc32(Buffer.from(type, "ascii"))), `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

test("crc32 matches the standard check value", () => {
  assert.equal(X.crc32(Buffer.from("123456789")), 0xcbf43926);
  // Continuing across buffers gives the same answer as one pass.
  assert.equal(X.crc32(Buffer.from("6789"), X.crc32(Buffer.from("12345"))), 0xcbf43926);
});

test("encodePng writes a valid PNG strip by strip", async () => {
  const width = 37;
  const height = 300;
  const png = concat(await X.encodePng({ width, height, strips: strips(width, height, 64) }));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = readChunks(png);
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks[0].data.readUInt32BE(0), width);
  assert.equal(chunks[0].data.readUInt32BE(4), height);
  assert.equal(chunks.at(-1).type, "IEND");
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  assert.equal(raw.length, height * (width * 4 + 1));
  for (const y of [0, 63, 64, 299]) {
    const row = y * (width * 4 + 1);
    assert.equal(raw[row], 0, "filter byte");
    assert.deepEqual([...raw.subarray(row + 1 + 5 * 4, row + 1 + 6 * 4)], [y & 255, 5, 7, 255]);
  }
});

test("encodePng refuses a row count that does not match the header", async () => {
  await assert.rejects(X.encodePng({ width: 4, height: 10, strips: strips(4, 9, 4) }), /Expected 10 rows/);
});

test("zipStore lays out files a zip reader can find", () => {
  const files = [
    { name: "part-1.png", bytes: Uint8Array.from([1, 2, 3, 4]) },
    { name: "part-2.png", bytes: Uint8Array.from([9, 8, 7]) },
  ];
  const zip = concat(X.zipStore(files));
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  let at = zip.readUInt32LE(end + 16);
  for (const file of files) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    assert.equal(zip.toString("utf8", at + 46, at + 46 + nameLength), file.name);
    const local = zip.readUInt32LE(at + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26);
    assert.deepEqual([...zip.subarray(dataAt, dataAt + file.bytes.length)], [...file.bytes]);
    assert.equal(zip.readUInt32LE(at + 16), X.crc32(file.bytes));
    at += 46 + nameLength;
  }
});
