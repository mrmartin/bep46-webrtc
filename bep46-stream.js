/*  bep46-stream.js — peer-to-peer live streaming substrate
 *  ───────────────────────────────────────────────────────
 *  Builds on the same pieces as bep46-webrtc.html: a WebTorrent swarm found
 *  through a WebSocket tracker, ed25519 identities (TweetNaCl) and signed
 *  records gossiped over a custom wire extension.  On top of that control
 *  plane it adds a live data plane shaped like Media over QUIC:
 *
 *    track  = one rendition of one publisher ('vh' full video, 'vl' low
 *             video, 'a' audio)
 *    group  = frames from one keyframe to the next (what a late joiner
 *             receives in a burst so it can start decoding immediately)
 *    object = one encoded frame, split into ≤16 KB chunks and sent over an
 *             UNORDERED, lossy-by-design WebRTC data channel
 *
 *  Every viewer is a relay.  A subscriber asks the publisher for a track; the
 *  publisher serves it if it has upload budget left, otherwise it redirects
 *  the subscriber to one of the peers it is already serving.  Relays forward
 *  chunks the moment they arrive (no transcoding, no reassembly wait), so a
 *  hop costs tens of milliseconds, and keep the current group cached.
 *
 *  Authentication is a periodic handshake on every wire (proof of the room
 *  secret + ed25519 signature, repeated every few minutes), never per frame.
 *  Control messages (presence, link signaling) are signed; media is not — it
 *  travels only over wires/links whose peers already proved membership.
 *
 *  Browser: <script src="tweetnacl"> <script src="webtorrent@1.9.7"> then
 *  this file; it defines window.BEP46Stream.  Node: require() gives the
 *  pure parts (framing, crypto, selector) for unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('tweetnacl'));
  } else {
    root.BEP46Stream = factory(root.nacl);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nacl) {
'use strict';

/* ───────────────────────── small utilities ───────────────────────── */
const enc = new TextEncoder(), dec = new TextDecoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64R = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; m[43] = 62; m[47] = 63; return m; })();
function b64u(bytes) {
  let s = '', i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const r = bytes.length - i;
    const n = (bytes[i] << 16) | ((r > 1 ? bytes[i + 1] : 0) << 8);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (r > 1 ? B64[(n >> 6) & 63] : '');
  }
  return s;
}
function unb64u(s) {
  if (typeof s !== 'string') return new Uint8Array(0);
  s = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i); const v = c < 128 ? B64R[c] : -1;
    if (v < 0) return new Uint8Array(0);
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out.subarray(0, o);
}
const toHex = u => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => { const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };

