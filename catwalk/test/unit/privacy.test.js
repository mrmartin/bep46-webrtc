// Friends-only posts: who can read what, before and after unfriending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standalone, cat, rejects } from '../helpers.js';

/** Build one shared ledger used by several signed-in identities on one node (switch with unlock). */
async function trio() {
  const n = standalone();
  const a = await cat(n, 'alice');
  const b = await cat(n, 'bob');
  const c = await cat(n, 'carol');
  return { n, a, b, c };
}
const as = (n, s) => { n.app.unlock(s); return n.app; };

test('friends can read friends-only posts; strangers and signed-out visitors cannot', async () => {
  const { n, a, b, c } = await trio();
  as(n, a).addFriend(b.pk);
  as(n, b).addFriend(a.pk);               // now mutual
  as(n, a).post('public hello', 'public');
  as(n, a).post('only for friends', 'friends');

  const bobSees = as(n, b).feed().map((p) => p.text);
  assert.deepEqual(bobSees.sort(), ['only for friends', 'public hello']);

  const carolSees = as(n, c).feed().map((p) => p.text);
  assert.deepEqual(carolSees, ['public hello']);

  n.app.lock();
  assert.deepEqual(n.app.feed().map((p) => p.text), ['public hello']);
  assert.deepEqual(n.app.wall(a.pk).map((p) => p.text), ['public hello']);
});

test('a pending request is not friendship: the requester shares, the other side does not until they confirm', async () => {
  const { n, a, b } = await trio();
  as(n, a).addFriend(b.pk);
  as(n, a).post('a: friends only', 'friends');
  as(n, b).post('b: friends only', 'friends');
  assert.equal(as(n, b).feed().filter((p) => p.owner === a.pk).length, 0, 'bob is not a friend yet, sees nothing of alice');
  assert.equal(n.app.relation(b.pk, a.pk), 'wants');
  as(n, b).addFriend(a.pk);
  assert.equal(n.app.relation(b.pk, a.pk), 'friends');
  assert.deepEqual(as(n, b).feed().map((p) => p.text).sort(), ['a: friends only', 'b: friends only']);
  assert.deepEqual(as(n, a).feed().map((p) => p.text).sort(), ['a: friends only', 'b: friends only']);
});

test('unfriending starts a new epoch: the ex-friend can no longer read anything; a new friend reads everything', async () => {
  const { n, a, b, c } = await trio();
  as(n, a).addFriend(b.pk); as(n, b).addFriend(a.pk);
  as(n, a).post('epoch 1 secret', 'friends');
  as(n, a).removeFriend(b.pk);
  assert.equal(n.app.myFkey().body.epoch, 2);
  as(n, a).post('epoch 2 secret', 'friends');

  const bob = as(n, b);
  assert.equal(bob.relation(b.pk, a.pk), 'requested', 'bob still has his half of the link, so from his side it is a pending request');
  assert.equal(bob.isFriend(a.pk, b.pk), false);
  assert.deepEqual(bob.feed().map((p) => p.text), [], 'not friends: nothing shown');
  // even reading the records directly, bob can open nothing: the only record
  // that ever sealed a key to him has been replaced by one that does not
  const posts = n.ledger.byOwner(a.pk, 'post').map((r) => bob.readPost(r));
  assert.deepEqual(posts.map((p) => p.text), [null, null]);
  assert.ok(posts.every((p) => p.locked));

  as(n, c).addFriend(a.pk); as(n, a).addFriend(c.pk);
  assert.deepEqual(as(n, c).feed().map((p) => p.text).sort(), ['epoch 1 secret', 'epoch 2 secret']);
});

test('reconcile grants the key to friends who got a profile after the request; the key survives a password change', async () => {
  const n = standalone();
  const a = await cat(n, 'alice');
  const bSession = await n.accounts.register('bob', 'bob-password'); // no profile yet → no box key
  as(n, a).addFriend(bSession.pk);
  as(n, a).post('for friends', 'friends');
  assert.equal(n.app.myFkey().body.keys[bSession.pk], undefined, 'nothing to seal to yet');
  n.app.unlock(bSession);
  n.app.setProfile({ name: 'Bob', fur: 'black', eyes: 'amber' });
  n.app.addFriend(a.pk);
  assert.equal(n.app.feed().map((p) => p.text).includes('for friends'), false, 'alice has not reconciled yet');
  as(n, a);
  assert.equal(n.app.reconcile(), 1);
  assert.equal(as(n, bSession).feed().map((p) => p.text).includes('for friends'), true);

  // password change re-seals the same account key, so the derived box key is unchanged
  const a2 = await n.accounts.login('alice', 'alice-password');
  await n.accounts.changePassword(a2, 'alice-password', 'alice-password-2');
  const a3 = await n.accounts.login('alice', 'alice-password-2');
  assert.equal(as(n, a3).feed().map((p) => p.text).includes('for friends'), true);
  await rejects(() => n.app.post(''), 'empty');
});

test('pokes: latest wins, and poking yourself is refused', async () => {
  const { n, a, b } = await trio();
  as(n, a).poke(b.pk);
  as(n, a).poke(b.pk);
  const pokes = n.app.pokesFor(b.pk);
  assert.equal(pokes.length, 1);
  assert.equal(pokes[0].pk, a.pk);
  assert.equal(n.ledger.get(pokes[0].id).seq, 2);
  await rejects(() => n.app.poke(a.pk), 'self');
});
