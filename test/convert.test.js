import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { GifWriter } from 'omggif';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { encode, encodeAsync, decode, convert, inspect } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { buildPng } from '../src/convert/png-build.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { readOrientation } from '../src/meta/exif.js';

const W = 48, H = 32;
const ascii = (s) => Buffer.from(s, 'latin1');
const chunk = (png, type) => readChunks(png).find((c) => c.type === type)?.data;
const chunkTypes = (png) => readChunks(png).map((c) => c.type);
const rgbaOf = (png) => {
  const p = PNG.sync.read(Buffer.from(png));
  return new Uint8Array(p.data);
};

function gradient(w = W, h = H) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data[o] = (x * 255) / w; data[o + 1] = (y * 255) / h; data[o + 2] = 128; data[o + 3] = 255;
  }
  return data;
}

function tiffWithOrientation(value) {
  const b = Buffer.alloc(26);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8); // one entry
  b.writeUInt16LE(0x0112, 10); b.writeUInt16LE(3, 12); b.writeUInt32LE(1, 14); b.writeUInt16LE(value, 18);
  b.writeUInt32LE(0, 22);
  return b;
}

function fakeIcc(space, size = 3000) {
  const icc = Buffer.alloc(size, 7);
  icc.writeUInt32BE(size, 0);
  icc.write(space, 16, 'latin1');
  icc.write('acsp', 36, 'latin1');
  return icc;
}

const segment = (marker, payload) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/** A baseline JPEG from jpeg-js with extra metadata segments spliced in after SOI. */
function jpegWithMetadata({ icc, exif, xmp, comment, dpi } = {}) {
  const base = jpeg.encode({ width: W, height: H, data: Buffer.from(gradient()) }, 90).data;
  let body = base.subarray(2);
  if (body[0] === 0xff && body[1] === 0xe0) body = body.subarray(2 + body.readUInt16BE(2)); // drop jpeg-js JFIF
  const segs = [];
  if (dpi) {
    const jfif = Buffer.alloc(14);
    jfif.write('JFIF\0', 0, 'latin1'); jfif[5] = 1; jfif[6] = 1; jfif[7] = 1;
    jfif.writeUInt16BE(dpi, 8); jfif.writeUInt16BE(dpi, 10);
    segs.push(segment(0xe0, jfif));
  }
  if (exif) segs.push(segment(0xe1, Buffer.concat([ascii('Exif\0\0'), exif])));
  if (xmp) segs.push(segment(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp)])));
  if (icc) {
    // Split across two APP2 segments, deliberately written out of order.
    const half = Math.ceil(icc.length / 2);
    const part = (seq, data) => segment(0xe2, Buffer.concat([ascii('ICC_PROFILE\0'), Buffer.from([seq, 2]), data]));
    segs.push(part(2, icc.subarray(half)), part(1, icc.subarray(0, half)));
  }
  if (comment) segs.push(segment(0xfe, ascii(comment)));
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, body]));
}

const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';

