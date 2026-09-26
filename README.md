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
them, or stripped, edited and set by a metadata policy (see "Metadata").

This is obfuscation, not encryption: a permutation keeps the colour histogram, and in the
browser use case the key ships to the visitor.

## Quick start

```sh
npm install
npm test            # PngSuite and JPEG round trips, conversion, CLI, browser reveal (fake DOM)
npm run test:browser  # the same in real Chromium and WebKit: decoder, worker, lab, demo site (see below)
npm run fuzz        # the long fuzz run (see "Fuzzing")
npm run serve       # builds dist/ and starts http://127.0.0.1:8080
npm run serve:lan   # the same, reachable from other machines on the network (HOST=0.0.0.0)
```

The dev server has no authentication: anyone who can reach it can encode, decode and publish
to the demo gallery. Only use `serve:lan` on a network you trust.

- **Lab** (`/`): load an image in any format, or a generated PNG/JPEG/WebP sample (a PNG
  where the browser can't encode WebP, as in Safari).
  - Encode it on the server or in the browser, and see what metadata was kept or dropped.
  - Watch it decode with each animation, compare chunks, rekey, try a wrong key.
  - Create and edit watermarks, with a live preview, and save them to `watermarks/`.
  - Create and edit metadata profiles, with the image's metadata before and after, and save
    them to `metadata-profiles/`; pick one when encoding and when decoding.
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
pixmix encode photo.jpg --watermark vivi-gold # carry a watermark for the decoder to draw
pixmix encode photo.jpg --visible-watermark vivi-pixel   # drawn on the scrambled image too
pixmix decode photo.scrambled.jpg --watermark embedded   # draw the one it carries
pixmix decode photo.scrambled.jpg --watermark my-mark.json
pixmix encode photo.jpg --metadata vivi-web   # strip everything, credit Vivi (see "Metadata")
```

For each file it reports how the input was decoded and what metadata was kept or dropped.
It never overwrites a file unless you pass `-f` (or `rekey --in-place`, which keeps symlinks
and permissions), and never writes two inputs to one output name in a run. A `--key-file` is
used as bytes, without one trailing newline or a leading UTF-8 BOM. Options that do not
apply to the command are usage errors. Exit codes: 0 = success, 1 = some files
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
| `dist/pixmix-watermark.mjs` | ESM | draws watermarks, loaded on demand (36 KB; 16 KB gzipped) |
| `dist/pixmix-metadata.mjs` | ESM | metadata policies in the decoders, loaded on demand (83 KB; 32 KB gzipped) |
| `dist/pixmix-encoder.mjs` | ESM, platform-neutral | Node, Deno, Bun, workers, browsers |
| `dist/pixmix-encoder.cjs` | CommonJS | `require()`-based servers |
| `dist/pixmix-jxl.mjs` + `pixmix-jxl-{enc,dec}.wasm` | ESM + WASM | JPEG XL support, loaded on demand |

The decoder bundle contains no encoding code; the encoder bundle has no DOM code.

Deploy `pixmix-watermark.mjs` next to the decoder if you use watermarks (or call
`configureWatermarks({ moduleUrl })`); it is only fetched when one is drawn. Likewise
`pixmix-metadata.mjs` (`configureMetadata`), fetched only when a decoder is given a metadata
policy.

Deploy `pixmix-worker.mjs` next to the decoder to keep large decodes off the main thread.
If it's missing, or a CSP forbids workers, the decoder quietly decodes on the main thread.
A decoder loaded from another origin (a CDN) starts the worker through a same-origin
`blob:` module, which needs CORS on the CDN.

JPEG XL support is optional:
- Copy the `pixmix-jxl*` files next to whichever bundle you deploy, or call
  `configureJxl({ moduleUrl, encoderWasm, encoderWasmNoSimd, decoderWasm })`.
  (`pixmix-jxl-enc.LICENSES.txt` holds the encoder's third-party licences.)
- Nothing is fetched until a JPEG XL image shows up.
- Revealing images only needs the decoder WASM (1.8 MB; 580 KB gzipped, 420 KB with
  Brotli). The encoder WASM is fetched only to write JPEG XL: encoding, including the JPEG
  route, which works in browsers too, and `decodeAsync()` of a JPEG XL file, which returns
  JPEG XL.
- The encoder comes in two builds, and each engine fetches only the one it can run:
  `pixmix-jxl-enc.wasm` uses WebAssembly SIMD (2.3 MB; 880 KB gzipped, 670 KB with
  Brotli); `pixmix-jxl-enc-nosimd.wasm` (2.4 MB; 925 KB gzipped, 690 KB with Brotli) is for
  engines without SIMD, such as some WebKit builds. pixmix checks with
  `WebAssembly.validate` on a tiny SIMD module.

## Encoder (servers)

```js
import { encode, rekey, inspect } from './dist/pixmix-encoder.mjs';

const scrambled = encode(pngBytes, { key: 'site-key' });                      // PNG, 16 px tiles, flipped
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
  - An image (or animation frame) that would get only a few whole tiles, such as a 16×16
    icon at the default size, gets the largest smaller tile size that shuffles it properly
    (pixel mode when even 2 px tiles are too few). The marker, and `inspect`, give the size
    used.
  - JPEG XL can also be `mcu`, the JPEG route. That's the default when the source is a
    JPEG, or a JPEG XL made from one.
- `effort`: JPEG XL encoder effort, 1–9. Defaults to 2 in pixel mode and 7 in block mode.
- `level`: PNG only, the zlib level, 0–9.
- `transforms`: JPEG and JPEG-route JPEG XL, default `true`. Also flips and rotates each
  MCU, still lossless.
- `quality`, `subsampling`, `background`: only when converting to JPEG from another format.
  Defaults are 90, `4:2:0` (or `4:2:2` / `4:4:4`), and `#ffffff` as the colour transparency
  is flattened onto.
- `keepThumbnails`: default `false`. See "Embedded previews" below.
- `decoders`: extra input decoders.
- `onConvert(report)`: reports how the input was decoded and what metadata was kept or
  dropped: `{ format, from, decoder, transferred, dropped }`.
- `watermark`, `visibleWatermark`: see "Watermarks" below.
- `metadata`: a metadata policy for the scrambled file, see "Metadata" below.
- `limits`: resource limits, see "Untrusted input" below.

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
A plugin only claims formats it can decode (`sharpDecoder` checks libvips' loaders), and
leaves GIF and JPEG XL to pixmix's exact built-in decoders unless `formats` says otherwise.
If a plugin fails on a format pixmix decodes itself, the built-in decoder takes over and
the report's `notes` say so.
`convert` / `convertAsync` produce the plain, unscrambled file the encoder would scramble
(for JPEG XL output, along the same route: a JPEG is recompressed as the JPEG route holds
it, unless `mode` asks for pixels). A JPEG XL made from a JPEG converts back to that JPEG,
bit for bit, when jxl-oxide rebuilds it verifiably.

Input that is already scrambled is refused with `ALREADY_SCRAMBLED` whatever the output
format (decode it first, or use `rekey`): scrambling it again would lose the original.
`convert` refuses it too when the format changes; converting to the same format keeps the
marker, and the file stays restorable. Invalid option values (a `quality` that is not a
number from 1 to 100, an unknown `subsampling`, a `transforms` that is not a boolean, …)
throw `BAD_OPTION` before any work is done.

### Untrusted input

Every entry point takes a `limits` option: `encode`, `decode`, `rekey`, `convert`, their
async versions, `inspect(bytes, { limits })`, and the browser's `reveal`, `revealAll`,
`restoreForDisplay`, `decodeToURL` and `decodeAsync`. Pass only what you want to change;
the rest keep their defaults (`DEFAULT_LIMITS`), and `Infinity` turns one off.

| Limit | Default | What it caps |
| --- | --- | --- |
| `maxInputBytes` | 256 MiB | the input file (the browser stops downloading there) |
| `maxPixels` | 100 megapixels | width × height of the image, and of any one frame |
| `maxFrames` | 1000 | frames in an animation |
| `maxTotalPixels` | 200 megapixels | all frames together |
| `maxDecompressedBytes` | 1 GiB | inflated PNG image data, per frame |
| `maxMetadataBytes` | 16 MiB | inflated metadata: `iCCP`, `zTXt`, `iTXt`, JPEG XL `brob` |
| `maxChunks` | 1,000,000 | PNG chunks, JPEG segments or JPEG XL boxes in one file |
| `maxScans` | 256 | scans in a JPEG (each is a pass over the whole image) |

They are checked from the headers before anything large is allocated: PNG `IHDR` and
`fcTL`, the JPEG frame header, the GIF screen and frames, and the JPEG XL header (the
decoder WASM checks the size and frame count again, and caps its own allocations).
Inflating stops at the size the `IHDR` declares, so a decompression bomb costs nothing.
`sharpDecoder` passes `maxPixels` on as sharp's `limitInputPixels`. A violation throws a
`PixmixError` with code `LIMIT`; `inspect` checks the same limits, so it works as a cheap
check before the real work. Anything wrong with the file itself also throws a `PixmixError`
(`BAD_PNG`, `BAD_JPEG`, …), including errors from jpeg-js, libvips and the JPEG XL codecs.

The CLI has `--max-pixels`, `--max-frames` and `--max-input-bytes`. The dev server applies
the limits to every upload, with its 64 MiB body limit as `maxInputBytes`, and answers 413.

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
    `ImageDecoder`. Elsewhere `browserDecoder` keeps the first frame and reports the
    animation as dropped. The loop count is read from the file, since engines disagree on
    what `repetitionCount` means for WebP.
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
- EXIF IFD1 thumbnails (JPEG or uncompressed strips), in JPEG, PNG and JPEG XL;
- JPEG previews inside the EXIF MakerNote (Olympus, Pentax, older Nikon and others);
- XMP thumbnails (`xmp:Thumbnails`) and Google's original and depth images (`GImage:Data`,
  `GDepth:Data`), in the XMP packet or in JPEG extended XMP;
- JFIF and JFXX thumbnails;
- Photoshop thumbnail resources, also when the resources continue over several APP13
  segments;
- MPF secondary images, motion-photo video and anything else after the JPEG's end marker.

The encoder removes all of these by default, on every route (same format, converted, JPEG
XL boxes including Brotli-compressed ones), and lists them under `dropped`. EXIF
thumbnails and MakerNote previews are zeroed in place so every other offset stays valid;
only complete, well-formed JPEG streams inside a MakerNote are touched. XMP previews are
removed from the packet and the rest is written back as it was; extended XMP holding one
goes entirely. Pass `keepThumbnails: true` to keep them. Data after the end marker can't be
kept either way, so it is still dropped (and reported), and so is the MPF index pointing
to it.

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

The built-in JPEG decoder refuses what pixmix's JPEG reader refuses (12-bit, lossless,
arithmetic-coded, hierarchical: `UNSUPPORTED`) and picks the colour transform as libjpeg
does (JFIF, else the Adobe APP14 transform, else component ids `R`,`G`,`B` mean RGB).
CMYK and YCCK are converted by the usual profile-less formula (as libjpeg and browsers do
without a profile), which `dropped` reports; `sharpDecoder` converts with the ICC profile.

