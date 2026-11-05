// Bundles Catwalk into ONE self-contained HTML file (dist/index.html): CSS,
// the three vendored libraries (shared with ../accounts/vendor), the sample
// data and the app, no external requests. That file is what you publish
// through the BEP-46 page publisher one directory up.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const r = (p) => resolve(root, p);

const js = await build({
  entryPoints: [r('web/app.js')], bundle: true, format: 'iife', platform: 'browser',
  target: ['es2022'], minify: true, write: false, legalComments: 'none',
});
const inline = (code) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
let html = readFileSync(r('web/index.html'), 'utf8');
html = html
  .replace('<link rel="stylesheet" href="app.css">', () => `<style>${readFileSync(r('web/app.css'), 'utf8')}</style>`)
  .replace('<script src="../../accounts/vendor/nacl-fast.min.js"></script>', () => inline(readFileSync(r('../accounts/vendor/nacl-fast.min.js'), 'utf8')))
  .replace('<script src="../../accounts/vendor/scrypt.js"></script>', () => inline(readFileSync(r('../accounts/vendor/scrypt.js'), 'utf8')))
  .replace('<script src="seed.js"></script>', () => inline(readFileSync(r('web/seed.js'), 'utf8')))
  .replace('<script type="module" src="app.js"></script>', () => inline(js.outputFiles[0].text));
for (const left of ['../../accounts/vendor/', 'src="app.js"', 'href="app.css"']) {
  if (html.includes(left)) throw new Error(`build left a reference to ${left}`);
}
mkdirSync(r('dist'), { recursive: true });
writeFileSync(r('dist/index.html'), html);
console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB, self-contained`);
