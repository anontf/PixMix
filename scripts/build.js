// Produces the standalone bundles (dependencies inlined):
//
//   dist/pixmix-decoder.js        ESM, browser decoder + reveal animations
//   dist/pixmix-decoder.min.js    IIFE, exposes window.PixMix; drop in with a <script> tag
//   dist/pixmix-worker.mjs        Web Worker the decoders use (optional: without it they
//                                 decode on the main thread)
//   dist/pixmix-encoder.mjs       ESM, encoder for any server/runtime (Node, Deno, Bun, workers)
//   dist/pixmix-encoder.cjs       CommonJS build of the encoder, for require()-based servers
//   dist/pixmix-jxl.mjs           JPEG XL codec, loaded on demand by all of the above,
//   dist/pixmix-jxl-{enc,dec}.wasm  with its WASM (libjxl encoder, native/libjxl; jxl-oxide
//                                 decoder, native/jxl), and pixmix-jxl-enc-nosimd.wasm, the
//                                 encoder for engines without WebAssembly SIMD
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

const chunk = { define: { __PIXMIX_JXL_CHUNK__: '"./pixmix-jxl.mjs"', __PIXMIX_WORKER__: '"./pixmix-worker.mjs"' } };
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
  { entryPoints: [`${root}src/browser/worker.js`], outfile: out('pixmix-worker.mjs'), format: 'esm', platform: 'browser', minify: true, ...chunk },
  {
    entryPoints: [`${root}src/formats/jxl/codec.js`], outfile: out('pixmix-jxl.mjs'), format: 'esm', platform: 'neutral',
    minify: true,
    define: { __PIXMIX_JXL_WASM__: JSON.stringify({ enc: './pixmix-jxl-enc.wasm', encNoSimd: './pixmix-jxl-enc-nosimd.wasm', dec: './pixmix-jxl-dec.wasm' }) },
  },
];

const report = async (f) => console.log(`${f.replace(root, '')}  ${((await stat(f)).size / 1024).toFixed(1)} KiB`);
for (const t of targets) {
  await build({ ...common, ...t });
  await report(t.outfile);
}
for (const [from, to] of [
  ['native/libjxl/pkg/pixmix_libjxl.wasm', 'pixmix-jxl-enc.wasm'],
  ['native/libjxl/pkg/pixmix_libjxl_nosimd.wasm', 'pixmix-jxl-enc-nosimd.wasm'],
  ['native/jxl/pkg/pixmix_jxl_bg.wasm', 'pixmix-jxl-dec.wasm'],
  ['native/libjxl/pkg/THIRD_PARTY_LICENSES.txt', 'pixmix-jxl-enc.LICENSES.txt'], // libjxl, Highway, Brotli, skcms
]) {
  await copyFile(`${root}${from}`, out(to));
  await report(out(to));
}
