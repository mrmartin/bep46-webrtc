// Generates the sample data every copy of Catwalk ships with: ten cats with
// accounts, profiles, friendships, posts (public and friends-only) and pokes,
// all as genuinely signed records produced through the same code path as
// the page. Output: web/seed.js (window.CATWALK_SEED = …), which the page
// ingests at start-up exactly as if it had arrived from a peer — so the very
// first visitor already sees a populated network, and becomes a seeder of it.
//
//   node tools/seed.js            (regenerates keys: every cat gets a new identity)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureNode } from '../../accounts/src/env-node.js';
import { Directory, memoryStore } from '../../accounts/src/directory.js';
import { Accounts } from '../../accounts/src/accounts.js';
import { Ledger } from '../src/ledger.js';
import { Catwalk } from '../src/catwalk.js';

configureNode();

export const DEMO_PASSWORD = 'catnip2004';

const CATS = [
  ['mittens', 'Mittens', 'calico', 'green', 'Professional napper. Amateur bird watcher.', 'Four white paws, zero regrets. Currently accepting applications for lap positions. Interests: sunbeams, the red dot, the sound of a tin opening three rooms away.'],
  ['whiskers', 'Whiskers', 'tabby', 'amber', 'I knock things off tables for science.', 'Gravity researcher. 1,204 experiments to date, all successful. Looking for a research partner with opposable thumbs.'],
  ['tom', 'Tom', 'grey', 'copper', 'Still chasing that mouse.', 'Semi-retired. Spends most days on the warm bit of the car bonnet. Not to be confused with any other Tom.'],
  ['luna', 'Luna', 'black', 'green', 'Night shift. Zoomies at 4 am, no exceptions.', 'Void-coloured. If you cannot see me I am on the black chair, judging you. Interests: hallway sprints, the inside of paper bags.'],
  ['oliver', 'Oliver', 'ginger', 'amber', 'Treat enthusiast. Will sit for salmon.', 'Big orange energy. Shares one brain cell with Simba on a rota basis; it is my turn on Tuesdays.'],
  ['cleo', 'Cleo', 'siamese', 'blue', 'Judging you from the top of the fridge.', 'Loud. Opinionated. Correct. Descended from temple cats and will not let anyone forget it.'],
  ['simba', 'Simba', 'ginger', 'green', 'Not a lion. Mostly.', 'Mane-adjacent. Keeper of the garden fence. Will fight the neighbour’s cat and lose with dignity.'],
  ['nala', 'Nala', 'white', 'odd', 'Sunbeam connoisseur.', 'One blue eye, one green, both unimpressed. Rates windowsills out of ten. Current record: the kitchen one, 9/10, slightly draughty.'],
  ['felix', 'Felix', 'tuxedo', 'green', 'Box inspector, first class.', 'If it fits, I sits. If it does not fit, I sits anyway and we revisit the measurements. Formal wear at all times.'],
  ['pixel', 'Pixel', 'grey', 'blue', 'Keyboard warmer at a software company.', 'Has shipped several commits by walking across the keyboard. None of them reverted. Interests: the warm laptop, the cursor, standing on the one key you need.'],
];

// mutual friendships (username pairs) and one-sided pending requests
const FRIENDS = [
  ['mittens', 'whiskers'], ['mittens', 'luna'], ['mittens', 'nala'], ['mittens', 'felix'],
  ['whiskers', 'tom'], ['whiskers', 'pixel'], ['whiskers', 'oliver'],
  ['tom', 'luna'], ['luna', 'cleo'], ['luna', 'felix'],
  ['oliver', 'simba'], ['oliver', 'nala'], ['simba', 'nala'], ['cleo', 'nala'],
  ['felix', 'pixel'], ['felix', 'simba'], ['pixel', 'luna'],
];
const PENDING = [['tom', 'cleo'], ['pixel', 'mittens'], ['simba', 'cleo']];

