/**
 * Minimal streaming SHA-1 (FIPS 180-1). Vendored so the browser can checksum
 * large uploads incrementally — Box requires a SHA-1 `Digest` on every chunk and
 * on commit, and Web Crypto's `digest()` has no streaming API (it would force
 * the whole file into memory). Validated against node:crypto in test/sha1.test.mjs.
 *
 * Only used by the Box upload transport; nothing else depends on it.
 */
export class Sha1 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0;
  private readonly w = new Int32Array(80);

  update(data: Uint8Array): this {
    this.totalLen += data.length;
    let i = 0;
    if (this.blockLen > 0) {
      while (i < data.length && this.blockLen < 64) this.block[this.blockLen++] = data[i++]!;
      if (this.blockLen === 64) {
        this.process(this.block);
        this.blockLen = 0;
      }
    }
    while (i + 64 <= data.length) {
      this.process(data.subarray(i, i + 64));
      i += 64;
    }
    while (i < data.length) this.block[this.blockLen++] = data[i++]!;
    return this;
  }

  digest(): Uint8Array {
    // 64-bit big-endian bit length of the message (before padding).
    const bitsHi = Math.floor(this.totalLen / 0x20000000);
    const bitsLo = (this.totalLen * 8) >>> 0;
    const pad: number[] = [0x80];
    let len = this.blockLen + 1;
    while (len % 64 !== 56) {
      pad.push(0);
      len++;
    }
    pad.push((bitsHi >>> 24) & 0xff, (bitsHi >>> 16) & 0xff, (bitsHi >>> 8) & 0xff, bitsHi & 0xff);
    pad.push((bitsLo >>> 24) & 0xff, (bitsLo >>> 16) & 0xff, (bitsLo >>> 8) & 0xff, bitsLo & 0xff);
    this.update(new Uint8Array(pad));

    const out = new Uint8Array(20);
    const h = [this.h0, this.h1, this.h2, this.h3, this.h4];
    for (let i = 0; i < 5; i++) {
      out[i * 4] = (h[i]! >>> 24) & 0xff;
      out[i * 4 + 1] = (h[i]! >>> 16) & 0xff;
      out[i * 4 + 2] = (h[i]! >>> 8) & 0xff;
      out[i * 4 + 3] = h[i]! & 0xff;
    }
    return out;
  }

  private process(block: Uint8Array): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] =
        (block[i * 4]! << 24) |
        (block[i * 4 + 1]! << 16) |
        (block[i * 4 + 2]! << 8) |
        block[i * 4 + 3]!;
    }
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (v << 1) | (v >>> 31);
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Portable base64 (no btoa/Buffer dependency) — input is always 20 bytes here. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

export const sha1Base64 = (bytes: Uint8Array): string => bytesToBase64(new Sha1().update(bytes).digest());
