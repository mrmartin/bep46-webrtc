// In-process simulated swarm for tests. Every transport joined to the same
// MemorySwarm is "connected" to every other one (a full mesh, like a small
// WebTorrent channel swarm). Messages are serialised through the same JSON
// framing as the real wire, delivered asynchronously through a queue, and the
// swarm can be partitioned and healed to test convergence.

import { Emitter, encodeMessage, decodeMessage } from './replica.js';

export class MemorySwarm {
  constructor() {
    this.members = new Set();
    this.groups = null; // null = fully connected; otherwise Map<transport, groupId>
    this.queue = [];
    this.delivered = 0;
    this.dropped = 0;
  }

  _canTalk(a, b) {
    if (a === b) return false;
    if (!a.started || !b.started) return false;
    if (!this.groups) return true;
    return this.groups.get(a) === this.groups.get(b);
  }

  _enqueue(from, to, text) {
    this.queue.push({ from, to, text });
  }

  /** Deliver everything in flight, including messages generated while delivering. */
  async settle(maxRounds = 10000) {
    let rounds = 0;
    while (this.queue.length && rounds++ < maxRounds) {
      const { from, to, text } = this.queue.shift();
      await Promise.resolve();
      if (!this._canTalk(from, to)) { this.dropped++; continue; }
      const msg = decodeMessage(text);
      if (!msg) { this.dropped++; continue; }
      this.delivered++;
      to.emitter.emit('message', msg, { send: (m) => this._enqueue(to, from, encodeMessage(m)) });
    }
    if (rounds >= maxRounds) throw new Error('swarm did not settle');
  }

  /** Split into groups; peers in different groups cannot hear each other. */
  partition(...groups) {
    this.groups = new Map();
    groups.forEach((g, i) => g.forEach((t) => this.groups.set(t, i)));
    for (const t of this.members) if (!this.groups.has(t)) this.groups.set(t, -1 - Math.random());
  }

  /** Reconnect everyone; every pair re-runs the connect handshake, like a real reconnection. */
  heal() {
    const before = this.groups;
    this.groups = null;
    if (!before) return;
    const ms = [...this.members].filter((t) => t.started);
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        if (before.get(ms[i]) !== before.get(ms[j])) this._connect(ms[i], ms[j]);
      }
    }
  }

  _connect(a, b) {
    a.emitter.emit('peer', { send: (m) => this._enqueue(a, b, encodeMessage(m)) });
    b.emitter.emit('peer', { send: (m) => this._enqueue(b, a, encodeMessage(m)) });
  }

  join(name = `peer${this.members.size + 1}`) {
    const t = new MemoryTransport(this, name);
    this.members.add(t);
    return t;
  }
}

export class MemoryTransport {
  constructor(swarm, name) {
    this.swarm = swarm;
    this.name = name;
    this.emitter = new Emitter();
    this.started = false;
  }

  on(ev, fn) { return this.emitter.on(ev, fn); }

  start() {
    if (this.started) return;
    this.started = true;
    for (const other of this.swarm.members) {
      if (this.swarm._canTalk(this, other)) this.swarm._connect(this, other);
    }
  }

  stop() { this.started = false; }

  broadcast(msg) {
    const text = encodeMessage(msg);
    for (const other of this.swarm.members) {
      if (this.swarm._canTalk(this, other)) this.swarm._enqueue(this, other, text);
    }
  }

  peerCount() {
    let n = 0;
    for (const other of this.swarm.members) if (this.swarm._canTalk(this, other)) n++;
    return n;
  }
}
