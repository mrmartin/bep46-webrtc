// Local WebSocket tracker for development: ws://127.0.0.1:8000
// Equivalent to `npx bittorrent-tracker --ws --port 8000` but with HTTP/UDP off.
// (Production: your own wss:// tracker behind nginx/Caddy — see README.)
import { Server } from 'bittorrent-tracker';

export function startTracker({ port = 8000, host = '127.0.0.1' } = {}) {
  const server = new Server({ udp: false, http: false, ws: true, stats: false, interval: 30_000 });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const p = server.ws?.address?.()?.port ?? server.http?.address?.()?.port ?? port;
      resolve({ server, url: `ws://${host}:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('tracker.js')) {
  const port = Number(process.argv[2] || process.env.PORT || 8000);
  const { url } = await startTracker({ port });
  console.log(`tracker listening at ${url}`);
}