Where each kind of metadata ends up:

| Metadata | PNG | JPEG | JPEG XL |
| --- | --- | --- | --- |
| EXIF | `eXIf` | APP1 `Exif` | `Exif` box |
| ICC profile | `iCCP` | APP2 `ICC_PROFILE`, split across segments | in the codestream |
| XMP | `iTXt XML:com.adobe.xmp` | APP1 XMP | `xml ` box |
| Density | `pHYs` | JFIF APP0 (dots per inch when whole, else per cm) | dropped (no field) |
| Comments | `tEXt Comment` (`iTXt` beyond Latin-1) | COM (UTF-8) | dropped (no field) |

The pixels stay exactly as stored. They aren't rotated (the EXIF orientation travels with
the EXIF; a TIFF's orientation tag becomes EXIF; JPEG XL keeps it in its header, which
viewers follow rather than the EXIF, so JPEG XL output gets the EXIF orientation there and
JPEG XL input hands its header's orientation to the EXIF) and aren't converted to sRGB (the ICC
profile travels with the image). AVIF and HEIC are the exception: libheif always applies
their rotation, so the EXIF orientation is set to 1 and the report says so.

Some things are dropped, and the report says so:
- animation frames after the first;
- pages after the first of a multi-page TIFF (or HEIF collection);
- CMYK and other non-RGB/grey profiles, and grey profiles on colour images;
- extended XMP;
- precision above 8 bits when writing JPEG (PNG and JPEG XL keep 16 bits), and in
  animations;