/* same SHA-1 as bep46-webrtc.html so both files derive identical swarm ids */
function sha1hex(bytes) {
  function rol(n, s) { return (n << s) | (n >>> (32 - s)); }
  const ml = bytes.length * 8;
  const withOne = new Uint8Array(((bytes.length + 8) >> 6) + 1 << 6);
  withOne.set(bytes); withOne[bytes.length] = 0x80;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, ml >>> 0, false);
  dv.setUint32(withOne.length - 8, Math.floor(ml / 0x100000000), false);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getInt32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const tmp = (rol(a, 5) + f + e + k + w[j]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/* epoch microseconds — the one clock every frame timestamp uses */
const nowUs = (typeof performance !== 'undefined' && performance.timeOrigin)
  ? () => Math.round((performance.timeOrigin + performance.now()) * 1000)
  : () => Date.now() * 1000;
const nowMs = () => Date.now();
const randId = (n = 12) => b64u(nacl.randomBytes(n));

class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { (this._h.get(ev) || this._h.set(ev, new Set()).get(ev)).add(fn); return this; }
  off(ev, fn) { const s = this._h.get(ev); if (s) s.delete(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  emit(ev, ...a) { const s = this._h.get(ev); if (s) for (const fn of Array.from(s)) { try { fn(...a); } catch (e) { console.error('[bep46-stream] handler error', ev, e); } } }
}

/* ───────────────────────── identity & room ───────────────────────── */
function newIdentity() {
  const kp = nacl.sign.keyPair();
  return { pk: kp.publicKey, sk: kp.secretKey, id: b64u(kp.publicKey) };
}
function identityFromSecret(hex) {
  const kp = nacl.sign.keyPair.fromSecretKey(fromHex(hex));
  return { pk: kp.publicKey, sk: kp.secretKey, id: b64u(kp.publicKey) };
}
function newRoomSecret() { return b64u(nacl.randomBytes(16)); }
/* The link carries the secret; the tracker only ever sees sha1 of it. */
function deriveRoom(secret) {
  return {
    secret,
    infoHash: sha1hex(enc.encode('bep46-call|' + secret)),
    key: nacl.hash(enc.encode('bep46-call-key|' + secret)).slice(0, 32)
  };
}

/* ───────────────────────── signed envelopes ─────────────────────────
   Gossip is signed by the sender's ed25519 key.  The body travels as a
   pre-serialised string so the bytes that were signed are the bytes that
   are verified, whatever JSON engine is on the other side.               */
const envBytes = e => enc.encode([e.i, e.f, e.o || '', e.k, e.s, e.b].join('\n'));
function signEnvelope(identity, kind, body, to, ttl) {
  const e = { i: randId(9), f: identity.id, o: to || '', k: kind, s: nowMs(), b: JSON.stringify(body), l: ttl };
  e.g = b64u(nacl.sign.detached(envBytes(e), identity.sk));
  return e;
}
function verifyEnvelope(e) {
  if (!e || typeof e !== 'object') return false;
  for (const k of ['i', 'f', 'k', 'b', 'g']) if (typeof e[k] !== 'string') return false;
  if (typeof e.s !== 'number') return false;
  const pk = unb64u(e.f); if (pk.length !== 32) return false;
  const sig = unb64u(e.g); if (sig.length !== 64) return false;
  try { return nacl.sign.detached.verify(envBytes(e), sig, pk); } catch (err) { return false; }
}

/* ───────────────────────── wire handshake ─────────────────────────
   Round r between two wire peers: initiator (lower id) sends a nonce, the
   responder answers with its nonce plus proof, the initiator proves back.
   proof = ed25519 signature of the transcript (identity) + HMAC of the
   transcript under the room key (membership).  Repeated periodically.     */
function hsTranscript(infoHash, idA, idB, nonceA, nonceB, round) {
  const aFirst = idA < idB;
  const lo = aFirst ? idA : idB, hi = aFirst ? idB : idA;
  const nlo = aFirst ? nonceA : nonceB, nhi = aFirst ? nonceB : nonceA;
  return enc.encode(['bep46-call-hs', infoHash, lo, hi, nlo, nhi, String(round)].join('|'));
}
/* keyed hash (nested SHA-512, HMAC-shaped) — TweetNaCl's browser build has no nacl.auth */
function concatBytes(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function roomTag(transcript, roomKey) {
  return nacl.hash(concatBytes(roomKey, nacl.hash(concatBytes(roomKey, transcript)))).slice(0, 32);
}
function hsProve(transcript, identity, roomKey) {
  return { sig: b64u(nacl.sign.detached(transcript, identity.sk)), tag: b64u(roomTag(transcript, roomKey)) };
}
function hsVerify(transcript, sig, tag, pk, roomKey) {
  try {
    const s = unb64u(sig), t = unb64u(tag);
    if (s.length !== 64 || t.length !== 32 || pk.length !== 32) return false;
    return nacl.sign.detached.verify(transcript, s, pk) && nacl.verify(t, roomTag(transcript, roomKey));
  } catch (e) { return false; }
}

/* ───────────────────────── media framing ─────────────────────────
   20-byte little-endian header in front of every chunk:
     u8 type (1 video, 2 audio)  u8 flags (bit0 keyframe)  u16 sid
     u32 seq  u16 idx  u16 cnt  f64 timestamp (µs, publisher clock)
   sid is link-local: the sender assigns it per (link, stream) in sub-ok and
   a relay rewrites just those two bytes when forwarding.                  */
const HDR = 20, MAX_CHUNK = 16000, T_VIDEO = 1, T_AUDIO = 2, F_KEY = 1;
function readHeader(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HDR) return null;
  const dv = new DataView(buf);
  const flags = dv.getUint8(1);
  return { type: dv.getUint8(0), flags, key: !!(flags & F_KEY), sid: dv.getUint16(2, true), seq: dv.getUint32(4, true),
    idx: dv.getUint16(8, true), cnt: dv.getUint16(10, true), ts: dv.getFloat64(12, true), len: buf.byteLength - HDR };
}
function chunkFrame(type, sid, seq, flags, ts, data) {
  const cnt = Math.max(1, Math.ceil(data.length / MAX_CHUNK));
  if (cnt > 65535) throw new Error('frame too large');
  const out = [];
  for (let i = 0; i < cnt; i++) {
    const part = data.subarray(i * MAX_CHUNK, Math.min(data.length, (i + 1) * MAX_CHUNK));
    const buf = new ArrayBuffer(HDR + part.length);
    const dv = new DataView(buf);
    dv.setUint8(0, type); dv.setUint8(1, flags); dv.setUint16(2, sid, true); dv.setUint32(4, seq >>> 0, true);
    dv.setUint16(8, i, true); dv.setUint16(10, cnt, true); dv.setFloat64(12, ts, true);
    new Uint8Array(buf, HDR).set(part);
    out.push(buf);
  }
  return out;
}
function withSid(buf, sid) { const c = buf.slice(0); new DataView(c).setUint16(2, sid, true); return c; }

/* Puts chunks back into frames.  Tolerates reordering, duplicates and loss;
   a frame whose chunks never all arrive is forgotten after maxAgeMs or
   once `window` newer frames have been seen.                               */
class Reassembler {
  constructor(opts = {}) { this.pending = new Map(); this.latest = -1; this.maxAgeMs = opts.maxAgeMs || 1500; this.window = opts.window || 64; this.dropped = 0; this._n = 0; }
  add(h, buf, now = nowMs()) {
    if (h.cnt === 1) { if (h.seq > this.latest) this.latest = h.seq; return { seq: h.seq, key: h.key, ts: h.ts, type: h.type, data: new Uint8Array(buf, HDR) }; }
    let e = this.pending.get(h.seq);
    if (!e) {
      if (this.latest >= 0 && h.seq < this.latest - this.window) return null;    // ancient
      e = { parts: new Array(h.cnt), got: 0, bytes: 0, t: now, key: h.key, ts: h.ts, type: h.type, cnt: h.cnt };
      this.pending.set(h.seq, e);
    }
    if (h.idx >= e.cnt || e.parts[h.idx]) return null;                             // bogus or duplicate
    e.parts[h.idx] = new Uint8Array(buf, HDR); e.got++; e.bytes += buf.byteLength - HDR;
    if ((++this._n & 31) === 0) this.prune(now);
    if (e.got < e.cnt) return null;
    this.pending.delete(h.seq);
    if (h.seq > this.latest) this.latest = h.seq;
    const data = new Uint8Array(e.bytes); let o = 0;
    for (const p of e.parts) { data.set(p, o); o += p.length; }
    return { seq: h.seq, key: e.key, ts: e.ts, type: e.type, data };
  }
  prune(now = nowMs()) {
    for (const [seq, e] of this.pending) {
      if (now - e.t > this.maxAgeMs || seq < this.latest - this.window) { this.pending.delete(seq); this.dropped++; }
    }
  }
}

/* The current group of pictures, kept as raw chunks so a new child can be
   brought up to speed with one burst and start decoding on the keyframe.   */
class GroupCache {
  constructor(maxBytes = 900000) { this.frames = []; this.bytes = 0; this.cur = null; this.maxBytes = maxBytes; }
  add(h, buf) {
    if (h.key && h.idx === 0 && !(this.cur && this.cur.seq === h.seq)) { this.frames = []; this.bytes = 0; this.cur = null; }
    let f = this.cur && this.cur.seq === h.seq ? this.cur : null;
    if (!f) {
      if (!this.frames.length && !h.key) return;            // nothing decodable yet
      f = { seq: h.seq, cnt: h.cnt, chunks: new Array(h.cnt), got: 0, key: h.key };
      this.frames.push(f); this.cur = f;
    }
    if (!f.chunks[h.idx]) { f.chunks[h.idx] = buf; f.got++; this.bytes += buf.byteLength; }
    if (this.bytes > this.maxBytes) { this.frames = []; this.bytes = 0; this.cur = null; }
  }
  /* complete frames from the keyframe up to the first incomplete one */
  burst() {
    const out = [];
    for (const f of this.frames) { if (f.got < f.cnt) break; for (const c of f.chunks) out.push(c); }
    return out;
  }
  clear() { this.frames = []; this.bytes = 0; this.cur = null; }
}

/* ───────────────────────── speaker selection ─────────────────────────
   "Nobody wants to hear more than three people at once."  Picks up to
   `max` ids to listen to from presence data, with hysteresis so a cough
   does not reshuffle the stage, and always includes pinned ids.           */
class SpeakerSelector {
  constructor(opts = {}) { this.max = opts.max || 3; this.holdMs = opts.holdMs || 2500; this.current = new Set(); }
  /* peers: [{id, speaking, level, lastSpokeAt}], pinned: Set<id> */
  update(now, peers, pinned = new Set()) {
    const score = p => (p.speaking ? 2 + (p.level || 0) : 0) + (p.lastSpokeAt ? Math.max(0, 1 - (now - p.lastSpokeAt) / 120000) : 0);
    const byId = new Map(peers.map(p => [p.id, p]));
    const next = new Set();
    for (const id of pinned) if (byId.has(id)) next.add(id);
    const ranked = peers.filter(p => !next.has(p.id)).sort((a, b) => score(b) - score(a));
    for (const id of this.current) {                       // keep current members while they are relevant
      const p = byId.get(id);
      if (p && !next.has(id) && next.size < this.max && (p.speaking || (p.lastSpokeAt && now - p.lastSpokeAt < this.holdMs) || !ranked.some(q => score(q) > score(p) && !this.current.has(q.id)))) next.add(id);
    }
    for (const p of ranked) { if (next.size >= this.max) break; if (!next.has(p.id)) next.add(p.id); }
    this.current = next;
    return next;
  }
}

/* ───────────────────────── Room: swarm control plane ─────────────────────────
   Finds peers through the tracker (via WebTorrent on a content-less info
   hash), authenticates every wire with the handshake above and floods signed
   gossip (presence, link signaling) with de-duplication.                  */
const DEFAULT_TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'];
const EXT = 'bep46call';

class Room extends Emitter {
  constructor(opts) {
    super();
    const WT = opts.WebTorrent || (typeof root !== 'undefined' && root.WebTorrent) || (typeof WebTorrent !== 'undefined' ? WebTorrent : null);
    if (!WT && !opts.client) throw new Error('WebTorrent not available');
    this.identity = opts.identity || newIdentity();
    this.id = this.identity.id;
    this.room = deriveRoom(opts.secret);
    this.trackers = (opts.trackers && opts.trackers.length) ? opts.trackers : DEFAULT_TRACKERS;
    this.rtcConfig = opts.rtcConfig || undefined;
    this.log = opts.log || (() => {});
    this.hsIntervalMs = opts.hsIntervalMs || 5 * 60 * 1000;
    this.peers = new Map();          // id -> peer wire state
    this.seen = new Map();           // envelope id -> ms
    this.roster = new Map();         // id -> presence entry (others only)
    this.presence = { n: 'Guest', q: 0 };
    this.destroyed = false;
    this._ownClient = !opts.client;
    this.client = opts.client || new WT({ tracker: { rtcConfig: this.rtcConfig } });
    this.client.on('error', e => this.emit('error', e));
    this.torrent = this.client.add(this.room.infoHash, { announce: this.trackers, name: 'bep46-call', private: true });
    this.torrent.on('wire', w => this._attach(w));
    this.torrent.on('warning', e => this.emit('warning', e));
    this.torrent.on('error', e => this.emit('error', e));
    this.torrent.on('trackerAnnounce', () => this.emit('tracker'));
    this._timers = [
      setInterval(() => this._prune(), 5000),
      setInterval(() => this.broadcastPresence(), 2000),
      setInterval(() => this._rehandshake(), 15000)
    ];
  }

  /* ---- wires ---- */
  _attach(wire) {
    const self = this;
    const pw = { wire, id: null, pk: null, authed: false, round: 0, myNonce: null, theirNonce: null, pendingRound: 0, hsAt: 0, authedAt: 0, since: nowMs(), ext: null };
    function Ext(w) { this.w = w; }
    Ext.prototype.name = EXT;
    Ext.prototype.onExtendedHandshake = function () {
      pw.ext = this;
      self._send(pw, { t: 'hello', v: 1, id: self.id });
      pw.hsAt = nowMs();
    };
    Ext.prototype.onMessage = function (buf) {
      let txt; try { txt = dec.decode(buf); } catch (e) { return; }
      const m = txt.match(/^(\d+):/); if (m) txt = txt.slice(m[1].length + 1);
      let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
      self._onWireMsg(pw, msg);
    };
    wire.use(Ext);
    wire.once('close', () => {
      if (pw.id && self.peers.get(pw.id) === pw) { self.peers.delete(pw.id); self.emit('peers', self.peers.size); }
    });
    // an unauthenticated wire is dropped after a while
    setTimeout(() => { if (!pw.authed && !wire.destroyed) { self.log('dropping unauthenticated wire'); try { wire.destroy(); } catch (e) {} } }, 15000);
  }
  _send(pw, obj) { if (!pw.ext || pw.wire.destroyed) return; try { pw.wire.extended(EXT, JSON.stringify(obj)); } catch (e) { } }
  _onWireMsg(pw, m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello': {
        if (typeof m.id !== 'string' || m.id === this.id) return this._kill(pw, 'self or bad hello');
        const pk = unb64u(m.id); if (pk.length !== 32) return this._kill(pw, 'bad id');
        if (pw.id && pw.id !== m.id) return this._kill(pw, 'id changed');
        pw.id = m.id; pw.pk = pk;
        const prev = this.peers.get(m.id);
        if (prev && prev !== pw) {                       // duplicate wire to the same peer: keep the newer
          if (prev.authed && nowMs() - prev.since < 30000) return this._kill(pw, 'duplicate');
          try { prev.wire.destroy(); } catch (e) {}
        }
        this.peers.set(m.id, pw);
        if (this.id < m.id) this._startRound(pw);        // lower id initiates
        return;
      }
      case 'hs': {                                       // round message
        if (!pw.id || typeof m.n !== 'string' || typeof m.r !== 'number') return;
        if (m.sig) {                                     // responder's reply to our round
          if (this.id > pw.id || m.r !== pw.pendingRound) return;
          pw.theirNonce = m.n;
          const tr = hsTranscript(this.room.infoHash, this.id, pw.id, pw.myNonce, pw.theirNonce, m.r);
          if (!hsVerify(tr, m.sig, m.tag, pw.pk, this.room.key)) return this._kill(pw, 'handshake verify failed');
          const p = hsProve(tr, this.identity, this.room.key);
          this._send(pw, { t: 'hs-ok', r: m.r, sig: p.sig, tag: p.tag });
          this._authed(pw, m.r);
        } else {                                         // initiator opened a round; we respond
          if (this.id < pw.id || m.r <= pw.round) return;
          pw.theirNonce = m.n; pw.myNonce = randId(12); pw.pendingRound = m.r;
          const tr = hsTranscript(this.room.infoHash, this.id, pw.id, pw.myNonce, pw.theirNonce, m.r);
          const p = hsProve(tr, this.identity, this.room.key);
          this._send(pw, { t: 'hs', r: m.r, n: pw.myNonce, sig: p.sig, tag: p.tag });
        }
        return;
      }
      case 'hs-ok': {
        if (!pw.id || this.id < pw.id || m.r !== pw.pendingRound) return;
        const tr = hsTranscript(this.room.infoHash, this.id, pw.id, pw.myNonce, pw.theirNonce, m.r);
        if (!hsVerify(tr, m.sig, m.tag, pw.pk, this.room.key)) return this._kill(pw, 'handshake verify failed');
        this._authed(pw, m.r);
        return;
      }
      case 'g':
        if (!pw.authed) return;
        return this._onGossip(pw, m.e);
    }
  }
  _startRound(pw) {
    pw.pendingRound = pw.round + 1; pw.myNonce = randId(12); pw.hsAt = nowMs();
    this._send(pw, { t: 'hs', r: pw.pendingRound, n: pw.myNonce });
  }
  _authed(pw, round) {
    const first = !pw.authed;
    pw.authed = true; pw.round = round; pw.authedAt = nowMs();
    if (first) {
      this.log('wire authenticated: ' + pw.id.slice(0, 8));
      this.emit('peers', this.peers.size);
      this.emit('peer', pw.id);
      this._sendPresenceTo(pw);
    }
  }
  _rehandshake() {
    const now = nowMs();
    for (const pw of this.peers.values()) {
      if (!pw.authed || this.id > pw.id) continue;             // initiator only
      if (now - pw.authedAt >= this.hsIntervalMs && pw.pendingRound === pw.round) this._startRound(pw);
      else if (pw.pendingRound !== pw.round && now - pw.hsAt > 20000) this._kill(pw, 'rehandshake timeout');
    }
  }
  _kill(pw, why) { this.log('closing wire (' + why + ')'); try { pw.wire.destroy(); } catch (e) {} }

  /* ---- gossip ---- */
  _onGossip(pw, e) {
    if (!e || typeof e.i !== 'string' || this.seen.has(e.i)) return;
    this.seen.set(e.i, nowMs());
    if (!verifyEnvelope(e)) { this.log('dropped gossip with bad signature'); return; }
    if (e.f === this.id) return;
    const ttl = Math.min(8, (e.l | 0) - 1);
    if (e.o && e.o !== this.id) { if (ttl > 0) this._forward(e, ttl, pw); return; }
    let body; try { body = JSON.parse(e.b); } catch (err) { return; }
    if (!e.o && ttl > 0) this._forward(e, ttl, pw);
    if (e.k === 'pres') this._onPresence(e.f, body, e.s);
    this.emit('gossip', { from: e.f, kind: e.k, body, ts: e.s, to: e.o });
  }
  _forward(e, ttl, except) {
    const fe = Object.assign({}, e, { l: ttl });
    if (e.o) { const direct = this.peers.get(e.o); if (direct && direct.authed) return this._send(direct, { t: 'g', e: fe }); }
    for (const pw of this.peers.values()) if (pw !== except && pw.authed) this._send(pw, { t: 'g', e: fe });
  }
  broadcast(kind, body) {
    const e = signEnvelope(this.identity, kind, body, '', 8);
    this.seen.set(e.i, nowMs());
    for (const pw of this.peers.values()) if (pw.authed) this._send(pw, { t: 'g', e });
  }
  send(to, kind, body) {
    const e = signEnvelope(this.identity, kind, body, to, 8);
    this.seen.set(e.i, nowMs());
    const direct = this.peers.get(to);
    if (direct && direct.authed) return this._send(direct, { t: 'g', e });
    for (const pw of this.peers.values()) if (pw.authed) this._send(pw, { t: 'g', e });
  }

  /* ---- presence / roster ---- */
  setPresence(patch) {
    Object.assign(this.presence, patch);
    clearTimeout(this._presT);
    this._presT = setTimeout(() => this.broadcastPresence(), 120);
  }
  broadcastPresence() {
    if (this.destroyed) return;
    this.presence.q = (this.presence.q | 0) + 1;
    this.broadcast('pres', this.presence);
  }
  _sendPresenceTo(pw) {
    this.presence.q = (this.presence.q | 0) + 1;
    const e = signEnvelope(this.identity, 'pres', this.presence, '', 8);
    this.seen.set(e.i, nowMs());
    this._send(pw, { t: 'g', e });
  }
  _onPresence(id, p, ts) {
    if (!p || typeof p !== 'object') return;
    const now = nowMs();
    let r = this.roster.get(id);
    const isNew = !r;
    if (r && (p.q | 0) <= (r.seq | 0)) { r.lastSeen = now; return; }
    if (!r) r = { id, lastSpokeAt: 0, firstSeen: now };
    const wasSpeaking = !!r.speaking;
    r.seq = p.q | 0; r.name = String(p.n || '').slice(0, 40) || 'Guest';
    r.streams = (p.s && typeof p.s === 'object') ? p.s : {};
    r.level = typeof p.lv === 'number' ? p.lv : 0;
    r.speaking = !!p.sp; r.mic = p.mic !== false; r.cam = p.cam !== false;
    r.budget = p.bg | 0; r.spare = p.cap | 0; r.lastSeen = now; r.raw = p;
    if (r.speaking && !wasSpeaking) r.speakStart = now;
    if (r.speaking || (wasSpeaking && !r.speaking)) r.lastSpokeAt = now;
    this.roster.set(id, r);
    this.emit('presence', r, isNew);
    this._rosterChanged();
  }
  _rosterChanged() { clearTimeout(this._rosT); this._rosT = setTimeout(() => this.emit('roster', this.roster), 60); }
  _prune() {
    const now = nowMs();
    for (const [k, t] of this.seen) if (now - t > 120000) this.seen.delete(k);
    if (this.seen.size > 50000) this.seen.clear();
    let changed = false;
    for (const [id, r] of this.roster) if (now - r.lastSeen > 9000) { this.roster.delete(id); changed = true; this.emit('left', id); }
    if (changed) this._rosterChanged();
  }
  get peerCount() { let n = 0; for (const pw of this.peers.values()) if (pw.authed) n++; return n; }

  leave() {
    if (this.destroyed) return; this.destroyed = true;
    for (const t of this._timers) clearInterval(t);
    clearTimeout(this._presT); clearTimeout(this._rosT);
    try { if (this._ownClient) this.client.destroy(); else this.client.remove(this.room.infoHash); } catch (e) {}
    this.peers.clear(); this.emit('peers', 0);
  }
}

