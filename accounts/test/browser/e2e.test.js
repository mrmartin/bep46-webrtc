// End-to-end in a real browser: two isolated Chromium contexts (two users on
// two machines), a local ws:// tracker, WebRTC between the tabs, the actual
// page. Register in A, log in from B, change the password in B, see A's old
// password fail, delete from A, see B lose it. Then reload B and check the
// directory survived in its own storage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { startTracker } from '../../tools/tracker.js';
import { createStaticServer } from '../../tools/serve.js';

let tracker, httpServer, browser, base, pageUrl;
const ctxs = [];

// Use CHROMIUM_PATH if set, else a Playwright-managed Chromium already on disk
// (any version), else let Playwright pick its own (`npx playwright install chromium`).
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;
  try {
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return undefined;
}

before(async () => {
  tracker = await startTracker({ port: 0 });
  httpServer = createStaticServer();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  // kdf=10 keeps scrypt fast under test; fresh=1 clears any stale storage; tracker= points at the local one.
  pageUrl = `${base}/web/?tracker=${encodeURIComponent(tracker.url)}&kdf=10&fresh=1`;
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
  });
});

after(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close();
  await new Promise((r) => httpServer.close(r));
  await tracker.close();
});

async function openUser(name) {
  const ctx = await browser.newContext();
  ctxs.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pageUrl);
  await page.waitForFunction(() => !!window.__registry);
  return { name, ctx, page, errors };
}

const peers = (page) => page.evaluate(() => window.__registry.transport.peerCount());
const rows = (page) => page.$$eval('#ledger-body tr', (trs) => trs.map((tr) => ({ user: tr.dataset.user, pk: tr.dataset.pk, seq: tr.children[2].textContent })));
const message = (page) => page.locator('#message').textContent();

async function waitForRow(page, user, pred = () => true, timeout = 15000) {
  await page.waitForFunction(({ user, src }) => {
    const pred = new Function('r', `return (${src})(r)`);
    return [...document.querySelectorAll('#ledger-body tr')].some((tr) => tr.dataset.user === user && pred({ seq: Number(tr.children[2].textContent) }));
  }, { user, src: pred.toString() }, { timeout });
}

