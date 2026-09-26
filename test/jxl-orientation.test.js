// JPEG XL details: the header orientation (pixels stay on the stored grid everywhere, the
// orientation travels as the header field or as EXIF), enum colour encodings kept exactly,
// exact animation timing, the route convertAsync takes, JPEG rebuilds, visible watermarks
// on sRGB-tagged images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { encodeAsync, decodeAsync, convertAsync, inspect } from '../src/index.js';
import { loadJxlCodec } from '../src/formats/jxl/load.js';
import { reconstructJpeg } from '../src/formats/jxl/index.js';
import { readChunks } from '../src/formats/png/chunks.js';
import { readOrientation } from '../src/meta/exif.js';
import { orientRgba, unorientRgba } from '../src/core/orient.js';
import { compute } from '../src/browser/compute.js';
import { apngDelay } from '../src/core/delay.js';

const codec = await loadJxlCodec();
const W = 12, H = 8;
const pattern = (w = W, h = H) => {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([(i * 29) & 255, (i * 7) & 255, 255 - i, 255], i * 4);
  return d;
};
const exifOf = (png) => readChunks(png).find((c) => c.type === 'eXIf')?.data;
const shown = async (bytes) => {
  const { info } = await sharp(bytes).autoOrient().toBuffer({ resolveWithObject: true });
  return [info.width, info.height];
};

test('orientations as pixel moves agree with jxl-oxide and with EXIF viewers', async () => {
  const data = pattern();
  for (let o = 1; o <= 8; o++) {
    const jxl = await codec.encode({ width: W, height: H, data, orientation: o });
    assert.equal(inspect(jxl).orientation, o);
    const stored = await codec.decode(jxl, { oriented: false });
    assert.deepEqual([stored.width, stored.height, stored.orientation], [W, H, o]);
    assert.deepEqual(stored.data, data, `orientation ${o}: the stored grid`);
    const viewed = await codec.decode(jxl);
    const mine = orientRgba(data, W, H, o);
    assert.deepEqual([viewed.width, viewed.height, viewed.data], [mine.width, mine.height, mine.data]);
    const png = await sharp(Buffer.from(data), { raw: { width: W, height: H, channels: 4 } }).png().withMetadata({ orientation: o }).toBuffer();
    assert.deepEqual(new Uint8Array(await sharp(png).autoOrient().ensureAlpha().raw().toBuffer()), mine.data);
    assert.deepEqual(unorientRgba(mine.data, mine.width, mine.height, o).data, data);
  }
});

test('JPEG XL with a header orientation -> PNG/JPEG: stored pixels, the orientation as EXIF', async () => {
  for (const o of [3, 6, 8]) {
    const jxl = await codec.encode({ width: W, height: H, data: pattern(), orientation: o });
    const png = await convertAsync(jxl, { format: 'png' });
    assert.deepEqual(PNG.sync.read(Buffer.from(png.bytes)).data, Buffer.from(pattern()));
    assert.equal(readOrientation(exifOf(png.bytes)), o);
    const want = o >= 5 ? [H, W] : [W, H];
    assert.deepEqual(await shown(png.bytes), want, 'shown as the JPEG XL is');
    const jpeg = await convertAsync(jxl, { format: 'jpeg' });
    assert.deepEqual(await shown(jpeg.bytes), want);
  }
});

test('JPEG with EXIF orientation -> JPEG XL, both routes: the header says it, and back again', async () => {
  const jpeg = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#3080c0' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  for (const mode of [undefined, 'pixel', 'block']) {
    const s = await encodeAsync(jpeg, { key: 'k', format: 'jxl', mode });
    assert.deepEqual([inspect(s).orientation, inspect(s).width, inspect(s).height], [6, 96, 64], `mode ${mode}`);
    const restored = await decodeAsync(s, { key: 'k' });
    assert.deepEqual([inspect(restored).orientation, inspect(restored).width], [6, 96], 'restoring keeps the header');
    const png = (await convertAsync(restored, { format: 'png' })).bytes;
    assert.deepEqual(await shown(png), [64, 96], 'shown rotated once');
  }
});

test('a JPEG XL whose EXIF disagrees with its header: the header wins, and the report says so', async () => {
  const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const png = await sharp(Buffer.from(pattern()), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  // A PNG carrying EXIF 6 becomes a JPEG XL with header orientation 6 (and the Exif box).
  const withExif = new Uint8Array([...png.subarray(0, 33), ...pngChunk('eXIf', tiff), ...png.subarray(33)]);
  const jxl = (await convertAsync(withExif, { format: 'jxl' })).bytes;
  assert.equal(inspect(jxl).orientation, 6);
  // The same boxes with a header orientation of 1.
  const flat = await codec.encode({ width: W, height: H, data: pattern() });
  const { readJxl, wrapCodestream } = await import('../src/formats/jxl/container.js');
  const mixed = wrapCodestream(readJxl(jxl).boxes.filter((b) => b.type === 'Exif'), readJxl(flat).codestream);
  const r = await convertAsync(mixed, { format: 'png' });
  assert.equal(readOrientation(exifOf(r.bytes)), 1);
  assert.ok(r.dropped.includes("EXIF orientation 6 (the JXL header's 1 wins)"), r.dropped.join());
});

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  let c = ~0;
  for (const b of out.subarray(4, 8 + data.length)) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  dv.setUint32(8 + data.length, ~c >>> 0);
  return out;
}

