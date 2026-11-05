// Single-replica behaviour: the account lifecycle against one local Directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standalone, rejects, clock } from '../helpers.js';
import { Directory, memoryStore } from '../../src/directory.js';
import { Accounts } from '../../src/accounts.js';
import { TEST_KDF } from '../helpers.js';

test('register → login works; wrong password and unknown user both fail identically', async () => {
  const { accounts } = standalone();
  const s = await accounts.register('Alice', 'correct-horse');
  assert.equal(s.username, 'alice');
  assert.equal(JSON.stringify(s).includes('secretKey'), false, 'session never serialises the secret');

  const s2 = await accounts.login('alice', 'correct-horse');
  assert.equal(s2.pk, s.pk);
  assert.deepEqual(s2.secretKey, s.secretKey);

  const e1 = await rejects(accounts.login('alice', 'wrong-horse!'), 'invalid_credentials');
  const e2 = await rejects(accounts.login('nobody', 'correct-horse'), 'invalid_credentials');
  assert.equal(e1.message, e2.message, 'no username enumeration via error text');
});

test('input rules: username validity, password length, duplicate names', async () => {
  const { accounts } = standalone();
  await rejects(accounts.register('ab', 'long-enough-pw'), 'bad_username');
  await rejects(accounts.register('alice!', 'long-enough-pw'), 'bad_username');
  await rejects(accounts.register('alice', 'short'), 'weak_password');
  await accounts.register('alice', 'long-enough-pw');
  await rejects(accounts.register('ALICE', 'another-long-pw'), 'username_taken');
});

test('change password: old stops working, new works, same identity, seq increments', async () => {
  const { accounts, directory } = standalone();
  const s = await accounts.register('bob', 'first-password');
  await rejects(accounts.changePassword(s, 'not-the-password', 'second-password'), 'invalid_credentials');
  await rejects(accounts.changePassword(s, 'first-password', 'short'), 'weak_password');

  const before = directory.get(s.pk);
  const rec = await accounts.changePassword(s, 'first-password', 'second-password');
  assert.equal(rec.seq, 2);
  assert.equal(rec.pk, s.pk, 'root identity unchanged');
  assert.notEqual(rec.kdf.salt, before.kdf.salt, 'fresh salt');
  assert.notEqual(rec.box.ct, before.box.ct);

  await rejects(accounts.login('bob', 'first-password'), 'invalid_credentials');
  const s2 = await accounts.login('bob', 'second-password');
  assert.equal(s2.pk, s.pk);
  assert.deepEqual(s2.secretKey, s.secretKey, 'the same root secret key, re-sealed');
});

test('delete: requires password, leaves a tombstone, frees the name, blocks replays', async () => {
  const { accounts, directory } = standalone();
  const s = await accounts.register('carol', 'carol-password');
  const live = directory.get(s.pk);
  await rejects(accounts.deleteAccount(s, 'wrong-password'), 'invalid_credentials');

  const tomb = await accounts.deleteAccount(s, 'carol-password');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.seq, 2);
  assert.equal(tomb.kdf, undefined);
  assert.equal(tomb.box, undefined);
  assert.equal(s.secretKey, null, 'session wiped');

  await rejects(accounts.login('carol', 'carol-password'), 'invalid_credentials');
  assert.equal(directory.lookup('carol').claimants.length, 0);
  assert.equal(directory.listTombstones().length, 1);

  // Replaying the old live record must not resurrect the account.
  assert.equal(directory.ingest(live).accepted, false);
  assert.equal(directory.get(s.pk).deleted, true);

  // The name is free again — for a NEW identity.
  const s2 = await accounts.register('carol', 'new-carol-password');
  assert.notEqual(s2.pk, s.pk);
  assert.equal(directory.lookup('carol').owner.pk, s2.pk);
});

test('operations on a deleted session fail cleanly', async () => {
  const { accounts, directory } = standalone();
  const s = await accounts.register('dave', 'dave-password');
  const s2 = await accounts.login('dave', 'dave-password');
  await accounts.deleteAccount(s, 'dave-password');
  await rejects(accounts.changePassword(s2, 'dave-password', 'dave-password-2'), 'deleted');
  await rejects(accounts.deleteAccount(s2, 'dave-password'), 'deleted');
  assert.equal(directory.get(s2.pk).deleted, true);
});

