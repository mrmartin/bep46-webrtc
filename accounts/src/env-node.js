// Node wiring for the core: tweetnacl from npm, scrypt from node:crypto.
import nacl from 'tweetnacl';
import { scrypt as nodeScrypt } from 'node:crypto';
import { configure } from './crypto.js';

export function nodeScryptAdapter(password, salt, { N, r, p, dkLen }) {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, dkLen, { N, r, p, maxmem: 512 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
    });
  });
}

export function configureNode() {
  configure({ nacl, scrypt: nodeScryptAdapter });
  return { nacl };
}
