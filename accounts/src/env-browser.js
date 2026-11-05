// Browser wiring for the core: vendored nacl-fast.min.js and scrypt-js, both
// loaded as classic scripts before the module graph (see web/index.html).
import { configure } from './crypto.js';

export function configureBrowser() {
  const nacl = globalThis.nacl;
  const scryptLib = globalThis.scrypt;
  if (!nacl) throw new Error('vendor/nacl-fast.min.js did not load');
  if (!scryptLib?.scrypt) throw new Error('vendor/scrypt.js did not load');
  configure({
    nacl,
    scrypt: (password, salt, { N, r, p, dkLen }) => scryptLib.scrypt(password, salt, N, r, p, dkLen),
  });
}
