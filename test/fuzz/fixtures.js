// Valid seed inputs for the fuzzer: every input format pixmix reads, and every kind of file
// it writes (scrambled PNG/APNG in both modes, JPEG baseline and progressive, JPEG XL on
// both routes). Built in code, deterministically (fixed salt), so no opaque binaries are
// needed beyond a few PngSuite images.

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { GifWriter } from 'omggif';
import { encode, encodeAsync, convert, convertAsync } from '../../src/index.js';
import { sharpDecoder } from '../../src/plugins/sharp.js';
import { loadJxlCodec } from '../../src/formats/jxl/load.js';
import { writeJxl } from '../../src/formats/jxl/container.js';
import { writeChunks } from '../../src/formats/png/chunks.js';
import { encodeRaster } from '../../src/formats/png/raster.js';
import { readSegments, writeSegments, M, isSof } from '../../src/formats/jpeg/markers.js';
import { decodeFrame } from '../../src/formats/jpeg/decode.js';
import { assembleJpeg } from '../../src/formats/jpeg/encode.js';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { compileWatermark } from '../../src/watermark/compile.js';
import { writeExif, encodeEntry, settableTag } from '../../src/meta/tiff.js';

export const KEY = 'fuzz-key';
const SALT = new Uint8Array(16).fill(7);
const PNGSUITE = [
  'basn2c08', 'basi3p04', 'basn6a16', 'basi0g01', 'basn3p02', 'basi4a08', 'tbbn3p08', 'ccwn2c08',
  'ctzn0g04', 'ctjn0g04', 'exif2c08', 'cs3n2c16', 's09i3p02', 'oi9n2c16',
];

const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function rgba(w, h, seed = 1, alpha = false) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = (x * 9 + seed * 40) & 255; d[o + 1] = (y * 7 + seed * 13) & 255; d[o + 2] = ((x ^ y) * 5) & 255;
    d[o + 3] = alpha ? (x * 11 + y) & 255 : 255;
  }
  return d;
}

const raw = (w, h, opts = {}) => sharp(Buffer.from(rgba(w, h, opts.seed ?? 1, opts.alpha)), { raw: { width: w, height: h, channels: 4 } });

/** APNG with a default image outside the animation and a partial, offset frame. */
function apng() {
  const ihdr = { width: 20, height: 14, depth: 8, colorType: 6, interlace: 0 };
  const frames = [{ w: 20, h: 14, x: 0, y: 0 }, { w: 9, h: 6, x: 4, y: 3 }, { w: 20, h: 14, x: 0, y: 0 }];
  const chunks = [{ type: 'IHDR', data: cat(u32(20, 14), Uint8Array.of(8, 6, 0, 0, 0)) }, { type: 'acTL', data: u32(2, 0) }];
  let seq = 0;
  frames.forEach((f, i) => {
    const z = encodeRaster({ ...ihdr, width: f.w, height: f.h }, rgba(f.w, f.h, i + 1, true));
    if (i === 0) { chunks.push({ type: 'IDAT', data: z }); return; }
    chunks.push({ type: 'fcTL', data: cat(u32(seq++, f.w, f.h, f.x, f.y), Uint8Array.of(0, 1, 0, 10, i & 1, 0)) });
    chunks.push({ type: 'fdAT', data: cat(u32(seq++), z) });
  });
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });
  return writeChunks(chunks);
}

function gif({ animated }) {
  const buf = new Uint8Array(1 << 16);
  const w = 18, h = 12;
  const gw = new GifWriter(buf, w, h, { loop: 0, palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x808080, 0x00ffff, 0xff00ff] });
  const px = (fw, fh, k) => Uint8Array.from({ length: fw * fh }, (_, i) => (i * k + (i / fw | 0)) & 7);
  gw.addFrame(0, 0, w, h, px(w, h, 3), { delay: 5, disposal: 1 });
  if (animated) {
    gw.addFrame(3, 2, 8, 6, px(8, 6, 5), { delay: 0, disposal: 2, transparent: 4 });
    gw.addFrame(1, 1, 10, 9, px(10, 9, 1), { delay: 12, disposal: 3 });
    gw.addFrame(0, 0, w, h, px(w, h, 7), { delay: 3 });
  }
  return buf.slice(0, gw.end());
}

