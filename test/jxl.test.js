import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  encode, encodeAsync, decode, decodeAsync, rekey, rekeyAsync, inspect, convertAsync, WrongKeyError,
} from '../src/index.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { readJxl, writeJxl } from '../src/formats/jxl/container.js';

const codec = await loadJxlCodec();
const pixelsOf = async (jxl) => Buffer.from((await codec.decode(jxl)).data);

function rgba(w, h, alpha = false) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = (x * 9) & 255; d[o + 1] = (y * 7) & 255; d[o + 2] = ((x ^ y) * 5) & 255; d[o + 3] = alpha ? (x * 11) & 255 : 255;
  }
  return d;
}

/** A container JXL with metadata boxes, like cjxl would write. */
async function sample({ w = 45, h = 29, lossy = false, boxes = [] } = {}) {
  const data = rgba(w, h, true);
  const cs = await codec.encode({ width: w, height: h, data }, lossy ? { lossless: false, quality: 80 } : {});
  return { bytes: writeJxl(boxes, cs), data };
}

const XMP = new TextEncoder().encode('<x:xmpmeta/>');
const exifBox = (tiff) => { const d = new Uint8Array(4 + tiff.length); d.set(tiff, 4); return { type: 'Exif', data: d }; };
const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);

for (const opts of [{ mode: 'pixel' }, { mode: 'block', block: 8 }, { mode: 'block', block: 7 }]) {
  test(`JXL -> JXL is lossless (${opts.mode}${opts.block ? ` ${opts.block}` : ''})`, async () => {
    const { bytes, data } = await sample({ boxes: [exifBox(TIFF), { type: 'xml ', data: XMP }, { type: 'abcd', data: Uint8Array.of(1, 2, 3) }] });
    const scrambled = await encodeAsync(bytes, { key: 'k', ...opts });
    const info = inspect(scrambled);
    assert.equal(info.format, 'jxl');
    assert.equal(info.scrambled, true);
    assert.equal(info.lossy, false);
    assert.ok(!(await pixelsOf(scrambled)).equals(Buffer.from(data)), 'scrambled looks different');
    const restored = await decodeAsync(scrambled, { key: 'k' });
    assert.ok((await pixelsOf(restored)).equals(Buffer.from(data)), 'exact pixels back');
    const types = (b) => readJxl(b).boxes.map((x) => x.type);
    assert.deepEqual(types(scrambled), ['ftyp', 'Exif', 'xml ', 'abcd', 'pmIx', 'jxlc']);
    assert.deepEqual(types(restored), ['ftyp', 'Exif', 'xml ', 'abcd', 'jxlc']);
    for (const t of ['Exif', 'xml ', 'abcd']) {
      assert.deepEqual(readJxl(restored).boxes.find((b) => b.type === t).data, readJxl(bytes).boxes.find((b) => b.type === t).data);
    }
  });
}

test('lossy JXL input is re-encoded losslessly, and the report says so', async () => {
  const { bytes } = await sample({ lossy: true });
  assert.equal(inspect(bytes).lossy, true);
  let report;
  const scrambled = await encodeAsync(bytes, { key: 'k', onConvert: (r) => { report = r; } });
  assert.ok(report.dropped.some((d) => d.startsWith('lossy compression')));
  assert.equal(inspect(scrambled).lossy, false);
  const restored = await decodeAsync(scrambled, { key: 'k' });
  assert.ok((await pixelsOf(restored)).equals(await pixelsOf(bytes)), 'same pixels as the lossy input decodes to');
});

test('bare codestream input works and gets a container', async () => {
  const data = rgba(20, 12);
  const cs = await codec.encode({ width: 20, height: 12, data });
  const scrambled = await encodeAsync(cs, { key: 'k' });
  assert.equal(inspect(scrambled).container, true);
  assert.ok((await pixelsOf(await decodeAsync(scrambled, { key: 'k' }))).equals(Buffer.from(data)));
});

