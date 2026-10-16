import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Sha1, sha1Base64 } from "../dist/index.js";

const nodeSha1 = (buf) => createHash("sha1").update(buf).digest("base64");

function incremental(buf, chunkSizes) {
  const h = new Sha1();
  let off = 0;
  let ci = 0;
  while (off < buf.length) {
    const n = chunkSizes[ci++ % chunkSizes.length];
    h.update(new Uint8Array(buf.subarray(off, off + n)));
    off += n;
  }
  return Buffer.from(h.digest()).toString("base64");
}

test("one-shot SHA-1 matches node:crypto (known vectors)", () => {
  for (const s of ["", "abc", "The quick brown fox jumps over the lazy dog"]) {
    const buf = Buffer.from(s);
    assert.equal(sha1Base64(new Uint8Array(buf)), nodeSha1(buf), `vector: ${JSON.stringify(s)}`);
  }
  const million = Buffer.alloc(1_000_000, 0x61);
  assert.equal(sha1Base64(new Uint8Array(million)), nodeSha1(million), "million 'a'");
});

test("block-boundary lengths match node:crypto", () => {
  for (const len of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
    const buf = randomBytes(len);
    assert.equal(sha1Base64(new Uint8Array(buf)), nodeSha1(buf), `len ${len}`);
  }
});

test("incremental update across odd chunk sizes matches node:crypto", () => {
  for (let t = 0; t < 25; t++) {
    const buf = randomBytes(Math.floor(Math.random() * 200_000));
    assert.equal(incremental(buf, [1, 7, 64, 333, 8192]), nodeSha1(buf), `trial ${t} len ${buf.length}`);
  }
});
