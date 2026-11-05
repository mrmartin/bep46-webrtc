// Multi-replica behaviour over the simulated swarm: propagation, late joiners,
// partitions, hostile peers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cluster, rejects, TEST_KDF } from '../helpers.js';
import { Directory } from '../../src/directory.js';
import { Accounts } from '../../src/accounts.js';
import { Replica } from '../../src/replica.js';
import { signRecord } from '../../src/records.js';
import { ed25519 } from '../../src/crypto.js';
import { toHex } from '../../src/bytes.js';

function sameState(nodes) {
  const snap = (d) => JSON.stringify(d.all().map((r) => [r.pk, r.seq, r.sig]).sort());
  const first = snap(nodes[0].directory);
  for (const n of nodes.slice(1)) assert.equal(snap(n.directory), first, `${n.name} diverged`);
}

test('register on one peer, log in on another; password change propagates', async () => {
  const { swarm, nodes } = cluster(3);
  const [A, B, C] = nodes;
  await swarm.settle();

  const sa = await A.accounts.register('alice', 'alice-password');
  await swarm.settle();
  assert.ok(B.directory.get(sa.pk), 'B has alice');
  assert.ok(C.directory.get(sa.pk), 'C has alice');
  sameState(nodes);

  const sc = await C.accounts.login('alice', 'alice-password');
  assert.equal(sc.pk, sa.pk);

  await B.accounts.changePassword(await B.accounts.login('alice', 'alice-password'), 'alice-password', 'alice-password-2');
  await swarm.settle();
  sameState(nodes);
  await rejects(A.accounts.login('alice', 'alice-password'), 'invalid_credentials');
  assert.equal((await A.accounts.login('alice', 'alice-password-2')).pk, sa.pk);

  const sx = await A.accounts.login('alice', 'alice-password-2');
  await A.accounts.deleteAccount(sx, 'alice-password-2');
  await swarm.settle();
  sameState(nodes);
  for (const n of nodes) await rejects(n.accounts.login('alice', 'alice-password-2'), 'invalid_credentials');
});

test('a late joiner receives the full directory on connect', async () => {
  const { swarm, nodes } = cluster(2);
  const [A, B] = nodes;
  await swarm.settle();
  for (const u of ['user1', 'user2', 'user3']) await A.accounts.register(u, `${u}-password`);
  await rejects(B.accounts.login('user2', 'user2-password'), 'invalid_credentials'); // not propagated yet
  await swarm.settle();
  const s = await B.accounts.login('user2', 'user2-password');
  await B.accounts.changePassword(s, 'user2-password', 'user2-password-new');
  await swarm.settle();

  const { nodes: late } = cluster(1, { swarm });
  const D = late[0];
  assert.equal(D.directory.all().length, 0);
  await swarm.settle();
  assert.equal(D.directory.all().length, 3);
  sameState([...nodes, D]);
  assert.ok(await D.accounts.login('user2', 'user2-password-new'));
});

test('partition: writes on each side merge on heal; newer seq wins everywhere', async () => {
  const { swarm, nodes } = cluster(4);
  const [A, B, C, D] = nodes;
  await swarm.settle();
  const s = await A.accounts.register('ivan', 'ivan-password');
  await C.accounts.register('judy', 'judy-password');
  await swarm.settle();
  sameState(nodes);

  swarm.partition([A.transport, B.transport], [C.transport, D.transport]);

  // Left side: ivan changes password (seq 2). Right side: still at seq 1; judy deletes.
  await A.accounts.changePassword(s, 'ivan-password', 'ivan-password-left');
  const sj = await D.accounts.login('judy', 'judy-password');
  await D.accounts.deleteAccount(sj, 'judy-password');
  await swarm.settle();
  assert.equal(C.directory.get(s.pk).seq, 1, 'right side has not seen the change');
  assert.equal(B.directory.lookup('judy').claimants.length, 1, 'left side still sees judy');

  swarm.heal();
  await swarm.settle();
  sameState(nodes);
  for (const n of nodes) {
    assert.equal(n.directory.get(s.pk).seq, 2);
    assert.equal(n.directory.lookup('judy').claimants.length, 0);
    await rejects(n.accounts.login('ivan', 'ivan-password'), 'invalid_credentials');
    assert.ok(await n.accounts.login('ivan', 'ivan-password-left'));
  }
});

test('partition on both sides of the SAME account converges (owner fork at equal seq)', async () => {
  const { swarm, nodes } = cluster(2);
  const [A, B] = nodes;
  await swarm.settle();
  const sa = await A.accounts.register('kim', 'kim-password');
  await swarm.settle();
  const sb = await B.accounts.login('kim', 'kim-password');

  swarm.partition([A.transport], [B.transport]);
  const ra = await A.accounts.changePassword(sa, 'kim-password', 'kim-password-A');
  const rb = await B.accounts.changePassword(sb, 'kim-password', 'kim-password-B');
  assert.equal(ra.seq, rb.seq);
  swarm.heal();
  await swarm.settle();
  sameState(nodes);
  const winner = A.directory.get(sa.pk).sig === ra.sig ? 'A' : 'B';
  // Exactly one of the two passwords works, and the same one on both peers.
  for (const n of nodes) {
    const okA = await n.accounts.login('kim', 'kim-password-A').then(() => true, () => false);
    const okB = await n.accounts.login('kim', 'kim-password-B').then(() => true, () => false);
    assert.equal(okA, winner === 'A');
    assert.equal(okB, winner === 'B');
  }
});

