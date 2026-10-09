// The replicated social ledger: a map  id → latest valid record  with the
// same convergent merge rule as the accounts Directory (per id, higher seq
// wins; same seq → smaller sig; tombstones are kept), but for catwalk's
// social records, of which an owner has many. Plugged into the shared
// Replica with keyField:'id', so the gossip protocol is identical.

import { validateSocial, ownerOf } from './social.js';
import { canonicalize } from '../../accounts/src/canonical.js';

export class Ledger {
  constructor({ store = null, validate = validateSocial } = {}) {
    this.records = new Map();
    this.store = store;
    this.validate = validate;
    this.listeners = new Set();
    this.stats = { accepted: 0, rejected: 0, stale: 0 };
    if (store) {
      let loaded = [];
      try { loaded = store.load() || []; } catch { loaded = []; }
      for (const r of loaded) this.ingest(r, { persist: false, local: false });
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  ingest(record, { persist = true, local = false } = {}) {
    const v = this.validate(record);
    if (!v.ok) { this.stats.rejected++; return { accepted: false, reason: v.reason }; }
    const cur = this.records.get(record.id);
    if (cur) {
      if (record.seq < cur.seq) { this.stats.stale++; return { accepted: false, reason: 'stale' }; }
      if (record.seq === cur.seq && (record.sig === cur.sig || !(record.sig < cur.sig))) { this.stats.stale++; return { accepted: false, reason: 'stale' }; }
    }
    const frozen = Object.freeze(JSON.parse(canonicalize(record)));
    this.records.set(record.id, frozen);
    this.stats.accepted++;
    if (persist && this.store) { try { this.store.save(this.all()); } catch { /* best effort */ } }
    for (const fn of this.listeners) { try { fn(frozen, { local, previous: cur || null }); } catch { /* never breaks merge */ } }
    return { accepted: true };
  }

  ingestAll(records, opts) {
    let n = 0;
    if (!Array.isArray(records)) return 0;
    for (const r of records) if (this.ingest(r, opts).accepted) n++;
    return n;
  }

  get(id) { return this.records.get(id) || null; }
  all() { return [...this.records.values()]; }
  live() { return this.all().filter((r) => !r.deleted); }
  ofKind(kind) { return this.live().filter((r) => r.kind === kind); }
  byOwner(owner, kind = null) { return this.live().filter((r) => r.owner === owner && (!kind || r.kind === kind)); }
  nextSeq(id) { return (this.records.get(id)?.seq ?? 0) + 1; }

  digest() { return this.all().map((r) => [r.id, r.seq]); }
  newerThan(digest) {
    const have = new Map(digest.map(([id, seq]) => [id, seq]));
    return this.all().filter((r) => (have.get(r.id) ?? 0) < r.seq);
  }
  wantFrom(digest) {
    return digest
      .filter(([id, seq]) => Number.isSafeInteger(seq) && typeof id === 'string' && (this.records.get(id)?.seq ?? 0) < seq)
      .map(([id]) => id);
  }
}

export { ownerOf };
export { memoryStore, webStorageStore } from '../../accounts/src/directory.js';
