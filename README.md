# pixmix

Keyed, reversible pixel scrambling. A scrambled image is still a completely valid image,
so any viewer shows it, just shuffled:
- same dimensions;
- PNG: same bit depth and colour type, every metadata chunk copied byte for byte;
- JPEG: same quantisation tables and metadata segments;
- JPEG XL: same metadata boxes. It is either re-encoded losslessly, or it holds a
  DCT-scrambled JPEG (the "JPEG route").

With the key, the original comes back exactly: the same pixels for PNG and lossless JPEG
XL, and the same DCT coefficients for JPEG and JPEG-route JPEG XL.

Output is PNG (and animated APNG), JPEG or JPEG XL. Input can be PNG/APNG, JPEG, GIF
(animated GIFs become APNG), JPEG XL, and, with a decoder plugin, WebP, AVIF, HEIC or TIFF.
EXIF, ICC, XMP, density and comments are carried over where the output format can hold
them.

This is obfuscation, not encryption: a permutation keeps the colour histogram, and in the
browser use case the key ships to the visitor.

## Quick start

```sh
npm install
npm test            # PngSuite and JPEG round trips, conversion, CLI, browser reveal (fake DOM)
npm run test:browser  # the same in real Chromium: decoder, worker, lab, demo site (see below)
npm run serve       # builds dist/ and starts http://127.0.0.1:8080
npm run serve:lan   # the same, reachable from other machines on the network (HOST=0.0.0.0)
```

The dev server has no authentication: anyone who can reach it can encode, decode and publish
to the demo gallery. Only use `serve:lan` on a network you trust.

- **Lab** (`/`): load an image in any format, or a generated PNG/JPEG/WebP sample.
  - Encode it on the server or in the browser, and see what metadata was kept or dropped.
  - Watch it decode with each animation, compare chunks, rekey, try a wrong key.
- **Demo site** (`/site.html`): images published from the lab, served scrambled and
  revealed by the standalone `<script>` decoder as they scroll into view.

## CLI

```sh
export PIXMIX_KEY='site-key'                  # or -k / --key-file
pixmix encode photos/*.jpg -o scrambled/      # photo.jpg -> scrambled/photo.scrambled.jpg (lossless)
pixmix encode logo.png --mode block --block 16
pixmix encode shot.png --format jpeg --quality 85
pixmix encode art.png --format jxl --mode block --block 16
pixmix encode photo.jpg --format jxl               # JPEG route: stays lossy-small
pixmix decode scrambled/photo.scrambled.jpg   # -> scrambled/photo.jpg
pixmix rekey --in-place --to-file new.key scrambled/*
pixmix inspect photo.jpg scrambled/photo.scrambled.jpg
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
| `dist/pixmix-worker.mjs` | ESM (Web Worker) | used by both decoders to decode off the main thread |
| `dist/pixmix-encoder.mjs` | ESM, platform-neutral | Node, Deno, Bun, workers, browsers |
| `dist/pixmix-encoder.cjs` | CommonJS | `require()`-based servers |
| `dist/pixmix-jxl.mjs` + `pixmix-jxl-{enc,dec}.wasm` | ESM + WASM | JPEG XL support, loaded on demand |

The decoder bundle contains no encoding code; the encoder bundle has no DOM code.

Deploy `pixmix-worker.mjs` next to the decoder to keep large decodes off the main thread.
If it's missing, or a CSP forbids workers, the decoder quietly decodes on the main thread.
A decoder loaded from another origin (a CDN) starts the worker through a same-origin
`blob:` module, which needs CORS on the CDN.

JPEG XL support is optional:
- Copy the three `pixmix-jxl*` files next to whichever bundle you deploy, or call
  `configureJxl({ moduleUrl, encoderWasm, decoderWasm })`. (`pixmix-jxl-enc.LICENSES.txt`
  holds the encoder's third-party licences.)
- Nothing is fetched until a JPEG XL image shows up.
- Revealing images only needs the decoder WASM (1.8 MB; 580 KB gzipped, 420 KB with
  Brotli). The encoder WASM (2.3 MB; 880 KB gzipped, 670 KB with Brotli) is fetched only to
  write JPEG XL: encoding, including the JPEG route, which works in browsers too, and
  `decodeAsync()` of a JPEG XL file, which returns JPEG XL.

## Encoder (servers)

```js
import { encode, rekey, inspect } from './dist/pixmix-encoder.mjs';

