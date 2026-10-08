// Catwalk — the page. All state is two replicated maps (accounts, social
// records) plus an in-memory session; everything on screen is derived from
// them on every change. Routes live in the hash so the single file works
// from anywhere, including inside the BEP-46 page viewer.
import WebTorrent from '../../accounts/vendor/webtorrent.min.js';
import { configureBrowser } from '../../accounts/src/env-browser.js';
import { Directory, webStorageStore, memoryStore } from '../../accounts/src/directory.js';
import { Accounts, AccountError } from '../../accounts/src/accounts.js';
import { Replica } from '../../accounts/src/replica.js';
import { WebTorrentTransport, DEFAULT_TRACKERS } from '../../accounts/src/transport-webtorrent.js';
import { fingerprint } from '../../accounts/src/records.js';
import { DEFAULT_KDF } from '../../accounts/src/crypto.js';
import { sha1Hex } from '../../accounts/src/sha1.js';
import { utf8 } from '../../accounts/src/bytes.js';
import { Ledger } from '../src/ledger.js';
import { Catwalk, CatwalkError } from '../src/catwalk.js';
import { FUR, EYES, LIMITS } from '../src/social.js';
import { catSvg } from '../src/avatar.js';

configureBrowser();

export const ACCOUNTS_CHANNEL = sha1Hex(utf8('catwalk/accounts/v1'));
export const SOCIAL_CHANNEL = sha1Hex(utf8('catwalk/social/v1'));

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (ts) => new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });

// --- settings -------------------------------------------------------------
const TRACKERS_KEY = 'catwalk:v1:trackers';
function loadTrackers() {
  const fromUrl = params.getAll('tracker').filter(Boolean);
  if (fromUrl.length) return fromUrl;
  try { const saved = JSON.parse(localStorage.getItem(TRACKERS_KEY) || 'null'); if (Array.isArray(saved) && saved.length) return saved; } catch { /* ignore */ }
  return DEFAULT_TRACKERS;
}
let kdf = DEFAULT_KDF;
if (isLocal && params.has('kdf')) { const n = Number(params.get('kdf')); if (Number.isInteger(n) && n >= 10 && n <= 20) kdf = { ...DEFAULT_KDF, N: 1 << n }; }

// --- model ----------------------------------------------------------------
let storeA, storeS;
try {
  localStorage.setItem('catwalk:probe', '1'); localStorage.removeItem('catwalk:probe');
  if (params.has('fresh')) { localStorage.removeItem('catwalk:v1:accounts'); localStorage.removeItem('catwalk:v1:social'); }
  storeA = webStorageStore(localStorage, 'catwalk:v1:accounts');
  storeS = webStorageStore(localStorage, 'catwalk:v1:social');
} catch { storeA = memoryStore(); storeS = memoryStore(); }

const directory = new Directory({ store: storeA });
const ledger = new Ledger({ store: storeS });
const accounts = new Accounts({ directory, kdf });
const app = new Catwalk({ directory, ledger });

// The sample network every copy ships with, ingested like gossip (signatures
// and all), so the first visitor already has cats to look at — and seeds them on.
if (window.CATWALK_SEED) {
  directory.ingestAll(window.CATWALK_SEED.accounts, { persist: true });
  ledger.ingestAll(window.CATWALK_SEED.social, { persist: true });
}

let client = null, transports = [], replicas = [], session = null;
const activity = [];
function log(text) { activity.unshift(`${new Date().toLocaleTimeString()} ${text}`); activity.length = Math.min(activity.length, 100); }

