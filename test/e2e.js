'use strict';
/*  End-to-end test: real headless Chromium tabs (separate browser contexts, fake
    camera and microphone), a local WebSocket tracker, the real call.html.
      1. three participants join the same link and see each other
      2. video and audio flow between all of them (WebCodecs → data channels → canvas/worklet)
      3. with the publisher's relay budget throttled, the third viewer is served by the second (depth 2)
      4. the relay leaves → the viewer recovers through a new parent
      5. everyone leaves → the same link works again for new participants
    Needs `playwright` resolvable (npm i -D playwright && npx playwright install chromium).   */
const path = require('path');
const fs = require('fs');
const { startTracker, startStatic } = require('./serve');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('playwright is not installed: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const NM = path.join(__dirname, '..', 'node_modules');
const VENDOR = {
  'webtorrent.min.js': path.join(NM, 'webtorrent', 'webtorrent.min.js'),
  'nacl.min.js': path.join(NM, 'tweetnacl', 'nacl.min.js')
};
const LAUNCH_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection',
  '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 45000);
const failures = [];
const results = [];
function ok(cond, msg, extra) { results.push({ ok: !!cond, msg, extra }); console.log((cond ? '  ✔ ' : '  ✘ ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) failures.push(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(page, fn, arg, label, timeout = TIMEOUT) {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 250 }); return true; }
  catch (e) { console.log('  … timeout waiting for ' + label); return false; }
}
const stats = p => (p.page || p).evaluate(() => window.__call.stats());

(async () => {
  const t0 = Date.now();
  const trk = await startTracker();
  const web = await startStatic();
  console.log('tracker ' + trk.url + ', pages ' + web.url);
  const browser = await chromium.launch({ args: LAUNCH_ARGS, executablePath: process.env.CHROMIUM_PATH || undefined });
  const contexts = [];
  const pageLogs = new Map();

  async function openParticipant(name, hash, extraQuery = '') {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    contexts.push(ctx);
    await ctx.route(/https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\/.*/, route => {
      const file = Object.keys(VENDOR).find(k => route.request().url().endsWith(k));
      if (file) route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(VENDOR[file]) });
      else route.fulfill({ status: 204, body: '' });
    });
    await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, route => route.fulfill({ status: 204, body: '' }));
    const page = await ctx.newPage();
    const logs = []; pageLogs.set(name, logs);
    page.on('console', m => { const txt = m.text(); logs.push(txt); if (process.env.E2E_VERBOSE) console.log('   [' + name + '] ' + txt); });
    page.on('pageerror', e => { logs.push('PAGEERROR ' + e.message); console.log('   [' + name + '] PAGE ERROR ' + e.message); });
    const url = web.url + '/call.html?tracker=' + encodeURIComponent(trk.url) + '&ice=none&name=' + encodeURIComponent(name) + '&vh=640x360x15x500&vl=320x180x10x100' + extraQuery + (hash ? '#' + hash : '');
    await page.goto(url);
    await page.waitForFunction(() => window.__call && document.getElementById('goBtn') && !document.getElementById('goBtn').disabled, null, { timeout: 15000 });
    return { page, ctx, name };
  }
  async function join(p) {
    await p.page.click('#goBtn');
    await p.page.waitForFunction(() => !document.getElementById('call').hidden, null, { timeout: 15000 });
    return p.page.evaluate(() => window.__call.secret);
  }

  try {
    /* ── 1. three participants on one link ───────────────────────────────── */
    console.log('\n1. three participants join one link');
    const A = await openParticipant('Ann', '', '&budget=260');            // Ann can afford one low-video child + audio only
    const secret = await join(A);
    const link = await A.page.evaluate(() => window.__call.link());
    ok(link.includes('#' + secret) && secret.length >= 20, 'call link created', { link: link.replace(/^http:\/\/[^/]+/, '') });
    const B = await openParticipant('Bob', secret);
    await join(B);
    const bSeesA = await waitFor(B.page, () => window.__call.stats().roster.length >= 1, null, 'Bob sees Ann');
    ok(bSeesA, 'second participant discovers the first through the tracker', { ms: Date.now() - t0 });
    const C = await openParticipant('Cat', secret);
    await join(C);
    const all3 = await Promise.all([A, B, C].map(p => waitFor(p.page, () => window.__call.stats().roster.length >= 2, null, p.name + ' sees 2 others')));
    ok(all3.every(Boolean), 'all three see a roster of three', { roster: (await stats(A)).roster.map(r => r.name).sort() });
    ok((await stats(A)).roster.every(r => r.streams.includes('vh') && r.streams.includes('vl') && r.streams.includes('a')), 'presence advertises two video renditions and audio');

    /* ── 2. media flows ─────────────────────────────────────────────────── */
    console.log('\n2. video and audio flow');
    const flowing = await Promise.all([A, B, C].map(p => waitFor(p.page, () => { const s = window.__call.stats(); return s.tiles.length >= 2 && s.tiles.every(t => t.drawn >= 10); }, null, p.name + ' draws frames from both others')));
    ok(flowing.every(Boolean), 'every participant renders video from both others');
    const audio = await Promise.all([A, B, C].map(p => waitFor(p.page, () => { const s = window.__call.stats(); return s.audio.length >= 2 && s.audio.every(a => a.decoded >= 25); }, null, p.name + ' decodes audio from both others')));
    ok(audio.every(Boolean), 'every participant decodes audio from both others');
    const sA = await stats(A), sB = await stats(B), sC = await stats(C);
    for (const [n, s] of [['Ann', sA], ['Bob', sB], ['Cat', sC]]) {
      console.log('   ' + n + ': ' + s.tiles.map(t => t.name + ':' + t.rendition + ' ' + t.drawn + 'f ' + t.w + 'x' + t.h + ' lat ' + Math.round(t.latencyMs || 0) + 'ms' + (t.loss ? ' loss' + t.loss : '') + (t.errors ? ' err' + t.errors : '')).join(' | ')
        + ' | audio ' + s.audio.map(a => a.decoded + 'f q' + Math.round(a.queuedMs) + 'ms u' + a.under).join(',') + ' | pub ' + (s.pub.video && s.pub.video.codec) + ' ' + JSON.stringify(s.pub.video && s.pub.video.encoded));
    }
    ok([sA, sB, sC].every(s => s.pub.video && s.pub.video.codec && s.pub.video.encoded.vh > 20 && s.pub.video.encoded.vl > 5), 'each participant encodes both renditions');
    ok([sA, sB, sC].some(s => s.tiles.some(t => t.rendition === 'vh')) && [sA, sB, sC].every(s => s.tiles.some(t => t.rendition === 'vl')), 'stage gets the full rendition, thumbnails the low one');
    const lat = [sA, sB, sC].flatMap(s => s.tiles.map(t => t.latencyMs)).filter(x => typeof x === 'number');
    ok(lat.length && Math.max(...lat) < 2500, 'capture-to-canvas latency stays conversational on this machine', { maxMs: Math.round(Math.max(...lat)), minMs: Math.round(Math.min(...lat)) });
    ok([sA, sB, sC].every(s => s.audio.every(a => a.under <= 20)), 'audio playback underruns stay rare', { under: [sA, sB, sC].map(s => s.audio.map(a => a.under)) });

    /* ── 2b. sustained flow for ten seconds ─────────────────────────────── */
    console.log('\n2b. ten seconds of steady state');
    const snap = async () => { const r = {}; for (const p of [A, B, C]) { const s = await stats(p); r[p.name] = { tiles: Object.fromEntries(s.tiles.map(t => [t.name, t.drawn])), audio: Object.fromEntries(s.audio.map(a => [a.id, a.decoded])), under: Object.fromEntries(s.audio.map(a => [a.id, a.under])) }; } return r; };
    const s0 = await snap(); const tSoak = Date.now(); await sleep(10000); const s1 = await snap(); const soakS = (Date.now() - tSoak) / 1000;
    const vidRates = [], audRates = [], underDelta = [];
    for (const n of Object.keys(s1)) {
      for (const k of Object.keys(s1[n].tiles)) if (k in s0[n].tiles) vidRates.push({ at: n, of: k, fps: +((s1[n].tiles[k] - s0[n].tiles[k]) / soakS).toFixed(1) });
      for (const k of Object.keys(s1[n].audio)) if (k in s0[n].audio) { audRates.push(+((s1[n].audio[k] - s0[n].audio[k]) / soakS).toFixed(1)); underDelta.push((s1[n].under[k] || 0) - (s0[n].under[k] || 0)); }
    }
    console.log('   video fps: ' + vidRates.map(v => v.at + '←' + v.of + ' ' + v.fps).join(', '));
    console.log('   audio frames/s (50 expected): ' + audRates.join(', ') + ' | new underruns: ' + underDelta.join(','));
    ok(vidRates.length >= 6 && vidRates.every(v => v.fps >= 3), 'every video tile keeps drawing (≥3 fps on this shared CPU)');
    ok(audRates.length >= 6 && audRates.every(r => r >= 40), 'audio keeps decoding at nearly 50 frames per second for every speaker');
    ok(underDelta.every(u => u <= 3), 'audio playback stays continuous');

    /* ── 3. relay: Ann's budget forces one of her viewers onto the other ─── */
    console.log('\n3. relaying through a viewer');
    const relayed = await waitFor(C.page, () => { const s = window.__call.stats(); return s.node.streams.some(x => !x.local && x.depth >= 2 && x.framesIn > 20); }, null, 'a stream at depth 2 on Cat', TIMEOUT)
      || await waitFor(B.page, () => { const s = window.__call.stats(); return s.node.streams.some(x => !x.local && x.depth >= 2 && x.framesIn > 20); }, null, 'a stream at depth 2 on Bob', 5000);
    const sA2 = await stats(A), sB2 = await stats(B), sC2 = await stats(C);
    const names = { [sA2.id]: 'Ann', [sB2.id]: 'Bob', [sC2.id]: 'Cat' };
    const tree = s => s.node.streams.map(x => (x.local ? 'own ' : names[x.pub] + '/') + x.track + (x.local ? '' : ' d' + x.depth + '<' + (names[x.parent] || (x.pending ? 'pending' : '-')) + ' in' + x.chunksIn + (x.dropped ? ' lost' + x.dropped : '')) + (x.children ? ' →' + x.children + ' out' + x.chunksOut + (x.congDrops ? ' cong' + x.congDrops : '') + (x.sendErrors ? ' err' + x.sendErrors : '') : '')).join(', ');
    for (const [n, s] of [['Ann', sA2], ['Bob', sB2], ['Cat', sC2]]) console.log('   ' + n + ' streams: ' + tree(s) + '\n        links ' + s.node.links.map(l => names[l.peer] + ':' + l.state + (l.initiator ? '(i)' : '(r)') + ' rtt' + l.rtt + ' vbuf' + l.vidBuffered + ' abuf' + l.audBuffered).join(' '));
    const deepB = sB2.node.streams.filter(x => !x.local && x.depth >= 2), deepC = sC2.node.streams.filter(x => !x.local && x.depth >= 2);
    const deep = deepB.concat(deepC);
    ok(relayed && deep.length > 0, 'one of Ann\'s streams reaches a viewer via the other viewer (depth 2)', deep.map(d => ({ track: d.track, depth: d.depth, frames: d.framesIn, via: names[d.parent] })));
    const relayNode = deepC.length ? B : C;                                   // the deep stream's parent is the other viewer
    const victim = relayNode === B ? C : B;
    const relayStats = relayNode === B ? sB2 : sC2;
    ok(relayStats.node.streams.some(x => !x.local && x.children >= 1), 'the relaying viewer forwards a stream it receives', relayStats.node.streams.filter(x => !x.local && x.children).map(x => names[x.pub] + '/' + x.track + ' →' + x.children));
    ok(!deepB.some(b => deepC.some(c => b.track === c.track && b.pub === c.pub)), 'no relay cycle: a track is never relayed in both directions at once');
    const annTracks = sA2.node.streams.filter(x => x.local);
    ok(annTracks.some(x => x.children === 1) && sA2.node.used < 2 * annTracks.reduce((a, x) => a + x.br, 0), 'Ann serves at least one track once instead of twice (budget respected beyond the first child)', { used: sA2.node.used, budget: sA2.node.budget, children: annTracks.map(x => x.track + ':' + x.children) });

    /* ── 4. churn: the relay leaves, the viewer recovers ─────────────────── */
    console.log('\n4. relay leaves, viewer recovers');
    const before = (await stats(victim)).tiles.reduce((m, t) => Object.assign(m, { [t.name]: t.drawn }), {});
    await relayNode.page.evaluate(() => window.__call.leave());
    const gone = await waitFor(victim.page, n => window.__call.stats().roster.length === n, 1, 'roster shrinks to one other');
    ok(gone, 'departure is noticed from presence timeout');
    const recovered = await waitFor(victim.page, b => { const s = window.__call.stats(); return s.tiles.length === 1 && s.tiles[0].name === 'Ann' && s.tiles[0].drawn > b + 20 && s.node.streams.filter(x => !x.local && x.pub === s.tiles[0].id && x.track === s.tiles[0].rendition).every(x => x.depth === 1); }, before.Ann || 0, 'Ann\'s video flows again directly');
    const sv = await stats(victim);
    ok(recovered, 'Ann\'s stream is re-subscribed directly after the relay left', sv.node.streams.filter(x => !x.local).map(x => ({ track: x.track, depth: x.depth, frames: x.framesIn })));
    ok(sv.audio.length === 1 && sv.audio[0].decoded > 0, 'audio from the remaining participant still plays');

    /* ── 5. the link outlives the call ───────────────────────────────────── */
    console.log('\n5. the same link works for a new call');
    await A.page.evaluate(() => window.__call.leave());
    await victim.page.evaluate(() => window.__call.leave());
    await sleep(500);
    const D = await openParticipant('Dan', secret);
    await join(D);
    const E = await openParticipant('Eve', secret);
    await join(E);
    const again = await waitFor(D.page, () => { const s = window.__call.stats(); return s.roster.length === 1 && s.tiles.length === 1 && s.tiles[0].drawn > 5; }, null, 'Dan sees and watches Eve');
    ok(again, 'new participants meet on the old link and exchange video', { roster: (await stats(D)).roster.map(r => r.name) });
    ok(!Array.from(pageLogs.values()).some(l => l.some(x => x.startsWith('PAGEERROR'))), 'no uncaught page errors');
  } catch (e) {
    console.error('TEST CRASH', e);
    failures.push('crash: ' + e.message);
  } finally {
    if (failures.length || process.env.E2E_VERBOSE) {
      for (const [n, l] of pageLogs) { console.log('\n--- console of ' + n + ' (last 40) ---'); console.log(l.slice(-40).join('\n')); }
    }
    for (const c of contexts) { try { await c.close(); } catch (e) {} }
    await browser.close();
    trk.tracker.close(); web.server.close();
    console.log('\n' + (results.length - failures.length) + '/' + results.length + ' checks passed in ' + Math.round((Date.now() - t0) / 1000) + 's');
    process.exit(failures.length ? 1 : 0);
  }
})();
