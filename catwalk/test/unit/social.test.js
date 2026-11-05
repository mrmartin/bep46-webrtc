// Record format: strictness, ownership baked into ids, tamper detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standalone, cat } from '../helpers.js';
import { validateSocial, signSocial, friendId, profileId, SOCIAL_VERSION } from '../../src/social.js';
import { ed25519 } from '../../../accounts/src/crypto.js';
import { toHex } from '../../../accounts/src/bytes.js';

test('every kind of record a cat publishes validates, and every tamper breaks it', async () => {
  const n = standalone();
  const a = await cat(n, 'alice', { name: 'Alice', fur: 'calico', eyes: 'odd' });
  const b = await cat(n, 'bob');
  n.app.unlock(a);
  n.app.addFriend(b.pk);
  n.app.post('hello world');
  n.app.post('secret', 'friends');
  n.app.poke(b.pk);
  const kinds = new Set(n.ledger.all().map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ['fkey', 'friend', 'poke', 'post', 'profile']);
  for (const r of n.ledger.all()) {
    assert.equal(validateSocial(r).ok, true, r.kind);
    // flip one field at a time
    assert.equal(validateSocial({ ...r, ts: r.ts + 1 }).ok, false, `${r.kind} ts`);
    assert.equal(validateSocial({ ...r, seq: r.seq + 1 }).ok, false, `${r.kind} seq`);
    assert.equal(validateSocial({ ...r, extra: 1 }).ok, false, `${r.kind} extra field`);
    if (r.body) assert.equal(validateSocial({ ...r, body: { ...r.body, zzz: 1 } }).ok, false, `${r.kind} extra body field`);
    assert.equal(validateSocial({ ...r, sig: r.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }).ok, false, `${r.kind} sig`);
  }
});

test('a record whose id belongs to someone else is rejected even with a valid signature', async () => {
  const n = standalone();
  const a = await cat(n, 'alice');
  const b = await cat(n, 'bob');
  // bob signs a "profile" for alice's id
  const forged = signSocial({
    v: SOCIAL_VERSION, kind: 'profile', id: profileId(a.pk), owner: b.pk, seq: 5, ts: 1, deleted: false,
    body: { ...n.app.profile(b.pk), name: 'Impostor' },
  }, b.secretKey);
  assert.equal(validateSocial(forged).ok, false);
  // and a friend link "from alice" signed by bob
  const link = signSocial({ v: SOCIAL_VERSION, kind: 'friend', id: friendId(a.pk, b.pk), owner: a.pk, seq: 1, ts: 1, deleted: false, body: { to: b.pk } }, b.secretKey);
  assert.equal(validateSocial(link).reason, 'bad signature');
  // a tombstone for someone else's post
  const tomb = signSocial({ v: SOCIAL_VERSION, kind: 'post', id: `post:${a.pk}:0011223344556677`, owner: b.pk, seq: 9, ts: 1, deleted: true }, b.secretKey);
  assert.equal(validateSocial(tomb).reason, 'tombstone id/owner mismatch');
  // unknown kinds / oversize text
  const kp = ed25519.keyPair();
  const pk = toHex(kp.publicKey);
  const weird = signSocial({ v: SOCIAL_VERSION, kind: 'like', id: `like:${pk}`, owner: pk, seq: 1, ts: 1, deleted: false, body: {} }, kp.secretKey);
  assert.equal(validateSocial(weird).reason, 'bad kind');
  const long = signSocial({ v: SOCIAL_VERSION, kind: 'post', id: `post:${pk}:0011223344556677`, owner: pk, seq: 1, ts: 1, deleted: false, body: { aud: 'public', text: 'x'.repeat(1001) } }, kp.secretKey);
  assert.equal(validateSocial(long).reason, 'bad post text');
});

test('ledger merge: higher seq wins, stale and replayed versions are dropped, tombstones stick', async () => {
  const n = standalone();
  const a = await cat(n, 'alice', { name: 'v1' });
  n.app.setProfile({ name: 'v2', fur: 'grey', eyes: 'blue' });
  const v2 = n.ledger.get(profileId(a.pk));
  assert.equal(v2.seq, 2);
  const v1 = signSocial({ ...v2, seq: 1, body: { ...v2.body, name: 'v1 again' }, sig: undefined }, a.secretKey);
  delete v1.sig; // signSocial already set it; make sure the object is clean
  const again = signSocial(v1, a.secretKey);
  assert.equal(n.ledger.ingest(again).reason, 'stale');
  assert.equal(n.ledger.get(profileId(a.pk)).body.name, 'v2');
  const id = n.app.post('bye').id;
  n.app.deletePost(id);
  assert.equal(n.ledger.get(id).deleted, true);
  assert.equal(n.app.feed().length, 0);
});