function connect(trackers) {
  for (const r of replicas) r.stop();
  if (client) client.destroy();
  client = new WebTorrent({ dht: false, lsd: false });
  client.on('error', (e) => log('client error: ' + (e?.message || e)));
  const ta = new WebTorrentTransport({ client, infoHash: ACCOUNTS_CHANNEL, announce: trackers, log: (...a) => log('accounts: ' + a.join(' ')) });
  const ts = new WebTorrentTransport({ client, infoHash: SOCIAL_CHANNEL, announce: trackers, log: (...a) => log('social: ' + a.join(' ')) });
  transports = [ta, ts];
  replicas = [
    new Replica({ directory, transport: ta, heartbeatMs: 15000, log: (...a) => log('accounts ' + a.join(' ')) }).start(),
    new Replica({ directory: ledger, transport: ts, heartbeatMs: 15000, keyField: 'id', log: (...a) => log('social ' + a.join(' ')) }).start(),
  ];
  for (const t of transports) { t.on('peerchange', renderSwarm); t.on('tracker', renderSwarm); }
  renderSwarm();
  window.__catwalk = { directory, ledger, accounts, app, client, transports, replicas, get session() { return session; } };
}

// --- re-render on change, debounced -----------------------------------------
let pending = null;
function scheduleRender() { if (pending) return; pending = setTimeout(() => { pending = null; render(); }, 120); }
directory.onChange(() => scheduleRender());
ledger.onChange((record, { local }) => {
  if (!local && session) {
    // somebody may have become my friend or published a profile: offer them my key
    try { if (app.reconcile() > 0) log('granted friends key to a new friend'); } catch { /* ignore */ }
  }
  scheduleRender();
});

// --- swarm status -----------------------------------------------------------
function renderSwarm() {
  const peers = Math.max(...transports.map((t) => t.peerCount()), 0);
  const trackers = Object.entries(transports[0]?.status.trackers || {});
  const connected = trackers.filter(([, s]) => s === 'connected').length;
  $('swarm-dot').className = 'dot ' + (peers > 0 ? 'live' : connected > 0 ? '' : trackers.length ? 'down' : '');
  $('swarm-text').innerHTML = `${peers === 0 ? 'no other browsers right now' : `<b>${peers}</b> other browser${peers === 1 ? '' : 's'} online`}<br>` +
    `${directory.listUsers().length} cats, ${ledger.ofKind('post').length} posts on file<br>` +
    (trackers.length ? `${connected}/${trackers.length} trackers reachable` : 'connecting…');
}

// --- views ------------------------------------------------------------------
const avatar = (pk, size = 40) => `<a href="#/profile/${pk}" title="${esc(app.displayName(pk))}">${catSvg({ ...(app.profile(pk) || { fur: 'grey', eyes: 'green' }), seed: pk }, size).replace('<svg ', '<svg class="avatar" ')}</a>`;
const nameLink = (pk) => `<a href="#/profile/${pk}"><b>${esc(app.displayName(pk))}</b></a>`;

function postHtml(p) {
  const mine = session && p.owner === session.pk;
  const body = p.locked
    ? `<span class="lock">friends-only post — you do not have the key (yet)</span>`
    : `<div class="text">${esc(p.text)}</div>`;
  return `<div class="post">${avatar(p.owner, 32)}<div style="flex:1;min-width:0">${nameLink(p.owner)}
    <span class="meta">· ${when(p.ts)}${p.aud === 'friends' ? ' · friends only' : ''}</span>
    ${mine ? `<a href="#" class="del" data-del="${p.id}">delete</a>` : ''}
    ${body}</div></div>`;
}

