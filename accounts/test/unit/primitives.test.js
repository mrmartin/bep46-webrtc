import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes as nodeRandom, scryptSync } from 'node:crypto';
import scryptPkg from 'scrypt-js';
const scryptJs = scryptPkg.scrypt;

import { sha1Hex } from '../../src/sha1.js';
import { canonicalize } from '../../src/canonical.js';
import { toHex, fromHex, utf8 } from '../../src/bytes.js';
import { deriveKey, secretbox, ed25519 } from '../../src/crypto.js';
import { DIRECTORY_CHANNEL, DIRECTORY_CHANNEL_NAME } from '../../src/transport-webtorrent.js';
import '../helpers.js';

test('pure-JS SHA-1 matches node:crypto across sizes incl. padding boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
    const bytes = new Uint8Array(nodeRandom(n));
    assert.equal(sha1Hex(bytes), createHash('sha1').update(bytes).digest('hex'), `length ${n}`);
  }
  assert.equal(sha1Hex(utf8('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('directory channel info-hash is a fixed, correct SHA-1', () => {
  assert.equal(DIRECTORY_CHANNEL, createHash('sha1').update(DIRECTORY_CHANNEL_NAME).digest('hex'));
  assert.match(DIRECTORY_CHANNEL, /^[0-9a-f]{40}$/);
});

test('canonicalize is order-independent and strict', () => {
  const a = canonicalize({ b: 1, a: { d: [1, 2, { z: 'x', y: true }], c: null } });
  const b = canonicalize({ a: { c: null, d: [1, 2, { y: true, z: 'x' }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":null,"d":[1,2,{"y":true,"z":"x"}]},"b":1}');
  assert.equal(canonicalize({ a: undefined, b: 2 }), '{"b":2}');
  assert.throws(() => canonicalize({ a: 1.5 }));
  assert.throws(() => canonicalize({ a: NaN }));
  assert.throws(() => canonicalize({ a: () => 1 }));
  assert.equal(canonicalize('é"\n'), JSON.stringify('é"\n'));
});

test('hex round-trips and rejects junk', () => {
  const b = new Uint8Array(nodeRandom(33));
  assert.deepEqual(fromHex(toHex(b)), b);
  assert.throws(() => fromHex('abc'));
  assert.throws(() => fromHex('zz'));
  assert.throws(() => fromHex('AB')); // lowercase only, by design
});

test('scrypt: node:crypto and scrypt-js (the browser implementation) agree', async () => {
  const params = { name: 'scrypt', N: 1 << 10, r: 8, p: 1, salt: toHex(new Uint8Array(nodeRandom(16))) };
  const pw = 'correct horse battery staple ✓';
  const viaNode = await deriveKey(pw, params);
  const viaJs = await scryptJs(utf8(pw.normalize('NFKC')), fromHex(params.salt), params.N, params.r, params.p, 32);
  const viaSync = scryptSync(utf8(pw.normalize('NFKC')), fromHex(params.salt), 32, { N: params.N, r: 8, p: 1 });
  assert.equal(toHex(viaNode), toHex(new Uint8Array(viaJs)));
  assert.equal(toHex(viaNode), viaSync.toString('hex'));
});

test('secretbox sealed in one environment opens in the other; wrong key fails', async () => {
  const kp = ed25519.keyPair();
  const params = { name: 'scrypt', N: 1 << 10, r: 8, p: 1, salt: toHex(new Uint8Array(nodeRandom(16))) };
  const key = await deriveKey('hunter2hunter2', params);
  const nonce = new Uint8Array(nodeRandom(24));
  const ct = secretbox.seal(kp.secretKey, nonce, key);
  assert.equal(ct.length, 64 + 16);
  assert.deepEqual(secretbox.open(ct, nonce, key), kp.secretKey);
  const wrong = await deriveKey('hunter2hunter3', params);
  assert.equal(secretbox.open(ct, nonce, wrong), null);
});
