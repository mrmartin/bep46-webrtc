// Account operations on top of a Directory. Everything here runs on the
// user's own device; nothing but signed records ever leaves it.
//
//   register(user, pw)              → new root keypair, sealed under scrypt(pw), seq 1
//   login(user, pw)                 → open the box of whichever claimant it fits
//   changePassword(session, old, new) → re-seal the SAME root key under the new password, seq+1
//   deleteAccount(session, pw)      → tombstone, seq+1
//
// All four produce (or verify against) records in the local Directory; the
// Replica broadcasts anything the Directory accepts.

import { toHex } from './bytes.js';
import { ed25519, deriveKey, DEFAULT_KDF } from './crypto.js';
import {
  RECORD_VERSION, normalizeUsername, isValidUsername, signRecord,
  sealSecretKey, openSecretKey, newSalt,
} from './records.js';

export class AccountError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const MIN_PASSWORD_LENGTH = 8;

export class Session {
  constructor({ username, pk, secretKey }) {
    this.username = username;
    this.pk = pk;
    this.secretKey = secretKey; // Uint8Array(64); memory only, never serialised
    Object.defineProperty(this, 'secretKey', { enumerable: false, writable: true, value: secretKey });
  }
  toJSON() { return { username: this.username, pk: this.pk }; }
  destroy() { this.secretKey?.fill(0); this.secretKey = null; }
}

export class Accounts {
  /**
   * @param {{ directory: import('./directory.js').Directory, kdf?: object, now?: () => number }} opts
   */
  constructor({ directory, kdf = DEFAULT_KDF, now = () => Date.now() }) {
    this.directory = directory;
    this.kdf = kdf;
    this.now = now;
  }

  // -- helpers -----------------------------------------------------------

  _checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
      throw new AccountError('weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  async _seal(secretKey, password) {
    const kdf = { ...this.kdf, salt: newSalt() };
    const key = await deriveKey(password, kdf);
    const box = sealSecretKey(secretKey, key);
    key.fill(0);
    return { kdf, box };
  }

  _publish(unsigned, secretKey) {
    const record = signRecord(unsigned, secretKey);
    const res = this.directory.ingest(record, { local: true });
    if (!res.accepted) throw new AccountError('publish_failed', `local directory refused record: ${res.reason}`);
    return this.directory.get(record.pk);
  }

  _current(session) {
    const r = this.directory.get(session.pk);
    if (!r) throw new AccountError('unknown_account', 'account record not found');
    if (r.deleted) throw new AccountError('deleted', 'account has been deleted');
    return r;
  }

  // -- operations --------------------------------------------------------

  async register(usernameRaw, password) {
    const username = normalizeUsername(usernameRaw);
    if (!isValidUsername(username)) {
      throw new AccountError('bad_username', 'username: 3–32 chars, a–z 0–9 _ . -, starting and ending alphanumeric');
    }
    this._checkPassword(password);
    const { claimants } = this.directory.lookup(username);
    if (claimants.length) throw new AccountError('username_taken', `"${username}" is already registered`);

    const kp = ed25519.keyPair();
    const { kdf, box } = await this._seal(kp.secretKey, password);
    this._publish({
      v: RECORD_VERSION, user: username, pk: toHex(kp.publicKey),
      seq: 1, ts: this.now(), deleted: false, kdf, box,
    }, kp.secretKey);
    return new Session({ username, pk: toHex(kp.publicKey), secretKey: kp.secretKey });
  }

  async login(usernameRaw, password) {
    const username = normalizeUsername(usernameRaw);
    const { claimants } = this.directory.lookup(username);
    // Try every live claimant: only the box sealed under this password opens.
    for (const r of claimants) {
      const key = await deriveKey(password, r.kdf);
      const sk = openSecretKey(r.box, key, r.pk);
      key.fill(0);
      if (sk) return new Session({ username, pk: r.pk, secretKey: sk });
    }
    // Same error whether the name is unknown or the password is wrong.
    throw new AccountError('invalid_credentials', 'unknown username or wrong password');
  }

  /** Re-derive from the latest record to prove the caller still knows the password. */
  async verifyPassword(session, password) {
    const r = this._current(session);
    const key = await deriveKey(password, r.kdf);
    const sk = openSecretKey(r.box, key, r.pk);
    key.fill(0);
    return !!sk;
  }

  async changePassword(session, oldPassword, newPassword) {
    this._checkPassword(newPassword);
    const r = this._current(session);
    if (!(await this.verifyPassword(session, oldPassword))) {
      throw new AccountError('invalid_credentials', 'current password is wrong');
    }
    const { kdf, box } = await this._seal(session.secretKey, newPassword);
    return this._publish({
      v: RECORD_VERSION, user: r.user, pk: r.pk, seq: r.seq + 1, ts: this.now(),
      deleted: false, kdf, box,
    }, session.secretKey);
  }

  async deleteAccount(session, password) {
    const r = this._current(session);
    if (!(await this.verifyPassword(session, password))) {
      throw new AccountError('invalid_credentials', 'password is wrong');
    }
    const tomb = this._publish({
      v: RECORD_VERSION, user: r.user, pk: r.pk, seq: r.seq + 1, ts: this.now(), deleted: true,
    }, session.secretKey);
    session.destroy();
    return tomb;
  }
}
