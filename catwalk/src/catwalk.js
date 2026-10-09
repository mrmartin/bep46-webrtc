// Catwalk's application layer: what a signed-in cat can do, and what anyone
// can read, on top of an accounts Directory (who exists) and a social Ledger
// (what they published). Everything runs on the user's device; the only
// outputs are signed records dropped into the ledger, which the Replica
// gossips to everyone else.

import { toHex } from '../../accounts/src/bytes.js';
import { randomBytes } from '../../accounts/src/crypto.js';
import {
  SOCIAL_VERSION, FUR, EYES, LIMITS, signSocial,
  profileId, fkeyId, friendId, pokeId, postId,
} from './social.js';
import * as P from './privacy.js';

export class CatwalkError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export class Catwalk {
  /**
   * @param {{ directory: import('../../accounts/src/directory.js').Directory,
   *           ledger: import('./ledger.js').Ledger, now?: () => number }} opts
   */
  constructor({ directory, ledger, now = () => Date.now() }) {
    this.directory = directory;
    this.ledger = ledger;
    this.now = now;
    this.me = null;          // { pk, secretKey, box:{publicKey, secretKey} } while signed in
    this._fkCache = new Map(); // `${author}:${fkeySeq}` → current friends key (Uint8Array)
  }

  // ---- who ---------------------------------------------------------------

  account(pk) { const r = this.directory.get(pk); return r && !r.deleted ? r : null; }
  username(pk) { return this.account(pk)?.user ?? null; }
  profile(pk) { const r = this.ledger.get(profileId(pk)); return r && !r.deleted ? r.body : null; }
  profileTs(pk) { const r = this.ledger.get(profileId(pk)); return r && !r.deleted ? r.ts : null; }
  displayName(pk) { return this.profile(pk)?.name || this.username(pk) || pk.slice(0, 8) + '…'; }