function viewHome() {
  if (!session) {
    const recent = app.feed({ limit: 15 });
    const demo = window.CATWALK_SEED?.demo;
    return `<div class="box"><h3>Welcome to Catwalk</h3><div class="body welcome">
      <h2>Catwalk is an online directory that connects cats through social networks.</h2>
      <p>You can use Catwalk to: <b>look up cats</b> near you · <b>see who is friends with whom</b> · <b>post to your friends</b>, or to everyone · <b>poke</b> somebody.</p>
      <p>There is no Catwalk server. This page, and every other open copy of it, <i>is</i> the site: accounts, friendships and posts are signed records passed between browsers over WebRTC, and friends-only posts are encrypted so only your friends can read them.</p>
      <form id="form-login" autocomplete="on"><h4>Sign in</h4>
        <label><span>username</span><input name="username" autocomplete="username" required></label>
        <label><span>password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button type="submit">Sign in</button> &nbsp; or <a href="#/register">register</a></div>
      </form>
      ${demo ? `<p class="demo"><b>Try it:</b> sign in as any of ${demo.users.map((u) => `<code>${esc(u)}</code>`).join(' ')} with the password <code>${esc(demo.password)}</code>. They are real accounts in the swarm; be nice to them.</p>` : ''}
    </div></div>
    <div class="box"><h3>Recent public posts</h3><div class="body">${recent.map(postHtml).join('') || '<p class="muted">Nothing yet.</p>'}</div></div>`;
  }
  const me = session.pk;
  const pokes = app.pokesFor(me).slice(0, 5);
  const incoming = app.pendingIncoming(me);
  const feed = app.feed({ limit: 60 });
  return `<div class="box"><h3>Welcome, ${esc(app.displayName(me))}</h3><div class="body">
    ${incoming.length ? `<p>👋 <b>${incoming.length}</b> friend request${incoming.length === 1 ? '' : 's'} waiting — <a href="#/friends">see who</a>.</p>` : ''}
    ${pokes.length ? `<p>${pokes.map((p) => `${nameLink(p.pk)} poked you (${when(p.ts)}) <a href="#" data-poke="${p.pk}">poke back</a>`).join('<br>')}</p>` : ''}
    <form id="form-post" class="composer">
      <textarea name="text" maxlength="${LIMITS.postText}" placeholder="What's on your mind, ${esc(app.displayName(me))}?" required></textarea>
      <div class="row"><select name="aud"><option value="friends">friends only</option><option value="public">everyone</option></select>
      <button type="submit">Post</button><span class="muted small">friends-only posts are encrypted to your current friends</span></div>
    </form>
  </div></div>
  <div class="box"><h3>News feed</h3><div class="body">${feed.map(postHtml).join('') || '<p class="muted">No posts yet. Make some friends, or write the first one.</p>'}</div></div>`;
}

function viewProfile(pk) {
  const acct = app.account(pk);
  if (!acct) return `<div class="box"><h3>Not found</h3><div class="body">No cat with that key is known to this browser (yet — it may still be on its way from a peer).</div></div>`;
  const prof = app.profile(pk) || {};
  const me = session?.pk;
  const rel = app.relation(me, pk);
  const friends = app.friendsOf(pk);
  const wall = app.wall(pk, { limit: 50 });
  let actions = '';
  if (session && rel !== 'self') {
    actions = {
      none: `<button data-add="${pk}">Add as friend</button>`,
      wants: `<button data-add="${pk}">Confirm friend request</button>`,
      requested: `<button class="quiet" disabled>Friend request sent</button> <a href="#" data-remove="${pk}">cancel</a>`,
      friends: `<button class="quiet" data-remove="${pk}">Remove from friends</button>`,
    }[rel] + ` <button class="quiet" data-poke="${pk}">Poke</button>`;
  } else if (rel === 'self') actions = `<a class="btn" href="#/edit">Edit my profile</a>`;
  else actions = `<span class="muted">sign in to add as a friend or poke</span>`;
  return `<div class="box"><h3>${esc(app.displayName(pk))}</h3><div class="body">
    <div class="profile-head">
      <div>${catSvg({ ...prof, seed: pk }, 160).replace('<svg ', '<svg class="avatar big" ')}</div>
      <div style="flex:1;min-width:200px">
        <div class="name">${esc(prof.name || acct.user)}</div>
        ${prof.tagline ? `<div class="tagline">“${esc(prof.tagline)}”</div>` : ''}
        <p style="margin-top:6px">${actions}</p>
        <table class="info">
          <tr><td class="k">username</td><td>${esc(acct.user)}</td></tr>
          <tr><td class="k">member since</td><td>${day(acct.ts)}</td></tr>
          <tr><td class="k">friends</td><td>${friends.length}</td></tr>
          <tr><td class="k">fur / eyes</td><td>${esc(prof.fur || '?')} / ${esc(prof.eyes || '?')}</td></tr>
          <tr><td class="k">key</td><td><span class="fp" title="${pk}">${fingerprint(pk)}</span></td></tr>
          ${rel === 'friends' ? '<tr><td class="k">status</td><td>you are friends</td></tr>' : ''}
        </table>
      </div>
    </div>
    ${prof.about ? `<h4>About</h4><p class="text" style="white-space:pre-wrap">${esc(prof.about)}</p>` : ''}
    <h4>Friends (${friends.length})</h4>
    <div class="friend-grid">${friends.map((f) => `<div>${avatar(f, 48)}<br><a href="#/profile/${f}">${esc(app.displayName(f))}</a></div>`).join('') || '<span class="muted">none yet</span>'}</div>
    <h4>Wall</h4>
    ${wall.map(postHtml).join('') || '<p class="muted">Nothing posted here that you can see.</p>'}
  </div></div>`;
}