const scrambled = encode(pngBytes, { key: 'site-key' });                      // PNG, pixel mode
const tiles     = encode(pngBytes, { key: 'site-key', mode: 'block', block: 16 });
const photo     = encode(jpegBytes, { key: 'site-key' });                      // JPEG, lossless
const asJpeg    = encode(gifBytes, { key: 'site-key', format: 'jpeg', quality: 85 });
const rotated   = rekey(scrambled, { from: 'site-key', to: 'new-key' });       // lossless
inspect(scrambled); // { format, width, height, scrambled: true, mode, … }
```

Options:
- `key`: string or `Uint8Array`.
- `format`: `png`, `jpeg` or `jxl`. The default is the input's own format when pixmix can
  write it, otherwise PNG. So JPEG stays JPEG, JPEG XL stays JPEG XL, and GIF/WebP/AVIF
  become PNG.
- `mode`, `block`: `pixel`, or `block` with a tile size of 2–4096.
  - PNG and JPEG XL use them; JPEG is always `mcu`.
  - JPEG XL can also be `mcu`, the JPEG route. That's the default when the source is a
    JPEG, or a JPEG XL made from one.
- `effort`: JPEG XL encoder effort, 1–9. Defaults to 2 in pixel mode and 7 in block mode.
- `level`: PNG only, the zlib level.
- `transforms`: JPEG and JPEG-route JPEG XL, default `true`. Also flips and rotates each
  MCU, still lossless.
- `quality`, `subsampling`, `background`: only when converting to JPEG from another format.
  Defaults are 90, `4:2:0` (or `4:2:2` / `4:4:4`), and `#ffffff` as the colour transparency
  is flattened onto.
- `keepThumbnails`: default `false`. See "Embedded previews" below.
- `decoders`: extra input decoders.
- `onConvert(report)`: reports how the input was decoded and what metadata was kept or
  dropped: `{ format, from, decoder, transferred, dropped }`.

`encode` is synchronous and handles PNG, JPEG and GIF on its own. JPEG XL, in or out,
goes through `encodeAsync`, `decodeAsync` and `rekeyAsync`, because its codec is WASM loaded
on first use. The sync functions throw a clear error pointing at the async ones. Use `encodeAsync` with a
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
`convert` / `convertAsync` produce the plain, unscrambled file the encoder would scramble.

### Animation

- **APNG → APNG** is lossless, like still PNG:
  - Every frame is scrambled with its own permutation (the frame index is part of the
    seed), including partial frames with offsets and a default image that sits outside the
    animation.
  - `acTL`, `fcTL` and every other chunk are copied unchanged, apart from the APNG sequence
    numbers, which are renumbered.
  - Viewers without APNG support show the scrambled default image.
- **Animated GIF → PNG** gives an APNG:
  - Frames are composited to full size following GIF disposal.
  - Delays and the loop count are kept; a delay of 0 or 1 plays as 10, as browsers do.
  - The whole animation shares one colour type, usually a palette.
- **Animated WebP and JPEG XL → PNG** give an APNG too, with every frame, delays and loop
  count:
  - WebP through `sharpDecoder`, or through `browserDecoder` in browsers with WebCodecs'
    `ImageDecoder`.
  - JPEG XL through the built-in decoder.
- **Any animation → JPEG XL** (APNG, GIF, WebP, JPEG XL) gives an animated JPEG XL:
  - Frames are full-canvas (APNG frames are composited following their dispose and blend
    operations; a default image outside the animation is left out), delays and the loop
    count are kept.
  - Every frame is scrambled with its own permutation, with the frame index in the seed,
    exactly as in APNG. A zero delay becomes one tick, since JPEG XL would merge the frame
    into the next one.
  - Animations are 8-bit.