/** Little-endian TIFF (EXIF): orientation in IFD0, and an IFD1 thumbnail. */
function exifWithThumbnail(thumb) {
  const b = new Uint8Array(56 + thumb.length);
  const dv = new DataView(b.buffer);
  b.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x0112, true); dv.setUint16(12, 3, true); dv.setUint32(14, 1, true); dv.setUint16(18, 6, true);
  dv.setUint32(22, 26, true); // IFD1
  dv.setUint16(26, 2, true);
  dv.setUint16(28, 0x0201, true); dv.setUint16(30, 4, true); dv.setUint32(32, 1, true); dv.setUint32(36, 56, true);
  dv.setUint16(40, 0x0202, true); dv.setUint16(42, 4, true); dv.setUint32(44, 1, true); dv.setUint32(48, thumb.length, true);
  b.set(thumb, 56);
  return b;
}

/**
 * A JPEG with every kind of embedded preview pixmix strips (EXIF, JFIF and Photoshop
 * thumbnails, MPF, trailing data) plus an ICC profile split over two segments and XMP.
 */
function jpegWithMetadata(jpeg) {
  const { segments } = readSegments(jpeg);
  const irb = cat(ascii('Photoshop 3.0\0'), ascii('8BIM'), Uint8Array.of(0x04, 0x09, 0, 0), u32(6), ascii('thumb!'),
    ascii('8BIM'), Uint8Array.of(0x04, 0x04, 0, 0), u32(3), ascii('iptc'));
  const icc = new Uint8Array(300).map((_, i) => i * 7);
  icc.set(ascii('RGB '), 16);
  const extra = [
    { marker: M.APP0, data: cat(ascii('JFIF\0'), Uint8Array.of(1, 2, 1, 0, 72, 0, 72, 1, 1), new Uint8Array(3).fill(99)) },
    { marker: M.APP1, data: cat(ascii('Exif\0\0'), exifWithThumbnail(jpeg.subarray(0, 64))) },
    { marker: M.APP1, data: cat(ascii('http://ns.adobe.com/xap/1.0/\0'), ascii('<x:xmpmeta>fuzz</x:xmpmeta>')) },
    { marker: M.APP2, data: cat(ascii('ICC_PROFILE\0'), Uint8Array.of(1, 2), icc.subarray(0, 150)) },
    { marker: M.APP2, data: cat(ascii('ICC_PROFILE\0'), Uint8Array.of(2, 2), icc.subarray(150)) },
    { marker: M.APP2, data: cat(ascii('MPF\0'), new Uint8Array(16)) },
    { marker: M.APP13, data: irb },
    { marker: M.COM, data: ascii('a comment') },
  ];
  return writeSegments([...extra, ...segments.filter((s) => s.marker !== M.APP0)], ascii('trailing motion photo'));
}

/**
 * EXIF with every structure the policies edit: IFD0, Exif (with a MakerNote and Interop),
 * GPS, an IFD1 thumbnail, an unknown tag; little- or big-endian.
 */
function richExif(le, thumb) {
  const e = { le, ifds: { IFD0: [], Exif: [], GPS: [], Interop: [], IFD1: [] }, subIfds: [], makerNoteOffset: null, warnings: [] };
  const put = (name, v) => { const info = settableTag(name); e.ifds[info.ifd].push(encodeEntry(info, v, le)); };
  put('Make', 'Fuzzcam'); put('Model', 'F1'); put('Orientation', 6); put('Artist', 'Someone'); put('DateTime', '2024:01:02 03:04:05');
  put('XPAuthor', 'Someone'); put('DateTimeOriginal', '2024:01:02 03:04:05'); put('BodySerialNumber', 'SN1'); put('FNumber', 2.8);
  put('UserComment', 'hello'); put('GPSLatitudeRef', 'N'); put('GPSLatitude', [48, 51, 24]); put('GPSAltitude', 35.5);
  e.ifds.Exif.push({ tag: 0x927c, type: 7, count: 12, data: Uint8Array.from('MAKERNOTE123', (c) => c.charCodeAt(0)) });
  e.ifds.IFD0.push({ tag: 0xc0de, type: 7, count: 6, data: Uint8Array.of(1, 2, 3, 4, 5, 6) });
  e.ifds.Interop.push({ tag: 1, type: 2, count: 4, data: ascii('R98\0') });
  e.ifds.IFD1.push({ tag: 0x0103, type: 3, count: 1, data: le ? Uint8Array.of(6, 0) : Uint8Array.of(0, 6) },
    { tag: 0x0201, type: 4, count: 1, data: new Uint8Array(4), blobs: [thumb] }, { tag: 0x0202, type: 4, count: 1, data: u32le(thumb.length, le) });
  return writeExif(e).tiff;
}
const u32le = (v, le) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, le); return b; };

