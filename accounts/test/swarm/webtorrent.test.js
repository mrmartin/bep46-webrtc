// Real wire test: a local bittorrent-tracker, two Node WebTorrent clients on
// the directory channel (TCP peer connections, no WebRTC needed in Node), and
// the p2pacct extension carrying real messages. This exercises exactly the
// code path the browser uses, minus WebRTC.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'bittorrent-tracker';
import WebTorrent from 'webtorrent';

import { TEST_KDF, rejects } from '../helpers.js';
import { Directory, memoryStore } from '../../src/directory.js';
import { Accounts } from '../../src/accounts.js';
import { Replica } from '../../src/replica.js';
import { WebTorrentTransport, DIRECTORY_CHANNEL } from '../../src/transport-webtorrent.js';

let tracker, announce;
const clients = [];

function node(name) {
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, webSeeds: false });
  clients.push(client);
  const directory = new Directory({ store: memoryStore() });
  const transport = new WebTorrentTransport({ client, infoHash: DIRECTORY_CHANNEL, announce, log: () => {} });
  const replica = new Replica({ directory, transport, heartbeatMs: 2000 }).start();
  const accounts = new Accounts({ directory, kdf: TEST_KDF });
  return { name, client, directory, transport, replica, accounts };
}

async function waitFor(fn, { timeout = 15000, every = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  tracker = new Server({ udp: false, http: true, ws: true, stats: false, interval: 1000 });
  await new Promise((resolve, reject) => tracker.listen(0, '127.0.0.1', (e) => (e ? reject(e) : resolve())));
  const port = tracker.http.address().port;
  announce = [`http://127.0.0.1:${port}/announce`];
});

after(async () => {
  for (const c of clients) await new Promise((r) => c.destroy(() => r()));
  await new Promise((r) => tracker.close(() => r()));
});

test('two WebTorrent clients find each other via the tracker and replicate accounts over the wire', async () => {
  const A = node('A');
  const B = node('B');

  await waitFor(() => A.transport.peerCount() >= 1 && B.transport.peerCount() >= 1, { what: 'peer wires with p2pacct' });

  const sa = await A.accounts.register('wire-alice', 'alice-wire-password');
  await waitFor(() => B.directory.get(sa.pk), { what: 'record to reach B' });
  const sb = await B.accounts.login('wire-alice', 'alice-wire-password');
  assert.equal(sb.pk, sa.pk);

  await B.accounts.changePassword(sb, 'alice-wire-password', 'alice-wire-password-2');
  await waitFor(() => A.directory.get(sa.pk)?.seq === 2, { what: 'password change to reach A' });
  await rejects(A.accounts.login('wire-alice', 'alice-wire-password'), 'invalid_credentials');
  assert.ok(await A.accounts.login('wire-alice', 'alice-wire-password-2'));

  // Late joiner gets the whole directory on its first handshake.
  const C = node('C');
  await waitFor(() => C.directory.get(sa.pk)?.seq === 2, { what: 'late joiner sync' });
  assert.ok(await C.accounts.login('wire-alice', 'alice-wire-password-2'));

  const sc = await C.accounts.login('wire-alice', 'alice-wire-password-2');
  await C.accounts.deleteAccount(sc, 'alice-wire-password-2');
  await waitFor(() => A.directory.get(sa.pk)?.deleted && B.directory.get(sa.pk)?.deleted, { what: 'tombstone everywhere' });
  for (const n of [A, B, C]) await rejects(n.accounts.login('wire-alice', 'alice-wire-password-2'), 'invalid_credentials');

  assert.ok(A.transport.status.bytesIn > 0 && A.transport.status.bytesOut > 0);
  assert.equal(A.transport.status.badMessages, 0);
  for (const n of [A, B, C]) n.replica.stop();
});