- PNG text chunks other than comments, and gamma without an ICC profile, when writing JPEG;
- transparency when writing JPEG (flattened onto `background`);
- JPEG XL extra channels other than alpha (spot colours, depth, …), and the animation of a
  one-frame animated JPEG XL (it becomes a still).

Every report has `notes` (a list, often empty): a lossless output of a lossy source (JPEG,
lossy WebP, AVIF unless coded as RGB, HEIC, lossy or recompressed-JPEG JPEG XL) gets a note
that it will be several times larger, and what stays small.

A PNG gets the smallest colour type that loses nothing: grey (1–8 bit), palette (1–8
bit), RGB or RGBA. Palette output also compresses far better once the pixels are
scrambled. A JPEG is written as a single component when the image is grey.

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
  here instead of `src`, e.g. to show a placeholder first), `data-pixmix-watermark`.
- Watermarks (see below): `watermark` / `data-watermark` on the script tag.
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
- Reconstruction uses jxl-oxide (0.12, with a patch for JPEGs with comments). It gets
  some JPEGs wrong, so both ends are checked, and anything that fails falls back to the
  pixel route. The report's `notes` then say why, and the file is several times larger.
  Asking for `mode: 'mcu'` gives an `UNSUPPORTED` error instead.
  - For a JPEG XL made from a JPEG by another tool, the rebuilt JPEG is recompressed and
    must decode to exactly the same pixels. Some progressive JPEGs fail this: jxl-oxide
    either stops with an error or silently rebuilds different coefficients.
  - Every file pixmix writes must rebuild bit for bit before it is returned. This catches
    JPEGs jxl-oxide can't rebuild, such as 4:4:4 stored with 1×2 sampling factors, and
    ones libjxl can't recompress, such as CMYK and 4:1:1.

