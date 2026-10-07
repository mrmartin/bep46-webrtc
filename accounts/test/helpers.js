import { configureNode } from '../src/env-node.js';
import { Directory, memoryStore } from '../src/directory.js';
import { Accounts } from '../src/accounts.js';
import { Replica } from '../src/replica.js';
import { MemorySwarm } from '../src/transport-memory.js';

configureNode();

// Fast scrypt for tests; the record format carries the parameters so this is
// a legitimate (if weak) configuration, and validateRecord's lower bound
// (2^10) is exactly what we use.
export const TEST_KDF = Object.freeze({ name: 'scrypt', N: 1 << 10, r: 8, p: 1 });

export function clock(start = 1_700_000_000_000) {
  let t = start;
  return () => (t += 1000);
}

export function standalone({ store = memoryStore(), now = clock() } = {}) {
  const directory = new Directory({ store });
  const accounts = new Accounts({ directory, kdf: TEST_KDF, now });
  return { directory, accounts, store };
}

/** n replicas on one simulated swarm, each with its own directory/store/accounts. */
export function cluster(n, { swarm = new MemorySwarm(), now = clock(), heartbeatMs = 0 } = {}) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const store = memoryStore();
    const directory = new Directory({ store });
    const transport = swarm.join(`n${i}`);
    const replica = new Replica({ directory, transport, heartbeatMs }).start();
    const accounts = new Accounts({ directory, kdf: TEST_KDF, now });
    nodes.push({ name: `n${i}`, store, directory, transport, replica, accounts });
  }
  return { swarm, nodes };
}

export async function rejects(promise, code) {
  try {
    await promise;
  } catch (e) {
    if (code && e.code !== code) throw new Error(`expected error code ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected rejection${code ? ` (${code})` : ''}`);
}
