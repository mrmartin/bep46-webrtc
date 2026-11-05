// Bundles the page into ONE self-contained HTML file (dist/index.html) with no
// external requests at all — ready to be published as a torrent / via the
// BEP-46 publisher, where a page cannot rely on relative module loading.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const r = (p) => resolve(root, p);

const js = await build({
  entryPoints: [r('web/app.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
  legalComments: 'none',
});
const css = readFileSync(r('web/app.css'), 'utf8');
const nacl = readFileSync(r('vendor/nacl-fast.min.js'), 'utf8');
const scrypt = readFileSync(r('vendor/scrypt.js'), 'utf8');
let html = readFileSync(r('web/index.html'), 'utf8');

const inline = (code) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
html = html
  .replace('<link rel="stylesheet" href="app.css">', () => `<style>${css}</style>`)
  .replace('<script src="../vendor/nacl-fast.min.js"></script>', () => inline(nacl))
  .replace('<script src="../vendor/scrypt.js"></script>', () => inline(scrypt))
  .replace('<script type="module" src="app.js"></script>', () => inline(js.outputFiles[0].text));

mkdirSync(r('dist'), { recursive: true });
writeFileSync(r('dist/index.html'), html);
console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB, self-contained`);
