# p2p-accounts — user accounts on a serverless web

A user database with create account / sign in / change password / delete account, and **no server**. The "database" is a set of signed records that every open copy of the page holds, verifies, and passes on to every other copy. Peers find each other through a WebTorrent tracker and talk over WebRTC — the same channel-swarm mechanism as the [BEP-46 page publisher](../README.md) one directory up, now carrying account records instead of content pointers.

Everything below has a test behind it: `npm run test:all` runs 28 tests in three layers — pure logic, real BitTorrent wires through a real tracker, and two isolated Chromium browsers driving the actual page over WebRTC.

## Example apps

Applications built on this layer. Each one is a static page: no backend, no database server, no API — the accounts live in whoever has the page open.

| App | What it shows | Where |
|---|---|---|
| **Swarm Registry** | The reference app. Register, sign in, change password and delete an account, and watch the directory fill in live from other peers. Shows every account's key fingerprint, flags names claimed by more than one key, keeps a visible list of tombstones, and has an activity log of the gossip underneath. Works with the public trackers out of the box or with your own (header → Trackers). | **live: <https://mrmartin.net/bep46-webrtc/accounts/>** · `web/` — run with `npm start`, or `npm run build` for a single-file `dist/index.html` you can publish into a swarm |

![Swarm Registry — two browsers on one swarm, one signed in as bob.builder, three accounts replicated](docs/swarm-registry.png)

To build your own: import `Directory`, `Accounts`, `Replica` and `WebTorrentTransport` from `src/`, wire them as `web/app.js` does (about 40 lines), and give the page a tracker. Everything else — key sealing, signatures, replication, persistence — is the layer's job, not the app's.

## Quick start

```bash
npm install
npm run tracker &          # local ws://127.0.0.1:8000 tracker (dev only)
npm start                  # serves http://127.0.0.1:8080/web/
```

Open `http://127.0.0.1:8080/web/?tracker=ws://127.0.0.1:8000` in two browser windows (two *profiles* or one normal + one private window, so they have separate storage). Register in one; the other lists the account within a second or two. Sign in there, change the password, go back to the first window: the old password no longer works.

