import WebTorrent from '../vendor/webtorrent.min.js';
import { configureBrowser } from '../src/env-browser.js';
import { Directory, webStorageStore, memoryStore } from '../src/directory.js';
import { Accounts, AccountError } from '../src/accounts.js';
import { Replica } from '../src/replica.js';
import { WebTorrentTransport, DIRECTORY_CHANNEL, DEFAULT_TRACKERS } from '../src/transport-webtorrent.js';
import { fingerprint } from '../src/records.js';
import { DEFAULT_KDF } from '../src/crypto.js';

configureBrowser();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// --- settings -----------------------------------------------------------
const SETTINGS_KEY = 'p2p-accounts:v1:trackers';
function loadTrackers() {
  const fromUrl = params.getAll('tracker').filter(Boolean);
  if (fromUrl.length) return fromUrl;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* ignore */ }
  return DEFAULT_TRACKERS;
}
function saveTrackers(list) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// Test hook: a weaker scrypt cost, only honoured on localhost so a hostile
// link cannot talk a real deployment into sealing keys weakly.
let kdf = DEFAULT_KDF;
if (isLocal && params.has('kdf')) {
  const n = Number(params.get('kdf'));
  if (Number.isInteger(n) && n >= 10 && n <= 20) kdf = { ...DEFAULT_KDF, N: 1 << n };
}

// --- model --------------------------------------------------------------
let store;
try {
  localStorage.setItem('p2p-accounts:probe', '1');
  localStorage.removeItem('p2p-accounts:probe');
  store = webStorageStore(localStorage);
} catch {
  store = memoryStore();
  log('Browser storage is unavailable; this copy will not keep the directory between reloads.');
}
if (params.has('fresh')) { try { localStorage.removeItem('p2p-accounts:v1:records'); store = webStorageStore(localStorage); } catch { /* ignore */ } }

const directory = new Directory({ store });
const accounts = new Accounts({ directory, kdf });
let client = null;
let transport = null;
let replica = null;
let session = null;
const freshKeys = new Set();

function connect(trackers) {
  if (replica) replica.stop();
  if (client) client.destroy();
  client = new WebTorrent({ dht: false, lsd: false });
  transport = new WebTorrentTransport({
    client, infoHash: DIRECTORY_CHANNEL, announce: trackers,
    log: (...a) => log(a.join(' ')),
  });
  transport.on('peerchange', renderSwarm);
  transport.on('tracker', renderSwarm);
  replica = new Replica({ directory, transport, heartbeatMs: 15000, log: (...a) => log(a.join(' ')) }).start();
  client.on('error', (e) => log('client error: ' + (e?.message || e)));
  renderSwarm();
  log(`Joined channel ${DIRECTORY_CHANNEL.slice(0, 12)}… via ${trackers.length} tracker(s)`);
  window.__registry = { directory, accounts, transport, replica, client, get session() { return session; } };
}

directory.onChange((record, { local }) => {
  freshKeys.add(record.pk);
  setTimeout(() => { freshKeys.delete(record.pk); renderLedger(); }, 2500);
  renderLedger();
  if (session && record.pk === session.pk && !local) {
    if (record.deleted) {
      signOut();
      setMessage('This account was deleted from another device. You have been signed out.', 'err');
    } else {
      setMessage('Your account record was updated from another device.', 'ok');
    }
  }
});

// --- rendering ----------------------------------------------------------
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function renderSwarm() {
  const peers = transport?.peerCount() ?? 0;
  const trackers = Object.entries(transport?.status.trackers || {});
  const connected = trackers.filter(([, s]) => s === 'connected').length;
  const dot = $('swarm-dot');
  dot.className = 'dot ' + (peers > 0 ? 'live' : connected > 0 ? '' : trackers.length ? 'down' : '');
  const n = directory.listUsers().length;
  const parts = [];
  parts.push(peers === 0 ? 'No peers yet' : `Talking to <strong>${peers} peer${peers === 1 ? '' : 's'}</strong>`);
  parts.push(`${n} account${n === 1 ? '' : 's'} on file`);
  if (trackers.length) parts.push(`${connected} of ${trackers.length} tracker${trackers.length === 1 ? '' : 's'} reachable`);
  $('swarm-text').innerHTML = parts.join('. ') + '.';
  $('swarm').dataset.peers = String(peers);
}

