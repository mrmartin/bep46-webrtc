'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../bep46-stream.js');
const nacl = require('tweetnacl');

test('base64url round-trips every length', () => {
  for (let n = 0; n < 70; n++) {
    const b = nacl.randomBytes(n);
    const s = L.b64u(b);
    assert.match(s, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(Array.from(L.unb64u(s)), Array.from(b));
  }
  assert.equal(L.unb64u('***').length, 0);
});

test('deriveRoom is deterministic and hides the secret', () => {
  const a = L.deriveRoom('tuesday-standup'), b = L.deriveRoom('tuesday-standup'), c = L.deriveRoom('tuesday-standup2');
  assert.equal(a.infoHash, b.infoHash);
  assert.match(a.infoHash, /^[0-9a-f]{40}$/);
  assert.notEqual(a.infoHash, c.infoHash);
  assert.equal(a.key.length, 32);
  assert.notEqual(L.b64u(a.key), L.b64u(c.key));
});

test('envelopes verify and detect tampering', () => {
  const id = L.newIdentity();
  const e = L.signEnvelope(id, 'pres', { n: 'Ann', q: 1 }, '', 8);
  assert.equal(e.f, id.id);
  assert.ok(L.verifyEnvelope(e));
  assert.ok(!L.verifyEnvelope(Object.assign({}, e, { b: JSON.stringify({ n: 'Bob', q: 1 }) })));
  assert.ok(!L.verifyEnvelope(Object.assign({}, e, { o: L.newIdentity().id })));
  assert.ok(!L.verifyEnvelope(Object.assign({}, e, { f: L.newIdentity().id })));
  assert.ok(L.verifyEnvelope(Object.assign({}, e, { l: 1 })));   // ttl is outside the signature on purpose
  assert.ok(!L.verifyEnvelope(null));
  assert.ok(!L.verifyEnvelope({ i: 'x' }));
});

test('handshake: same transcript from both sides, proofs bind identity and room', () => {
  const room = L.deriveRoom('s'), other = L.deriveRoom('t');
  const A = L.newIdentity(), B = L.newIdentity(), M = L.newIdentity();
  const tA = L.hsTranscript(room.infoHash, A.id, B.id, 'nA', 'nB', 3);
  const tB = L.hsTranscript(room.infoHash, B.id, A.id, 'nB', 'nA', 3);
  assert.deepEqual(Array.from(tA), Array.from(tB));
  const p = L.hsProve(tA, A, room.key);
  assert.ok(L.hsVerify(tB, p.sig, p.tag, A.pk, room.key));
  assert.ok(!L.hsVerify(tB, p.sig, p.tag, M.pk, room.key), 'other identity');
  assert.ok(!L.hsVerify(tB, p.sig, p.tag, A.pk, other.key), 'other room');
  const t4 = L.hsTranscript(room.infoHash, A.id, B.id, 'nA', 'nB', 4);
  assert.ok(!L.hsVerify(t4, p.sig, p.tag, A.pk, room.key), 'replayed into another round');
});

test('framing: chunk, header, reassemble out of order with duplicates', () => {
  const data = nacl.randomBytes(50000);
  const chunks = L.chunkFrame(L.T_VIDEO, 7, 42, L.F_KEY, 1234567890123, data);
  assert.equal(chunks.length, 4);
  const h0 = L.readHeader(chunks[0]);
  assert.deepEqual({ type: h0.type, key: h0.key, sid: h0.sid, seq: h0.seq, idx: h0.idx, cnt: h0.cnt, ts: h0.ts }, { type: 1, key: true, sid: 7, seq: 42, idx: 0, cnt: 4, ts: 1234567890123 });
  const r = new L.Reassembler();
  const order = [2, 0, 3, 0, 1];
  let out = null;
  for (const i of order) { const c = L.withSid(chunks[i], 9); const h = L.readHeader(c); assert.equal(h.sid, 9); const f = r.add(h, c, 1000); if (f) { assert.equal(out, null); out = f; } }
  assert.ok(out, 'frame completed');
  assert.equal(out.seq, 42); assert.ok(out.key);
  assert.deepEqual(Array.from(out.data), Array.from(data));
  assert.equal(r.pending.size, 0);
  // single-chunk audio frames pass straight through
  const a = L.chunkFrame(L.T_AUDIO, 1, 5, 0, 99, nacl.randomBytes(80));
  assert.equal(a.length, 1);
  const fa = r.add(L.readHeader(a[0]), a[0], 1000);
  assert.equal(fa.seq, 5); assert.equal(fa.type, L.T_AUDIO); assert.equal(fa.data.length, 80);
  assert.equal(L.readHeader(new ArrayBuffer(3)), null);
});

test('framing: lost chunk is pruned by age and window', () => {
  const r = new L.Reassembler({ maxAgeMs: 100, window: 4 });
  const chunks = L.chunkFrame(L.T_VIDEO, 1, 1, 0, 0, nacl.randomBytes(40000));
  r.add(L.readHeader(chunks[0]), chunks[0], 0);
  r.add(L.readHeader(chunks[1]), chunks[1], 0);
  assert.equal(r.pending.size, 1);
  r.prune(50); assert.equal(r.pending.size, 1);
  r.prune(200); assert.equal(r.pending.size, 0); assert.equal(r.dropped, 1);
  const c2 = L.chunkFrame(L.T_VIDEO, 1, 2, 0, 0, nacl.randomBytes(40000));
  r.add(L.readHeader(c2[0]), c2[0], 300);
  for (let s = 3; s < 10; s++) { const c = L.chunkFrame(L.T_VIDEO, 1, s, 0, 0, new Uint8Array(10)); r.add(L.readHeader(c[0]), c[0], 300); }
  r.prune(300);
  assert.equal(r.pending.size, 0, 'old partial frame fell out of the window');
});

test('group cache: starts at a keyframe and bursts only decodable frames', () => {
  const g = new L.GroupCache();
  const push = (seq, key, size) => { const cs = L.chunkFrame(L.T_VIDEO, 1, seq, key ? L.F_KEY : 0, 0, nacl.randomBytes(size)); for (const c of cs) g.add(L.readHeader(c), c); return cs; };
  push(1, false, 100);
  assert.equal(g.burst().length, 0, 'delta before any keyframe is useless');
  push(2, true, 30000);               // 2 chunks
  push(3, false, 100);
  const partial = L.chunkFrame(L.T_VIDEO, 1, 4, 0, 0, nacl.randomBytes(30000));
  g.add(L.readHeader(partial[0]), partial[0]);   // second chunk never arrives
  push(5, false, 100);
  const b = g.burst();
  assert.equal(b.length, 3, 'keyframe (2 chunks) + one delta, stop at the incomplete frame');
  assert.equal(L.readHeader(b[0]).seq, 2);
  push(6, true, 100);
  assert.equal(g.frames.length, 1, 'new keyframe resets the group');
  assert.equal(g.burst().length, 1);
});

test('speaker selector: top three, hysteresis and pins', () => {
  const sel = new L.SpeakerSelector({ max: 3, holdMs: 2000 });
  const peers = t => [
    { id: 'a', speaking: true, level: 0.5, lastSpokeAt: t },
    { id: 'b', speaking: true, level: 0.2, lastSpokeAt: t },
    { id: 'c', speaking: false, level: 0, lastSpokeAt: t - 500 },
    { id: 'd', speaking: false, level: 0, lastSpokeAt: 0 },
    { id: 'e', speaking: false, level: 0, lastSpokeAt: 0 }
  ];
  let s = sel.update(10000, peers(10000));
  assert.deepEqual(Array.from(s).sort(), ['a', 'b', 'c']);
  // c goes quiet, d starts talking: d should replace c only after the hold time
  const p2 = peers(10000).map(p => p.id === 'd' ? Object.assign(p, { speaking: true, level: 0.3, lastSpokeAt: 11000 }) : p);
  s = sel.update(11000, p2);
  assert.ok(s.has('a') && s.has('b'));
  assert.equal(s.size, 3);
  s = sel.update(13000, p2.map(p => p.id === 'c' ? Object.assign(p, { lastSpokeAt: 10000 }) : p));
  assert.deepEqual(Array.from(s).sort(), ['a', 'b', 'd']);
  // pinned wins a slot even when silent
  s = sel.update(14000, p2, new Set(['e']));
  assert.ok(s.has('e')); assert.equal(s.size, 3);
  // never more than max, never fewer than available
  s = sel.update(15000, p2.slice(0, 2));
  assert.equal(s.size, 2);
});