test('JPEG -> PNG carries ICC, EXIF, XMP, density and comments', () => {
  const icc = fakeIcc('RGB ');
  const exif = tiffWithOrientation(6);
  const src = jpegWithMetadata({ icc, exif, xmp: XMP, comment: 'hello', dpi: 300 });
  const r = convert(src, { format: 'png' });
  assert.equal(r.from, 'jpeg');
  assert.equal(r.decoder, 'jpeg-js');
  assert.deepEqual(r.transferred.sort(), ['EXIF', 'ICC profile', 'XMP', 'comments', 'density']);
  assert.deepEqual(r.dropped, []);

  const iccp = chunk(r.bytes, 'iCCP');
  const nul = iccp.indexOf(0);
  assert.ok(Buffer.from(inflateSync(iccp.subarray(nul + 2))).equals(icc), 'ICC reassembled in order');
  assert.ok(Buffer.from(chunk(r.bytes, 'eXIf')).equals(exif));
  assert.equal(readOrientation(chunk(r.bytes, 'eXIf')), 6);
  assert.ok(Buffer.from(chunk(r.bytes, 'iTXt')).toString('utf8').endsWith(XMP));
  assert.equal(Buffer.from(chunk(r.bytes, 'pHYs')).readUInt32BE(0), Math.round(300 / 0.0254));
  assert.equal(Buffer.from(chunk(r.bytes, 'tEXt')).toString('latin1'), 'Comment\0hello');
  // Chunk order rules: iCCP/eXIf before image data.
  const types = chunkTypes(r.bytes);
  assert.ok(types.indexOf('iCCP') < types.indexOf('IDAT') && types.indexOf('eXIf') < types.indexOf('IDAT'));

  // Pixels are exactly what the JPEG decodes to.
  const ref = jpeg.decode(src, { useTArray: true, formatAsRGBA: true });
  assert.deepEqual(rgbaOf(r.bytes), new Uint8Array(ref.data));
});

test('JPEG input encodes to a scrambled PNG that restores exactly', () => {
  const src = jpegWithMetadata({ icc: fakeIcc('RGB '), exif: tiffWithOrientation(3), dpi: 72 });
  let report;
  const scrambled = encode(src, { key: 'k', format: 'png', mode: 'block', block: 8, onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'jpeg');
  assert.equal(inspect(scrambled).scrambled, true);
  const restored = decode(scrambled, { key: 'k' });
  const plain = convert(src, { format: 'png' }).bytes;
  assert.deepEqual(rgbaOf(restored), rgbaOf(plain));
  for (const t of ['iCCP', 'eXIf', 'pHYs']) assert.deepEqual(chunk(restored, t), chunk(plain, t));
  assert.ok(!chunkTypes(restored).includes('pmIx'));
});

test('inspect reports JPEG metadata and orientation', () => {
  const info = inspect(jpegWithMetadata({ exif: tiffWithOrientation(8), xmp: XMP }));
  assert.equal(info.format, 'jpeg');
  assert.equal(info.scrambled, false);
  assert.deepEqual([info.width, info.height], [W, H]);
  assert.deepEqual(info.metadata, ['exif', 'xmp']);
  assert.equal(info.orientation, 8);
});

test('CMYK ICC profiles are dropped with a reason', () => {
  const r = convert(jpegWithMetadata({ icc: fakeIcc('CMYK') }), { format: 'png' });
  assert.ok(!chunk(r.bytes, 'iCCP'));
  assert.deepEqual(r.dropped, ['ICC profile (CMYK colour space)']);
});

test('colour type selection is lossless and minimal', () => {
  const cases = [];
  // 20x20 = 400 pixels, so fully distinct colours cannot fit a palette.
  const make = (fill) => { const d = new Uint8Array(20 * 20 * 4); for (let i = 0; i < 400; i++) d.set(fill(i), i * 4); return d; };
  cases.push(['grey', make((i) => [i & 255, i & 255, i & 255, 255]), 0, 8]);
  cases.push(['grey+alpha', make((i) => [i & 255, i & 255, i & 255, i >> 1]), 4, 8]);
  cases.push(['2 colours', make((i) => (i % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])), 3, 1]);
  cases.push(['palette+alpha', make((i) => [i % 10, 50, 0, i % 3 ? 255 : 0]), 3, 8]);
  cases.push(['rgb', make((i) => [i & 255, i >> 2, (i * 7) & 255, 255]), 2, 8]);
  cases.push(['rgba', make((i) => [i & 255, i >> 2, (i * 7) & 255, i & 255]), 6, 8]);
  for (const [name, data, colorType, depth] of cases) {
    const { png } = buildPng({ width: 20, height: 20, data });
    const ihdr = chunk(png, 'IHDR');
    assert.equal(ihdr[9], colorType, `${name}: colour type`);
    assert.equal(ihdr[8], depth, `${name}: depth`);
    assert.deepEqual(rgbaOf(png), data, `${name}: pixels`);
  }
});

