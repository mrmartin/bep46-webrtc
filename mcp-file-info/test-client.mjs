// End-to-end check with a real MCP client: make a ~1 MB PNG, get an upload slot
// over MCP, PUT the bytes over HTTP, then ask MCP for the `file` output.
import { deflateSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BASE = process.env.MCP_BASE_URL ?? 'http://127.0.0.1:3000';

function makeNoisePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0]), randomBytes(width * 3)); // filter 0 + noise
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = makeNoisePng(640, 560);
console.log(`generated image.png: ${png.length} bytes (${(png.length / 1024 / 1024).toFixed(2)} MB)`);

const client = new Client({ name: 'file-info-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
console.log(`connected, protocol era: ${client.getProtocolEra()}`);
console.log('tools:', (await client.listTools()).tools.map(t => t.name));

const slot = await client.callTool({ name: 'request_upload', arguments: { filename: 'image.png' } });
if (slot.isError) throw new Error(slot.content[0].text);
const { upload_id, upload_url, method } = slot.structuredContent;
console.log(`upload slot: ${upload_id}`);

const up = await fetch(upload_url, { method, body: png, headers: { 'content-type': 'image/png' } });
console.log(`HTTP ${method} upload -> ${up.status} ${await up.text()}`);
if (!up.ok) process.exit(1);

const info = await client.callTool({ name: 'file_info', arguments: { upload_id } });
console.log('file_info ->', info.content[0].text);
console.log('structured ->', info.structuredContent);
await client.close();

if (info.isError || !/PNG image data, 640 x 560/.test(info.content[0].text)) {
  console.error('FAIL: unexpected file output');
  process.exit(1);
}
console.log('PASS');
