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

/** A container JXL with metadata boxes, like cjxl writes. */
async function sample({ w = 45, h = 29, lossy = false, boxes = [] } = {}) {
  const data = rgba(w, h, true);
  const cs = await codec.encode({ width: w, height: h, data }, lossy ? { distance: 2 } : {});
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

test('JPEG route: a JPEG with a comment (COM) is rebuilt exactly (jxl-oxide patch)', async () => {
  const base = new Uint8Array(await photo(96, 64));
  const text = new TextEncoder().encode('a comment');
  const com = Uint8Array.of(0xff, 0xfe, 0, text.length + 2, ...text);
  const jpg = new Uint8Array([...base.subarray(0, 2), ...com, ...base.subarray(2)]);
  const s = await encodeAsync(jpg, { key: 'k', format: 'jxl' });
  assert.equal(inspect(s).mode, 'mcu');
  const restored = await codec.reconstructJpeg(await decodeAsync(s, { key: 'k' }));
  assert.ok(sameCoefs(restored, jpg));
  assert.ok(Buffer.from(restored).includes(Buffer.from(com)), 'the comment comes back as it was');
  // A third-party recompressed JPEG with a comment too.
  assert.ok(Buffer.from(await codec.reconstructJpeg(await codec.transcodeJpeg(jpg))).equals(Buffer.from(jpg)));
});

test('JPEG route: JPEGs it cannot carry fall back to the pixel route, and the report says why', async () => {
  const cmyk = new Uint8Array(await sharp(await photo(64, 48)).toColourspace('cmyk').jpeg().toBuffer());
  let report;
  const s = await encodeAsync(cmyk, { key: 'k', format: 'jxl', onConvert: (r) => { report = r; } });
  assert.equal(inspect(s).mode, 'block');
  assert.match(report.notes.join(), /JPEG route not possible/);
  await decodeAsync(s, { key: 'k' });
  await assert.rejects(encodeAsync(cmyk, { key: 'k', format: 'jxl', mode: 'mcu' }), { code: 'UNSUPPORTED' });
});

test('a recompressed-JPEG JXL that jxl-oxide rebuilds wrongly takes the pixel route', async () => {
  // jxl-oxide 0.12 silently rebuilds this progressive JPEG with different coefficients.
  const w = 768, h = 512, d = Buffer.alloc(w * h * 3);
  let seed = 1;
  for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = ((((i / 3) | 0) % w) * 2 + (seed >>> 24) / 4) & 255; }
  const jpg = new Uint8Array(await sharp(d, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85, progressive: true }).toBuffer());
  const jxl = await codec.transcodeJpeg(jpg);
  assert.ok(!Buffer.from(await codec.reconstructJpeg(jxl)).equals(Buffer.from(jpg)), 'still a case jxl-oxide gets wrong');
  let report;
  const s = await encodeAsync(jxl, { key: 'k', onConvert: (r) => { report = r; } });
  assert.equal(inspect(s).mode, 'block');
  assert.match(report.notes.join(), /does not rebuild its JPEG exactly/);
  assert.ok((await pixelsOf(await decodeAsync(s, { key: 'k' }))).equals(await pixelsOf(jxl)), 'the image the JPEG XL shows');
  await assert.rejects(encodeAsync(jxl, { key: 'k', mode: 'mcu' }), { code: 'UNSUPPORTED' });
});

test('inspect describes JPEG-route files properly', async () => {
  const jxl = await encodeAsync(new Uint8Array(await photo(64, 48)), { key: 'k', format: 'jxl', transforms: false });
  const info = inspect(jxl);
  assert.deepEqual([info.mode, info.block, info.transforms], ['mcu', null, false]);
});

test('JPEG route: EXIF and XMP become boxes, as cjxl does', async () => {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp)]);
  app1.writeUInt16BE(app1.length - 2, 2);
  const src = Buffer.from(await photo(64, 48));
  const jpg = new Uint8Array(Buffer.concat([src.subarray(0, 2), app1, src.subarray(2)]));
  const jxl = await encodeAsync(jpg, { key: 'k', format: 'jxl' });
  const boxes = readJxl(jxl).boxes;
  assert.deepEqual(boxes.map((b) => b.type).filter((t) => ['Exif', 'xml ', 'jbrd', 'pmIx'].includes(t)).sort(), ['Exif', 'jbrd', 'pmIx', 'xml ']);
  assert.equal(Buffer.from(boxes.find((b) => b.type === 'xml ').data).toString(), xmp);
  assert.ok(Buffer.from(boxes.find((b) => b.type === 'Exif').data).toString('latin1').includes('pixmix'));
  assert.deepEqual(inspect(jxl).metadata, ['exif', 'xmp']);
});