/* ───────────────────────── Link: one media connection per peer pair ─────────────────────────
   A dedicated RTCPeerConnection (public API only, nothing reached into
   WebTorrent) with three data channels:
     ctl  reliable, ordered   — sub/unsub/redirect/keyframe/capacity
     vid  unordered, lossy    — video chunks (give up retransmitting after 400 ms)
     aud  unordered, lossy    — audio frames  (150 ms)
   Signaling travels as signed gossip through the room swarm.               */
const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
const GATHER_MS = 1200, LINK_OPEN_TIMEOUT = 20000, VID_LIFETIME = 400, AUD_LIFETIME = 150;

class Link extends Emitter {
  constructor(node, peer, initiator, lid) {
    super();
    this.node = node; this.peer = peer; this.initiator = initiator; this.lid = lid || randId(6);
    this.state = 'new'; this.created = nowMs(); this.openedAt = 0;
    this.inStreams = new Map();   // sid -> Stream   (what the peer sends us)
    this.outStreams = new Map();  // sid -> Stream   (what we send the peer)
    this.outState = new Map();    // Stream -> {waitKey}
    this.nextSid = 1; this.peerSpare = 0; this.rtt = null; this.pingAt = 0;
    this.pendingIce = []; this.remoteSet = false; this.sentDesc = false; this.waiters = [];
    this.pc = new RTCPeerConnection(node.rtcConfig);
    const pc = this.pc;
    pc.onicecandidate = e => { if (e.candidate && this.sentDesc) this._signal({ op: 'ice', cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close('pc-' + s);
      else if (s === 'disconnected') { clearTimeout(this._discT); this._discT = setTimeout(() => { if (pc.connectionState === 'disconnected') this.close('pc-disconnected'); }, 6000); }
      else if (s === 'connected') clearTimeout(this._discT);
    };
    if (initiator) {
      this.ctl = pc.createDataChannel('ctl', { ordered: true });
      this.vid = pc.createDataChannel('vid', { ordered: false, maxPacketLifeTime: VID_LIFETIME });
      this.aud = pc.createDataChannel('aud', { ordered: false, maxPacketLifeTime: AUD_LIFETIME });
      [this.ctl, this.vid, this.aud].forEach(c => this._setupChannel(c));
      this._offer().catch(e => this.close('offer-failed: ' + e.message));
    } else {
      pc.ondatachannel = e => { const c = e.channel; if (['ctl', 'vid', 'aud'].includes(c.label)) { this[c.label] = c; this._setupChannel(c); } };
    }
    this._openT = setTimeout(() => { if (this.state !== 'open') this.close('open-timeout'); }, LINK_OPEN_TIMEOUT);
    this.state = 'connecting';
  }
  _setupChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => this._checkOpen();
    ch.onclose = () => this.close('channel-closed');
    ch.onerror = () => {};
    if (ch.label === 'ctl') ch.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.node._onCtl(this, m); };
    else ch.onmessage = e => this.node._onMedia(this, e.data);
  }
  _checkOpen() {
    if (this.state === 'open' || this.state === 'closed') return;
    if (!(this.ctl && this.vid && this.aud)) return;
    if ([this.ctl, this.vid, this.aud].some(c => c.readyState !== 'open')) return;
    this.state = 'open'; this.openedAt = nowMs(); clearTimeout(this._openT);
    const w = this.waiters; this.waiters = []; for (const fn of w) { try { fn(); } catch (e) {} }
    this.emit('open');
  }
  whenOpen(fn) { if (this.state === 'open') fn(); else if (this.state !== 'closed') this.waiters.push(fn); }
  get isOpen() { return this.state === 'open'; }
  async _gather() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(res => {
      const t = setTimeout(done, GATHER_MS);
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', h); res(); }
      function h() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', h);
    });
  }
  async _offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._gather();
    if (this.state === 'closed') return;
    this.sentDesc = true;
    this._signal({ op: 'offer', sdp: this.pc.localDescription.sdp });
  }
  async handleSignal(b) {
    const pc = this.pc;
    try {
      if (b.op === 'offer' && !this.initiator) {
        if (this.remoteSet) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: b.sdp });
        this.remoteSet = true; this._flushIce();
        const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
        await this._gather();
        if (this.state === 'closed') return;
        this.sentDesc = true;
        this._signal({ op: 'answer', sdp: pc.localDescription.sdp });
      } else if (b.op === 'answer' && this.initiator) {
        if (this.remoteSet || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: b.sdp });
        this.remoteSet = true; this._flushIce();
      } else if (b.op === 'ice' && b.cand) {
        if (this.remoteSet) await pc.addIceCandidate(b.cand).catch(() => {}); else this.pendingIce.push(b.cand);
      }
    } catch (e) { this.close('signal-error: ' + e.message); }
  }
  _flushIce() { const l = this.pendingIce; this.pendingIce = []; for (const c of l) this.pc.addIceCandidate(c).catch(() => {}); }
  _signal(body) { this.node.room.send(this.peer, 'link', Object.assign({ lid: this.lid }, body)); }
  sendCtl(o) { if (this.ctl && this.ctl.readyState === 'open') { try { this.ctl.send(JSON.stringify(o)); } catch (e) {} } }
  allocSid() { let s; do { s = this.nextSid++ & 0xffff; } while (s === 0 || this.outStreams.has(s)); return s; }
  outKbps() { let k = 0; for (const s of this.outStreams.values()) k += s.br || 0; return k; }
  close(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.reason = reason;
    clearTimeout(this._openT); clearTimeout(this._discT);
    try { this.pc.close(); } catch (e) {}
    this.waiters = [];
    this.emit('close', reason);
    this.node._onLinkClosed(this);
  }
}