function viewFriends() {
  if (!session) return viewHome();
  const me = session.pk;
  const friends = app.friendsOf(me);
  const incoming = app.pendingIncoming(me);
  const outgoing = app.pendingOutgoing(me);
  const row = (pk, extra = '') => `<tr><td width="48">${avatar(pk, 40)}</td><td>${nameLink(pk)}<br><span class="muted">${esc(app.profile(pk)?.tagline || app.username(pk))}</span></td><td style="text-align:right">${extra}</td></tr>`;
  return `<div class="box"><h3>My friends</h3><div class="body">
    ${incoming.length ? `<h4>Friend requests (${incoming.length})</h4><table class="list">${incoming.map((r) => row(r.pk, `<button data-add="${r.pk}">Confirm</button>`)).join('')}</table>` : ''}
    <h4>Friends (${friends.length})</h4>
    <table class="list">${friends.map((pk) => row(pk, `<button class="quiet" data-poke="${pk}">poke</button> <button class="quiet" data-remove="${pk}">remove</button>`)).join('') || '<tr><td class="muted">No friends yet. Find some in <a href="#/members">all cats</a>.</td></tr>'}</table>
    ${outgoing.length ? `<h4>Requests you sent (${outgoing.length})</h4><table class="list">${outgoing.map((r) => row(r.pk, `<a href="#" data-remove="${r.pk}">cancel</a>`)).join('')}</table>` : ''}
  </div></div>`;
}

function viewMembers(q = '') {
  q = q.trim().toLowerCase();
  const all = app.members().filter((m) => !q || m.name.toLowerCase().includes(q) || m.user.includes(q) || (m.profile?.tagline || '').toLowerCase().includes(q));
  return `<div class="box"><h3>All cats${q ? ` matching “${esc(q)}”` : ''} (${all.length})</h3><div class="body">
    <table class="list"><tr><th></th><th>cat</th><th>friends</th><th>member since</th></tr>
    ${all.map((m) => `<tr><td width="48">${avatar(m.pk, 40)}</td><td>${nameLink(m.pk)} <span class="muted">${esc(m.user)}</span><br><span class="muted">${esc(m.profile?.tagline || '')}</span></td><td>${m.friends}</td><td>${day(m.since)}</td></tr>`).join('')}
    </table>${all.length ? '' : '<p class="muted">No cats match.</p>'}</div></div>`;
}

