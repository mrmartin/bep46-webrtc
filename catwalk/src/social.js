// Catwalk's social records — everything a cat publishes besides its account.
//
// {
//   v: 1,
//   kind: "profile" | "friend" | "post" | "poke" | "fkey",
//   id: "<kind>:<owner>[:<suffix>]",   // the replicated-map key; ownership is baked into it
//   owner: "<64 hex>",                 // the account root key (same keypair as the account record)
//   seq: 3,                            // strictly increasing per id; stale/replayed versions are dropped
//   ts: 1696680000000,                 // when the owner wrote it (informational; ordering in feeds)
//   deleted: false,
//   body: { … per kind, see below … }, // absent on tombstones
//   sig: "<128 hex>"                   // ed25519(owner secret key) over DOMAIN || canonical(record without sig)
// }
//
// Bodies:
//   profile  { name, tagline, about, fur, eyes, box }     box = x25519 public key for friends-only posts
//   friend   { to }                                       "owner wants to be friends with `to`"; mutual = friends
//   poke     { to }                                       re-poking bumps seq; `ts` is the latest poke
//   post     { aud:"public", text }                       readable by everyone
//            { aud:"friends", epoch, nonce, ct }          secretbox(text) under the owner's friends key for `epoch`
//   fkey     { epoch, keys:{ [pk]: {nonce, ct} }, chain:[{epoch, nonce, ct}, …] }
//            keys[pk] = box(FK_epoch) sealed to that friend's profile `box` key (and to the owner itself);
//            chain[i] = secretbox(FK_{epoch-1-i}) under FK_{epoch-i}, so a friend holding the current
//            key can unwind to every earlier one. Removing a friend starts a new epoch and re-seals
//            only to the remaining friends; since one fkey record replaces the previous one, the
//            removed friend is left with no key at all (bar whatever they cached while they had it).
//
// Identity is the account key from the accounts layer; the username→pk index
// lives there too. A record is only valid if its `id` starts with
// "<kind>:<owner>", so nobody can publish a profile or friend link for
// somebody else, whatever they sign it with.

import { canonicalize } from '../../accounts/src/canonical.js';
import { toHex, fromHex, isHex, utf8, concat } from '../../accounts/src/bytes.js';
import { ed25519, secretbox, box as naclBox } from '../../accounts/src/crypto.js';

export const SOCIAL_VERSION = 1;
export const SIGN_DOMAIN = utf8('catwalk/record/v1\n');
export const KINDS = Object.freeze(['profile', 'friend', 'post', 'poke', 'fkey']);
export const FUR = Object.freeze(['ginger', 'grey', 'black', 'white', 'tabby', 'calico', 'siamese', 'tuxedo']);
export const EYES = Object.freeze(['green', 'amber', 'blue', 'copper', 'odd']);
export const LIMITS = Object.freeze({
  name: 40, tagline: 120, about: 1000, postText: 1000,
  maxFriendKeys: 5000, maxChain: 1000, maxPostCipherHex: 2 * (4 * 1000 + secretbox.OVERHEAD),
});
const MAX_TS = 4102444800000;

const PK = (s) => isHex(s, ed25519.PUBLIC_KEY_LENGTH);
const NONCE = (s) => isHex(s, secretbox.NONCE_LENGTH);
const KEY_CT = (s) => isHex(s, secretbox.KEY_LENGTH + secretbox.OVERHEAD); // a sealed 32-byte key

export function postId(owner, suffixHex) { return `post:${owner}:${suffixHex}`; }
export function profileId(owner) { return `profile:${owner}`; }
export function fkeyId(owner) { return `fkey:${owner}`; }
export function friendId(owner, to) { return `friend:${owner}:${to}`; }
export function pokeId(owner, to) { return `poke:${owner}:${to}`; }

export function signingBytes(record) {
  const { sig, ...unsigned } = record;
  return concat(SIGN_DOMAIN, utf8(canonicalize(unsigned)));
}

export function signSocial(unsigned, secretKey) {
  return { ...unsigned, sig: toHex(ed25519.sign(signingBytes(unsigned), secretKey)) };
}

const bad = (reason) => ({ ok: false, reason });
const str = (v, max) => typeof v === 'string' && v.length <= max && v === v.normalize('NFC') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const keysAre = (o, list) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...list].sort().join(',');