Against the public internet, drop the `?tracker=` parameter and the page uses the default `wss://` trackers listed in `src/transport-webtorrent.js` (the project's own `wss://bot.martintech.co.uk` first, then the public ones) — or open **Trackers** in the page header and enter your own.

## What "account" means here

There is no trusted party, so an account cannot be "a row the server believes". It is:

- **an ed25519 keypair** — the public key *is* the identity; the username is a label indexed over it;
- **the secret key, sealed under the password** — `secretbox(secretKey, key = scrypt(password, salt))`;
- **a signed record** carrying both, replicated to everyone.

That gives the four operations without a server:

| Operation | What actually happens |
|---|---|
| Register | Generate keypair. Derive a key from the password with scrypt. Seal the secret key. Sign the record (seq 1) with the secret key. Publish. |
| Sign in | Fetch the record(s) for the username from the local replica. Derive the key from the typed password. Try to open the box. A wrong password simply fails to decrypt — the password never leaves the device, and nothing is sent to anyone. |
| Change password | Re-seal the *same* secret key under a new salt + new password. Sign a new record with `seq + 1`. Publish. The identity does not change; peers replace the old record. |
| Delete | Sign a **tombstone** (`deleted: true`, no key material) with `seq + 1`. Publish. Peers keep the tombstone forever, so an old live record can never be replayed to resurrect the account. The username becomes free for a new key. |

### The record

```json
{
  "v": 1,
  "user": "alice",
  "pk":  "<64 hex — ed25519 public key>",
  "seq": 3,
  "ts":  1696680000000,
  "deleted": false,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<32 hex>" },
  "box": { "nonce": "<48 hex>", "ct": "<160 hex>" },
  "sig": "<128 hex — ed25519 over 'p2p-accounts/record/v1\\n' + canonical JSON of the rest>"
}
```

Canonical JSON is sorted-keys, no whitespace, integers only (a JCS subset, `src/canonical.js`). `validateRecord` (`src/records.js`) is deliberately strict — unknown fields, wrong hex lengths, non-power-of-two scrypt `N`, `N` outside `2^10..2^20` (so a hostile record cannot make your login take minutes), and tombstones that still carry key material are all rejected before the signature is even checked.

### The directory (the database)

`src/directory.js` is a map `pk → latest valid record` with a merge rule that makes it a state-based CRDT: any two peers that have seen the same records hold identical state, whatever the arrival order.

- accept only if the signature verifies under the record's own `pk`;
- for one `pk`, higher `seq` wins; equal `seq` with different content → lexicographically smaller `sig` wins (owners should never fork, but convergence must not depend on it);
- tombstones are kept.

Usernames are an **index**, not the key. Nothing in a serverless system can stop two keys claiming `alice`; the directory therefore exposes all live *claimants* and a deterministic display *owner* (oldest `ts`, then smallest `pk`) so all peers at least render the same thing. Sign-in tries every claimant and only the box sealed under *your* password opens — a squatter can clutter the list but cannot log in as you or lock you out. Registration refuses a name that has any live claimant in the local replica.

Each browser persists its replica in `localStorage`, so a reloaded tab comes back with the whole directory and re-seeds it to newcomers. Every visitor is a replica; durability is "someone who has seen it comes back online".

### The gossip

`src/replica.js` runs over any transport with `broadcast`, `peer`, `message`:

| Message | When |
|---|---|
| `sync {records}` | to every new peer, both directions; the receiver replies with anything it has that is newer |
| `update {record}` | fan-out of every newly accepted record (user-made or relayed) |
| `digest [[pk,seq]…]` | 15 s heartbeat; peers answer with `want`/`records` to repair anything missed |

Every inbound record goes through `Directory.ingest`, so a peer can send garbage, forgeries, replays or future-claiming digests and the worst it achieves is a counter in `directory.stats.rejected`.

`src/transport-webtorrent.js` carries those messages as a BEP-10 extension (`p2pacct`) over the wires of a channel swarm whose info-hash is `sha1("p2p-accounts/directory/v1")`. No torrent exists behind that hash — it is purely a rendezvous, exactly like `sha1(publicKey)` in the BEP-46 project. `src/transport-memory.js` is the in-process equivalent used by the tests, with `partition()` / `heal()`.

## Tests

```bash
npm test               # 26 unit + simulated-swarm tests (~9 s)
npm run test:swarm     # real bittorrent-tracker + 3 Node WebTorrent clients over TCP (~3 s)
npm run test:browser   # 2 Chromium contexts, local ws tracker, WebRTC, the real page (~17 s)
npm run test:all
```

What the layers cover:

- **primitives** — pure-JS SHA-1 vs `node:crypto`; canonicalisation; and that `scrypt-js` (browser) and `node:crypto` scrypt derive identical keys, so a box sealed in one environment opens in the other.
- **records** — every single-field tamper breaks the signature; a valid signature from the wrong key is rejected; KDF cost bounds; username rules.
- **accounts** — the four operations; wrong-password and unknown-user errors are byte-identical (no enumeration); persistence round-trip through a store, including a corrupted entry; two claimants of one name; same-seq owner forks converge.
- **replication** — register on A / sign in on C; late joiner gets the full directory; four-peer partition with writes on both sides merging on heal; a hostile peer sending forged, tampered, replayed and squatted records; the digest heartbeat repairing a missed update.
- **webtorrent** — the same lifecycle over genuine BitTorrent wires via a real tracker.
- **e2e** — through the UI in two browsers: register, cross-browser sign-in, wrong password, duplicate refused, password change seen on the other browser, deletion signing the other browser out, name reuse under a new key, reload-persistence, and a third fresh browser being brought up to date by one survivor.

The browser test needs a Chromium. It uses `$CHROMIUM_PATH` if set, else any Playwright-managed Chromium under `$PLAYWRIGHT_BROWSERS_PATH`, else run `npx playwright install chromium` once.

## Deploying

**Tracker.** Browsers need a `wss://` tracker. Public ones come and go; run your own — `bittorrent-tracker --ws --trust-proxy` or Novage's `wt-tracker` behind nginx/Caddy with TLS, WebSocket upgrade headers and a proxy read timeout above the 120 s re-announce interval. The page only ever sends the tracker an info-hash and a WebRTC offer; account data never touches it.

**The page.** `web/` is plain static files (ES modules + the three vendored libraries in `vendor/`; no CDN). Any static host works. `npm run build` produces `dist/index.html`, a single self-contained file that makes zero external requests, suitable for publishing *as a torrent* through the BEP-46 publisher — at which point the site and its user database both live in the swarm.

**Defaults to change for production:** the tracker list in `src/transport-webtorrent.js` (`DEFAULT_TRACKERS`), the scrypt cost (`DEFAULT_KDF`, currently `N = 2^15`; raise to `2^17` if you accept ~5 s sign-in in pure-JS browsers), and remove or keep the `?kdf=` query override, which the page already only honours on `localhost`.

## What this does not protect against — read before relying on it

- **Offline password guessing.** The sealed secret key is public by construction, so anyone can run scrypt against it as fast as their hardware allows. scrypt at `N = 2^15` (32 MiB per guess) makes that expensive, not impossible. A short or common password is a compromised account; the UI enforces only an 8-character minimum. This is the inherent price of having no server to rate-limit; it is the same model as a password-protected key file published in the open.
- **Username squatting.** Anyone can publish a record claiming your name with a back-dated `ts` and win the *display* slot. They cannot log in as you, and your sign-in still works, but a newcomer looking at the list sees two `alice` rows and the fingerprint is the only way to tell them apart. Real uniqueness needs a consensus layer or a naming authority, which this deliberately lacks.
- **Durability.** If every peer that holds a record goes away, the record is gone. Browsers also evict `localStorage`. For a serious deployment, keep one always-on headless replica (the Node transport works unchanged: see `test/swarm/webtorrent.test.js`) — it is a *mirror*, not an authority; it cannot forge or roll back anything.
- **Deletion is a tombstone, not erasure.** The tombstone propagates, but a copy of the old record (username, key, sealed secret) may survive on a peer that never comes back to hear about it. What protects it is the password-derived key — another reason the scrypt cost matters.
- **Public metadata.** Usernames, public keys, registration times and the number of password changes are visible to every peer. There is no private directory.
- **No account recovery.** Lose the password, lose the key, lose the account. Nobody can reset it because nobody holds anything that could.
- **Owner forks.** Change the password on two offline devices and reconcile later: exactly one wins, deterministically, and the other device's new password is silently void. The UI surfaces this as "updated from another device".
- **Denial of service.** A peer can flood the swarm with valid records under fresh keys (each costs them one signature). Limits exist per message (`src/replica.js` `LIMITS`) but there is no global quota; a real deployment would want proof-of-work or an invitation record on registration.

## Layout

```
src/
  bytes.js, sha1.js, canonical.js   encoding and hashing (env-agnostic)
  crypto.js                          injected nacl + scrypt; deriveKey; cost limits
  records.js                         record format, signing, strict validation
  directory.js                       the replicated map (CRDT merge) + stores
  accounts.js                        register / login / changePassword / deleteAccount
  replica.js                         gossip protocol, message framing, limits
  transport-memory.js                simulated swarm with partitions (tests)
  transport-webtorrent.js            BEP-10 extension over a WebTorrent channel swarm
  env-node.js, env-browser.js        wiring for each runtime
web/   index.html, app.css, app.js   the site
vendor/                              webtorrent.min.js, nacl-fast.min.js, scrypt.js (from npm, pinned in package.json)
tools/ serve.js, tracker.js, build.js, dev/screenshot.mjs, dev/check-dist.mjs
test/  unit/  swarm/  browser/
```

## License

MIT.
