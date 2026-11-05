// Protocol-level test of the hosted tracker, speaking exactly what a browser
// WebTorrent client speaks (bittorrent-tracker's WebSocket announce dialect):
// two "browsers" announce to the same info-hash; A's WebRTC offer must be
// relayed to B, and B's answer relayed back to A. No real WebRTC needed.
//
//   node test-ws.js ws://127.0.0.1:8001        (or wss://bot.martintech.co.uk)
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

const url = process.argv[2] || 'ws://127.0.0.1:8001';
const infoHash = randomBytes(20).toString('binary');       // 20-byte binary string, as browsers send it
const peerId = () => '-WW0100-' + randomBytes(6).toString('hex'); // 20 bytes
const bin = (s) => s;
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const timer = setTimeout(() => fail('timed out after 10s'), 10_000);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin: 'https://example.invalid' } });
    const got = [];
    ws.on('open', () => resolve({ ws, got, name }));
    ws.on('error', reject);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); got.push(m); ws.emit('msg', m); });
  });
}
const waitFor = (c, pred) => new Promise((r) => {
  const hit = c.got.find(pred); if (hit) return r(hit);
  c.ws.on('msg', (m) => { if (pred(m)) r(m); });
});

const A = await connect('A'), B = await connect('B');
const aId = peerId(), bId = peerId();
const offerId = randomBytes(20).toString('binary');

// A announces with one WebRTC offer, B announces with none (like a visitor).
A.ws.send(JSON.stringify({ action: 'announce', info_hash: bin(infoHash), peer_id: aId, event: 'started',
  numwant: 1, uploaded: 0, downloaded: 0, left: 0,
  offers: [{ offer: { type: 'offer', sdp: 'v=0 fake-sdp-from-A' }, offer_id: offerId }] }));
const aResp = await waitFor(A, (m) => m.action === 'announce' && m.interval);
console.log('A announce reply: interval=' + aResp.interval + ' complete=' + aResp.complete + ' incomplete=' + aResp.incomplete);

B.ws.send(JSON.stringify({ action: 'announce', info_hash: bin(infoHash), peer_id: bId, event: 'started',
  numwant: 1, uploaded: 0, downloaded: 0, left: 1, offers: [] }));
const bResp = await waitFor(B, (m) => m.action === 'announce' && m.interval);
console.log('B announce reply: interval=' + bResp.interval + ' complete=' + bResp.complete + ' incomplete=' + bResp.incomplete);

// B then re-announces with an offer; the tracker should hand that offer to A.
const offerId2 = randomBytes(20).toString('binary');
B.ws.send(JSON.stringify({ action: 'announce', info_hash: bin(infoHash), peer_id: bId,
  numwant: 1, uploaded: 0, downloaded: 0, left: 1,
  offers: [{ offer: { type: 'offer', sdp: 'v=0 fake-sdp-from-B' }, offer_id: offerId2 }] }));
const relayed = await waitFor(A, (m) => m.offer);
if (relayed.peer_id !== bId) fail('offer relayed to A came from wrong peer');
if (relayed.offer.sdp !== 'v=0 fake-sdp-from-B') fail('offer sdp mangled');
console.log('A received B\'s offer  (peer_id matches, sdp intact)');

// A answers; the tracker must route the answer back to B.
A.ws.send(JSON.stringify({ action: 'announce', info_hash: bin(infoHash), peer_id: aId, to_peer_id: bId,
  answer: { type: 'answer', sdp: 'v=0 fake-answer-from-A' }, offer_id: relayed.offer_id }));
const ans = await waitFor(B, (m) => m.answer);
if (ans.peer_id !== aId) fail('answer came from wrong peer');
if (ans.answer.sdp !== 'v=0 fake-answer-from-A') fail('answer sdp mangled');
console.log('B received A\'s answer (peer_id matches, sdp intact)');

// scrape must count both.
A.ws.send(JSON.stringify({ action: 'scrape', info_hash: bin(infoHash) }));
const sc = await waitFor(A, (m) => m.action === 'scrape');
const row = Object.values(sc.files)[0];
console.log('scrape: complete=' + row.complete + ' incomplete=' + row.incomplete);
if (row.complete + row.incomplete !== 2) fail('scrape does not show 2 peers');

A.ws.close(); B.ws.close(); clearTimeout(timer);
console.log('PASS: ' + url + ' relays WebRTC offers/answers between peers');
process.exit(0);
