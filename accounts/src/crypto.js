// Crypto primitives, injected once per environment so the same core runs in
// Node (tweetnacl npm + node:crypto scrypt) and in the browser (vendored
// nacl-fast.min.js + scrypt-js). Both scrypt implementations follow RFC 7914,
// so a key derived in one environment opens a box sealed in the other —
// asserted by test/unit/crypto.test.js.

import { utf8, fromHex } from './bytes.js';

let nacl = null;
let scryptImpl = null;

export function configure({ nacl: n, scrypt: s }) {
  if (!n || typeof n.sign?.keyPair !== 'function') throw new Error('configure: nacl missing');
  if (typeof s !== 'function') throw new Error('configure: scrypt(password, salt, {N,r,p,dkLen}) missing');
  nacl = n;
  scryptImpl = s;
}

function need() {
  if (!nacl) throw new Error('crypto not configured — call configure({ nacl, scrypt }) first');
}

export function randomBytes(n) {
  need();
  return nacl.randomBytes(n);
}

export const ed25519 = {
  keyPair() { need(); return nacl.sign.keyPair(); },
  fromSecretKey(sk) { need(); return nacl.sign.keyPair.fromSecretKey(sk); },
  sign(msg, sk) { need(); return nacl.sign.detached(msg, sk); },
  verify(msg, sig, pk) {
    need();
    try { return nacl.sign.detached.verify(msg, sig, pk); } catch { return false; }
  },
  PUBLIC_KEY_LENGTH: 32,
  SECRET_KEY_LENGTH: 64,
  SIGNATURE_LENGTH: 64,
};

export const secretbox = {
  seal(plain, nonce, key) { need(); return nacl.secretbox(plain, nonce, key); },
  open(boxed, nonce, key) { need(); return nacl.secretbox.open(boxed, nonce, key); }, // null on failure
  NONCE_LENGTH: 24,
  KEY_LENGTH: 32,
  OVERHEAD: 16,
};

// Public-key authenticated encryption (x25519 + xsalsa20-poly1305) and the
// SHA-512 hash, for apps that need to seal something to a specific reader
// (catwalk's friends-only posts). Not used by the accounts layer itself.
export const box = {
  keyPair() { need(); return nacl.box.keyPair(); },
  fromSecretKey(sk) { need(); return nacl.box.keyPair.fromSecretKey(sk); },
  seal(plain, nonce, theirPk, mySk) { need(); return nacl.box(plain, nonce, theirPk, mySk); },
  open(boxed, nonce, theirPk, mySk) { need(); return nacl.box.open(boxed, nonce, theirPk, mySk); }, // null on failure
  PUBLIC_KEY_LENGTH: 32,
  SECRET_KEY_LENGTH: 32,
  NONCE_LENGTH: 24,
  OVERHEAD: 16,
};

export function hash(bytes) {
  need();
  return nacl.hash(bytes); // SHA-512, 64 bytes
}

// Password → 32-byte key. `params` is the public kdf block stored in the record.
export async function deriveKey(password, params) {
  need();
  const salt = fromHex(params.salt);
  const out = await scryptImpl(utf8(password.normalize('NFKC')), salt, {
    N: params.N, r: params.r, p: params.p, dkLen: secretbox.KEY_LENGTH,
  });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

// Default cost: 2^15 ≈ 32 MiB, well under a second natively, a second or two
// in pure-JS browsers. Records carry their own params, so this can be raised
// later without breaking existing accounts (they re-key on password change).
export const DEFAULT_KDF = Object.freeze({ name: 'scrypt', N: 1 << 15, r: 8, p: 1 });
export const KDF_LIMITS = Object.freeze({ minN: 1 << 10, maxN: 1 << 20, r: 8, p: 1 });
