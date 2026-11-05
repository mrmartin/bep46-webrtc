// The shipped sample data is real: every record verifies, every demo cat can
// sign in with the demo password, and friends can read each other's
// friends-only posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureNode } from '../../../accounts/src/env-node.js';
import { Directory, memoryStore } from '../../../accounts/src/directory.js';
import { Accounts } from '../../../accounts/src/accounts.js';
import { validateRecord } from '../../../accounts/src/records.js';
import { Ledger } from '../../src/ledger.js';
import { Catwalk } from '../../src/catwalk.js';
import { validateSocial } from '../../src/social.js';

configureNode();
const src = readFileSync(new URL('../../web/seed.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const seed = win.CATWALK_SEED;

test('seed.js is well-formed and every record validates', () => {
  assert.ok(seed && Array.isArray(seed.accounts) && Array.isArray(seed.social));
  assert.equal(seed.accounts.length, 10);
  for (const r of seed.accounts) assert.equal(validateRecord(r).ok, true, r.user);
  for (const r of seed.social) assert.equal(validateSocial(r).ok, true, r.id);
  assert.deepEqual(seed.demo.users.sort(), seed.accounts.map((a) => a.user).sort());
});

test('the seed loads into an empty node like gossip would, with a populated, consistent network', async () => {
  const directory = new Directory({ store: memoryStore() });
  const ledger = new Ledger({ store: memoryStore() });
  assert.equal(directory.ingestAll(seed.accounts), seed.accounts.length);
  assert.equal(ledger.ingestAll(seed.social), seed.social.length);
  const app = new Catwalk({ directory, ledger });
  const members = app.members();
  assert.equal(members.length, 10);
  assert.ok(members.every((m) => m.profile && m.profile.name && m.profile.box), 'every cat has a profile with a box key');
  assert.ok(members.every((m) => m.friends >= 2), 'every cat has at least two friends');
  const publicFeed = app.feed();
  assert.ok(publicFeed.length >= 20, `visitors see ${publicFeed.length} public posts`);
  assert.ok(publicFeed.every((p) => p.aud === 'public' && !p.locked));

  // sign in as a demo cat and read a friend's friends-only post
  const accounts = new Accounts({ directory });
  const s = await accounts.login('mittens', seed.demo.password);
  app.unlock(s);
  const feed = app.feed();
  const friendsOnly = feed.filter((p) => p.aud === 'friends');
  assert.ok(friendsOnly.length >= 2, 'mittens sees friends-only posts');
  assert.ok(friendsOnly.every((p) => !p.locked && p.text), 'and can read them all');
  assert.ok(friendsOnly.some((p) => p.name === 'Luna'), 'including the one Luna wrote about the airing cupboard');
  assert.ok(app.pendingIncoming(s.pk).length >= 1, 'mittens has a pending friend request waiting');
  assert.ok(app.pokesFor(s.pk).length >= 1, 'and has been poked');
  // a stranger's friends-only posts stay closed
  const strangers = members.filter((m) => m.pk !== s.pk && !app.isFriend(s.pk, m.pk));
  assert.ok(strangers.length >= 1);
  for (const st of strangers) assert.ok(app.wall(st.pk).every((p) => p.aud === 'public'));
});