test('ICC profile space constrains the colour type', () => {
  const grey = new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : 90));
  const rgb = buildPng({ width: 8, height: 8, data: grey }, { icc: fakeIcc('RGB ') });
  assert.notEqual(chunk(rgb.png, 'IHDR')[9], 0, 'RGB profile forbids grey PNG');
  assert.ok(chunk(rgb.png, 'iCCP'));
  const colour = gradient(8, 8);
  const bad = buildPng({ width: 8, height: 8, data: colour }, { icc: fakeIcc('GRAY') });
  assert.deepEqual(bad.dropped, ['ICC profile (GRAY profile on a colour image)']);
  assert.deepEqual(rgbaOf(bad.png), colour);
});

test('animated GIF keeps the first frame as a palette PNG', () => {
  const buf = Buffer.alloc(4096);
  const gw = new GifWriter(buf, 4, 4, { loop: 0, palette: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff] });
  gw.addFrame(0, 0, 4, 4, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
  gw.addFrame(0, 0, 4, 4, new Array(16).fill(3));
  const r = convert(new Uint8Array(buf.subarray(0, gw.end())));
  assert.equal(r.from, 'gif');
  assert.deepEqual(r.dropped, ['animation (first frame kept)']);
  assert.equal(chunk(r.bytes, 'IHDR')[9], 3);
  const px = rgbaOf(r.bytes);
  assert.deepEqual([...px.subarray(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('formats without a built-in decoder ask for a plugin', async () => {
  const webp = await sharp(Buffer.from(gradient()), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toBuffer();
  assert.throws(() => encode(webp, { key: 'k' }), /pass a decoder plugin/);
  assert.throws(() => encode(webp, { key: 'k', decoders: [sharpDecoder(sharp)] }), { code: 'ASYNC_DECODER' });
  assert.throws(() => encode(jpegWithMetadata(), { key: 'k', format: 'jxl' }), /not supported yet/);
});

test('sharp plugin: lossless WebP with ICC + EXIF + XMP', async () => {
  const src = gradient();
  const webp = await sharp(Buffer.from(src), { raw: { width: W, height: H, channels: 4 } })
    .withIccProfile('p3')
    .withExif({ IFD0: { Copyright: 'pixmix test' } })
    .withXmp(XMP)
    .webp({ lossless: true })
    .toBuffer();
  let report;
  const scrambled = await encodeAsync(webp, { key: 'k', decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'webp');
  assert.equal(report.decoder, 'sharp');
  assert.deepEqual(report.transferred.sort(), ['EXIF', 'ICC profile', 'XMP']);
  const restored = decode(scrambled, { key: 'k' });
  // The stored (P3-encoded) values, not an sRGB conversion, since the P3 profile travels along.
  const stored = await sharp(webp).ensureAlpha().keepIccProfile().raw().toBuffer();
  assert.deepEqual(rgbaOf(restored), new Uint8Array(stored), 'stored WebP pixels survive exactly');
  assert.match(Buffer.from(chunk(restored, 'eXIf')).toString('latin1'), /pixmix test/);
});

test('sharp plugin: AVIF uses sharp-provided metadata', async () => {
  const avif = await sharp(Buffer.from(gradient()), { raw: { width: W, height: H, channels: 4 } })
    .withIccProfile('p3')
    .avif({ lossless: true })
    .toBuffer();
  const r = await (await import('../src/index.js')).convertAsync(avif, { decoders: [sharpDecoder(sharp)] });
  assert.equal(r.from, 'avif');
  assert.ok(r.transferred.includes('ICC profile'));
  const p = PNG.sync.read(Buffer.from(r.bytes));
  assert.equal(p.width, W);
  assert.equal(p.height, H);
});