test('directory persists through its store and reloads identically', async () => {
  const store = memoryStore();
  const { accounts } = standalone({ store });
  const a = await accounts.register('erin', 'erin-password');
  await accounts.changePassword(a, 'erin-password', 'erin-password-2');
  const f = await accounts.register('frank', 'frank-password');
  await accounts.deleteAccount(f, 'frank-password');

  const reloaded = new Directory({ store });
  assert.equal(reloaded.all().length, 2);
  assert.equal(reloaded.get(a.pk).seq, 2);
  assert.equal(reloaded.get(f.pk).deleted, true);

  const accounts2 = new Accounts({ directory: reloaded, kdf: TEST_KDF, now: clock() });
  const s = await accounts2.login('erin', 'erin-password-2');
  assert.equal(s.pk, a.pk);
  await rejects(accounts2.login('frank', 'frank-password'), 'invalid_credentials');

  // A corrupted store entry is dropped, not fatal.
  const bad = memoryStore([...store.peek(), { v: 1, user: 'x', garbage: true }]);
  const d3 = new Directory({ store: bad });
  assert.equal(d3.all().length, 2);
  assert.equal(d3.stats.rejected, 1);
});

test('two claimants of one name: deterministic owner, login picks by password, squatter cannot impersonate', async () => {
  // Two independent devices that have never synced both register "grace".
  const now = clock();
  const A = standalone({ now });
  const B = standalone({ now });
  const sa = await A.accounts.register('grace', 'grace-on-A-pw');
  const sb = await B.accounts.register('grace', 'grace-on-B-pw');

  // Now they merge (simulate sync by cross-ingesting), in opposite orders.
  A.directory.ingestAll(B.directory.all());
  B.directory.ingestAll(A.directory.all());
  assert.deepEqual(A.directory.all().map((r) => r.pk).sort(), B.directory.all().map((r) => r.pk).sort());

  const la = A.directory.lookup('grace');
  const lb = B.directory.lookup('grace');
  assert.equal(la.claimants.length, 2);
  assert.equal(la.owner.pk, lb.owner.pk, 'all peers agree on the display owner');
  assert.equal(la.owner.pk, sa.pk, 'older registration wins the display');

  // Each password opens exactly its own account, on either replica.
  assert.equal((await A.accounts.login('grace', 'grace-on-B-pw')).pk, sb.pk);
  assert.equal((await B.accounts.login('grace', 'grace-on-A-pw')).pk, sa.pk);
  await rejects(A.accounts.login('grace', 'neither-password'), 'invalid_credentials');

  // Registration of the contested name is now refused everywhere.
  await rejects(A.accounts.register('grace', 'third-grace-pw'), 'username_taken');
});

test('same-seq fork by an owner converges to the same pick regardless of order', async () => {
  const now = clock();
  const { accounts, directory } = standalone({ now });
  const s = await accounts.register('heidi', 'heidi-password');
  // Owner (mis)behaves: signs two different seq-2 records (e.g. two devices offline).
  const d1 = new Directory(); d1.ingestAll(directory.all());
  const d2 = new Directory(); d2.ingestAll(directory.all());
  const a1 = new Accounts({ directory: d1, kdf: TEST_KDF, now });
  const a2 = new Accounts({ directory: d2, kdf: TEST_KDF, now });
  const r1 = await a1.changePassword(s, 'heidi-password', 'heidi-password-x');
  const r2 = await a2.changePassword(s, 'heidi-password', 'heidi-password-y');
  assert.equal(r1.seq, 2); assert.equal(r2.seq, 2); assert.notEqual(r1.sig, r2.sig);

  const x = new Directory(); x.ingest(r1); x.ingest(r2);
  const y = new Directory(); y.ingest(r2); y.ingest(r1);
  assert.equal(x.get(s.pk).sig, y.get(s.pk).sig, 'order-independent');
  assert.equal(x.get(s.pk).sig, r1.sig < r2.sig ? r1.sig : r2.sig);
});