/* ───────────────────────── Node: publish / subscribe / relay ───────────────────────── */
const TRACKS = { vh: T_VIDEO, vl: T_VIDEO, a: T_AUDIO };
const SUB_TIMEOUT = 9000, MAX_REDIRECTS = 12, IDLE_LINK_MS = 30000, STALL_MS = 5000;

class Node extends Emitter {
  constructor(opts) {
    super();
    this.room = opts.room; this.id = this.room.id;
    this.budget = typeof opts.budgetKbps === 'number' ? opts.budgetKbps : 3000;
    this.rtcConfig = opts.rtcConfig || { iceServers: DEFAULT_ICE };
    this.log = opts.log || (() => {});
    this.links = new Map();     // peer id -> Link
    this.streams = new Map();   // sk -> Stream
    this.destroyed = false;
    this._onGossip = g => {
      if (g.kind === 'link') this._onLinkSignal(g.from, g.body);
      else if (g.kind === 'sub-help') this._onSubHelp(g.from, g.body);
      else if (g.kind === 'sub-help-ok') this._onSubHelpOk(g.from, g.body);
    };
    this.room.on('gossip', this._onGossip);
    this._hk = setInterval(() => this._housekeeping(), 1000);
  }
  static sk(pub, track) { return pub + '/' + track; }

  /* ---- publishing ---- */
  publish(track, { codec, cfg, br }) {
    if (!TRACKS[track]) throw new Error('unknown track ' + track);
    const sk = Node.sk(this.id, track);
    let s = this.streams.get(sk);
    if (s) { s.codec = codec; s.cfg = cfg || {}; s.br = br || 0; return s.handle; }
    s = this._newStream(sk, this.id, track, true);
    s.codec = codec; s.cfg = cfg || {}; s.br = br || 0; s.depth = 0;
    const node = this;
    s.handle = {
      get stream() { return s; },
      push(frame) { node._push(s, frame); },
      setConfig(c) { Object.assign(s.cfg, c); },
      get wantKey() { const w = s.wantKey; s.wantKey = false; return w; },
      get children() { return s.children.size; },
      get congestion() { return s.congestion; },
      end() { node.unpublish(track); }
    };
    this.emit('streams');
    return s.handle;
  }
  unpublish(track) {
    const s = this.streams.get(Node.sk(this.id, track));
    if (!s) return;
    for (const [link, sid] of s.children) { link.sendCtl({ op: 'end', sk: s.sk }); link.outStreams.delete(sid); link.outState.delete(s); }
    s.children.clear();
    this.streams.delete(s.sk);
    this.emit('streams');
  }
  _newStream(sk, pub, track, local) {
    const s = { sk, pub, track, local, type: TRACKS[track], codec: null, cfg: {}, br: 0, seq: 0, depth: local ? 0 : -1,
      parent: null, parentSid: 0, pendingLink: null, children: new Map(), cache: track === 'a' ? null : new GroupCache(),
      reasm: new Reassembler(), sinks: new Set(), candidates: [], tried: new Set(), unreachable: new Map(), helpAt: 0, redirects: 0, attempts: 0, timer: null,
      lastIn: 0, lastOut: 0, bytesIn: 0, framesIn: 0, chunksIn: 0, chunksOut: 0, congDrops: 0, wantKey: false, lastKfReq: 0, congestion: 0, relayOnly: false, relayOnlySince: 0 };
    this.streams.set(sk, s);
    return s;
  }
  _push(s, frame) {
    const seq = s.seq++;
    const now = nowMs();
    s.lastIn = now; s.framesIn++;
    const chunks = chunkFrame(s.type, 0, seq, frame.key ? F_KEY : 0, Math.round(frame.ts), frame.data);
    for (const buf of chunks) this._relay(s, buf, readHeader(buf), null);
    if (s.sinks.size) { const f = { seq, key: !!frame.key, ts: frame.ts, type: s.type, data: frame.data }; for (const k of s.sinks) k.onFrame(f, s); }
  }

  /* ---- forwarding (also the publisher's own fan-out) ---- */
  _relay(s, buf, h, fromLink) {
    if (s.cache) s.cache.add(h, buf);
    if (!s.children.size) return;
    const now = nowMs();
    let congested = 0;
    for (const [link, sid] of s.children) {
      if (!link.isOpen) continue;
      const ch = h.type === T_AUDIO ? link.aud : link.vid;
      let st = link.outState.get(s); if (!st) { st = { waitKey: false, lastSent: 0, graceUntil: now + 1500 }; link.outState.set(s, st); }
      if (h.type === T_VIDEO) {
        // Congestion = the child's send queue holds much more than a keyframe burst: roughly 0.8 s of this
        // link's video, never less than 96 KB, and not during the grace period after the group-cache burst.
        const high = Math.max(96000, link.outKbps() * 125 * 0.8);
        if (now > st.graceUntil && ch.bufferedAmount > high && !h.key) { st.waitKey = true; congested++; s.congDrops++; continue; }
        if (st.waitKey) { if (h.key) st.waitKey = false; else { congested++; s.congDrops++; continue; } }
      } else if (ch.bufferedAmount > 32000) { s.congDrops++; continue; }   // audio is only dropped when hopelessly behind
      try { ch.send(withSid(buf, sid)); st.lastSent = now; s.chunksOut++; } catch (e) { s.sendErrors = (s.sendErrors | 0) + 1; }
    }
    s.lastOut = now;
    s.congestion = s.children.size ? congested / s.children.size : 0;
  }
  _onMedia(link, buf) {
    const h = readHeader(buf); if (!h) return;
    const s = link.inStreams.get(h.sid); if (!s) return;
    const now = nowMs();
    s.lastIn = now; s.bytesIn += buf.byteLength; s.chunksIn++;
    this._relay(s, buf, h, link);
    const f = s.reasm.add(h, buf, now);
    if (f) { s.framesIn++; if (s.sinks.size) for (const k of s.sinks) k.onFrame(f, s); }
  }

