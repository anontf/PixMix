import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { encodeAsync, decodeAsync, convertAsync, inspect } from '../src/index.js';
import { sharpDecoder } from '../src/plugins/sharp.js';
import { readPng } from '../src/formats/png/index.js';
import { encodeRaster } from '../src/formats/png/raster.js';
import { writeChunks } from '../src/formats/png/chunks.js';

const W = 20, H = 12;
/** 16-bit RGB samples that are NOT representable in 8 bits. */
function rgb16(w = W, h = H) {
  const d = new Uint16Array(w * h * 3);
  for (let i = 0; i < d.length; i++) d[i] = (i * 2749 + 17) & 0xffff;
  return d;
}
const be = (d16) => { const b = new Uint8Array(d16.length * 2); d16.forEach((v, i) => { b[i * 2] = v >> 8; b[i * 2 + 1] = v & 255; }); return b; };
function png16(d16, w = W, h = H) {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 16; ihdr[9] = 2;
  return writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: encodeRaster({ width: w, height: h, depth: 16, colorType: 2, interlace: 0 }, be(d16)) }, { type: 'IEND', data: new Uint8Array(0) }]);
}

// sharp writes 16-bit TIFF only uncompressed (its default TIFF compression is JPEG).
const tiff16 = (d16) => sharp(png16(d16)).toColourspace('rgb16').tiff({ compression: 'none' }).toBuffer();

test('16-bit TIFF (via sharp) stays 16-bit in PNG, exactly', async () => {
  const d = rgb16();
  const tiff = await tiff16(d);
  let report;
  const s = await encodeAsync(tiff, { key: 'k', format: 'png', decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.ok(!report.dropped.some((x) => x.includes('precision')), report.dropped.join());
  assert.equal(inspect(s).bitDepth, 16);
  const back = readPng(await decodeAsync(s, { key: 'k' }));
  assert.deepEqual([back.ihdr.depth, back.ihdr.colorType], [16, 2]);
  assert.deepEqual(back.pixels, be(d));
});

test('16-bit data that is really 8-bit becomes an 8-bit PNG (nothing lost)', async () => {
  const d = Uint16Array.from(rgb16(), (v) => (v >> 8) * 257);
  const tiff = await tiff16(d);
  const r = await convertAsync(tiff, { format: 'png', decoders: [sharpDecoder(sharp)] });
  assert.equal(inspect(r.bytes).bitDepth, 8);
});

test('16-bit PNG -> JPEG XL -> PNG stays exactly 16-bit', async () => {
  const d = rgb16();
  const jxl = (await convertAsync(png16(d), { format: 'jxl' })).bytes;
  assert.equal(inspect(jxl).bitDepth, 16);
  const r = await convertAsync(jxl, { format: 'png' });
  assert.ok(!r.dropped.some((x) => x.includes('precision')), r.dropped.join());
  const p = readPng(r.bytes);
  assert.equal(p.ihdr.depth, 16);
  assert.deepEqual(p.pixels, be(d));
});

test('16-bit to JPEG is reduced to 8-bit, and reported; to JPEG XL it stays 16-bit', async () => {
  const d = rgb16();
  const tiff = await tiff16(d);
  let report;
  await encodeAsync(tiff, { key: 'k', format: 'jpeg', decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
  assert.ok(report.dropped.includes('16-bit precision (reduced to 8-bit)'), `jpeg: ${report.dropped}`);
  for (const mode of ['pixel', 'block']) {
    const s = await encodeAsync(tiff, { key: 'k', format: 'jxl', mode, decoders: [sharpDecoder(sharp)], onConvert: (r) => { report = r; } });
    assert.ok(!report.dropped.some((x) => x.includes('precision')), `jxl: ${report.dropped}`);
    assert.equal(inspect(s).bitDepth, 16);
    const back = readPng((await convertAsync(await decodeAsync(s, { key: 'k' }), { format: 'png' })).bytes);
    assert.deepEqual([back.ihdr.depth, back.ihdr.colorType], [16, 2]);
    assert.deepEqual(back.pixels, be(d), `${mode}: exact`);
  }
});

test('16-bit grey with alpha survives PNG -> JPEG XL -> PNG', async () => {
  const w = 9, h = 7;
  const raw = new Uint8Array(w * h * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 97 + 5) & 255;
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 16; ihdr[9] = 4;
  const png = writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: encodeRaster({ width: w, height: h, depth: 16, colorType: 4, interlace: 0 }, raw) }, { type: 'IEND', data: new Uint8Array(0) }]);
  const s = await encodeAsync(png, { key: 'k', format: 'jxl' });
  assert.equal(inspect(s).bitDepth, 16);
  const back = readPng((await convertAsync(await decodeAsync(s, { key: 'k' }), { format: 'png' })).bytes);
  assert.deepEqual([back.ihdr.depth, back.ihdr.colorType], [16, 4]);
  assert.deepEqual(back.pixels, raw);
});
