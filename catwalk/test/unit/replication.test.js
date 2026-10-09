// Social records travel between peers exactly like account records: late
// joiners catch up, a friends-only post written on one browser is readable
// by the friend on another, and nobody can inject records for someone else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, sameLedgers } from '../helpers.js';
import { signSocial, SOCIAL_VERSION, profileId } from '../../src/social.js';
import { ed25519 } from '../../../accounts/src/crypto.js';
import { toHex } from '../../../accounts/src/bytes.js';

test('two browsers: friends, posts and a friends-only post cross the swarm', async () => {
  const { nodes, settle } = cluster(3);
  const [A, B, C] = nodes;
  await settle();
  const alice = await A.accounts.register('alice', 'alice-password');
  A.app.unlock(alice); A.app.setProfile({ name: 'Alice', fur: 'ginger', eyes: 'green' });
  const bob = await B.accounts.register('bob', 'bob-password');
  B.app.unlock(bob); B.app.setProfile({ name: 'Bob', fur: 'tuxedo', eyes: 'amber' });
  await settle();
  assert.equal(A.app.members().length, 2);
  assert.equal(C.app.members().length, 2);

  A.app.addFriend(bob.pk);
  await settle();
  assert.deepEqual(B.app.pendingIncoming(bob.pk).map((p) => p.pk), [alice.pk]);
  B.app.addFriend(alice.pk);
  B.app.post('bob says hi to friends', 'friends');
  B.app.post('bob says hi to all', 'public');
  await settle();
  sameLedgers(nodes);
  assert.equal(A.app.isFriend(alice.pk, bob.pk), true);
  assert.deepEqual(A.app.feed().map((p) => p.text).sort(), ['bob says hi to all', 'bob says hi to friends']);
  // C (signed out) only sees the public one
  assert.deepEqual(C.app.feed().map((p) => p.text), ['bob says hi to all']);
});

test('a late joiner on the same swarm receives the whole ledger and can sign in and read', async () => {
  const c = cluster(2);
  const [A, B] = c.nodes;
  await c.settle();
  const alice = await A.accounts.register('alice', 'alice-password');
  A.app.unlock(alice); A.app.setProfile({ name: 'Alice' });
  const bob = await A.accounts.register('bob', 'bob-password');
  A.app.unlock(bob); A.app.setProfile({ name: 'Bob' }); A.app.addFriend(alice.pk);
  A.app.unlock(alice); A.app.addFriend(bob.pk); A.app.post('secret for bob', 'friends'); A.app.post('hello everyone');
  await c.settle();
  sameLedgers(c.nodes);
  // B signs in as bob with the replicated account and reads the replicated secret
  const bobOnB = await B.accounts.login('bob', 'bob-password');
  B.app.unlock(bobOnB);
  assert.deepEqual(B.app.feed().map((p) => p.text).sort(), ['hello everyone', 'secret for bob']);
  assert.deepEqual(B.app.friendsOf(bob.pk), [alice.pk]);
});

test('a hostile peer cannot plant or roll back records', async () => {
  const c = cluster(2);
  const [A, Evil] = c.nodes;
  await c.settle();
  const alice = await A.accounts.register('alice', 'alice-password');
  A.app.unlock(alice); A.app.setProfile({ name: 'Alice', fur: 'white', eyes: 'blue' });
  await c.settle();
  const before = Evil.ledger.get(profileId(alice.pk));
  // forged profile under alice's id signed by evil's key
  const kp = ed25519.keyPair();
  const forged = signSocial({ v: SOCIAL_VERSION, kind: 'profile', id: profileId(alice.pk), owner: toHex(kp.publicKey), seq: 99, ts: 5, deleted: false, body: { ...before.body, name: 'Evil Alice' } }, kp.secretKey);
  assert.equal(Evil.ledger.ingest(forged).accepted, false);
  // replay of an older version
  A.app.setProfile({ name: 'Alice II', fur: 'white', eyes: 'blue' });
  await c.settle();
  assert.equal(Evil.ledger.ingest(before).reason, 'stale');
  assert.equal(A.ledger.get(profileId(alice.pk)).body.name, 'Alice II');
  // Evil broadcasts garbage; A ignores it and keeps converged state
  Evil.replicas[1].transport.broadcast({ t: 'update', record: forged });
  Evil.replicas[1].transport.broadcast({ t: 'records', records: [before, { nonsense: true }] });
  await c.settle();
  assert.equal(A.ledger.get(profileId(alice.pk)).body.name, 'Alice II');
  sameLedgers(c.nodes);
});