- **JPEG:** converting an animation to JPEG keeps the first frame, and the report says so.
- **In the browser,** the reveal animates frame 0, then the `<img>` gets the restored
  APNG (for an animated JPEG XL too, since most browsers can't show JPEG XL), which plays
  normally.

### Embedded previews

Several places inside an image file can hold a small copy of the picture, and that copy
would show the unscrambled image to anyone who looks:
- EXIF IFD1 thumbnails (JPEG and PNG);
- JFIF and JFXX thumbnails;
- Photoshop thumbnail resources;
- MPF secondary images, motion-photo video and anything else after the JPEG's end marker.

The encoder removes all of these by default and lists them under `dropped`. EXIF
thumbnails are zeroed in place so every other EXIF offset stays valid. Pass
`keepThumbnails: true` to keep them (trailing data after the end marker can't be kept
either way).

### Input formats and metadata

When the input and output formats match (PNG → PNG, JPEG → JPEG) nothing is decoded or
re-encoded: the scramble is lossless and the metadata is kept byte for byte. Otherwise the
input is decoded to pixels and re-encoded:

| Input | Decoder | Metadata source |
| --- | --- | --- |
| PNG | built-in | pixmix's PNG reader |
| JPEG | built-in (jpeg-js) | pixmix's JPEG reader |
| JPEG XL | built-in (jxl-oxide, WASM) | pixmix's box reader; the ICC profile comes from the decoder |
| GIF | built-in (omggif). All frames when writing PNG (as APNG), else the first | – |
| WebP | `sharpDecoder` / `browserDecoder` | pixmix's WebP reader |
| AVIF, HEIC, TIFF | `sharpDecoder` / `browserDecoder` | sharp |

Where each kind of metadata ends up:

| Metadata | PNG | JPEG | JPEG XL |
| --- | --- | --- | --- |
| EXIF | `eXIf` | APP1 `Exif` | `Exif` box |
| ICC profile | `iCCP` | APP2 `ICC_PROFILE`, split across segments | in the codestream |
| XMP | `iTXt XML:com.adobe.xmp` | APP1 XMP | `xml ` box |
| Density | `pHYs` | JFIF APP0 | dropped (no field) |
| Comments | `tEXt Comment` | COM | dropped (no field) |

The pixels stay exactly as stored. They aren't rotated (the EXIF orientation travels with
the EXIF) and aren't converted to sRGB (the ICC profile travels with the image).

Some things are dropped, and the report says so:
- animation frames after the first;
- CMYK and other non-RGB/grey profiles, and grey profiles on colour images;
- extended XMP;
- precision above 8 bits when writing JPEG (PNG and JPEG XL keep 16 bits), and in
  animations;
- PNG text chunks other than comments, and gamma without an ICC profile, when writing JPEG;
- transparency when writing JPEG (flattened onto `background`).

A PNG gets the smallest colour type that loses nothing: grey, palette (1–8 bit), RGB or
RGBA. Palette output also compresses far better once the pixels are scrambled. A JPEG is
written as a single component when the image is grey.

Sources deeper than 8 bits become 16-bit PNGs or JPEG XLs:
- 16-bit PNG, 16-bit TIFF/PNG/AVIF/HEIF through sharp, and 10/12/16-bit or float JPEG XL.
- If every sample is exactly an 8-bit value, the output is 8-bit, since that loses nothing.
- Animations are 8-bit.
- A 16-bit lossless JPEG XL needs codestream level 10, so it carries a `jxll` box.

## Decoder (websites)

```html
<img data-pixmix src="/img/photo.jpg" alt="…">     <!-- PNG or JPEG -->
<script src="pixmix-decoder.min.js" data-key="site-key" data-effect="dissolve"></script>
```

Or from code:

```js
PixMix.revealAll({ key: 'site-key', effect: 'blocks', duration: 1500 });
await PixMix.reveal(imgElement, { key, effect: 'scan', onProgress: (p) => … });
const original = await PixMix.decodeAsync(bytes, { key });   // just the bytes
const { bytes: shown, type } = await PixMix.restoreForDisplay(bytes, { key });
```