test('browser reveal of an oriented JPEG XL: the PNG is shown oriented, the animation turns with it', async () => {
  const jxl = await codec.encode({ width: W, height: H, data: pattern(), orientation: 6 });
  const s = await encodeAsync(jxl, { key: 'k', mode: 'block', block: 2 });
  const r = await compute(s, 'k', { animated: true });
  assert.equal(r.orientation, 6);
  assert.deepEqual([r.layout.width, r.layout.height], [W, H], 'the scramble is on the stored grid');
  const png = PNG.sync.read(Buffer.from(r.restored));
  assert.deepEqual([png.width, png.height], [H, W]);
  assert.deepEqual(new Uint8Array(png.data), orientRgba(pattern(), W, H, 6).data);
});

test('enum colour encodings are written back as they were (grey PQ, say), not as an ICC profile', async () => {
  const n = 16 * 4;
  const data = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) data.set([i * 1000, i * 1000, i * 1000, 65535], i * 4);
  // colour space grey, D65, sRGB primaries, PQ, relative intent.
  const encoding = [1, 1, 1, 16, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  const icc = new Uint8Array(4); // stands for the profile a decoder would synthesise
  const src = await codec.encode({ width: 16, height: 4, depth: 16, data, icc, colour: { encoding, icc } });
  const before = await codec.decode(src, { srgb: false, high: true });
  assert.deepEqual(before.colour.encoding, encoding);
  for (const mode of ['pixel', 'block']) {
    const restored = await decodeAsync(await encodeAsync(src, { key: 'k', mode }), { key: 'k' });
    const after = await codec.decode(restored, { srgb: false, high: true });
    assert.deepEqual(after.colour.encoding, encoding, mode);
    assert.deepEqual(after.icc, before.icc);
    assert.deepEqual(after.data, before.data);
  }
});

test('animation timing stays exact: ticks at the file\'s own rate', async () => {
  const frames = [1, 2, 3].map((k) => ({ data: pattern().map((v) => v ^ k), delay: [1, 30] }));
  const src = await codec.encode({ width: W, height: H, frames, plays: 0 });
  const anim = await codec.decodeAnimation(src);
  assert.deepEqual(anim.frames.map((f) => f.delay), [[1, 30], [1, 30], [1, 30]]);
  const back = await decodeAsync(await encodeAsync(src, { key: 'k' }), { key: 'k' });
  assert.deepEqual((await codec.decodeAnimation(back)).frames.map((f) => f.delay), [[1, 30], [1, 30], [1, 30]]);
  const apng = (await convertAsync(src, { format: 'png' })).bytes;
  const fctl = readChunks(apng).filter((c) => c.type === 'fcTL').map((c) => [Buffer.from(c.data).readUInt16BE(20), Buffer.from(c.data).readUInt16BE(22)]);
  assert.deepEqual(fctl, [[1, 30], [1, 30], [1, 30]]);
  assert.deepEqual(apngDelay([1001, 30000]), [1001, 30000]);
  assert.deepEqual(apngDelay([2002, 120000]), [1001, 60000]);
  const [num, den] = apngDelay([1, 1000003]);
  assert.ok(num >= 0 && den <= 65535 && Math.abs(num / den - 1 / 1000003) < 1e-4);
});

test('convertAsync to JPEG XL takes the route the encoder takes', async () => {
  for (const progressive of [false, true]) {
    const jpeg = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3080c0' } }).jpeg({ progressive }).toBuffer());
    const plain = await convertAsync(jpeg, { format: 'jxl' });
    assert.equal(plain.decoder, 'none');
    const restored = await decodeAsync(await encodeAsync(jpeg, { key: 'k', format: 'jxl' }), { key: 'k' });
    assert.deepEqual(await reconstructJpeg(plain.bytes), await reconstructJpeg(restored), 'the same JPEG inside');
    const block = await convertAsync(jpeg, { format: 'jxl', mode: 'block' });
    assert.equal(await reconstructJpeg(block.bytes), null, 'mode block: the pixel route');
    assert.equal(block.decoder, 'jpeg-js');
  }
  await assert.rejects(convertAsync(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer(), { format: 'jxl', mode: 'mcu' }), { code: 'BAD_OPTION' });
});

test('a recompressed JPEG converts back to that JPEG, exactly', async () => {
  const jpeg = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c08030' } }).jpeg({ quality: 70 }).toBuffer());
  const jxl = await codec.transcodeJpeg(jpeg);
  const r = await convertAsync(jxl, { format: 'jpeg' });
  assert.equal(r.decoder, 'jpeg reconstruction');
  assert.deepEqual(r.bytes, jpeg);
});

test('visible watermark on JPEG XL output from a PNG tagged with a plain sRGB profile', async () => {
  const wm = JSON.parse(readFileSync(new URL('../watermarks/compiled/vivi-pixel.json', import.meta.url)));
  const png = new Uint8Array(await sharp(Buffer.from(pattern(64, 48)), { raw: { width: 64, height: 48, channels: 4 } }).withIccProfile('srgb').png().toBuffer());
  assert.ok(readChunks(png).some((c) => c.type === 'iCCP'));
  const s = await encodeAsync(png, { key: 'k', format: 'jxl', visibleWatermark: wm });
  const back = await codec.decode(await decodeAsync(s, { key: 'k' }), { srgb: false });
  assert.deepEqual(back.data, pattern(64, 48));
});