// --- colour profiles and 16-bit samples ------------------------------------------------

test('an ICC profile travels into JPEG XL, and the samples stay exactly as stored', async () => {
  const png = await sharp(Buffer.from(rgba(40, 24)), { raw: { width: 40, height: 24, channels: 4 } }).withIccProfile('p3').png().toBuffer();
  const { icc } = await sharp(png).metadata();
  const stored = PNG.sync.read(png).data;
  let report;
  const s = await encodeAsync(png, { key: 'k', format: 'jxl', onConvert: (r) => { report = r; } });
  assert.ok(report.transferred.includes('ICC profile'), report.dropped.join());
  assert.equal(inspect(s).srgb, false);
  const own = async (jxl) => codec.decode(jxl, { srgb: false });
  const restored = await decodeAsync(s, { key: 'k' });
  assert.ok(Buffer.from((await own(restored)).data).equals(stored), 'exact stored samples, no sRGB conversion');
  assert.ok(Buffer.from((await own(restored)).icc).equals(icc), 'same profile');
  // JXL -> JXL keeps it (no "converted to sRGB" any more), and so does JXL -> PNG.
  const again = await encodeAsync(restored, { key: 'k2', mode: 'block', block: 4, onConvert: (r) => { report = r; } });
  assert.deepEqual(report.dropped, []);
  const back = await own(await decodeAsync(again, { key: 'k2' }));
  assert.ok(Buffer.from(back.data).equals(stored));
  assert.ok(Buffer.from(back.icc).equals(icc));
  assert.ok((await convertAsync(restored, { format: 'png' })).transferred.includes('ICC profile'));
});

test('a profile JPEG XL cannot carry for the pixels is dropped and reported', async () => {
  // A (header-only) GRAY profile on a colour PNG.
  const gray = new Uint8Array(132);
  gray.set(new TextEncoder().encode('GRAY'), 16);
  const { readChunks, writeChunks } = await import('../src/formats/png/chunks.js');
  const { zlibSync } = await import('fflate');
  const chunks = readChunks(PNG.sync.write(Object.assign(new PNG({ width: 16, height: 8 }), { data: Buffer.from(rgba(16, 8)) })));
  chunks.splice(1, 0, { type: 'iCCP', data: new Uint8Array([120, 0, 0, ...zlibSync(gray)]) });
  let report;
  await encodeAsync(writeChunks(chunks), { key: 'k', format: 'jxl', onConvert: (r) => { report = r; } });
  assert.ok(report.dropped.includes('ICC profile (GRAY profile on a colour image)'), report.dropped.join());
});

test('16-bit JPEG XL stays 16-bit through scramble, restore and rekey, exactly', async () => {
  const w = 33, h = 17;
  const d = new Uint16Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 2749 + 17) & 0xffff;
  const jxl = await codec.encode({ width: w, height: h, depth: 16, data: d }); // level 10: a container
  assert.equal(inspect(jxl).bitDepth, 16);
  const samples = async (b) => (await codec.decode(b, { high: true })).data;
  assert.deepEqual(await samples(jxl), d);
  for (const opts of [{ mode: 'pixel' }, { mode: 'block', block: 4 }]) {
    let report;
    const s = await encodeAsync(jxl, { key: 'k', ...opts, onConvert: (r) => { report = r; } });
    assert.deepEqual(report.dropped, []);
    assert.equal(inspect(s).bitDepth, 16);
    assert.notDeepEqual(await samples(s), d);
    assert.deepEqual(await samples(await decodeAsync(s, { key: 'k' })), d, `${opts.mode}: exact`);
    const r = await rekeyAsync(s, { from: 'k', to: 'k2' });
    assert.deepEqual(await samples(await decodeAsync(r, { key: 'k2' })), d, `${opts.mode}: exact after rekey`);
  }
});
