'use strict';
/* Local test infrastructure: a WebSocket tracker (bittorrent-tracker) plus a static
   file server for the repo root.  Used by test/e2e.js and handy for manual testing:
     node test/serve.js            → prints URLs; open call.html?tracker=ws://127.0.0.1:PORT&ice=none  */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server: Tracker } = require('bittorrent-tracker');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function startTracker(port = 0) {
  return new Promise((resolve, reject) => {
    const t = new Tracker({ http: false, udp: false, ws: true, stats: false, trustProxy: false });
    t.on('error', reject); t.on('warning', () => {});
    t.listen(port, () => { t.removeListener('error', reject); resolve({ tracker: t, port: t.http.address().port, url: 'ws://127.0.0.1:' + t.http.address().port }); });
  });
}
function startStatic(port = 0, root = ROOT) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/call.html';
      const fp = path.normalize(path.join(root, p));
      if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    });
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}
module.exports = { startTracker, startStatic, ROOT };

if (require.main === module) {
  (async () => {
    const t = await startTracker(Number(process.env.TRACKER_PORT || 8000));
    const s = await startStatic(Number(process.env.PORT || 8080));
    console.log('tracker  ' + t.url);
    console.log('page     ' + s.url + '/call.html?tracker=' + encodeURIComponent(t.url) + '&ice=none');
  })().catch(e => { console.error(e); process.exit(1); });
}