test('stale and leaking boxes are dropped', async () => {
  const { bytes } = await sample({ boxes: [{ type: 'jbrd', data: Uint8Array.of(1) }, { type: 'jhgm', data: Uint8Array.of(2) }] });
  let report;
  const scrambled = await encodeAsync(bytes, { key: 'k', onConvert: (r) => { report = r; } });
  assert.deepEqual(report.dropped.sort(), ['HDR gain map (a second image)', 'JPEG reconstruction data (no longer matches the image)']);
  assert.deepEqual(readJxl(scrambled).boxes.map((b) => b.type), ['ftyp', 'pmIx', 'jxlc']);
});

test('sync APIs point at the async ones; wrong key; rekey; mcu mode rejected', async () => {
  const { bytes, data } = await sample();
  assert.throws(() => encode(bytes, { key: 'k' }), /encodeAsync/);
  const s = await encodeAsync(bytes, { key: 'one' });
  assert.throws(() => decode(s, { key: 'one' }), /decodeAsync/);
  assert.throws(() => rekey(s, { from: 'one', to: 'two' }), /rekeyAsync/);
  await assert.rejects(decodeAsync(s, { key: 'nope' }), WrongKeyError);
  const r = await rekeyAsync(s, { from: 'one', to: 'two', mode: 'block', block: 4 });
  assert.equal(inspect(r).mode, 'block');
  assert.ok((await pixelsOf(await decodeAsync(r, { key: 'two' }))).equals(Buffer.from(data)));
  await assert.rejects(encodeAsync(bytes, { key: 'k', mode: 'mcu' }), /needs a JPEG source/);
});

test('PNG -> JXL restores exactly', async () => {
  const src = readFileSync(new URL('./fixtures/pngsuite/basn6a08.png', import.meta.url));
  let report;
  const scrambled = await encodeAsync(src, { key: 'k', format: 'jxl', onConvert: (r) => { report = r; } });
  assert.equal(report.from, 'png');
  assert.equal(report.format, 'jxl');
  assert.equal(inspect(scrambled).format, 'jxl');
  const restored = await decodeAsync(scrambled, { key: 'k' });
  const png = PNG.sync.read(src);
  assert.ok((await pixelsOf(restored)).equals(png.data), 'exact, including colour under alpha = 0');
  const plain = await convertAsync(src, { format: 'jxl' });
  assert.ok((await pixelsOf(plain.bytes)).equals(png.data));
});

test('JPEG -> JXL and JXL -> PNG/JPEG', async () => {
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } })
    .withExif({ IFD0: { Copyright: 'pixmix' } }).jpeg().toBuffer();
  let report;
  const jxl = await encodeAsync(jpeg, { key: 'k', format: 'jxl', mode: 'pixel', onConvert: (r) => { report = r; } });
  assert.equal(inspect(jxl).mode, 'pixel');
  assert.ok(report.transferred.includes('EXIF'));
  assert.ok(Buffer.from(readJxl(jxl).boxes.find((b) => b.type === 'Exif').data).toString('latin1').includes('pixmix'));

  const { bytes } = await sample({ boxes: [exifBox(TIFF)] });
  const png = await encodeAsync(bytes, { key: 'k', format: 'png', onConvert: (r) => { report = r; } });
  assert.equal(report.decoder, 'jxl-oxide');
  assert.ok(report.transferred.includes('EXIF'));
  assert.equal(inspect(png).format, 'png');
  const jpg = await encodeAsync(bytes, { key: 'k', format: 'jpeg' });
  assert.equal(inspect(jpg).format, 'jpeg');
});

test('JXL decoding is bit-exact (a colour conversion in the decode path would break this)', async () => {
  const d = new Uint8Array(256 * 3 * 4);
  for (let i = 0; i < 256; i++) {
    d.set([i, 255, 0, 255], i * 4); d.set([4, i, 255 - i, i], (256 + i) * 4); d.set([i, i, i, 0], (512 + i) * 4);
  }
  const jxl = await codec.encode({ width: 256, height: 3, data: d });
  assert.ok((await pixelsOf(jxl)).equals(Buffer.from(d)));
});

