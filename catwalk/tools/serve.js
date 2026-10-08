// Static server for development, rooted at the REPO root so web/ can load
// ../../accounts/vendor/* and ../src → ../../accounts/src resolve.
//   node tools/serve.js [port]      → http://127.0.0.1:8081/catwalk/web/
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createStaticServer() {
  return http.createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/catwalk/web/';
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(resolve(root, '.' + path));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8081);
  createStaticServer().listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}/catwalk/web/`));
}