const options = (list, cur) => list.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v}</option>`).join('');

function viewEdit() {
  if (!session) return viewHome();
  const p = app.profile(session.pk) || { name: app.username(session.pk), tagline: '', about: '', fur: 'tabby', eyes: 'green' };
  return `<div class="box"><h3>Edit my profile</h3><div class="body">
    <form id="form-profile"><div class="profile-head"><div id="preview">${catSvg({ ...p, seed: session.pk }, 120).replace('<svg ', '<svg class="avatar big" ')}</div><div style="flex:1;min-width:220px">
      <label><span>name</span><input name="name" maxlength="${LIMITS.name}" value="${esc(p.name)}" required></label>
      <label><span>tagline</span><input name="tagline" maxlength="${LIMITS.tagline}" value="${esc(p.tagline)}" style="width:100%"></label>
      <label><span>about</span><textarea name="about" rows="4" maxlength="${LIMITS.about}">${esc(p.about)}</textarea></label>
      <label><span>fur</span><select name="fur">${options(FUR, p.fur)}</select></label>
      <label><span>eyes</span><select name="eyes">${options(EYES, p.eyes)}</select></label>
      <div class="actions"><button type="submit">Save profile</button></div>
    </div></div></form>
    <h4>Account</h4>
    <form id="form-password"><label><span>current password</span><input name="current" type="password" autocomplete="current-password" required></label>
      <label><span>new password</span><input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="actions"><button type="submit" class="quiet">Change password</button></div></form>
    <p class="small muted">There is no password reset anywhere: your account is a key sealed under your password.</p>
  </div></div>`;
}

function viewRegister() {
  return `<div class="box"><h3>Register</h3><div class="body">
    <form id="form-register" autocomplete="on">
      <label><span>username</span><input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{1,30}[A-Za-z0-9]"> <span class="muted small">a–z 0–9 . _ -</span></label>
      <label><span>password</span><input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
      <label><span>again</span><input name="confirm" type="password" autocomplete="new-password" required minlength="8"></label>
      <label><span>your name</span><input name="name" maxlength="${LIMITS.name}" required placeholder="e.g. Mittens"></label>
      <label><span>fur</span><select name="fur">${options(FUR, 'tabby')}</select></label>
      <label><span>eyes</span><select name="eyes">${options(EYES, 'green')}</select></label>
      <div class="actions"><button type="submit">Register</button></div>
    </form>
    <p class="small muted">Registering generates a key on this device and seals it under your password; the password never leaves the browser. Lose it and the account is gone for good.</p>
  </div></div>`;
}

// --- router / render --------------------------------------------------------
let message = { text: '', kind: '' };
function say(text, kind = '') { message = { text, kind }; render(); }

function render() {
  const hash = location.hash || '#/';
  const [, route, arg] = /^#\/([a-z]*)\/?([^/?]*)/.exec(hash) || [];
  let html;
  switch (route) {
    case '': case 'home': html = viewHome(); break;
    case 'profile': html = viewProfile(arg); break;
    case 'friends': html = viewFriends(); break;
    case 'members': case 'search': html = viewMembers(decodeURIComponent(arg || '')); break;
    case 'edit': html = viewEdit(); break;
    case 'register': html = session ? viewHome() : viewRegister(); break;
    case 'login': html = viewHome(); break;
    default: html = viewHome();
  }
  const msg = message.text ? `<div class="message ${message.kind}">${esc(message.text)}</div>` : '';
  $('content').innerHTML = msg + html;
  $('topnav').innerHTML = session
    ? `<span class="who">${esc(app.displayName(session.pk))}</span><a href="#/">home</a><a href="#/profile/${session.pk}">profile</a><a href="#/friends">friends</a><a href="#" id="logout">logout</a>`
    : `<a href="#/">home</a><a href="#/members">cats</a><a href="#/register">register</a>`;
  $('leftnav').innerHTML = session
    ? `<a href="#/">Home</a><a href="#/profile/${session.pk}">My Profile</a><a href="#/friends">My Friends</a><a href="#/members">All Cats</a><a href="#/edit">Edit Profile</a>`
    : `<a href="#/">Home</a><a href="#/members">All Cats</a><a href="#/register">Register</a>`;
  renderSwarm();
}
window.addEventListener('hashchange', () => { message = { text: '', kind: '' }; render(); window.scrollTo(0, 0); });

// --- actions ----------------------------------------------------------------
async function run(fn, btn) {
  if (btn) { btn.disabled = true; }
  try { await fn(); } catch (e) {
    say(e instanceof AccountError || e instanceof CatwalkError ? e.message : 'Something went wrong: ' + (e?.message || e), 'err');
  } finally { if (btn) btn.disabled = false; }
}

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-add],[data-remove],[data-poke],[data-del],#logout,#settings-toggle');
  if (!a) return;
  ev.preventDefault();
  if (a.id === 'logout') { app.lock(); session?.destroy(); session = null; location.hash = '#/'; say('Signed out.'); return; }
  if (a.id === 'settings-toggle') { $('settings').hidden = !$('settings').hidden; return; }
  if (!session) { say('Sign in first.', 'err'); return; }
  run(() => {
    if (a.dataset.add) { app.addFriend(a.dataset.add); say(app.isFriend(session.pk, a.dataset.add) ? `You and ${app.displayName(a.dataset.add)} are now friends.` : `Friend request sent to ${app.displayName(a.dataset.add)}.`); }
    else if (a.dataset.remove) { app.removeFriend(a.dataset.remove); say(`${app.displayName(a.dataset.remove)} removed. Your friends-only posts are re-keyed without them.`); }
    else if (a.dataset.poke) { app.poke(a.dataset.poke); say(`You poked ${app.displayName(a.dataset.poke)}.`); }
    else if (a.dataset.del) { app.deletePost(a.dataset.del); say('Post deleted.'); }
  }, a);
});

document.addEventListener('submit', (ev) => {
  const f = ev.target;
  if (f.id === 'search') { ev.preventDefault(); location.hash = '#/search/' + encodeURIComponent($('q').value.trim()); return; }
  if (f.id === 'settings') {
    ev.preventDefault();
    const list = $('trackers').value.split(/\s+/).filter((s) => /^wss?:\/\//.test(s));
    if (!list.length) return say('Enter at least one ws:// or wss:// tracker.', 'err');
    try { localStorage.setItem(TRACKERS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
    connect(list); say('Reconnected.'); return;
  }
  if (!['form-login', 'form-register', 'form-post', 'form-profile', 'form-password'].includes(f.id)) return;
  ev.preventDefault();
  const btn = f.querySelector('button[type="submit"]');
  run(async () => {
    if (f.id === 'form-login') {
      session = await accounts.login(f.username.value, f.password.value);
      app.unlock(session);
      try { app.reconcile(); } catch { /* ignore */ }
      if (!app.profile(session.pk)) { location.hash = '#/edit'; say('Welcome! Tell the other cats who you are.'); }
      else { location.hash = '#/'; say(`Signed in as ${app.displayName(session.pk)}.`); }
    } else if (f.id === 'form-register') {
      if (f.password.value !== f.confirm.value) throw new CatwalkError('mismatch', 'The two passwords differ.');
      session = await accounts.register(f.username.value, f.password.value);
      app.unlock(session);
      app.setProfile({ name: f.name.value, fur: f.fur.value, eyes: f.eyes.value });
      location.hash = '#/';
      say(`Welcome to Catwalk, ${esc(f.name.value)}! Your account now lives in every open copy of this page.`);
    } else if (f.id === 'form-post') {
      app.post(f.text.value, f.aud.value);
      f.reset();
      say(f.aud.value === 'public' ? 'Posted to everyone.' : 'Posted to your friends.');
    } else if (f.id === 'form-profile') {
      app.setProfile({ name: f.name.value, tagline: f.tagline.value, about: f.about.value, fur: f.fur.value, eyes: f.eyes.value });
      location.hash = '#/profile/' + session.pk;
      say('Profile saved.');
    } else if (f.id === 'form-password') {
      await accounts.changePassword(session, f.current.value, f.next.value);
      f.reset();
      say('Password changed. Your key, friends and posts are unchanged.');
    }
  }, btn);
});
document.addEventListener('input', (ev) => {
  const f = ev.target.closest('#form-profile');
  if (!f || !session) return;
  $('preview').innerHTML = catSvg({ fur: f.fur.value, eyes: f.eyes.value, seed: session.pk }, 120).replace('<svg ', '<svg class="avatar big" ');
});

// --- boot -------------------------------------------------------------------
const trackers = loadTrackers();
$('trackers').value = trackers.join('\n');
render();
connect(trackers);
setInterval(renderSwarm, 3000);
window.addEventListener('pagehide', () => { try { client?.destroy(); } catch { /* ignore */ } });