test('two browsers, one swarm: full account lifecycle through the UI', { timeout: 120_000 }, async () => {
  const A = await openUser('A');
  const B = await openUser('B');

  // 1. They find each other through the tracker and connect over WebRTC.
  await A.page.waitForFunction(() => window.__registry.transport.peerCount() >= 1, null, { timeout: 30_000 });
  await B.page.waitForFunction(() => window.__registry.transport.peerCount() >= 1, null, { timeout: 30_000 });
  assert.ok((await peers(A.page)) >= 1 && (await peers(B.page)) >= 1);
  assert.match(await A.page.locator('#swarm-text').textContent(), /1 peer/);

  // 2. A registers.
  await A.page.click('#tab-register');
  await A.page.fill('#register-username', 'Alice');
  await A.page.fill('#register-password', 'alice-password-1');
  await A.page.fill('#register-confirm', 'alice-password-1');
  await A.page.click('#register-submit');
  await A.page.waitForSelector('#signed-in:not([hidden])');
  assert.equal(await A.page.locator('#me-username').textContent(), 'alice');
  assert.match(await message(A.page), /created and published/);

  // 3. B sees alice appear without doing anything.
  await waitForRow(B.page, 'alice');
  const [rowB] = await rows(B.page);
  const [rowA] = await rows(A.page);
  assert.equal(rowB.pk, rowA.pk);
  assert.equal(rowB.seq, '1');

  // 4. B signs in with the wrong password, then the right one.
  await B.page.fill('#login-username', 'alice');
  await B.page.fill('#login-password', 'not-the-password');
  await B.page.click('#login-submit');
  await B.page.waitForFunction(() => document.getElementById('message').classList.contains('err'));
  assert.match(await message(B.page), /unknown username or wrong password/);
  await B.page.fill('#login-username', 'alice');
  await B.page.fill('#login-password', 'alice-password-1');
  await B.page.click('#login-submit');
  await B.page.waitForSelector('#signed-in:not([hidden])');

  // 5. Duplicate registration is refused on B.
  await B.page.click('#signout');
  await B.page.click('#tab-register');
  await B.page.fill('#register-username', 'alice');
  await B.page.fill('#register-password', 'another-password');
  await B.page.fill('#register-confirm', 'another-password');
  await B.page.click('#register-submit');
  await B.page.waitForFunction(() => document.getElementById('message').classList.contains('err'));
  assert.match(await message(B.page), /already registered/);

  // 6. B changes alice's password; A learns about it.
  await B.page.click('#tab-login');
  await B.page.fill('#login-username', 'alice');
  await B.page.fill('#login-password', 'alice-password-1');
  await B.page.click('#login-submit');
  await B.page.waitForSelector('#signed-in:not([hidden])');
  await B.page.fill('#pw-current', 'alice-password-1');
  await B.page.fill('#pw-next', 'alice-password-2');
  await B.page.fill('#pw-confirm', 'alice-password-2');
  await B.page.click('#pw-submit');
  await B.page.waitForFunction(() => /Password changed/.test(document.getElementById('message').textContent));
  await waitForRow(A.page, 'alice', (r) => r.seq === 2);
  assert.match(await message(A.page), /updated from another device/);

  // 7. On A (a fresh session), the old password no longer works, the new one does.
  await A.page.click('#signout');
  await A.page.fill('#login-username', 'alice');
  await A.page.fill('#login-password', 'alice-password-1');
  await A.page.click('#login-submit');
  await A.page.waitForFunction(() => document.getElementById('message').classList.contains('err'));
  await A.page.fill('#login-username', 'alice');
  await A.page.fill('#login-password', 'alice-password-2');
  await A.page.click('#login-submit');
  await A.page.waitForSelector('#signed-in:not([hidden])');

  // 8. A deletes the account; B (still signed in) is signed out by the tombstone.
  await A.page.fill('#del-password', 'alice-password-2');
  await A.page.check('#del-confirm');
  await A.page.click('#del-submit');
  await A.page.waitForFunction(() => /deleted/.test(document.getElementById('message').textContent));
  await B.page.waitForSelector('#signed-out:not([hidden])', { timeout: 15_000 });
  assert.match(await message(B.page), /deleted from another device/);
  assert.equal((await rows(B.page)).length, 0);
  assert.equal(await B.page.locator('#tombstone-count').textContent(), '1');

  // 9. The name is free again: B registers a new alice with a new key.
  await B.page.click('#tab-register');
  await B.page.fill('#register-username', 'alice');
  await B.page.fill('#register-password', 'alice-password-3');
  await B.page.fill('#register-confirm', 'alice-password-3');
  await B.page.click('#register-submit');
  await B.page.waitForSelector('#signed-in:not([hidden])');
  await waitForRow(A.page, 'alice', (r) => r.seq === 1);
  const [newRow] = await rows(A.page);
  assert.notEqual(newRow.pk, rowA.pk, 'new identity behind the reused name');

  // 10. Persistence: close A entirely, reload B with its storage; the directory is still there,
  // and a brand-new browser C gets it from B alone.
  await A.ctx.close();
  await B.page.goto(pageUrl.replace('&fresh=1', ''));
  await B.page.waitForFunction(() => !!window.__registry);
  assert.deepEqual((await rows(B.page)).map((r) => r.user), ['alice']);
  assert.equal(await B.page.locator('#tombstone-count').textContent(), '1');

  const C = await openUser('C');
  await waitForRow(C.page, 'alice', undefined, 30_000);
  await C.page.fill('#login-username', 'alice');
  await C.page.fill('#login-password', 'alice-password-3');
  await C.page.click('#login-submit');
  await C.page.waitForSelector('#signed-in:not([hidden])');

  for (const u of [A, B, C]) {
    const real = u.errors.filter((e) => !/ERR_|net::|favicon|WebSocket|ICE/i.test(e));
    assert.deepEqual(real, [], `${u.name} had page errors`);
  }
});