const RICH_XMP = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" '
  + 'xmp:CreatorTool="fuzz &amp; co" exif:GPSLatitude="48,51N"><dc:creator><rdf:Seq><rdf:li>Someone</rdf:li></rdf:Seq></dc:creator>'
  + '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) Someone</rdf:li></rdf:Alt></dc:rights><!-- note -->'
  + '<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:image xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">AAAA</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/** Photoshop APP13 with IPTC (a creator, a city, keywords) and a digest. */
function iptcPayload() {
  const ds = (n, t) => cat(Uint8Array.of(0x1c, 2, n, 0, t.length), ascii(t));
  const iim = cat(Uint8Array.of(0x1c, 1, 90, 0, 3, 0x1b, 0x25, 0x47), ds(80, 'Someone'), ds(90, 'Paris'), ds(25, 'fuzz'), ds(116, '(c)'));
  const res = (id, data) => cat(ascii('8BIM'), Uint8Array.of(id >> 8, id & 255, 0, 0), u32(data.length), data, new Uint8Array(data.length & 1));
  return cat(ascii('Photoshop 3.0\0'), res(0x0404, iim), res(0x0425, new Uint8Array(16).fill(9)));
}

/** A JPEG with every kind of metadata the policies handle. */
function jpegWithRichMetadata(jpeg, le) {
  const { segments } = readSegments(jpeg);
  const extra = [
    { marker: M.APP1, data: cat(ascii('Exif\0\0'), richExif(le, jpeg.subarray(0, 48))) },
    { marker: M.APP1, data: cat(ascii('http://ns.adobe.com/xap/1.0/\0'), new TextEncoder().encode(RICH_XMP)) },
    { marker: M.APP13, data: iptcPayload() },
    { marker: 0xeb, data: cat(ascii('JP'), Uint8Array.of(0, 1, 0, 0, 0, 1), u32(38), ascii('jumb'), u32(30), ascii('jumd'), new Uint8Array(16).fill(0x11), Uint8Array.of(3), ascii('c2pa\0')) },
    { marker: M.COM, data: ascii('comment ✓') },
  ];
  return writeSegments([segments[0], ...extra, ...segments.slice(1).filter((s) => s.marker !== M.APP1)]);
}

/** A JPEG re-assembled with restart markers every 2 MCUs. */
function withRestarts(jpeg) {
  const { segments } = readSegments(jpeg);
  const frame = decodeFrame(segments);
  const header = segments.filter((s) => ![M.DHT, M.SOS, M.DRI].includes(s.marker) && !isSof(s.marker));
  return assembleJpeg(header, frame, { restartInterval: 2 });
}

/**
 * @returns {Promise<{name: string, bytes: Uint8Array, scrambled: boolean, weight: number}[]>}
 *   weight: how often the fuzzer picks it (slow ones, like the JPEG route, less)
 */
