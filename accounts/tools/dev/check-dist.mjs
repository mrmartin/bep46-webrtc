// Loads dist/index.html in Chromium and checks it boots with zero network requests besides itself.
import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStaticServer } from '../serve.js';
const root = process.env.PLAYWRIGHT_BROWSERS_PATH; let exe = process.env.CHROMIUM_PATH;
if (!exe && root) for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) { const p = join(root, d, 'chrome-linux', 'chrome'); if (existsSync(p)) { exe = p; break; } }
const srv = createStaticServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
const reqs = []; page.on('request', (r) => reqs.push(r.url())); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/dist/index.html?tracker=ws://127.0.0.1:1`);
await page.waitForFunction(() => !!window.__registry, null, { timeout: 10000 });
console.log('requests:', reqs.length, reqs.map((u) => u.split('/').pop()).join(', '));
console.log('page errors:', errs);
await browser.close(); srv.close();
