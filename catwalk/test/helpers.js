import { configureNode } from '../../accounts/src/env-node.js';
import { Directory, memoryStore } from '../../accounts/src/directory.js';
import { Accounts } from '../../accounts/src/accounts.js';
import { Replica } from '../../accounts/src/replica.js';
import { MemorySwarm } from '../../accounts/src/transport-memory.js';
import { Ledger } from '../src/ledger.js';
import { Catwalk } from '../src/catwalk.js';

configureNode();

export const TEST_KDF = Object.freeze({ name: 'scrypt', N: 1 << 10, r: 8, p: 1 });

export function clock(start = 1_700_000_000_000) {
  let t = start;
  return () => (t += 1000);
}

/** One node: its own directory, ledger and app, no network. */
export function standalone({ now = clock() } = {}) {
  const directory = new Directory({ store: memoryStore() });
  const ledger = new Ledger({ store: memoryStore() });
  const accounts = new Accounts({ directory, kdf: TEST_KDF, now });
  const app = new Catwalk({ directory, ledger, now });
  return { directory, ledger, accounts, app };
}

/** Register + sign in + unlock a cat on a node, with a profile. */
export async function cat(node, user, { name = user, fur = 'tabby', eyes = 'green', tagline = '' } = {}) {
  const session = await node.accounts.register(user, `${user}-password`);
  node.app.unlock(session);
  node.app.setProfile({ name, fur, eyes, tagline });
  return session;
}

/** n nodes on two simulated swarms (accounts channel + social channel), like the real page. */
export function cluster(n, { now = clock(), heartbeatMs = 0 } = {}) {
  const swarmA = new MemorySwarm();
  const swarmS = new MemorySwarm();
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const directory = new Directory({ store: memoryStore() });
    const ledger = new Ledger({ store: memoryStore() });
    const ta = swarmA.join(`a${i}`);
    const ts = swarmS.join(`s${i}`);
    const ra = new Replica({ directory, transport: ta, heartbeatMs }).start();
    const rs = new Replica({ directory: ledger, transport: ts, heartbeatMs, keyField: 'id' }).start();
    const accounts = new Accounts({ directory, kdf: TEST_KDF, now });
    const app = new Catwalk({ directory, ledger, now });
    nodes.push({ name: `n${i}`, directory, ledger, accounts, app, replicas: [ra, rs] });
  }
  const settle = async () => { await swarmA.settle(); await swarmS.settle(); await swarmA.settle(); await swarmS.settle(); };
  return { swarmA, swarmS, nodes, settle };
}

export function sameLedgers(nodes) {
  const snap = (l) => JSON.stringify(l.all().map((r) => [r.id, r.seq, r.sig]).sort());
  const first = snap(nodes[0].ledger);
  for (const n of nodes.slice(1)) if (snap(n.ledger) !== first) throw new Error(`${n.name} ledger diverged`);
}

export async function rejects(fn, code) {
  try { await fn(); } catch (e) {
    if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected rejection${code ? ` (${code})` : ''}`);
}