test('hostile peer: forged, replayed, and squatted records cannot corrupt the directory', async () => {
  const { swarm, nodes } = cluster(3);
  const [A, B, Evil] = nodes;
  await swarm.settle();
  const s = await A.accounts.register('leo', 'leo-password');
  const v1 = A.directory.get(s.pk);
  await A.accounts.changePassword(s, 'leo-password', 'leo-password-2');
  await swarm.settle();
  sameState(nodes);

  const before = JSON.stringify(A.directory.all());
  // 1. Unsigned garbage / tampered copies
  Evil.transport.broadcast({ t: 'update', record: { ...A.directory.get(s.pk), user: 'leo', deleted: true } });
  Evil.transport.broadcast({ t: 'update', record: { ...A.directory.get(s.pk), seq: 99 } });
  Evil.transport.broadcast({ t: 'sync', records: [{ hello: 'world' }, null, 42] });
  Evil.transport.broadcast({ t: 'records', records: 'not-an-array' });
  Evil.transport.broadcast({ t: 'digest', items: [[s.pk, 10 ** 9]] }); // claims to have a future version
  Evil.transport.broadcast({ t: 'bogus' });
  Evil.transport.broadcast(null);
  // 2. Replay of the pre-change record (valid signature, lower seq)
  Evil.transport.broadcast({ t: 'update', record: v1 });
  await swarm.settle();
  assert.equal(JSON.stringify(A.directory.all()), before, 'A unchanged');
  assert.equal(JSON.stringify(B.directory.all()), before, 'B unchanged');
  assert.ok(A.directory.stats.rejected >= 2);
  await rejects(A.accounts.login('leo', 'leo-password'), 'invalid_credentials');

  // 3. A squatter publishes its own well-formed "leo" record under a new key.
  const kp = ed25519.keyPair();
  const squat = signRecord({
    v: 1, user: 'leo', pk: toHex(kp.publicKey), seq: 1, ts: 0, deleted: false,
    kdf: { ...TEST_KDF, salt: '00'.repeat(16) }, box: { nonce: '00'.repeat(24), ct: '00'.repeat(80) },
  }, kp.secretKey);
  Evil.transport.broadcast({ t: 'update', record: squat });
  await swarm.settle();
  sameState(nodes);
  const lk = A.directory.lookup('leo');
  assert.equal(lk.claimants.length, 2, 'the squat is visible as a second claimant');
  assert.equal(lk.owner.pk, squat.pk, 'with a back-dated ts the squatter can win the DISPLAY slot…');
  const real = await A.accounts.login('leo', 'leo-password-2');
  assert.equal(real.pk, s.pk, '…but the real password still opens only the real account');
  // and the squatter's box opens for nobody.
  await rejects(B.accounts.login('leo', 'anything-at-all'), 'invalid_credentials');
});

test('anti-entropy: digest heartbeat repairs a peer that missed an update', async () => {
  // Build two replicas that are connected but where B's directory was
  // populated behind the replica's back (simulating a missed message).
  const { swarm, nodes } = cluster(2, { heartbeatMs: 0 });
  const [A, B] = nodes;
  await swarm.settle();
  const s = await A.accounts.register('mia', 'mia-password');
  await swarm.settle();
  // Sneak a newer record into A only, without going through the fan-out.
  const d = new Directory(); d.ingestAll(A.directory.all());
  const acc = new Accounts({ directory: d, kdf: TEST_KDF });
  const r2 = await acc.changePassword(s, 'mia-password', 'mia-password-2');
  A.directory.records.set(s.pk, Object.freeze(r2)); // bypass listeners deliberately
  assert.equal(B.directory.get(s.pk).seq, 1);

  // A heartbeat from B: B's digest says seq 1; A replies with its newer record.
  B.transport.broadcast({ t: 'digest', items: B.directory.digest() });
  await swarm.settle();
  assert.equal(B.directory.get(s.pk).seq, 2);

  // And the other direction: A's digest advertises seq 2 to a peer that is behind.
  const C = cluster(1, { swarm }).nodes[0];
  C.directory.records.clear(); // pretend the initial sync was lost
  await swarm.settle();
  C.directory.records.clear();
  A.transport.broadcast({ t: 'digest', items: A.directory.digest() });
  await swarm.settle();
  assert.equal(C.directory.get(s.pk)?.seq, 2, 'C asked for what the digest advertised');
});

test('stopping a replica stops both sending and receiving', async () => {
  const { swarm, nodes } = cluster(2);
  const [A, B] = nodes;
  await swarm.settle();
  B.replica.stop();
  await A.accounts.register('nina', 'nina-password');
  await swarm.settle();
  assert.equal(B.directory.all().length, 0);
  assert.equal(A.transport.peerCount(), 0);
});
