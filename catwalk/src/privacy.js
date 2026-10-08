// Friends-only posts without a server to enforce "friends only".
//
// Every account derives an x25519 "box" keypair from its account secret key
// (so nothing extra has to be stored or backed up) and publishes the public
// half in its profile. Each author keeps one symmetric *friends key* per
// epoch; the current one is sealed to every friend's box key in the author's
// `fkey` record, and earlier ones hang off it in a chain, each encrypted under
// the next. Friends-only posts are secretbox(text) under the key of the epoch
// they were written in. Removing a friend starts a new epoch sealed only to
// the friends who remain; the replaced record was the ex-friend's only way in,
// so from then on every friends-only post is closed to them (unless they
// cached the key — nothing can be un-sent). A new friend gets the current key
// and can unwind the chain to read older posts too.

import { toHex, fromHex, utf8, fromUtf8, concat } from '../../accounts/src/bytes.js';
import { secretbox, box, hash, randomBytes } from '../../accounts/src/crypto.js';

const BOX_DOMAIN = utf8('catwalk/box-key/v1\n');

/** x25519 keypair derived from the 64-byte ed25519 account secret key. */
export function boxKeyPair(accountSecretKey) {
  const seed = hash(concat(BOX_DOMAIN, accountSecretKey.subarray(0, 32))).subarray(0, box.SECRET_KEY_LENGTH);
  return box.fromSecretKey(seed);
}

export function newFriendsKey() { return randomBytes(secretbox.KEY_LENGTH); }

/** Seal a friends key to one reader's box public key. */
export function sealKeyTo(fk, readerBoxPkHex, myBoxSk) {
  const nonce = randomBytes(box.NONCE_LENGTH);
  return { nonce: toHex(nonce), ct: toHex(box.seal(fk, nonce, fromHex(readerBoxPkHex), myBoxSk)) };
}

/** Open an entry of an author's fkey.keys with my box secret key; null if not for me / tampered. */
export function openKeyFrom(entry, authorBoxPkHex, myBoxSk) {
  try { return box.open(fromHex(entry.ct), fromHex(entry.nonce), fromHex(authorBoxPkHex), myBoxSk); } catch { return null; }
}

/** chain entry: previous epoch's key encrypted under the newer one. */
export function wrapKey(olderFk, newerFk) {
  const nonce = randomBytes(secretbox.NONCE_LENGTH);
  return { nonce: toHex(nonce), ct: toHex(secretbox.seal(olderFk, nonce, newerFk)) };
}
export function unwrapKey(entry, newerFk) {
  try { return secretbox.open(fromHex(entry.ct), fromHex(entry.nonce), newerFk); } catch { return null; }
}

/** Given the key for `fkey.epoch`, recover the key for any earlier `epoch` through the chain. */
export function keyForEpoch(fkeyBody, currentFk, epoch) {
  if (epoch === fkeyBody.epoch) return currentFk;
  if (epoch > fkeyBody.epoch || epoch < 1) return null;
  let k = currentFk;
  for (const link of fkeyBody.chain) {        // chain[0] is epoch-1 under epoch, chain[1] is epoch-2 under epoch-1, …
    k = unwrapKey(link, k);
    if (!k) return null;
    if (link.epoch === epoch) return k;
  }
  return null;
}

export function encryptPost(text, fk) {
  const nonce = randomBytes(secretbox.NONCE_LENGTH);
  return { nonce: toHex(nonce), ct: toHex(secretbox.seal(utf8(text), nonce, fk)) };
}
export function decryptPost(body, fk) {
  try {
    const plain = secretbox.open(fromHex(body.ct), fromHex(body.nonce), fk);
    return plain ? fromUtf8(plain) : null;
  } catch { return null; }
}