  /* ---- subscribing ---- */
  subscribe(pub, track, sink) {
    const sk = Node.sk(pub, track);
    let s = this.streams.get(sk);
    if (pub === this.id) { if (!s) return null; s.sinks.add(sink); if (sink.onConfig) sink.onConfig({ codec: s.codec, cfg: s.cfg, track, br: s.br }, s); return s; }
    if (!s) { s = this._newStream(sk, pub, track, false); s.candidates = [pub]; }
    s.sinks.add(sink); s.relayOnly = false;
    if (s.parent) { if (sink.onConfig) sink.onConfig({ codec: s.codec, cfg: s.cfg, track, br: s.br }, s); }
    else if (!s.pendingLink && !s.timer) this._trySubscribe(s);
    this.emit('streams');
    return s;
  }
  unsubscribe(pub, track, sink) {
    const s = this.streams.get(Node.sk(pub, track)); if (!s) return;
    if (sink) s.sinks.delete(sink); else s.sinks.clear();
    if (s.sinks.size || s.local) return;
    if (s.children.size) { s.relayOnly = true; s.relayOnlySince = nowMs(); return; }   // keep seeding for our children
    this._detach(s, true);
  }
  _detach(s, tellParent) {
    clearTimeout(s.timer); s.timer = null;
    if (s.parent) { if (tellParent) s.parent.sendCtl({ op: 'unsub', sk: s.sk }); s.parent.inStreams.delete(s.parentSid); s.parent = null; }
    s.pendingLink = null;
    this.streams.delete(s.sk);
    this.emit('streams');
  }
  _trySubscribe(s) {
    if (this.destroyed || s.local) return;
    clearTimeout(s.timer); s.timer = null;
    if (!s.sinks.size && !s.children.size) { this._detach(s, false); return; }
    if (!s.candidates.length || s.redirects > MAX_REDIRECTS) {
      s.candidates = [s.pub]; s.tried.clear(); s.redirects = 0;
      if (this._unreachable(s, s.pub)) this._askHelp(s);         // cannot reach the publisher directly: ask it for relays
      if (s.attempts++ > 0) {                                     // back off before asking the publisher again
        const wait = Math.min(8000, 800 * Math.pow(2, Math.min(4, s.attempts - 1)));
        s.timer = setTimeout(() => { s.timer = null; this._trySubscribe(s); }, wait);
        this.emit('streams');
        return;
      }
    }
    const cand = s.candidates.shift();
    if (cand === this.id || s.tried.has(cand) || this._unreachable(s, cand)) return this._trySubscribe(s);
    s.tried.add(cand);
    const link = this._ensureLink(cand);
    s.pendingLink = link;
    link.whenOpen(() => { if (s.pendingLink === link && !s.parent) link.sendCtl({ op: 'sub', sk: s.sk }); });
    s.timer = setTimeout(() => { if (s.pendingLink === link && !s.parent) { s.pendingLink = null; s.timer = null; this._trySubscribe(s); } }, SUB_TIMEOUT);
    this.emit('streams');
  }
  _unreachable(s, peer) {
    const t = s.unreachable.get(peer); if (!t) return false;
    if (nowMs() - t > 60000) { s.unreachable.delete(peer); return false; }
    return true;
  }
  /* The publisher cannot be linked directly (NAT, firewall): ask it over the swarm
     which peers already receive the stream, so one of them can be our parent. */
  _askHelp(s) {
    const now = nowMs(); if (now - s.helpAt < 4000) return;
    s.helpAt = now; this.room.send(s.pub, 'sub-help', { sk: s.sk });
  }
  _onSubHelp(from, b) {
    if (!b || typeof b.sk !== 'string') return;
    const s = this.streams.get(b.sk); if (!s || (!s.local && !s.parent)) return;
    const to = Array.from(s.children.keys()).filter(l => l.isOpen && l.peer !== from).sort((a, c) => c.peerSpare - a.peerSpare).map(l => l.peer).slice(0, 8);
    this.room.send(from, 'sub-help-ok', { sk: b.sk, to });
  }
  _onSubHelpOk(from, b) {
    if (!b || typeof b.sk !== 'string') return;
    const s = this.streams.get(b.sk); if (!s || s.parent || from !== s.pub) return;
    const to = Array.isArray(b.to) ? b.to.filter(p => typeof p === 'string' && p !== this.id && !this._unreachable(s, p)) : [];
    if (!to.length) return;
    clearTimeout(s.timer); s.timer = null; s.pendingLink = null;
    s.candidates = to.concat(s.candidates); s.tried.clear(); s.redirects = 0;
    this._trySubscribe(s);
  }
  _ensureLink(peer) {
    let l = this.links.get(peer);
    if (l && l.state !== 'closed') return l;
    l = new Link(this, peer, true);
    this.links.set(peer, l);
    this.emit('links');
    return l;
  }

  /* ---- control messages on links ---- */
  _onCtl(link, m) {
    if (!m || typeof m !== 'object') return;
    switch (m.op) {
      case 'sub': return this._onSub(link, m.sk);
      case 'sub-ok': return this._onSubOk(link, m);
      case 'sub-redirect': return this._onRedirect(link, m);
      case 'sub-reject': return this._onReject(link, m);
      case 'unsub': { const s = this.streams.get(m.sk); if (s) this._removeChild(s, link); return; }
      case 'end': { const s = this.streams.get(m.sk); if (s && s.parent === link) this._parentLost(s); return; }
      case 'alive': { const s = this.streams.get(m.sk); if (s && s.parent === link) s.lastIn = nowMs(); return; }
      case 'kf': return this._onKeyRequest(link, m.sk);
      case 'cap': link.peerSpare = m.spare | 0; return;
      case 'ping': return link.sendCtl({ op: 'pong', t: m.t });
      case 'pong': if (typeof m.t === 'number') link.rtt = nowMs() - m.t; return;
    }
  }
  usedKbps() { let k = 0; for (const s of this.streams.values()) k += s.br * s.children.size; return k; }
  spareKbps() { return this.budget - this.usedKbps(); }
  _onSub(link, sk) {
    const s = this.streams.get(sk);
    if (!s || (!s.local && !s.parent)) return link.sendCtl({ op: 'sub-reject', sk, why: 'nostream' });
    if (s.children.has(link)) return this._accept(s, link, s.children.get(link));
    const spare = this.spareKbps();
    if (spare >= s.br || s.children.size === 0) return this._accept(s, link, null);
    const to = Array.from(s.children.keys()).filter(l => l.isOpen && l.peer !== link.peer)
      .sort((a, b) => b.peerSpare - a.peerSpare).map(l => l.peer);
    if (to.length) { link.sendCtl({ op: 'sub-redirect', sk, to: to.slice(0, 6) }); this.log('redirect ' + sk.slice(0, 10) + ' → ' + to[0].slice(0, 8)); }
    else this._accept(s, link, null);
  }
  _accept(s, link, existingSid) {
    const sid = existingSid || link.allocSid();
    if (!existingSid) { s.children.set(link, sid); link.outStreams.set(sid, s); link.outState.set(s, { waitKey: false, lastSent: nowMs(), graceUntil: nowMs() + 1500 }); }
    link.sendCtl({ op: 'sub-ok', sk: s.sk, sid, codec: s.codec, cfg: s.cfg, br: s.br, depth: s.depth, track: s.track });
    if (s.cache && !existingSid) {                                   // bring the child up to the current keyframe
      for (const c of s.cache.burst()) { try { link.vid.send(withSid(c, sid)); } catch (e) {} }
    }
    this.emit('streams');
  }
  _removeChild(s, link) {
    const sid = s.children.get(link);
    if (sid === undefined) return;
    s.children.delete(link); link.outStreams.delete(sid); link.outState.delete(s);
    if (!s.local && !s.sinks.size && !s.children.size) this._detach(s, true);
    this.emit('streams');
  }
  _onSubOk(link, m) {
    const s = this.streams.get(m.sk);
    if (!s || s.local || s.parent || s.pendingLink !== link) { link.sendCtl({ op: 'unsub', sk: m.sk }); return; }
    clearTimeout(s.timer); s.timer = null; s.pendingLink = null;
    s.parent = link; s.parentSid = m.sid; s.codec = m.codec; s.cfg = m.cfg || {}; s.br = m.br | 0; s.depth = (m.depth | 0) + 1;
    s.attempts = 0; s.redirects = 0; s.tried.clear(); s.candidates = []; s.lastIn = nowMs(); s.reasm = new Reassembler();
    link.inStreams.set(m.sid, s);
    for (const k of s.sinks) if (k.onConfig) k.onConfig({ codec: s.codec, cfg: s.cfg, track: s.track, br: s.br }, s);
    this.log('subscribed ' + s.sk.slice(0, 10) + ' depth ' + s.depth + ' via ' + link.peer.slice(0, 8));
    this.emit('streams');
  }
  _onRedirect(link, m) {
    const s = this.streams.get(m.sk);
    if (!s || s.parent || s.pendingLink !== link) return;
    clearTimeout(s.timer); s.timer = null; s.pendingLink = null; s.redirects++;
    const to = Array.isArray(m.to) ? m.to.filter(p => typeof p === 'string' && p !== this.id && !s.tried.has(p)) : [];
    s.candidates = to.concat(s.candidates);
    this._trySubscribe(s);
  }
  _onReject(link, m) {
    const s = this.streams.get(m.sk);
    if (!s || s.parent || s.pendingLink !== link) return;
    clearTimeout(s.timer); s.timer = null; s.pendingLink = null;
    if (link.peer === s.pub) { s.candidates = []; s.redirects = MAX_REDIRECTS + 1; }   // publisher has nothing (yet): back off
    this._trySubscribe(s);
  }
  _onKeyRequest(link, sk) {
    const s = this.streams.get(sk); if (!s) return;
    const now = nowMs();
    if (s.local) { s.wantKey = true; return; }
    if (s.parent && now - s.lastKfReq > 700) { s.lastKfReq = now; s.parent.sendCtl({ op: 'kf', sk }); }
  }
  requestKeyframe(pub, track) {
    const s = this.streams.get(Node.sk(pub, track)); if (!s || !s.parent) return;
    const now = nowMs(); if (now - s.lastKfReq < 700) return;
    s.lastKfReq = now; s.parent.sendCtl({ op: 'kf', sk: s.sk });
  }
  _parentLost(s) {
    if (s.parent) { s.parent.inStreams.delete(s.parentSid); s.parent = null; }
    s.pendingLink = null; s.depth = -1;
    if (s.sinks.size || s.children.size) { s.candidates = [s.pub]; s.tried.clear(); s.redirects = 0; this._trySubscribe(s); }
    else this._detach(s, false);
  }