function validateBody(kind, id, owner, b) {
  switch (kind) {
    case 'profile': {
      if (id !== profileId(owner)) return 'bad profile id';
      if (!keysAre(b, ['name', 'tagline', 'about', 'fur', 'eyes', 'box'])) return 'bad profile fields';
      if (!str(b.name, LIMITS.name) || !b.name.trim()) return 'bad name';
      if (!str(b.tagline, LIMITS.tagline) || !str(b.about, LIMITS.about)) return 'bad tagline/about';
      if (!FUR.includes(b.fur) || !EYES.includes(b.eyes)) return 'bad fur/eyes';
      if (!isHex(b.box, naclBox.PUBLIC_KEY_LENGTH)) return 'bad box key';
      return null;
    }
    case 'friend':
    case 'poke': {
      if (!keysAre(b, ['to']) || !PK(b.to) || b.to === owner) return `bad ${kind} target`;
      if (id !== (kind === 'friend' ? friendId(owner, b.to) : pokeId(owner, b.to))) return `bad ${kind} id`;
      return null;
    }
    case 'post': {
      const m = /^post:([0-9a-f]{64}):([0-9a-f]{16})$/.exec(id);
      if (!m || m[1] !== owner) return 'bad post id';
      if (b?.aud === 'public') {
        if (!keysAre(b, ['aud', 'text'])) return 'bad post fields';
        if (!str(b.text, LIMITS.postText) || !b.text.trim()) return 'bad post text';
        return null;
      }
      if (b?.aud === 'friends') {
        if (!keysAre(b, ['aud', 'epoch', 'nonce', 'ct'])) return 'bad post fields';
        if (!Number.isSafeInteger(b.epoch) || b.epoch < 1) return 'bad epoch';
        if (!NONCE(b.nonce)) return 'bad nonce';
        if (typeof b.ct !== 'string' || !/^[0-9a-f]+$/.test(b.ct) || b.ct.length % 2 || b.ct.length > LIMITS.maxPostCipherHex || b.ct.length < 2 * secretbox.OVERHEAD) return 'bad ciphertext';
        return null;
      }
      return 'bad audience';
    }
    case 'fkey': {
      if (id !== fkeyId(owner)) return 'bad fkey id';
      if (!keysAre(b, ['epoch', 'keys', 'chain'])) return 'bad fkey fields';
      if (!Number.isSafeInteger(b.epoch) || b.epoch < 1) return 'bad epoch';
      if (!b.keys || typeof b.keys !== 'object' || Array.isArray(b.keys)) return 'bad keys';
      const ks = Object.keys(b.keys);
      if (ks.length > LIMITS.maxFriendKeys) return 'too many keys';
      for (const pk of ks) {
        const e = b.keys[pk];
        if (!PK(pk) || !keysAre(e, ['nonce', 'ct']) || !NONCE(e.nonce) || !KEY_CT(e.ct)) return 'bad key entry';
      }
      if (!Array.isArray(b.chain) || b.chain.length > LIMITS.maxChain || b.chain.length !== b.epoch - 1) return 'bad chain length';
      for (let i = 0; i < b.chain.length; i++) {
        const c = b.chain[i];
        if (!keysAre(c, ['epoch', 'nonce', 'ct']) || c.epoch !== b.epoch - 1 - i || !NONCE(c.nonce) || !KEY_CT(c.ct)) return 'bad chain entry';
      }
      return null;
    }
    default:
      return 'unknown kind';
  }
}

// Structural validation + signature. Returns { ok: true } or { ok: false, reason }.
export function validateSocial(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('not an object');
  const allowed = new Set(['v', 'kind', 'id', 'owner', 'seq', 'ts', 'deleted', 'body', 'sig']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return bad(`unknown field ${k}`);
  if (r.v !== SOCIAL_VERSION) return bad('bad version');
  if (!KINDS.includes(r.kind)) return bad('bad kind');
  if (typeof r.id !== 'string' || r.id.length > 200 || !r.id.startsWith(`${r.kind}:`)) return bad('bad id');
  if (!PK(r.owner)) return bad('bad owner');
  if (!Number.isSafeInteger(r.seq) || r.seq < 1) return bad('bad seq');
  if (!Number.isSafeInteger(r.ts) || r.ts < 0 || r.ts > MAX_TS) return bad('bad ts');
  if (typeof r.deleted !== 'boolean') return bad('bad deleted');
  if (!isHex(r.sig, ed25519.SIGNATURE_LENGTH)) return bad('bad sig');
  if (r.deleted) {
    if (r.body !== undefined) return bad('tombstone carries a body');
    // A tombstone still has to be for an id this owner could have created.
    const m = /^([a-z]+):([0-9a-f]{64})(?::|$)/.exec(r.id);
    if (!m || m[2] !== r.owner) return bad('tombstone id/owner mismatch');
  } else {
    const why = validateBody(r.kind, r.id, r.owner, r.body);
    if (why) return bad(why);
  }
  if (!ed25519.verify(signingBytes(r), fromHex(r.sig), fromHex(r.owner))) return bad('bad signature');
  return { ok: true };
}

export function ownerOf(id) {
  const m = /^[a-z]+:([0-9a-f]{64})/.exec(id);
  return m ? m[1] : null;
}
