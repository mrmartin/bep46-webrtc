// The account record — the only thing that travels between peers.
//
// {
//   v: 1,
//   user: "alice",                      // normalised username
//   pk: "<64 hex>",                     // account root key (ed25519 public key) — the real identity
//   seq: 3,                             // strictly increasing per pk; replays and rollbacks are rejected
//   ts: 1696680000000,                  // informational; also the username tie-break (older wins)
//   deleted: false,
//   kdf: { name:"scrypt", N, r, p, salt:"<32 hex>" },   // absent on tombstones
//   box: { nonce:"<48 hex>", ct:"<160 hex>" },          // secretbox(rootSecretKey) under scrypt(password) — absent on tombstones
//   sig: "<128 hex>"                    // ed25519(root secret key) over DOMAIN || canonical(record without sig)
// }
//
// Login = decrypting `box` with the password-derived key and checking the
// recovered secret key really belongs to `pk`. The password never leaves the
// device; a wrong password simply fails to open the box.

import { canonicalize } from './canonical.js';
import { toHex, fromHex, isHex, utf8, concat, equalBytes } from './bytes.js';
import { ed25519, secretbox, randomBytes, KDF_LIMITS } from './crypto.js';

export const RECORD_VERSION = 1;
export const SIGN_DOMAIN = utf8('p2p-accounts/record/v1\n');
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$/;
const MAX_TS = 4102444800000; // 2100-01-01, sanity bound for clocks

export function normalizeUsername(u) {
  return String(u ?? '').trim().normalize('NFKC').toLowerCase();
}

export function isValidUsername(u) {
  return USERNAME_RE.test(u) && !u.includes('..');
}

export function signingBytes(record) {
  const { sig, ...unsigned } = record;
  return concat(SIGN_DOMAIN, utf8(canonicalize(unsigned)));
}

export function signRecord(unsigned, secretKey) {
  const sig = ed25519.sign(signingBytes(unsigned), secretKey);
  return { ...unsigned, sig: toHex(sig) };
}

function isPow2(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

// Structural validation + signature. Returns { ok: true } or { ok: false, reason }.
// Deliberately strict: anything unexpected is rejected, since records arrive
// from arbitrary peers.
export function validateRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('not an object');
  const allowed = new Set(['v', 'user', 'pk', 'seq', 'ts', 'deleted', 'kdf', 'box', 'sig']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return bad(`unknown field ${k}`);

  if (r.v !== RECORD_VERSION) return bad('bad version');
  if (typeof r.user !== 'string' || !isValidUsername(r.user)) return bad('bad username');
  if (!isHex(r.pk, ed25519.PUBLIC_KEY_LENGTH)) return bad('bad pk');
  if (!Number.isSafeInteger(r.seq) || r.seq < 1) return bad('bad seq');
  if (!Number.isSafeInteger(r.ts) || r.ts < 0 || r.ts > MAX_TS) return bad('bad ts');
  if (typeof r.deleted !== 'boolean') return bad('bad deleted');
  if (!isHex(r.sig, ed25519.SIGNATURE_LENGTH)) return bad('bad sig');

  if (r.deleted) {
    if (r.kdf !== undefined || r.box !== undefined) return bad('tombstone carries key material');
  } else {
    const k = r.kdf;
    if (!k || typeof k !== 'object') return bad('missing kdf');
    const kk = Object.keys(k).sort().join(',');
    if (kk !== 'N,name,p,r,salt') return bad('bad kdf fields');
    if (k.name !== 'scrypt') return bad('unsupported kdf');
    if (!isPow2(k.N) || k.N < KDF_LIMITS.minN || k.N > KDF_LIMITS.maxN) return bad('kdf N out of range');
    if (k.r !== KDF_LIMITS.r || k.p !== KDF_LIMITS.p) return bad('kdf r/p not allowed');
    if (!isHex(k.salt, 16)) return bad('bad salt');

    const b = r.box;
    if (!b || typeof b !== 'object') return bad('missing box');
    if (Object.keys(b).sort().join(',') !== 'ct,nonce') return bad('bad box fields');
    if (!isHex(b.nonce, secretbox.NONCE_LENGTH)) return bad('bad nonce');
    if (!isHex(b.ct, ed25519.SECRET_KEY_LENGTH + secretbox.OVERHEAD)) return bad('bad ciphertext length');
  }

  const ok = ed25519.verify(signingBytes(r), fromHex(r.sig), fromHex(r.pk));
  if (!ok) return bad('bad signature');
  return { ok: true };
}

function bad(reason) {
  return { ok: false, reason };
}

// --- key material ---------------------------------------------------------

export function sealSecretKey(secretKey, key) {
  const nonce = randomBytes(secretbox.NONCE_LENGTH);
  const ct = secretbox.seal(secretKey, nonce, key);
  return { nonce: toHex(nonce), ct: toHex(ct) };
}

// Returns the 64-byte secret key, or null if the key is wrong or the box was
// not sealed for this pk.
export function openSecretKey(box, key, pkHex) {
  const sk = secretbox.open(fromHex(box.ct), fromHex(box.nonce), key);
  if (!sk) return null;
  // Belt and braces: the recovered secret must regenerate exactly this pk.
  const derived = ed25519.fromSecretKey(sk).publicKey;
  if (!equalBytes(derived, fromHex(pkHex))) return null;
  return sk;
}

export function newSalt() {
  return toHex(randomBytes(16));
}

// Fingerprint shown in UIs so users can tell two claimants of one name apart.
export function fingerprint(pkHex) {
  return pkHex.slice(0, 16).replace(/(.{4})(?=.)/g, '$1-');
}