  /* ---- link lifecycle ---- */
  _onLinkSignal(from, b) {
    if (!b || typeof b !== 'object') return;
    let link = this.links.get(from);
    if (b.op === 'offer') {
      if (link && link.state !== 'closed') {
        if (link.lid === b.lid) return;                          // duplicate
        if (link.initiator && !link.remoteSet) {                 // glare: both offered at once, lower id wins
          if (this.id < from) return;
        }
        link.close('replaced');
      }
      link = new Link(this, from, false, b.lid);
      this.links.set(from, link);
      this.emit('links');
      link.handleSignal(b);
    } else if (link && link.lid === b.lid) link.handleSignal(b);
  }
  _onLinkClosed(link) {
    if (this.links.get(link.peer) === link) this.links.delete(link.peer);
    for (const s of Array.from(this.streams.values())) {
      if (s.parent === link) this._parentLost(s);
      else if (s.pendingLink === link) {
        s.pendingLink = null; clearTimeout(s.timer); s.timer = null;
        const benign = link.openedAt || link.reason === 'replaced' || link.reason === 'glare' || link.reason === 'destroy';
        if (benign) { s.tried.delete(link.peer); s.candidates.unshift(link.peer); }         // retry the same peer over the fresh link
        else { s.unreachable.set(link.peer, nowMs()); if (link.peer === s.pub) this._askHelp(s); } // never opened: route around it
        setTimeout(() => { if (!s.parent && !s.pendingLink) this._trySubscribe(s); }, 300);
      }
      if (s.children.has(link)) this._removeChild(s, link);
    }
    this.emit('links');
  }
  _housekeeping() {
    if (this.destroyed) return;
    const now = nowMs();
    for (const s of Array.from(this.streams.values())) {
      // keep each child informed when it has not been sent anything for a while (muted mic, paused camera, congestion)
      if (s.children.size && (s.local || s.parent)) for (const link of s.children.keys()) {
        const st = link.outState.get(s);
        if (st && now - st.lastSent > 2000) { st.lastSent = now; link.sendCtl({ op: 'alive', sk: s.sk }); }
      }
      // a parent that went quiet for too long is treated as lost
      if (s.parent && now - s.lastIn > STALL_MS) { this.log('stall on ' + s.sk.slice(0, 10) + ', re-subscribing'); s.parent.sendCtl({ op: 'unsub', sk: s.sk }); this._parentLost(s); }
      // relay-only streams are dropped once nobody depends on them
      if (s.relayOnly && !s.children.size && !s.sinks.size && !s.local) this._detach(s, true);
    }
    for (const link of Array.from(this.links.values())) {
      if (link.state !== 'open') continue;
      const busy = link.inStreams.size || link.outStreams.size || Array.from(this.streams.values()).some(s => s.pendingLink === link);
      if (!busy && now - link.openedAt > IDLE_LINK_MS && now - (link.lastBusy || link.openedAt) > IDLE_LINK_MS) link.close('idle');
      else if (busy) link.lastBusy = now;
      if (now - link.pingAt > 5000) { link.pingAt = now; link.sendCtl({ op: 'ping', t: now }); }
    }
    if ((this._capTick = (this._capTick | 0) + 1) % 3 === 0) {
      const spare = this.spareKbps();
      for (const link of this.links.values()) if (link.isOpen) link.sendCtl({ op: 'cap', spare });
      Object.assign(this.room.presence, { bg: this.budget, cap: spare });   // carried by the next periodic presence
    }
  }
  setBudget(kbps) {
    this.budget = Math.max(0, kbps | 0);
    // shed children we can no longer afford: relayed streams first, biggest first
    let used = this.usedKbps();
    if (used <= this.budget) return;
    const victims = [];
    for (const s of this.streams.values()) for (const link of s.children.keys()) victims.push({ s, link });
    victims.sort((a, b) => (a.s.local - b.s.local) || (b.s.br - a.s.br));
    for (const v of victims) { if (used <= this.budget) break; v.link.sendCtl({ op: 'end', sk: v.s.sk }); this._removeChild(v.s, v.link); used -= v.s.br; }
  }
  stats() {
    const streams = [];
    for (const s of this.streams.values()) streams.push({ sk: s.sk, pub: s.pub, track: s.track, local: s.local, depth: s.depth, parent: s.parent ? s.parent.peer : null,
      pending: !!s.pendingLink, children: s.children.size, br: s.br, framesIn: s.framesIn, bytesIn: s.bytesIn, chunksIn: s.chunksIn, chunksOut: s.chunksOut, congDrops: s.congDrops, sendErrors: s.sendErrors | 0,
      sinks: s.sinks.size, relayOnly: s.relayOnly, congestion: s.congestion, dropped: s.reasm.dropped });
    const links = [];
    for (const l of this.links.values()) links.push({ peer: l.peer, state: l.state, initiator: l.initiator, in: l.inStreams.size, out: l.outStreams.size, rtt: l.rtt, peerSpare: l.peerSpare,
      vidBuffered: l.vid ? l.vid.bufferedAmount : 0, audBuffered: l.aud ? l.aud.bufferedAmount : 0, reason: l.reason || null });
    return { id: this.id, budget: this.budget, used: this.usedKbps(), streams, links };
  }
  destroy() {
    if (this.destroyed) return; this.destroyed = true;
    clearInterval(this._hk);
    this.room.off('gossip', this._onGossip);
    for (const s of this.streams.values()) { clearTimeout(s.timer); for (const link of s.children.keys()) link.sendCtl({ op: 'end', sk: s.sk }); }
    for (const l of Array.from(this.links.values())) l.close('destroy');
    this.streams.clear(); this.links.clear();
  }
}

/* ───────────────────────── browser media: publishers ───────────────────────── */
const hasWebCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