// [author, audience, text] in chronological order
const POSTS = [
  ['mittens', 'public', 'Hello Catwalk! First one here. Is this thing on?'],
  ['whiskers', 'public', 'Experiment #1205: the blue mug. It fell. Hypothesis confirmed again. Science is relentless.'],
  ['tom', 'public', 'The mouse was under the fridge the whole time. I have been informed it is a toy. I do not accept this.'],
  ['luna', 'public', 'Reminder that 4 am is a perfectly reasonable time to run the length of the flat eleven times.'],
  ['oliver', 'public', 'The humans bought the SALMON treats. Not the chicken ones. The SALMON ones. Today is a good day.'],
  ['cleo', 'public', 'From the top of the fridge I can see everything. Everything is beneath me. This is as it should be.'],
  ['mittens', 'friends', 'Friends only: I have found a new spot on top of the airing cupboard. Do not tell Luna, she will take it.'],
  ['simba', 'public', 'Patrolled the fence. The neighbour’s cat looked at me. I looked back. Nothing further to report.'],
  ['nala', 'public', 'Windowsill review, bathroom: 6/10. Warm but you can hear the boiler. Would nap again, reluctantly.'],
  ['felix', 'public', 'A box arrived. Dimensions: small. Verdict: I fit. Review to follow once I have sat in it for six hours.'],
  ['pixel', 'public', 'Walked across the keyboard and the build went green. You are welcome, team.'],
  ['whiskers', 'friends', 'Friends only: I am scared of the new vacuum cleaner. It knows where I sleep. Please do not repeat this.'],
  ['luna', 'friends', 'Friends only: Mittens thinks the airing cupboard is a secret. It is not a secret. I was there first.'],
  ['oliver', 'friends', 'Friends only: hid three salmon treats behind the sofa. Simba, if you are reading this, it is my turn with the brain cell, hands off.'],
  ['tom', 'public', 'Update on the mouse situation: still a toy, apparently. Investigation ongoing.'],
  ['mittens', 'public', 'Watched a pigeon for forty minutes today. It did nothing. Ten out of ten.'],
  ['cleo', 'friends', 'Friends only: I sometimes come down from the fridge when nobody is watching. For cuddles. This is confidential.'],
  ['nala', 'public', 'Windowsill review, kitchen: 9/10. Full sun from eleven. Slightly draughty. New leader.'],
  ['pixel', 'public', 'Sat on the warm laptop. Someone said "the fans are loud". That is because I am loud. Respect the fans.'],
  ['felix', 'public', 'Six-hour box review: still fits. Slight lean to the left. Four stars, would recommend to a friend.'],
  ['simba', 'friends', 'Friends only: I lost to the neighbour’s cat. Twice. Please do not mention it on my wall.'],
  ['luna', 'public', 'Knocked a glass of water onto a phone at 4 am. Everyone woke up. Mission accomplished.'],
  ['whiskers', 'public', 'Experiment #1206: the pen. Rolled further than expected. Noted.'],
  ['oliver', 'public', 'Sat for salmon. Got salmon. The system works.'],
  ['mittens', 'public', 'Catwalk tip: pokes are free. Poke your friends. Poke everyone.'],
  ['felix', 'friends', 'Friends only: the formal wear is not optional, it is genetic. I would wear a hoodie if I could.'],
  ['nala', 'public', 'Oliver fell asleep in my sunbeam. There are rules. There are RULES.'],
  ['cleo', 'public', 'Correction to an earlier post: nothing is beneath me. Everyone is beneath me. Different thing.'],
  ['pixel', 'friends', 'Friends only: I do not actually understand the commits. I just like the warm keys. Keep this between us.'],
  ['tom', 'public', 'Spent the afternoon on the car bonnet. It was warm. That is the whole post.'],
];
const POKES = [['mittens', 'luna'], ['luna', 'mittens'], ['oliver', 'simba'], ['whiskers', 'pixel'], ['nala', 'oliver'], ['felix', 'pixel'], ['cleo', 'nala']];

// A clock we drive by hand so the sample looks like ten days of activity.
let t = Date.parse('2026-09-28T09:12:00Z');
const step = (minutes) => (t += minutes * 60_000);
const now = () => t;

const directory = new Directory({ store: memoryStore() });
const ledger = new Ledger({ store: memoryStore() });
const accounts = new Accounts({ directory, now });
const app = new Catwalk({ directory, ledger, now });

const sessions = new Map();
for (const [user, name, fur, eyes, tagline, about] of CATS) {
  step(37 + (user.length * 11) % 50);
  const s = await accounts.register(user, DEMO_PASSWORD);
  sessions.set(user, s);
  app.unlock(s);
  app.setProfile({ name, fur, eyes, tagline, about });
}
const as = (u) => { app.unlock(sessions.get(u)); return app; };
const pk = (u) => sessions.get(u).pk;

for (const [a, b] of FRIENDS) { step(23); as(a).addFriend(pk(b)); step(31); as(b).addFriend(pk(a)); }
for (const [a, b] of PENDING) { step(19); as(a).addFriend(pk(b)); }
// everyone reconciles once, like a sign-in after friends got their profiles
for (const [user] of CATS) as(user).reconcile();
for (const [author, aud, text] of POSTS) { step(190 + (text.length * 7) % 240); as(author).post(text, aud); }
for (const [a, b] of POKES) { step(41); as(a).poke(pk(b)); }
app.lock();

const seed = {
  generated: new Date().toISOString(),
  demo: { password: DEMO_PASSWORD, users: CATS.map(([u]) => u) },
  accounts: directory.all(),
  social: ledger.all(),
};
const out = fileURLToPath(new URL('../web/seed.js', import.meta.url));
writeFileSync(out, `// Generated by tools/seed.js — ${seed.accounts.length} cats, ${seed.social.length} social records. Do not edit by hand.\nwindow.CATWALK_SEED = ${JSON.stringify(seed)};\n`);
console.log(`web/seed.js: ${seed.accounts.length} accounts, ${seed.social.length} social records (${ledger.ofKind('post').length} posts, ${ledger.ofKind('friend').length} friend links, ${ledger.ofKind('poke').length} pokes), demo password "${DEMO_PASSWORD}"`);
