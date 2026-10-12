// MCP server: `request_upload` hands out a one-time upload URL, the user PUTs the
// raw image bytes to it over plain HTTP (outside MCP), then `file_info` runs
// `file` on the stored bytes and returns the familiar "$ file image.png" line.
//
// Why the side channel: MCP (spec revision 2026-07-28, SDK v2) still has no
// client-to-server file primitive. Tool arguments are JSON the model has to
// emit token by token, so a 1 MB image as base64 is not realistic.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/$/, '');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 32 * 1024 * 1024);
const TICKET_TTL_MS = Number(process.env.TICKET_TTL_MS ?? 10 * 60 * 1000);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(import.meta.dirname, 'uploads');
// Optional: lets `file_info` take a local `path` (for a server co-located with the user's files).
const FILE_INFO_ROOT = process.env.FILE_INFO_ROOT ? path.resolve(process.env.FILE_INFO_ROOT) : null;

/** @type {Map<string, {expiresAt: number, status: 'pending'|'uploaded', filePath: string, name?: string, size?: number}>} */
const tickets = new Map();

function newTicket() {
  const id = randomBytes(16).toString('base64url');
  const ticket = { expiresAt: Date.now() + TICKET_TTL_MS, status: 'pending', filePath: path.join(UPLOAD_DIR, id) };
  tickets.set(id, ticket);
  return { id, ticket };
}

async function dropTicket(id) {
  const t = tickets.get(id);
  if (!t) return;
  tickets.delete(id);
  await rm(t.filePath, { force: true });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tickets) if (t.expiresAt < now) void dropTicket(id);
}, 60_000).unref();

function sanitizeName(raw) {
  const base = path.basename(String(raw ?? '')).replace(/[^\w.+-]/g, '_');
  return base && base !== '.' && base !== '..' ? base : 'upload';
}

async function runFile(filePath) {
  const [desc, mime] = await Promise.all([
    execFileAsync('file', ['-b', '--', filePath]),
    execFileAsync('file', ['-b', '--mime-type', '--', filePath]),
  ]);
  return { description: desc.stdout.trim(), mime_type: mime.stdout.trim() };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---- out-of-band upload endpoint: PUT /upload/<id> with the raw bytes as the body ----
async function handleUpload(req, res, id, url) {
  const t = tickets.get(id);
  if (!t || t.expiresAt < Date.now()) return sendJson(res, 404, { error: 'unknown or expired upload_id' });
  if (t.status !== 'pending') return sendJson(res, 409, { error: 'upload_id already used' });
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: `max ${MAX_UPLOAD_BYTES} bytes` });

  t.status = 'uploading';
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) return cb(new Error('too large'));
      cb(null, chunk);
    },
  });
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    await pipeline(req, limiter, createWriteStream(t.filePath, { mode: 0o600 }));
  } catch (err) {
    await rm(t.filePath, { force: true });
    t.status = 'pending';
    return sendJson(res, err.message === 'too large' ? 413 : 400, { error: err.message });
  }
  t.status = 'uploaded';
  t.size = size;
  t.name = sanitizeName(url.searchParams.get('name') ?? req.headers['x-filename'] ?? 'upload');
  sendJson(res, 201, { upload_id: id, name: t.name, size });
}

