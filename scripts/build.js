// Produces the standalone bundles (dependencies inlined):
//
//   dist/pixmix-decoder.js        ESM, browser decoder + reveal animations
//   dist/pixmix-decoder.min.js    IIFE, exposes window.PixMix; drop in with a <script> tag
//   dist/pixmix-encoder.mjs       ESM, encoder for any server/runtime (Node, Deno, Bun, workers)
//   dist/pixmix-encoder.cjs       CommonJS build of the encoder, for require()-based servers

import { build } from 'esbuild';
import { rm, stat } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const out = (f) => `${root}dist/${f}`;
const common = { bundle: true, target: 'es2020', logLevel: 'warning', legalComments: 'none' };

await rm(out(''), { recursive: true, force: true });

const targets = [
  { entryPoints: [`${root}src/browser/index.js`], outfile: out('pixmix-decoder.js'), format: 'esm', platform: 'browser' },
  { entryPoints: [`${root}src/browser/auto.js`], outfile: out('pixmix-decoder.min.js'), format: 'iife', globalName: 'PixMix', platform: 'browser', minify: true },
  { entryPoints: [`${root}src/encoder.js`], outfile: out('pixmix-encoder.mjs'), format: 'esm', platform: 'neutral' },
  { entryPoints: [`${root}src/encoder.js`], outfile: out('pixmix-encoder.cjs'), format: 'cjs', platform: 'node' },
];

for (const t of targets) {
  await build({ ...common, ...t });
  const { size } = await stat(t.outfile);
  console.log(`${t.outfile.replace(root, '')}  ${(size / 1024).toFixed(1)} KiB`);
}