`restoreForDisplay` returns what an `<img>` can show:
- PNG and JPEG as they are;
- a JPEG XL as a PNG of its pixels (an APNG when it is animated), or as its JPEG on the
  JPEG route.

It needs only the JPEG XL decoder, not the encoder.

- Effects:
  - `dissolve`, `scan`.
  - `blocks`: tiles fly home. For JPEG, flipped or rotated MCUs spin and turn back over
    as they go. It works with PNG block mode and all JPEGs up to 12,000 tiles; otherwise
    it falls back to `dissolve`.
  - `none`.
  - `prefers-reduced-motion` forces `none`.
- Per-image overrides: `data-pixmix-key`, `data-pixmix-effect`, `data-pixmix-src` (fetch from
  here instead of `src`, e.g. to show a placeholder first).
- EXIF orientation: the animation is drawn rotated or flipped the same way the browser will
  show the final `<img>`. Browsers differ on EXIF in PNGs, so this is detected once with a
  2×1 test image. Override it with `orientation: 'apply' | 'ignore'`.
- `revealAll` is lazy by default: each image decodes when it scrolls into view.
- Decoding runs in a Web Worker by default: unscrambling, inflate/deflate, JPEG entropy
  coding and JPEG XL.
  - The page only draws the animation.
  - `worker: false` (or `data-worker="false"` on the script tag) keeps it on the main
    thread; a string gives the worker's URL.
  - All reveals share one worker.
- The animation runs on a temporary canvas. Afterwards the `<img>` gets the exact restored
  file as a `blob:` URL, so ICC/gamma handling, CSS, alt text and "save image" behave
  normally.
- State goes in `data-pixmix-state`: `decoding` → `done` | `error`. On error the scrambled
  image stays and a warning is logged.
- Cross-origin images need CORS, since the decoder `fetch`es the bytes.

### JPEG XL

There are two routes.

**JPEG route** (`mode: 'mcu'`), for photos. It's the default when the source is a JPEG, or
a JPEG XL made by recompressing one (it has a `jbrd` box):
- The JPEG is scrambled in the DCT domain exactly as in JPEG → JPEG. Nothing is
  requantised.
- It's then losslessly recompressed into JPEG XL by libjxl (`JxlEncoderAddJPEGFrame` with
  reconstruction data, in WASM). So the file stays as small as a lossy JPEG XL; a 12 MP
  photo is 28% smaller than its JPEG. Like `cjxl`, the JPEG's EXIF, XMP and JUMBF become
  `Exif`, `xml ` and `jumb` boxes.
- Decoding rebuilds that JPEG bit for bit from the JPEG XL, unscrambles it, and either
  recompresses it (`decodeAsync`) or shows it (the reveal gives the `<img>` the original
  JPEG).
- Speed at 12 MP: about 1.2 s to encode, 1.0 s to reveal in a browser, 1.7 s to restore to
  JPEG XL.
- It works everywhere, browsers included, since the encoder is plain WASM.
- Reconstruction uses jxl-oxide. jxl-oxide 0.12 can't rebuild some *progressive* JPEGs from
  third-party JPEG XL files. Those fall back to the pixel route; pixmix's own JPEGs are
  always baseline.

**Pixel route** (`mode: 'pixel' | 'block'`), for everything else:
- Decode JPEG XL with pixmix → the exact samples the input decodes to: 8- or 16-bit, in
  its own colour space (never converted), every frame of an animation.
- Scramble in `pixel` or `block` mode (each animation frame with its own permutation).
- Encode losslessly with libjxl, with the same ICC profile (or sRGB), bit depth, frames,
  delays and loop count. Grey and opaque images are stored with fewer channels.

So the key always gives back exactly those samples. What the report lists under `dropped`
when re-encoding a JPEG XL input on the pixel route:
- **Lossy input** that isn't a recompressed JPEG (VarDCT/XYB) is stored losslessly from its
  decoded pixels, so the file grows.
