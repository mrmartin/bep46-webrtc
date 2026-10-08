# The tracker

Browser peers cannot find each other on their own: WebRTC needs a signalling
channel, and in WebTorrent that channel is a **WebSocket tracker**. The public
ones are unreliable, so this project runs its own:

| | |
|---|---|
| announce (browsers) | `wss://bot.martintech.co.uk` |
| announce (Node / curl) | `https://bot.martintech.co.uk/announce` |
| status | <https://bot.martintech.co.uk/> |
| stats | <https://bot.martintech.co.uk/stats> (and `/stats.json`) |
| the app, served by the tracker | <https://bot.martintech.co.uk/bep46-webrtc.html> |

It is the first entry of `TRACKERS` in `bep46-webrtc.html` and of
`DEFAULT_TRACKERS` in `accounts/src/transport-webtorrent.js`; the two public
trackers stay in the list as fallbacks.

The tracker only ever sees an info-hash, a peer id and the WebRTC
offer/answer blobs it relays. Page content and account records never pass
through it.

## What it is

Nothing bespoke. It is the stock
[`bittorrent-tracker`](https://github.com/webtorrent/bittorrent-tracker)
package (the same one `accounts/tools/tracker.js` and the test-suite use), with
a 60-line launcher in [`tracker/tracker.js`](tracker/tracker.js) that:

- enables the WebSocket and HTTP announce endpoints, disables UDP,
- sets `trustProxy` so the real client IP is taken from `X-Forwarded-For`,
- serves a plain-text status page on `/` and this checkout's
  `bep46-webrtc.html`, leaving `/announce`, `/scrape` and `/stats` to the
  library.

## Run it yourself

```bash
cd tracker && npm install
node tracker.js 3000                 # ws://0.0.0.0:3000 (+ http announce)
node test-ws.js ws://127.0.0.1:3000  # protocol test, see below
```

Put TLS in front of it; browsers will only talk `wss://` from an `https://`
page. The nginx vhost needs the WebSocket upgrade headers and a read timeout
longer than the 120 s re-announce interval:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;   # required for WebSocket
    proxy_set_header   Connection "upgrade";       # required for WebSocket
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

Without the two `Upgrade`/`Connection` lines nginx forwards the handshake as
an ordinary GET, the tracker answers with its status page, and the browser
reports `Unexpected server response: 200`.

## Testing it

`tracker/test-ws.js` speaks the WebTorrent WebSocket dialect directly, without
a browser or real WebRTC: two fake peers announce to one random info-hash,
peer A's offer must be relayed to peer B, B's answer must be routed back to A,
and a scrape must count both. It takes the tracker URL as its argument, so it
works against a local instance or the public `wss://` one:

```bash
node tracker/test-ws.js wss://bot.martintech.co.uk
```

The end-to-end proof is the app itself: open
<https://bot.martintech.co.uk/bep46-webrtc.html> in two browsers (or one
normal + one private window), **Create** a page in one, **Visit** its address
in the other, and watch the peer count go to 1.

## Where it runs

`bot.martintech.co.uk` is a container on the `subtitlecat2` host. The tracker
is `supervisord`'s `app` program there (`/app/run-app.sh` → this checkout's
`tracker/tracker.js` on port 3000); the host's nginx terminates TLS and
proxies to the container. `git pull` in `/app/bep46-webrtc` and
`supervisorctl restart app` redeploys it.