function renderLedger() {
  const users = directory.listUsers();
  const body = $('ledger-body');
  body.replaceChildren();
  const contested = new Set();
  const seen = new Map();
  for (const u of users) { if (seen.has(u.user)) { contested.add(u.user); } seen.set(u.user, true); }
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.dataset.pk = u.pk;
    tr.dataset.user = u.user;
    if (session && u.pk === session.pk) tr.classList.add('me');
    if (contested.has(u.user)) tr.classList.add('contested');
    if (freshKeys.has(u.pk)) tr.classList.add('fresh');
    tr.innerHTML = `
      <td>${esc(u.user)}</td>
      <td><span class="key" title="${u.pk}">${fingerprint(u.pk)}</span></td>
      <td class="num">${u.seq}</td>
      <td>${u.seq === 1 ? fmtTime(u.ts) : '—'}</td>
      <td>${fmtTime(u.ts)}</td>`;
    body.appendChild(tr);
  }
  $('ledger-empty').hidden = users.length > 0;
  $('ledger').hidden = users.length === 0;
  $('ledger-count').textContent = users.length ? `${users.length} live` : '';

  const tombs = directory.listTombstones();
  $('tombstones').hidden = tombs.length === 0;
  $('tombstone-count').textContent = String(tombs.length);
  $('tombstone-list').replaceChildren(...tombs.map((t) => {
    const li = document.createElement('li');
    li.innerHTML = `${esc(t.user)} <span class="key">${fingerprint(t.pk)}</span> — deleted ${fmtTime(t.ts)}`;
    return li;
  }));
  renderSwarm();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function log(text) {
  const li = document.createElement('li');
  const t = document.createElement('time');
  t.textContent = new Date().toLocaleTimeString();
  li.append(t, document.createTextNode(text));
  const ol = $('log');
  ol.prepend(li);
  while (ol.children.length > 200) ol.lastChild.remove();
}

function setMessage(text, kind = '') {
  const m = $('message');
  m.textContent = text;
  m.className = 'message ' + kind;
}

function renderSession() {
  const on = !!session;
  $('signed-in').hidden = !on;
  $('signed-out').hidden = on;
  if (on) {
    $('me-username').textContent = session.username;
    $('me-fingerprint').textContent = 'key ' + fingerprint(session.pk);
  }
  renderLedger();
}

function signOut() {
  session?.destroy();
  session = null;
  renderSession();
  selectTab('login');
}

// --- forms --------------------------------------------------------------
async function busy(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  setMessage('');
  try {
    await fn();
  } catch (e) {
    setMessage(e instanceof AccountError ? e.message : 'Something went wrong: ' + (e?.message || e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function selectTab(which) {
  const login = which === 'login';
  $('tab-login').setAttribute('aria-selected', String(login));
  $('tab-register').setAttribute('aria-selected', String(!login));
  $('form-login').hidden = !login;
  $('form-register').hidden = login;
  setMessage('');
}
$('tab-login').addEventListener('click', () => selectTab('login'));
$('tab-register').addEventListener('click', () => selectTab('register'));

$('form-register').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  busy(f, async () => {
    if (f.password.value !== f.confirm.value) throw new AccountError('mismatch', 'The two passwords differ.');
    session = await accounts.register(f.username.value, f.password.value);
    f.reset();
    renderSession();
    setMessage(`Account "${session.username}" created and published to ${transport.peerCount()} peer(s).`, 'ok');
  });
});

$('form-login').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  busy(f, async () => {
    session = await accounts.login(f.username.value, f.password.value);
    f.reset();
    renderSession();
    setMessage(`Signed in as ${session.username}.`, 'ok');
  });
});

$('form-password').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  busy(f, async () => {
    if (f.next.value !== f.confirm.value) throw new AccountError('mismatch', 'The two new passwords differ.');
    const rec = await accounts.changePassword(session, f.current.value, f.next.value);
    f.reset();
    setMessage(`Password changed (record version ${rec.seq}).`, 'ok');
  });
});

$('form-delete').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  busy(f, async () => {
    const name = session.username;
    await accounts.deleteAccount(session, f.password.value);
    f.reset();
    session = null;
    renderSession();
    setMessage(`Account "${name}" deleted.`, 'ok');
  });
});

$('signout').addEventListener('click', () => { signOut(); setMessage('Signed out.', 'ok'); });

$('settings-toggle').addEventListener('click', () => {
  const s = $('settings');
  s.hidden = !s.hidden;
  $('settings-toggle').setAttribute('aria-expanded', String(!s.hidden));
});
$('settings').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const list = $('trackers').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
  if (!list.length) { setMessage('Enter at least one ws:// or wss:// tracker address.', 'err'); return; }
  saveTrackers(list);
  connect(list);
});

// --- boot ---------------------------------------------------------------
const trackers = loadTrackers();
$('trackers').value = trackers.join('\n');
$('channel-hint').textContent = `channel ${DIRECTORY_CHANNEL}`;
renderSession();
connect(trackers);
setInterval(renderSwarm, 3000);
window.addEventListener('pagehide', () => { try { client?.destroy(); } catch { /* ignore */ } });
