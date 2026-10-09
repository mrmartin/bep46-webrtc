// WebSocket tracker for bep46-webrtc, built on the stock `bittorrent-tracker`
// package (the same one the repo's accounts/tools/tracker.js and tests use).
//
//   node tracker.js [port]        default 3000; PORT env also honoured
//
// Routes (all on one port, TLS is terminated by the parent nginx):
//   WS   /              WebTorrent WebSocket announce (what browsers use)
//   GET  /announce      classic HTTP announce (Node clients / curl tests); /scrape too
//   GET  /stats         bittorrent-tracker's stats page; /stats.json gets a CORS
//                       header here so the project site can show live numbers
//   GET  /status        plain-text status (what this is, swarm/peer counts)
//   GET  /catwalk/      the built single-file Catwalk (catwalk/dist/index.html)
//   GET  /accounts/     the built single-file Swarm Registry (accounts/dist/index.html)
//                       (`npm run build` in each; without the build these fall
//                       through to the static tree below, i.e. the unbuilt app)
//   GET  /...           everything else: this checkout as a static site, the same
//                       tree GitHub Pages serves (the landing page index.html,
//                       bep46-webrtc.html, the apps' web/, src/ and vendor/).
//                       html/js/css/json/svg/png/md/txt only; no dotfiles, no node_modules.
import { Server } from 'bittorrent-tracker';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, normalize, extname, sep } from 'node:path';

const port = Number(process.argv[2] || process.env.PORT || 3000);
const host = '0.0.0.0';
const PUBLIC_WS = process.env.PUBLIC_WS || 'wss://bot.martintech.co.uk';
const PUBLIC_HTTP = PUBLIC_WS.replace(/^ws/, 'http');
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));   // the git checkout
const BUILT = { '/catwalk': 'catwalk/dist/index.html', '/accounts': 'accounts/dist/index.html' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const server = new Server({
  udp: false,          // browsers cannot use it and the parent only forwards TCP
  http: true,          // /announce + /scrape + /stats (also hosts the ws upgrade)
  ws: true,            // WebRTC signalling for browsers
  stats: true,
  trustProxy: true,    // real client IP from X-Forwarded-For set by nginx
  interval: 120_000,   // re-announce interval told to clients (ms)
});

let VERSION = '?';
try { VERSION = JSON.parse(readFileSync(new URL('./node_modules/bittorrent-tracker/package.json', import.meta.url))).version; } catch {}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
// Sends a regular file; false (and nothing written) if it is not one.
function sendFile(res, head, file, type) {
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
  if (head) res.end(); else createReadStream(file).pipe(res);
  return true;
}

// Our handler must run first: bittorrent-tracker registers its /stats handler
// synchronously in the constructor and its announce/scrape handler on the next
// tick, and each of them skips a request whose headers are already written.
// So: prepend, answer synchronously, or only set headers and return to let the
// library answer (that is how /stats.json gets its CORS header).
server.http.prependListener('request', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const head = req.method === 'HEAD';
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return text(res, 400, 'bad path\n'); }

  if (path === '/announce' || path === '/scrape' || path === '/stats') return;              // the library's
  if (path === '/stats.json') { res.setHeader('access-control-allow-origin', '*'); return; } // library answers, header rides along

  if (path === '/status') {
    const swarms = Object.keys(server.torrents).length;
    let peers = 0;
    for (const t of Object.values(server.torrents)) peers += t.peers.length;
    return text(res, 200, [
      'bep46-webrtc tracker (bittorrent-tracker ' + VERSION + ')',
      '',
      'announce (browsers, WebRTC): ' + PUBLIC_WS,
      'announce (http):             ' + PUBLIC_HTTP + '/announce',
      'stats:                       ' + PUBLIC_HTTP + '/stats',
      'the project site:            ' + PUBLIC_HTTP + '/',
      'page publisher:              ' + PUBLIC_HTTP + '/bep46-webrtc.html',
      'catwalk (example app):       ' + PUBLIC_HTTP + '/catwalk/',
      'swarm registry (accounts):   ' + PUBLIC_HTTP + '/accounts/',
      '',
      'swarms: ' + swarms + '   peers: ' + peers,
      '',
      'source: https://github.com/mrmartin/bep46-webrtc',
      '',
    ].join('\n'));
  }

  // The built single-file apps, when built.
  const app = path.replace(/\/index\.html$/, '/').replace(/\/$/, '');
  if (BUILT[app] && sendFile(res, head, resolve(ROOT, BUILT[app]), TYPES['.html'])) return;

  // The checkout as a static site.
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(resolve(ROOT, '.' + path));
  if (!file.startsWith(ROOT + sep)) return text(res, 403, 'forbidden\n');
  const parts = file.slice(ROOT.length + 1).split(sep);
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return text(res, 404, 'not found\n');
  const type = TYPES[extname(file).toLowerCase()];
  if (type && sendFile(res, head, file, type)) return;
  try {
    if (statSync(file).isDirectory()) { res.writeHead(301, { location: path + '/' }); return res.end(); }
  } catch {}
  text(res, 404, 'not found\n');
});

server.on('error', (err) => console.error('tracker error:', err.message));
server.on('warning', (err) => console.warn('tracker warning:', err.message));
server.on('listening', () => {
  console.log(`tracker listening on ${host}:${port}  (ws + http announce, public ${PUBLIC_WS}; serving ${ROOT})`);
});
server.on('start', (_addr, params) => {
  if (params && params.info_hash) console.log(`start  ${params.ip || '?'}  swarm ${params.info_hash.toString('hex').slice(0, 12)}…`);
});
server.listen(port, host);
