// Byte / hex / utf8 helpers that behave identically in Node and browsers.

const HEX = '0123456789abcdef';

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += HEX[b >> 4] + HEX[b & 15];
  }
  return s;
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) {
    throw new TypeError('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isHex(s, bytes) {
  return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s) {
  return enc.encode(s);
}

export function fromUtf8(bytes) {
  return dec.decode(bytes);
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