- **Precision:** float or more than 16 bits is stored as 16-bit; animations are 8-bit.
- **Boxes that would be stale or leak the image:**
  - `jbrd` (JPEG reconstruction data, no longer matching the pixels);
  - `jhgm` (an HDR gain map, a second image);
  - `jxli` / `jxll` (a frame index and codestream level, rewritten).

  `Exif`, `xml `, `jumb`, Brotli-compressed `brob` boxes and unknown boxes are copied
  unchanged. EXIF thumbnails are stripped as for the other formats.

The codec has two parts, both pixmix's own WASM bindings:
- **libjxl 0.12's encoder** (`native/libjxl`) for lossless encoding and JPEG
  recompression. A small C layer exposes:
  - lossless 8- or 16-bit grey, grey+alpha, RGB or RGBA, tagged with an ICC profile or
    as sRGB;
  - animations (full-canvas frames, per-frame durations, loop count);
  - lossless JPEG recompression with reconstruction data, in a container;
  - an effort setting.

  It's built single-threaded with WebAssembly SIMD (every current browser and Node), so it
  runs the same on servers and in browsers.
- **pixmix's own jxl-oxide binding** (`native/jxl`) for decoding and JPEG reconstruction.
  - It returns raw 8- or 16-bit pixels and the ICC profile, converting colour with `moxcms`,
    a pure-Rust colour-management library.
  - It can also return every keyframe of an animation.
  - Neither published option would do. `@jsquash/jxl`'s libjxl decoder isn't bit-exact:
    it colour-converts even sRGB images and turns (4,255,0) into (3,255,0). The
    `jxl-oxide-wasm` package can't reconstruct JPEGs. A test guards the exactness.

In the browser, most engines can't display JPEG XL. So the pixel route decodes it in WASM
(as 8-bit sRGB), animates frame 0 like PNG, and gives the `<img>` a lossless PNG of the
restored pixels, or an APNG of every frame for an animation. The JPEG route shows the
restored JPEG.

#### Rebuilding the encoder WASM

`native/libjxl/pkg` (ES module glue, `.wasm` and the third-party licences) is committed, so
this is only needed after changing `native/libjxl/binding.c` or the pinned versions:

```sh
./scripts/build-libjxl-wasm.sh              # Linux x86-64; needs curl, tar and python3
```

It downloads pinned versions of Emscripten (6.0.10), CMake and Ninja, the libjxl 0.12.0
release tarball (checked against its SHA-256) and the dependency commits that release's
`deps.sh` pins (Brotli, Highway, skcms), all into `~/.cache/pixmix-libjxl`
(`PIXMIX_LIBJXL_WORK` overrides it), never into the repository. Source paths are mapped
to neutral prefixes and debug info is left out, so the binary carries no local paths (the
script checks); the output is byte-for-byte reproducible. `-Os` is the default: `-O3`
(`BUILD_OPT=-O3`) makes the WASM 3% larger (2.44 MB instead of 2.38 MB) and was no faster
in the benchmarks below.

#### Rebuilding the decoder WASM