  /** Every live account, with its profile if it has one. */
  members() {
    return this.directory.listUsers().map((a) => ({
      pk: a.pk, user: a.user, since: a.ts, profile: this.profile(a.pk), name: this.displayName(a.pk),
      friends: this.friendsOf(a.pk).length,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- session ------------------------------------------------------------

  unlock(session) {
    this.me = { pk: session.pk, secretKey: session.secretKey, box: P.boxKeyPair(session.secretKey) };
    this._fkCache.clear();
    return this.me;
  }
  lock() { this.me = null; this._fkCache.clear(); }
  _need() { if (!this.me) throw new CatwalkError('signed_out', 'sign in first'); return this.me; }

  _publish(unsigned) {
    const me = this._need();
    const rec = signSocial(unsigned, me.secretKey);
    const res = this.ledger.ingest(rec, { local: true });
    if (!res.accepted) throw new CatwalkError('publish_failed', `ledger refused record: ${res.reason}`);
    return this.ledger.get(rec.id);
  }
  _record(kind, id, body) {
    const me = this._need();
    return { v: SOCIAL_VERSION, kind, id, owner: me.pk, seq: this.ledger.nextSeq(id), ts: this.now(), deleted: false, body };
  }
  _tombstone(kind, id) {
    const me = this._need();
    return this._publish({ v: SOCIAL_VERSION, kind, id, owner: me.pk, seq: this.ledger.nextSeq(id), ts: this.now(), deleted: true });
  }

  // ---- profile ------------------------------------------------------------

  setProfile({ name, tagline = '', about = '', fur = 'tabby', eyes = 'green' }) {
    const me = this._need();
    name = String(name ?? '').trim().normalize('NFC');
    if (!name || name.length > LIMITS.name) throw new CatwalkError('bad_name', `a name is 1–${LIMITS.name} characters`);
    if (!FUR.includes(fur) || !EYES.includes(eyes)) throw new CatwalkError('bad_look', 'pick a fur and eye colour from the list');
    tagline = String(tagline ?? '').trim().normalize('NFC').slice(0, LIMITS.tagline);
    about = String(about ?? '').trim().normalize('NFC').slice(0, LIMITS.about);
    const body = { name, tagline, about, fur, eyes, box: toHex(me.box.publicKey) };
    const rec = this._publish(this._record('profile', profileId(me.pk), body));
    this.reconcile();
    return rec;
  }

  // ---- friends ------------------------------------------------------------

  friendRecord(from, to) { const r = this.ledger.get(friendId(from, to)); return r && !r.deleted ? r : null; }
  isFriend(a, b) { return !!(this.friendRecord(a, b) && this.friendRecord(b, a)); }
  friendsOf(pk) {
    return this.ledger.byOwner(pk, 'friend').map((r) => r.body.to)
      .filter((o) => this.friendRecord(o, pk) && this.account(o));
  }
  /** Cats who asked `pk` to be friends and are still waiting. */
  pendingIncoming(pk) {
    return this.ledger.ofKind('friend').filter((r) => r.body.to === pk && !this.friendRecord(pk, r.owner) && this.account(r.owner))
      .sort((a, b) => b.ts - a.ts).map((r) => ({ pk: r.owner, ts: r.ts }));
  }
  pendingOutgoing(pk) {
    return this.ledger.byOwner(pk, 'friend').filter((r) => !this.friendRecord(r.body.to, pk) && this.account(r.body.to))
      .sort((a, b) => b.ts - a.ts).map((r) => ({ pk: r.body.to, ts: r.ts }));
  }
  relation(viewer, other) {
    if (!viewer || viewer === other) return 'self';
    if (this.isFriend(viewer, other)) return 'friends';
    if (this.friendRecord(viewer, other)) return 'requested';
    if (this.friendRecord(other, viewer)) return 'wants';
    return 'none';
  }

  addFriend(otherPk) {
    const me = this._need();
    if (otherPk === me.pk) throw new CatwalkError('self', 'you are already your own best friend');
    if (!this.account(otherPk)) throw new CatwalkError('unknown', 'no such cat');
    if (!this.friendRecord(me.pk, otherPk)) this._publish(this._record('friend', friendId(me.pk, otherPk), { to: otherPk }));
    this.grant(otherPk);
    return this.relation(me.pk, otherPk);
  }
  removeFriend(otherPk) {
    const me = this._need();
    if (this.friendRecord(me.pk, otherPk)) this._tombstone('friend', friendId(me.pk, otherPk));
    this.revoke(otherPk);
  }

  // ---- friends key (who can read my friends-only posts) --------------------

  myFkey() { const me = this._need(); const r = this.ledger.get(fkeyId(me.pk)); return r && !r.deleted ? r : null; }

  /** The current friends key, creating epoch 1 (sealed to myself) on first use. */
  _myFk() {
    const me = this._need();
    const rec = this.myFkey();
    if (rec) {
      const hit = this._fkCache.get(`${me.pk}:${rec.seq}`);
      if (hit) return hit;
      const mine = rec.body.keys[me.pk];
      const fk = mine && P.openKeyFrom(mine, toHex(me.box.publicKey), me.box.secretKey);
      if (!fk) throw new CatwalkError('lost_key', 'your friends key cannot be opened with this account key');
      this._fkCache.set(`${me.pk}:${rec.seq}`, fk);
      return fk;
    }
    const fk = P.newFriendsKey();
    const keys = { [me.pk]: P.sealKeyTo(fk, toHex(me.box.publicKey), me.box.secretKey) };
    const out = this._publish(this._record('fkey', fkeyId(me.pk), { epoch: 1, keys, chain: [] }));
    this._fkCache.set(`${me.pk}:${out.seq}`, fk);
    return fk;
  }

  /** Seal my current friends key to `otherPk` (needs their profile's box key). Returns true if a record was written. */
  grant(otherPk) {
    const me = this._need();
    const theirBox = this.profile(otherPk)?.box;
    if (!theirBox) return false;
    const fk = this._myFk();
    const rec = this.myFkey();
    if (rec.body.keys[otherPk]) return false;
    const keys = { ...rec.body.keys, [otherPk]: P.sealKeyTo(fk, theirBox, me.box.secretKey) };
    const out = this._publish(this._record('fkey', fkeyId(me.pk), { epoch: rec.body.epoch, keys, chain: rec.body.chain }));
    this._fkCache.set(`${me.pk}:${out.seq}`, fk);
    return true;
  }

  /** Start a new epoch without `otherPk`: they keep what they could read, nothing after. */
  revoke(otherPk) {
    const me = this._need();
    const rec = this.myFkey();
    if (!rec || !rec.body.keys[otherPk]) return false;
    const oldFk = this._myFk();
    const fk = P.newFriendsKey();
    const keys = {};
    for (const pk of Object.keys(rec.body.keys)) {
      if (pk === otherPk) continue;
      const theirBox = pk === me.pk ? toHex(me.box.publicKey) : this.profile(pk)?.box;
      if (theirBox) keys[pk] = P.sealKeyTo(fk, theirBox, me.box.secretKey);
    }
    const chain = [{ epoch: rec.body.epoch, ...P.wrapKey(oldFk, fk) }, ...rec.body.chain];
    const out = this._publish(this._record('fkey', fkeyId(me.pk), { epoch: rec.body.epoch + 1, keys, chain }));
    this._fkCache.set(`${me.pk}:${out.seq}`, fk);
    return true;
  }

  /** Give every friend (and every cat I asked) who now has a profile a copy of my key. Returns how many were granted. */
  reconcile() {
    const me = this._need();
    let n = 0;
    const wanted = new Set(this.ledger.byOwner(me.pk, 'friend').map((r) => r.body.to));
    for (const pk of wanted) if (this.account(pk) && this.grant(pk)) n++;
    return n;
  }

  /** Friends key of `author` for `epoch`, if they sealed one to me. */
  _fkOf(author, epoch) {
    const me = this.me;
    if (!me) return null;
    if (author === me.pk) { const fk = this._myFk(); return P.keyForEpoch(this.myFkey().body, fk, epoch); }
    const rec = this.ledger.get(fkeyId(author));
    if (!rec || rec.deleted) return null;
    const theirBox = this.profile(author)?.box;
    const entry = rec.body.keys[me.pk];
    if (!theirBox || !entry) return null;
    const ck = `${author}:${rec.seq}`;
    let cur = this._fkCache.get(ck);
    if (!cur) {
      cur = P.openKeyFrom(entry, theirBox, me.box.secretKey);
      if (!cur) return null;
      this._fkCache.set(ck, cur);
    }
    return P.keyForEpoch(rec.body, cur, epoch);
  }

  // ---- posts --------------------------------------------------------------

  post(text, aud = 'public') {
    const me = this._need();
    text = String(text ?? '').trim().normalize('NFC');
    if (!text) throw new CatwalkError('empty', 'write something first');
    if (text.length > LIMITS.postText) throw new CatwalkError('too_long', `posts are at most ${LIMITS.postText} characters`);
    const id = postId(me.pk, toHex(randomBytes(8)));
    if (aud === 'public') return this._publish(this._record('post', id, { aud: 'public', text }));
    if (aud !== 'friends') throw new CatwalkError('bad_audience', 'audience is public or friends');
    const fk = this._myFk();
    const { epoch } = this.myFkey().body;
    return this._publish(this._record('post', id, { aud: 'friends', epoch, ...P.encryptPost(text, fk) }));
  }
  deletePost(id) {
    const me = this._need();
    const r = this.ledger.get(id);
    if (!r || r.deleted || r.kind !== 'post' || r.owner !== me.pk) throw new CatwalkError('not_yours', 'not your post');
    return this._tombstone('post', id);
  }

  /** Render one post record for the signed-in viewer (or a visitor). */
  readPost(r) {
    const base = { id: r.id, owner: r.owner, name: this.displayName(r.owner), ts: r.ts, aud: r.body.aud };
    if (r.body.aud === 'public') return { ...base, text: r.body.text, locked: false };
    const fk = this._fkOf(r.owner, r.body.epoch);
    const text = fk ? P.decryptPost(r.body, fk) : null;
    return { ...base, text, locked: text === null };
  }

  /** What the current viewer may see: public posts, own posts, and friends' friends-only posts. */
  _visible(r) {
    if (!this.account(r.owner)) return false;
    if (r.body.aud === 'public') return true;
    const me = this.me?.pk;
    return !!me && (r.owner === me || this.isFriend(me, r.owner));
  }
  feed({ limit = 100 } = {}) {
    return this.ledger.ofKind('post').filter((r) => this._visible(r))
      .sort((a, b) => b.ts - a.ts).slice(0, limit).map((r) => this.readPost(r));
  }
  wall(pk, { limit = 100 } = {}) {
    return this.ledger.byOwner(pk, 'post').filter((r) => this._visible(r))
      .sort((a, b) => b.ts - a.ts).slice(0, limit).map((r) => this.readPost(r));
  }

  // ---- pokes --------------------------------------------------------------

  poke(otherPk) {
    const me = this._need();
    if (otherPk === me.pk) throw new CatwalkError('self', 'poking yourself achieves nothing');
    if (!this.account(otherPk)) throw new CatwalkError('unknown', 'no such cat');
    return this._publish(this._record('poke', pokeId(me.pk, otherPk), { to: otherPk }));
  }
  pokesFor(pk) {
    return this.ledger.ofKind('poke').filter((r) => r.body.to === pk && this.account(r.owner))
      .sort((a, b) => b.ts - a.ts).map((r) => ({ pk: r.owner, name: this.displayName(r.owner), ts: r.ts, id: r.id }));
  }
  /** Clear a poke aimed at me by tombstoning — no: pokes belong to the poker. We just remember what we saw. */
}
