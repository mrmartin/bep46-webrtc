// Drives the BUILT page (dist/index.html) in jsdom, no browser needed: home with
// sample posts, members, a profile, sign in as a demo cat, read a friends-only
// post, post, friend, poke, edit the profile, log out, check persistence.
//   npm run build && npm run smoke
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[2] || new URL('../../dist/index.html', import.meta.url), 'utf8');
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/catwalk/?tracker=ws://127.0.0.1:1', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    // Web platform pieces real browsers have and jsdom lacks (WebTorrent's bundle expects them at load time).
    for (const k of ['WritableStream', 'ReadableStream', 'TransformStream', 'TextEncoder', 'TextDecoder', 'structuredClone', 'queueMicrotask']) if (!w[k]) w[k] = globalThis[k];
    if (!w.crypto?.getRandomValues) w.crypto = globalThis.crypto;
    w.scrollTo = () => {};
    // Uint8Array#toBase64/fromBase64 (ES2025) exist in current browsers but not in Node 20's realm.
    const U = w.Uint8Array.prototype;
    if (!U.toBase64) U.toBase64 = function () { return Buffer.from(this).toString('base64'); };
    if (!U.toHex) U.toHex = function () { return Buffer.from(this).toString('hex'); };
    if (!w.Uint8Array.fromBase64) w.Uint8Array.fromBase64 = (s) => new w.Uint8Array(Buffer.from(s, 'base64'));
    if (!w.Uint8Array.fromHex) w.Uint8Array.fromHex = (s) => new w.Uint8Array(Buffer.from(s, 'hex'));
  } });
const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => (doc.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const fail = (m) => { console.error('FAIL: ' + m); console.error(errors.join('\n')); process.exit(1); };
await sleep(1500);
console.log('page errors so far:', errors.length ? errors : 'none');
if (!window.__catwalk) fail('app did not boot (window.__catwalk missing)');
const { app, ledger, directory } = window.__catwalk;
console.log('cats:', directory.listUsers().length, 'posts:', ledger.ofKind('post').length);
const home = text('#content');
if (!home.includes('Welcome to Catwalk') || !home.includes('Recent public posts')) fail('home view missing');
if (!home.includes('car bonnet')) fail('newest seed public post not shown on home');
if (home.includes('Friends only:')) fail('a friends-only post leaked to a signed-out visitor');
console.log('home: ok (' + doc.querySelectorAll('#content .post').length + ' public posts shown)');

window.location.hash = '#/members'; await sleep(300);
const rows = doc.querySelectorAll('#content table.list tr').length - 1;
if (rows !== 10) fail('members view shows ' + rows + ' cats');
console.log('members: ok (10 cats, ' + doc.querySelectorAll('#content svg.avatar').length + ' avatars)');

const mittens = directory.lookup('mittens').owner.pk;
window.location.hash = '#/profile/' + mittens; await sleep(300);
const prof = text('#content');
if (!prof.includes('Mittens') || !prof.includes('Professional napper')) fail('profile view broken');
if (prof.includes('airing cupboard')) fail('friends-only post visible on wall while signed out');
console.log('profile: ok (friends listed: ' + doc.querySelectorAll('#content .friend-grid a').length / 1 + ')');

// sign in as luna (scrypt in pure JS, a few seconds)
window.location.hash = '#/'; await sleep(300);
doc.querySelector('#form-login input[name=username]').value = 'luna';
doc.querySelector('#form-login input[name=password]').value = 'catnip2004';
doc.querySelector('#form-login').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 60 && !window.__catwalk.session; i++) await sleep(500);
if (!window.__catwalk.session) fail('login did not complete: ' + text('.message'));
await sleep(300);
const feed = text('#content');
if (!feed.includes('Welcome, Luna')) fail('signed-in home missing');
if (!feed.includes('airing cupboard')) fail('luna cannot read mittens’ friends-only post');
if (feed.includes('do not have the key')) fail('a locked post is shown to luna');
console.log('login as luna: ok, feed shows', doc.querySelectorAll('#content .post').length, 'posts incl. friends-only');

// post
doc.querySelector('#form-post textarea').value = 'jsdom was here (friends only)';
doc.querySelector('#form-post select').value = 'friends';
doc.querySelector('#form-post').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(400);
if (!text('#content').includes('jsdom was here')) fail('post did not appear');
console.log('post: ok ->', text('.message'));

// friend + poke a stranger (simba), then confirm the pending request from pixel
const simba = directory.lookup('simba').owner.pk;
window.location.hash = '#/profile/' + simba; await sleep(300);
doc.querySelector('[data-add]').click(); await sleep(400);
console.log('add friend:', text('.message'));
doc.querySelector('[data-poke]').click(); await sleep(400);
console.log('poke:', text('.message'));
window.location.hash = '#/friends'; await sleep(300);
const fr = text('#content');
console.log('friends view: friends=' + app.friendsOf(mittens === '' ? '' : window.__catwalk.session.pk).length, 'pending incoming=' + app.pendingIncoming(window.__catwalk.session.pk).length, 'outgoing=' + app.pendingOutgoing(window.__catwalk.session.pk).length);
if (!fr.includes('Requests you sent')) fail('outgoing request not listed');

// edit profile
window.location.hash = '#/edit'; await sleep(300);
doc.querySelector('#form-profile input[name=tagline]').value = 'edited in jsdom';
doc.querySelector('#form-profile select[name=fur]').value = 'white';
doc.querySelector('#form-profile').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(400);
if (!text('#content').includes('edited in jsdom')) fail('profile edit not shown');
console.log('edit profile: ok');

// logout → the friends-only post must vanish
doc.querySelector('#logout').click(); await sleep(400);
if (text('#content').includes('jsdom was here')) fail('friends-only post visible after logout');
console.log('logout: ok');
// localStorage persisted
const saved = JSON.parse(window.localStorage.getItem('catwalk:v1:social')).length;
console.log('persisted social records:', saved, '(ledger has', ledger.all().length + ')');
console.log('page errors:', errors.length ? errors : 'none');
console.log('PASS');
process.exit(0);
