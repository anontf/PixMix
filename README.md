# pixmix

Keyed, reversible pixel scrambling. A scrambled image is still a completely valid image
(same dimensions, same bit depth and colour type, every metadata chunk copied byte for
byte), so any viewer shows it, just shuffled. With the key, the original pixels come back
exactly.

This is obfuscation, not encryption: a permutation keeps the colour histogram, and in the
browser use case the key ships to the visitor.

## Quick start

```sh
npm install
npm test            # PngSuite round trips, primitives, browser reveal (fake DOM)
npm run serve       # builds dist/ and starts http://127.0.0.1:8080
```

- **Lab** (`/`): load an image (or the sample), encode on the server or in the browser, watch
  it decode with each animation, compare chunks, rekey, try a wrong key.
- **Demo site** (`/site.html`): images published from the lab, served scrambled and
  revealed by the standalone `<script>` decoder as they scroll into view.

## Bundles

`npm run build` writes self-contained files (fflate inlined, no runtime deps):

| File | Format | Use |
| --- | --- | --- |
| `dist/pixmix-decoder.min.js` | IIFE → `window.PixMix` | drop into any website |
| `dist/pixmix-decoder.js` | ESM | bundlers / `<script type="module">` |
| `dist/pixmix-encoder.mjs` | ESM, platform-neutral | Node, Deno, Bun, workers, browsers |
| `dist/pixmix-encoder.cjs` | CommonJS | `require()`-based servers |

The decoder bundle contains no encoding code; the encoder bundle has no DOM code.

## Encoder (servers)

```js
import { encode, rekey, inspect } from './dist/pixmix-encoder.mjs';

const scrambled = encode(pngBytes, { key: 'site-key' });                     // pixel mode
const tiles     = encode(pngBytes, { key: 'site-key', mode: 'block', block: 16 });
const rotated   = rekey(scrambled, { from: 'site-key', to: 'new-key' });      // lossless
inspect(scrambled); // { width, height, scrambled: true, mode, block, chunks: [...] }
```

Options: `key` (string or `Uint8Array`), `mode` (`pixel` | `block`), `block` (2–4096),
`level` (zlib level), `format` (output format; currently must match the input).

## Decoder (websites)

```html
<img data-pixmix src="/img/photo.png" alt="…">
<script src="pixmix-decoder.min.js" data-key="site-key" data-effect="dissolve"></script>
```

Or from code:

```js
PixMix.revealAll({ key: 'site-key', effect: 'blocks', duration: 1500 });
await PixMix.reveal(imgElement, { key, effect: 'scan', onProgress: (p) => … });
const png = await PixMix.decodeAsync(bytes, { key });   // just the bytes
```

- Effects: `dissolve`, `scan`, `blocks` (tiles fly home; block mode only, otherwise it falls
  back to dissolve), `none`. `prefers-reduced-motion` forces `none`.
- Per-image overrides: `data-pixmix-key`, `data-pixmix-effect`, `data-pixmix-src` (fetch from
  here instead of `src`, e.g. to show a placeholder first).
- `revealAll` is lazy by default: each image decodes when it scrolls into view.
- The animation runs on a temporary canvas. Afterwards the `<img>` gets the exact restored PNG
  as a `blob:` URL, so ICC/gamma handling, CSS, alt text and "save image" behave normally.
- State goes in `data-pixmix-state`: `decoding` → `done` | `error`. On error the scrambled
  image stays and a warning is logged.
- Cross-origin images need CORS, since the decoder `fetch`es the bytes.

## How it works

1. **Seed.** HKDF-SHA-256 over the key, with the per-image random salt, and info = version,
   mode, block size, width and height. The output is a ChaCha20 key/nonce plus a 4-byte key
   check.
2. **Permutation.** A Fisher–Yates shuffle driven by ChaCha20 with unbiased
   rejection sampling, integer-only so every engine agrees.
   - `pixel` mode shuffles all pixels.
   - `block` mode shuffles whole B×B tiles. The right/bottom leftover strips are shuffled
     pixel by pixel among themselves.
3. **PNG.** Chunks are parsed and CRC-checked. The raster is inflated, unfiltered and
   de-interlaced into native samples; 16-bit, palette and 1/2/4-bit data are all kept as
   they are. Whole pixels are moved, then the raster is re-filtered, re-interlaced and
   deflated. Only `IDAT` changes. A `pmIx` chunk (ancillary, private, safe-to-copy) holding
   the version, mode, block size, salt and key check goes right before it.

Marker v1: `u8 version | u8 mode | u16 block | u8 saltLen | salt | u8[4] check`.
The permutation stream is pinned by a test. Any change to it must bump the version.

### Size and speed

- Pixel mode turns the image into noise that deflate can't compress, so expect roughly the
  raw pixel size (a 12 MP RGB photo comes out at about 35 MB).
- Block mode (8–32 px) stays close to the original size.
- In Node, 12 MP takes about 3 s per encode or decode. Native zlib is used when available;
  browsers use `CompressionStream`/`DecompressionStream`.

## Roadmap

- [x] Phase 1: PNG → PNG, keys and rekey, browser reveal with animations, bundles, dev server
- [ ] CLI (`pixmix encode|decode|rekey|inspect`)
- [ ] Decode off the main thread (Web Worker) for very large images
- [ ] Any input format → PNG, with EXIF/XMP/ICC transferred
- [ ] JPEG → JPEG in the DCT domain: MCU-granular shuffle, lossless, markers untouched
- [ ] JXL: lossless via libjxl WASM, then lossy via the JPEG-reconstruction path
- [ ] APNG / animated images

Test images: [PngSuite](http://www.schaik.com/pngsuite/) by Willem van Schaik (see
`test/fixtures/pngsuite/PngSuite.LICENSE`).
