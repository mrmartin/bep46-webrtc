// Minimal SHA-1 (FIPS 180-4). Used only to derive swarm info-hashes, which the
// WebTorrent protocol fixes at SHA-1. Pure JS so it works from file:// and in
// non-secure contexts where crypto.subtle is unavailable. Tested against
// node:crypto in test/unit/sha1.test.js.

import { toHex } from './bytes.js';

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function sha1(bytes) {
  const ml = bytes.length;
  const withOne = ml + 1;
  const padded = Math.ceil((withOne + 8) / 64) * 64;
  const m = new Uint8Array(padded);
  m.set(bytes);
  m[ml] = 0x80;
  const view = new DataView(m.buffer);
  const bitLen = ml * 8;
  view.setUint32(padded - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded - 4, bitLen >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0); ov.setUint32(4, h1); ov.setUint32(8, h2); ov.setUint32(12, h3); ov.setUint32(16, h4);
  return out;
}

export function sha1Hex(bytes) {
  return toHex(sha1(bytes));
}