**Pixel route** (`mode: 'pixel' | 'block'`), for everything else:
- Decode JPEG XL with pixmix → the exact samples the input decodes to: 8- or 16-bit, in
  its own colour space (never converted), on the stored pixel grid (the header's
  orientation isn't applied), every frame of an animation.
- Scramble in `pixel` or `block` mode (each animation frame with its own permutation).
- Encode losslessly with libjxl, with the same colour encoding (the same enum values when
  the input has them, else its ICC profile, else sRGB), orientation, bit depth, frames,
  exact frame durations and loop count. Grey and opaque images are stored with fewer
  channels.

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
  - lossless 8- or 16-bit grey, grey+alpha, RGB or RGBA, tagged with an enum colour
    encoding, an ICC profile or as sRGB, with an orientation;
  - animations (full-canvas frames, per-frame durations, loop count);
  - lossless JPEG recompression with reconstruction data, in a container;
  - an effort setting.

  It's built single-threaded, twice: with WebAssembly SIMD (Node and most browsers) and
  without (engines that can't compile SIMD, such as Playwright's WebKit). Both runs are
  lossless, so they give back the same pixels. Without SIMD, 2 MP block mode is about 15%
  slower and the JPEG route about 50% slower; pixel mode is about the same.
- **pixmix's own jxl-oxide binding** (`native/jxl`) for decoding and JPEG reconstruction.
  - It returns raw 8- or 16-bit pixels, the ICC profile, the enum colour encoding and the
    orientation, converting colour (only where asked, for display) with `moxcms`, a
    pure-Rust colour-management library.
  - It can also return every keyframe of an animation, with durations in ticks.
  - Neither published option would do. `@jsquash/jxl`'s libjxl decoder isn't bit-exact:
    it colour-converts even sRGB images and turns (4,255,0) into (3,255,0). The
    `jxl-oxide-wasm` package can't reconstruct JPEGs. A test guards the exactness.

In the browser, most engines can't display JPEG XL. So the pixel route decodes it in WASM
(as 8-bit sRGB), animates frame 0 like PNG, and gives the `<img>` a lossless PNG of the
restored pixels (turned the way the header's orientation says), or an APNG of every frame
for an animation. The JPEG route shows the
restored JPEG. Safari could show JPEG XL itself, but gets the PNG too, so every engine
shows the same exact pixels.

#### Rebuilding the encoder WASM

`native/libjxl/pkg` (ES module glue, the SIMD and non-SIMD `.wasm` and the third-party
licences) is committed, so this is only needed after changing `native/libjxl/binding.c` or
the pinned versions:

```sh
./scripts/build-libjxl-wasm.sh              # Linux x86-64; needs curl, tar and python3
```

It downloads pinned versions of Emscripten (6.0.10), CMake and Ninja, the libjxl 0.12.0
release tarball (checked against its SHA-256) and the dependency commits that release's
`deps.sh` pins (Brotli, Highway, skcms), all into `~/.cache/pixmix-libjxl`
(`PIXMIX_LIBJXL_WORK` overrides it), never into the repository. Source paths are mapped
to neutral prefixes and debug info is left out, so the binary carries no local paths (the
script checks); both builds are byte-for-byte reproducible, and share one glue module
(the script checks that too). `-Os` is the default: `-O3` (`BUILD_OPT=-O3`) makes the SIMD
WASM 3% larger (2.44 MB instead of 2.38 MB) and was no faster in the benchmarks below.

#### Rebuilding the decoder WASM

`native/jxl/pkg` is committed, so this is only needed after changing `native/jxl`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128   # must match native/jxl/Cargo.toml
./scripts/build-jxl-wasm.sh
```

## Watermarks

A watermark is a small footer drawn on the revealed image: text in a committed font, with an
outline, a shadow, a background box and ornaments. The decoder draws it at the end of the
reveal, and the `<img>` then shows the watermarked file.

- **Definitions** live in `watermarks/<id>.json`, one small JSON file each, in a fixed key
  order and layout so diffs stay clean. The lab edits them (`/`), or edit them by hand and
  run `npm run watermarks` (`--check` reports stale compiled files; a test does too).
- **Compiled watermarks** (`watermarks/compiled/<id>.json`, plus an `.svg` preview) hold the
  text as glyph outlines, made with opentype.js when a definition is saved. Drawing needs no
  font, so nothing depends on what is installed. This is what decoders fetch.
- **Fonts** are in `watermarks/fonts/` with their licences (SIL OFL): Press Start 2P,
  Pixelify Sans, Cinzel Decorative. Logos for image ornaments go in `watermarks/assets/`
  (PNG, up to 256×256).

The three defaults are bottom-right footers reading "Vivi":
- `vivi-pixel`: crisp Press Start 2P, off-white with a dark 1-pixel outline and a hard
  shadow; sized in whole font pixels (8, 16 or 24 px).
- `vivi-window`: a JRPG dialogue window, dark-blue gradient box with a silver border and
  rounded corners, the name in Pixelify Sans.
- `vivi-gold`: Cinzel Decorative in a metallic gold gradient, with a sparkle and a thin
  gold line that fades out at both ends.

What a definition can set (lengths in em, the font size, unless named otherwise):
- `text` (up to 4 lines), `font`, `letterSpacing`, `lineHeight`, `align`.
- `size`: `px`, or `relative` to the image's `short` / `long` side, `width`, `height` or
  `diagonal`, clamped to `min` / `max` px and optionally snapped (`snap`, for pixel fonts).
  `fit.maxWidth` / `fit.maxHeight` (fractions of the image) shrink it on small images, and
  below `fit.minSize` px it is left out.
- `anchor` (9 positions), `margin` (`relative` with `min` / `max` px), `offset`.
- `fill`: a colour (`#rrggbb` or `#rrggbbaa`) or a linear gradient (CSS angle, 2–8 stops);
  `opacity`; `crisp` (no anti-aliasing).
- `stroke` (colour, width, round or square join, opacity), `shadow` (colour, opacity,
  offset, blur).
- `background`: `box`, `pill` or `strip` (full width), with its own fill, opacity, radius,
  padding and `border`.
- `ornaments` (up to 8): `sparkle`, `star`, `diamond`, `dot`, `heart`, `line` or `image`,
  before / after / above / below the text or at a corner, with size, gap, offset, own fill.

Rendering is plain JavaScript: a scanline rasteriser for the outlines, the outline as a
dilation, the shadow as an offset, box-blurred copy. It uses only exactly specified maths
(no `Math.sin`, no canvas), so Node, Chromium and WebKit draw the same pixels; the browser
tests check that the `<img>` shows exactly what Node draws (the same JPEG file, byte for
byte; for PNG the same pixels, as each engine deflates its own way). EXIF orientation is respected:
the watermark sits bottom-right of the image as displayed.

Drawn on a restored file:
- PNG keeps its colour type, bit depth and every chunk. Palette and 1/2/4-bit images become
  8-bit RGBA, without the chunks that no longer fit (PLTE, tRNS, bKGD, hIST, sBIT, and a
  grey image's ICC profile). With a tRNS colour key, keyed pixels count as transparent, and
  painted pixels that would come out as the key colour are moved one level off it. In an
  APNG, every frame that holds the whole watermark gets it.
- JPEG is painted in the DCT domain: only the blocks under the watermark are decoded,
  painted and quantised again, with the file's own tables. Everything else keeps its exact
  coefficients, and the metadata stays.
- JPEG XL: its pixels (lossless again), or the JPEG inside on the JPEG route.

```html
<script src="pixmix-decoder.min.js" data-key="site-key" data-watermark="vivi-gold"></script>
```

```js
PixMix.revealAll({ key, watermark: 'vivi-gold' });   // an id: fetched from watermarks/<id>.json
PixMix.revealAll({ key, watermark: compiled });      // or a compiled watermark object
PixMix.revealAll({ key, watermark: false });         // none, even if the file carries one
const exact = await PixMix.decodeAsync(bytes, { key });                     // never watermarked
const shown = await decodeAsync(bytes, { key, watermark: 'embedded' });     // Node: the file's own
```

- The default (`'auto'`) draws the watermark the file carries, if any.
- Ids are looked up at `watermarkBase` (`data-watermark-base`, default `watermarks/` next
  to the page). The dev server serves the compiled ones there.
- A watermark that cannot be loaded or drawn is skipped with a warning; the image still
  shows. So is a carried watermark that cannot be read (damaged, or over
  `maxMetadataBytes`): restoring never needs it, and `inspect` reports it as
  `{ unreadable: true, error }`. Only asking for it (`watermark: 'embedded'`) is an error.
- `decodeAsync`, `restoreForDisplay` and `decodeToURL` stay exact unless given `watermark`.

### Watermarks in scrambled files

A scrambled file can carry two things, in private places other software ignores (PNG
chunks, JPEG APP15 segments, JPEG XL boxes). Restored files carry neither.

**The watermark for the decoder** (`encode(…, { watermark })`, `--watermark`): a whole
compiled watermark (2–3 KB), or just its id (`{ id }`, `--watermark-ref`), which the decoder
looks up. The reveal then draws it without being told which. Rekey keeps it as stored
(`watermark: null` removes it, another value replaces it; a damaged one is dropped). It is
not authenticated: like the image itself, anyone can change it.

**A visible watermark on the scrambled image** (`visibleWatermark`, `--visible-watermark`):
every viewer shows the scrambled image with the watermark on it, and pixmix still restores
the original exactly.
- The scrambled pixels under it (for JPEG, the coefficients of its whole MCUs) are kept in
  the file, compressed and encrypted with a key-derived ChaCha20 stream, so the watermark
  can't be taken off without the key. The decoder puts them back before unscrambling.
- It costs a few KB: with the defaults, 2–6 KB on an 800×500 image, 7–23 KB at 4000×2600
  (noisy content; JPEG less than PNG). It includes the watermark itself, 1–3 KB.
- The marker becomes v2 (see below), so older pixmix versions refuse the file instead of
  restoring it with the watermark scattered over the image.
- Rekey draws it again under the new key; `visibleWatermark: null` removes it. Restoring
  only needs the stashed pixels, not the watermark stored with them.
- PNG: any colour type (palette images use their nearest palette colours); APNG frames that
  hold the whole watermark. JPEG: baseline, progressive, grey. JPEG XL: both routes, but on
  the pixel route only for 8-bit sRGB images (the browser reveals 8-bit sRGB pixels, and
  the stored ones must be the same; a plain sRGB ICC profile is replaced by the sRGB
  colour encoding); others are refused.
- Tests check that pngjs, sharp (libpng, libjpeg) and jxl-oxide still read these files.

Considered and left out:
- Drawing on the scrambled image without keeping what is under it: restoring would no
  longer be exact.
- Keeping those pixels unencrypted: anyone could remove the watermark.
- Visible watermarks on 16-bit or non-sRGB JPEG XL: the reveal decodes such files to
  converted 8-bit pixels, which the stash cannot match.
- Signing the carried watermark with the key: in the browser use case the key is public.

Limits on untrusted input (see "Untrusted input"): compiled watermarks are validated (sizes,
counts, path syntax); watermark JSON counts against `maxMetadataBytes` when it is needed
(a carried one to be drawn, a stashed one for rekey to draw it again); stashed regions must lie inside the image, one per
frame (so they never add up to more than the image), and are inflated into a buffer of
exactly their size, at most `maxDecompressedBytes`; the renderer refuses a watermark covering more than 4
megapixels (or `maxPixels`) and caps outline and blur radii at 32 px. The fuzzer's seeds
include files carrying watermarks (whole and by id) and visible watermarks on every format
and route, and it mutates their payloads.

### Server and CLI

The dev server keeps definitions in `watermarks/` (`PIXMIX_WATERMARKS_DIR` overrides it):
- `GET /api/watermarks` (definitions, fonts, assets), `GET /api/watermarks/<id>`;
  `POST /api/watermarks` creates, `PUT /api/watermarks/<id>` creates or replaces,
  `DELETE /api/watermarks/<id>`; `POST /api/watermarks/preview` compiles without saving.
- `GET /watermarks/<id>.json` (compiled) and `.svg`.
- `/api/encode` takes `watermark`, `watermarkEmbed=id` and `visibleWatermark`;
  `/api/decode` takes `watermark=<id>` or `watermark=embedded`.
- Ids must match `[a-z0-9-]`, bodies are limited to 256 KB and validated strictly.

CLI: `--watermark <id|file|embedded>`, `--watermark-ref`, `--visible-watermark <id|file>`,
`--no-watermark` (rekey) and `--watermarks <dir>`. A file is a definition (compiled with
the directory's fonts) or a compiled watermark.

In Node, `pixmix/watermarks` exports `compileWatermark`, `normalizeDefinition`,
`formatDefinition`, `validateCompiled`, `watermarkStore`, `loadWatermark` and
`renderWatermark`.

## Metadata

By default metadata travels as described in "Input formats and metadata". A metadata
policy changes that: strip, keep, remove and set, the same way on PNG, JPEG and JPEG XL,
without touching the pixels. The typical site strips everything from the images it serves
and sets its own copyright:

```js
const out = await encodeAsync(photo, { key, metadata: { preset: 'web', set: { artist: 'Vivi', copyright: 'Vivi' } } });
```

```sh
pixmix encode photos/*.jpg --metadata vivi-web -o scrambled/   # a saved profile
pixmix decode photo.scrambled.jpg --metadata strip-all         # a preset
pixmix inspect photo.jpg                                       # EXIF tags, XMP, ICC, text, IPTC, …
```

### Policies

A policy is plain data (a preset name, or an object), so it can be saved, sent to a server
or to a Web Worker:

```js
{
  preset: 'privacy',                   // keep (default), strip-all, privacy, web
  keep: ['icc'], strip: ['text'],      // kinds, over the preset
  remove: ['serials', 'exif:Make', 'exif:GPS/*', 'xmp:dc:creator', 'iptc:City', 'text:Author', 'other:APP13'],
  set: {
    artist: 'Vivi', copyright: 'Vivi', title: '…', description: '…', software: '…',
    comment: ['…'],                    // replaces every comment
    orientation: 1,                    // the EXIF tag (pixels are never rotated)
    icc: 'srgb',                       // tag as sRGB (pixels are not converted)
    exif: { DateTime: '2025:01:31 12:00:00', XResolution: 72, Artist: null },  // null removes
    xmp: { 'dc:subject': ['sun', 'sea'], 'xmpRights:Marked': 'True' },
    xmpPacket: '<x:xmpmeta …>',        // replaces the whole packet
    text: { Source: 'pixmix' },        // PNG text chunks
  },
}
```

Kinds, and where they live:

| Kind | PNG | JPEG | JPEG XL |
| --- | --- | --- | --- |
| `exif` | `eXIf` | APP1 `Exif` | `Exif` box (or `brob`) |
| `xmp` | `iTXt XML:com.adobe.xmp` | APP1 XMP (+ extended XMP) | `xml ` box (or `brob`) |
| `icc` | `iCCP` | APP2 `ICC_PROFILE` | the codestream |
| `colour` | `sRGB`, `gAMA`, `cHRM`, `cICP`, `mDCV`, `cLLI` | – | the codestream |
| `text` | `tEXt`, `zTXt`, `iTXt` | COM | – |
| `density` | `pHYs` | JFIF density | – |
| `orientation` | EXIF Orientation | EXIF Orientation | the codestream |
| `other` | every other ancillary chunk (`tIME`, `caBX`, unknown ones) | APP2–APP15 (Photoshop/IPTC, JUMBF/C2PA, MPF, …) | `jumb`, unknown boxes |

Never touched: image data and structure (`PLTE`, `tRNS`, APNG chunks, unknown critical
chunks, JFIF, Adobe APP14, DQT/DHT/SOF/SOS, `jbrd`, `jxll`, …) and pixmix's own marker,
watermark and stash chunks. A block the policy leaves alone keeps its bytes, and without a
policy (or with `keep`) files come out exactly as before.

Presets:
- `keep`: everything, as without a policy.
- `strip-all`: only what displaying the pixels needs: the ICC profile, PNG colour chunks
  and the orientation (EXIF is cut down to its Orientation tag, or goes when that is 1).
  Density is dropped: browsers do not use it.
- `privacy`: every removal group below; the rest (camera, exposure, copyright, keywords,
  captions, the profile) stays.
- `web`: `strip-all`, and a plain sRGB profile goes too (viewers assume sRGB). Meant to be
  combined with `set`.

Removal groups, across EXIF, XMP, IPTC, text and other chunks:

| Group | Removes |
| --- | --- |
| `gps` | the GPS IFD, XMP `exif:GPS*`, city/state/country (XMP, IPTC) |
| `serials` | body, lens and camera serial numbers, `aux:ImageNumber` |
| `makernote` | the MakerNote, DNG private data |
| `owner` | Artist, CameraOwnerName, XPAuthor, HostComputer, `dc:creator`, IPTC By-line, PNG `Author`, … |
| `timestamps` | DateTime*, OffsetTime*, SubSecTime*, GPS date and time, XMP dates, IPTC dates, PNG `tIME` |
| `history` | ImageUniqueID, `xmpMM:*` (document ids, history), `photoshop:DocumentAncestors` |
| `thumbnail` | EXIF IFD1, XMP thumbnails, Photoshop thumbnails, JFXX, MPF, data after the image |
| `c2pa` | JUMBF / C2PA manifests (PNG `caBX`, JPEG APP11, JPEG XL `jumb`) |

Patterns are globs, case-insensitive: `exif:[IFD/]Name` (a name or `0x` number; IFDs:
IFD0, Exif, GPS, Interop, IFD1, SubIFD), `xmp:prefix:Name` (namespaces are matched by URI,
whatever prefix the file uses), `iptc:Name`, `text:Keyword` (JPEG comments are `Comment`),
`other:Type` (a PNG chunk type, `APP13`, a box type).

The convenience fields go into EXIF (created if needed: Artist, Copyright, ImageTitle,
ImageDescription, Software), into the XMP packet if the file keeps one (`dc:creator`,
`dc:rights`, `dc:title`, `dc:description`, `xmp:CreatorTool`), into PNG text if text is
kept (Author, Copyright, Title, Description, Software) and over existing IPTC datasets.
EXIF values get their tag's type (ASCII, SHORT, RATIONAL, …); bad ones are refused.

Every entry point takes `metadata`: `encode`, `convert`, `decode`, `rekey` (which keeps
the file's metadata without one), their async versions, and the browser's `reveal`,
`revealAll`, `restoreForDisplay`, `decodeToURL` and `decodeAsync` (`data-metadata` on the
script tag). Reports say what changed: `onConvert`'s report gets `metadata`, and
`decode`/`rekey` call `onMetadata`, with `{ policy, removed, set, notes }`.
The encoder's `inspect(bytes, { metadata: true })` adds `meta`, the parsed metadata.
Invalid policies throw a PixmixError with code `BAD_METADATA` that names the problem.
`applyMetadata` and `readMetadata` work on any PNG, JPEG or JPEG XL; `pixmix/metadata`
exports the rest.

### How it is edited

- **EXIF** is parsed into IFD0, Exif, GPS, Interop, IFD1 and SubIFDs, with values kept as
  bytes, so unknown tags survive, and written back in its own byte order with every
  pointer and offset (thumbnail, strips, tiles) recomputed. The MakerNote stays opaque and
  goes back to its old offset (padded), since vendors point into it from the TIFF header;
  the report says when it had to move.
- **XMP** is parsed as XML (no DTDs or custom entities, bounded depth), and what the policy
  does not touch is written back as it was. Extended XMP is not rewritten: it goes when the
  packet changes.
- **ICC**: `icc: 'srgb'` writes PNG's `sRGB` chunk (replacing iCCP and the colour chunks),
  a compact sRGB profile in JPEG, and the sRGB colour encoding in JPEG XL. Removing or
  replacing a non-sRGB profile changes how the image looks, and the report says so.
- **IPTC** in Photoshop APP13: datasets are removed or replaced, the IPTC digest dropped.
  Copies of EXIF and XMP inside it, and ImageMagick's `Raw profile type …` text chunks,
  cannot be cleaned and go when a policy changes their kind.
- **Unreadable** EXIF, XMP or IPTC is removed, not kept, when the policy needs to change it
  (so "remove the location" cannot quietly leave it in), and the report says so.

What cannot be done, and is reported instead:
- JPEG XL keeps its ICC profile, colour encoding and orientation in the codestream. The
  pixel route encodes the codestream again, so `encode`, `decode` and `rekey` can change
  the profile there; `convert` of a JPEG XL to JPEG XL does not re-encode, so it cannot.
  JPEG XL has no text, comments or density; EXIF Orientation is ignored there (the
  codestream's counts), so `strip-all` removes its EXIF entirely on the pixel route.
- A JPEG XL made from a JPEG (the JPEG route) keeps comments and other segments inside its
  reconstruction data: policies edit the JPEG, which is then recompressed, so it stays
  exact and rebuildable (`applyMetadataAsync`; the sync version edits the boxes and drops
  the reconstruction data).
- JPEG has no keyword text (only comments); EXIF or XMP over 64 KB does not fit a segment.
- Brotli-compressed JPEG XL boxes cannot be read in browsers: they go when the policy
  touches their kind.
- Orientation is a tag: stripping it (or setting 1) makes viewers show the pixels as
  stored, so a phone photo may appear sideways. pixmix never rotates pixels, which would not
  be lossless for JPEG.

### Profiles

Profiles live in `metadata-profiles/<id>.json`: a policy with an `id`, `name` and
`description`, validated and written in a fixed key order (maps sorted), so diffs stay
clean. Two defaults: `vivi-web` (the `web` preset with Vivi as artist and copyright) and
`vivi-privacy` (`privacy`, same credit). Ids use `[a-z0-9-]` and cannot be a preset name.

- CLI: `--metadata <preset|profile id|file.json>` on encode, decode and rekey;
  `--metadata-profiles <dir>`.
- Server (`PIXMIX_METADATA_PROFILES_DIR` overrides the directory):
  `GET /api/metadata-profiles` (profiles, presets, kinds, groups),
  `POST /api/metadata-profiles` creates, `GET/PUT/DELETE /api/metadata-profiles/<id>`;
  `?metadata=<preset|id>` on `/api/encode`, `/api/decode` and `/api/rekey` (the latter two
  report in `X-Pixmix-Metadata`), `?metadata=1` on `/api/inspect`.
- Lab: a profile editor with a before/after table of the current image's metadata, and
  metadata pickers for encoding and decoding.
- Browsers: the decoders fetch `pixmix-metadata.mjs` only when a policy is used.

## How it works

1. **Seed.** HKDF-SHA-256 over the key, with the per-image random salt, and info = version,
   mode, block size, width and height. The output is a ChaCha20 key/nonce plus a 4-byte key
   check.
2. **Permutation.** A Fisher–Yates shuffle driven by ChaCha20 with unbiased
   rejection sampling, integer-only so every engine agrees.
   - `pixel` mode shuffles all pixels.
   - `block` mode (the default for PNG and JPEG XL, 16 px) shuffles tiles, and with
     `transforms` (on by default) also gives each tile one of the 8 flips/rotations. The
     transform flag is the top bit of the marker's tile-size field.
   - `block` mode shuffles whole B×B tiles. The right/bottom leftover strips are shuffled
     pixel by pixel among themselves.
   - `mcu` mode (JPEG) shuffles the grid of MCUs, then draws a transform per slot.
3. **PNG.** Chunks are parsed and CRC-checked. The raster is inflated, unfiltered and
   de-interlaced into native samples; 16-bit, palette and 1/2/4-bit data are all kept as
   they are. Whole pixels are moved, then the raster is re-filtered, re-interlaced and
   deflated. Only `IDAT` changes. A `pmIx` chunk (ancillary, private, safe-to-copy) holding
   the version, mode, block size, salt and key check goes right before it.
4. **JPEG.** The entropy-coded data is decoded to quantised DCT coefficients, with no IDCT.
   Baseline, extended and progressive files are supported, along with restart markers,
   truncated data (read as libjpeg does), stray bytes between segments and scans without
   Huffman tables (Motion-JPEG frames: the Annex K tables are used, as in libjpeg).
   12-bit, lossless, arithmetic-coded and hierarchical JPEGs are refused (`UNSUPPORTED`),
   on every path.
   - Whole MCUs (8×8 or 16×16, depending on chroma subsampling) are moved with all their
     components, so colour stays attached to its brightness.
   - The transforms are applied exactly on the coefficients: flipping negates the odd
     frequencies, transposing swaps u and v. Square MCUs get 8 transforms; 4:2:2 (16×8)
     gets the 4 flips.
   - The coefficients are written back with Huffman tables optimised for the data, as
     `jpegtran -optimize` does.
     - Baseline sources are written as one baseline scan (one per component when the
       MCU has more than 10 blocks, e.g. every component sampled 2×2, as the standard
       requires).
     - Progressive sources are written as progressive scans: DC first, then AC bands,
       spectral selection with per-scan tables. `progressive: true | false` overrides that.
   - Nothing is requantised. APPn, COM and DQT segments and the SOF payload are copied
     unchanged, and an APP15 `pixmix\0` segment holds the marker. The exception: a file
     that redefines a quantisation table between scans gets one DQT with the tables its
     components really used (on free table ids) and a SOF pointing at them, the same image.
   - DC differences are written mod 2^16 (as decoders read them), so corrupt files whose
     DC predictor overflowed stay readable.
   - Restart markers are not kept.
   - **Progressive caveat.** Progressive AC scans can't store the padding blocks of partial
     edge MCUs, and scrambling may move real content into them. So a scrambled file is
     progressive only when the image has no such padding (width and height fit whole MCUs);
     otherwise it's baseline.
     - The marker records that the source was progressive, and restoring writes a
       progressive file again. That's exact, since the original couldn't hold AC data in
       padding blocks either.
     - The JPEG inside a JPEG-route JPEG XL is always baseline (see jxl-oxide above).
   - The same limit applies to MCUs of more than 10 blocks, which only non-interleaved
     scans can code: with partial edge MCUs such files are refused (`UNSUPPORTED`).

Marker v1: `u8 version | u8 mode | u16 block | u8 saltLen | salt | u8[4] check`. Marker v2
adds `u8 flags` (bit 0: a visible watermark's stash is in the file); it's only written when a
flag is set, and the permutation is the same as v1's.
- In `mcu` mode, `block` holds flags: bit 0 = transforms, bit 1 = restore as progressive.
- APNG frames mix their index into the seed; it's 0 for still images.
The permutation stream is pinned by a test. Any change to it must bump the version.

### Size and speed

Measured on 768×512 photos (Kodak test images):

| | kodim23 | kodim05 |
| --- | --- | --- |
| Original PNG / JPEG q85 | 545 / 56 KB | 767 / 128 KB |
| Unscrambled lossless PNG / JPEG XL | 545 / 366 KB | 767 / 481 KB |
| PNG, default (block 16 + flips) | 584 KB | 800 KB |
| PNG, pixel mode | 1094 KB | 1075 KB |
| JPEG XL, default / pixel mode | 399 / 1151 KB | 524 / 1047 KB |
| From the JPEG: JPEG / JXL JPEG route | 58 / 53 KB | 129 / 113 KB |
| From the JPEG: PNG (lossless) | 418 KB | 724 KB |

- **Block mode** (the default) keeps output within about 5–10% of an unscrambled lossless
  file. Tile flips cost nothing measurable.
- **Pixel mode** turns the image into noise that no lossless format can compress: about
  twice a lossless original, or roughly the raw pixel size (a 12 MP photo is about 35 MB).
  Use it only when tiles give away too much.
- **Lossy sources:** a JPEG (or lossy WebP/AVIF/JPEG XL) saved as PNG or pixel-route JPEG XL
  is 3–8× bigger even unscrambled, because lossless can't reuse the lossy compression.
  - Keep JPEGs as JPEG, or use JPEG XL's JPEG route, which is even smaller.
  - The conversion report adds a `notes` entry saying so.
  - Converting other lossy formats to `format: 'jpeg'` keeps them small too.
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

## Fuzzing

`test/fuzz/` is a deterministic fuzzer. It builds valid seed files for every input
format and every kind of scrambled output (PNG and APNG in both modes, JPEG baseline and
progressive, GIF, JPEG XL on both routes, WebP and TIFF for sharp), then mutates them:
bit flips, byte and word replacements, truncation, insertions, chunk, segment and box
length edits, duplicated, reordered and dropped chunks, header fields, garbage after valid
headers, and splices of two files. PNG CRCs are usually repaired so mutants get past them.
Metadata has its own seeds (EXIF in both byte orders with a MakerNote, GPS, Interop and a
thumbnail; XMP; IPTC; JUMBF; PNG text and raw profiles; files scrambled with a policy) and
mutations aimed at IFD entry types, counts, offsets and pointers, and at XML structure.

Each mutant goes through `inspect`, `encode`, `encodeAsync`, `decode`, `decodeAsync`,
`rekeyAsync`, `convertAsync`, `inspect({ metadata: true })`, `applyMetadata(Async)` and
the browser reveal's decoding (the last three with a metadata policy too), with the right
key and small limits. The only acceptable outcomes are success or a `PixmixError`. It is a
failure when anything else is thrown (a `PixmixError` wrapping a `TypeError` counts too),
when a case runs past its time budget (cases run in worker threads, which are replaced),
when a worker dies or runs out of heap, and when the process's memory runs away. A file
`encode` accepts (with or without a metadata policy) must also come back from `decode`
with the same PNG pixels or JPEG coefficients.

```sh
npm test                 # includes a smoke run: fixed seed, 300 cases
npm run fuzz             # 20,000 cases; settings from the environment:
PIXMIX_FUZZ_ITERATIONS=100000 PIXMIX_FUZZ_SEED=7 PIXMIX_FUZZ_WORKERS=4 npm run fuzz
PIXMIX_FUZZ_SEED=7 PIXMIX_FUZZ_CASE=1234 npm run fuzz   # rerun one case, verbosely
```

`PIXMIX_FUZZ_TIMEOUT` sets the budget per case (20 s), `PIXMIX_FUZZ_OUT` a directory for
failing inputs. Every bug it has found has a regression test in
`test/fuzz-regressions.test.js`, with the input built in code.

## Browser tests

`npm run test:browser` builds `dist/` and drives headless browsers through Playwright
(`npx playwright install chromium webkit` once). It covers:
- the `<script>` decoder: every format and effect, with the final bytes checked in Node and
  the rendering compared with the original's;
- the Web Worker, and the main-thread fallback (`data-worker="false"`, CSP
  `worker-src 'none'`);
- a decoder loaded from another origin, a wrong key, EXIF rotation;
- animated WebP through `ImageDecoder`, and the first-frame fallback without it;
- the encoder in the page: JPEG → JPEG XL on the JPEG route, animated and 16-bit JPEG XL;
- watermarks drawn by the reveal (exactly what Node draws), carried and visible ones,
  and the painter only being fetched when needed;
- the lab (every input/output/mode, encoded on the server and in the browser, the watermark
  and metadata profile editors, metadata policies when encoding and decoding) and the demo
  site.

Console errors fail a test.

Every test runs once per engine, grouped under its name (`chromium`, `webkit`).
- `PIXMIX_BROWSERS=chromium,webkit` picks the engines. The default is all of them,
  Firefox included; an engine that can't start is skipped, with the browser's error.
- WebKit is Playwright's WPE build, not Safari. It shares Safari's engine, but its image
  decoding and WebCodecs go through GStreamer, and it encodes WebP (Safari doesn't).

If a browser can't start because the host lacks its shared libraries, either install them
system-wide (`sudo npx playwright install-deps`), or unpack them somewhere (`apt-get
download` + `dpkg -x`) and set:
- `PIXMIX_BROWSER_LIBS` to the library directories, colon-separated. They're added to
  `LD_LIBRARY_PATH`, and Playwright's dependency check (which ignores them) is skipped.
  For WebKit the harness also:
  - runs a copy of Playwright's launcher that keeps them;
  - points glvnd and GStreamer at the unpacked `share/glvnd/egl_vendor.d` and
    `gstreamer-1.0` plugins next to them.
  WebKit also needs Mesa's EGL (`libegl-mesa0`, `mesa-libgallium`) and GStreamer's base
  plugins; without them its web process crashes on animated images.
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
- [x] Phase 6: real-browser test suite (Chromium, WebKit); animated WebP / JPEG XL → APNG; 16-bit
  input kept in PNG; progressive JPEGs stay progressive
- [x] Phase 7: pixmix's own libjxl 0.12 WASM encoder: JPEG recompression in browsers too;
  JPEG XL output keeps ICC profiles, 16-bit samples and animations
- [x] Phase 8: watermarks: committed definitions compiled to outlines, a deterministic
  renderer, drawn by the reveal, the server and the CLI; carried in scrambled files, or
  visible on them with exact restoring; lab editor
- [x] Phase 9: metadata policies: EXIF/XMP/ICC/IPTC editing on every format, presets,
  saved profiles, CLI, server and lab
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
- opentype.js (MIT) compiles watermark text; it is not in any bundle.
- exifr (MIT) reads metadata back in the tests; it is not in any bundle.
- Watermark fonts (SIL Open Font License 1.1, texts in `watermarks/fonts/`): Press Start 2P,
  Pixelify Sans (both by their project authors) and Cinzel Decorative (Natanael Gama), from
  the Google Fonts repository.

Test images: [PngSuite](http://www.schaik.com/pngsuite/) by Willem van Schaik (see
`test/fixtures/pngsuite/PngSuite.LICENSE`).
