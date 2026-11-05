// The replicated user database.
//
// A Directory is a map  pk → latest valid record  with a convergent merge
// rule, so every peer that has seen the same set of records holds the same
// state regardless of arrival order (a state-based CRDT: LWW per key, where
// "later" is the owner-signed `seq`):
//
//   * a record is only ever accepted if its signature verifies under its own pk
//   * for one pk, higher seq wins; equal seq → lexicographically smaller sig
//     wins (an owner should never produce that, but convergence must not
//     depend on owners behaving)
//   * tombstones are kept forever so a deleted account cannot be rolled back
//     to a live state by replaying an old record
//
// Usernames are an index over this map, not the key. Several pks can claim
// the same name (nothing in a serverless system can prevent that); `lookup`
// returns every live claimant plus a deterministic "owner" (oldest ts, then
// smallest pk) so all peers at least agree on who to display. Login tries
// every claimant and only the box sealed under the user's password opens, so
// a squatter can confuse but cannot impersonate.

import { validateRecord } from './records.js';
import { canonicalize } from './canonical.js';

export class Directory {
  /**
   * @param {{ store?: { load(): object[], save(records: object[]): void } }} opts
   */
  constructor({ store = null } = {}) {
    this.records = new Map(); // pk -> record
    this.store = store;
    this.listeners = new Set();
    this.stats = { accepted: 0, rejected: 0, stale: 0 };
    if (store) {
      let loaded = [];
      try { loaded = store.load() || []; } catch { loaded = []; }
      for (const r of loaded) this.ingest(r, { persist: false, local: false });
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Merge one record. Returns { accepted, reason }.
   * accepted=false with reason 'stale' means we already hold something at
   * least as new — not an error, just nothing to do.
   */
  ingest(record, { persist = true, local = false } = {}) {
    const v = validateRecord(record);
    if (!v.ok) {
      this.stats.rejected++;
      return { accepted: false, reason: v.reason };
    }
    const cur = this.records.get(record.pk);
    if (cur) {
      if (record.seq < cur.seq) { this.stats.stale++; return { accepted: false, reason: 'stale' }; }
      if (record.seq === cur.seq) {
        if (record.sig === cur.sig) { this.stats.stale++; return { accepted: false, reason: 'stale' }; }
        // Fork by the owner at the same seq: deterministic pick so all peers converge.
        if (!(record.sig < cur.sig)) { this.stats.stale++; return { accepted: false, reason: 'stale' }; }
      }
    }
    const frozen = Object.freeze(JSON.parse(canonicalize(record)));
    this.records.set(record.pk, frozen);
    this.stats.accepted++;
    if (persist && this.store) {
      try { this.store.save(this.all()); } catch { /* persistence is best-effort */ }
    }
    for (const fn of this.listeners) {
      try { fn(frozen, { local, previous: cur || null }); } catch { /* listener errors never break merge */ }
    }
    return { accepted: true };
  }

  /** Merge many; returns how many were accepted. */
  ingestAll(records, opts) {
    let n = 0;
    if (!Array.isArray(records)) return 0;
    for (const r of records) if (this.ingest(r, opts).accepted) n++;
    return n;
  }

  get(pk) {
    return this.records.get(pk) || null;
  }

  all() {
    return [...this.records.values()];
  }

  /** Compact [pk, seq] pairs for anti-entropy. */
  digest() {
    return this.all().map((r) => [r.pk, r.seq]);
  }

  /** Records newer than what a digest claims to hold. */
  newerThan(digest) {
    const have = new Map(digest.map(([pk, seq]) => [pk, seq]));
    return this.all().filter((r) => (have.get(r.pk) ?? 0) < r.seq);
  }

  /** pks a digest claims to hold newer versions of than we do. */
  wantFrom(digest) {
    return digest
      .filter(([pk, seq]) => Number.isSafeInteger(seq) && (this.records.get(pk)?.seq ?? 0) < seq)
      .map(([pk]) => pk);
  }

  /** All live claimants of a username, and the deterministic display owner. */
  lookup(username) {
    const claimants = this.all()
      .filter((r) => !r.deleted && r.user === username)
      .sort((a, b) => a.ts - b.ts || (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));
    return { owner: claimants[0] || null, claimants };
  }

  /** Live accounts grouped for display: one row per live record. */
  listUsers() {
    const owners = new Map();
    for (const r of this.all()) {
      if (r.deleted) continue;
      const { owner } = this.lookup(r.user);
      owners.set(r.user, owner.pk);
    }
    return this.all()
      .filter((r) => !r.deleted)
      .map((r) => ({ ...r, isOwner: owners.get(r.user) === r.pk }))
      .sort((a, b) => a.user.localeCompare(b.user) || a.ts - b.ts);
  }

  listTombstones() {
    return this.all().filter((r) => r.deleted).sort((a, b) => b.ts - a.ts);
  }
}

// Stores -----------------------------------------------------------------

export function memoryStore(initial = []) {
  let data = [...initial];
  return {
    load: () => data.map((r) => ({ ...r })),
    save: (records) => { data = records.map((r) => ({ ...r })); },
    peek: () => data,
  };
}

export function webStorageStore(storage, key = 'p2p-accounts:v1:records') {
  return {
    load() {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    },
    save(records) {
      storage.setItem(key, JSON.stringify(records));
    },
  };
}