// ---- the MCP server itself ----
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'file-info', version: '1.0.0' });

  server.registerTool(
    'request_upload',
    {
      description:
        'Reserve a one-time upload slot for a file the user wants inspected. Returns an upload_url; the user ' +
        'sends the raw file bytes to it with an HTTP PUT (for example `curl -T image.png "<upload_url>"`). ' +
        'Afterwards call file_info with the returned upload_id. Files are never sent through MCP itself.',
      inputSchema: z.object({
        filename: z.string().optional().describe('Expected file name, used only to label the result'),
      }),
      outputSchema: z.object({
        upload_id: z.string(),
        upload_url: z.string(),
        method: z.literal('PUT'),
        max_bytes: z.number(),
        expires_at: z.string(),
      }),
    },
    async ({ filename }) => {
      const { id, ticket } = newTicket();
      const name = sanitizeName(filename ?? 'image.png');
      const upload_url = `${PUBLIC_URL}/upload/${id}?name=${encodeURIComponent(name)}`;
      const output = { upload_id: id, upload_url, method: 'PUT', max_bytes: MAX_UPLOAD_BYTES, expires_at: new Date(ticket.expiresAt).toISOString() };
      const text =
        `Upload slot ready (valid until ${output.expires_at}, max ${MAX_UPLOAD_BYTES} bytes).\n` +
        `Ask the user to run:\n\n  curl -T ${name} "${upload_url}"\n\n` +
        `then call file_info with upload_id "${id}".`;
      return { content: [{ type: 'text', text }], structuredContent: output };
    },
  );

  server.registerTool(
    'file_info',
    {
      description:
        'Run the `file` command on an uploaded file (by upload_id from request_upload) and return the ' +
        'same line `$ file <name>` prints, e.g. "image.png: PNG image data, 640 x 560, 8-bit/color RGB, non-interlaced".' +
        (FILE_INFO_ROOT ? ` Alternatively pass a local path under ${FILE_INFO_ROOT}.` : ''),
      inputSchema: z.object({
        upload_id: z.string().optional().describe('Id returned by request_upload, after the user uploaded the bytes'),
        path: z.string().optional().describe('Local path on the server host (only if the server allows it)'),
      }),
      outputSchema: z.object({
        name: z.string(),
        size_bytes: z.number(),
        description: z.string(),
        mime_type: z.string(),
        file_output: z.string(),
      }),
    },
    async ({ upload_id, path: localPath }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      if (!upload_id === !localPath) return fail('Pass exactly one of upload_id or path.');

      let filePath, name, size;
      if (upload_id) {
        const t = tickets.get(upload_id);
        if (!t || t.expiresAt < Date.now()) return fail(`Unknown or expired upload_id "${upload_id}". Call request_upload again.`);
        if (t.status !== 'uploaded') return fail(`Nothing has been uploaded to "${upload_id}" yet. Ask the user to PUT the file to the upload_url first.`);
        ({ filePath, name, size } = t);
      } else {
        if (!FILE_INFO_ROOT) return fail('Local paths are disabled on this server (set FILE_INFO_ROOT to enable). Use request_upload instead.');
        let resolved;
        try { resolved = await realpath(path.resolve(FILE_INFO_ROOT, localPath)); } catch { return fail(`No such file: ${localPath}`); }
        if (resolved !== FILE_INFO_ROOT && !resolved.startsWith(FILE_INFO_ROOT + path.sep)) return fail(`Path is outside ${FILE_INFO_ROOT}.`);
        const st = await stat(resolved);
        if (!st.isFile()) return fail(`Not a regular file: ${localPath}`);
        filePath = resolved; name = path.basename(resolved); size = st.size;
      }

      const { description, mime_type } = await runFile(filePath);
      const output = { name, size_bytes: size, description, mime_type, file_output: `${name}: ${description}` };
      return { content: [{ type: 'text', text: output.file_output }], structuredContent: output };
    },
  );

  return server;
});

const mcpHandler = toNodeHandler(handler);
const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const validateHost = loopback ? localhostHostValidation() : () => true;
const validateOrigin = localhostOriginValidation(); // only bites on browser-originated requests

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/mcp') {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void mcpHandler(req, res);
    return;
  }
  const m = url.pathname.match(/^\/upload\/([A-Za-z0-9_-]+)$/);
  if (m && (req.method === 'PUT' || req.method === 'POST')) {
    if (!validateHost(req, res)) return;
    void handleUpload(req, res, m[1], url);
    return;
  }
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  sendJson(res, 404, { error: 'not found' });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`MCP endpoint:    ${PUBLIC_URL}/mcp`);
  console.log(`Upload endpoint: ${PUBLIC_URL}/upload/<upload_id>  (PUT raw bytes)`);
});

process.on('SIGINT', async () => {
  await handler.close();
  httpServer.close();
  process.exit(0);
});