async function pickVideoCodec(r) {
  const probe = async (codec, extra) => {
    try { const res = await VideoEncoder.isConfigSupported(Object.assign({ codec, width: r.w, height: r.h, bitrate: r.kbps * 1000, framerate: r.fps, latencyMode: 'realtime' }, extra)); return !!res.supported; }
    catch (e) { return false; }
  };
  if (await probe('avc1.42E01F', { hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' } })) return 'avc1.42E01F';
  if (await probe('vp8', {})) return 'vp8';
  if (await probe('avc1.42E01F', { avc: { format: 'annexb' } })) return 'avc1.42E01F';
  throw new Error('no supported video encoder');
}
function encoderConfig(codec, r, bitrate) {
  const c = { codec, width: r.w, height: r.h, bitrate: bitrate || r.kbps * 1000, framerate: r.fps, latencyMode: 'realtime' };
  if (codec.startsWith('avc1')) { c.avc = { format: 'annexb' }; c.hardwareAcceleration = 'prefer-hardware'; }
  return c;
}

const DEFAULT_RENDITIONS = { vh: { w: 1280, h: 720, fps: 30, kbps: 1200 }, vl: { w: 320, h: 180, fps: 15, kbps: 120 } };

class VideoPublisher extends Emitter {
  constructor({ node, track, renditions, codec, gopMs, log }) {
    super();
    this.node = node; this.track = track; this.codecPref = codec; this.gopMs = gopMs || 2000; this.log = log || (() => {});
    this.rend = Object.assign({}, DEFAULT_RENDITIONS, renditions || {});
    const st = track.getSettings ? track.getSettings() : {};
    if (st.width && st.height) { this.rend.vh = Object.assign({}, this.rend.vh, { w: st.width, h: st.height }); }
    if (st.frameRate) this.rend.vh.fps = Math.min(this.rend.vh.fps, Math.round(st.frameRate)) || this.rend.vh.fps;
    this.enc = {}; this.streams = {}; this.lastKey = {}; this.tsMap = {}; this.frames = 0; this.running = false;
    this.targetKbps = { vh: this.rend.vh.kbps, vl: this.rend.vl.kbps }; this.curKbps = Object.assign({}, this.targetKbps);
    this.stats = { frames: 0, encoded: { vh: 0, vl: 0 }, bytes: { vh: 0, vl: 0 }, dropped: 0, codec: null };
  }
  async start() {
    if (!hasWebCodecs) throw new Error('WebCodecs not available in this browser');
    this.codec = this.codecPref || await pickVideoCodec(this.rend.vh);
    this.stats.codec = this.codec;
    for (const r of ['vh', 'vl']) {
      const rd = this.rend[r];
      this.streams[r] = this.node.publish(r, { codec: this.codec, cfg: { w: rd.w, h: rd.h, fps: rd.fps, fmt: this.codec.startsWith('avc1') ? 'annexb' : undefined }, br: rd.kbps });
      this.tsMap[r] = new Map(); this.lastKey[r] = 0;
      this._makeEncoder(r);
    }
    this.lowCanvas = document.createElement('canvas'); this.lowCanvas.width = this.rend.vl.w; this.lowCanvas.height = this.rend.vl.h;
    this.lowCtx = this.lowCanvas.getContext('2d', { alpha: false, desynchronized: true });
    this.running = true;
    this._pump();
    this._adaptT = setInterval(() => this._adapt(), 1000);
  }
  _makeEncoder(r) {
    const e = new VideoEncoder({ output: (chunk, meta) => this._out(r, chunk), error: err => { this.log('encoder ' + r + ' error: ' + err.message); this._restartEncoder(r); } });
    e.configure(encoderConfig(this.codec, this.rend[r], this.curKbps[r] * 1000));
    this.enc[r] = e;
  }
  _restartEncoder(r) {
    try { this.enc[r].close(); } catch (e) {}
    try { this._makeEncoder(r); this.lastKey[r] = 0; } catch (e) { this.log('cannot restart encoder: ' + e.message); }
  }
  _pump() {
    const track = this.track;
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      this.reader = reader;
      (async () => {
        while (this.running) {
          let r; try { r = await reader.read(); } catch (e) { break; }
          if (r.done) break;
          this._frame(r.value);
        }
      })();
    } else {                                                    // Firefox / Safari path
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([track]); v.play().catch(() => {});
      this.video = v;
      const step = () => {
        if (!this.running) return;
        try { const f = new VideoFrame(v, { timestamp: Math.round(performance.now() * 1000) }); this._frame(f); } catch (e) {}
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else setTimeout(step, 1000 / this.rend.vh.fps);
      };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else setTimeout(step, 100);
    }
  }
  _frame(frame) {
    if (!this.running) { frame.close(); return; }
    const ts = nowUs();
    this.frames++; this.stats.frames++;
    try {
      // full rendition
      if (frame.codedWidth !== this.rend.vh.w || frame.codedHeight !== this.rend.vh.h) {   // camera changed size: reconfigure
        this.rend.vh.w = frame.codedWidth; this.rend.vh.h = frame.codedHeight;
        this.streams.vh.setConfig({ w: frame.codedWidth, h: frame.codedHeight });
        this.enc.vh.configure(encoderConfig(this.codec, this.rend.vh, this.curKbps.vh * 1000)); this.lastKey.vh = 0;
      }
      if (this.enc.vh.encodeQueueSize > 2) this.stats.dropped++;
      else { this.tsMap.vh.set(frame.timestamp, ts); this.enc.vh.encode(frame, { keyFrame: this._keyDue('vh') }); }
      // low rendition: every Nth frame, downscaled through a canvas
      const div = Math.max(1, Math.round(this.rend.vh.fps / this.rend.vl.fps));
      if (this.frames % div === 0 && this.enc.vl.encodeQueueSize <= 2) {
        this.lowCtx.drawImage(frame, 0, 0, this.rend.vl.w, this.rend.vl.h);
        const lf = new VideoFrame(this.lowCanvas, { timestamp: frame.timestamp });
        this.tsMap.vl.set(lf.timestamp, ts);
        this.enc.vl.encode(lf, { keyFrame: this._keyDue('vl') });
        lf.close();
      }
    } catch (e) { this.log('encode error: ' + e.message); }
    frame.close();
  }
  _keyDue(r) {
    const now = nowMs();
    const s = this.streams[r];
    if (now - this.lastKey[r] >= this.gopMs || (s && s.wantKey)) { this.lastKey[r] = now; return true; }
    return false;
  }
  _out(r, chunk) {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    const ts = this.tsMap[r].get(chunk.timestamp); this.tsMap[r].delete(chunk.timestamp);
    if (this.tsMap[r].size > 60) this.tsMap[r].clear();
    this.stats.encoded[r]++; this.stats.bytes[r] += data.length;
    const s = this.streams[r]; if (s) s.push({ key: chunk.type === 'key', ts: ts !== undefined ? ts : nowUs(), data });
  }
  /* simple publisher-side adaptation: if our first-hop children are backed up, lower the bitrate; recover slowly */
  _adapt() {
    const s = this.streams.vh; if (!s) return;
    const c = s.congestion;
    if (c > 0.3) { this._congested = (this._congested | 0) + 1; this._clear = 0; } else { this._clear = (this._clear | 0) + 1; this._congested = 0; }
    let k = this.curKbps.vh;
    if (this._congested >= 2 && k > 300) { k = Math.max(300, Math.round(k * 0.7)); this._congested = 0; }
    else if (this._clear >= 15 && k < this.targetKbps.vh) { k = Math.min(this.targetKbps.vh, Math.round(k * 1.25)); this._clear = 0; }
    if (k !== this.curKbps.vh) { this.curKbps.vh = k; try { this.enc.vh.configure(encoderConfig(this.codec, this.rend.vh, k * 1000)); this.lastKey.vh = 0; } catch (e) {} this.emit('bitrate', k); }
  }
  stop() {
    this.running = false; clearInterval(this._adaptT);
    try { if (this.reader) this.reader.cancel(); } catch (e) {}
    if (this.video) { try { this.video.srcObject = null; } catch (e) {} }
    for (const r of ['vh', 'vl']) { try { this.enc[r] && this.enc[r].close(); } catch (e) {} this.node.unpublish(r); }
  }
}

/* audio capture runs in an AudioWorklet: 20 ms blocks of mono PCM plus a level reading */
const CAPTURE_WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.buf=new Float32Array(960);this.n=0;this.acc=0;this.cnt=0;}
process(inputs){const ch=inputs[0]&&inputs[0][0];if(!ch)return true;for(let i=0;i<ch.length;i++){const v=ch[i];this.buf[this.n++]=v;this.acc+=v*v;this.cnt++;
if(this.n===960){const out=this.buf;this.port.postMessage({pcm:out},[out.buffer]);this.buf=new Float32Array(960);this.n=0;}}
if(this.cnt>=2400){this.port.postMessage({level:Math.sqrt(this.acc/this.cnt)});this.acc=0;this.cnt=0;}return true;}}
registerProcessor('bep46-capture',C);`;
/* playback: ring buffer with a target delay; underruns play silence, excess latency is skipped */
const PLAYBACK_WORKLET = `class P extends AudioWorkletProcessor{constructor(o){super();this.cap=48000*3;this.rb=new Float32Array(this.cap);this.w=0;this.r=0;this.q=0;
this.target=(o.processorOptions&&o.processorOptions.target)||4800;this.playing=false;this.under=0;this.tick=0;
this.port.onmessage=e=>{const d=e.data;if(d.pcm)this.write(d.pcm);else if(d.target)this.target=d.target;else if(d.flush){this.w=this.r=this.q=0;this.playing=false;}};}
write(p){if(this.q+p.length>this.cap){const drop=this.q+p.length-this.cap;this.r=(this.r+drop)%this.cap;this.q-=drop;}
for(let i=0;i<p.length;i++){this.rb[this.w]=p[i];this.w=(this.w+1)%this.cap;}this.q+=p.length;
if(this.q>this.target*3){const drop=this.q-this.target;this.r=(this.r+drop)%this.cap;this.q-=drop;}}
process(_,outputs){const out=outputs[0][0];if(!out)return true;if(!this.playing&&this.q>=this.target)this.playing=true;
if(this.playing&&this.q>=out.length){for(let i=0;i<out.length;i++){out[i]=this.rb[this.r];this.r=(this.r+1)%this.cap;}this.q-=out.length;}
else{out.fill(0);if(this.playing){this.playing=false;this.under++;}}
if(++this.tick%16===0)this.port.postMessage({q:this.q,under:this.under});return true;}}
registerProcessor('bep46-play',P);`;
const workletReady = new WeakMap();
function ensureWorklets(ctx) {
  let p = workletReady.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET + '\n' + PLAYBACK_WORKLET], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url);
    workletReady.set(ctx, p);
  }
  return p;
}

class AudioPublisher extends Emitter {
  constructor({ node, track, ctx, kbps, log }) {
    super();
    this.node = node; this.track = track; this.ctx = ctx; this.kbps = kbps || 32; this.log = log || (() => {});
    this.muted = false; this.level = 0; this.speaking = false; this.base = 0; this.lastSpeech = 0; this.n = 0;
    this.stats = { frames: 0, bytes: 0 };
  }
  async start() {
    if (typeof AudioEncoder === 'undefined') throw new Error('AudioEncoder not available');
    await ensureWorklets(this.ctx);
    this.stream = this.node.publish('a', { codec: 'opus', cfg: { sr: 48000, ch: 1 }, br: this.kbps });
    this.encoder = new AudioEncoder({ output: c => this._out(c), error: e => this.log('audio encoder error: ' + e.message) });
    this.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: this.kbps * 1000 });
    this.src = this.ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.worklet = new AudioWorkletNode(this.ctx, 'bep46-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0;          // a worklet only runs when it reaches the destination
    this.src.connect(this.worklet); this.worklet.connect(this.sink); this.sink.connect(this.ctx.destination);
    this.worklet.port.onmessage = e => { const d = e.data; if (d.pcm) this._pcm(d.pcm); else if (typeof d.level === 'number') this._level(d.level); };
  }
  _level(l) {
    this.level = l;
    const now = nowMs();
    if (l > 0.015) this.lastSpeech = now;
    const sp = now - this.lastSpeech < 700 && !this.muted;
    this.emit('level', l);
    if (sp !== this.speaking) { this.speaking = sp; this.emit('speaking', sp); }
  }
  _pcm(f32) {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    const now = nowUs();
    if (!this.base || Math.abs(now - this.base) > 40000) this.base = now - 20000;   // first block, or clock drifted: re-anchor
    this.base += 20000;
    if (this.muted) return;
    try {
      const ad = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: this.base, data: f32 });
      this.encoder.encode(ad); ad.close();
    } catch (e) { this.log('audio encode: ' + e.message); }
  }
  _out(chunk) {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    this.stats.frames++; this.stats.bytes += data.length;
    if (this.stream) this.stream.push({ key: true, ts: chunk.timestamp, data });
  }
  setMuted(m) { this.muted = !!m; if (m && this.speaking) { this.speaking = false; this.emit('speaking', false); } }
  stop() {
    try { this.src && this.src.disconnect(); this.worklet && this.worklet.disconnect(); this.sink && this.sink.disconnect(); } catch (e) {}
    try { this.encoder && this.encoder.close(); } catch (e) {}
    this.node.unpublish('a');
  }
}

/* ───────────────────────── browser media: sinks ───────────────────────── */
class VideoSink {
  constructor({ canvas, ctx, sync, onKeyRequest, log }) {
    this.canvas = canvas; this.c2d = canvas.getContext('2d', { alpha: false }); this.actx = ctx; this.sync = sync || null;
    this.onKeyRequest = onKeyRequest || (() => {}); this.log = log || (() => {});
    this.decoder = null; this.needKey = true; this.lastSeq = -1; this.pending = null; this.timer = null;
    this.stats = { decoded: 0, drawn: 0, loss: 0, errors: 0, fps: 0, latencyMs: null, w: 0, h: 0, lastTs: 0 };
    this._fpsN = 0; this._fpsT = nowMs();
    this._fpsTimer = setInterval(() => { const now = nowMs(); this.stats.fps = this._fpsN * 1000 / Math.max(1, now - this._fpsT); this._fpsN = 0; this._fpsT = now; }, 2000);
  }
  onConfig({ codec, cfg }, stream) {
    this.codec = codec; this.cfg = cfg || {}; this.current = stream || null;
    this._reset();
  }
  _reset() {
    if (this.decoder) { try { this.decoder.close(); } catch (e) {} }
    this.decoder = new VideoDecoder({ output: f => this._out(f), error: e => { this.stats.errors++; this.needKey = true; this.onKeyRequest(); this._reset(); } });
    const c = { codec: this.codec, optimizeForLatency: true };
    if (this.cfg.w && this.cfg.h) { c.codedWidth = this.cfg.w; c.codedHeight = this.cfg.h; }
    try { this.decoder.configure(c); } catch (e) { this.log('decoder configure: ' + e.message); this.decoder = null; }
    this.needKey = true; this.lastSeq = -1;
  }
  onFrame(f, stream) {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.current && stream && stream !== this.current) return;      // an old rendition still draining after a switch
    if (this.lastSeq >= 0 && f.seq !== this.lastSeq + 1 && !f.key) { this.needKey = true; this.stats.loss++; }
    if (this.needKey) { if (!f.key) { this.onKeyRequest(); return; } this.needKey = false; }
    if (this.decoder.decodeQueueSize > 8 && !f.key) { this.needKey = true; return; }   // hopelessly behind: skip to next keyframe
    this.lastSeq = f.seq;
    try { this.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.ts), data: f.data })); }
    catch (e) { this.stats.errors++; this.needKey = true; }
  }
  _out(frame) {
    this.stats.decoded++;
    if (this.pending) this.pending.close();           // newest frame wins
    this.pending = frame;
    this._schedule();
  }
  _schedule() {
    if (this.timer) return;
    let due = 0;
    if (this.sync && this.actx) { const lt = this.sync(this.pending.timestamp); if (lt != null) due = (lt - this.actx.currentTime) * 1000; }
    if (due <= 4) return this._draw();
    this.timer = setTimeout(() => { this.timer = null; this._draw(); }, Math.min(due, 250));
  }
  _draw() {
    const f = this.pending; this.pending = null; if (!f) return;
    const w = f.displayWidth || f.codedWidth, h = f.displayHeight || f.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.stats.w = w; this.stats.h = h; }
    try { this.c2d.drawImage(f, 0, 0, w, h); } catch (e) {}
    this.stats.drawn++; this.stats.lastTs = f.timestamp; this.stats.latencyMs = (nowUs() - f.timestamp) / 1000; this._fpsN++;
    f.close();
  }
  stop() {
    clearTimeout(this.timer); this.timer = null; clearInterval(this._fpsTimer);
    if (this.pending) { this.pending.close(); this.pending = null; }
    if (this.decoder) { try { this.decoder.close(); } catch (e) {} this.decoder = null; }
  }
}

class AudioSink {
  constructor({ ctx, targetMs, log }) {
    this.ctx = ctx; this.target = Math.round((targetMs || 100) * 48); this.log = log || (() => {});
    this.decoder = null; this.anchor = null; this.q = 0; this.under = 0; this.lastSeq = -1;
    this.stats = { frames: 0, decoded: 0, concealed: 0, under: 0, queuedMs: 0 };
  }
  async start() {
    await ensureWorklets(this.ctx);
    this.node = new AudioWorkletNode(this.ctx, 'bep46-play', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { target: this.target } });
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain); this.gain.connect(this.ctx.destination);
    this.node.port.onmessage = e => { this.q = e.data.q; this.under = e.data.under; this.stats.under = this.under; this.stats.queuedMs = this.q / 48; };
    this._lastUnder = 0; this._stableSince = nowMs();
    this._adaptT = setInterval(() => this._adapt(), 2000);
  }
  _adapt() {
    if (!this.node) return;
    const now = nowMs();
    if (this.under > this._lastUnder) {                      // glitches: give the network more room, up to 300 ms
      this._lastUnder = this.under; this._stableSince = now;
      this.target = Math.min(300 * 48, this.target + 20 * 48);
      this.node.port.postMessage({ target: this.target });
    } else if (now - this._stableSince > 30000 && this.target > 60 * 48) {   // quiet for 30 s: trim 10 ms
      this._stableSince = now;
      this.target = Math.max(60 * 48, this.target - 10 * 48);
      this.node.port.postMessage({ target: this.target });
    }
    this.stats.targetMs = this.target / 48;
  }
  onConfig({ codec }, stream) {
    this.current = stream || null;
    if (this.decoder) { try { this.decoder.close(); } catch (e) {} }
    this.decoder = new AudioDecoder({ output: ad => this._out(ad), error: e => { this.log('audio decoder error: ' + e.message); this.decoder = null; setTimeout(() => this.onConfig({ codec }), 200); } });
    try { this.decoder.configure({ codec: codec || 'opus', sampleRate: 48000, numberOfChannels: 1 }); } catch (e) { this.log('audio decoder configure: ' + e.message); this.decoder = null; }
    this.lastSeq = -1;
  }
  onFrame(f, stream) {
    if (!this.decoder || this.decoder.state !== 'configured' || !this.node) return;
    if (this.current && stream && stream !== this.current) return;
    this.stats.frames++;
    if (this.lastSeq >= 0 && f.seq > this.lastSeq + 1) {                    // lost frames: keep time with silence
      const gap = Math.min(5, f.seq - this.lastSeq - 1);
      for (let i = 0; i < gap; i++) { this.node.port.postMessage({ pcm: new Float32Array(960) }); this.stats.concealed++; }
    }
    if (f.seq > this.lastSeq) this.lastSeq = f.seq; else return;               // out of order: too late to play
    try { this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.ts), data: f.data })); } catch (e) {}
  }
  _out(ad) {
    const n = ad.numberOfFrames;
    const f32 = new Float32Array(n);
    try { ad.copyTo(f32, { planeIndex: 0, format: 'f32-planar' }); } catch (e) { try { ad.copyTo(f32, { planeIndex: 0 }); } catch (e2) { ad.close(); return; } }
    this.stats.decoded++;
    this.anchor = { ts: ad.timestamp, local: this.ctx.currentTime + this.q / 48000 };
    if (this.node) this.node.port.postMessage({ pcm: f32 }, [f32.buffer]);
    ad.close();
  }
  /* maps a publisher timestamp (µs) to the AudioContext time at which it will be heard */
  localTimeFor(ts) { return this.anchor ? this.anchor.local + (ts - this.anchor.ts) / 1e6 : null; }
  setVolume(v) { if (this.gain) this.gain.gain.value = v; }
  stop() {
    clearInterval(this._adaptT);
    if (this.decoder) { try { this.decoder.close(); } catch (e) {} this.decoder = null; }
    try { this.node && this.node.disconnect(); this.gain && this.gain.disconnect(); } catch (e) {}
    this.node = null;
  }
}

return {
  version: '0.2.0',
  // pure
  b64u, unb64u, toHex, fromHex, sha1hex, nowUs, Emitter,
  newIdentity, identityFromSecret, newRoomSecret, deriveRoom,
  signEnvelope, verifyEnvelope, hsTranscript, hsProve, hsVerify,
  HDR, MAX_CHUNK, T_VIDEO, T_AUDIO, F_KEY, readHeader, chunkFrame, withSid, Reassembler, GroupCache,
  SpeakerSelector, DEFAULT_TRACKERS, DEFAULT_ICE, DEFAULT_RENDITIONS,
  // browser
  Room, Link, Node, VideoPublisher, AudioPublisher, VideoSink, AudioSink, pickVideoCodec, ensureWorklets, hasWebCodecs
};
});
