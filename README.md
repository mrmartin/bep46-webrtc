# bep46-webrtc

Updatable torrents, in a single HTML file.

BitTorrent is permanent by design: a torrent is identified by the hash of its
own contents, so changing one byte makes a different torrent with a different
address. That is great for integrity and useless for anything that evolves — a
newspaper, a feed, a website. This project gives a torrent a **stable address
that can be re-pointed at new content**, signed so only the owner can do it,
and runs the whole thing client-side in the browser over WebRTC. No server, no
build step, no install — open the file and go.

## Background

The BitTorrent protocol has an extension for exactly this problem,
[BEP 46 — *Updating Torrents Via DHT Mutable Items*](https://bittorrent.org/beps/bep_0046.html).
The idea: instead of sharing the infohash of a torrent, you share an **ed25519
public key**. The owner signs a small record that says "the current version is
infohash X", publishes it to the BitTorrent DHT under `sha1(publicKey)`, and
anyone holding the public key polls that location for updates. Because the DHT
validates the signature, only the keyholder can ever change what the address
points to. BEP 46 builds on [BEP 44](https://bittorrent.org/beps/bep_0044.html)
(signed mutable items in the DHT) and is a more decentralized cousin of
[BEP 39](https://bittorrent.org/beps/bep_0039.html) (feed updates over HTTP).

BEP 46 has reference implementations — `lmatteis/dmt` (the author's original)
and `RangerMauve/mutable-webtorrent` — but they are all **Node.js**, because
they depend on the UDP-based mainline DHT. A browser cannot open a UDP socket,
so a browser tab cannot join the mainline DHT, so spec-literal BEP 46 is
impossible from a web page. WebTorrent's own extension-support table lists both
BEP 44 and BEP 46 as unimplemented for this reason.

This project keeps the **semantics** of BEP 46 — signed, owner-only,
sequence-numbered updates — and swaps out the one piece a browser cannot have.
The mainline DHT is replaced by a **WebRTC rendezvous swarm**. The cost is
honest and stated up front: this does **not** interoperate with mainline
BitTorrent or DHT-based BEP 46 clients. It is a self-contained mutable-torrent
network among peers running this page.

## Quick start

Open `bep46-webrtc.html` in a browser. To see the full loop, use two tabs (or
two devices):

1. **Tab A** — Generate keypair → choose a file → Create torrent → Publish new version.
2. **Tab B** — paste Tab A's `bep46:` address → Follow. The file appears with a download link.
3. Back in **Tab A**, choose a *different* file → Create torrent → Publish. Tab B updates to `v2` on its own.

Keep the publishing tab open: it is the seed for the content.

## How it works — the gruesome detail

The page has two moving parts: **content distribution** (ordinary WebTorrent)
and the **mutable pointer layer** (the BEP 46 reconstruction). They are
deliberately decoupled.

### Identity

An ed25519 keypair (via TweetNaCl, `nacl.sign.keyPair()`). The 32-byte public
key, hex-encoded, *is* the mutable address — shareable as `bep46:<64-hex>`. The
secret key is the sole capability to publish; the page never persists it.

### The channel = `sha1(publicKey)`

Every peer interested in an address joins a **WebTorrent swarm whose infohash
is `sha1(publicKey)`**. This is not an accident — it is the exact target ID
that BEP 46 uses to locate a record in the DHT. We use the same derivation, but
as a swarm rendezvous point instead of a DHT key. Peers announcing the same
40-hex value to the trackers get matched and WebRTC-connected to each other.

The channel "torrent" has no content and no metadata. Nobody seeds it; it never
completes. It exists purely so that WebTorrent's tracker + WebRTC machinery
introduces interested peers to one another. We only want the peer wires.

### The pointer record

The thing that travels is a signed JSON record:

```json
{
  "k":   "<64-hex ed25519 public key>",
  "seq": 3,
  "ih":  "<40-hex content infohash>",
  "sig": "<128-hex detached ed25519 signature>"
}
```

`ih` mirrors BEP 46's `v.ih` field. The signature covers a deterministic
28-byte message — **8-byte big-endian `seq` concatenated with the 20-byte raw
infohash** — so a record cannot be replayed at a different sequence number or
have its target swapped without invalidating `sig`.

### Gossip over a wire-protocol extension

Each peer connection in the channel swarm gets a custom BitTorrent wire
extension named `bep46`. It does three things:

- **On extended handshake** — push our current best record to the new peer, so
  a peer that joins after a publish is brought up to date immediately.
- **On message** — parse an incoming record and hand it to `_ingest`.
- **`send`** — serialize a record and transmit it over the wire.

`_ingest` is the gatekeeper. It (1) checks the record's `k` matches this
channel, (2) verifies the ed25519 signature, (3) **rejects any record whose
`seq` is not strictly greater than the best one already held** — this is the
rollback protection BEP 44 mandates — and only then adopts it, re-broadcasts it
to its own peers (gossip propagation), and fires the update callback.

### The heartbeat

A peer that connects *between* publishes would miss the one-shot broadcast. So
the owner's channel **re-broadcasts its current best record every 3 seconds**.
This is idempotent: `_ingest` silently drops anything that is not strictly
newer, so re-broadcasts cost a signature verification and nothing else. BEP 44
explicitly expects this — mutable items must be periodically re-put to stay
alive. Publish-then-follow and follow-then-publish both converge within one
heartbeat.

### Content delivery

When a follower adopts a record, it calls `client.add(ih)` on the **content**
infohash. That is plain WebTorrent: tracker discovery, WebRTC data channels,
piece exchange, the publisher seeding. When a *newer* record arrives, the old
content torrent is removed and the new one added; the file list re-renders.
Because BitTorrent is content-addressed, an unchanged file yields an unchanged
infohash — publishing genuinely new content requires genuinely different bytes,
and the UI enforces this rather than minting an empty new version.

### Two implementation notes worth knowing

- **Payload encoding.** `wire.extended(name, data)` transmits `data` verbatim
  only when it is a `Buffer`; anything else is bencoded. A `Uint8Array` is not
  a `Buffer`, so it gets wrapped as a bencoded byte string `<len>:<json>`. The
  extension therefore sends a plain string and strips the `^\d+:` bencode
  prefix on receipt before `JSON.parse`. A real record is JSON beginning with
  `{`, never a digit, so the strip is unambiguous.
- **SHA-1.** The channel derivation uses a small bundled SHA-1 rather than
  `crypto.subtle`, so the page works when opened directly from `file://`
  without a secure context.

### Dependencies

[WebTorrent](https://webtorrent.io) for WebRTC transport and
[TweetNaCl](https://tweetnacl.js.org) for ed25519. Both loaded from a CDN. No
build, no bundler, no backend.

## Known limitations

- **Not mainline-interoperable.** By construction — see Background.
- **WebSocket trackers are scarce.** Browser WebTorrent needs `wss://`
  trackers for WebRTC signaling, and the public pool has thinned to almost
  nothing. For real deployment, run your own (e.g. Novage's `wt-tracker`) and
  point the `TRACKERS` array at it.
- **No offline persistence.** The pointer lives only in connected peers'
  memory; if every peer holding the latest record goes offline, a new follower
  has nothing to sync from until one returns. The mainline DHT provides exactly
  this durability — replacing it is the obvious next milestone.
- **The owner must seed.** Standard BitTorrent: someone has to hold the
  content. Closing the publishing tab stops the seed.

## End goal: peer-to-peer webhosting

A website is a directory of files. A directory of files is a torrent. The only
thing standing between "torrent" and "website" has always been that a website
*changes* and a torrent cannot — which is precisely the gap a mutable address
closes.

The destination for this project is a browser that treats a `bep46:` address
as a URL: resolve the public key to its current content torrent, fetch
`index.html` and its assets over WebRTC, render the page — and silently reload
when the owner publishes a new version. Publishing a site update becomes
signing a 28-byte message. There is no origin server to seize, rate-limit, or
bill; hosting cost is whoever keeps a tab open, and any visitor can mirror by
simply continuing to seed. The publisher keeps a private key; everyone else
keeps a public one. That is the entire trust model.

This is the same ambition the Dat protocol and the Beaker browser pursued, but
built on BitTorrent — a far larger, older, and more battle-tested swarm — and
reachable from an unmodified web browser today. This single HTML file is the
smallest working core of that idea: signed, updatable, serverless content,
addressed by a key instead of a location.

## License

MIT.