export async function buildFixtures() {
  const out = [];
  const add = (name, bytes, { scrambled = false, weight = 1 } = {}) => out.push({ name, bytes: new Uint8Array(bytes), scrambled, weight });
  const scrambled = (name, bytes, opts, weight) => add(name, encode(bytes, { key: KEY, salt: SALT, ...opts }), { scrambled: true, weight });

  // PNG, straight from PngSuite (interlaced, sub-byte, 16-bit, palettes, tRNS, text, EXIF…).
  for (const name of PNGSUITE) add(`png:${name}`, readFileSync(new URL(`../fixtures/pngsuite/${name}.png`, import.meta.url)), { weight: 0.5 });
  const png = new Uint8Array(await raw(24, 16, { alpha: true }).png().toBuffer());
  add('png:rgba', png);
  scrambled('png:scrambled-pixel', png, { mode: 'pixel' }, 2);
  scrambled('png:scrambled-block', png, { mode: 'block', block: 5 }, 2);
  scrambled('png:scrambled-interlaced', readFileSync(new URL('../fixtures/pngsuite/basi3p04.png', import.meta.url)), { mode: 'block', block: 4 });

  // APNG, and animated GIF -> APNG.
  const anim = apng();
  add('apng', anim);
  scrambled('apng:scrambled', anim, { mode: 'block', block: 3 }, 2);
  const agif = gif({ animated: true });
  add('gif:animated', agif);
  add('gif:still', gif({ animated: false }));
  add('apng:from-gif', convert(agif, { format: 'png' }).bytes);
  scrambled('apng:scrambled-from-gif', agif, {}, 1);

  // JPEG: baseline, 4:4:4, progressive, grey, CMYK, restart intervals, with metadata.
  const exif = { IFD0: { Orientation: '6', Copyright: 'fuzz' } };
  const baseline = new Uint8Array(await raw(40, 24).removeAlpha().withExif(exif).jpeg({ quality: 80 }).toBuffer());
  const progressive = new Uint8Array(await raw(33, 20).removeAlpha().jpeg({ quality: 85, progressive: true }).toBuffer());
  const p444 = new Uint8Array(await raw(24, 24).removeAlpha().jpeg({ quality: 90, progressive: true, chromaSubsampling: '4:4:4' }).toBuffer());
  add('jpeg:baseline', baseline);
  add('jpeg:444', await raw(19, 13).removeAlpha().jpeg({ chromaSubsampling: '4:4:4' }).toBuffer());
  add('jpeg:progressive', progressive);
  add('jpeg:progressive-444', p444);
  add('jpeg:grey', await raw(21, 11).removeAlpha().greyscale().jpeg().toBuffer(), { weight: 0.5 });
  add('jpeg:cmyk', await raw(16, 16).removeAlpha().toColourspace('cmyk').jpeg().toBuffer(), { weight: 0.5 });
  add('jpeg:restarts', withRestarts(baseline));
  add('jpeg:metadata', jpegWithMetadata(baseline));
  add('png:exif-thumbnail', writeChunks([
    { type: 'IHDR', data: cat(u32(24, 16), Uint8Array.of(8, 6, 0, 0, 0)) },
    { type: 'eXIf', data: exifWithThumbnail(baseline.subarray(0, 64)) },
    { type: 'iCCP', data: cat(ascii('icc\0\0'), deflateSync(new Uint8Array(200).map((_, i) => (i === 16 ? 0x52 : i === 17 ? 0x47 : i === 18 ? 0x42 : i === 19 ? 0x20 : i)))) },
    { type: 'zTXt', data: cat(ascii('Comment\0\0'), deflateSync(ascii('compressed comment'))) },
    { type: 'iTXt', data: cat(ascii('XML:com.adobe.xmp\0\x01\0\0\0'), deflateSync(ascii('<x:xmpmeta/>'))) },
    { type: 'IDAT', data: encodeRaster({ width: 24, height: 16, depth: 8, colorType: 6, interlace: 0 }, rgba(24, 16, 2, true)) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]));
  // Metadata of every kind, for the policies (both EXIF byte orders), plain and scrambled
  // with a policy applied.
  const rich = jpegWithRichMetadata(baseline, true);
  add('jpeg:rich-metadata', rich, { weight: 1.5 });
  add('jpeg:rich-metadata-mm', jpegWithRichMetadata(baseline, false), { weight: 1 });
  const richPng = writeChunks([
    { type: 'IHDR', data: cat(u32(24, 16), Uint8Array.of(8, 6, 0, 0, 0)) },
    { type: 'iCCP', data: cat(ascii('icc\0\0'), deflateSync(new Uint8Array(200).map((_, i) => (i === 16 ? 0x52 : i === 17 ? 0x47 : i === 18 ? 0x42 : i === 19 ? 0x20 : i === 36 ? 0x61 : i === 37 ? 0x63 : i === 38 ? 0x73 : i === 39 ? 0x70 : i)))) },
    { type: 'gAMA', data: u32(45455) },
    { type: 'eXIf', data: richExif(false, baseline.subarray(0, 40)) },
    { type: 'iTXt', data: cat(ascii('XML:com.adobe.xmp\0\0\0\0\0'), new TextEncoder().encode(RICH_XMP)) },
    { type: 'tEXt', data: cat(ascii('Author\0Someone')) },
    { type: 'zTXt', data: cat(ascii('Raw profile type exif\0\0'), deflateSync(ascii('\nexif\n 4\n45786966\n'))) },
    { type: 'tIME', data: Uint8Array.of(7, 232, 1, 2, 3, 4, 5) },
    { type: 'caBX', data: ascii('jumbc2pa') },
    { type: 'pHYs', data: cat(u32(2835, 2835), Uint8Array.of(1)) },
    { type: 'IDAT', data: encodeRaster({ width: 24, height: 16, depth: 8, colorType: 6, interlace: 0 }, rgba(24, 16, 4, true)) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
  add('png:rich-metadata', richPng, { weight: 1.5 });
  const web = { preset: 'web', set: { artist: 'Vivi', copyright: 'Vivi', exif: { Software: 'fuzz' } } };
  scrambled('jpeg:scrambled-policy', rich, { metadata: 'privacy' }, 1);
  scrambled('png:scrambled-policy', richPng, { metadata: web, mode: 'block', block: 4 }, 1);
  scrambled('jpeg:scrambled', baseline, {}, 2);
  scrambled('jpeg:scrambled-progressive', p444, {}, 2);
  scrambled('jpeg:scrambled-no-transforms', progressive, { transforms: false });

  // JPEG XL: pixel route (bare and in a container with metadata boxes), animated, JPEG route.
  const codec = await loadJxlCodec();
  const cs = await codec.encode({ width: 17, height: 11, data: rgba(17, 11, 3, true) }, { effort: 1 });
  const xmp = cat(ascii('xml '), brotliCompressSync(ascii('<x:xmpmeta>fuzz</x:xmpmeta>')));
  const tiff = exifWithThumbnail(baseline.subarray(0, 40));
  const jxl = writeJxl([{ type: 'Exif', data: cat(new Uint8Array(4), tiff) }, { type: 'brob', data: xmp }], cs);
  add('jxl:brob-exif', writeJxl([{ type: 'brob', data: cat(ascii('Exif'), brotliCompressSync(cat(new Uint8Array(4), tiff))) }], cs), { weight: 0.5 });
  add('jxl:bare', cs, { weight: 0.5 });
  add('jxl:container', jxl);
  add('jxl:lossy', writeJxl([], await codec.encode({ width: 16, height: 8, data: rgba(16, 8, 5) }, { distance: 1.5, effort: 1 })), { weight: 0.5 });
  add('jxl:scrambled-pixel', await encodeAsync(jxl, { key: KEY, salt: SALT, mode: 'pixel', effort: 1 }), { scrambled: true, weight: 2 });
  add('jxl:scrambled-block', await encodeAsync(jxl, { key: KEY, salt: SALT, mode: 'block', block: 4, effort: 1 }), { scrambled: true });
  // libjxl's other outputs: animation, 16-bit, an ICC profile (each plain and scrambled).
  const toJxl = async (bytes) => (await convertAsync(bytes, { format: 'jxl' })).bytes;
  const animJxl = await toJxl(agif);
  const deepJxl = await toJxl(readFileSync(new URL('../fixtures/pngsuite/basn6a16.png', import.meta.url)));
  const p3 = new Uint8Array(await raw(14, 10).withIccProfile('p3').png().toBuffer());
  const iccJxl = await toJxl(p3);
  add('jxl:animated', animJxl, { weight: 0.7 });
  add('jxl:16-bit', deepJxl, { weight: 0.7 });
  add('jxl:icc', iccJxl, { weight: 0.7 });
  add('jxl:scrambled-animated', await encodeAsync(animJxl, { key: KEY, salt: SALT, mode: 'block', block: 3, effort: 1 }), { scrambled: true });
  add('jxl:scrambled-16-bit', await encodeAsync(deepJxl, { key: KEY, salt: SALT, mode: 'pixel', effort: 1 }), { scrambled: true, weight: 0.7 });
  add('jxl:scrambled-icc', await encodeAsync(iccJxl, { key: KEY, salt: SALT, mode: 'pixel', effort: 1 }), { scrambled: true, weight: 0.7 });
  add('png:icc-p3', p3, { weight: 0.5 });
  // JPEG route: recompressed JPEGs, now in-process (baseline, progressive, 4:4:4, grey).
  add('jxl:rich-metadata', writeJxl([{ type: 'Exif', data: cat(new Uint8Array(4), richExif(true, baseline.subarray(0, 32))) },
    { type: 'xml ', data: new TextEncoder().encode(RICH_XMP) }, { type: 'jumb', data: ascii('c2pa manifest') }], cs), { weight: 1 });
  add('jxl:jpeg-route-rich-metadata', await codec.transcodeJpeg(convert(rich).bytes), { weight: 0.5 });
  add('jxl:jpeg-route', await codec.transcodeJpeg(baseline), { weight: 0.5 });
  add('jxl:jpeg-route-progressive', await codec.transcodeJpeg(progressive), { weight: 0.5 });
  add('jxl:scrambled-jpeg-route', await encodeAsync(baseline, { key: KEY, salt: SALT, format: 'jxl' }), { scrambled: true, weight: 1 });
  add('jxl:scrambled-jpeg-route-444', await encodeAsync(p444, { key: KEY, salt: SALT, format: 'jxl' }), { scrambled: true, weight: 0.5 });

  // Watermarks: carried (whole, and by id) and visible on the scrambled image, on every
  // format and route. The fixtures are tiny, so the watermark is one that fits them.
  const wm = fuzzWatermark();
  const carried = { watermark: wm };
  const visible = { watermark: { id: 'vivi-gold' }, visibleWatermark: wm };
  scrambled('png:wm-carried', png, { ...carried, mode: 'block', block: 4 }, 1.5);
  scrambled('png:wm-visible', png, visible, 1.5);
  scrambled('png:wm-visible-palette', readFileSync(new URL('../fixtures/pngsuite/basi3p04.png', import.meta.url)), visible, 0.7);
  scrambled('apng:wm-visible', anim, { ...visible, mode: 'block', block: 3 }, 1);
  scrambled('jpeg:wm-carried-id', baseline, { watermark: { id: 'vivi-window' } }, 0.7);
  scrambled('jpeg:wm-visible', baseline, visible, 1.5);
  scrambled('jpeg:wm-visible-progressive', p444, { ...carried, visibleWatermark: wm }, 1.5);
  add('jxl:wm-visible-pixel', await encodeAsync(jxl, { key: KEY, salt: SALT, mode: 'pixel', effort: 1, ...carried, visibleWatermark: wm }), { scrambled: true, weight: 1 });
  add('jxl:wm-carried-id', await encodeAsync(jxl, { key: KEY, salt: SALT, mode: 'block', block: 4, effort: 1, watermark: { id: 'vivi-pixel' } }), { scrambled: true, weight: 0.5 });
  add('jxl:wm-visible-jpeg-route', await encodeAsync(baseline, { key: KEY, salt: SALT, format: 'jxl', ...visible }), { scrambled: true, weight: 0.7 });

  // Formats only a plugin reads.
  add('webp:lossy', await raw(22, 14).webp({ quality: 70 }).toBuffer());
  add('webp:lossless-alpha', await raw(15, 9, { alpha: true }).webp({ lossless: true }).toBuffer());
  add('webp:animated', await sharp(Buffer.from(agif), { animated: true }).webp().toBuffer());
  add('tiff', await raw(12, 10).tiff().toBuffer(), { weight: 0.3 });
  return out;
}

let wmCache = null;
/**
 * A compiled watermark that shows on the fuzzer's tiny images and uses every drawing path:
 * outline, blurred shadow, a bordered gradient box and ornaments.
 */
export function fuzzWatermark() {
  wmCache ??= compileWatermark({
    id: 'fuzz', text: 'Vi', font: 'PixelifySans', size: { px: 7 }, fit: { maxWidth: 1, maxHeight: 1, minSize: 1 },
    margin: { relative: 0, min: 1, max: 1 }, fill: { type: 'linear', angle: 135, stops: [{ at: 0, color: '#ffe080' }, { at: 1, color: '#a06010c0' }] },
    stroke: { color: '#101030', width: 0.1 }, shadow: { color: '#000000', opacity: 0.5, x: 0.1, y: 0.1, blur: 0.2 },
    background: { shape: 'pill', fill: '#20308080', padding: { x: 0.3, y: 0.15 }, border: { fill: '#ffffff', width: 0.08 } },
    ornaments: [{ shape: 'sparkle', position: 'top-right', size: 0.4 }, { shape: 'line', position: 'below', size: 1 }],
  }, { font: (n) => readFileSync(new URL(`../../watermarks/fonts/${n}.ttf`, import.meta.url)) });
  return wmCache;
}

/** Plugins the fuzzer hands to encodeAsync, so WebP/TIFF input reaches sharp. */
export const pluginDecoders = () => [sharpDecoder(sharp, { formats: ['webp', 'avif', 'heic', 'tiff'] })];
