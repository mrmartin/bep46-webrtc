// Transport over a WebTorrent "channel swarm".
//
// The directory channel is a swarm whose info-hash is sha1 of a fixed string.
// There is no torrent behind it — nobody seeds anything and metadata never
// arrives. It exists purely so the tracker introduces every peer running this
// app to every other one (WebRTC in browsers, TCP in Node), exactly like the
// sha1(publicKey) channel swarms of the BEP-46 project. Over each peer wire we
// run a BitTorrent extension (BEP 10) named `p2pacct` that carries the
// Replica's JSON messages as raw UTF-8.

import { Emitter, encodeMessage, decodeMessage, LIMITS } from './replica.js';
import { sha1Hex } from './sha1.js';
import { utf8, fromUtf8 } from './bytes.js';

export const EXT_NAME = 'p2pacct';
export const DIRECTORY_CHANNEL_NAME = 'p2p-accounts/directory/v1';
export const DIRECTORY_CHANNEL = sha1Hex(utf8(DIRECTORY_CHANNEL_NAME));

export const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
];

export class WebTorrentTransport {
  /**
   * @param {{ client: any, infoHash?: string, announce: string[], log?: Function }} opts
   *   client   – a WebTorrent instance (browser bundle or `import WebTorrent from 'webtorrent'`)
   *   announce – tracker URLs (wss:// in browsers; http:// or ws:// also work in Node)
   */
  constructor({ client, infoHash = DIRECTORY_CHANNEL, announce = DEFAULT_TRACKERS, log = () => {} }) {
    this.client = client;
    this.infoHash = infoHash;
    this.announce = announce;
    this.log = log;
    this.emitter = new Emitter();
    this.torrent = null;
    this.peers = new Set(); // extension instances whose peer speaks our protocol
    this.status = { trackers: {}, bytesIn: 0, bytesOut: 0, badMessages: 0 };
  }

  on(ev, fn) { return this.emitter.on(ev, fn); }

  start() {
    if (this.torrent) return;
    const transport = this;

    class P2PAcct {
      constructor(wire) {
        this.wire = wire;
        this.ready = false;
        wire.once('close', () => transport._drop(this));
      }
      onHandshake() {}
      onExtendedHandshake(hs) {
        // Only called when the peer advertised EXT_NAME in its handshake.
        if (this.ready) return;
        this.ready = true;
        transport.peers.add(this);
        transport.emitter.emit('peerchange', transport.peerCount());
        transport.emitter.emit('peer', { send: (m) => this.send(m) });
      }
      onMessage(buf) {
        let text = fromUtf8(buf);
        // Defensive: tolerate a bencoded-bytestring prefix from other senders.
        if (text.charCodeAt(0) >= 48 && text.charCodeAt(0) <= 57) text = text.replace(/^\d+:/, '');
        const msg = decodeMessage(text);
        transport.status.bytesIn += buf.length;
        if (!msg) { transport.status.badMessages++; return; }
        transport.emitter.emit('message', msg, { send: (m) => this.send(m) });
      }
      send(msg) {
        if (!this.ready || this.wire.destroyed) return;
        const bytes = utf8(encodeMessage(msg));
        if (bytes.length > LIMITS.maxMessageBytes) return;
        transport.status.bytesOut += bytes.length;
        try { this.wire.extended(EXT_NAME, bytes); } catch { /* wire closing */ }
      }
    }
    P2PAcct.prototype.name = EXT_NAME;

    this.torrent = this.client.add(this.infoHash, {
      announce: this.announce,
      skipVerify: true,
    });
    this.torrent.on('wire', (wire) => {
      wire.use(P2PAcct);
    });
    this.torrent.on('warning', (e) => {
      this.log('warning', e?.message || String(e));
      const m = /tracker.*?(wss?:\/\/\S+|https?:\/\/\S+)/i.exec(e?.message || '');
      if (m) this.status.trackers[m[1]] = 'error';
    });
    this.torrent.on('error', (e) => this.log('error', e?.message || String(e)));
    this.torrent.on('trackerAnnounce', () => { this.emitter.emit('tracker'); });

    // Per-tracker state, when the tracker client exposes it.
    const poll = () => {
      const tc = this.torrent?.discovery?.tracker;
      if (tc?._trackers) {
        for (const t of tc._trackers) {
          const url = t.announceUrl;
          const sock = t.socket;
          this.status.trackers[url] = sock ? (sock.connected ? 'connected' : 'connecting') : (t.destroyed ? 'closed' : 'pending');
        }
      }
    };
    this._poll = setInterval(poll, 2000);
    if (this._poll.unref) this._poll.unref();
  }

  stop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    if (this.torrent) {
      const t = this.torrent;
      this.torrent = null;
      try { t.destroy(); } catch { /* already gone */ }
    }
    this.peers.clear();
  }

  _drop(ext) {
    if (this.peers.delete(ext)) this.emitter.emit('peerchange', this.peerCount());
  }

  broadcast(msg) {
    for (const p of this.peers) p.send(msg);
  }

  peerCount() {
    return this.peers.size;
  }
}
