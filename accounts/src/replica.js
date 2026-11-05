// A Replica = a Directory + a transport + the gossip protocol between them.
// It is transport-agnostic: the memory swarm (tests) and the WebTorrent
// channel swarm (browser / Node) both satisfy the same tiny interface:
//
//   transport.start() / stop()
//   transport.broadcast(msg)                       // msg is a plain object
//   transport.on('peer',    ({ send }) => …)        // a new peer is ready to talk
//   transport.on('message', (msg, { send }) => …)   // msg already JSON-parsed
//   transport.peerCount()
//
// Wire messages:
//   { t:'sync',    records }   full state, sent to every new peer (both directions)
//   { t:'update',  record  }   one newly accepted record, fanned out immediately
//   { t:'digest',  items   }   [[pk,seq],…] heartbeat for anti-entropy
//   { t:'want',    pks     }   please send me these
//   { t:'records', records }   reply to want / digest
//
// Every inbound record goes through Directory.ingest, i.e. signature +
// structure validation and the monotonic-seq rule; a peer cannot make us
// store anything an account owner did not sign, nor roll an account back.

export const LIMITS = Object.freeze({
  maxMessageBytes: 2 * 1024 * 1024,
  maxRecordsPerMessage: 5000,
  maxDigestItems: 20000,
});

export class Replica {
  constructor({ directory, transport, heartbeatMs = 15000, log = () => {}, keyField = 'pk' }) {
    this.directory = directory;
    this.transport = transport;
    // Which record field the directory is keyed by: 'pk' for the accounts
    // Directory, 'id' for a catwalk-style Ledger. Digests are [[key, seq], …].
    this.keyField = keyField;
    this.heartbeatMs = heartbeatMs;
    this.log = log;
    this._timer = null;
    this._unsub = [];
    this._fanout = (record, { local }) => {
      // Re-gossip anything newly accepted, whether it came from the user or a peer.
      this.transport.broadcast({ t: 'update', record });
      this.log(local ? 'published' : 'relayed', record.user ?? record.id, 'seq', record.seq);
    };
  }

  start() {
    this._unsub.push(this.directory.onChange(this._fanout));
    this._unsub.push(this.transport.on('peer', ({ send }) => {
      send({ t: 'sync', records: this.directory.all() });
    }));
    this._unsub.push(this.transport.on('message', (msg, { send }) => this.handle(msg, send)));
    this.transport.start();
    if (this.heartbeatMs > 0) {
      this._timer = setInterval(() => {
        if (this.transport.peerCount() > 0) this.transport.broadcast({ t: 'digest', items: this.directory.digest() });
      }, this.heartbeatMs);
      if (this._timer.unref) this._timer.unref();
    }
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const u of this._unsub) u();
    this._unsub = [];
    this.transport.stop();
  }

  handle(msg, send) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'sync':
      case 'records': {
        if (!Array.isArray(msg.records) || msg.records.length > LIMITS.maxRecordsPerMessage) return;
        const n = this.directory.ingestAll(msg.records);
        if (msg.t === 'sync') {
          // Tell them what we have that they lack. Their sync already told us what they hold.
          const k = this.keyField;
          const theirs = new Map(msg.records.filter((r) => r && typeof r[k] === 'string').map((r) => [r[k], r.seq]));
          const newer = this.directory.all().filter((r) => (theirs.get(r[k]) ?? 0) < r.seq);
          if (newer.length) send({ t: 'records', records: newer });
        }
        if (n) this.log('merged', n, 'record(s) from peer');
        break;
      }
      case 'update': {
        this.directory.ingest(msg.record); // fan-out happens via onChange if accepted
        break;
      }
      case 'digest': {
        if (!Array.isArray(msg.items) || msg.items.length > LIMITS.maxDigestItems) return;
        const items = msg.items.filter((it) => Array.isArray(it) && typeof it[0] === 'string');
        const want = this.directory.wantFrom(items);
        if (want.length) send({ t: 'want', pks: want });
        const newer = this.directory.newerThan(items);
        if (newer.length) send({ t: 'records', records: newer });
        break;
      }
      case 'want': {
        if (!Array.isArray(msg.pks)) return;
        const records = msg.pks.slice(0, LIMITS.maxRecordsPerMessage)
          .map((pk) => this.directory.get(pk)).filter(Boolean);
        if (records.length) send({ t: 'records', records });
        break;
      }
      default:
        // Unknown message types are ignored, which leaves room for later versions.
    }
  }
}

// Shared JSON framing with a size guard (used by every transport).
export function encodeMessage(msg) {
  return JSON.stringify(msg);
}

export function decodeMessage(text) {
  if (typeof text !== 'string' || text.length > LIMITS.maxMessageBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Tiny event emitter for transports.
export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    for (const fn of this._h.get(ev) || []) {
      try { fn(...args); } catch (e) { /* a handler must not break the transport */ }
    }
  }
}
