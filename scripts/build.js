// Produces the standalone bundles (dependencies inlined):
//
//   dist/pixmix-decoder.js        ESM, browser decoder + reveal animations
//   dist/pixmix-decoder.min.js    IIFE, exposes window.PixMix; drop in with a <script> tag
//   dist/pixmix-encoder.mjs       ESM, encoder for any server/runtime (Node, Deno, Bun, workers)
//   dist/pixmix-encoder.cjs       CommonJS build of the encoder, for require()-based servers
//   dist/pixmix-jxl.mjs           JPEG XL codec, loaded on demand by all of the above,
//   dist/pixmix-jxl-{enc,dec}.wasm  with its WASM (libjxl encoder; jxl-oxide decoder, native/jxl)
//   dist/pixmix-cjxl/             libjxl cjxl for JPEG -> JPEG XL recompression (servers only)
//
// Deploy the JPEG XL files next to whichever bundle you use (or call configureJxl), and
// only if you need JPEG XL: nothing is fetched until a JPEG XL image shows up.

import { build } from 'esbuild';
import { rm, stat, copyFile, mkdir } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const out = (f) => `${root}dist/${f}`;
const common = { bundle: true, target: 'es2020', logLevel: 'warning', legalComments: 'none' };

await rm(out(''), { recursive: true, force: true });
await mkdir(out(''), { recursive: true });

const chunk = { define: { __PIXMIX_JXL_CHUNK__: '"./pixmix-jxl.mjs"' } };
const targets = [
  { entryPoints: [`${root}src/browser/index.js`], outfile: out('pixmix-decoder.js'), format: 'esm', platform: 'browser', ...chunk },
  {
    entryPoints: [`${root}src/browser/auto.js`], outfile: out('pixmix-decoder.min.js'), format: 'iife', globalName: 'PixMix', platform: 'browser', minify: true,
    // No import.meta in a classic script; the loader falls back to document.currentScript.
    define: { ...chunk.define, 'import.meta.url': '""' },
  },
  { entryPoints: [`${root}src/encoder.js`], outfile: out('pixmix-encoder.mjs'), format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], ...chunk },
  {
    entryPoints: [`${root}src/encoder.js`], outfile: out('pixmix-encoder.cjs'), format: 'cjs', platform: 'node',
    // CommonJS has no import.meta; point it at this file so the JPEG XL chunk resolves.
    define: { ...chunk.define, 'import.meta.url': '__pixmix_url' },
    banner: { js: "const __pixmix_url = require('url').pathToFileURL(__filename).href;" },
  },
  {
    entryPoints: [`${root}src/formats/jxl/codec.js`], outfile: out('pixmix-jxl.mjs'), format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], minify: true,
    external: ['module', 'fs', 'path', 'url', 'worker_threads', 'crypto'],
    define: {
      __PIXMIX_JXL_WASM__: JSON.stringify({ enc: './pixmix-jxl-enc.wasm', dec: './pixmix-jxl-dec.wasm' }),
      __PIXMIX_CJXL__: '"./pixmix-cjxl/cjxl.cjs"',
    },
  },
];

const report = async (f) => console.log(`${f.replace(root, '')}  ${((await stat(f)).size / 1024).toFixed(1)} KiB`);
for (const t of targets) {
  await build({ ...common, ...t });
  await report(t.outfile);
}
await mkdir(out('pixmix-cjxl'), { recursive: true });
for (const [from, to] of [
  ['node_modules/@jsquash/jxl/codec/enc/jxl_enc.wasm', 'pixmix-jxl-enc.wasm'],
  ['native/jxl/pkg/pixmix_jxl_bg.wasm', 'pixmix-jxl-dec.wasm'],
  // .cjs so it stays CommonJS even inside a "type": "module" package
  ['node_modules/jxl-wasm/lib/cjxl.js', 'pixmix-cjxl/cjxl.cjs'],
  ['node_modules/jxl-wasm/lib/cjxl.wasm', 'pixmix-cjxl/cjxl.wasm'],
  ['node_modules/jxl-wasm/LICENSE', 'pixmix-cjxl/LICENSE'],
]) {
  await copyFile(`${root}${from}`, out(to));
  await report(out(to));
}
