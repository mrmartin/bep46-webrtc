// WebSocket tracker for bep46-webrtc, built on the stock `bittorrent-tracker`
// package (the same one the repo's accounts/tools/tracker.js and tests use).
//
//   node tracker.js [port]        default 3000; PORT env also honoured
//
// Routes (all on one port, TLS is terminated by the parent nginx):
//   GET  /            small status page (what this is, swarm/peer counts)
//   WS   /            WebTorrent WebSocket announce (what browsers use)
//   GET  /announce    classic HTTP announce (Node clients / curl tests)
//   GET  /stats       bittorrent-tracker's stats page (/stats.json too)
//   GET  /bep46-webrtc.html   the app from this checkout (uses this tracker by default)
import { Server } from 'bittorrent-tracker';
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2] || process.env.PORT || 3000);
const host = '0.0.0.0';
const PUBLIC_WS = process.env.PUBLIC_WS || 'wss://bot.martintech.co.uk';
const APP_HTML = new URL('../bep46-webrtc.html', import.meta.url);  // the app, one dir up

const server = new Server({
  udp: false,          // browsers cannot use it and the parent only forwards TCP
  http: true,          // /announce + /scrape + /stats (also hosts the ws upgrade)
  ws: true,            // WebRTC signalling for browsers
  stats: true,
  trustProxy: true,    // real client IP from X-Forwarded-For set by nginx
  interval: 120_000,   // re-announce interval told to clients (ms)
});

// Our own handler goes on first; bittorrent-tracker adds its default
// (/announce, /scrape, /stats, else 404) on the next tick and skips any
// request we already answered.
// It must answer synchronously (headers sent before the default handler runs).
server.http.on('request', (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const swarms = Object.keys(server.torrents).length;
    let peers = 0;
    for (const t of Object.values(server.torrents)) peers += t.peers.length;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end([
      'bep46-webrtc tracker (bittorrent-tracker ' + VERSION + ')',
      '',
      'announce (browsers, WebRTC): ' + PUBLIC_WS,
      'announce (http):             ' + PUBLIC_WS.replace(/^ws/, 'http') + '/announce',
      'stats:                       ' + PUBLIC_WS.replace(/^ws/, 'http') + '/stats',
      'app with this tracker:       ' + PUBLIC_WS.replace(/^ws/, 'http') + '/bep46-webrtc.html',
      '',
      'swarms: ' + swarms + '   peers: ' + peers,
      '',
      'source: https://github.com/mrmartin/bep46-webrtc',
      '',
    ].join('\n'));
  } else if (url.pathname === '/bep46-webrtc.html') {
    let html;
    try { html = readFileSync(APP_HTML); }
    catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('app html not found: ' + e.message + '\n');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }
});

let VERSION = '?';
try { VERSION = JSON.parse(readFileSync(new URL('./node_modules/bittorrent-tracker/package.json', import.meta.url))).version; } catch {}

server.on('error', (err) => console.error('tracker error:', err.message));
server.on('warning', (err) => console.warn('tracker warning:', err.message));
server.on('listening', () => {
  console.log(`tracker listening on ${host}:${port}  (ws + http announce, public ${PUBLIC_WS})`);
});
server.on('start', (_addr, params) => {
  if (params && params.info_hash) console.log(`start  ${params.ip || '?'}  swarm ${params.info_hash.toString('hex').slice(0, 12)}…`);
});
server.listen(port, host);
