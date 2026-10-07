import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standalone, TEST_KDF } from '../helpers.js';
import { validateRecord, signRecord, normalizeUsername, isValidUsername, fingerprint } from '../../src/records.js';
import { ed25519 } from '../../src/crypto.js';
import { toHex } from '../../src/bytes.js';

async function freshRecord() {
  const { accounts, directory } = standalone();
  const session = await accounts.register('alice', 'password-one');
  return { record: directory.get(session.pk), session };
}

test('a freshly registered record validates and has the documented shape', async () => {
  const { record } = await freshRecord();
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(Object.keys(record).sort(), ['box', 'deleted', 'kdf', 'pk', 'seq', 'sig', 'ts', 'user', 'v']);
  assert.equal(record.seq, 1);
  assert.equal(record.kdf.N, TEST_KDF.N);
  assert.equal(record.box.ct.length, (64 + 16) * 2);
});

test('any single-field tamper breaks the signature', async () => {
  const { record } = await freshRecord();
  const tampers = {
    user: 'alicf',
    seq: record.seq + 1,
    ts: record.ts + 1,
    deleted: true, // also structurally invalid (tombstone with key material) — still must fail
    kdf: { ...record.kdf, N: record.kdf.N * 2 },
    box: { ...record.box, ct: record.box.ct.replace(/^../, (h) => (h === 'ff' ? '00' : 'ff')) },
    pk: record.pk.replace(/^../, (h) => (h === 'ff' ? '00' : 'ff')),
  };
  for (const [field, value] of Object.entries(tampers)) {
    const r = validateRecord({ ...record, [field]: value });
    assert.equal(r.ok, false, `tampering ${field} must fail`);
  }
  // Extra field, even harmless-looking, is rejected (strict schema).
  assert.equal(validateRecord({ ...record, note: 'hi' }).ok, false);
});

test('a record signed by a different key than pk is rejected', async () => {
  const { record } = await freshRecord();
  const other = ed25519.keyPair();
  const { sig, ...unsigned } = record;
  const forged = signRecord(unsigned, other.secretKey); // valid signature, wrong signer
  assert.equal(validateRecord(forged).ok, false);
  const forged2 = signRecord({ ...unsigned, pk: toHex(other.publicKey) }, other.secretKey); // consistent, different identity
  assert.equal(validateRecord(forged2).ok, true, 'a self-consistent record from another key is simply another account');
});

test('structural limits: kdf cost bounds, hex lengths, username rules', async () => {
  const { record, session } = await freshRecord();
  const { sig, ...u } = record;
  const resign = (patch) => validateRecord(signRecord({ ...u, ...patch }, session.secretKey));
  assert.equal(resign({ kdf: { ...u.kdf, N: 1 << 9 } }).ok, false, 'N too small');
  assert.equal(resign({ kdf: { ...u.kdf, N: 1 << 21 } }).ok, false, 'N too large (login DoS)');
  assert.equal(resign({ kdf: { ...u.kdf, N: 3000 } }).ok, false, 'N not power of two');
  assert.equal(resign({ kdf: { ...u.kdf, r: 16 } }).ok, false, 'r pinned');
  assert.equal(resign({ kdf: { ...u.kdf, salt: 'ab' } }).ok, false, 'salt length');
  assert.equal(resign({ box: { ...u.box, nonce: 'ab' } }).ok, false, 'nonce length');
  assert.equal(resign({ seq: 0 }).ok, false);
  assert.equal(validateRecord({ ...record, seq: 1.5 }).ok, false, 'rejected before any canonicalisation');
  assert.equal(resign({ user: 'Alice' }).ok, false, 'must be normalised');
  assert.equal(resign({ user: 'ab' }).ok, false, 'too short');
  assert.equal(resign({ user: 'a..b' }).ok, false);
  assert.equal(resign({ user: '-ab' }).ok, false);
  assert.equal(resign({ user: 'a.b-c_d9' }).ok, true);
  assert.equal(resign({ v: 2 }).ok, false);
  assert.equal(resign({ deleted: true, kdf: undefined, box: undefined }).ok, true, 'tombstone form');
});

test('username normalisation', () => {
  assert.equal(normalizeUsername('  Alice '), 'alice');
  assert.equal(normalizeUsername('ＡＬＩＣＥ'), 'alice'); // NFKC folds full-width
  assert.equal(isValidUsername('alice'), true);
  assert.equal(isValidUsername('a'.repeat(33)), false);
  assert.equal(isValidUsername('a'.repeat(32)), true);
  assert.equal(fingerprint('0123456789abcdef' + 'f'.repeat(48)), '0123-4567-89ab-cdef');
});