// --- JPEG route: JPEG scrambled in the DCT domain, recompressed into JPEG XL ------------

import { readSegments } from '../src/formats/jpeg/markers.js';
import { decodeFrame } from '../src/formats/jpeg/decode.js';
import { convert } from '../src/index.js';
import { unscrambleJxlDetailed } from '../src/formats/jxl/index.js';

const coefs = (jpg) => decodeFrame(readSegments(jpg).segments).components.map((c) => Buffer.from(c.coefs.buffer));
const sameCoefs = (a, b) => coefs(a).every((c, i) => c.equals(coefs(b)[i]));
const photo = (w, h, opts = {}) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.sin(i / 700) * 90 + 128 + ((i * 2654435761) >>> 29)) | 0;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).withExif({ IFD0: { Copyright: 'pixmix' } }).jpeg(opts).toBuffer();
};

test('JPEG -> JXL takes the JPEG route by default: small, and the JPEG comes back exactly', async () => {
  const jpg = new Uint8Array(await photo(320, 240, { progressive: true }));
  let report;
  const jxl = await encodeAsync(jpg, { key: 'k', format: 'jxl', onConvert: (r) => { report = r; } });
  const info = inspect(jxl);
  assert.equal(info.mode, 'mcu');
  assert.equal(report.format, 'jxl');
  assert.ok(readJxl(jxl).boxes.some((b) => b.type === 'jbrd'), 'carries JPEG reconstruction data');
  const pixelRoute = await encodeAsync(jpg, { key: 'k', format: 'jxl', mode: 'block', block: 16 });
  assert.ok(jxl.length < pixelRoute.length / 2, `JPEG route ${jxl.length} B vs pixel route ${pixelRoute.length} B`);

  const d = await unscrambleJxlDetailed(jxl, { key: 'k' });
  assert.equal(d.route, 'jpeg');
  const plain = convert(jpg, { format: 'jpeg' }).bytes; // what the encoder scrambled (sanitised)
  assert.ok(sameCoefs(d.jpeg.toJpeg(), plain), 'identical DCT coefficients');

  const restored = await decodeAsync(jxl, { key: 'k' });
  assert.equal(inspect(restored).format, 'jxl');
  assert.ok(sameCoefs(await codec.reconstructJpeg(restored), plain), 'restored JXL reconstructs the original JPEG');
  await assert.rejects(decodeAsync(jxl, { key: 'nope' }), WrongKeyError);
});

test('a recompressed-JPEG JXL input stays on the JPEG route; rekey works on it', async () => {
  const jpg = new Uint8Array(await photo(96, 64));
  const recompressed = await codec.transcodeJpeg(jpg);
  let report;
  const s = await encodeAsync(recompressed, { key: 'one', onConvert: (r) => { report = r; } });
  assert.equal(inspect(s).mode, 'mcu');
  assert.equal(report.decoder, 'jpeg reconstruction');
  const r = await rekeyAsync(s, { from: 'one', to: 'two', transforms: false });
  await assert.rejects(decodeAsync(r, { key: 'one' }), WrongKeyError);
  const d = await unscrambleJxlDetailed(r, { key: 'two' });
  assert.ok(sameCoefs(d.jpeg.toJpeg(), jpg));
  await assert.rejects(rekeyAsync(s, { from: 'one', to: 'two', mode: 'pixel' }), /only be re-keyed in mode "mcu"/);
});

test('inspect describes JPEG-route files properly', async () => {
  const jxl = await encodeAsync(new Uint8Array(await photo(64, 48)), { key: 'k', format: 'jxl', transforms: false });
  const info = inspect(jxl);
  assert.deepEqual([info.mode, info.block, info.transforms], ['mcu', null, false]);
});
