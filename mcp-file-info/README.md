# mcp-file-info

An MCP server with one job: take an image from the user and return what
`$ file image.png` prints for it.

```
image.png: PNG image data, 640 x 560, 8-bit/color RGB, non-interlaced
```

It is built on the current MCP specification revision (**2026-07-28**) with
the v2 TypeScript SDK (`@modelcontextprotocol/server` 2.3.x,
`@modelcontextprotocol/node` 2.1.x), served over Streamable HTTP. Clients that
still speak the 2025-era `initialize` handshake are served from the same
endpoint.

## The problem: MCP cannot carry the file

MCP has no client-to-server file transfer. Everything a client sends is a
JSON-RPC message, and the arguments of a `tools/call` are produced by the
model, token by token. A 1 MB PNG as base64 is 1.4 MB of text the model would
have to type out verbatim, which is slow, expensive, and unreliable. The
protocol's own "image" and "blob" content types only flow the other way
(server to client, inside tool results and resources).

This is a known gap, not an oversight on our side:

- The maintainers' discussion on passing files from the client
  (modelcontextprotocol discussion #1197) has been open since December 2024.
  The current advice there is to pass an opaque file handle into `tools/call`
  and move the bytes outside JSON-RPC.
- SEP-1306 (binary-mode elicitation) was closed in March 2026 as superseded by
  SEP-2356 (file inputs as data URIs), which was closed in June 2026 in favour
  of SEP-2631 (file objects plus `files/authorizeUpload` /
  `files/authorizeDownload`). SEP-2631 is still an open draft as of October
  2026 and is not part of the 2026-07-28 revision.
- The 2026-07-28 changelog adds nothing about binary input. Its "multi
  round-trip requests" let a tool ask for more input mid-call, but that input
  is still JSON.

So the file has to travel on a side channel. The options, from the ones the
spec can use today to the ones it cannot:

| Option | How the bytes move | When it fits |
|---|---|---|
| **Out-of-band upload with a handle (this server)** | Tool returns a one-time upload URL; user PUTs the file there over HTTP; the next tool call carries only the `upload_id`. | Remote or local servers, any size. This is the pattern SEP-2631 is standardising and the one Box ships today. |
| Local path | Tool takes a filesystem path; server reads it. | Only when the server runs on the same machine as the user's files (typically stdio). Supported here behind `FILE_INFO_ROOT`. |
| URL fetch | Tool takes an `https://` URL; server downloads it. | When the file is already hosted somewhere. Not implemented here. |
| Base64 in tool arguments | Model emits the bytes as text. | Tiny files only. Fine for a programmatic (non-LLM) client, not for a 1 MB image typed by a model. |
| URL-mode elicitation | Server returns a URL and the client opens it in a browser for the user to pick a file. | Same side channel as the first row, but with a web form instead of `curl`. Requires a host that implements URL elicitation. |

## How it works

```
model                 MCP server (this)                  user
  │ tools/call request_upload ─▶ reserve id, return URL   │
  │ ◀── upload_url, upload_id ──                          │
  │  "please run: curl -T image.png <upload_url>" ──────▶ │
  │                              ◀── PUT raw bytes ────── │  (plain HTTP, not MCP)
  │ tools/call file_info {upload_id} ─▶ run `file`        │
  │ ◀── "image.png: PNG image data, 640 x 560, ..."       │
```

Tools:

- `request_upload { filename? }` returns `{ upload_id, upload_url, method: "PUT", max_bytes, expires_at }`
  and a ready-to-paste `curl -T` command. Slots are single-use and expire
  after 10 minutes.
- `file_info { upload_id }` (or `{ path }` when `FILE_INFO_ROOT` is set) runs
  `file -b` and `file -b --mime-type` on the bytes and returns the
  `name: description` line as text plus `{ name, size_bytes, description, mime_type, file_output }`
  as structured content.

Endpoints:

- `POST /mcp` — Streamable HTTP MCP endpoint.
- `PUT /upload/<upload_id>?name=<file name>` — raw request body is the file. Max 32 MB by default.
- `GET /healthz`

## Run it

```sh
cd mcp-file-info
npm install
npm start            # MCP endpoint: http://127.0.0.1:3000/mcp
```

Environment variables: `HOST` (default `127.0.0.1`), `PORT` (`3000`),
`PUBLIC_URL` (what to put in upload URLs when behind a proxy),
`MAX_UPLOAD_BYTES` (`33554432`), `TICKET_TTL_MS` (`600000`), `UPLOAD_DIR`,
`FILE_INFO_ROOT` (enable the local `path` input, restricted to this directory).

End-to-end test with a real MCP client (generates a ~1 MB PNG, negotiates the
2026-07-28 revision, requests a slot, uploads, asks for `file` output):

```sh
npm test
```

Connect it to Claude Code:

```sh
claude mcp add --transport http file-info http://127.0.0.1:3000/mcp
```

Then ask: "what does `file` say about my image?" The model calls
`request_upload`, shows you the `curl -T` line, and calls `file_info` once you
have run it.

## Security notes

- The upload endpoint only accepts bytes for an `upload_id` that a tool call
  minted, once, within its TTL, and enforces `MAX_UPLOAD_BYTES` while streaming.
- `file` runs via `execFile` with `--`, never through a shell.
- Host-header validation (from `@modelcontextprotocol/node`) rejects requests
  whose `Host` is not localhost while the server is bound to loopback; origin
  validation does the same for browser-originated MCP requests.
- Uploaded files are stored under `uploads/` with mode 0600 and removed when
  the slot expires.
