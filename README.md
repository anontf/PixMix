# pixmix

Keyed, reversible pixel scrambling. A scrambled image is still a completely valid image
(same dimensions, same bit depth and colour type, every metadata chunk copied byte for
byte), so any viewer shows it, just shuffled. With the key, the original pixels come back
exactly.

Input can be PNG, JPEG, GIF, and, with a decoder plugin, WebP, AVIF, HEIC or TIFF. EXIF,
ICC, XMP, density and comments are carried over. Output is PNG for now; JPEG and JXL
output are later phases.

This is obfuscation, not encryption: a permutation keeps the colour histogram, and in the
browser use case the key ships to the visitor.

## Quick start

```sh
npm install
npm test            # PngSuite round trips, conversion, CLI, browser reveal (fake DOM)
npm run serve       # builds dist/ and starts http://127.0.0.1:8080
```

- **Lab** (`/`): load an image in any format, or a generated PNG/JPEG/WebP sample.
  - Encode it on the server or in the browser, and see what metadata was kept or dropped.
  - Watch it decode with each animation, compare chunks, rekey, try a wrong key.
- **Demo site** (`/site.html`): images published from the lab, served scrambled and
  revealed by the standalone `<script>` decoder as they scroll into view.

## CLI

```sh
export PIXMIX_KEY='site-key'                  # or -k / --key-file
pixmix encode photos/*.jpg -o scrambled/      # photo.jpg -> scrambled/photo.scrambled.png
pixmix encode logo.png --mode block --block 16
pixmix decode scrambled/photo.scrambled.png   # -> scrambled/photo.png
pixmix rekey --in-place --to-file new.key scrambled/*.png
pixmix inspect photo.jpg scrambled/photo.scrambled.png
cat in.webp | pixmix encode -o - - > out.png  # stdin/stdout
```

For each file it reports how the input was decoded and what metadata was kept or dropped.
It never overwrites a file unless you pass `-f`. Exit codes: 0 = success, 1 = some files
failed (the others are still processed), 2 = usage error. If `sharp` is installed, the CLI
uses it for WebP, AVIF, HEIC and TIFF (turn this off with `--no-sharp`). `pixmix --help`
lists every option.

## Bundles

`npm run build` writes self-contained files (fflate, jpeg-js and omggif inlined; no runtime deps):

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
const tiles     = encode(jpegBytes, { key: 'site-key', mode: 'block', block: 16 });
const rotated   = rekey(scrambled, { from: 'site-key', to: 'new-key' });      // lossless
inspect(scrambled); // { width, height, scrambled: true, mode, block, chunks: [...] }
```

Options:
- `key`: string or `Uint8Array`.
- `mode`: `pixel` or `block`.
- `block`: tile size, 2–4096.
- `level`: zlib level.
- `format`: output format, default `png`, currently the only one.
- `decoders`: extra input decoders.
- `onConvert(report)`: reports how the input was decoded and what metadata was kept or
  dropped.

`encode` is synchronous and handles PNG, JPEG and GIF on its own. Use `encodeAsync` with a
decoder plugin for everything else:

```js
import sharp from 'sharp';
import { encodeAsync, sharpDecoder } from './dist/pixmix-encoder.mjs';

const out = await encodeAsync(webpBytes, {
  key: 'site-key',
  decoders: [sharpDecoder(sharp)],        // you pass your own sharp; pixmix doesn't depend on it
  onConvert: (r) => console.log(r.from, r.decoder, r.transferred, r.dropped),
});
```

In browsers, `browserDecoder()` uses the browser's own decoders (WebP, AVIF, BMP, …).
`convert` / `convertAsync` turn any input into a plain, unscrambled PNG.

### Input formats and metadata

| Input | Decoder | Metadata source |
| --- | --- | --- |
| PNG | none (lossless path, every chunk kept byte for byte) | the PNG itself |
| JPEG | built-in (jpeg-js) | pixmix's JPEG reader |
| GIF | built-in (omggif), first frame | – |
| WebP | `sharpDecoder` / `browserDecoder` | pixmix's WebP reader |
| AVIF, HEIC, TIFF | `sharpDecoder` / `browserDecoder` | sharp |

Where each kind of metadata ends up in the PNG:
- EXIF → `eXIf`
- ICC → `iCCP`
- XMP → `iTXt XML:com.adobe.xmp`
- JFIF density (or the density sharp reports) → `pHYs`
- JPEG comments → `tEXt Comment`

The pixels stay exactly as stored. They aren't rotated (the EXIF orientation travels with
the EXIF) and aren't converted to sRGB (the ICC profile travels with the image).

Some things are dropped, and the report says so:
- animation frames after the first;
- CMYK and other non-RGB/grey profiles (PNG can't hold them);
- JPEG extended XMP;
- precision above 8 bits from plugin decoders.

The PNG gets the smallest colour type that loses nothing: grey, palette (1–8 bit), RGB or
RGBA. Palette output also compresses far better once the pixels are scrambled.

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
- EXIF orientation: the animation is drawn rotated or flipped the same way the browser will
  show the final `<img>`. Browsers differ on EXIF in PNGs, so this is detected once with a
  2×1 test image. Override it with `orientation: 'apply' | 'ignore'`.
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
- Converting a 12 MP JPEG takes about 2.4 s with the built-in decoder and 1.2 s with sharp.
  In both cases building the PNG is most of the time.

## Roadmap

- [x] Phase 1: PNG → PNG, keys and rekey, browser reveal with animations, bundles, dev server
- [x] Phase 2: CLI; any input → PNG with EXIF/ICC/XMP/density carried over; decoder plugins
  (sharp, browser); EXIF orientation in the reveal
- [ ] Decode off the main thread (Web Worker) for very large images
- [ ] 16-bit input through plugins (currently reduced to 8-bit)
- [ ] JPEG → JPEG in the DCT domain: MCU-granular shuffle, lossless, markers untouched
- [ ] JXL: lossless via libjxl WASM, then lossy via the JPEG-reconstruction path
- [ ] APNG / animated images

Test images: [PngSuite](http://www.schaik.com/pngsuite/) by Willem van Schaik (see
`test/fixtures/pngsuite/PngSuite.LICENSE`).