`native/jxl/pkg` is committed, so this is only needed after changing `native/jxl`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128   # must match native/jxl/Cargo.toml
./scripts/build-jxl-wasm.sh
```

## How it works

1. **Seed.** HKDF-SHA-256 over the key, with the per-image random salt, and info = version,
   mode, block size, width and height. The output is a ChaCha20 key/nonce plus a 4-byte key
   check.
2. **Permutation.** A Fisher–Yates shuffle driven by ChaCha20 with unbiased
   rejection sampling, integer-only so every engine agrees.
   - `pixel` mode shuffles all pixels.
   - `block` mode shuffles whole B×B tiles. The right/bottom leftover strips are shuffled
     pixel by pixel among themselves.
   - `mcu` mode (JPEG) shuffles the grid of MCUs, then draws a transform per slot.
3. **PNG.** Chunks are parsed and CRC-checked. The raster is inflated, unfiltered and
   de-interlaced into native samples; 16-bit, palette and 1/2/4-bit data are all kept as
   they are. Whole pixels are moved, then the raster is re-filtered, re-interlaced and
   deflated. Only `IDAT` changes. A `pmIx` chunk (ancillary, private, safe-to-copy) holding
   the version, mode, block size, salt and key check goes right before it.
4. **JPEG.** The entropy-coded data is decoded to quantised DCT coefficients, with no IDCT.
   Baseline, extended and progressive files are supported, along with restart markers and
   truncated data.
   - Whole MCUs (8×8 or 16×16, depending on chroma subsampling) are moved with all their
     components, so colour stays attached to its brightness.
   - The transforms are applied exactly on the coefficients: flipping negates the odd
     frequencies, transposing swaps u and v. Square MCUs get 8 transforms; 4:2:2 (16×8)
     gets the 4 flips.
   - The coefficients are written back with Huffman tables optimised for the data, as
     `jpegtran -optimize` does.
     - Baseline sources are written as one baseline scan.
     - Progressive sources are written as progressive scans: DC first, then AC bands,
       spectral selection with per-scan tables. `progressive: true | false` overrides that.
   - Nothing is requantised. APPn, COM and DQT segments and the SOF payload are copied
     unchanged, and an APP15 `pixmix\0` segment holds the marker.
   - Restart markers are not kept.
   - **Progressive caveat.** Progressive AC scans can't store the padding blocks of partial
     edge MCUs, and scrambling may move real content into them. So a scrambled file is
     progressive only when the image has no such padding (width and height fit whole MCUs);
     otherwise it's baseline.
     - The marker records that the source was progressive, and restoring writes a
       progressive file again. That's exact, since the original couldn't hold AC data in
       padding blocks either.
     - The JPEG inside a JPEG-route JPEG XL is always baseline (see jxl-oxide above).

Marker v1: `u8 version | u8 mode | u16 block | u8 saltLen | salt | u8[4] check`.
- In `mcu` mode, `block` holds flags: bit 0 = transforms, bit 1 = restore as progressive.
- APNG frames mix their index into the seed; it's 0 for still images.
The permutation stream is pinned by a test. Any change to it must bump the version.

### Size and speed

- Pixel mode turns the image into noise that deflate can't compress, so expect roughly the
  raw pixel size (a 12 MP RGB photo comes out at about 35 MB).
- Block mode (8–32 px) stays close to the original size.
- In Node, 12 MP takes about 3 s per encode or decode. Native zlib is used when available;
  browsers use `CompressionStream`/`DecompressionStream`.
- Converting a 12 MP JPEG to PNG takes about 2.4 s with the built-in decoder and 1.2 s with
  sharp. In both cases building the PNG is most of the time.
- JPEG → JPEG is fast and keeps the size: a 12 MP photo takes about 0.5 s to scramble and
  0.4 s to restore, and grows about 3% (shuffled MCUs make the DC differences larger).
  pixmix's progressive scans come out about the same size as libjpeg's.
- Converting 12 MP PNG → scrambled JPEG takes about 1.7 s (colour conversion, DCT and
  entropy coding in JS).
- JPEG XL, JPEG route: see above. It's fast because nothing is DCT'd or entropy-optimised
  twice.
- JPEG XL, pixel route (single-threaded WASM):
  - Pixel mode at effort 2: 2 MP encodes in 0.7 s and 12 MP in 4.3 s.
  - Block mode at effort 7 is slower (a few seconds at 2 MP, half a minute at 12 MP on a
    hard, noisy image), but the result is about 20% smaller than PNG block mode.
  - Decoding 12 MP takes 5–9 s.
  - Lower `effort` trades size for speed: at 2 MP, effort 5 takes about half the time of
    effort 7 for a 50% larger file.

Encode times with libjxl 0.12 against the encoders it replaced (`@jsquash/jxl` for pixels,
`jxl-wasm`'s `cjxl` 0.7 for the JPEG route), measured in Node on the same synthetic,
noisy photo-like images (so block mode is slower here than on real photos):

| Encode | 2 MP before | 2 MP now | 12 MP before | 12 MP now |
| --- | --- | --- | --- | --- |
| pixel mode (effort 2) | 0.58 s, 6.61 MB | 0.66 s, 6.41 MB | 5.3 s, 39.7 MB | 4.3 s, 38.5 MB |
| block 16 (effort 7) | 20.5 s, 1.66 MB | 4.6 s, 1.75 MB | 66 s, 9.57 MB | 35 s, 10.25 MB |
| JPEG route | 0.77 s | 0.16 s | 1.44 s | 1.24 s |
| JPEG route, restore to JPEG XL | 0.85 s | 0.23 s | 1.83 s | 1.73 s |

The JPEG route's files are the same size as before. Block mode is 2–4 times faster at
effort 7 and 5–7% larger (higher efforts close that gap only slowly).

## Browser tests

`npm run test:browser` builds `dist/` and drives headless Chromium through Playwright
(`npx playwright install chromium` once). It covers:
- the `<script>` decoder: every format and effect, with the final bytes checked in Node and
  the rendering compared with the original's;
- the Web Worker, and the main-thread fallback (`data-worker="false"`, CSP
  `worker-src 'none'`);
- a decoder loaded from another origin, a wrong key, EXIF rotation;
- animated WebP through `ImageDecoder`;
- the encoder in the page: JPEG → JPEG XL on the JPEG route, animated and 16-bit JPEG XL;
- the lab (every input/output/mode, encoded on the server and in the browser) and the demo
  site.

Console errors fail a test.

If Chromium can't start because the host lacks its shared libraries, either install them
system-wide (`sudo npx playwright install-deps`), or unpack them somewhere and set:
- `PIXMIX_BROWSER_LIBS` to that library directory (it's added to `LD_LIBRARY_PATH`);
- `FONTCONFIG_FILE` if the host has no fonts.

Firefox isn't covered yet: Playwright's Firefox needs a newer NSS than some distributions
ship.

## Roadmap

- [x] Phase 1: PNG → PNG, keys and rekey, browser reveal with animations, bundles, dev server
- [x] Phase 2: CLI; any input → PNG with EXIF/ICC/XMP/density carried over; decoder plugins
  (sharp, browser); EXIF orientation in the reveal
- [x] Phase 3: JPEG output. JPEG → JPEG is scrambled losslessly in the DCT domain (MCU
  shuffle and flips, metadata untouched); other formats → JPEG via a built-in encoder;
  embedded previews stripped; JPEG reveal animations in the browser
- [x] Phase 4: JPEG XL in and out.
  - Lossless pixel route, and the JPEG route (DCT scramble → lossless JPEG recompression).
  - Custom jxl-oxide WASM for exact decoding and JPEG reconstruction; lazy loading.
  - Browser reveal, CLI, server and lab support.
- [x] Phase 5: APNG in/out (per-frame permutations), animated GIF → APNG, decoding in a
  Web Worker with a main-thread fallback
- [x] Phase 6: real-browser test suite (Chromium); animated WebP / JPEG XL → APNG; 16-bit
  input kept in PNG; progressive JPEGs stay progressive
- [x] Phase 7: pixmix's own libjxl 0.12 WASM encoder: JPEG recompression in browsers too;
  JPEG XL output keeps ICC profiles, 16-bit samples and animations
- [ ] Firefox in the browser suite

## Third-party code

Everything is bundled or loaded under permissive licences:
- fflate (MIT), jpeg-js (BSD-3-Clause), omggif (MIT).
- libjxl (BSD-3-Clause, with its patent grant), built into the encoder WASM with
  Highway (BSD-3-Clause / Apache-2.0), Brotli (MIT) and skcms (BSD-3-Clause); the texts
  are in `native/libjxl/pkg/THIRD_PARTY_LICENSES.txt` (copied to
  `dist/pixmix-jxl-enc.LICENSES.txt`).
- jxl-oxide and its crates (MIT or Apache-2.0), moxcms (BSD-3-Clause or Apache-2.0),
  brotli-decompressor (BSD-3-Clause/MIT).
- sharp is an optional peer (Apache-2.0).

Test images: [PngSuite](http://www.schaik.com/pngsuite/) by Willem van Schaik (see
`test/fixtures/pngsuite/PngSuite.LICENSE`).
