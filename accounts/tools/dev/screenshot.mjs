// Opens two browsers against a local tracker, registers a couple of accounts, screenshots both.
import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTracker } from '../tracker.js';
import { createStaticServer } from '../serve.js';

const out = process.argv[2] || '/tmp';
const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
let exe = process.env.CHROMIUM_PATH;
if (!exe && root) for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) { const p = join(root, d, 'chrome-linux', 'chrome'); if (existsSync(p)) { exe = p; break; } }

const tracker = await startTracker({ port: 0 });
const srv = createStaticServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/web/?tracker=${encodeURIComponent(tracker.url)}&kdf=10&fresh=1`;
const browser = await chromium.launch({ executablePath: exe, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'] });
const mk = async (w, h, scheme) => { const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const p = await c.newPage(); await p.goto(url); await p.waitForFunction(() => !!window.__registry); return p; };
const A = await mk(1280, 860, 'light');
const B = await mk(420, 900, 'dark');
await A.waitForFunction(() => window.__registry.transport.peerCount() >= 1, null, { timeout: 30000 });
await A.click('#tab-register');
for (const [u, pw] of [['martin', 'a-long-password'], ['alice', 'another-long-pw'], ['bob.builder', 'yet-another-pw']]) {
  await A.fill('#register-username', u); await A.fill('#register-password', pw); await A.fill('#register-confirm', pw);
  await A.click('#register-submit'); await A.waitForSelector('#signed-in:not([hidden])');
  if (u !== 'bob.builder') { await A.click('#signout'); await A.click('#tab-register'); }
}
await B.waitForFunction(() => document.querySelectorAll('#ledger-body tr').length >= 3);
await B.fill('#login-username', 'alice'); await B.fill('#login-password', 'another-long-pw'); await B.click('#login-submit');
await B.waitForSelector('#signed-in:not([hidden])');
await A.waitForTimeout(3000);
await A.screenshot({ path: join(out, 'desktop-light.png'), fullPage: true });
await B.screenshot({ path: join(out, 'mobile-dark.png'), fullPage: true });
console.log('saved to', out);
await browser.close(); srv.close(); await tracker.close();
